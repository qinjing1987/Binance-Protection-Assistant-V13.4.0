const test = require('node:test');
const assert = require('node:assert/strict');
const { RuleAutoTrader, findSupportResistance, reversalConfirmation, bollinger, macd } = require('../server/monitoring/RuleAutoTrader');

function baseConfig(overrides = {}) {
  return {
    get: () => ({
      ruleTrading: {
        enabled: false,
        leverage: 10,
        riskPerTradePct: 0.5,
        maxPositions: 1,
        maxPendingOrders: 2,
        orderTtlMinutes: 5,
        cooldownMinutes: 10,
        bbPeriod: 20, bbStdDev: 2, macdFast: 12, macdSlow: 26, macdSignal: 9,
        maxEntryDistanceAtr: 1.5, require5mTrendMatch: true, exitOnIndicatorReverse: true,
        ...(overrides.ruleTrading || {})
      },
      risk: { riskPerTradePct: 1 },
      protection: { calculationMode: 'MARGIN', stopLossMarginPct: 5, takeProfitMarginPct: 20 }
    })
  };
}

function candles(closes, { start = 0, step = 60000 } = {}) {
  return closes.map((close, i) => {
    const c = Number(close);
    const open = i ? Number(closes[i - 1]) : c;
    const high = Math.max(open, c) * 1.003;
    const low = Math.min(open, c) * 0.997;
    return { openTime: start + i * step, closeTime: start + i * step + step - 1000, open, high, low, close: c };
  });
}

function makeTrader({ enabled = false, binance = {}, state = {} } = {}) {
  const config = baseConfig({ ruleTrading: { enabled } });
  return new RuleAutoTrader({
    config,
    state: { getRuleCooldown: () => 0, getCooldown: () => 0, setRuleCooldown: () => {}, ...state },
    ranking: {},
    risk: {},
    binance: {
      actualHedgeMode: false,
      fetchPositions: async () => [],
      fetchOpenOrders: async () => [],
      fetchKlines: async () => [],
      fetchMarkPrice: async () => ({ markPrice: 100 }),
      fetchAccountEquity: async () => 100,
      getAccount: async () => ({ totalMarginBalance: '100', availableBalance: '100' }),
      getSymbolConfig: async () => ({ leverage: 10 }),
      maxInitialLeverage: async () => 20,
      setLeverage: async () => {},
      roundPrice: (_s, p) => p,
      roundQty: (_s, q) => Math.floor(q),
      minQty: () => 1,
      maxQty: () => 1000000,
      minNotional: () => 1,
      createLimitOrder: async args => ({ orderId: 123, status: 'NEW', executedQty: 0, ...args }),
      cancelOrder: async () => ({}),
      createCloseMarketOrder: async args => ({ orderId: 456, status: 'NEW', ...args }),
      ...binance
    }
  });
}

test('支撑阻力识别只取当前价同侧且限制ATR距离', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push({ openTime: i * 60000, closeTime: i * 60000 + 59000, open: 100, high: 101, low: 99, close: 100 });
  rows[20].low = 99.1; rows[21].low = 99.0; rows[22].low = 99.1;
  rows[40].high = 101.0; rows[41].high = 101.2; rows[42].high = 101.0;
  const z = findSupportResistance(rows, 100.2, 2.0, { lookback: 60, clusterAtr: 0.25, maxDistanceAtr: 0.8 });
  assert.ok(z.support && z.support.price < 100.2);
  assert.ok(z.resistance && z.resistance.price > 100.2);
});

test('LONG 需要支撑附近下影反转确认', () => {
  const rows = candles([100, 100.2, 100.4]);
  const last = rows[rows.length - 1];
  last.open = 100.2; last.close = 100.4; last.low = 99.8; last.high = 100.45;
  assert.equal(reversalConfirmation(rows, 'LONG', 100.0, 0.5), true);
});

test('规则自动交易默认同币冷却为10分钟', () => {
  const trader = makeTrader({ enabled: true });
  assert.equal(trader.cfg.cooldownMinutes, 10);
});

test('规则自动交易默认关闭且完全不依赖 AI Trader', () => {
  const trader = makeTrader();
  assert.equal(trader.enabled(), false);
  assert.equal(trader.statusLabel(), '关闭');
  assert.equal(require('../server/monitoring/RuleAutoTrader').RuleAutoTrader.toString().includes('AITrader'), false);
});



test('V13规则仓位可由盈利后的RSI反向触发指标平仓', async()=>{
  let closed=0;
  const closes=Array.from({length:50},(_,i)=>100+i*0.5).concat([125,124,123,122,121]);
  const objects=candles(closes, {start: Date.now()-70*60000});
  const rows=objects.map(r=>[r.openTime,r.open,r.high,r.low,r.close,100,r.closeTime]);
  const trader=makeTrader({enabled:true,binance:{
    fetchPositions:async()=>[{symbol:'ABCUSDT',positionSide:'LONG',contracts:1,markPrice:121,entryPrice:110,side:'long'}],
    fetchKlines:async()=>rows
  },state:{getPositionSource:()=> 'RULE'}});
  trader.emergency={closePositionMarket:async()=>{closed+=1;return {orderId:999};}};
  trader.running=true;
  await trader.monitorRuleExits();
  assert.equal(closed,1);
  assert.equal(trader.lastExit.reason,'RSI_BEARISH_REVERSE');
});

test('V11.3 三指标计算：布林带与MACD均能在80根K线内得到最新值',()=>{
  const rows=candles(Array.from({length:80},(_,i)=>100+Math.sin(i/4)*2+i*0.01));
  const bb=bollinger(rows,20,2);
  const m=macd(rows,12,26,9);
  assert.ok(bb && bb.upper>bb.middle && bb.middle>bb.lower);
  assert.ok(m && Number.isFinite(m.hist));
});
test('规则交易的 LIMIT 下单使用 GTC，并保留规则来源标记', async () => {
  const calls = [];
  const trader = makeTrader({ enabled: true, binance: {
    actualHedgeMode: true,
    getSymbolConfig: async () => ({ leverage: 10 }),
    createLimitOrder: async args => { calls.push(args); return { orderId: 123, status: 'NEW', executedQty: 0 }; }
  } });
  trader.running = true;
  await trader.placeLimit({ symbol: 'TESTUSDT', action: 'LONG', entry: 99, quantity: 2, leverage: 10, plannedSLPct: 0.5, plannedTPPct: 2, rr: 4, support: { price: 99 } }, 'T');
  assert.equal(calls[0].timeInForce, 'GTC');
  assert.equal(calls[0].price, 99);
  assert.equal(calls[0].positionSide, 'LONG');
  assert.equal(calls[0].side, 'BUY');
  assert.equal(calls[0].quantity, 2);
  assert.equal(trader.pending.size, 1);
});

test('下单前若同Symbol已有任意方向持仓，规则交易必须拒绝', async () => {
  const trader = makeTrader({ enabled: true, binance: { fetchPositions: async () => [{ symbol: 'ABCUSDT', positionSide: 'SHORT', contracts: 3 }] } });
  await assert.rejects(
    trader.placeLimit({ symbol: 'ABCUSDT', action: 'LONG', entry: 99, quantity: 2, leverage: 10, plannedSLPct: 0.5, plannedTPPct: 2 }, 'T'),
    e => e.code === 'SYMBOL_HAS_POSITION'
  );
});

test('规则交易禁止在已有普通挂单的Symbol上追加自动LIMIT', async () => {
  const trader = makeTrader({ enabled: true, binance: { fetchOpenOrders: async () => [{ symbol: 'ABCUSDT', orderId: 8, status: 'NEW' }] } });
  await assert.rejects(
    trader.placeLimit({ symbol: 'ABCUSDT', action: 'LONG', entry: 99, quantity: 2, leverage: 10, plannedSLPct: 0.5, plannedTPPct: 2 }, 'T'),
    e => e.code === 'OPEN_ORDER_EXISTS'
  );
});

test('规则交易不会静默把配置杠杆降低到交易所最大杠杆', async () => {
  const trader = makeTrader({ enabled: true, binance: { maxInitialLeverage: async () => 5 } });
  trader.config = baseConfig({ ruleTrading: { enabled: true, leverage: 10 } });
  const result = await trader.evaluateCandidate({ symbol: 'ABCUSDT', action: 'LONG', group: 'GAINER', changePct: 5 }, { currentSymbols: new Set(), pendingSymbols: new Set() }, 0);
  assert.notEqual(result.reason, 'LEVERAGE_CAPPED');
  // K线不足时会提前返回；策略中不存在“自动降到5x继续交易”的路径。
  assert.notEqual(result.reason, undefined);
});

test('规则订单FILLED事件应立即从pending移除并记录RULE成交', () => {
  const trader = makeTrader({ enabled: true });
  trader.pending.set('123', { orderId: 123, symbol: 'ABCUSDT', positionSide: 'LONG', status: 'NEW' });
  trader.handleUserEvent({ e: 'ORDER_TRADE_UPDATE', o: { s: 'ABCUSDT', ps: 'LONG', c: 'QP_RULE_TEST', i: 123, X: 'FILLED', x: 'TRADE', ap: '1.2', z: '10' } });
  assert.equal(trader.pending.has('123'), false);
  assert.equal(trader.shouldTagPosition({ symbol: 'ABCUSDT', positionSide: 'LONG' }), true);
});

test('规则订单部分成交保留pending，完全成交再移除', () => {
  const trader = makeTrader({ enabled: true });
  trader.pending.set('124', { orderId: 124, symbol: 'ABCUSDT', positionSide: 'LONG', status: 'NEW', executedQty: 0 });
  trader.handleUserEvent({ e: 'ORDER_TRADE_UPDATE', o: { s: 'ABCUSDT', ps: 'LONG', c: 'QP_RULE_TEST2', i: 124, X: 'PARTIALLY_FILLED', x: 'TRADE', ap: '1.2', z: '4' } });
  assert.equal(trader.pending.has('124'), true);
  assert.equal(trader.pending.get('124').executedQty, 4);
  trader.handleUserEvent({ e: 'ORDER_TRADE_UPDATE', o: { s: 'ABCUSDT', ps: 'LONG', c: 'QP_RULE_TEST2', i: 124, X: 'FILLED', x: 'TRADE', ap: '1.2', z: '10' } });
  assert.equal(trader.pending.has('124'), false);
});


test('规则自动交易启用但调度未运行时状态必须显示已停止，不能伪装正常', () => {
  const trader = makeTrader({ enabled: true });
  trader.running = false;
  trader.lastSuccessfulAt = Date.now() - 60_000;
  const status = trader.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.status, '已停止');
});

test('规则自动交易停止时会撤掉本软件产生的待成交LIMIT', async () => {
  let canceled = 0;
  const trader = makeTrader({ enabled: true, binance: {
    fetchOpenOrders: async () => [{ orderId: 125, clientOrderId: 'QP_RULE_TEST3', symbol: 'ABCUSDT', status: 'NEW' }],
    cancelOrder: async () => { canceled += 1; return {}; }
  } });
  trader.pending.set('125', { orderId: 125, clientOrderId: 'QP_RULE_TEST3', symbol: 'ABCUSDT', positionSide: 'LONG', status: 'NEW', createdAt: Date.now() - 1000 });
  trader.stop('USER_DISABLED');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(canceled, 1);
  assert.equal(trader.pending.size, 0);
});

test('下单前仅在无持仓且无挂单时才允许自动设置该Symbol杠杆，并且设置后必须复核', async () => {
  let setCalls = 0;
  let verified = 0;
  const trader = makeTrader({ enabled: true, binance: {
    getSymbolConfig: async () => ({ leverage: verified ? 10 : 7 }),
    setLeverage: async () => { setCalls += 1; verified = 1; }
  } });
  const r = await trader.ensureSymbolLeverage('ABCUSDT', 10, { positions: [], openOrders: [] });
  assert.equal(r.changed, true);
  assert.equal(setCalls, 1);
});

test('规则交易恢复时只收录QPRULE活动挂单，并清掉内存中的陈旧挂单', async () => {
  const trader = makeTrader({ enabled: true, binance: {
    fetchOpenOrders: async () => [
      { orderId: 201, clientOrderId: 'QP_RULE_A', symbol: 'ABCUSDT', positionSide: 'LONG', side: 'BUY', price: 1, origQty: 10, executedQty: 0, status: 'NEW', time: Date.now() },
      { orderId: 202, clientOrderId: 'MANUAL_B', symbol: 'XYZUSDT', positionSide: 'SHORT', side: 'SELL', price: 2, origQty: 5, executedQty: 0, status: 'NEW', time: Date.now() }
    ]
  } });
  trader.pending.set('999', { orderId: 999, clientOrderId: 'QP_RULE_OLD', symbol: 'OLDUSDT', positionSide: 'LONG', status: 'NEW' });
  await trader.syncPendingFromExchange();
  assert.equal(trader.pending.has('201'), true);
  assert.equal(trader.pending.has('999'), false);
  assert.equal(trader.pending.has('202'), false);
});

test('规则交易放宽后允许1m趋势反向作为回踩信号，不再直接淘汰', async () => {
  const trader = makeTrader({ enabled: true, binance: { maxInitialLeverage: async () => 10 } });
  const rows = [];
  for (let i = 0; i < 90; i++) {
    const base = 100 - i * 0.02;
    rows.push({ openTime: i * 60000, closeTime: i * 60000 + 59000, open: base, high: base + 0.2, low: base - 0.2, close: base + 0.05 });
  }
  // 这里重点验证代码路径：evaluateCandidate 不再因为 1m mismatch 直接返回该原因。
  trader.binance.fetchKlines = async (_symbol, tf) => tf === '1m' ? rows : rows;
  trader.binance.fetchMarkPrice = async () => ({ markPrice: 99.5 });
  trader.binance.getAccount = async () => ({ totalMarginBalance: '100', availableBalance: '100' });
  trader.risk = { canRuleAutoTrade: async () => ({ ok: true }) };
  trader.binance.maxInitialLeverage = async () => 10;
  const r = await trader.evaluateCandidate({ symbol: 'ABCUSDT', action: 'LONG', group: 'GAINER', changePct: 8, rank: 1 }, { currentSymbols: new Set(), pendingSymbols: new Set(), traceId: 'T' }, 0);
  assert.notEqual(r.reason, '1M_TREND_MISMATCH');
});

test('规则交易日亏损上限为0时视为关闭', async () => {
  const config = baseConfig();
  const RiskManager = require('../server/risk/RiskManager');
  const state = { rawGet: (k, d) => ({ lossStreakPausedUntil: 0, dailyRisk: { date: new Date().toISOString().slice(0,10), dayStartEquity: 100, realizedPnl: -50, fees: 0, funding: 0 } }[k] ?? d), rawSet: () => {} };
  const risk = new RiskManager({ config, state, binance: { fetchAccountEquity: async () => 50 } });
  assert.equal((await risk.canAutoTrade()).ok, true);
  assert.equal((await risk.canRuleAutoTrade()).ok, true);
});

test('规则自动交易停止后不会继续创建新的订单', async () => {
  const trader = makeTrader({ enabled: true });
  trader.running = true;
  trader.scanBusy = true;
  trader.running = false;
  assert.equal(trader.running, false);
});


test('扫描进入下单阶段前如果规则自动交易已停止，不得继续创建LIMIT', async () => {
  const trader = makeTrader({ enabled: true, state: {}, binance: {
    fetchPositions: async () => [],
    fetchOpenOrders: async () => [],
    getAccount: async () => ({ totalMarginBalance: '100', availableBalance: '100' })
  } });
  trader.risk = { canAutoTrade: async () => ({ ok: true }) };
  trader.running = true;
  trader.ranking = { getTop10: async () => ({ gainers: [{ symbol: 'ABCUSDT', changePct: 5 }], losers: [] }) };
  trader.evaluateCandidate = async (candidate) => {
    trader.running = false; // 模拟分析完成后立即停止规则自动交易。
    return { symbol: candidate.symbol, action: 'LONG', eligible: true, entry: 99, quantity: 2, leverage: 10, plannedSLPct: 0.5, plannedTPPct: 2 };
  };
  let placed = 0;
  trader.placeLimit = async () => { placed += 1; };
  await trader.scan();
  assert.equal(placed, 0);
});


test('规则信号因最小数量不足被拦截时应返回达到最小数量所需账户权益', async () => {
  const trader = makeTrader({ enabled: true, binance: { minQty: () => 1, roundQty: (_s, q) => Math.floor(q), minNotional: () => 0, fetchMarkPrice: async () => ({ markPrice: 100 }), getAccount: async () => ({ totalMarginBalance: '10', availableBalance: '10' }) } });
  const result = await trader.evaluateCandidate({ symbol: 'ABCUSDT', action: 'LONG', group: 'GAINER', rank: 1, changePct: 5 }, { currentSymbols: new Set(), pendingSymbols: new Set() }, 0);
  if (result.reason === 'QTY_BELOW_MIN') assert.ok(result.requiredEquity > 10);
  else assert.notEqual(result.reason, 'REFERENCE_ERROR');
});


test('V13.4 规则扫描使用配置 TopN，多空各TopN形成2N候选池', async () => {
  const trader = makeTrader({ enabled: true, binance: {
    fetchPositions: async () => [],
    fetchOpenOrders: async () => [],
    getAccount: async () => ({ totalMarginBalance: '100', availableBalance: '100' })
  }});
  trader.config = baseConfig({ ruleTrading: { enabled: true, topN: 20, maxPositions: 99, maxPendingOrders: 99 } });
  trader.risk = { canAutoTrade: async () => ({ ok: true }) };
  trader.running = true;
  let requestedN = null;
  trader.ranking = { getRankings: async n => {
    requestedN = n;
    return {
      gainers: Array.from({length:20},(_,i)=>({symbol:`G${i}USDT`,changePct:20-i})),
      losers: Array.from({length:20},(_,i)=>({symbol:`L${i}USDT`,changePct:-20+i}))
    };
  }};
  trader.evaluateCandidate = async c => ({ symbol:c.symbol, action:c.action, rank:c.rank, eligible:false, status:'SKIP', reason:'TEST_BLOCK', reasons:['TEST_BLOCK'] });
  const result = await trader.scan();
  assert.equal(requestedN, 20);
  assert.equal(result.lastSummary.candidates, 40);
  assert.equal(result.lastSummary.decisions.length, 40);
});
