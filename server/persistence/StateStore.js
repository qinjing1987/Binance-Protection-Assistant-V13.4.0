// 保护运行状态存储。
// 这里故意只保存非敏感数据：仓位来源、冷却、日风险、保护状态、AI 信号记录等。
const path = require('path');
const JsonStore = require('./JsonStore');
const { positionKey } = require('../utils/symbol');

class StateStore {
  constructor(dataDir) {
    this.store = new JsonStore(path.join(dataDir, 'state.json'), {
      positions: {}, protections: {}, cooldowns: {}, ruleCooldowns: {}, ruleOrderPlans: {}, trades: {}, daily: {}, signals: {}, ruleTradingStats: null
    });
  }
  key(position) { return positionKey(position.symbol, position.positionSide); }
  getPositionSource(position) { return this.store.get('positions', {})[this.key(position)]?.source || 'MANUAL'; }
  setPositionSource(position, source) {
    const positions = this.store.get('positions', {});
    const k = this.key(position);
    positions[k] = { ...(positions[k] || {}), source, updatedAt: Date.now() };
    this.store.set('positions', positions);
  }
  deletePosition(position) { const positions = this.store.get('positions', {}); delete positions[this.key(position)]; this.store.set('positions', positions); }
  getProtectionState(position) { return this.store.get('protections', {})[this.key(position)]?.state || 'UNPROTECTED'; }
  getProtectionMeta(position) { return this.store.get('protections', {})[this.key(position)] || {}; }
  getProtectionParams(position) { return this.store.get('protections', {})[this.key(position)]?.params || null; }
  setProtectionParams(position, params) {
    const protections = this.store.get('protections', {});
    const k = this.key(position);
    protections[k] = { ...(protections[k] || {}), params: { ...(protections[k]?.params || {}), ...(params || {}) }, updatedAt: Date.now() };
    this.store.set('protections', protections);
  }
  setProtectionState(position, state, extra = {}) {
    const protections = this.store.get('protections', {});
    protections[this.key(position)] = { ...(protections[this.key(position)] || {}), state, ...extra, updatedAt: Date.now() };
    this.store.set('protections', protections);
  }
  getCooldown(symbol) { return Number(this.store.get('cooldowns', {})[String(symbol).toUpperCase()] || 0); }
  setCooldown(symbol, until) { const c = this.store.get('cooldowns', {}); c[String(symbol).toUpperCase()] = Number(until); this.store.set('cooldowns', c); }
  getRuleCooldown(symbol) { return Number(this.store.get('ruleCooldowns', {})[String(symbol).toUpperCase()] || 0); }
  setRuleCooldown(symbol, until) { const c = this.store.get('ruleCooldowns', {}); c[String(symbol).toUpperCase()] = Number(until); this.store.set('ruleCooldowns', c); }
  getRuleOrderPlan(clientOrderId) { return this.store.get('ruleOrderPlans', {})[String(clientOrderId || '')] || null; }
  setRuleOrderPlan(clientOrderId, plan) { const plans = this.store.get('ruleOrderPlans', {}); plans[String(clientOrderId)] = { ...(plans[String(clientOrderId)] || {}), ...(plan || {}), updatedAt: Date.now() }; this.store.set('ruleOrderPlans', plans); }
  deleteRuleOrderPlan(clientOrderId) { const plans = this.store.get('ruleOrderPlans', {}); delete plans[String(clientOrderId || '')]; this.store.set('ruleOrderPlans', plans); }

  getRuleTradingStats() { return this.store.get('ruleTradingStats', null); }
  setRuleTradingStats(stats) { this.store.set('ruleTradingStats', stats || null); }
  getSignals() { return this.store.get('signals', {}); }
  saveSignal(signalId, record) { const s = this.store.get('signals', {}); s[signalId] = record; for (const [id, r] of Object.entries(s)) if (Date.now() - Number(r.createdAt || 0) > 24 * 3600e3) delete s[id]; this.store.set('signals', s); }
  rawGet(key, fallback) { return this.store.get(key, fallback); }
  rawSet(key, value) { this.store.set(key, value); }
}
module.exports = StateStore;
