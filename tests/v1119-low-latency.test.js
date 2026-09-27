const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const originalModuleLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'ws') return class MockWebSocket {};
  return originalModuleLoad.call(this, request, parent, isMain);
};
const MarkPriceStream = require('../server/binance/MarkPriceStream');
Module._load = originalModuleLoad;
const ProtectionManager = require('../server/protection/ProtectionManager');
const Logger = require('../server/Logger');

function cfg() {
  return { get: () => ({
    autoProtection: true,
    protection: {
      calculationMode: 'MARGIN',
      stopLossPct: 4,
      takeProfitPct: 8,
      stopLossMarginPct: 3,
      takeProfitMarginPct: 10,
      liquidationBufferPp: 0.5,
      priceProtect: false,
      closeOnImmediateTarget: true,
      trailingEnabled: true,
      trailingActivationPct: 1,
      trailingCallbackPct: 1
    },
    ai: { closeOnProtectionFailure: true }
  }) };
}

test('Mark Price 1s WS 能解析 combined stream 并计算标准字段', () => {
  const stream = new MarkPriceStream({ config: { get: () => ({ binanceSandbox: false }) } });
  const out = [];
  stream.setSymbols(['4USDT']);
  stream.on('markPrice', x => out.push(x));
  stream.handleMessage(JSON.stringify({
    stream: '4usdt@markPrice@1s',
    data: { e: 'markPriceUpdate', E: 1000, T: 999, s: '4USDT', p: '0.025123' }
  }));
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, '4USDT');
  assert.equal(out[0].markPrice, 0.025123);
  assert.equal(out[0].eventTime, 1000);
  assert.equal(out[0].transactionTime, 999);
  assert.ok(out[0].receivedAt > 0);
  assert.match(stream.wsUrl(), /4usdt@markPrice@1s/);
});

test('Mark Price 非正式盘时使用测试网 public 地址', () => {
  const stream = new MarkPriceStream({ config: { get: () => ({ binanceSandbox: true }) } });
  stream.setSymbols(['BTCUSDT']);
  assert.match(stream.wsUrl(), /^wss:\/\/fstream\.binancefuture\.com\/public\/stream\?streams=btcusdt@markPrice@1s$/);
});

test('止损穿越时 Mark Price 本地兜底只执行一次市价平仓', async () => {
  let closeCalls = 0;
  const position = {
    symbol: 'ARKUSDT', positionSide: 'SHORT', side: 'short', contracts: 22,
    entryPrice: 0.2388, markPrice: 0.2400, liquidationPrice: 0.24957,
    leverage: 14, isolatedMargin: 0.39, unrealizedPnl: -0.01
  };
  const state = {
    getProtectionMeta: () => ({ activeSL: 0.2397, targetSL: 0.2397 }),
    getProtectionState: () => 'PROTECTED',
    getPositionSource: () => 'MANUAL',
    setProtectionState: () => {},
    getProtectionParams: () => ({})
  };
  const pm = new ProtectionManager({
    binance: {
      timeOffset: 0,
      fetchPositions: async () => [position]
    },
    state,
    config: cfg(),
    emergency: { closePositionMarket: async () => { closeCalls++; return { orderId: 123 }; } },
    userStream: null
  });
  const a = pm.handleMarkPrice({ ...position }, 0.2400, { eventTime: Date.now(), wsLatencyMs: 10 });
  const b = pm.handleMarkPrice({ ...position }, 0.2400, { eventTime: Date.now(), wsLatencyMs: 11 });
  const [r1, r2] = await Promise.all([a, b]);
  assert.equal(r1.ok || r2.ok, true);
  assert.equal(closeCalls, 1);
});

test('Mark Price 未穿越止损时不能触发本地市价平仓', async () => {
  let closeCalls = 0;
  const position = {
    symbol: 'ARKUSDT', positionSide: 'SHORT', side: 'short', contracts: 22,
    entryPrice: 0.2388, markPrice: 0.2390, liquidationPrice: 0.24957,
    leverage: 14, isolatedMargin: 0.39, unrealizedPnl: 0.0
  };
  const state = {
    getProtectionMeta: () => ({ activeSL: 0.2397, targetSL: 0.2397 }),
    getProtectionState: () => 'PROTECTED',
    getPositionSource: () => 'MANUAL',
    getProtectionParams: () => ({})
  };
  const pm = new ProtectionManager({
    binance: { fetchPositions: async () => [position] },
    state,
    config: cfg(),
    emergency: { closePositionMarket: async () => { closeCalls++; } },
    userStream: null
  });
  const r = await pm.handleMarkPrice({ ...position }, 0.2390, { eventTime: Date.now(), wsLatencyMs: 10 });
  assert.equal(r.skipped, true);
  assert.equal(closeCalls, 0);
});

test('保护目标在 Algo 建单前已写入状态，供 UI 立即显示', async () => {
  const writes = [];
  const position = {
    symbol: '4USDT', positionSide: 'SHORT', side: 'short', contracts: 100,
    entryPrice: 0.025, markPrice: 0.0249, liquidationPrice: 0.026,
    leverage: 20, isolatedMargin: 0.125, unrealizedPnl: 0
  };
  const state = {
    getProtectionParams: () => ({}),
    getProtectionState: () => 'UNPROTECTED',
    getPositionSource: () => 'MANUAL',
    setProtectionState: (...args) => writes.push(args)
  };
  const pm = new ProtectionManager({
    binance: {
      fetchPositions: async () => [position],
      tickSize: () => 0.000001,
      roundPrice: (_s,p,mode) => mode === 'ceil' ? Math.ceil(p/0.000001)*0.000001 : Math.floor(p/0.000001)*0.000001,
      fetchOpenAlgoOrders: async () => [],
      createProtectionOrder: async () => ({ algoId: 1 })
    },
    state,
    config: cfg(),
    emergency: null,
    userStream: null
  });
  await assert.rejects(() => pm._protect(position, { forceConfig: false, reason: 'TEST' }), /SL 创建后未确认安全保护|保护复核失败|保护目标已被当前 Mark/);
  const targetWrite = writes.find(x => x[1] === 'PROTECTING' && x[2]?.targetSL);
  assert.ok(targetWrite, 'SL/TP 目标应该在建单前先写入状态');
  assert.ok(Number(targetWrite[2].targetSL) > 0);
  assert.ok(Number(targetWrite[2].targetTP) > 0);
});


test('Mark Price 首次跨过 Trailing 激活线时立即触发一次保护复核', async () => {
  const position = {
    symbol: 'ARKUSDT', positionSide: 'SHORT', side: 'short', contracts: 22,
    entryPrice: 0.2388, markPrice: 0.2388, liquidationPrice: 0.24957,
    leverage: 14, isolatedMargin: 0.39, unrealizedPnl: 0
  };
  const state = {
    getProtectionMeta: () => ({ activeSL: 0.2397, targetSL: 0.2397, activeTP: 0.2353, targetTP: 0.2353 }),
    getProtectionState: () => 'PROTECTED', getPositionSource: () => 'MANUAL', setProtectionState: () => {}
  };
  const pm = new ProtectionManager({
    binance: { getQueuedAlgoJobs: () => [] }, state, config: cfg(), emergency: { closePositionMarket: async () => ({}) }, userStream: null
  });
  let calls = 0;
  let seenMark = null;
  pm.reconcile = async (p, options) => { calls++; seenMark = p.markPrice; assert.equal(options.reason, 'MARK_PRICE_TRAILING_ACTIVATION'); return { ok: true }; };
  const r1 = await pm.handleMarkPrice(position, 0.2360, { eventTime: Date.now(), wsLatencyMs: 12 });
  const r2 = await pm.handleMarkPrice(position, 0.2360, { eventTime: Date.now(), wsLatencyMs: 13 });
  await new Promise(r => setImmediate(r));
  assert.equal(r1.trailingActivationTriggered, true);
  assert.equal(r2.trailingActivationTriggered, undefined);
  assert.equal(calls, 1);
  assert.equal(seenMark, 0.2360);
});

test('TP 目标已达到且 Binance TP 尚未确认时，Mark Price 本地兜底只平仓一次', async () => {
  let closeCalls = 0;
  const position = {
    symbol: 'HUSDT', positionSide: 'SHORT', side: 'short', contracts: 71,
    entryPrice: 0.07121, markPrice: 0.06975, liquidationPrice: 0.07456,
    leverage: 10, isolatedMargin: 0.50, unrealizedPnl: 0.02
  };
  const state = {
    getProtectionMeta: () => ({ targetTP: 0.06978, activeTP: null, activeSL: 0.07143, targetSL: 0.07143 }),
    getPositionSource: () => 'MANUAL', getProtectionState: () => 'PROTECTING', setProtectionState: () => {}
  };
  const pm = new ProtectionManager({
    binance: { fetchPositions: async () => [position] }, state, config: cfg(), emergency: { closePositionMarket: async () => { closeCalls++; return { orderId: 7 }; } }, userStream: null
  });
  const [a, b] = await Promise.all([
    pm.handleMarkPrice(position, 0.06970, { eventTime: Date.now(), wsLatencyMs: 10 }),
    pm.handleMarkPrice(position, 0.06970, { eventTime: Date.now(), wsLatencyMs: 11 })
  ]);
  assert.equal(a.ok || b.ok, true);
  assert.equal(closeCalls, 1);
});

test('实时 Mark Price 穿越待提交 TP 时，先取消该仓位排队 Algo 任务再执行本地兜底', async () => {
  let cancelArgs = null;
  let closeCalls = 0;
  const position = {
    symbol: 'QNTUSDT', positionSide: 'LONG', side: 'long', contracts: 10,
    entryPrice: 90, markPrice: 90, liquidationPrice: 80, leverage: 10, isolatedMargin: 0.9
  };
  const state = {
    getProtectionMeta: () => ({ targetTP: 91, activeTP: null, targetSL: 89, activeSL: 89 }),
    getProtectionState: () => 'PROTECTING', getPositionSource: () => 'MANUAL', setProtectionState: () => {}
  };
  const pm = new ProtectionManager({
    binance: {
      getQueuedAlgoJobs: () => [{ label: 'TP', queueKey: 'QNTUSDT|LONG' }],
      cancelQueuedAlgoJobs: (key, reason) => { cancelArgs = [key, reason]; return 1; },
      fetchPositions: async () => [position]
    },
    state, config: cfg(),
    emergency: { closePositionMarket: async () => { closeCalls++; return { orderId: 88 }; } }, userStream: null
  });
  const r = await pm.handleMarkPrice(position, 91.01, { eventTime: Date.now(), wsLatencyMs: 5 });
  assert.equal(r.ok, true);
  assert.deepEqual(cancelArgs, ['QNTUSDT|LONG', 'TARGET_CROSSED_WHILE_QUEUED_TP']);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(closeCalls, 1);
});

test('Algo 队列 guard 返回专用取消原因时，不应伪装成仓位关闭', async () => {
  const BinanceClient = require('../server/binance/BinanceClient');
  const client = new BinanceClient({ credentialStore: { get: () => ({}) }, config: { get: () => ({ binanceSandbox: false }) } });
  client.algoOrderMinIntervalMs = 0;
  let calls = 0;
  const job = client.enqueueAlgoOrder(async () => { calls++; return 1; }, { label: 'TP', priority: 50, queueGuard: () => 'TARGET_CROSSED_WHILE_QUEUED_TP' });
  await assert.rejects(job, err => err?.name === 'AlgoQueueCancelledError' && err?.reason === 'TARGET_CROSSED_WHILE_QUEUED_TP' && err?.code === 'QUEUE_JOB_CANCELLED');
  assert.equal(calls, 0);
});

test('V11.3.1 低延迟固定保护：SL优先确认，TP异步排队且不阻塞保护首段', async () => {
  const ProtectionManager = require('../server/protection/ProtectionManager');
  const state = {
    setProtectionState: () => {},
    getProtectionState: () => 'UNPROTECTED',
    getProtectionMeta: () => ({}),
    getProtectionParams: () => ({}),
    getPositionSource: () => 'RULE'
  };
  const config = {
    get: () => ({
      autoProtection: true,
      protection: {
        calculationMode: 'PRICE', stopLossPct: 0.5, takeProfitPct: 2,
        liquidationBufferPp: 0.5, priceProtect: false, fastFixedProtection: true,
        trailingEnabled: false, closeOnImmediateTarget: true
      }
    })
  };
  const p = { symbol: 'TESTUSDT', positionSide: 'LONG', side: 'long', contracts: 1, entryPrice: 100, markPrice: 100, leverage: 10, liquidationPrice: 50, marginType: 'ISOLATED' };
  const pm = new ProtectionManager({ binance: {}, state, config, emergency: null, userStream: null });
  pm.positionGeneration = () => 1;
  pm.isPositionGenerationCurrent = () => true;
  pm.refreshPosition = async x => x;
  pm.exchangeProtectionTargets = () => ({ tickSize: 0.01, sl: 99.5, tp: 102 });
  pm.listProtection = async () => [{ symbol: 'TESTUSDT', positionSide: 'LONG', side: 'SELL', orderType: 'STOP_MARKET', algoStatus: 'NEW', triggerPrice: 99.5, algoId: 1, clientAlgoId: 'QP_SL_TEST' }];
  pm.createAlgoFixedProtection = async ({ type }) => {
    if (type === 'STOP_MARKET') return { symbol: 'TESTUSDT', positionSide: 'LONG', side: 'SELL', orderType: 'STOP_MARKET', algoStatus: 'NEW', triggerPrice: 99.5, algoId: 1, clientAlgoId: 'QP_SL_TEST' };
    await new Promise(resolve => setTimeout(resolve, 2000));
    return { symbol: 'TESTUSDT', positionSide: 'LONG', side: 'SELL', orderType: 'TAKE_PROFIT_MARKET', algoStatus: 'NEW', triggerPrice: 102, algoId: 2, clientAlgoId: 'QP_TP_TEST' };
  };
  const started = Date.now();
  const result = await pm._protect(p, { reason: 'UNIT_TEST', forceConfig: false });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, true);
  assert.equal(result.state, 'PROTECTING');
  assert.ok(elapsed < 1000, `保护首段耗时 ${elapsed}ms，不能等待TP限频任务`);
  assert.equal(pm.hasPendingFixedProtection(p, 'TAKE_PROFIT_MARKET'), true);
});
