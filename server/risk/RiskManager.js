// 本地风控：AI 和规则自动交易共用日亏损熔断；数量/杠杆/执行条件均由本模块与交易所规则约束。
const Logger = require('../Logger');
const { normalizeSymbol, positionKey } = require('../utils/symbol');

function utcDateKey(ms = Date.now()) { return new Date(ms).toISOString().slice(0, 10); }

class RiskManager {
  constructor({ config, state, binance }) {
    this.config = config;
    this.state = state;
    this.binance = binance;
    this.tradeEventIds = new Set();
    this.closeOrderAccumulators = new Map();
  }

  async ensureDayStartEquity(equityHint = null) {
    const day = utcDateKey();
    const old = this.state.rawGet('dailyRisk', null);
    // dayStartEquity > 0 才代表已经建立了可用于百分比风控的日初基准。
    if (old && old.date === day && Number(old.dayStartEquity) > 0) return old;

    // 注意：账户“可连接但当前权益为 0”是合法的连接状态，不能把它误判成
    // 系统启动失败。此时保护/行情仍应启动；只是自动开仓必须继续被 canAutoTrade 拒绝，
    // 直到后续账户同步获得 >0 的真实权益并建立日初基准。
    let equity = null;
    let source = 'START_ACCOUNT_HINT';
    const hint = equityHint == null ? NaN : Number(equityHint);
    if (Number.isFinite(hint) && hint >= 0) equity = hint;

    if (equity == null && typeof this.binance.getCachedAccountSnapshot === 'function') {
      const cached = this.binance.getCachedAccountSnapshot(60000);
      const cachedEquity = Number(cached?.account?.totalMarginBalance ?? cached?.account?.totalWalletBalance);
      if (Number.isFinite(cachedEquity) && cachedEquity >= 0) {
        equity = cachedEquity;
        source = 'CACHED_ACCOUNT<=60S';
      }
    }

    if (equity == null) {
      try {
        const live = Number(await this.binance.fetchAccountEquity());
        if (Number.isFinite(live) && live >= 0) {
          equity = live;
          source = 'LIVE_REST';
        }
      } catch (e) {
        // 没有任何可用权益快照时，保留“未初始化”状态，不阻断保护服务启动。
        return { date: day, dayStartEquity: 0, realizedPnl: 0, fees: 0, funding: 0, netPnl: 0, source: 'UNINITIALIZED', initialized: false, initError: e?.message || String(e) };
      }
    }

    if (!(Number(equity) > 0)) {
      const empty = { date: day, dayStartEquity: 0, realizedPnl: 0, fees: 0, funding: 0, netPnl: 0, source: 'NO_POSITIVE_EQUITY', initialized: false };
      this.state.rawSet('dailyRisk', empty);
      return empty;
    }

    const fresh = { date: day, dayStartEquity: equity, realizedPnl: 0, fees: 0, funding: 0, netPnl: 0, source, initialized: true };
    this.state.rawSet('dailyRisk', fresh);
    return fresh;
  }

  async daily() {
    let d = await this.ensureDayStartEquity();
    const fetchedAt = Date.now();
    let currentEquity = null;
    let equityError = null;
    let equitySource = 'LIVE_REST';
    let equityAgeMs = 0;
    try {
      currentEquity = Number(await this.binance.fetchAccountEquity());
      if (!(currentEquity > 0)) currentEquity = null;
      if (currentEquity != null && !(Number(d.dayStartEquity) > 0)) {
        d = await this.ensureDayStartEquity(currentEquity);
      }
    } catch (e) {
      equityError = e?.message || String(e);
      const cached = typeof this.binance.getCachedAccountSnapshot === 'function'
        ? this.binance.getCachedAccountSnapshot(15000)
        : null;
      if (cached?.account) {
        const fallback = Number(cached.account.totalMarginBalance ?? cached.account.totalWalletBalance);
        if (fallback > 0) {
          currentEquity = fallback;
          equitySource = 'CACHED_REST<=15S';
          equityAgeMs = Number(cached.ageMs || 0);
          equityError = `${equityError}；已回退到${equityAgeMs}ms内的成功账户快照`;
        }
      }
    }

    const dayNet = Number(d.realizedPnl || 0) - Number(d.fees || 0) + Number(d.funding || 0);
    const realizedLoss = Math.max(0, -dayNet);
    const equityDrawdownLoss = currentEquity != null
      ? Math.max(0, Number(d.dayStartEquity) - currentEquity)
      : null;
    // 日亏损熔断取“已实现净亏损”和“实时权益回撤”两者中的较大值，避免浮亏绕过熔断。
    const riskLoss = equityDrawdownLoss == null ? null : Math.max(realizedLoss, equityDrawdownLoss);
    const lossPct = riskLoss == null || !(Number(d.dayStartEquity) > 0)
      ? null
      : riskLoss / Number(d.dayStartEquity) * 100;

    return {
      ...d,
      netPnl: dayNet,
      currentEquity,
      equityFetchedAt: fetchedAt,
      equityAgeMs,
      equitySource,
      equityFresh: currentEquity != null,
      equityError,
      realizedLoss,
      equityDrawdownLoss,
      riskLoss,
      lossPct,
      lossStreak: Number(this.state.rawGet('lossStreak', 0)),
      lossStreakPausedUntil: Number(this.state.rawGet('lossStreakPausedUntil', 0))
    };
  }

  async canAutoTrade() {
    const cfg = this.config.get();
    let d;
    try {
      d = await this.daily();
    } catch (e) {
      return { ok: false, reason: '账户权益数据不可用，禁止自动开仓', daily: null, error: e };
    }
    if (!d.equityFresh || !(Number(d.currentEquity) > 0)) {
      return { ok: false, reason: '账户权益数据不可用，禁止自动开仓', daily: d };
    }
    const dailyLossLimitPct = Number(cfg.risk.dailyLossLimitPct || 0);
    if (dailyLossLimitPct > 0 && Number(d.lossPct) >= dailyLossLimitPct) {
      return { ok: false, reason: '已达到日亏损上限', daily: d };
    }
    const pauseUntil = Number(this.state.rawGet('lossStreakPausedUntil', 0));
    if (Date.now() < pauseUntil) return { ok: false, reason: '连续亏损冷却中', daily: d };
    return { ok: true, daily: d };
  }

  // AI 与规则自动交易共用同一套日亏损熔断；0 表示关闭日亏损百分比限制，但账户权益数据不可用时仍禁止新开仓。
  async canRuleAutoTrade() {
    return this.canAutoTrade();
  }

  validateSignal(signal, positions, candidateSymbols) {
    const cfg = this.config.get();
    const action = String(signal?.action || '').toUpperCase();
    const symbol = normalizeSymbol(signal?.symbol);
    if (!['LONG', 'SHORT', 'HOLD'].includes(action)) return { ok: false, reason: 'AI方向无效' };
    if (action === 'HOLD') return { ok: false, reason: 'AI选择 HOLD' };
    if (!candidateSymbols.includes(symbol)) return { ok: false, reason: '币种不在当前候选池' };
    if (positions.some(p => normalizeSymbol(p.symbol) === symbol)) return { ok: false, reason: '该币已有仓位' };
    const sl = Number(signal.stop_loss_pct), tp = Number(signal.take_profit_pct), conf = Number(signal.confidence);
    if (!(sl >= cfg.risk.minSLPct && sl <= cfg.risk.maxSLPct)) return { ok: false, reason: '止损超出允许范围' };
    if (!(tp >= cfg.risk.minTPPct && tp <= cfg.risk.maxTPPct)) return { ok: false, reason: '止盈超出允许范围' };
    if (!(tp / sl >= cfg.risk.minRR)) return { ok: false, reason: '风险收益比不足 2R' };
    if (!(conf >= cfg.risk.minAIConfidence)) return { ok: false, reason: 'AI置信度不足' };
    return { ok: true, normalized: { action, symbol, sl, tp, conf } };
  }

  async validateSignalAsync(signal, positions, candidateSymbols) {
    const syncCheck = this.validateSignal(signal, positions, candidateSymbols);
    if (!syncCheck.ok) return syncCheck;
    const gate = await this.canAutoTrade();
    if (!gate.ok) return gate;
    const cfg = this.config.get();
    const aiPositions = positions.filter(p => this.state.getPositionSource(p) === 'AI');
    if (aiPositions.length >= cfg.risk.maxAIPositions) return { ok: false, reason: '达到 AI 最大持仓数量' };
    if (aiPositions.reduce((s, p) => s + cfg.risk.riskPerTradePct, 0) + cfg.risk.riskPerTradePct > cfg.risk.maxAITotalRiskPct + 1e-9) return { ok: false, reason: '超过 AI 总风险上限' };
    const until = this.state.getCooldown(signal.symbol);
    if (Date.now() < until) return { ok: false, reason: '该币仍在冷却时间内' };
    return { ...syncCheck, daily: gate.daily };
  }

  async calculateQuantity(symbol, entryPrice, stopLossPct) {
    const cfg = this.config.get();
    const equity = await this.binance.fetchAccountEquity();
    const riskMoney = equity * Number(cfg.risk.riskPerTradePct) / 100;
    const stopDistance = Number(entryPrice) * Number(stopLossPct) / 100;
    if (!(riskMoney > 0 && stopDistance > 0)) throw new Error('风险金额或止损距离无效');
    const rawQty = riskMoney / stopDistance;
    const qty = this.binance.roundQty(symbol, rawQty);
    if (!(qty > 0) || qty < this.binance.minQty(symbol)) throw new Error(`按风险计算出的数量低于交易所最小数量：${qty}`);
    const notional = qty * Number(entryPrice);
    if (notional < this.binance.minNotional(symbol)) throw new Error(`名义价值低于交易所最小值：${notional}`);
    const maxLev = await this.binance.maxInitialLeverage(symbol);
    if (!(Number(maxLev) > 0)) throw new Error(`无法读取 ${symbol} 的 Binance 最大初始杠杆，禁止猜测默认杠杆`);
    const leverage = Math.min(Number(cfg.risk.defaultLeverage), Number(maxLev));
    if (!(leverage > 0)) throw new Error('AI开仓杠杆无效，已阻止下单');
    return { equity, riskMoney, quantity: qty, notional, leverage, maxLeverage: maxLev };
  }

  // 按“完整平仓订单”计一次连亏，而不是按每个 TRADE 成交回报计数。
  recordTradeEvent(e) {
    if (e?.e !== 'ORDER_TRADE_UPDATE' || e?.o?.x !== 'TRADE') return;
    const o = e.o || {};
    const id = `${o.i || ''}|${o.T || ''}|${o.l || ''}|${o.z || ''}`;
    if (this.tradeEventIds.has(id)) return;
    this.tradeEventIds.add(id);
    if (this.tradeEventIds.size > 5000) this.tradeEventIds.clear();

    const realized = Number(o.rp || 0);
    const fee = Number(o.n || 0);
    const side = String(o.S || o.side || '').toUpperCase();
    const positionSide = String(o.ps || 'BOTH').toUpperCase();
    const reduceOnly = o.R === true || o.R === 'true' || o.R === 1 || o.R === '1';
    // 只有平仓方向才进入“完整交易”统计；避免开仓成交手续费被误算成亏损交易。
    const closingTrade = positionSide === 'LONG' ? side === 'SELL' : positionSide === 'SHORT' ? side === 'BUY' : reduceOnly;
    if (!closingTrade) return;
    if (!realized && !fee) return;
    const d = this.state.rawGet('dailyRisk', null);
    if (!d || d.date !== utcDateKey()) return;
    d.realizedPnl = Number(d.realizedPnl || 0) + realized;
    d.fees = Number(d.fees || 0) + Math.abs(fee);
    this.state.rawSet('dailyRisk', d);

    const status = String(o.X || '').toUpperCase();
    const orderId = String(o.i || '');
    const key = `${orderId}|${String(o.s || '')}|${String(o.ps || 'BOTH')}`;
    const agg = this.closeOrderAccumulators.get(key) || { realized: 0, fee: 0, lastAt: Date.now() };
    agg.realized += realized;
    agg.fee += Math.abs(fee);
    agg.lastAt = Date.now();
    this.closeOrderAccumulators.set(key, agg);

    // 只在完整订单 FILLED 时更新一次连亏状态；避免一个订单的多笔成交被重复计入。
    if (status !== 'FILLED') return;
    this.closeOrderAccumulators.delete(key);
    const outcome = agg.realized - agg.fee;
    let streak = Number(this.state.rawGet('lossStreak', 0));
    if (outcome < 0) streak++;
    else if (outcome > 0) streak = 0;
    this.state.rawSet('lossStreak', streak);
    const cfg = this.config.get();
    if (streak >= Number(cfg.risk.lossStreakLimit || 0) && Number(cfg.risk.lossStreakLimit || 0) > 0) {
      const until = Date.now() + Number(cfg.risk.lossStreakCooldownMinutes || 0) * 60000;
      this.state.rawSet('lossStreakPausedUntil', until);
      Logger.warn('连续亏损达到限制，自动开仓进入冷却', { until: new Date(until).toISOString(), orderId, outcome });
    }
  }

  markAI(position) { this.state.setPositionSource(position, 'AI'); }
  key(position) { return positionKey(position.symbol, position.positionSide); }
}
module.exports = RiskManager;
