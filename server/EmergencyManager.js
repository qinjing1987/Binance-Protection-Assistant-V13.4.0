// 紧急操作：停止 AI 与全部平仓。
// 注意：全部平仓后会再次从交易所读取仓位，确认没有残余仓位才算完成。
const Logger = require('./Logger');
class EmergencyManager {
  constructor(binance) { this.binance = binance; }
  async closePositionMarket(p) {
    const side = p.side === 'long' ? 'SELL' : 'BUY';
    const clientOrderId = `QP_CLOSE_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    return this.binance.createCloseMarketOrder({ symbol: p.symbol, side, quantity: p.contracts, positionSide: p.positionSide, newClientOrderId: clientOrderId });
  }
  async closeAll() {
    const first = await this.binance.fetchPositions();
    const results = [];
    for (const p of first) {
      try { const r = await this.closePositionMarket(p); results.push({ symbol: p.symbol, positionSide: p.positionSide, ok: true, orderId: r.orderId }); }
      catch (e) { Logger.error('紧急平仓失败', { symbol: p.symbol, positionSide: p.positionSide, error: e, code: e.code || null, status: e.status || null }); results.push({ symbol: p.symbol, positionSide: p.positionSide, ok: false, error: e.message }); }
    }
    // 紧急平仓后轮询短时间确认，避免单次 1.2s 查询过早把正常成交误判为失败。
    let remain = [];
    const deadline = Date.now() + 5000;
    do {
      await new Promise(r => setTimeout(r, 700));
      remain = await this.binance.fetchPositions();
      if (!remain.length) break;
    } while (Date.now() < deadline);
    return { ok: remain.length === 0, results, remaining: remain.map(p => ({ symbol: p.symbol, positionSide: p.positionSide, contracts: p.contracts })) };
  }
}
module.exports = EmergencyManager;
