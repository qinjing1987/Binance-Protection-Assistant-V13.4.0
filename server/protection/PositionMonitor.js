// 持仓监控：WS 负责实时事件，REST 负责定时对账兜底。
// V11.2.0：杠杆/强平价/保证金模式发生变化时，视为保护风险变化并触发重新保护。
const EventEmitter = require('events');
const Logger = require('../Logger');
const { positionKey } = require('../utils/symbol');

function numChanged(a, b, tolerance = 1e-12) {
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return String(a ?? '') !== String(b ?? '');
  return Math.abs(x - y) > tolerance;
}

function changed(a, b) {
  return numChanged(a.contracts, b.contracts)
    || numChanged(a.entryPrice, b.entryPrice)
    || numChanged(a.leverage, b.leverage, 1e-9)
    || numChanged(a.liquidationPrice, b.liquidationPrice)
    || String(a.marginType || '').toUpperCase() !== String(b.marginType || '').toUpperCase();
}

class PositionMonitor extends EventEmitter {
  constructor({ binance, userStream }) {
    super();
    this.binance = binance;
    this.userStream = userStream;
    this.known = new Map();
    this.timer = null;
    this.running = false;
    this.wsConnected = false;
    this.lastSyncError = null;
    this.syncChain = Promise.resolve();
    this._listenersAttached = false;
    this._statusHandler = s => {
      this.wsConnected = !!s.connected;
      this.emit('transport', { wsConnected: this.wsConnected, endpoint: s.endpoint || null });
    };
    this._recentEventFingerprints = new Map();
    this._eventHandler = async e => this.handleUserEvent(e);
  }

  key(p) { return positionKey(p.symbol, p.positionSide); }

  removeUserStreamListener(name, handler) {
    try {
      if (typeof this.userStream.off === 'function') this.userStream.off(name, handler);
      else if (typeof this.userStream.removeListener === 'function') this.userStream.removeListener(name, handler);
      else if (this.userStream.handlers?.[name] === handler) delete this.userStream.handlers[name];
    } catch {}
  }

  eventFingerprint(e) {
    const o = e?.o || e?.ao || {};
    if (e?.e !== 'ALGO_UPDATE') return null;
    return [e.e, e.E || '', e.T || '', this.algoIdOfEvent(o), o.X || o.algoStatus || o.status || '', o.p || o.triggerPrice || ''].join('|');
  }

  algoIdOfEvent(o) { return o?.algoId ?? o?.aid ?? o?.id ?? o?.orderId ?? null; }

  isDuplicateEvent(e) {
    const fp = this.eventFingerprint(e);
    if (!fp) return false;
    const now = Date.now();
    for (const [k, t] of this._recentEventFingerprints) if (now - t > 5000) this._recentEventFingerprints.delete(k);
    if (this._recentEventFingerprints.has(fp)) return true;
    this._recentEventFingerprints.set(fp, now);
    return false;
  }

  async handleUserEvent(e) {
    if (this.isDuplicateEvent(e)) {
      const o = e.o || e.ao || {};
      Logger.warn('Binance用户事件重复到达，已去重', { event: e.e, symbol: e.s || o.s || null, algoId: this.algoIdOfEvent(o), eventTime: e.E || null, transactionTime: e.T || o.T || null });
      return;
    }

    this.emit('userEvent', e);
    const o = e.o || e.ao || {};
    const receiveAt = Date.now();
    const receiveServerNow = receiveAt + Number(this.binance?.timeOffset || 0);
    const wsLatencyMs = Number.isFinite(Number(e.E)) ? Math.max(0, receiveServerNow - Number(e.E)) : null;
    if (['ACCOUNT_CONFIG_UPDATE', 'ALGO_UPDATE', 'MARGIN_CALL', 'listenKeyExpired'].includes(e.e)) {
      const status = String(o.algoStatus ?? o.status ?? o.strategyStatus ?? o.X ?? '').toUpperCase() || null;
      Logger.info('Binance用户事件收到', {
        event: e.e, symbol: e.s || o.s || e.ac?.s || null, positionSide: e.ps || o.ps || e.ac?.ps || null,
        status, algoId: this.algoIdOfEvent(o), type: o.orderType || o.type || o.strategyType || null,
        triggerPrice: o.triggerPrice ?? o.stopPrice ?? o.activatePrice ?? null,
        leverage: e.ac?.l || null, eventTime: e.E || null, transactionTime: e.T || o.T || null,
        receiveAt, wsLatencyMs
      });
    }
    if (e.e === 'ORDER_TRADE_UPDATE') {
      Logger.info('Binance订单交易事件收到', {
        symbol: o.s || null, positionSide: o.ps || null, side: o.S || null, type: o.o || null,
        executionType: o.x || null, orderStatus: o.X || null, orderId: o.i || null, algoId: this.algoIdOfEvent(o),
        clientOrderId: o.c || null, lastFilledQty: o.l || null, cumulativeFilledQty: o.z || null,
        avgPrice: o.ap || null, realizedPnl: o.rp || null, commission: o.n || null, commissionAsset: o.N || null,
        eventTime: e.E || null, transactionTime: e.T || o.T || null, receiveAt, wsLatencyMs
      });
    }

    const orderExecution = e.e === 'ORDER_TRADE_UPDATE'
      && ['TRADE', 'AMENDMENT', 'CALCULATED'].includes(String(o.x || '').toUpperCase())
      || e.e === 'ORDER_TRADE_UPDATE'
      && ['FILLED', 'PARTIALLY_FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH'].includes(String(o.X || '').toUpperCase());
    const shouldSync = ['ACCOUNT_UPDATE', 'ACCOUNT_CONFIG_UPDATE', 'ALGO_UPDATE', 'MARGIN_CALL', 'listenKeyExpired'].includes(e.e) || orderExecution;
    if (shouldSync) {
      try {
        await this.sync(`WS_${e.e}`, { emitPositionEvents: true });
        if (e.e === 'ALGO_UPDATE') this.emit('protectionChanged', e);
      } catch (err) {
        this.lastSyncError = err;
        Logger.warn('WS 触发 REST 对账失败', { event: e.e, error: err, code: err.code || null, status: err.status || null });
      }
    }
  }

  attachUserStreamListeners() {
    if (this._listenersAttached) return;
    this._listenersAttached = true;
    this.userStream.on('status', this._statusHandler);
    this.userStream.on('event', this._eventHandler);
  }

  detachUserStreamListeners() {
    if (!this._listenersAttached) return;
    this.removeUserStreamListener('status', this._statusHandler);
    this.removeUserStreamListener('event', this._eventHandler);
    this._listenersAttached = false;
  }

  async start({ emitInitialPositionEvents = false } = {}) {
    if (this.running) return;
    this.running = true;
    this.attachUserStreamListeners();
    await this.sync('STARTUP', { emitPositionEvents: emitInitialPositionEvents });
    await this.userStream.start();
    this.schedule();
  }

  schedule() {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.sync('TIMER');
      } catch (e) {
        this.lastSyncError = e;
        Logger.error('REST 仓位同步失败', { error: e, code: e.code || null, status: e.status || null, reason: 'TIMER' });
      } finally {
        this.schedule();
      }
    }, 10000);
  }

  async sync(reason, { emitPositionEvents = true } = {}) {
    // WS 事件可能在极短时间内连续到达；所有 REST 对账严格串行，避免旧响应覆盖新仓位快照。
    const run = this.syncChain.then(async () => {
      const forceConfig = String(reason || '').includes('ACCOUNT_CONFIG_UPDATE');
      const positions = await this.binance.fetchPositions(null, { forceConfig });
      const next = new Map(positions.map(p => [this.key(p), p]));

      for (const [k, current] of next) {
        if (!this.known.has(k)) {
          if (emitPositionEvents) this.emit('positionChanged', { type: 'OPENED', position: current, reason });
        } else if (changed(this.known.get(k), current)) {
          const old = this.known.get(k);
          if (emitPositionEvents) this.emit('positionChanged', {
            type: 'CHANGED',
            old,
            position: current,
            reason,
            riskChanged: {
              contracts: numChanged(old.contracts, current.contracts),
              entryPrice: numChanged(old.entryPrice, current.entryPrice),
              leverage: numChanged(old.leverage, current.leverage, 1e-9),
              liquidationPrice: numChanged(old.liquidationPrice, current.liquidationPrice),
              marginType: String(old.marginType || '').toUpperCase() !== String(current.marginType || '').toUpperCase()
            }
          });
        }
      }

      for (const [k, old] of this.known) {
        if (!next.has(k) && emitPositionEvents) this.emit('positionChanged', { type: 'CLOSED', old, reason });
      }

      this.known = next;
      this.lastSyncError = null;
      this.emit('snapshot', positions);
      return positions;
    });
    this.syncChain = run.catch(() => {});
    return run;
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.detachUserStreamListeners();
    this._recentEventFingerprints.clear();
    this.userStream.stop();
  }
}

module.exports = PositionMonitor;
