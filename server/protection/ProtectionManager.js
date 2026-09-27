// 自动保护核心。
// 只负责“保护真实仓位”，不提供加仓/减仓/自动调仓。
// V11.2.0：单一实时 Mark 快照；交易所事实优先；真实杠杆/强平价必须可信；风险变化自动重保护；重复 QP 单清理；Trailing 数量同步；Algo 变更队列统一。
const Logger = require('../Logger');
const { normalizeSymbol, positionKey } = require('../utils/symbol');

const ACTIVE_STATUSES = new Set(['NEW', 'WORKING', 'PARTIALLY_FILLED']);

class ProtectionManager {
  constructor({ binance, state, config, emergency, userStream }) {
    this.binance = binance;
    this.state = state;
    this.config = config;
    this.emergency = emergency;
    this.userStream = userStream;
    // 同一仓位同时收到多个事件时，共用同一个保护 Promise，禁止“假成功”。
    this.locks = new Map();
    this.pendingRequests = new Map();
    // 低延迟保护模式下，TP 可先进入 Algo 队列而不阻塞本次保护返回。
    // 这样开仓后先确认 SL，并立即启用本地 Mark Price TP 兜底；TP 到可提交窗口后再自动复核。
    this.pendingFixedProtectionJobs = new Map();
    this.failureCounts = new Map();
    this.algoUpdates = new Map();
    // 我们主动撤销重复保护单时，Binance 会回推 ALGO_UPDATE；这些内部撤单不应再次触发保护自激。
    this.suppressedAlgoReviews = new Map();
    this.positionGenerations = new Map();
    // 诊断日志只在保护状态发生变化时记录，避免每3秒重复刷屏。
    this.lastDiagnosticLogState = new Map();
    // Mark Price 1s 本地保护兜底：用于 Algo SL 尚未建成或交易所触发事件异常时的最后一道防线。
    this.localStopFallbackInFlight = new Map();
    this.localTpFallbackInFlight = new Map();
    this.localStopCrossLoggedAt = new Map();
    this.localTpCrossLoggedAt = new Map();
    this.latestMarkPrices = new Map();
    this.latestMarkMeta = new Map();
    this.trailingActivationInFlight = new Map();
    this.localStopGraceMs = 50;
    this.localFallbackPositionReadTimeoutMs = 80;
  }

  key(p) { return positionKey(p.symbol, p.positionSide); }

  positionGeneration(p) {
    const key = this.key(p);
    if (!this.positionGenerations.has(key)) this.positionGenerations.set(key, 0);
    return this.positionGenerations.get(key);
  }

  isPositionGenerationCurrent(key, generation) {
    return this.positionGenerations.get(String(key)) === generation;
  }

  invalidatePositionGeneration(p, reason = 'POSITION_CLOSED') {
    const key = this.key(p);
    const next = this.positionGeneration(p) + 1;
    this.positionGenerations.set(key, next);
    this.pendingRequests.delete(key);
    this.pendingFixedProtectionJobs.delete(`${key}|STOP_MARKET`);
    this.pendingFixedProtectionJobs.delete(`${key}|TAKE_PROFIT_MARKET`);
    this.latestMarkPrices.delete(key);
    this.latestMarkMeta.delete(key);
    this.trailingActivationInFlight.delete(key);
    this.localStopFallbackInFlight.delete(key);
    this.localTpFallbackInFlight.delete(key);
    const cancelledQueuedJobs = typeof this.binance.cancelQueuedAlgoJobs === 'function'
      ? this.binance.cancelQueuedAlgoJobs(key, 'POSITION_CLOSED_WHILE_QUEUED')
      : 0;
    Logger.info('保护世代已失效', { symbol: p.symbol, positionSide: p.positionSide, generation: next, reason, cancelledQueuedJobs });
    return { key, generation: next, cancelledQueuedJobs };
  }
  side(p) { return p.side === 'long' ? 'SELL' : 'BUY'; }
  algoIdOf(o) { return o?.algoId ?? o?.aid ?? o?.id ?? o?.orderId ?? null; }
  clientAlgoIdOf(o) { return o?.clientAlgoId ?? o?.clientOrderId ?? o?.newClientStrategyId ?? null; }
  orderPrice(o) { return o ? Number(o.triggerPrice ?? o.stopPrice ?? o.activatePrice ?? 0) || null : null; }
  orderQty(o) { return o ? Number(o.quantity ?? o.origQty ?? 0) || null : null; }
  boolish(v) { return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true'; }

  isClosingConditional(o, p) {
    const positionSide = String(o.positionSide || 'BOTH').toUpperCase();
    // Hedge Mode 下，正确的 positionSide + 反向 side 本身就限定为平该方向仓位。
    if (positionSide !== 'BOTH') return true;
    // One-way 下必须明确是 closePosition 或 reduceOnly，普通条件单不能冒充保护。
    return this.boolish(o.closePosition ?? o.closeAll ?? o.cp)
      || this.boolish(o.reduceOnly ?? o.ro);
  }

  isMatchingOrder(o, p) {
    return normalizeSymbol(o.symbol) === normalizeSymbol(p.symbol)
      && String(o.positionSide || 'BOTH').toUpperCase() === String(p.positionSide || 'BOTH').toUpperCase()
      && String(o.side || '').toUpperCase() === this.side(p)
      && this.isClosingConditional(o, p);
  }
  isActive(o) { return ACTIVE_STATUSES.has(String(o.algoStatus || o.status || o.strategyStatus || '').toUpperCase()); }
  isOurs(o) { return /^QP_/i.test(String(this.clientAlgoIdOf(o) || '')); }

  liquidationSafety(p, bufferPp = Number(this.config.get()?.protection?.liquidationBufferPp ?? 0.5)) {
    const e = Number(p.entryPrice);
    const liq = Number(p.liquidationPrice);
    const buffer = Math.max(0, Number(bufferPp) || 0);
    if (!(e > 0)) return { ok: false, reason: 'INVALID_ENTRY' };
    if (!(liq > 0)) return { ok: false, reason: 'LIQUIDATION_PRICE_UNAVAILABLE' };
    if (p.side === 'long' && !(liq < e)) return { ok: false, reason: 'INVALID_LONG_LIQUIDATION_PRICE' };
    if (p.side === 'short' && !(liq > e)) return { ok: false, reason: 'INVALID_SHORT_LIQUIDATION_PRICE' };
    return {
      ok: true,
      liquidationPrice: liq,
      bufferPp: buffer,
      bufferPrice: e * (buffer / 100),
      safeFloor: liq < e ? liq + e * (buffer / 100) : null,
      safeCeil: liq > e ? liq - e * (buffer / 100) : null
    };
  }

  isDirectionallyValidSL(p, price) {
    const e = Number(p.entryPrice), v = Number(price);
    if (!(e > 0 && v > 0)) return false;
    return p.side === 'long' ? v < e : v > e;
  }

  isSafeSLPrice(p, price, bufferPp = Number(this.config.get()?.protection?.liquidationBufferPp ?? 0.5)) {
    if (!this.isDirectionallyValidSL(p, price)) return false;
    const safety = this.liquidationSafety(p, bufferPp);
    if (!safety.ok) return false;
    if (p.side === 'long') return Number(price) > safety.safeFloor;
    return Number(price) < safety.safeCeil;
  }

  isDirectionallyValidTP(p, price) {
    const e = Number(p.entryPrice), v = Number(price);
    if (!(e > 0 && v > 0)) return false;
    return p.side === 'long' ? v > e : v < e;
  }

  stopWouldTriggerImmediately(p, price, markPrice = p.markPrice) {
    const mark = Number(markPrice), trigger = Number(price);
    if (!(mark > 0 && trigger > 0)) return false;
    return p.side === 'long' ? mark <= trigger : mark >= trigger;
  }

  takeProfitWouldTriggerImmediately(p, price, markPrice = p.markPrice) {
    const mark = Number(markPrice), trigger = Number(price);
    if (!(mark > 0 && trigger > 0)) return false;
    return p.side === 'long' ? mark >= trigger : mark <= trigger;
  }

  stopHasCrossed(p, markPrice, stopPrice) {
    const mark = Number(markPrice), trigger = Number(stopPrice);
    if (!(mark > 0 && trigger > 0)) return false;
    return p.side === 'long' ? mark <= trigger : mark >= trigger;
  }

  async handleMarkPrice(p, markPrice, meta = {}) {
    if (!this.config.get().autoProtection) return { ok: false, skipped: true };
    const mark = Number(markPrice);
    if (!(mark > 0)) return { ok: false, skipped: true };
    const key = this.key(p);
    const receivedAt = Number(meta.receivedAt || Date.now());
    this.latestMarkPrices.set(key, mark);
    this.latestMarkMeta.set(key, {
      markPrice: mark,
      eventTime: Number(meta.eventTime || 0),
      transactionTime: Number(meta.transactionTime || 0),
      receivedAt,
      wsLatencyMs: Number.isFinite(Number(meta.wsLatencyMs)) ? Number(meta.wsLatencyMs) : null
    });
    const protection = this.state.getProtectionMeta(p) || {};
    const stopPrice = Number(protection.activeSL || protection.targetSL || 0);
    const tpPrice = Number(protection.activeTP || protection.targetTP || 0);

    // P0：止损/止盈目标一旦被 1s Mark Price 穿越，本地立即进入市场平仓兜底。
    // 交换端 Algo 仍然是第一执行者；本地兜底只解决 Algo 尚未创建、限频等待或事件延迟的窗口。
    const stopCrossed = stopPrice > 0 && this.stopHasCrossed(p, mark, stopPrice);
    const tpCrossed = tpPrice > 0 && this.takeProfitWouldTriggerImmediately(p, tpPrice, mark);
    if (stopCrossed || tpCrossed) {
      // 目标已经被实时 Mark Price 穿越：取消尚未执行的 Algo 建单任务，防止等待限频后再发送已经失效的旧保护。
      const cancelReason = stopCrossed ? 'TARGET_CROSSED_WHILE_QUEUED_SL' : 'TARGET_CROSSED_WHILE_QUEUED_TP';
      if (typeof this.binance?.cancelQueuedAlgoJobs === 'function') this.binance.cancelQueuedAlgoJobs(key, cancelReason);
    }
    if (stopCrossed) return this._runLocalMarketFallback(p, 'SL', stopPrice, mark, meta);
    if (tpCrossed) return this._runLocalMarketFallback(p, 'TP', tpPrice, mark, meta);

    // P0：Trailing 激活不再依赖下一次持仓事件；首次跨越激活线即立即触发一次保护复核。
    const cfg = this.config.get();
    const activationPct = Number(cfg?.protection?.trailingActivationPct || 0);
    if (cfg?.protection?.trailingEnabled === true && activationPct > 0 && Number(p.entryPrice) > 0 && !(this.trailingActivationInFlight.has(key))) {
      const profitable = p.side === 'long'
        ? mark >= Number(p.entryPrice) * (1 + activationPct / 100)
        : mark <= Number(p.entryPrice) * (1 - activationPct / 100);
      const queued = typeof this.binance?.getQueuedAlgoJobs === 'function'
        ? this.binance.getQueuedAlgoJobs(key).some(job => String(job.label || '').toUpperCase() === 'TRAILING')
        : false;
      const trailingAlreadyKnown = !!(protection.activeTrailingAlgoId || protection.trailingAlgoId || protection.trailingActive);
      if (profitable && !queued && !trailingAlreadyKnown) {
        this.trailingActivationInFlight.set(key, true);
        Logger.info('移动保护实时激活条件达到', {
          symbol: p.symbol, positionSide: p.positionSide, entryPrice: Number(p.entryPrice),
          markPrice: mark, favorableMovePct: Number((Math.abs(mark - Number(p.entryPrice)) / Number(p.entryPrice) * 100).toFixed(4)),
          activationPct, eventTime: meta.eventTime || null, wsLatencyMs: meta.wsLatencyMs ?? null
        });
        Promise.resolve(this.reconcile({ ...p, markPrice: mark }, { forceConfig: false, reason: 'MARK_PRICE_TRAILING_ACTIVATION' }))
          .catch(error => {
            if (!error?.protectionLogged) Logger.error('移动保护实时激活复核失败', { symbol: p.symbol, positionSide: p.positionSide, error, code: error?.code || null, status: error?.status || null });
          })
          .finally(() => this.trailingActivationInFlight.delete(key));
        return { ok: true, trailingActivationTriggered: true };
      }
    }
    return { ok: false, skipped: true };
  }

  async _runLocalMarketFallback(p, kind, triggerPrice, mark, meta = {}) {
    const isSL = kind === 'SL';
    const map = isSL ? this.localStopFallbackInFlight : this.localTpFallbackInFlight;
    const loggedMap = isSL ? this.localStopCrossLoggedAt : this.localTpCrossLoggedAt;
    const key = this.key(p);
    if (map.has(key)) return { ok: false, inFlight: true };
    const confirmed = isSL ? Number((this.state.getProtectionMeta(p) || {}).activeSL || 0) > 0 : Number((this.state.getProtectionMeta(p) || {}).activeTP || 0) > 0;
    const now = Date.now();
    const crossKey = `${key}|${kind}|${triggerPrice}`;
    if (!loggedMap.has(crossKey)) {
      loggedMap.set(crossKey, now);
      const logFn = confirmed ? Logger.warn : Logger.error;
      logFn(isSL ? '本地 Mark Price 观察到止损已穿越' : '本地 Mark Price 观察到止盈已达到', {
        symbol: p.symbol, positionSide: p.positionSide, markPrice: mark, triggerPrice,
        exchangeOrderConfirmed: confirmed, eventTime: meta.eventTime || null, wsLatencyMs: meta.wsLatencyMs ?? null,
        source: confirmed ? `CONFIRMED_EXCHANGE_${kind}` : `PENDING_EXCHANGE_${kind}`
      });
    }

    const source = this.state.getPositionSource(p);
    const task = (async () => {
      try {
        if (this.localStopGraceMs > 0) await new Promise(r => setTimeout(r, this.localStopGraceMs));
        // 优先读取最新仓位，但设置 120ms 硬上限；REST 超时就立即使用当前实时快照执行本地兜底。
        let fresh = null;
        try {
          fresh = await Promise.race([
            this.refreshPosition(p, { forceConfig: false }),
            new Promise(resolve => setTimeout(() => resolve(null), this.localFallbackPositionReadTimeoutMs))
          ]);
        } catch {}
        if (!fresh) fresh = { ...p, markPrice: mark };
        const liveMark = mark; // 当前 1s Mark Price 才是最快的实时事实；REST 只用于刷新数量/仓位存在性。
        const liveTrigger = Number(triggerPrice);
        const stillCrossed = isSL ? this.stopHasCrossed(fresh, liveMark, liveTrigger) : this.takeProfitWouldTriggerImmediately(fresh, liveTrigger, liveMark);
        if (!(Number(fresh.contracts) > 0) || !stillCrossed) {
          Logger.info(isSL ? '本地止损兜底复核后无需平仓' : '本地止盈兜底复核后无需平仓', { symbol: fresh.symbol, positionSide: fresh.positionSide, contracts: fresh.contracts, markPrice: liveMark, triggerPrice: liveTrigger, readTimeoutMs: this.localFallbackPositionReadTimeoutMs });
          return { ok: false, skipped: true };
        }
        Logger.warn(isSL ? '本地极速止损兜底执行市价平仓' : '本地极速止盈兜底执行市价平仓', {
          symbol: fresh.symbol, positionSide: fresh.positionSide, contracts: fresh.contracts, markPrice: liveMark, triggerPrice: liveTrigger,
          exchangeOrderConfirmed: confirmed, source: source === 'AI' ? `AI_${kind}_BACKSTOP` : `MANUAL_${kind}_BACKSTOP`
        });
        const result = await this.emergency.closePositionMarket(fresh);
        Logger.warn(isSL ? '本地极速止损兜底平仓请求已发送' : '本地极速止盈兜底平仓请求已发送', {
          symbol: fresh.symbol, positionSide: fresh.positionSide, contracts: fresh.contracts, orderId: result?.orderId || null,
          wsLatencyMs: meta.wsLatencyMs ?? null, fallbackLatencyMs: Date.now() - now, triggerPrice: liveTrigger, markPrice: liveMark
        });
        return { ok: true, fallback: true, result };
      } catch (error) {
        if (error?.code === 'POSITION_NOT_FOUND' || /position.*not found|no position|unknown order|insufficient.*position/i.test(String(error?.message || ''))) {
          Logger.info(isSL ? '本地止损兜底执行时仓位已不存在，视为其它保护已完成' : '本地止盈兜底执行时仓位已不存在，视为其它保护已完成', { symbol: p.symbol, positionSide: p.positionSide, code: error.code || null, message: error.message });
          return { ok: false, alreadyClosed: true };
        }
        Logger.error(isSL ? '本地极速止损兜底失败' : '本地极速止盈兜底失败', { symbol: p.symbol, positionSide: p.positionSide, error, code: error.code || null, status: error.status || null });
        throw error;
      } finally {
        map.delete(key);
      }
    })();
    map.set(key, task);
    return task;
  }

  isUsableSL(p, price) {
    return this.isSafeSLPrice(p, price) && !this.stopWouldTriggerImmediately(p, price);
  }

  isUsableTP(p, price) {
    return this.isDirectionallyValidTP(p, price) && !this.takeProfitWouldTriggerImmediately(p, price);
  }

  isStricterSL(p, candidatePrice, referencePrice) {
    const c = Number(candidatePrice), r = Number(referencePrice);
    if (!(c > 0 && r > 0)) return false;
    // “更严格” = 反向行情只需要更小的价格移动就会触发：
    // LONG 止损越高越严格；SHORT 止损越低越严格。
    return p.side === 'long' ? c > r : c < r;
  }

  isStricterTP(p, candidatePrice, referencePrice) {
    const c = Number(candidatePrice), r = Number(referencePrice);
    if (!(c > 0 && r > 0)) return false;
    // “更严格/更保守”的止盈 = 更早获利退出：LONG 越低越严格，SHORT 越高越严格。
    return p.side === 'long' ? c < r : c > r;
  }

  strictestTP(p, orders = []) {
    const valid = orders.filter(o => this.isUsableTP(p, this.orderPrice(o)));
    if (!valid.length) return null;
    return valid.reduce((best, o) => {
      if (!best) return o;
      return this.isStricterTP(p, this.orderPrice(o), this.orderPrice(best)) ? o : best;
    }, null);
  }

  strictestSL(p, orders = []) {
    const valid = orders.filter(o => this.isUsableSL(p, this.orderPrice(o)));
    if (!valid.length) return null;
    return valid.reduce((best, o) => {
      if (!best) return o;
      return this.isStricterSL(p, this.orderPrice(o), this.orderPrice(best)) ? o : best;
    }, null);
  }

  pickTPForTarget(p, orders = [], targetPrice = null) {
    const usable = orders.filter(o => this.isUsableTP(p, this.orderPrice(o)));
    if (!usable.length) return null;
    if (targetPrice != null) {
      const exact = usable.find(o => this.samePrice(this.orderPrice(o), targetPrice, Number(this.binance.tickSize(p.symbol)) || null));
      if (exact) return exact;
    }
    return usable.find(o => this.isOurs(o)) || usable[0];
  }

  markInternalAlgoCancel(algoId, ttlMs = null) {
    if (algoId == null) return;
    // 撤单也进入全局 Algo 变更队列；真实队列等待可能超过 15 秒。
    // suppression 必须覆盖最长可能的本地排队时间，否则自己的撤单回推会再次自激保护。
    const queueWindow = Number(this.binance?.algoOrderMinIntervalMs || 61000);
    const ttl = Math.max(Number(ttlMs || 0), queueWindow * 10, 10 * 60 * 1000);
    this.suppressedAlgoReviews.set(String(algoId), Date.now() + ttl);
  }

  isInternalAlgoCancel(algoId) {
    if (algoId == null) return false;
    const key = String(algoId);
    const expiresAt = this.suppressedAlgoReviews.get(key);
    if (!expiresAt) return false;
    if (expiresAt < Date.now()) {
      this.suppressedAlgoReviews.delete(key);
      return false;
    }
    return true;
  }

  async cancelExtraProtectionOrders(p, orders, keep, label) {
    const keepId = this.algoIdOf(keep);
    const typeSet = label === 'SL'
      ? new Set(['STOP_MARKET', 'STOP'])
      : label === 'TP'
        ? new Set(['TAKE_PROFIT_MARKET', 'TAKE_PROFIT'])
        : new Set(['TRAILING_STOP_MARKET']);
    for (const o of orders || []) {
      if (!typeSet.has(String(o.orderType || o.type || o.strategyType).toUpperCase())) continue;
      const id = this.algoIdOf(o);
      if (id == null || String(id) === String(keepId)) continue;
      try {
        if (o.__protectionTransport === 'ORDER') {
          await this.binance.cancelOrder(p.symbol, o.orderId, o.clientOrderId);
          Logger.warn('已清理多余普通条件保护单', { symbol: p.symbol, positionSide: p.positionSide, label, orderId: o.orderId, clientOrderId: o.clientOrderId || null, ours: this.isOurs(o) });
        } else {
          this.markInternalAlgoCancel(id);
          await this.binance.cancelAlgoOrder(p.symbol, id);
          Logger.warn('已清理多余同仓位保护单', { symbol: p.symbol, positionSide: p.positionSide, label, algoId: id, ours: this.isOurs(o) });
        }
      } catch (e) {
        Logger.warn('多余保护单清理失败', { symbol: p.symbol, positionSide: p.positionSide, label, orderId: o.orderId || null, algoId: id || null, error: e.message });
      }
    }
  }

  async listProtection(p) {
    const [algoOrders, normalOrders] = await Promise.all([
      typeof this.binance.fetchOpenAlgoOrders === 'function' ? this.binance.fetchOpenAlgoOrders(p.symbol) : Promise.resolve([]),
      typeof this.binance.fetchOpenOrders === 'function' ? this.binance.fetchOpenOrders(p.symbol) : Promise.resolve([])
    ]);
    const normalize = (rows, transport) => (rows || [])
      .filter(o => this.isActive(o) && this.isMatchingOrder(o, p))
      .map(o => ({ ...o, __protectionTransport: transport }));
    return [
      ...normalize(algoOrders, 'ALGO'),
      ...normalize(normalOrders, 'ORDER')
    ];
  }

  classify(p, orders) {
    const sls = orders.filter(o => ['STOP_MARKET', 'STOP'].includes(String(o.orderType || o.type || o.strategyType).toUpperCase()));
    const tps = orders.filter(o => ['TAKE_PROFIT_MARKET', 'TAKE_PROFIT'].includes(String(o.orderType || o.type || o.strategyType).toUpperCase()));
    const trs = orders.filter(o => String(o.orderType || o.type || o.strategyType).toUpperCase() === 'TRAILING_STOP_MARKET');

    const safeSL = this.strictestSL(p, sls);
    const pickSL = safeSL || sls.find(o => this.isOurs(o)) || sls[0] || null;
    const expectedTP = p.__protectionExpectedTP;
    const usableTP = this.pickTPForTarget(p, tps, expectedTP);
    const strictestTP = this.strictestTP(p, tps);
    const pickTP = strictestTP || usableTP || tps.find(o => this.isOurs(o)) || tps[0] || null;
    const trailing = trs.find(o => this.isOurs(o)) || trs[0] || null;

    return {
      sl: pickSL,
      tp: pickTP,
      trailing,
      sls,
      tps,
      trs,
      slOurs: !!pickSL && this.isOurs(pickSL),
      tpOurs: !!pickTP && this.isOurs(pickTP),
      trailingOurs: !!trailing && this.isOurs(trailing)
    };
  }

  resolveProtectionParams(p, options = {}) {
    const cfg = this.config.get();
    const stored = this.state.getProtectionParams?.(p) || {};
    const suppliedMode = options.mode || (options.forcePriceMode ? 'PRICE' : null);
    const mode = String(suppliedMode || stored.mode || cfg.protection.calculationMode || 'MARGIN').toUpperCase() === 'PRICE' ? 'PRICE' : 'MARGIN';

    if (mode === 'PRICE') {
      const sl = Number(options.stopLossPct ?? stored.stopLossPct ?? cfg.protection.stopLossPct);
      const tp = Number(options.takeProfitPct ?? stored.takeProfitPct ?? cfg.protection.takeProfitPct);
      if (!(sl > 0 && tp > 0)) throw new Error('保护参数无效：价格止损/止盈必须大于 0');
      return {
        mode,
        stopLossPct: sl,
        takeProfitPct: tp,
        leverage: Number(p.leverage) > 0 ? Number(p.leverage) : null,
        liquidationBufferPp: Number(cfg.protection.liquidationBufferPp ?? 0.5)
      };
    }

    const leverage = Number(p.leverage);
    if (!(leverage > 0)) throw new Error('无法读取当前仓位实际杠杆，拒绝使用默认杠杆猜测保护价格');
    const slMargin = Number(options.stopLossMarginPct ?? stored.stopLossMarginPct ?? cfg.protection.stopLossMarginPct ?? 20);
    const tpMargin = Number(options.takeProfitMarginPct ?? stored.takeProfitMarginPct ?? cfg.protection.takeProfitMarginPct ?? 40);
    if (!(slMargin > 0 && tpMargin > 0)) throw new Error('保护参数无效：保证金止损/止盈必须大于 0');
    return {
      mode,
      leverage,
      stopLossMarginPct: slMargin,
      takeProfitMarginPct: tpMargin,
      stopLossPct: slMargin / leverage,
      takeProfitPct: tpMargin / leverage,
      liquidationBufferPp: Number(cfg.protection.liquidationBufferPp ?? 0.5)
    };
  }

  protectionTargets(p, options = {}) {
    const params = this.resolveProtectionParams(p, options);
    const e = Number(p.entryPrice);
    if (!(e > 0)) throw new Error(`无法计算保护价格：${p.symbol} 开仓价无效`);

    // 所有自动保护模式都必须先获得一个可信的强平价；这样不会把“未知”误判成安全。
    const safety = this.liquidationSafety(p, params.liquidationBufferPp);
    if (!safety.ok) throw new Error(`无法计算保护价格：Binance 强平价无效（${safety.reason}）`);

    let slPct = Number(params.stopLossPct);
    const tpPct = Number(params.takeProfitPct);
    let sl = p.side === 'long' ? e * (1 - slPct / 100) : e * (1 + slPct / 100);
    const tp = p.side === 'long' ? e * (1 + tpPct / 100) : e * (1 - tpPct / 100);
    if (!(tp > 0)) throw new Error('无法计算保护价格：止盈百分比导致触发价格无效');
    let liquidationAdjusted = false;

    if (p.side === 'long') {
      const safeFloor = safety.safeFloor;
      if (!(safeFloor < e)) throw new Error('当前仓位距离强平价过近，无法放置安全止损');
      if (sl <= safeFloor) {
        sl = safeFloor;
        slPct = (e - sl) / e * 100;
        liquidationAdjusted = true;
      }
    } else {
      const safeCeil = safety.safeCeil;
      if (!(safeCeil > e)) throw new Error('当前仓位距离强平价过近，无法放置安全止损');
      if (sl >= safeCeil) {
        sl = safeCeil;
        slPct = (sl - e) / e * 100;
        liquidationAdjusted = true;
      }
    }

    return {
      ...params,
      sl,
      tp,
      effectiveStopLossPct: Number(slPct),
      effectiveTakeProfitPct: Number(tpPct),
      liquidationAdjusted
    };
  }

  prices(p, stopLossPct = this.config.get().protection.stopLossPct, takeProfitPct = this.config.get().protection.takeProfitPct) {
    const e = Number(p.entryPrice);
    const sl = Number(stopLossPct), tp = Number(takeProfitPct);
    if (!(e > 0)) throw new Error(`无法计算保护价格：${p.symbol} 开仓价无效`);
    if (p.side === 'long') return { sl: e * (1 - sl / 100), tp: e * (1 + tp / 100) };
    return { sl: e * (1 + sl / 100), tp: e * (1 - tp / 100) };
  }

  samePrice(a, b, tickSize = null) {
    const x = Number(a), y = Number(b);
    if (!(x > 0 && y > 0)) return false;
    // Binance 回读价格可能因舍入落在相邻一个 tick。1 tick 内视为同一保护目标，
    // 避免“0.07049 vs 0.07048”这类纯取整差异触发假告警/重复重保护。
    const tol = tickSize > 0 ? tickSize + 1e-15 : Math.max(1e-10, Math.abs(y) * 1e-8);
    return Math.abs(x - y) <= tol;
  }

  sameQuantity(a, b, stepSize = null) {
    const x = Number(a), y = Number(b);
    if (!(x > 0 && y > 0)) return false;
    const tol = stepSize > 0 ? stepSize / 2 + 1e-12 : Math.max(1e-10, Math.abs(y) * 1e-8);
    return Math.abs(x - y) <= tol;
  }

  async refreshPosition(p, { forceConfig = true } = {}) {
    let fresh;
    try {
      fresh = await this.binance.fetchPositions(p.symbol, { forceConfig });
    } catch (e) {
      const err = new Error(`无法读取 Binance 最新仓位，禁止使用旧数据创建保护：${e.message}`);
      err.code = 'POSITION_REFRESH_FAILED';
      throw err;
    }
    const positionRestReadAt = Date.now();
    const wantedSide = String(p.positionSide || 'BOTH').toUpperCase();
    const currentRaw = (fresh || []).find(x => String(x.positionSide || 'BOTH').toUpperCase() === wantedSide);
    if (!currentRaw) {
      const err = new Error(`Binance 最新仓位中未找到 ${normalizeSymbol(p.symbol)} ${wantedSide}，可能已平仓或已反向`);
      err.code = 'POSITION_NOT_FOUND';
      throw err;
    }

    // 保护计算使用 Binance REST 的结构化仓位事实，但价格/收益实时诊断优先采用
    // 最近 1s Mark Price WS；这样“持仓表 / 详情 / Trailing / PnL”不会各自使用不同 Mark。
    const key = this.key(currentRaw);
    const markMeta = this.latestMarkMeta.get(key);
    const restMark = Number(currentRaw.markPrice);
    const liveMark = Number(markMeta?.markPrice);
    const markFresh = liveMark > 0 && Number(markMeta?.receivedAt) > 0 && Date.now() - Number(markMeta.receivedAt) <= 5000;
    const current = { ...currentRaw };
    current.exchangeUnrealizedPnl = Number.isFinite(Number(currentRaw.unrealizedPnl)) ? Number(currentRaw.unrealizedPnl) : null;
    current.exchangeMarkPrice = restMark > 0 ? restMark : null;
    if (markFresh) {
      const qty = Math.abs(Number(current.contracts || 0));
      const entry = Number(current.entryPrice || 0);
      current.markPrice = liveMark;
      current.markPriceSource = 'MARK_PRICE_WS';
      current.markPriceEventTime = Number(markMeta.eventTime || 0);
      current.markPriceReceivedAt = Number(markMeta.receivedAt);
      current.markPriceLatencyMs = markMeta.wsLatencyMs;
      if (qty > 0 && entry > 0) {
        current.unrealizedPnl = Number(((String(current.side).toLowerCase() === 'long' ? (liveMark - entry) : (entry - liveMark)) * qty).toFixed(8));
        current.notional = Number((qty * liveMark).toFixed(8));
        current.unrealizedPnlSource = 'MARK_PRICE_WS_DERIVED';
      }
    } else {
      current.markPriceSource = 'BINANCE_POSITION_REST';
      current.unrealizedPnlSource = 'BINANCE_POSITION_REST';
    }
    current.positionRestReadAt = positionRestReadAt;
    current.positionSnapshotAt = Math.max(
      positionRestReadAt,
      Number(markMeta?.receivedAt || 0),
      Number(currentRaw.updatedAt || 0)
    );
    return current;
  }

  exchangeProtectionTargets(p, targets) {
    const tickSize = Number(this.binance.tickSize(p.symbol)) || null;
    let sl = this.binance.roundPrice(p.symbol, targets.sl, p.side === 'long' ? 'floor' : 'ceil');
    const tp = this.binance.roundPrice(p.symbol, targets.tp, p.side === 'long' ? 'ceil' : 'floor');

    if (!(tickSize > 0)) {
      if (!this.isSafeSLPrice(p, sl)) throw new Error('止损取整后无法保持强平安全缓冲');
      if (!this.isDirectionallyValidTP(p, tp)) throw new Error('止盈取整后方向无效');
      return { sl, tp, tickSize: null };
    }

    // 取整后若第一格跨过安全边界，逐格向开仓价方向回退。
    for (let i = 0; i < 1000 && !this.isSafeSLPrice(p, sl); i++) {
      sl = p.side === 'long' ? sl + tickSize : sl - tickSize;
      sl = Number(sl.toPrecision(15));
    }
    if (!this.isSafeSLPrice(p, sl)) throw new Error('止损按 Binance tickSize 取整后无法保持强平安全缓冲');
    if (!this.isDirectionallyValidTP(p, tp)) throw new Error('止盈按 Binance tickSize 取整后方向无效');
    return { sl, tp, tickSize };
  }

  makeClientAlgoId(kind, p) {
    // 36字符以内，尽量保留 Symbol/Side，并加入随机后缀避免同毫秒重复。
    const symbol = normalizeSymbol(p.symbol).slice(0, 14);
    const side = String(p.positionSide || 'BOTH').toUpperCase().slice(0, 5);
    const nonce = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    return `QP_${kind}_${symbol}_${side}_${nonce}`.replace(/[^A-Z0-9_]/gi, '').slice(0, 36);
  }

  async cancelDuplicateOurs(p, orders, keep, label) {
    const keepId = this.algoIdOf(keep);
    const typeSet = label === 'SL'
      ? new Set(['STOP_MARKET', 'STOP'])
      : label === 'TP'
        ? new Set(['TAKE_PROFIT_MARKET', 'TAKE_PROFIT'])
        : new Set(['TRAILING_STOP_MARKET']);
    for (const o of orders || []) {
      if (!this.isOurs(o) || !typeSet.has(String(o.orderType || o.type || o.strategyType).toUpperCase())) continue;
      const id = this.algoIdOf(o);
      if (id == null || String(id) === String(keepId)) continue;
      try {
        if (o.__protectionTransport === 'ORDER') {
          await this.binance.cancelOrder(p.symbol, o.orderId, o.clientOrderId);
          Logger.warn('已清理重复 QP 普通保护单', { symbol: p.symbol, positionSide: p.positionSide, label, orderId: o.orderId || null, clientOrderId: o.clientOrderId || null });
        } else {
          this.markInternalAlgoCancel(id);
          await this.binance.cancelAlgoOrder(p.symbol, id);
          Logger.warn('已清理重复 QP Algo 保护单', { symbol: p.symbol, positionSide: p.positionSide, label, algoId: id });
        }
      } catch (e) {
        Logger.warn('重复 QP 保护单清理失败', { symbol: p.symbol, positionSide: p.positionSide, label, orderId: o.orderId || null, algoId: id || null, error: e.message });
      }
    }
  }

  async createWithIdempotency(createFn, p, label, expectedClientAlgoId) {
    try {
      return await createFn();
    } catch (e) {
      if (/TIMEOUT|ECONN|fetch|network|socket|ETIMEDOUT/i.test(String(e.code || '') + e.message)) {
        try {
          const orders = await this.listProtection(p);
          const found = (orders || []).find(o => String(this.clientAlgoIdOf(o) || '') === String(expectedClientAlgoId || ''));
          if (found) return found;
        } catch {}
      }
      throw e;
    }
  }

  async createAlgoFixedProtection({ p, label, type, triggerPrice, queueMeta, traceId }) {
    const clientAlgoId = this.makeClientAlgoId(label, p);
    const startedAt = Date.now();
    const created = await this.createWithIdempotency(
      () => this.binance.createProtectionOrder({
        symbol: p.symbol,
        side: this.side(p),
        type,
        triggerPrice,
        positionSide: p.positionSide,
        clientAlgoId,
        priceProtect: this.config.get().protection.priceProtect === true,
        ...queueMeta
      }),
      p,
      label,
      clientAlgoId
    );
    Logger.info(`${label} Algo条件单已提交`, {
      traceId,
      symbol: p.symbol,
      positionSide: p.positionSide,
      algoId: this.algoIdOf(created),
      clientAlgoId,
      triggerPrice,
      elapsedMs: Date.now() - startedAt,
      transport: 'ALGO'
    });
    return created;
  }

  hasPendingFixedProtection(p, type) {
    return this.pendingFixedProtectionJobs.has(`${this.key(p)}|${String(type).toUpperCase()}`);
  }

  scheduleAsyncFixedProtection(p, { label, type, triggerPrice, queueMeta, traceId, generation }) {
    const key = this.key(p);
    const pendingKey = `${key}|${String(type).toUpperCase()}`;
    const existing = this.pendingFixedProtectionJobs.get(pendingKey);
    if (existing) return existing;

    const promise = this.createAlgoFixedProtection({ p, label, type, triggerPrice, queueMeta, traceId });
    this.pendingFixedProtectionJobs.set(pendingKey, promise);
    promise.then((created) => {
      if (this.pendingFixedProtectionJobs.get(pendingKey) === promise) this.pendingFixedProtectionJobs.delete(pendingKey);
      Logger.info(`${label} 已从低延迟保护队列提交完成`, {
        traceId, symbol: p.symbol, positionSide: p.positionSide,
        algoId: this.algoIdOf(created), triggerPrice
      });
      // 不在当前保护锁结束前再次调用 protect，避免队列任务刚完成时形成保护自激循环。
      // Binance 的 ALGO_UPDATE 会触发下一次复核；若没有事件，后续持仓同步也会再次复核。
    }).catch((error) => {
      if (this.pendingFixedProtectionJobs.get(pendingKey) === promise) this.pendingFixedProtectionJobs.delete(pendingKey);
      const harmlessCancellation = error?.name === 'AlgoQueueCancelledError'
        && ['POSITION_CLOSED_WHILE_QUEUED', 'TARGET_CROSSED_WHILE_QUEUED_SL', 'TARGET_CROSSED_WHILE_QUEUED_TP'].includes(String(error.reason || ''));
      (harmlessCancellation ? Logger.info : Logger.error)(`${label} 异步固定保护${harmlessCancellation ? '任务已取消' : '提交失败'}`, {
        traceId, symbol: p.symbol, positionSide: p.positionSide,
        error: harmlessCancellation ? (error.reason || error.message) : error, code: error.code || null, status: error.status || null, protectionStage: '异步固定保护提交'
      });
      // 保留本地 Mark Price 兜底；下一次仓位/保护事件会再次尝试提交。
    });
    return promise;
  }

  async _protect(p, options = {}) {
    if (!this.config.get().autoProtection) return { ok: false, skipped: true, state: 'UNPROTECTED' };
    const key = this.key(p);
    const generation = this.positionGeneration(p);
    const queueGuard = () => this.isPositionGenerationCurrent(key, generation);
    const queueMeta = { queueKey: key, queueGuard };
    const traceId = options.traceId || Logger.nextId('PROTECT');
    let stage = '启动保护流程';
    this.state.setProtectionState(p, 'PROTECTING');
    Logger.info('保护流程开始', { traceId, symbol: p.symbol, positionSide: p.positionSide, reason: options.reason || 'UNKNOWN', forceConfig: options.forceConfig !== false });

    try {
      stage = '并行读取最新仓位与现有保护';
      // 绝不使用调用方旧快照直接计算新的自动保护价格。
      // 低延迟优化：仓位 REST 与现有 Algo 保护查询并行，避免开仓后串行等待两次网络往返。
      const initialProtectionRead = this.listProtection(p);
      p = await this.refreshPosition(p, { forceConfig: options.forceConfig !== false });
      const existingOrdersAtStart = await initialProtectionRead;
      Logger.info('保护读取最新仓位完成', { traceId, symbol: p.symbol, positionSide: p.positionSide, contracts: p.contracts, entryPrice: p.entryPrice, markPrice: p.markPrice, leverage: p.leverage || null, leverageSource: p.leverageSource || null, liquidationPrice: p.liquidationPrice || null, marginType: p.marginType || null, parallelProtectionRead: true, existingProtectionCount: existingOrdersAtStart.length });
      const cfg = this.config.get();
      stage = '计算 SL/TP';
      const targets = this.protectionTargets(p, options);
      const exchangeTargets = this.exchangeProtectionTargets(p, targets);
      const tickSize = exchangeTargets.tickSize;
      const expectedSL = exchangeTargets.sl;
      const expectedTP = exchangeTargets.tp;
      p.__protectionExpectedTP = expectedTP;
      // 目标一算出来就写入状态：UI 立即显示 SL/TP 目标，不必等待两个 Algo 都提交完成。
      this.state.setProtectionState(p, 'PROTECTING', {
        verifiedAt: Date.now(),
        lastError: null,
        targetSL: expectedSL,
        targetTP: expectedTP,
        contracts: Number(p.contracts || 0),
        entryPrice: Number(p.entryPrice || 0),
        markPrice: Number(p.markPrice || 0),
        lastLeverage: Number(p.leverage || 0),
        lastLiquidationPrice: Number(p.liquidationPrice || 0),
        marginType: p.marginType || null,
        calculationMode: targets.mode,
        effectiveStopLossPct: Number(targets.effectiveStopLossPct || 0),
        effectiveTakeProfitPct: Number(targets.effectiveTakeProfitPct || 0),
        protectionQueuedAt: Date.now()
      });
      Logger.info('保护目标计算完成', { traceId, symbol: p.symbol, positionSide: p.positionSide, mode: targets.mode, requestedStopLossPct: targets.stopLossPct, requestedTakeProfitPct: targets.takeProfitPct, effectiveStopLossPct: targets.effectiveStopLossPct, effectiveTakeProfitPct: targets.effectiveTakeProfitPct, expectedSL, expectedTP, liquidationAdjusted: !!targets.liquidationAdjusted, liquidationPrice: p.liquidationPrice });

      // 如果理论止损已经被当前 Mark 穿越，不能继续挂一个会立即触发/被拒绝的条件单。
      if (this.stopWouldTriggerImmediately(p, expectedSL, p.markPrice)) {
        Logger.error('保护目标已被当前 Mark 穿越，无法直接挂原止损', { traceId, symbol: p.symbol, positionSide: p.positionSide, markPrice: p.markPrice, expectedSL, expectedTP });
        const err = new Error(`止损目标已被当前标记价穿越：Mark=${p.markPrice} / SL=${expectedSL}`);
        err.code = 'PROTECTION_TARGET_CROSSED';
        err.targetType = 'SL';
        throw err;
      }
      if (this.takeProfitWouldTriggerImmediately(p, expectedTP, p.markPrice)) {
        Logger.error('保护目标已被当前 Mark 达到，无法直接挂原止盈', { traceId, symbol: p.symbol, positionSide: p.positionSide, markPrice: p.markPrice, expectedSL, expectedTP });
        const err = new Error(`止盈目标已被当前标记价达到：Mark=${p.markPrice} / TP=${expectedTP}`);
        err.code = 'PROTECTION_TARGET_CROSSED';
        err.targetType = 'TP';
        throw err;
      }

      stage = '读取现有 Binance Algo 保护单';
      const existingOrders = existingOrdersAtStart;
      Logger.info('保护现有 Algo 查询完成', { traceId, symbol: p.symbol, positionSide: p.positionSide, count: existingOrders.length, orders: existingOrders.map(o => ({ algoId: this.algoIdOf(o), clientAlgoId: this.clientAlgoIdOf(o), type: o.orderType || o.type || o.strategyType, status: this.algoStatusOf(o), triggerPrice: this.orderPrice(o), quantity: this.orderQty(o), ours: this.isOurs(o) })) });
      let existing = this.classify(p, existingOrders);
      const closingSide = this.side(p);

      // ---------- 固定 SL / TP ----------
      // Binance USDⓈ-M 条件单已迁移至 Algo 服务。低延迟模式不再伪造普通 /fapi/v1/order 条件单：
      // 先最高优先级提交 SL，TP 同步入队但不阻塞本次保护返回；TP 等待 Algo 限频窗口。
      const usableSLOrders = existingOrders.filter(o => ['STOP_MARKET', 'STOP'].includes(String(o.orderType || o.type || o.strategyType).toUpperCase()));
      const strictestExistingSL = this.strictestSL(p, usableSLOrders);
      const exactExistingSL = strictestExistingSL && this.samePrice(this.orderPrice(strictestExistingSL), expectedSL, tickSize) ? strictestExistingSL : null;
      const keepManualStrictSL = strictestExistingSL
        && !this.isOurs(strictestExistingSL)
        && this.isStricterSL(p, this.orderPrice(strictestExistingSL), expectedSL);
      let sl = (keepManualStrictSL || exactExistingSL) ? strictestExistingSL : null;
      let tpPendingDuringProtection = false;

      const tpCandidates = existingOrders.filter(o => ['TAKE_PROFIT_MARKET', 'TAKE_PROFIT'].includes(String(o.orderType || o.type || o.strategyType).toUpperCase()));
      const strictestExistingTP = this.strictestTP(p, tpCandidates);
      const exactTP = strictestExistingTP && this.samePrice(this.orderPrice(strictestExistingTP), expectedTP, tickSize) ? strictestExistingTP : null;
      const keepStricterTP = strictestExistingTP && this.isStricterTP(p, this.orderPrice(strictestExistingTP), expectedTP);
      let tp = exactTP || (keepStricterTP ? strictestExistingTP : null);

      if (!sl) {
        stage = '创建 SL 保护单';
        sl = await this.createAlgoFixedProtection({ p, label: 'SL', type: 'STOP_MARKET', triggerPrice: expectedSL, queueMeta, traceId });
      }

      // 低延迟模式：TP 不再等待 61 秒后才让 _protect 返回；立即进入同一个全局 Algo 队列。
      // 在交易所 TP 尚未确认之前，state 中已有 targetTP，1s Mark Price 兜底可立即执行市价平仓。
      const lowLatencyProtection = cfg.protection.fastFixedProtection !== false;
      if (!tp) {
        stage = '排队 TP 保护单';
        if (lowLatencyProtection) {
          tpPendingDuringProtection = true;
          this.scheduleAsyncFixedProtection(p, {
            label: 'TP', type: 'TAKE_PROFIT_MARKET', triggerPrice: expectedTP,
            queueMeta, traceId, generation
          });
        } else {
          tp = await this.createAlgoFixedProtection({ p, label: 'TP', type: 'TAKE_PROFIT_MARKET', triggerPrice: expectedTP, queueMeta, traceId });
        }
      }

      const fixedOrdersNow = await this.listProtection(p);
      const finalKeepSL = this.strictestSL(
        p,
        fixedOrdersNow.filter(o => ['STOP_MARKET', 'STOP'].includes(String(o.orderType || o.type || o.strategyType).toUpperCase()))
      ) || sl;
      const finalKeepTP = this.strictestTP(
        p,
        fixedOrdersNow.filter(o => ['TAKE_PROFIT_MARKET', 'TAKE_PROFIT'].includes(String(o.orderType || o.type || o.strategyType).toUpperCase()))
      ) || tp;

      sl = finalKeepSL;
      tp = finalKeepTP;
      await this.cancelExtraProtectionOrders(p, fixedOrdersNow, finalKeepSL, 'SL');

      const tpPending = tpPendingDuringProtection || this.hasPendingFixedProtection(p, 'TAKE_PROFIT_MARKET');
      if (!finalKeepTP && !tpPending) {
        throw new Error('保护复核失败：Binance 实际 TP 未确认，且没有排队中的 TP 保护任务');
      }
      if (finalKeepTP && (!this.isUsableTP(p, this.orderPrice(finalKeepTP))
        || (!this.samePrice(this.orderPrice(finalKeepTP), expectedTP, tickSize) && !this.isStricterTP(p, this.orderPrice(finalKeepTP), expectedTP)))) {
        throw new Error('保护复核失败：Binance 实际 TP 与系统目标不一致且未更严格');
      }
      if (finalKeepTP) await this.cancelExtraProtectionOrders(p, fixedOrdersNow, finalKeepTP, 'TP');

      // ---------- Trailing ----------
      let afterFixed = this.classify(p, await this.listProtection(p));
      if (cfg.protection.trailingEnabled && Number(p.markPrice) > 0) {
        const currentQty = Number(p.contracts || 0);
        const activeTrailing = afterFixed.trailing && this.trailingActivated(afterFixed.trailing);
        const trailingQty = afterFixed.trailing ? this.orderQty(afterFixed.trailing) : null;
        const trailingNeedsReplace = !!afterFixed.trailing
          && this.isOurs(afterFixed.trailing)
          && currentQty > 0
          && trailingQty != null
          && !this.sameQuantity(trailingQty, currentQty, Number(this.binance.stepSize(p.symbol)) || null);

        const profitable = p.side === 'long'
          ? Number(p.markPrice) >= Number(p.entryPrice) * (1 + Number(cfg.protection.trailingActivationPct) / 100)
          : Number(p.markPrice) <= Number(p.entryPrice) * (1 - Number(cfg.protection.trailingActivationPct) / 100);

        if (profitable && (!afterFixed.trailing || trailingNeedsReplace) && currentQty > 0) {
          const activation = null;
          stage = '创建 Trailing Algo';
          const clientAlgoId = this.makeClientAlgoId('TR', p);
          Logger.info('移动保护达到激活条件，准备创建 Binance Trailing', {
            traceId, symbol: p.symbol, positionSide: p.positionSide,
            markPrice: Number(p.markPrice), entryPrice: Number(p.entryPrice),
            activationProfitPct: Number(cfg.protection.trailingActivationPct),
            callbackRate: Number(cfg.protection.trailingCallbackPct),
            quantity: currentQty, activationPrice: null, activationPriceMode: 'LATEST_MARK_PRICE'
          });
          const trailingQueueGuard = () => {
            if (!this.isPositionGenerationCurrent(key, generation)) return 'POSITION_CLOSED_WHILE_QUEUED';
            const latest = Number(this.latestMarkPrices.get(key) || p.markPrice || 0);
            if (!(latest > 0)) return true;
            const activationNow = p.side === 'long'
              ? latest >= Number(p.entryPrice) * (1 + Number(cfg.protection.trailingActivationPct) / 100)
              : latest <= Number(p.entryPrice) * (1 - Number(cfg.protection.trailingActivationPct) / 100);
            return activationNow ? true : 'TRAILING_ACTIVATION_LOST_WHILE_QUEUED';
          };
          const tr = await this.createWithIdempotency(
            () => this.binance.createTrailingOrder({
              symbol: p.symbol,
              side: closingSide,
              quantity: currentQty,
              activationPrice: activation,
              callbackRate: Number(cfg.protection.trailingCallbackPct),
              positionSide: p.positionSide,
              clientAlgoId,
              queueKey: key,
              queueGuard: trailingQueueGuard
            }),
            p,
            'TRAILING',
            clientAlgoId
          );
          const algoId = this.algoIdOf(tr);
          // 不再在保护锁内轮询90秒等待Trailing激活。先保留固定SL，由Binance ALGO_UPDATE(ia=true)
          // 事件驱动后续切换，减少REST轮询并缩短保护主链占用时间。
          const refreshedOrders = await this.listProtection(p);
          const refreshed = this.classify(p, refreshedOrders);
          const candidate = algoId != null
            ? refreshed.trs.find(o => String(this.algoIdOf(o)) === String(algoId))
            : refreshed.trs.find(o => String(this.clientAlgoIdOf(o) || '') === clientAlgoId);

          if (candidate && this.trailingActivated(candidate)) {
            if (afterFixed.trailing && afterFixed.trailingOurs) {
              const oldId = this.algoIdOf(afterFixed.trailing);
              if (oldId != null && String(oldId) !== String(this.algoIdOf(candidate))) {
                this.markInternalAlgoCancel(oldId);
                await this.binance.cancelAlgoOrder(p.symbol, oldId);
              }
            }
            afterFixed = refreshed;
            // 只有新 Trailing 已激活后才撤 QP 固定 SL；不会出现“先撤再确认”。
            if (afterFixed.sl && this.isOurs(afterFixed.sl)) {
              const oldId = this.algoIdOf(afterFixed.sl);
              if (oldId != null) {
                this.markInternalAlgoCancel(oldId);
                await this.binance.cancelAlgoOrder(p.symbol, oldId);
              }
              afterFixed.sl = null;
            }
          } else {
            // 新建后尚未收到 ia=true 属于正常等待状态，不应按故障 WARN 记录。
            Logger.info('移动保护已创建，等待 Binance Trailing 激活；固定 SL 保持不撤', {
              traceId, symbol: p.symbol, positionSide: p.positionSide,
              algoId: this.algoIdOf(candidate) ?? algoId ?? null,
              activationPrice: candidate ? this.orderPrice(candidate) : activation,
              callbackRate: Number(cfg.protection.trailingCallbackPct)
            });
          }
        }
      }

      // ---------- 最终复核 ----------
      stage = '最终 Binance Algo 复核';
      const finalOrders = await this.listProtection(p);
      const final = this.classify(p, finalOrders);
      const trailingActive = !!final.trailing && this.trailingActivated(final.trailing);
      const fixedSafe = !!final.sl && this.isSafeSLPrice(p, this.orderPrice(final.sl));
      const tpSafe = !!final.tp && this.isDirectionallyValidTP(p, this.orderPrice(final.tp));
      const tpPendingFinal = tpPendingDuringProtection || this.hasPendingFixedProtection(p, 'TAKE_PROFIT_MARKET');

      // Trailing 激活以后可以替代固定 SL；首次保护若 TP 正在 Algo 限频队列中，只要安全 SL 已确认即可返回 PROTECTING。
      const ok = trailingActive ? (tpSafe || tpPendingFinal) : (fixedSafe && (tpSafe || tpPendingFinal));
      if (!ok) throw new Error('保护复核失败：当前没有可确认的安全保护组合');

      await this.cancelDuplicateOurs(p, finalOrders, final.sl, 'SL');
      await this.cancelDuplicateOurs(p, finalOrders, final.tp, 'TP');
      if (trailingActive) await this.cancelDuplicateOurs(p, finalOrders, final.trailing, 'TRAILING');

      this.failureCounts.delete(key);
      const state = trailingActive ? 'TRAILING' : (tpPendingFinal ? 'PROTECTING' : 'PROTECTED');
      const verifiedAt = Date.now();
      const actualSL = this.orderPrice(final.sl);
      const actualTP = this.orderPrice(final.tp);
      this.state.setProtectionState(p, state, {
        verifiedAt,
        lastError: null,
        lastLeverage: Number(p.leverage || 0),
        lastLiquidationPrice: Number(p.liquidationPrice || 0),
        activeSL: actualSL,
        activeTP: actualTP,
        trailingAlgoId: this.algoIdOf(final.trailing),
        activeTrailingAlgoId: trailingActive ? this.algoIdOf(final.trailing) : null,
        trailingActive,
        trailingActivationPrice: final.trailing ? this.orderPrice(final.trailing) : null,
        targetSL: expectedSL,
        targetTP: expectedTP,
        tpPending: tpPendingFinal,
        contracts: Number(p.contracts || 0),
        entryPrice: Number(p.entryPrice || 0),
        markPrice: Number(p.markPrice || 0),
        marginType: p.marginType || null,
        calculationMode: targets.mode,
        effectiveStopLossPct: Number(targets.effectiveStopLossPct || 0),
        effectiveTakeProfitPct: Number(targets.effectiveTakeProfitPct || 0),
        liquidationAdjusted: !!targets.liquidationAdjusted
      });
      delete p.__protectionExpectedTP;
      Logger.info(tpPendingFinal ? '保护流程首段完成：SL已确认，TP等待 Binance Algo 限频窗口' : '保护流程完成并通过 Binance 最终复核', { traceId, symbol: p.symbol, positionSide: p.positionSide, state, slOrderId: this.algoIdOf(final.sl), tpOrderId: this.algoIdOf(final.tp), slTransport: final.sl?.__protectionTransport || 'ALGO', tpTransport: final.tp?.__protectionTransport || 'ALGO_PENDING', tpPending: tpPendingFinal, trailingAlgoId: this.algoIdOf(final.trailing), actualSL, actualTP, expectedSL, expectedTP });
      return { ok: true, state, orders: final, targets, traceId };
    } catch (e) {
      // 队列层主动取消不是保护故障：可能是仓位关闭，也可能是实时 Mark Price 已穿越待提交目标。
      if (e?.name === 'AlgoQueueCancelledError') {
        const queueReason = e.reason || e.queueReason || e.message || 'QUEUE_JOB_CANCELLED';
        if (queueReason === 'POSITION_CLOSED_WHILE_QUEUED') {
          this.failureCounts.delete(key);
          this.pendingRequests.delete(key);
          this.state.setProtectionState(p, 'CLOSED', { lastError: null, verifiedAt: Date.now() });
          delete p.__protectionExpectedTP;
          Logger.info('保护任务因仓位已关闭/保护世代失效而取消，不计入保护失败', { traceId, symbol: p.symbol, positionSide: p.positionSide, stage, reason: queueReason, queueKey: key });
          return { ok: false, cancelled: true, state: 'CLOSED', traceId };
        }
        delete p.__protectionExpectedTP;
        this.state.setProtectionState(p, 'PROTECTING', { lastError: null, verifiedAt: Date.now() });
        Logger.info('保护任务因实时条件失效而取消，不计入保护失败', { traceId, symbol: p.symbol, positionSide: p.positionSide, stage, reason: queueReason, queueKey: key });
        return { ok: false, cancelled: true, state: 'PROTECTING', traceId, reason: queueReason };
      }
      // 保护请求已经进入执行阶段后，如果仓位恰好在此时关闭/反向，本次请求属于过期保护世代。
      // 此时无论 Binance 返回 POSITION_NOT_FOUND、-4509 或其它订单层错误，都不应再计入保护失败或触发二次平仓。
      if (!queueGuard()) {
        this.failureCounts.delete(key);
        this.pendingRequests.delete(key);
        this.state.setProtectionState(p, 'CLOSED', { lastError: null, verifiedAt: Date.now() });
        delete p.__protectionExpectedTP;
        Logger.info('保护任务因仓位已关闭/保护世代已失效而取消，不计入保护失败', { traceId, symbol: p.symbol, positionSide: p.positionSide, stage, reason: e.message, queueKey: key });
        return { ok: false, cancelled: true, state: 'CLOSED', traceId };
      }
      const count = (this.failureCounts.get(key) || 0) + 1;
      this.failureCounts.set(key, count);
      this.state.setProtectionState(p, 'ERROR', {
        lastError: e.message,
        failureCount: count,
        verifiedAt: Date.now()
      });
      e.protectionLogged = true;
      e.protectionStage = stage;
      e.traceId = e.traceId || traceId;
      Logger.error('自动保护失败', { traceId, symbol: p.symbol, positionSide: p.positionSide, count, stage, reason: options.reason || 'UNKNOWN', error: e });
      const source = this.state.getPositionSource(p);
      delete p.__protectionExpectedTP;
      const hardClose = e.code === 'PROTECTION_TARGET_CROSSED' && this.config.get().protection.closeOnImmediateTarget === true;
      const aiClose = source === 'AI' && this.config.get().ai.closeOnProtectionFailure;
      if ((hardClose || aiClose) && this.emergency) {
        try {
          // 任何自动保护性平仓都必须先读取最新仓位，绝不使用旧数量/旧方向。
          const fresh = await this.refreshPosition(p);
          await this.emergency.closePositionMarket(fresh);
          Logger.warn(source === 'AI' ? 'AI保护失败，已按最新仓位执行保护性平仓' : '保护目标已失效，已按最新仓位执行保护性平仓', { symbol: fresh.symbol, positionSide: fresh.positionSide, contracts: fresh.contracts, reason: e.message, code: e.code || null, traceId: e.traceId || traceId });
        } catch (closeErr) {
          Logger.error('保护性平仓失败', { symbol: p.symbol, positionSide: p.positionSide, error: closeErr, traceId: closeErr.traceId || traceId });
        }
      }
      throw e;
    }
  }

  protect(p, options = {}) {
    const key = this.key(p);
    const running = this.locks.get(key);
    if (running) {
      // 同一仓位在保护期间再次收到风险变化/取消事件时，不丢失最新请求。
      // 当前保护 Promise 结束后自动再跑一次，避免长时间 Algo 限频等待导致事件丢失。
      this.pendingRequests.set(key, { position: { ...p }, options: { ...options } });
      return running;
    }

    const promise = this._protect(p, options).finally(() => {
      if (this.locks.get(key) !== promise) return;
      this.locks.delete(key);
      const pending = this.pendingRequests.get(key);
      if (!pending) return;
      this.pendingRequests.delete(key);
      queueMicrotask(() => {
        this.protect(pending.position, pending.options).catch(error => {
          // _protect 已经记录一次详细错误；这里只做兜底，避免异步 Promise 变成未处理拒绝。
          if (!error?.protectionLogged) Logger.error('保护重试失败', {
            symbol: pending.position.symbol,
            positionSide: pending.position.positionSide,
            error: error.message,
            code: error.code || null,
            status: error.status || null,
            protectionStage: error.protectionStage || null
          });
        });
      });
    });
    this.locks.set(key, promise);
    return promise;
  }

  trailingActivated(o) {
    if (!o) return false;
    const v = o.ia ?? o.info?.ia ?? o.isActivated ?? o.info?.isActivated;
    return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
  }

  algoStatusOf(eventOrOrder) {
    const o = eventOrOrder?.o || eventOrOrder?.ao || eventOrOrder || {};
    return String(o.algoStatus ?? o.status ?? o.strategyStatus ?? o.X ?? '').toUpperCase();
  }

  shouldReviewAlgoUpdate(event, p) {
    if (!event || event.e !== 'ALGO_UPDATE' || !p) return false;
    const o = event.o || event.ao || {};
    const eventId = this.algoIdOf(o);
    if (this.isInternalAlgoCancel(eventId)) return false;
    const status = this.algoStatusOf(o);
    // Binance 从 2026-08-21 起保证原生Trailing在状态仍为NEW时可通过 ia=true 表示“已激活”。
    // ALGO_UPDATE 某些推送的 type 字段可能为空，因此 ia=true 本身就是足够的激活信号。
    const trailingActivatedEvent = this.trailingActivated(o);
    // 普通 NEW / WORKING 不复核，只有原生Trailing从未激活->已激活(ia=true)时，
    // 即使状态仍为NEW，也需要立即切换固定SL为Trailing。
    if (trailingActivatedEvent) return true;
    if (['NEW', 'WORKING', 'PARTIALLY_FILLED'].includes(status)) return false;
    if (!['CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'TRIGGERED', 'FAILED', 'DELETED'].includes(status)) return false;

    const symbolMatch = !o.s || normalizeSymbol(o.s) === normalizeSymbol(p.symbol);
    const sideMatch = !o.ps || !p.positionSide || String(o.ps).toUpperCase() === String(p.positionSide).toUpperCase();
    if (!symbolMatch || !sideMatch) return false;

    // 状态字段存在时优先要求它是保护类型；自己的 QP 单即使事件字段不完整也允许复核。
    const type = String(o.orderType || o.type || o.strategyType || '').toUpperCase();
    const protectiveType = ['STOP_MARKET', 'STOP', 'TAKE_PROFIT_MARKET', 'TAKE_PROFIT', 'TRAILING_STOP_MARKET'].includes(type);
    return protectiveType || this.isOurs(o);
  }

  handleAlgoUpdate(event) {
    if (!event || event.e !== 'ALGO_UPDATE') return;
    const o = event.o || event.ao || {};
    const id = this.algoIdOf(o);
    if (id == null) return;
    this.algoUpdates.set(String(id), { ...o, receivedAt: Date.now() });
    if (this.algoUpdates.size > 500) this.algoUpdates.delete(this.algoUpdates.keys().next().value);
  }

  async reconcile(p, options = {}) { return this.protect(p, options); }

  callbackRateOf(o) {
    if (!o) return null;
    const v = o.callbackRate ?? o.priceRate ?? o.cr ?? o.info?.callbackRate ?? o.info?.priceRate;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  logDiagnosticProtectionState(p, stateSignature, message, meta, level = 'info') {
    const key = this.key(p);
    const now = Date.now();
    const prev = this.lastDiagnosticLogState.get(key);
    if (prev && prev.signature === stateSignature) return false;
    this.lastDiagnosticLogState.set(key, { signature: stateSignature, at: now });
    const fn = level === 'warn' ? Logger.warn : level === 'error' ? Logger.error : Logger.info;
    fn(message, meta);
    return true;
  }

  async diagnostics(p) {
    const cfg = this.config.get();
    p = await this.refreshPosition(p);
    const positionReadAt = Number(p.positionRestReadAt || Date.now());
    const markMeta = this.latestMarkMeta.get(this.key(p)) || null;
    const mark = Number(p.markPrice), entry = Number(p.entryPrice);

    let targets = null, targetError = null;
    try { targets = this.protectionTargets(p); } catch (e) { targetError = e.message; }

    if (targets) {
      try { p.__protectionExpectedTP = this.exchangeProtectionTargets(p, targets).tp; } catch {}
    }

    let classified = { sl: null, tp: null, trailing: null, sls: [], tps: [], trs: [], slOurs: false, tpOurs: false, trailingOurs: false };
    let queryError = null;
    try { classified = this.classify(p, await this.listProtection(p)); }
    catch (e) { queryError = e.message; }

    const actualSL = this.orderPrice(classified.sl);
    const actualTP = this.orderPrice(classified.tp);
    const trailingActivation = classified.trailing ? this.orderPrice(classified.trailing) : null;
    const queuedAlgoJobs = typeof this.binance.getQueuedAlgoJobs === 'function' ? this.binance.getQueuedAlgoJobs(this.key(p)) : [];
    const queuedLabels = new Set(queuedAlgoJobs.map(x => String(x.label || '').toUpperCase()));
    const queuedSL = [...queuedLabels].some(x => x === 'SL' || x.endsWith('_SL'));
    const queuedTP = [...queuedLabels].some(x => x === 'TP' || x.endsWith('_TP'));
    const queuedTrailing = queuedLabels.has('TRAILING');
    const tickSize = (() => { try { return Number(this.binance.tickSize(p.symbol)) || null; } catch { return null; } })();

    let expectedSL = targets?.sl ?? null;
    let expectedTP = targets?.tp ?? null;
    try {
      if (targets) {
        const exchangeTargets = this.exchangeProtectionTargets(p, targets);
        expectedSL = exchangeTargets.sl;
        expectedTP = exchangeTargets.tp;
      }
    } catch (e) {
      if (!targetError) targetError = e.message;
    }

    const fromMarkPct = price => (price != null && mark > 0) ? Number((Math.abs(price - mark) / mark * 100).toFixed(3)) : null;
    const fromEntryPct = price => (price != null && entry > 0) ? Number((Math.abs(price - entry) / entry * 100).toFixed(3)) : null;
    const effectiveSL = actualSL ?? expectedSL;
    const effectiveTP = actualTP ?? expectedTP;
    const slDistancePct = fromMarkPct(effectiveSL);
    const tpDistancePct = fromMarkPct(effectiveTP);
    const slEntryDistancePct = fromEntryPct(effectiveSL);
    const tpEntryDistancePct = fromEntryPct(effectiveTP);
    const rr = slEntryDistancePct > 0 && tpEntryDistancePct != null ? Number((tpEntryDistancePct / slEntryDistancePct).toFixed(2)) : null;
    const leverage = Number(p.leverage) > 0 ? Number(p.leverage) : null;
    const positionMarginBasis = leverage != null && Math.abs(Number(p.notional || 0)) > 0
      ? Math.abs(Number(p.notional || 0)) / leverage
      : Number(p.isolatedMargin || 0) || null;
    const positionReturnPct = positionMarginBasis > 0 ? Number((Number(p.unrealizedPnl || 0) / positionMarginBasis * 100).toFixed(2)) : null;
    const priceMovePct = entry > 0 && mark > 0
      ? Number((((mark - entry) / entry * 100) * (String(p.positionSide || '').toUpperCase() === 'SHORT' ? -1 : 1)).toFixed(3))
      : null;
    const slMarginImpactPct = slEntryDistancePct != null && leverage != null ? Number((slEntryDistancePct * leverage).toFixed(2)) : null;
    const tpMarginImpactPct = tpEntryDistancePct != null && leverage != null ? Number((tpEntryDistancePct * leverage).toFixed(2)) : null;
    const qty = Math.abs(Number(p.contracts || 0));
    const pnlAt = price => {
      const px = Number(price);
      if (!(qty > 0 && entry > 0 && px > 0)) return null;
      return Number(((p.side === 'long' ? px - entry : entry - px) * qty).toFixed(6));
    };
    const priceDerivedPnl = (mark > 0 && qty > 0 && entry > 0) ? pnlAt(mark) : null;
    const exchangePnl = Number.isFinite(Number(p.exchangeUnrealizedPnl)) ? Number(p.exchangeUnrealizedPnl) : Number(p.unrealizedPnl);
    const liveUnrealizedPnl = priceDerivedPnl != null ? priceDerivedPnl : Number(p.unrealizedPnl || 0);
    // 这里的“当前 PnL”统一采用当前 Mark 快照推导值；Binance REST PnL 仅用于一致性审计。
    p.unrealizedPnl = liveUnrealizedPnl;
    p.unrealizedPnlSource = priceDerivedPnl != null && markMeta ? 'MARK_PRICE_WS_DERIVED' : (p.unrealizedPnlSource || 'BINANCE_POSITION_REST');
    const pnlGap = priceDerivedPnl != null && Number.isFinite(exchangePnl)
      ? Number((priceDerivedPnl - exchangePnl).toFixed(6))
      : null;
    let accountEquity = null;
    let availableBalance = null;
    let accountReadAt = null;
    let accountQueryError = null;
    try {
      if (typeof this.binance.getAccount === 'function') {
        const account = await this.binance.getAccount();
        accountReadAt = Date.now();
        const equity = Number(account?.totalMarginBalance ?? account?.totalWalletBalance);
        accountEquity = Number.isFinite(equity) ? equity : null;
        const available = Number(account?.availableBalance);
        availableBalance = Number.isFinite(available) ? available : null;
      } else if (typeof this.binance.fetchAccountEquity === 'function') {
        accountEquity = Number(await this.binance.fetchAccountEquity());
        accountReadAt = Date.now();
      }
    } catch (e) {
      accountQueryError = e.message;
      Logger.warn('保护诊断账户快照读取失败', { symbol: p.symbol, positionSide: p.positionSide, error: e });
    }
    const componentTimes = [positionReadAt, Number(markMeta?.receivedAt || 0), Number(accountReadAt || 0)].filter(x => x > 0);
    const snapshotAt = componentTimes.length ? Math.max(...componentTimes) : Date.now();
    const snapshotEarliest = componentTimes.length ? Math.min(...componentTimes) : snapshotAt;
    const snapshotLagMs = componentTimes.length ? snapshotAt - snapshotEarliest : null;
    const snapshotConsistency = snapshotLagMs == null ? 'ACCOUNT_NOT_READ' : (snapshotLagMs <= 2000 ? 'CONSISTENT' : 'TIME_GAP');
    if (snapshotLagMs != null && snapshotLagMs > 2000) Logger.warn('保护诊断发现账户与仓位快照存在明显时间差', { symbol: p.symbol, positionSide: p.positionSide, snapshotLagMs, positionReadAt, accountReadAt });
    if (pnlGap != null && Math.abs(pnlGap) > Math.max(0.00001, Math.abs(exchangePnl) * 0.05)) {
      Logger.warn('保护诊断发现交易所PnL与价格/数量推导PnL存在明显差异', {
        symbol: p.symbol, positionSide: p.positionSide, entryPrice: entry, markPrice: mark, contracts: qty,
        exchangePnl, priceDerivedPnl, pnlGap, leverage, notional: Number(p.notional || 0)
      });
    }
    const estimatedSLPnl = effectiveSL != null ? pnlAt(effectiveSL) : null;
    const estimatedTPPnl = effectiveTP != null ? pnlAt(effectiveTP) : null;
    const projectedEquity = value => accountEquity != null && Number.isFinite(Number(value))
      ? Number((accountEquity - Number(liveUnrealizedPnl || 0) + Number(value)).toFixed(4))
      : null;
    const equityAfterSL = projectedEquity(estimatedSLPnl);
    const equityAfterTP = projectedEquity(estimatedTPPnl);

    const liq = Number(p.liquidationPrice);
    const liqDistancePct = liq > 0 && mark > 0 ? Number((Math.abs(mark - liq) / mark * 100).toFixed(3)) : null;
    const liqBufferPct = slDistancePct != null && liqDistancePct != null ? Number((liqDistancePct - slDistancePct).toFixed(2)) : null;
    const slSafe = actualSL != null ? this.isSafeSLPrice(p, actualSL) : (expectedSL != null ? this.isSafeSLPrice(p, expectedSL) : false);
    const tpSafe = actualTP != null ? this.isDirectionallyValidTP(p, actualTP) : (expectedTP != null ? this.isDirectionallyValidTP(p, expectedTP) : false);
    const stopBeyondLiquidation = actualSL != null && !this.isSafeSLPrice(p, actualSL);
    const trailingActive = !!classified.trailing && this.trailingActivated(classified.trailing);
    const trailingEnabled = cfg.protection.trailingEnabled === true;
    const trailingActivationPct = Number(cfg.protection.trailingActivationPct || 0);
    const favorableMovePct = entry > 0 && mark > 0
      ? Number(((p.side === 'long' ? (mark - entry) : (entry - mark)) / entry * 100).toFixed(4))
      : null;
    const trailingActivationReached = trailingEnabled && favorableMovePct != null && favorableMovePct >= trailingActivationPct;
    const trailingActivationRemainingPct = trailingEnabled && favorableMovePct != null
      ? Number(Math.max(0, trailingActivationPct - favorableMovePct).toFixed(4))
      : null;
    const priceGapPct = (actual, expected) => actual != null && expected > 0 ? Number((Math.abs(actual - expected) / expected * 100).toFixed(4)) : null;
    const priceGapTicks = (actual, expected) => (actual != null && expected > 0 && tickSize > 0) ? Number((Math.abs(actual - expected) / tickSize).toFixed(3)) : null;
    if (actualSL == null || actualTP == null) {
      const pendingComplement = (actualSL != null && queuedTP) || (actualTP != null && queuedSL) || (actualSL == null && actualTP == null && (queuedSL || queuedTP || queuedTrailing));
      const signature = pendingComplement
        ? `WAITING|SL=${actualSL != null}|TP=${actualTP != null}|QSL=${queuedSL}|QTP=${queuedTP}|QTR=${queuedTrailing}`
        : `INCOMPLETE|SL=${actualSL != null}|TP=${actualTP != null}|QSL=${queuedSL}|QTP=${queuedTP}|QTR=${queuedTrailing}`;
      if (pendingComplement) {
        this.logDiagnosticProtectionState(p, signature, '保护诊断：部分保护已确认，另一保护单正在限频队列中', {
          symbol: p.symbol, positionSide: p.positionSide, actualSL, actualTP, queuedSL, queuedTP, queuedTrailing,
          queuedJobs: queuedAlgoJobs.map(x => ({ label: x.label, seq: x.seq, started: x.started, rateLimited: x.rateLimited, ageMs: x.ageMs, queueKey: x.queueKey })),
          slAlgoId: this.algoIdOf(classified.sl), tpAlgoId: this.algoIdOf(classified.tp)
        });
      } else {
        this.logDiagnosticProtectionState(p, signature, '保护诊断发现保护单不完整', { symbol: p.symbol, positionSide: p.positionSide, actualSL, actualTP, queuedJobs: queuedAlgoJobs.map(x => x.label), slAlgoId: this.algoIdOf(classified.sl), tpAlgoId: this.algoIdOf(classified.tp) }, 'warn');
      }
    }
    const slGapTicks = priceGapTicks(actualSL, expectedSL);
    const tpGapTicks = priceGapTicks(actualTP, expectedTP);
    if (actualSL != null && expectedSL != null && !this.samePrice(actualSL, expectedSL, tickSize)) {
      const fn = slGapTicks != null && slGapTicks <= 1.0001 ? Logger.info : Logger.warn;
      fn('保护诊断发现实际SL与系统目标存在价格偏差', { symbol: p.symbol, positionSide: p.positionSide, expectedSL, actualSL, gapPct: priceGapPct(actualSL, expectedSL), gapTicks: slGapTicks, stricterProtection: this.isStricterSL(p, actualSL, expectedSL) });
    }
    if (actualTP != null && expectedTP != null && !this.samePrice(actualTP, expectedTP, tickSize)) {
      const fn = tpGapTicks != null && tpGapTicks <= 1.0001 ? Logger.info : Logger.warn;
      fn('保护诊断发现实际TP与系统目标存在价格偏差', { symbol: p.symbol, positionSide: p.positionSide, expectedTP, actualTP, gapPct: priceGapPct(actualTP, expectedTP), gapTicks: tpGapTicks, stricterProtection: this.isStricterTP(p, actualTP, expectedTP) });
    }
    if (stopBeyondLiquidation) Logger.error('保护诊断发现止损越过强平安全边界', { symbol: p.symbol, positionSide: p.positionSide, liquidationPrice: liq, markPrice: mark, entryPrice: entry, actualSL });
    if (leverage == null && String(cfg.protection.calculationMode || 'MARGIN').toUpperCase() === 'MARGIN') Logger.error('保护诊断缺少真实杠杆，保证金风险模式无法可靠计算', { symbol: p.symbol, positionSide: p.positionSide, leverageSource: p.leverageSource || 'NOT_READ' });
    if (accountEquity == null) Logger.warn('保护诊断未获得账户权益快照，预计账户权益不可用', { symbol: p.symbol, positionSide: p.positionSide, accountQueryError });

    const tpTargetSatisfied = expectedTP == null || (actualTP != null && (this.samePrice(actualTP, expectedTP, tickSize) || this.isStricterTP(p, actualTP, expectedTP)));
    let protectionState = 'UNPROTECTED';
    if (queryError) protectionState = 'UNKNOWN';
    else if (!targets && targetError) protectionState = 'UNKNOWN';
    else if (stopBeyondLiquidation) protectionState = 'ERROR';
    else if (trailingActive && actualTP != null && tpSafe && tpTargetSatisfied) protectionState = 'TRAILING';
    else if (actualSL != null && actualTP != null && slSafe && tpSafe && tpTargetSatisfied) protectionState = 'PROTECTED';
    else if ((actualSL != null || actualTP != null || classified.trailing) && (queuedSL || queuedTP || queuedTrailing)) protectionState = 'PROTECTING';
    else if (actualSL != null || actualTP != null || classified.trailing) protectionState = 'PARTIAL';
    else if (queuedSL || queuedTP || queuedTrailing) protectionState = 'PROTECTING';

    const localProtectionState = this.state.getProtectionState(p);
    if (protectionState !== 'UNKNOWN') {
      this.state.setProtectionState(p, protectionState, {
        verifiedAt: Date.now(),
        lastError: protectionState === 'ERROR' ? '交易所实际保护参数不安全' : null,
        activeSL: actualSL,
        activeTP: actualTP,
        trailingAlgoId: this.algoIdOf(classified.trailing),
        activeTrailingAlgoId: trailingActive ? this.algoIdOf(classified.trailing) : null,
        trailingActive,
        trailingActivationPrice: classified.trailing ? this.orderPrice(classified.trailing) : null,
        targetSL: expectedSL,
        targetTP: expectedTP,
        lastLeverage: leverage || 0,
        lastLiquidationPrice: liq > 0 ? liq : 0,
        contracts: Number(p.contracts || 0),
        entryPrice: entry,
        markPrice: mark
      });
    }

    return {
      symbol: normalizeSymbol(p.symbol),
      positionSide: String(p.positionSide || 'BOTH').toUpperCase(),
      side: p.side,
      contracts: Number(p.contracts || 0),
      signedContracts: Number(p.signedContracts || 0),
      isolatedMargin: Number(p.isolatedMargin || 0),
      notional: Number(p.notional || 0),
      marginType: p.marginType || null,
      entryPrice: entry > 0 ? entry : null,
      markPrice: mark > 0 ? mark : null,
      leverage,
      leverageSource: p.leverageSource || (leverage != null ? 'BINANCE_SYMBOL_CONFIG' : 'NOT_READ'),
      calculationMode: targets?.mode || String(cfg.protection.calculationMode || 'MARGIN').toUpperCase(),
      stopLossMarginPct: targets?.stopLossMarginPct ?? null,
      takeProfitMarginPct: targets?.takeProfitMarginPct ?? null,
      requestedStopLossPct: targets?.stopLossPct ?? null,
      requestedTakeProfitPct: targets?.takeProfitPct ?? null,
      effectiveStopLossPct: targets?.effectiveStopLossPct ?? null,
      effectiveTakeProfitPct: targets?.effectiveTakeProfitPct ?? null,
      liquidationAdjusted: !!targets?.liquidationAdjusted,
      targetError,
      theoreticalSL: expectedSL != null ? Number(expectedSL.toFixed(12)) : null,
      theoreticalTP: expectedTP != null ? Number(expectedTP.toFixed(12)) : null,
      expectedSL: expectedSL != null ? Number(expectedSL.toFixed(12)) : null,
      expectedTP: expectedTP != null ? Number(expectedTP.toFixed(12)) : null,
      tickSize,
      actualSL,
      actualTP,
      slSource: actualSL != null ? 'BINANCE_CONFIRMED' : 'THEORETICAL_ONLY',
      tpSource: actualTP != null ? 'BINANCE_CONFIRMED' : 'THEORETICAL_ONLY',
      slPriceGapPct: priceGapPct(actualSL, expectedSL),
      tpPriceGapPct: priceGapPct(actualTP, expectedTP),
      slAlgoId: classified.sl?.__protectionTransport === 'ALGO' ? this.algoIdOf(classified.sl) : null,
      tpAlgoId: classified.tp?.__protectionTransport === 'ALGO' ? this.algoIdOf(classified.tp) : null,
      slOrderId: classified.sl?.__protectionTransport === 'ORDER' ? this.algoIdOf(classified.sl) : null,
      tpOrderId: classified.tp?.__protectionTransport === 'ORDER' ? this.algoIdOf(classified.tp) : null,
      slTransport: classified.sl?.__protectionTransport || null,
      tpTransport: classified.tp?.__protectionTransport || null,
      trailingAlgoId: this.algoIdOf(classified.trailing),
      slAlgoStatus: classified.sl ? (classified.sl.algoStatus ?? classified.sl.status ?? classified.sl.strategyStatus ?? null) : null,
      tpAlgoStatus: classified.tp ? (classified.tp.algoStatus ?? classified.tp.status ?? classified.tp.strategyStatus ?? null) : null,
      trailingAlgoStatus: classified.trailing ? (classified.trailing.algoStatus ?? classified.trailing.status ?? classified.trailing.strategyStatus ?? null) : null,
      slOurs: classified.slOurs,
      tpOurs: classified.tpOurs,
      trailingOurs: classified.trailingOurs,
      trailingActive,
      trailingActivationPrice: trailingActivation,
      trailingQuantity: this.orderQty(classified.trailing),
      trailingCallbackPct: this.callbackRateOf(classified.trailing),
      trailingActivationPct,
      trailingEnabled,
      trailingActivationReached,
      trailingFavorableMovePct: favorableMovePct,
      trailingActivationRemainingPct,
      trailingQueued: queuedTrailing,
      trailingModeLabel: trailingActive
        ? '移动保护运行中'
        : (trailingActivationReached
          ? (queuedTrailing ? '已达到激活条件 · Binance限频等待' : '已达到激活条件 · 正在创建')
          : (trailingEnabled ? '已开启 · 等待盈利激活' : '已关闭')),
      slDistancePct,
      tpDistancePct,
      slEntryDistancePct,
      tpEntryDistancePct,
      rr,
      positionMarginBasis,
      positionReturnPct,
      priceMovePct,
      estimatedSLPnl,
      estimatedTPPnl,
      accountEquity: Number.isFinite(accountEquity) ? accountEquity : null,
      equityAfterSL,
      equityAfterTP,
      slMarginImpactPct,
      tpMarginImpactPct,
      marginImpactBasis: leverage != null ? 'ENTRY_PRICE_CHANGE_X_BINANCE_LEVERAGE' : 'UNAVAILABLE',
      marginImpactNote: leverage != null ? '按开仓价到实际/理论 SL、TP 的价格变化 × Binance 当前仓位杠杆；未计手续费、资金费、滑点' : '未读取当前仓位实际杠杆',
      liquidationPrice: liq > 0 ? liq : null,
      liqDistancePct,
      liqBufferPct,
      liqRisk: liqBufferPct != null && liqBufferPct < Number(cfg.protection.liquidationBufferPp ?? 0.5),
      liquidationSafetyAvailable: this.liquidationSafety(p).ok,
      slSafe,
      tpSafe,
      stopBeyondLiquidation,
      slMatchesTarget: actualSL != null && expectedSL != null ? this.samePrice(actualSL, expectedSL, tickSize) : false,
      tpMatchesTarget: actualTP != null && expectedTP != null ? this.samePrice(actualTP, expectedTP, tickSize) : false,
      tpTargetSatisfied,
      tpAlreadyReached: expectedTP != null && this.takeProfitWouldTriggerImmediately(p, expectedTP),
      slAlreadyTriggered: expectedSL != null && this.stopWouldTriggerImmediately(p, expectedSL),
      protectionComplete: trailingActive ? !!actualTP && tpSafe : !!actualSL && !!actualTP && slSafe && tpSafe,
      actualOrdersConfirmed: !!actualSL || !!actualTP || !!classified.trailing,
      unrealizedPnl: Number(liveUnrealizedPnl || 0),
      exchangeUnrealizedPnl: Number.isFinite(exchangePnl) ? exchangePnl : null,
      unrealizedPnlSource: p.unrealizedPnlSource || 'BINANCE_POSITION_REST',
      priceDerivedPnl,
      pnlGap,
      availableBalance: availableBalance != null ? availableBalance : null,
      snapshotAt,
      positionReadAt,
      markReadAt: Number(markMeta?.receivedAt || 0) || null,
      markEventTime: Number(markMeta?.eventTime || 0) || null,
      markPriceSource: p.markPriceSource || 'BINANCE_POSITION_REST',
      accountReadAt,
      snapshotLagMs,
      snapshotConsistency,
      accountQueryError,
      positionMarginBasisSource: leverage != null && Math.abs(Number(p.notional || 0)) > 0 ? 'NOTIONAL_DIV_LEVERAGE' : (Number(p.isolatedMargin || 0) > 0 ? 'ISOLATED_MARGIN_FALLBACK' : 'UNAVAILABLE'),
      protectionState,
      localProtectionState,
      stateMismatch: localProtectionState !== protectionState,
      queryError,
      queuedAlgoJobs,
      queuedSL,
      queuedTP,
      queuedTrailing,
      checkedAt: Date.now()
    };
    delete p.__protectionExpectedTP;
    Logger.info('保护诊断快照完成', {
      symbol: result.symbol, positionSide: result.positionSide, snapshotAt: result.snapshotAt,
      contracts: result.contracts, leverage: result.leverage, leverageSource: result.leverageSource,
      entryPrice: result.entryPrice, markPrice: result.markPrice, markPriceSource: result.markPriceSource, unrealizedPnl: result.unrealizedPnl,
      exchangeUnrealizedPnl: result.exchangeUnrealizedPnl, priceDerivedPnl: result.priceDerivedPnl, pnlGap: result.pnlGap, positionReturnPct: result.positionReturnPct,
      actualSL: result.actualSL, actualTP: result.actualTP, slDistancePct: result.slDistancePct,
      tpDistancePct: result.tpDistancePct, slEntryDistancePct: result.slEntryDistancePct,
      tpEntryDistancePct: result.tpEntryDistancePct, rr: result.rr, accountEquity: result.accountEquity,
      availableBalance: result.availableBalance, accountReadAt: result.accountReadAt,
      snapshotConsistency: result.snapshotConsistency, protectionState: result.protectionState
    });
    return result;
  }

  async cleanup(old) {
    const key = this.key(old);
    this.invalidatePositionGeneration(old, 'POSITION_CLOSED');
    try {
      let orders = [];
      try { orders = await this.listProtection(old); } catch (e) { Logger.warn('保护单清理读取失败', { symbol: old.symbol, error: e.message }); }
      for (const o of orders) {
        if (!this.isOurs(o)) continue;
        try {
          if (o.__protectionTransport === 'ORDER') {
            await this.binance.cancelOrder(old.symbol, o.orderId, o.clientOrderId);
          } else if (this.algoIdOf(o)) {
            await this.binance.cancelAlgoOrder(old.symbol, this.algoIdOf(o));
          }
        } catch (e) {
          Logger.warn('保护单清理失败', { symbol: old.symbol, orderId: o.orderId || null, algoId: this.algoIdOf(o), error: e.message });
        }
      }
    } finally {
      this.failureCounts.delete(key);
      this.state.setProtectionState(old, 'CLOSED');
      this.state.deletePosition(old);
    }
  }
}

module.exports = ProtectionManager;
