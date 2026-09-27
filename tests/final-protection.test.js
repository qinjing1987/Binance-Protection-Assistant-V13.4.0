const test = require('node:test');
const assert = require('node:assert/strict');
const ProtectionManager = require('../server/protection/ProtectionManager');

function cfg(extra = {}) {
  return {
    get: () => ({
      autoProtection: true,
      protection: {
        calculationMode: 'MARGIN',
        stopLossPct: 4,
        takeProfitPct: 8,
        stopLossMarginPct: 20,
        takeProfitMarginPct: 40,
        liquidationBufferPp: 0.5,
        priceProtect: false,
        trailingEnabled: false,
        closeOnImmediateTarget: true,
        ...extra
      },
      ai: { closeOnProtectionFailure: true }
    })
  };
}

function basePos(overrides = {}) {
  return {
    symbol: '4USDT', positionSide: 'SHORT', side: 'short',
    contracts: 203, signedContracts: -203,
    entryPrice: 0.025039, markPrice: 0.025019,
    liquidationPrice: 0.025637, leverage: 20,
    marginType: 'isolated', isolatedMargin: 0.26,
    notional: -5.082917, unrealizedPnl: 0,
    ...overrides
  };
}

function build({ initialOrders = [], freshPosition = basePos(), closeOnImmediate = true } = {}) {
  let orders = initialOrders.map(x => ({ ...x }));
  let nextId = 9000;
  const created = [];
  const canceled = [];
  let fetchPositionCalls = 0;
  let emergencyCalls = [];
  const state = {
    getProtectionParams: () => ({}),
    getProtectionState: () => 'UNPROTECTED',
    getPositionSource: () => 'MANUAL',
    setProtectionState: () => {}
  };
  const binance = {
    tickSize: () => 0.000001,
    stepSize: () => 1,
    roundPrice: (_s, price, mode) => Number((mode === 'ceil' ? Math.ceil(price / 0.000001 - 1e-12) : Math.floor(price / 0.000001 + 1e-12)) * 0.000001),
    fetchPositions: async () => { fetchPositionCalls++; return [{ ...freshPosition }]; },
    fetchOpenAlgoOrders: async () => orders.map(x => ({ ...x })),
    createProtectionOrder: async (payload) => {
      const algoId = ++nextId;
      const order = {
        symbol: payload.symbol,
        positionSide: payload.positionSide,
        side: payload.side,
        orderType: payload.type,
        triggerPrice: payload.triggerPrice,
        algoId,
        algoStatus: 'WORKING',
        clientAlgoId: payload.clientAlgoId,
        closePosition: true,
        priceProtect: payload.priceProtect
      };
      orders.push(order); created.push(payload); return order;
    },
    replaceProtectionOrder: async (payload) => {
      orders = orders.filter(x => String(x.algoId) !== String(payload.existingAlgoId));
      const algoId = ++nextId;
      const order = {
        symbol: payload.symbol,
        positionSide: payload.positionSide,
        side: payload.side,
        orderType: payload.type,
        triggerPrice: payload.triggerPrice,
        algoId,
        algoStatus: 'WORKING',
        clientAlgoId: payload.clientAlgoId,
        closePosition: true,
        priceProtect: payload.priceProtect
      };
      orders.push(order); created.push(payload); canceled.push(String(payload.existingAlgoId)); return order;
    },
    cancelAlgoOrder: async (_symbol, algoId) => {
      canceled.push(String(algoId));
      orders = orders.filter(x => String(x.algoId) !== String(algoId));
      return { ok: true };
    },
    fetchAccountEquity: async () => 100
  };
  const emergency = { closePositionMarket: async p => { emergencyCalls.push({ ...p }); } };
  const pm = new ProtectionManager({ binance, state, config: cfg({ closeOnImmediateTarget: closeOnImmediate }), emergency, userStream: null });
  return { pm, get orders() { return orders; }, created, canceled, get fetchPositionCalls() { return fetchPositionCalls; }, emergencyCalls };
}

function slOrder(price, extra = {}) {
  return { symbol: '4USDT', positionSide: 'SHORT', side: 'BUY', orderType: 'STOP_MARKET', triggerPrice: price, algoId: 101, algoStatus: 'WORKING', clientAlgoId: 'MANUAL_SL', closePosition: true, ...extra };
}
function tpOrder(price, extra = {}) {
  return { symbol: '4USDT', positionSide: 'SHORT', side: 'BUY', orderType: 'TAKE_PROFIT_MARKET', triggerPrice: price, algoId: 202, algoStatus: 'WORKING', clientAlgoId: 'MANUAL_TP', closePosition: true, ...extra };
}

test('更严格 SL 判定：LONG 更高更严格、SHORT 更低更严格', () => {
  const { pm } = build();
  assert.equal(pm.isStricterSL(basePos({ side: 'long', positionSide: 'LONG' }), 99, 98), true);
  assert.equal(pm.isStricterSL(basePos(), 0.02515, 0.02529), true);
  assert.equal(pm.isStricterSL(basePos(), 0.02535, 0.02529), false);
});

test('系统目标优先：更宽的手动 SL 会被系统目标替换并清理', async () => {
  const expectedSL = 0.02529; // 20x / 20% margin risk，经 tickSize 取整
  const expectedTP = 0.024538;
  const widerManual = slOrder(0.02535);
  const exactTP = tpOrder(expectedTP);
  const ctx = build({ initialOrders: [widerManual, exactTP] });
  const result = await ctx.pm.protect(basePos());
  assert.equal(result.ok, true);
  const sl = ctx.orders.find(o => o.orderType === 'STOP_MARKET');
  const tp = ctx.orders.find(o => o.orderType === 'TAKE_PROFIT_MARKET');
  assert.equal(sl.triggerPrice, expectedSL);
  assert.equal(tp.triggerPrice, expectedTP);
  assert.ok(ctx.canceled.includes(String(widerManual.algoId)));
  assert.equal(ctx.created.filter(x => x.type === 'STOP_MARKET').length, 1);
});

test('更严格的手动 SL 可以保留，但 TP 仍必须执行系统目标', async () => {
  const stricterManual = slOrder(0.02515);
  const wrongTP = tpOrder(0.02400);
  const ctx = build({ initialOrders: [stricterManual, wrongTP] });
  const result = await ctx.pm.protect(basePos());
  assert.equal(result.ok, true);
  const sl = ctx.orders.find(o => o.orderType === 'STOP_MARKET');
  const tp = ctx.orders.find(o => o.orderType === 'TAKE_PROFIT_MARKET');
  assert.equal(sl.algoId, stricterManual.algoId);
  assert.equal(sl.triggerPrice, stricterManual.triggerPrice);
  assert.ok(Math.abs(Number(tp.triggerPrice) - 0.024538) < 1e-12);
  assert.ok(ctx.canceled.includes(String(wrongTP.algoId)));
  assert.ok(ctx.created.some(x => x.type === 'TAKE_PROFIT_MARKET' && Math.abs(Number(x.triggerPrice) - 0.024538) < 1e-12));
});

test('已有错误 TP 不能被误当成系统目标，必须创建并确认正确 TP', async () => {
  const ctx = build({ initialOrders: [tpOrder(0.024)] });
  const result = await ctx.pm.protect(basePos());
  assert.equal(result.ok, true);
  assert.equal(ctx.orders.filter(o => o.orderType === 'TAKE_PROFIT_MARKET').length, 1);
  assert.ok(Math.abs(Number(ctx.orders.find(o => o.orderType === 'TAKE_PROFIT_MARKET').triggerPrice) - 0.024538) < 1e-12);
});
test('已有更严格 TP 不应重复创建，避免 Binance -4130', async () => {
  const stricter = tpOrder(0.02490); // SHORT：越高越早止盈，属于更严格保护
  const ctx = build({ initialOrders: [stricter] });
  const result = await ctx.pm.protect(basePos());
  assert.equal(result.ok, true);
  assert.equal(ctx.created.filter(o => o.type === 'TAKE_PROFIT_MARKET').length, 0);
  assert.equal(ctx.orders.find(o => o.orderType === 'TAKE_PROFIT_MARKET').algoId, stricter.algoId);
});

test('已有较宽 TP 时必须走安全替换路径，而不是直接重复 POST 导致 -4130', async () => {
  const wider = tpOrder(0.02400);
  const ctx = build({ initialOrders: [wider] });
  const result = await ctx.pm.protect(basePos());
  assert.equal(result.ok, true);
  const tp = ctx.orders.find(o => o.orderType === 'TAKE_PROFIT_MARKET');
  assert.ok(tp);
  assert.ok(Math.abs(Number(tp.triggerPrice) - 0.024538) < 1e-12);
  assert.ok(ctx.canceled.includes(String(wider.algoId)));
});

test('TP 安全替换会标记旧 Algo 为内部撤单，避免撤单回推再次自激', async () => {
  const wider = tpOrder(0.02400);
  const ctx = build({ initialOrders: [wider] });
  await ctx.pm.protect(basePos());
  assert.equal(ctx.pm.isInternalAlgoCancel(wider.algoId), true);
});


test('目标已经被当前 Mark 穿越时，禁止留下裸仓并使用最新仓位执行保护性平仓', async () => {
  const ctx = build({
    freshPosition: basePos({ markPrice: 0.02540 }),
    closeOnImmediate: true
  });
  await assert.rejects(() => ctx.pm.protect(basePos({ markPrice: 0.025019 })), /止损目标已被当前标记价穿越/);
  assert.ok(ctx.fetchPositionCalls >= 2); // 初始保护刷新 + 保护性平仓前再次刷新
  assert.equal(ctx.emergencyCalls.length, 1);
  assert.equal(ctx.emergencyCalls[0].contracts, 203);
});

test('诊断在 Binance 尚未确认 SL/TP 时也能给出理论止损/止盈后的预计权益', async () => {
  const ctx = build();
  const d = await ctx.pm.diagnostics(basePos());
  assert.equal(d.accountEquity, 100);
  assert.ok(d.equityAfterSL != null);
  assert.ok(d.equityAfterTP != null);
  assert.equal(d.positionReturnPct, 0);
  assert.equal(d.actualSL, null);
  assert.equal(d.actualTP, null);
});

test('实时 Binance TP 与系统目标不一致时，诊断不能宣称完整保护', async () => {
  const ctx = build({ initialOrders: [slOrder(0.02529), tpOrder(0.02400)] });
  const d = await ctx.pm.diagnostics(basePos());
  assert.equal(d.actualSL, 0.02529);
  assert.equal(d.actualTP, 0.024);
  assert.equal(d.tpMatchesTarget, false);
  assert.notEqual(d.protectionState, 'PROTECTED');
});


test('盈利达到阈值后进入 TRAILING 状态并保留固定 TP，同时撤掉程序创建的固定 SL', async () => {
  const ctx = build({
    freshPosition: basePos({ markPrice: 0.02470 }),
  });
  const originalGet = ctx.pm.config.get;
  ctx.pm.config.get = () => ({
    autoProtection: true,
    protection: {
      ...originalGet().protection,
      trailingEnabled: true,
      trailingActivationPct: 1,
      trailingCallbackPct: 1,
    },
    ai: { closeOnProtectionFailure: true },
  });
  ctx.pm.binance.createTrailingOrder = async payload => {
    const order = {
      symbol: payload.symbol,
      positionSide: payload.positionSide,
      side: payload.side,
      orderType: 'TRAILING_STOP_MARKET',
      algoId: 777001,
      algoStatus: 'NEW',
      ia: true,
      activatePrice: payload.activationPrice,
      callbackRate: payload.callbackRate,
      quantity: payload.quantity,
      clientAlgoId: payload.clientAlgoId,
      closePosition: undefined,
    };
    // 直接写入同一测试订单池，模拟 Binance 已返回“已激活”的原生 Trailing。
    ctx.__trailingOrder = order;
    return order;
  };
  const originalFetch = ctx.pm.binance.fetchOpenAlgoOrders;
  ctx.pm.binance.fetchOpenAlgoOrders = async symbol => {
    const rows = await originalFetch(symbol);
    if (ctx.__trailingOrder) rows.push({ ...ctx.__trailingOrder });
    return rows;
  };

  const result = await ctx.pm.protect(basePos({ markPrice: 0.02470 }));
  assert.equal(result.ok, true);
  assert.equal(result.state, 'TRAILING');
  assert.equal(ctx.orders.some(o => o.orderType === 'TAKE_PROFIT_MARKET'), true);
  assert.equal(ctx.canceled.some(id => id === '9001'), true, '程序创建的固定 SL 应在 Trailing 激活后撤掉');
  assert.equal(result.orders.trailing != null, true);
  assert.equal(result.orders.tp != null, true, '固定 TP 继续保留');
});

test('Trailing 开关开启但未达到盈利阈值时，固定保护路径完整且不发生运行时错误', async () => {
  const ctx = build({
    freshPosition: basePos({ markPrice: 0.025019 }),
  });
  const originalGet = ctx.pm.config.get;
  // 通过替换配置读取开启 trailing，仅验证未达到激活条件时不会进入未定义变量路径。
  ctx.pm.config.get = () => ({
    autoProtection: true,
    protection: {
      ...originalGet().protection,
      trailingEnabled: true,
      trailingActivationPct: 1,
      trailingCallbackPct: 1,
    },
    ai: { closeOnProtectionFailure: true },
  });
  const result = await ctx.pm.protect(basePos());
  assert.equal(result.ok, true);
  assert.equal(ctx.orders.some(o => o.orderType === 'STOP_MARKET'), true);
  assert.equal(ctx.orders.some(o => o.orderType === 'TAKE_PROFIT_MARKET'), true);
});

test('自动保护抛出的原始错误对象会统一标记 protectionLogged 与保护阶段，外层可可靠去重', async () => {
  const ctx = build({
    freshPosition: basePos({ markPrice: 0.02540 }),
    closeOnImmediate: false
  });
  let err = null;
  try {
    await ctx.pm.protect(basePos({ markPrice: 0.025019 }));
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.match(err.message, /止损目标已被当前标记价穿越/);
  assert.equal(err.protectionLogged, true);
  assert.equal(err.protectionStage, '计算 SL/TP');
  assert.equal(err.code, 'PROTECTION_TARGET_CROSSED');
});


test('TP 创建必须携带当前仓位 queueKey，诊断才能识别限频等待任务', async () => {
  const ctx = build({ initialOrders: [] });
  await ctx.pm.protect(basePos());
  const tpPayload = ctx.created.find(x => x.type === 'TAKE_PROFIT_MARKET');
  assert.ok(tpPayload);
  assert.equal(tpPayload.queueKey, '4USDT|SHORT');
  assert.equal(typeof tpPayload.queueGuard, 'function');
});
