// AI交易执行器：AI只给信号，本地风控决定是否允许开仓，最后统一进入保护引擎。
const crypto = require('crypto');
const { normalizeSymbol } = require('../utils/symbol');
const Logger = require('../Logger');
class AITrader {
  constructor({ binance, ai, risk, protection, state, config }) { Object.assign(this, { binance, ai, risk, protection, state, config }); }
  signalId(signal) { return crypto.createHash('sha256').update(JSON.stringify({ action: signal.action, symbol: normalizeSymbol(signal.symbol), sl: signal.stop_loss_pct, tp: signal.take_profit_pct, confidence: signal.confidence })).digest('hex').slice(0, 24); }
  async run(ranking, currentPositions, execute = false) {
    const signal = await this.ai.analyze(ranking); const candidates = [...ranking.gainers, ...ranking.losers].map(x => normalizeSymbol(x.symbol));
    const check = await this.risk.validateSignalAsync(signal, currentPositions, candidates); const createdAt = Date.now();
    const signalId = this.signalId(signal); const cfg = this.config.get(); const result = { signal, check, signalId, createdAt, expiresAt: createdAt + cfg.ai.signalTtlMinutes * 60000, executed: false };
    if (!execute || !cfg.aiTrading || this.state.rawGet('aiEmergencyStopped', false)) return result;
    if (!check.ok) return result;
    const signals = this.state.rawGet('signals', {}); const old = signals[signalId];
    if (old && old.status === 'EXECUTED' && Date.now() - Number(old.createdAt) < cfg.ai.signalTtlMinutes * 60000) { result.check = { ok: false, reason: '同一 AI 信号在有效期内已经执行过' }; return result; }
    if (Date.now() > result.expiresAt) { result.check = { ok: false, reason: 'AI 信号已过期' }; return result; }

    const ticker = await this.binance.fetchTicker(signal.symbol); const entry = Number(ticker.lastPrice);
    const mark = Number((await this.binance.fetchMarkPrice(signal.symbol)).markPrice || entry);
    if (!(entry > 0 && mark > 0)) throw new Error('无法取得有效市场价格');
    const sizing = await this.risk.calculateQuantity(signal.symbol, entry, signal.stop_loss_pct);
    if (Number(mark) > 0 && Math.abs(mark - entry) / entry * 100 > cfg.risk.maxSlippagePct) throw new Error('Mark/最新价偏差超过允许范围，取消 AI 开仓');
    await this.binance.setLeverage(signal.symbol, sizing.leverage);
    const positionSide = this.binance.actualHedgeMode ? signal.action : 'BOTH';
    const side = signal.action === 'LONG' ? 'BUY' : 'SELL';
    const orderId = `QP_AI_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`.slice(0, 36);
    let order;
    try {
      order = await this.binance.createMarketOrder({ symbol: signal.symbol, side, quantity: sizing.quantity, positionSide, newClientOrderId: orderId });
      const fresh = await this.binance.fetchPositions();
      const position = fresh.find(p => normalizeSymbol(p.symbol) === normalizeSymbol(signal.symbol) && String(p.positionSide) === String(positionSide));
      if (!position) throw new Error('AI开仓成功响应后未读取到对应真实持仓');
      this.state.setPositionSource(position, 'AI');
      this.state.setProtectionParams(position, { mode: 'PRICE', stopLossPct: signal.stop_loss_pct, takeProfitPct: signal.take_profit_pct, source: 'AI_SIGNAL' });
      const protection = await this.protection.reconcile(position, { mode: 'PRICE', stopLossPct: signal.stop_loss_pct, takeProfitPct: signal.take_profit_pct });
      if (!protection.ok) throw new Error('AI仓位保护未确认成功');
      signals[signalId] = { status: 'EXECUTED', createdAt, executedAt: Date.now(), symbol: signal.symbol, orderId: order.orderId };
      this.state.rawSet('signals', signals);
      result.executed = true; result.order = { orderId: order.orderId, quantity: sizing.quantity, leverage: sizing.leverage, riskMoney: sizing.riskMoney };
      Logger.info('AI自动开仓并完成保护', { symbol: signal.symbol, positionSide, orderId: order.orderId });
      return result;
    } catch (e) {
      Logger.error('AI开仓/保护失败', { symbol: signal.symbol, error: e, code: e.code || null, status: e.status || null, protectionStage: e.protectionStage || null, traceId: e.traceId || null });
      throw e;
    }
  }
}
module.exports = AITrader;
