const test = require('node:test');
const assert = require('node:assert/strict');
const RiskManager = require('../server/risk/RiskManager');

test('V13.3.1：账户权益瞬时REST失败时可使用15秒内成功账户快照', async () => {
  const date = new Date().toISOString().slice(0, 10);
  const state = { rawGet: (k, d) => k === 'dailyRisk' ? { date, dayStartEquity: 2, realizedPnl: 0, fees: 0, funding: 0 } : d, rawSet: () => {}, getCooldown: () => 0 };
  const binance = { fetchAccountEquity: async () => { throw new Error('瞬时 REST 失败'); }, getCachedAccountSnapshot: () => ({ account: { totalMarginBalance: '1.4171' }, ageMs: 1200 }) };
  const risk = new RiskManager({ config: { get: () => ({ risk: { dailyLossLimitPct: 0 } }) }, state, binance });
  const d = await risk.daily();
  assert.equal(d.currentEquity, 1.4171);
  assert.equal(d.equityFresh, true);
  assert.equal(d.equitySource, 'CACHED_REST<=15S');
  assert.equal(d.equityAgeMs, 1200);
  assert.match(d.equityError, /已回退/);
});

test('V13.3.1：权益REST失败且无新鲜缓存时继续禁止自动开仓', async () => {
  const date = new Date().toISOString().slice(0, 10);
  const state = { rawGet: (k, d) => k === 'dailyRisk' ? { date, dayStartEquity: 2, realizedPnl: 0, fees: 0, funding: 0 } : d, rawSet: () => {}, getCooldown: () => 0 };
  const binance = { fetchAccountEquity: async () => { throw new Error('REST down'); }, getCachedAccountSnapshot: () => null };
  const risk = new RiskManager({ config: { get: () => ({ risk: { dailyLossLimitPct: 0 } }) }, state, binance });
  const r = await risk.canRuleAutoTrade();
  assert.equal(r.ok, false);
  assert.match(r.reason, /账户权益数据不可用/);
});


test('V13.3.3：启动阶段优先使用已成功获取的账户权益提示值，避免二次REST失败阻断保护启动', async () => {
  const date = new Date().toISOString().slice(0, 10);
  const stateData = {};
  const state = {
    rawGet: (k, d) => k === 'dailyRisk' ? null : d,
    rawSet: (k, v) => { stateData[k] = v; },
  };
  const binance = {
    fetchAccountEquity: async () => { throw new Error('SECOND_ACCOUNT_REST_FAIL'); },
    getCachedAccountSnapshot: () => null,
  };
  const risk = new RiskManager({ config: { get: () => ({ risk: { dailyLossLimitPct: 0 } }) }, state, binance });
  const d = await risk.ensureDayStartEquity(1.4171);
  assert.equal(d.date, date);
  assert.equal(d.dayStartEquity, 1.4171);
  assert.equal(d.source, 'START_ACCOUNT_HINT');
  assert.equal(stateData.dailyRisk.dayStartEquity, 1.4171);
});

test('V13.3.3：启动阶段无权益提示时可使用60秒内账户快照建立日初权益', async () => {
  const date = new Date().toISOString().slice(0, 10);
  const state = { rawGet: (k, d) => k === 'dailyRisk' ? null : d, rawSet: () => {} };
  const binance = {
    fetchAccountEquity: async () => { throw new Error('REST_FAIL'); },
    getCachedAccountSnapshot: () => ({ account: { totalMarginBalance: '1.3988' }, ageMs: 5000 }),
  };
  const risk = new RiskManager({ config: { get: () => ({ risk: { dailyLossLimitPct: 0 } }) }, state, binance });
  const d = await risk.ensureDayStartEquity();
  assert.equal(d.date, date);
  assert.equal(d.dayStartEquity, 1.3988);
  assert.equal(d.source, 'CACHED_ACCOUNT<=60S');
});


test('V13.3.5：null权益提示不应被Number(null)=0吞掉，必须继续检查60秒账户缓存', async () => {
  const date = new Date().toISOString().slice(0, 10);
  const state = { rawGet: (k, d) => k === 'dailyRisk' ? null : d, rawSet: () => {} };
  const binance = {
    fetchAccountEquity: async () => { throw new Error('SHOULD_NOT_CALL_LIVE_REST'); },
    getCachedAccountSnapshot: () => ({ account: { totalMarginBalance: '1.3988' }, ageMs: 5000 }),
  };
  const risk = new RiskManager({ config: { get: () => ({ risk: { dailyLossLimitPct: 0 } }) }, state, binance });
  const d = await risk.ensureDayStartEquity(null);
  assert.equal(d.date, date);
  assert.equal(d.dayStartEquity, 1.3988);
  assert.equal(d.source, 'CACHED_ACCOUNT<=60S');
});

test('V13.3.3：日风险初始化异常只阻止自动开仓，不向上抛出中断规则风控判断', async () => {
  const state = {
    rawGet: (k, d) => d,
    rawSet: () => {},
    getCooldown: () => 0,
  };
  const binance = {
    fetchAccountEquity: async () => { throw new Error('NO_EQUITY'); },
    getCachedAccountSnapshot: () => null,
  };
  const risk = new RiskManager({ config: { get: () => ({ risk: { dailyLossLimitPct: 0 } }) }, state, binance });
  const r = await risk.canRuleAutoTrade();
  assert.equal(r.ok, false);
  assert.match(r.reason, /账户权益数据不可用/);
});


test('V13.3.5：账户连接成功但权益为0时不阻断系统初始化；后续获得正权益可建立日初基准', async () => {
  const date = new Date().toISOString().slice(0, 10);
  let equity = 0;
  const stateData = {};
  const state = {
    rawGet: (k, d) => Object.prototype.hasOwnProperty.call(stateData, k) ? stateData[k] : d,
    rawSet: (k, v) => { stateData[k] = v; },
    getCooldown: () => 0,
  };
  const binance = {
    fetchAccountEquity: async () => equity,
    getCachedAccountSnapshot: () => ({ account: { totalMarginBalance: String(equity) }, ageMs: 100 }),
  };
  const risk = new RiskManager({ config: { get: () => ({ risk: { dailyLossLimitPct: 0 } }) }, state, binance });

  const startup = await risk.ensureDayStartEquity(0);
  assert.equal(startup.date, date);
  assert.equal(startup.dayStartEquity, 0);
  assert.equal(startup.initialized, false);

  const blocked = await risk.canRuleAutoTrade();
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /账户权益数据不可用/);

  equity = 1.25;
  const d = await risk.daily();
  assert.equal(d.dayStartEquity, 1.25);
  assert.equal(d.currentEquity, 1.25);
  assert.equal(d.equityFresh, true);
  assert.equal(d.riskLoss, 0);
});
