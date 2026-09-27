const test = require('node:test');
const assert = require('node:assert/strict');
const ProtectionManager = require('../server/protection/ProtectionManager');
const PositionMonitor = require('../server/protection/PositionMonitor');
const Reconciliation = require('../server/recovery/Reconciliation');
const BinanceClient = require('../server/binance/BinanceClient');
const ConfigStore = require('../server/ConfigStore');
const fs = require('fs');
const os = require('os');
const path = require('path');

function cfg(extra = {}) {
  return {
    get: () => ({
      autoProtection: true,
      protection: {
        calculationMode: 'MARGIN', stopLossPct: 4, takeProfitPct: 8,
        stopLossMarginPct: 20, takeProfitMarginPct: 40,
        liquidationBufferPp: 0.5, priceProtect: false,
        trailingEnabled: false, trailingActivationPct: 1, trailingCallbackPct: 1,
        ...extra
      },
      ai: { closeOnProtectionFailure: true }
    })
  };
}

function pos(overrides = {}) {
  return {
    symbol: '4USDT', positionSide: 'SHORT', contracts: 203, signedContracts: -203,
    side: 'short', entryPrice: 0.025039, markPrice: 0.025019,
    liquidationPrice: 0.025637, leverage: 20, marginType: 'isolated',
    isolatedMargin: 0.26, unrealizedPnl: 0, ...overrides
  };
}

test('缺少强平价时，保护计算必须拒绝，不得把 UNKNOWN 当安全', () => {
  const pm = new ProtectionManager({
    binance: {},
    state: { getProtectionParams: () => ({}) },
    config: cfg(), emergency: null, userStream: null
  });
  const p = pos({ liquidationPrice: 0 });
  assert.equal(pm.liquidationSafety(p).ok, false);
  assert.equal(pm.isSafeSLPrice(p, 0.0252), false);
  assert.throws(() => pm.protectionTargets(p), /强平价无效/);
});

test('当前 20x 空单按 20%/40% 保证金风险换算，并受强平价硬约束', () => {
  const pm = new ProtectionManager({
    binance: {
      tickSize: () => 0.000001,
      roundPrice: (s, p, mode) => Number((mode === 'ceil' ? Math.ceil(p / 0.000001) : Math.floor(p / 0.000001)) * 0.000001)
    },
    state: { getProtectionParams: () => ({}) },
    config: cfg(), emergency: null, userStream: null
  });
  const p = pos();
  const t = pm.protectionTargets(p);
  assert.ok(Math.abs(t.effectiveStopLossPct - 1) < 1e-9);
  assert.ok(Math.abs(t.effectiveTakeProfitPct - 2) < 1e-9);
  assert.ok(t.sl < p.liquidationPrice);
  const e = p.entryPrice;
  assert.ok(t.tp < e);
});

test('positionRisk 新杠杆变化属于仓位变化，必须触发保护重算事件', async () => {
  let current = pos({ leverage: 20 });
  const monitor = new PositionMonitor({
    binance: { fetchPositions: async () => [current] },
    userStream: { on() {}, start: async () => {}, stop() {} }
  });
  const events = [];
  monitor.on('positionChanged', x => events.push(x));
  await monitor.sync('TEST1');
  current = pos({ leverage: 10 });
  await monitor.sync('TEST2');
  assert.equal(events[0].type, 'OPENED');
  assert.equal(events[1].type, 'CHANGED');
  assert.equal(events[1].riskChanged.leverage, true);
});

test('强平价变化属于风险变化，必须触发保护重算事件', async () => {
  let current = pos({ liquidationPrice: 0.025637 });
  const monitor = new PositionMonitor({
    binance: { fetchPositions: async () => [current] },
    userStream: { on() {}, start: async () => {}, stop() {} }
  });
  const events = [];
  monitor.on('positionChanged', x => events.push(x));
  await monitor.sync('TEST1');
  current = pos({ liquidationPrice: 0.02550 });
  await monitor.sync('TEST2');
  assert.equal(events[1].riskChanged.liquidationPrice, true);
});

test('PositionMonitor 串行化同步，旧 REST 响应不能覆盖新响应', async () => {
  let releaseFirst;
  const first = new Promise(r => { releaseFirst = r; });
  let calls = 0;
  const snapshots = [];
  const monitor = new PositionMonitor({
    binance: {
      fetchPositions: async () => {
        calls++;
        if (calls === 1) { await first; return [pos({ contracts: 100 })]; }
        return [pos({ contracts: 200 })];
      }
    },
    userStream: { on() {}, start: async () => {}, stop() {} }
  });
  monitor.on('snapshot', ps => snapshots.push(ps[0].contracts));
  const a = monitor.sync('FIRST');
  const b = monitor.sync('SECOND');
  releaseFirst();
  await Promise.all([a, b]);
  assert.deepEqual(snapshots, [100, 200]);
  assert.equal(monitor.known.get(monitor.key(pos())).contracts, 200);
});

test('AI保护失败时不能使用旧数量直接执行紧急平仓', async () => {
  let closeCalls = 0;
  const state = {
    getProtectionParams: () => ({}),
    getProtectionState: () => 'UNPROTECTED',
    setProtectionState: () => {},
    getPositionSource: () => 'AI'
  };
  let fetchCalls = 0;
  const pm = new ProtectionManager({
    binance: { fetchPositions: async () => { fetchCalls++; throw new Error('REST DOWN'); } },
    state,
    config: cfg(),
    emergency: { closePositionMarket: async () => { closeCalls++; } },
    userStream: null
  });
  await assert.rejects(() => pm.reconcile(pos()), /禁止使用旧数据/);
  assert.ok(fetchCalls >= 2);
  assert.equal(closeCalls, 0);
});

test('Reconciliation 已初始化的 Binance 不重复 init', async () => {
  let initCalls = 0; let fetchCalls = 0;
  const binance = {
    initialized: true,
    init: async () => { initCalls++; },
    fetchPositions: async () => { fetchCalls++; return []; }
  };
  const state = {
    rawGet: () => ({}), key: () => 'x',
    setPositionSource: () => {}
  };
  const protection = { reconcile: async () => ({ok:true}) };
  await new Reconciliation({ binance, protection, state }).run();
  assert.equal(initCalls, 0);
  assert.equal(fetchCalls, 1);
});

test('固定保护单默认关闭 priceProtect，除非显式开启', async () => {
  const client = new BinanceClient({
    credentialStore: { get: () => ({ binanceApiKey: 'k', binanceApiSecret: 's' }) },
    config: { get: () => ({ binanceSandbox: false }) }
  });
  client.symbolId = s => s;
  client.roundPrice = () => 1.2345;
  // 单测不等待生产环境 61 秒 Algo 限频窗口。
  client.algoOrderMinIntervalMs = 0;
  let captured;
  client.rawRequest = async (method, path, opts) => { captured = opts.params; return { algoId: 1 }; };
  await client.createProtectionOrder({ symbol: '4USDT', side: 'BUY', type: 'STOP_MARKET', triggerPrice: 1.2, positionSide: 'SHORT', clientAlgoId: 'QP_TEST' });
  assert.equal(captured.priceProtect, 'false');
  await client.createProtectionOrder({ symbol: '4USDT', side: 'BUY', type: 'STOP_MARKET', triggerPrice: 1.2, positionSide: 'SHORT', clientAlgoId: 'QP_TEST2', priceProtect: true });
  assert.equal(captured.priceProtect, 'true');
});


const Module = require('module');
const originalModuleLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'ws') return class MockWebSocket {};
  return originalModuleLoad.call(this, request, parent, isMain);
};
const UserDataStream = require('../server/binance/UserDataStream');
Module._load = originalModuleLoad;

test('USDⓈ-M User Data Stream 使用新 /private 路径并订阅保护相关事件', () => {
  const prod = new UserDataStream({ config: { get: () => ({ binanceSandbox: false }) } });
  const testnet = new UserDataStream({ config: { get: () => ({ binanceSandbox: true }) } });
  const prodUrl = prod.wsUrl('LK_TEST');
  const testUrl = testnet.wsUrl('LK_TEST');
  assert.match(prodUrl, /^wss:\/\/fstream\.binance\.com\/private\/ws\?listenKey=LK_TEST&events=/);
  assert.match(testUrl, /^wss:\/\/stream\.binancefuture\.com\/private\/ws\?listenKey=LK_TEST&events=/);
  for (const event of ['ORDER_TRADE_UPDATE','ACCOUNT_UPDATE','ACCOUNT_CONFIG_UPDATE','ALGO_UPDATE','MARGIN_CALL','listenKeyExpired']) {
    assert.ok(prodUrl.includes(event), `缺少事件 ${event}`);
  }
});


test('ALGO_UPDATE 即使仓位字段不变，也必须触发 protectionChanged 供保护层复核', async () => {
  const monitor = new PositionMonitor({
    binance: { fetchPositions: async () => [pos()] },
    userStream: { handlers: {}, on(name, fn) { this.handlers[name] = fn; }, start: async () => {}, stop() {} }
  });
  let changed = 0;
  monitor.on('protectionChanged', e => { changed++; assert.equal(e.e, 'ALGO_UPDATE'); });
  await monitor.start();
  await monitor.userStream.handlers.event({ e: 'ALGO_UPDATE', o: { s: '4USDT', ps: 'SHORT', type: 'STOP_MARKET', X: 'CANCELED' } });
  assert.equal(changed, 1);
  monitor.stop();
});


test('Ollama 保存配置不应被意外改成需 Key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-config-'));
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ai: { providers: [{ id: 'ollama', enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' }] } }), 'utf8');
    const store = new ConfigStore(dir);
    const ollama = store.get().ai.providers.find(x => x.id === 'ollama');
    assert.equal(ollama.requiresKey, false);
    assert.equal(ollama.free, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('One-way 普通条件单不能冒充保护单，必须明确 closePosition 或 reduceOnly', () => {
  const pm = new ProtectionManager({ binance: {}, state: { getProtectionParams: () => ({}) }, config: cfg(), emergency: null, userStream: null });
  const p = pos({ positionSide: 'BOTH' });
  const base = { symbol: '4USDT', positionSide: 'BOTH', side: 'BUY', orderType: 'STOP_MARKET', algoStatus: 'NEW', triggerPrice: 0.0252 };
  assert.equal(pm.isMatchingOrder(base, p), false);
  assert.equal(pm.isMatchingOrder({ ...base, reduceOnly: true }, p), true);
  assert.equal(pm.isMatchingOrder({ ...base, closePosition: 'true' }, p), true);
});

test('Hedge Mode 正确仓位方向的反向条件单可作为平仓保护', () => {
  const pm = new ProtectionManager({ binance: {}, state: { getProtectionParams: () => ({}) }, config: cfg(), emergency: null, userStream: null });
  const p = pos({ positionSide: 'SHORT' });
  const order = { symbol: '4USDT', positionSide: 'SHORT', side: 'BUY', orderType: 'STOP_MARKET', algoStatus: 'NEW', triggerPrice: 0.0252 };
  assert.equal(pm.isMatchingOrder(order, p), true);
});


test('保护锁期间再次收到取消/风险事件不能丢失，当前保护完成后自动再复核一次', async () => {
  const state = {
    getProtectionParams: () => ({}),
    getProtectionState: () => 'UNPROTECTED',
    getPositionSource: () => 'MANUAL',
    setProtectionState: () => {}
  };
  const pm = new ProtectionManager({ binance: {}, state, config: cfg(), emergency: null, userStream: null });
  let calls = 0;
  let release;
  pm._protect = async () => {
    calls++;
    if (calls === 1) await new Promise(r => { release = r; });
    return { ok: true, state: 'PROTECTED' };
  };
  const first = pm.protect(pos());
  await new Promise(r => setImmediate(r));
  const second = pm.protect(pos(), { reason: 'ALGO_UPDATE' });
  assert.equal(second, first);
  assert.equal(pm.pendingRequests.size, 1);
  release();
  await first;
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 2);
  assert.equal(pm.pendingRequests.size, 0);
});



test('保护程序主动撤单产生的 ALGO_UPDATE 不应再次触发自激复核', () => {
  const pm = new ProtectionManager({ binance: {}, state: { getProtectionParams: () => ({}) }, config: cfg(), emergency: null, userStream: null });
  const p = pos();
  pm.markInternalAlgoCancel(778899);
  assert.equal(pm.shouldReviewAlgoUpdate({ e: 'ALGO_UPDATE', o: { s: '4USDT', ps: 'SHORT', type: 'STOP_MARKET', X: 'CANCELED', algoId: 778899 } }, p), false);
  assert.equal(pm.shouldReviewAlgoUpdate({ e: 'ALGO_UPDATE', o: { s: '4USDT', ps: 'SHORT', type: 'STOP_MARKET', X: 'CANCELED', algoId: 778899 } }, p), false);
});

test('PositionMonitor 启动初始同步默认不触发 OPENED 保护事件', async () => {
  const monitor = new PositionMonitor({
    binance: { fetchPositions: async () => [pos()] },
    userStream: { handlers: {}, on(name, fn) { this.handlers[name] = fn; }, start: async () => {}, stop() {} }
  });
  let opened = 0;
  monitor.on('positionChanged', e => { if (e.type === 'OPENED') opened++; });
  await monitor.start();
  assert.equal(opened, 0);
  monitor.stop();
});

test('PositionMonitor restart 不会累积 userStream listener', async () => {
  const { EventEmitter } = require('node:events');
  const stream = new EventEmitter();
  stream.start = async () => {}; stream.stop = () => {};
  let fetches = 0;
  const monitor = new PositionMonitor({ binance: { fetchPositions: async () => { fetches++; return [pos()]; } }, userStream: stream });
  await monitor.start();
  monitor.stop();
  await monitor.start();
  assert.equal(stream.listenerCount('event'), 1);
  assert.equal(stream.listenerCount('status'), 1);
  monitor.stop();
  assert.equal(stream.listenerCount('event'), 0);
  assert.equal(stream.listenerCount('status'), 0);
  assert.ok(fetches >= 2);
});

test('PositionMonitor 相同 ALGO_UPDATE 指纹短时间重复到达时只处理一次', async () => {
  const { EventEmitter } = require('node:events');
  const stream = new EventEmitter();
  stream.start = async () => {}; stream.stop = () => {};
  const monitor = new PositionMonitor({ binance: { fetchPositions: async () => [pos()] }, userStream: stream });
  let syncCalls = 0;
  await monitor.start();
  monitor.sync = async () => { syncCalls++; return [pos()]; };
  const event = { e: 'ALGO_UPDATE', E: 1000, T: 999, o: { s: '4USDT', ps: 'SHORT', algoId: 123, X: 'CANCELED', type: 'STOP_MARKET', triggerPrice: '0.0253' } };
  try {
    stream.emit('event', event);
    stream.emit('event', { ...event, o: { ...event.o } });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(syncCalls, 1);
  } finally {
    monitor.stop();
  }
});

test('ALGO_UPDATE 的 NEW 不触发保护复核，CANCELED/EXPIRED 才触发', () => {
  const pm = new ProtectionManager({ binance: {}, state: { getProtectionParams: () => ({}) }, config: cfg(), emergency: null, userStream: null });
  const p = pos();
  assert.equal(pm.shouldReviewAlgoUpdate({ e: 'ALGO_UPDATE', o: { s: '4USDT', ps: 'SHORT', type: 'STOP_MARKET', X: 'NEW' } }, p), false);
  assert.equal(pm.shouldReviewAlgoUpdate({ e: 'ALGO_UPDATE', o: { s: '4USDT', ps: 'SHORT', type: 'STOP_MARKET', X: 'CANCELED' } }, p), true);
  assert.equal(pm.shouldReviewAlgoUpdate({ e: 'ALGO_UPDATE', o: { s: '4USDT', ps: 'SHORT', type: 'STOP_MARKET', X: 'EXPIRED' } }, p), true);
});


test('保护世代 guard 必须传递到 Algo 创建请求，仓位关闭后排队任务可被取消', async () => {
  const captured = [];
  const state = {
    getProtectionParams: () => ({ mode: 'MARGIN', stopLossMarginPct: 3, takeProfitMarginPct: 10 }),
    getPositionSource: () => 'MANUAL',
    setProtectionState: () => {},
    deletePosition: () => {}
  };
  const config = cfg();
  const binance = {
    fetchPositions: async () => [{ ...pos({ symbol: '4USDT', positionSide: 'SHORT', contracts: 10, entryPrice: 0.025, markPrice: 0.0249, leverage: 20, liquidationPrice: 0.026 }) }],
    tickSize: () => 0.000001,
    roundPrice: (_s, p) => Number(p.toFixed(6)),
    stepSize: () => 1,
    fetchOpenAlgoOrders: async () => [],
    createProtectionOrder: async opts => { captured.push(opts); return { algoId: 1, algoStatus: 'NEW', triggerPrice: opts.triggerPrice }; },
    cancelAlgoOrder: async () => ({ ok: true })
  };
  const pm = new ProtectionManager({ binance, state, config, emergency: null, userStream: null });
  const p0 = { symbol: '4USDT', positionSide: 'SHORT', side: 'short', contracts: 10, entryPrice: 0.025, markPrice: 0.0249, leverage: 20, liquidationPrice: 0.026, notional: 0.5, marginType: 'ISOLATED' };
  pm._protect = async function(position) {
    const key = this.key(position);
    const generation = this.positionGeneration(position);
    const guard = () => this.isPositionGenerationCurrent(key, generation);
    await binance.createProtectionOrder({ symbol: position.symbol, side: 'BUY', type: 'STOP_MARKET', triggerPrice: 0.0252, positionSide: position.positionSide, clientAlgoId: 'QP_TEST', queueKey: key, queueGuard: guard });
    return { ok: true };
  };
  await pm.protect(p0);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].queueKey, '4USDT|SHORT');
  assert.equal(typeof captured[0].queueGuard, 'function');
  pm.invalidatePositionGeneration(p0, 'POSITION_CLOSED');
  assert.equal(captured[0].queueGuard(), false);
});

test('保护请求执行中仓位关闭后，过期世代的 Binance 订单错误不计入保护失败', async () => {
  const state = {
    getProtectionParams: () => ({ mode: 'MARGIN', stopLossMarginPct: 3, takeProfitMarginPct: 10 }),
    getPositionSource: () => 'MANUAL',
    setProtectionState: () => {},
    deletePosition: () => {}
  };
  const config = cfg();
  let pm;
  const binance = {
    fetchPositions: async () => [{ ...pos({ symbol:'4USDT', positionSide:'SHORT', contracts:10, entryPrice:0.025, markPrice:0.0249, leverage:20, liquidationPrice:0.026 }) }],
    tickSize: () => 0.000001,
    roundPrice: (_s,p,mode) => Number((mode === 'ceil' ? Math.ceil(p / 0.000001) : Math.floor(p / 0.000001)) * 0.000001),
    fetchOpenAlgoOrders: async () => [],
    createProtectionOrder: async () => {
      pm.invalidatePositionGeneration({ symbol:'4USDT', positionSide:'SHORT' }, 'POSITION_CLOSED');
      const e = new Error('Binance -4509: position no longer open');
      e.code = -4509; e.status = 400;
      throw e;
    }
  };
  pm = new ProtectionManager({ binance, state, config, emergency:null, userStream:null });
  const result = await pm.protect(pos({ symbol:'4USDT', positionSide:'SHORT', contracts:10, entryPrice:0.025, markPrice:0.0249, leverage:20, liquidationPrice:0.026 }));
  assert.equal(result.cancelled, true);
  assert.equal(pm.failureCounts.has('4USDT|SHORT'), false);
});


test('Trailing ia=true 即使 ALGO_UPDATE 没有 type 字段，也必须触发复核', () => {
  const cfg = { get: () => ({ autoProtection:true, protection:{ calculationMode:'MARGIN', stopLossPct:4, takeProfitPct:8, stopLossMarginPct:20, takeProfitMarginPct:40, liquidationBufferPp:0.5, trailingEnabled:true, trailingActivationPct:1, trailingCallbackPct:1 } }) };
  const state = { getProtectionState:()=> 'PROTECTED', setProtectionState:()=>{} };
  const binance = { fetchPositions:async()=>[], fetchOpenAlgoOrders:async()=>[], tickSize:()=>0.01, roundPrice:(_s,p)=>p };
  const pm = new ProtectionManager({binance,state,config:cfg,emergency:null,userStream:null});
  const p = {symbol:'BTCUSDT', positionSide:'LONG', side:'long'};
  assert.equal(pm.shouldReviewAlgoUpdate({e:'ALGO_UPDATE', o:{algoId:123, ps:'LONG', s:'BTCUSDT', ia:true, X:'NEW'}}, p), true);
  assert.equal(pm.shouldReviewAlgoUpdate({e:'ALGO_UPDATE', o:{algoId:123, ps:'LONG', s:'BTCUSDT', ia:false, X:'NEW'}}, p), false);
});
