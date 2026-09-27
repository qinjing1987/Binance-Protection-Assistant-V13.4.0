const test = require('node:test');
const assert = require('node:assert/strict');
const BinanceClient = require('../server/binance/BinanceClient');

test('Algo 下单队列全局串行，并遵守最小间隔', async () => {
  const client = new BinanceClient({
    credentialStore: { get: () => ({}) },
    config: { get: () => ({ binanceSandbox: false }) }
  });
  client.algoOrderMinIntervalMs = 20;
  const events = [];
  const p1 = client.enqueueAlgoOrder(async () => { events.push(['start', 1, Date.now()]); return 1; }, { label: 'SL', priority: 100 });
  const p2 = client.enqueueAlgoOrder(async () => { events.push(['start', 2, Date.now()]); return 2; }, { label: 'TP', priority: 50 });
  const r = await Promise.all([p1, p2]);
  assert.deepEqual(r, [1, 2]);
  assert.equal(events.length, 2);
  assert.ok(events[1][2] - events[0][2] >= 15);
});

test('Algo 队列按优先级处理尚未执行的任务，新增 SL 可排在待执行 TP 前', async () => {
  const client = new BinanceClient({
    credentialStore: { get: () => ({}) },
    config: { get: () => ({ binanceSandbox: false }) }
  });
  client.algoOrderMinIntervalMs = 0;
  let releaseFirst;
  const execution = [];
  const first = client.enqueueAlgoOrder(async () => {
    execution.push('FIRST');
    await new Promise(r => { releaseFirst = r; });
  }, { label: 'FIRST', priority: 1 });
  const tp = client.enqueueAlgoOrder(async () => { execution.push('TP'); return 'tp'; }, { label: 'TP', priority: 50 });
  const sl = client.enqueueAlgoOrder(async () => { execution.push('SL'); return 'sl'; }, { label: 'SL', priority: 100 });
  releaseFirst();
  await first;
  const results = await Promise.all([tp, sl]);
  assert.deepEqual(execution, ['FIRST', 'SL', 'TP']);
  assert.deepEqual([results[0], results[1]], ['tp', 'sl']);
  assert.equal(client.algoOrderQueue.length, 0);
});


test('cancelAlgoOrder 进入全局 Algo 变更队列，但不占用 POST Algo 提交限频时间戳', async () => {
  const client = new BinanceClient({
    credentialStore: { get: () => ({}) },
    config: { get: () => ({ binanceSandbox: false }) }
  });
  client.algoOrderMinIntervalMs = 30;

  const events = [];
  let releaseCreate;
  client.rawRequest = async (method, path, options) => {
    events.push(['start', method, path, options?.params?.algoId || null, Date.now()]);
    if (method === 'POST') {
      await new Promise(resolve => { releaseCreate = resolve; });
    }
    return { ok: true };
  };

  const create = client.enqueueAlgoOrder(() => client.rawRequest('POST', '/fapi/v1/algoOrder', { signed: true, params: { type: 'STOP_MARKET' } }), { label: 'SL', priority: 100 });
  await new Promise(r => setTimeout(r, 2));
  const cancel = client.cancelAlgoOrder('4USDT', 123);

  assert.equal(events.length, 1);
  assert.equal(events[0][1], 'POST');
  assert.ok(client.algoOrderQueue.length >= 1);
  releaseCreate();

  await create;
  const submitAt = client.lastAlgoOrderSubmitAt;
  await cancel;

  assert.equal(events.length, 2);
  assert.equal(events[1][1], 'DELETE');
  assert.equal(events[1][2], '/fapi/v1/algoOrder');
  assert.equal(events[1][3], 123);
  assert.equal(client.lastAlgoOrderSubmitAt, submitAt);
});

test('连续 cancelAlgoOrder 调用保持全局串行，不直接并发 rawRequest', async () => {
  const client = new BinanceClient({
    credentialStore: { get: () => ({}) },
    config: { get: () => ({ binanceSandbox: false }) }
  });
  client.algoOrderMinIntervalMs = 0;
  let active = 0;
  let maxActive = 0;
  const completed = [];
  client.rawRequest = async (_method, _path, options) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 10));
    completed.push(options.params.algoId);
    active -= 1;
    return { ok: true };
  };

  await Promise.all([
    client.cancelAlgoOrder('4USDT', 1),
    client.cancelAlgoOrder('4USDT', 2),
    client.cancelAlgoOrder('4USDT', 3)
  ]);

  assert.equal(maxActive, 1);
  assert.deepEqual(completed, [1, 2, 3]);
  assert.equal(client.algoOrderQueue.length, 0);
});


test('replaceProtectionOrder 在同一个限频任务内先撤旧再建新，不产生 61 秒保护空窗', async () => {
  const client = new BinanceClient({
    credentialStore: { get: () => ({}) },
    config: { get: () => ({ binanceSandbox: false }) }
  });
  client.algoOrderMinIntervalMs = 20;
  client.roundPrice = (_s, p) => p;
  const calls = [];
  client.rawRequest = async (method, path, opts) => {
    calls.push({ method, path, at: Date.now(), params: opts?.params });
    return method === 'POST'
      ? { algoId: 999001, algoStatus: 'NEW' }
      : { code: 200 };
  };
  const result = await client.replaceProtectionOrder({
    existingAlgoId: 888001,
    symbol: 'HUSDT', side: 'BUY', type: 'TAKE_PROFIT_MARKET', triggerPrice: 0.06978,
    positionSide: 'SHORT', clientAlgoId: 'QP_TP_TEST', priceProtect: false
  });
  assert.equal(result.algoId, 999001);
  assert.deepEqual(calls.map(x => x.method), ['DELETE', 'POST']);
  assert.equal(calls[0].params.algoId, 888001);
  assert.equal(calls[1].params.type, 'TAKE_PROFIT_MARKET');
  assert.equal(calls[1].params.triggerPrice, 0.06978);
  assert.ok(client.lastAlgoOrderSubmitAt > 0);
  assert.ok(calls[1].at - calls[0].at < 20, '进入替换任务后撤旧与新建之间不应额外等待整个限频窗口');
});


test('TRAILING_STOP_MARKET 使用 Binance 原生 activatePrice/callbackRate，并保持 Hedge/One-way 参数正确', async () => {
  const client = new BinanceClient({
    credentialStore: { get: () => ({}) },
    config: { get: () => ({ binanceSandbox: false }) }
  });
  client.markets.set('BTCUSDT', {
    symbol: 'BTCUSDT',
    pricePrecision: 1,
    quantityPrecision: 3,
    filters: { PRICE_FILTER: { tickSize: '0.1' }, LOT_SIZE: { stepSize: '0.001', minQty: '0.001' } }
  });
  client.algoOrderMinIntervalMs = 0;
  let captured = null;
  client.rawRequest = async (_method, _path, options) => { captured = options.params; return { algoId: 900123, algoStatus: 'NEW' }; };

  await client.createTrailingOrder({
    symbol: 'BTCUSDT', side: 'SELL', quantity: 2, activationPrice: 101.04, callbackRate: 1,
    positionSide: 'LONG', clientAlgoId: 'QP_TR_TEST', queueKey: 'BTCUSDT|LONG'
  });

  assert.equal(captured.type, 'TRAILING_STOP_MARKET');
  assert.equal(captured.positionSide, 'LONG');
  assert.equal(captured.quantity, 2);
  assert.equal(captured.activatePrice, 101.1);
  assert.equal(captured.callbackRate, 1);
  assert.equal(captured.reduceOnly, undefined, 'Hedge Mode 不应发送 reduceOnly');
});

test('One-way Trailing 才发送 reduceOnly=true', async () => {
  const client = new BinanceClient({
    credentialStore: { get: () => ({}) },
    config: { get: () => ({ binanceSandbox: false }) }
  });
  client.markets.set('BTCUSDT', {
    symbol: 'BTCUSDT',
    pricePrecision: 1,
    quantityPrecision: 3,
    filters: { PRICE_FILTER: { tickSize: '0.1' }, LOT_SIZE: { stepSize: '0.001', minQty: '0.001' } }
  });
  client.algoOrderMinIntervalMs = 0;
  let captured = null;
  client.rawRequest = async (_method, _path, options) => { captured = options.params; return { algoId: 900124, algoStatus: 'NEW' }; };

  await client.createTrailingOrder({
    symbol: 'BTCUSDT', side: 'BUY', quantity: 2, activationPrice: 99.96, callbackRate: 0.5,
    positionSide: 'BOTH', clientAlgoId: 'QP_TR_TEST2', queueKey: 'BTCUSDT|BOTH'
  });

  assert.equal(captured.type, 'TRAILING_STOP_MARKET');
  assert.equal(captured.positionSide, 'BOTH');
  assert.equal(captured.reduceOnly, 'true');
  assert.equal(captured.activatePrice, 99.9);
  assert.equal(captured.callbackRate, 0.5);
});


test('Trailing 已达到激活条件时可以省略 activatePrice，交给 Binance 使用最新价格', async () => {
  const client = new BinanceClient({
    credentialStore: { get: () => ({}) },
    config: { get: () => ({ binanceSandbox: false }) }
  });
  client.markets.set('BTCUSDT', {
    symbol: 'BTCUSDT', pricePrecision: 1, quantityPrecision: 3,
    filters: { PRICE_FILTER: { tickSize: '0.1' }, LOT_SIZE: { stepSize: '0.001', minQty: '0.001' } }
  });
  client.algoOrderMinIntervalMs = 0;
  let captured = null;
  client.rawRequest = async (_method, _path, options) => { captured = options.params; return { algoId: 900125, algoStatus: 'NEW' }; };
  await client.createTrailingOrder({
    symbol: 'BTCUSDT', side: 'SELL', quantity: 2, activationPrice: null, callbackRate: 0.7,
    positionSide: 'LONG', clientAlgoId: 'QP_TR_TEST3', queueKey: 'BTCUSDT|LONG'
  });
  assert.equal(captured.activatePrice, undefined);
  assert.equal(captured.callbackRate, 0.7);
});

test('Algo 限频等待期间，新到的高优先级 SL 可以抢在旧 TP 前执行', async () => {
  const client = new BinanceClient({
    credentialStore: { get: () => ({}) },
    config: { get: () => ({ binanceSandbox: false }) }
  });
  client.algoOrderMinIntervalMs = 80;
  client.lastAlgoOrderSubmitAt = Date.now();
  const execution = [];
  const tp = client.enqueueAlgoOrder(async () => { execution.push('TP'); }, { label: 'TP', priority: 50 });
  await new Promise(r => setTimeout(r, 10));
  const sl = client.enqueueAlgoOrder(async () => { execution.push('SL'); }, { label: 'SL', priority: 100 });
  await Promise.all([sl, tp]);
  assert.deepEqual(execution, ['SL', 'TP']);
});
