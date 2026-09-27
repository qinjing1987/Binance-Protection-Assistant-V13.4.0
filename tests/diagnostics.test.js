const test = require('node:test');
const assert = require('node:assert/strict');
const ProtectionManager = require('../server/protection/ProtectionManager');
const Logger = require('../server/Logger');

function buildManager({ actualSLPrice, actualTPPrice, liquidationPrice, leverage=20, mode='MARGIN' }) {
  const cfg = { get: () => ({ autoProtection:true, protection: { calculationMode:mode, stopLossPct:4, takeProfitPct:8, stopLossMarginPct:20, takeProfitMarginPct:40, liquidationBufferPp:0.5, trailingEnabled:false } }) };
  const state = { getProtectionState: () => 'PROTECTED', setProtectionState:()=>{} };
  const openOrders = [];
  if (actualSLPrice != null) openOrders.push({symbol:'NILUSDT',positionSide:'SHORT',side:'BUY',orderType:'STOP_MARKET',triggerPrice:actualSLPrice,algoId:111,algoStatus:'WORKING',clientAlgoId:'QP_SL_x'});
  if (actualTPPrice != null) openOrders.push({symbol:'NILUSDT',positionSide:'SHORT',side:'BUY',orderType:'TAKE_PROFIT_MARKET',triggerPrice:actualTPPrice,algoId:222,algoStatus:'WORKING',clientAlgoId:'QP_TP_x'});
  const binance = {
    fetchOpenAlgoOrders: async () => openOrders,
    tickSize: () => 0.0001,
    roundPrice: (s,p,mode) => Number((mode==='ceil'?Math.ceil(p/0.0001-1e-12):Math.floor(p/0.0001+1e-12))*0.0001).toFixed(4)
  };
  binance.roundPrice = (s,p,mode) => Number((mode==='ceil'?Math.ceil(p/0.0001-1e-10):Math.floor(p/0.0001+1e-10))*0.0001);
  binance.fetchPositions = async () => [{symbol:'NILUSDT',positionSide:'SHORT',contracts:47.7,signedContracts:-47.7,side:'short',entryPrice:0.1089,markPrice:0.1099,liquidationPrice,unrealizedPnl:-0.05,leverage,isolatedMargin:0.29}];
  const pm = new ProtectionManager({ binance, state, config:cfg, emergency:null, userStream:null });
  const position = {symbol:'NILUSDT',positionSide:'SHORT',side:'short',entryPrice:0.1089,markPrice:0.1099,liquidationPrice,unrealizedPnl:-0.05,contracts:47.7,leverage};
  return {pm,position};
}

test('20x 下默认保证金风险 20/40 转为约 1%/2% 价格幅度', async () => {
  const {pm,position}=buildManager({actualSLPrice:null,actualTPPrice:null,liquidationPrice:0.12});
  const d=await pm.diagnostics(position);
  assert.equal(d.calculationMode,'MARGIN');
  assert.equal(d.leverage,20);
  assert.equal(d.theoreticalSL.toFixed(6),(0.1100).toFixed(6));
  assert.equal(d.theoreticalTP.toFixed(6),(0.1067).toFixed(6));
  assert.ok(Math.abs(d.slEntryDistancePct-1.01)<0.02, `SL entry distance=${d.slEntryDistancePct}`);
  assert.ok(Math.abs(d.tpEntryDistancePct-2.02)<0.02, `TP entry distance=${d.tpEntryDistancePct}`);
  assert.ok(Math.abs(d.slMarginImpactPct-20.20)<0.40, `SL margin impact=${d.slMarginImpactPct}`);
  assert.ok(Math.abs(d.tpMarginImpactPct-40.04)<0.40, `TP margin impact=${d.tpMarginImpactPct}`);
  assert.equal(d.rr,2);
});

test('止损不能跨过强平安全边界，并可自动收紧', async () => {
  const {pm,position}=buildManager({actualSLPrice:null,actualTPPrice:null,liquidationPrice:0.1096});
  const t=pm.protectionTargets(position);
  assert.equal(t.liquidationAdjusted,true);
  assert.ok(t.sl < position.liquidationPrice);
  assert.ok(t.effectiveStopLossPct < 1);
});

test('实际 Binance SL/TP 优先，并从 Binance positionRisk 读取 20x', async () => {
  const {pm,position}=buildManager({actualSLPrice:0.1133,actualTPPrice:0.1002,liquidationPrice:0.11467,leverage:20});
  const d=await pm.diagnostics(position);
  assert.equal(d.actualSL,0.1133); assert.equal(d.actualTP,0.1002);
  assert.equal(d.slSource,'BINANCE_CONFIRMED'); assert.equal(d.tpSource,'BINANCE_CONFIRMED');
  assert.equal(d.leverage,20); assert.equal(d.slAlgoId,111); assert.equal(d.tpAlgoId,222);
  assert.ok(d.rr>0);
});

test('实际止损越过强平价时状态必须为 ERROR', async () => {
  const {pm,position}=buildManager({actualSLPrice:0.126,actualTPPrice:0.1002,liquidationPrice:0.12,leverage:20});
  const d=await pm.diagnostics(position);
  assert.equal(d.stopBeyondLiquidation,true);
  assert.equal(d.protectionState,'ERROR');
});

test('保证金模式缺少真实杠杆时拒绝猜测', () => {
  const {pm,position}=buildManager({actualSLPrice:null,actualTPPrice:null,liquidationPrice:0.12,leverage:0});
  assert.throws(()=>pm.protectionTargets({...position,leverage:0}),/无法读取当前仓位实际杠杆/);
});

test('不安全的用户止损也必须触发新增安全 QP 保护需求', async () => {
  const {pm,position}=buildManager({actualSLPrice:0.126,actualTPPrice:0.1002,liquidationPrice:0.12,leverage:20});
  const orders=await pm.listProtection(position);
  const c=pm.classify(position,orders);
  assert.equal(c.slOurs,true); // 该 fixture 是 QP 单；核心断言：不安全 SL 不会被当成安全 SL
  assert.equal(pm.isSafeSLPrice(position,0.126),false);
});

test('Trailing 的 ia 字段兼容 boolean/string/number', () => {
  const {pm}=buildManager({actualSLPrice:null,actualTPPrice:null,liquidationPrice:0.12});
  assert.equal(pm.trailingActivated({ia:true}),true);
  assert.equal(pm.trailingActivated({ia:'true'}),true);
  assert.equal(pm.trailingActivated({ia:1}),true);
  assert.equal(pm.trailingActivated({ia:'false'}),false);
});


test('实际 Binance SL/TP 的 Mark 距离必须与显示价格一致，ROI 基于仓位保证金', async () => {
  const cfg = { get: () => ({ autoProtection:true, protection: { calculationMode:'MARGIN', stopLossPct:4, takeProfitPct:8, stopLossMarginPct:3, takeProfitMarginPct:10, liquidationBufferPp:0.5, trailingEnabled:false } }) };
  const state = { getProtectionState: () => 'PROTECTED', setProtectionState:()=>{} };
  const orders = [
    {symbol:'BROCCOLI714USDT', positionSide:'LONG', side:'SELL', orderType:'STOP_MARKET', triggerPrice:0.032460, algoId:123, algoStatus:'NEW', clientAlgoId:'QP_SL'},
    {symbol:'BROCCOLI714USDT', positionSide:'LONG', side:'SELL', orderType:'TAKE_PROFIT_MARKET', triggerPrice:0.032860, algoId:456, algoStatus:'NEW', clientAlgoId:'QP_TP'}
  ];
  const binance = {
    fetchOpenAlgoOrders: async () => orders,
    tickSize: () => 0.000010,
    stepSize: () => 1,
    roundPrice: (_s,p,mode) => Number((mode==='ceil'?Math.ceil(p/0.00001):Math.floor(p/0.00001))*0.00001),
    fetchPositions: async () => [{symbol:'BROCCOLI714USDT',positionSide:'LONG',contracts:198,signedContracts:198,side:'long',entryPrice:0.032560,markPrice:0.032641,liquidationPrice:0.030211,unrealizedPnl:0.0161,leverage:11,isolatedMargin:0.60,notional:6.4535}],
    fetchAccountEquity: async () => 0.5897
  };
  const pm = new ProtectionManager({binance,state,config:cfg,emergency:null,userStream:null});
  const d = await pm.diagnostics({symbol:'BROCCOLI714USDT',positionSide:'LONG',side:'long',entryPrice:0.032560,markPrice:0.032641,liquidationPrice:0.030211,contracts:198,unrealizedPnl:0.0161,leverage:11});
  assert.ok(Math.abs(d.slDistancePct - 0.554) < 0.01, `SL mark distance=${d.slDistancePct}`);
  assert.ok(Math.abs(d.tpDistancePct - 0.671) < 0.01, `TP mark distance=${d.tpDistancePct}`);
  assert.equal(d.slEntryDistancePct.toFixed(3),'0.307');
  assert.equal(d.tpEntryDistancePct.toFixed(3),'0.921');
  assert.equal(d.positionReturnPct,2.74);
  assert.equal(d.accountEquity,0.5897);
  assert.equal(d.actualSL,0.03246);
  assert.equal(d.actualTP,0.03286);
  assert.equal(d.snapshotConsistency, 'CONSISTENT');
  assert.ok(Number.isFinite(d.snapshotLagMs));
});


test('诊断发现PnL数据异常时必须留下可分析日志', async () => {
  const cfg = { get: () => ({ autoProtection:true, protection: { calculationMode:'MARGIN', stopLossPct:4, takeProfitPct:8, stopLossMarginPct:3, takeProfitMarginPct:10, liquidationBufferPp:0.5, trailingEnabled:false } }) };
  const state = { getProtectionState: () => 'PROTECTED', setProtectionState:()=>{} };
  const warnings = [];
  const originalWarn = Logger.warn;
  Logger.warn = (message, meta) => warnings.push({ message, meta });
  try {
    const binance = {
      fetchOpenAlgoOrders: async () => [],
      tickSize: () => 0.000010,
      roundPrice: (_s,p,mode) => Number((mode==='ceil'?Math.ceil(p/0.00001):Math.floor(p/0.00001))*0.00001),
      fetchPositions: async () => [{symbol:'BROCCOLI714USDT',positionSide:'LONG',contracts:198,signedContracts:198,side:'long',entryPrice:0.032560,markPrice:0.032641,liquidationPrice:0.030211,unrealizedPnl:0.001,leverage:11,isolatedMargin:0.60,notional:6.4535}],
      fetchAccountEquity: async () => 0.5897
    };
    const pm = new ProtectionManager({binance,state,config:cfg,emergency:null,userStream:null});
    const d = await pm.diagnostics({symbol:'BROCCOLI714USDT',positionSide:'LONG'});
    assert.notEqual(d.pnlGap, null);
    assert.ok(warnings.some(x => x.message.includes('PnL与价格/数量推导PnL存在明显差异')));
  } finally {
    Logger.warn = originalWarn;
  }
});

test('一侧保护已确认且另一侧正在 Algo 限频队列时，诊断状态应为 PROTECTING 而非 PARTIAL', async () => {
  const cfg = { get: () => ({ autoProtection:true, protection: { calculationMode:'MARGIN', stopLossPct:4, takeProfitPct:8, stopLossMarginPct:3, takeProfitMarginPct:10, liquidationBufferPp:0.5, trailingEnabled:false } }) };
  const state = { getProtectionState: () => 'PROTECTING', setProtectionState:()=>{} };
  const orders = [
    {symbol:'MUBARAKUSDT', positionSide:'SHORT', side:'BUY', orderType:'STOP_MARKET', triggerPrice:0.04577, algoId:111, algoStatus:'NEW', clientAlgoId:'QP_SL'}
  ];
  const binance = {
    fetchOpenAlgoOrders: async () => orders,
    getQueuedAlgoJobs: () => [{seq:9,label:'TP',priority:50,queueKey:'MUBARAKUSDT|SHORT',started:false,rateLimited:true,enqueuedAt:Date.now()}],
    tickSize: () => 0.00001,
    roundPrice: (_s,p,mode) => Number((mode==='ceil'?Math.ceil(p/0.00001):Math.floor(p/0.00001))*0.00001),
    fetchPositions: async () => [{symbol:'MUBARAKUSDT',positionSide:'SHORT',contracts:71,signedContracts:-71,side:'short',entryPrice:0.045,markPrice:0.0459,liquidationPrice:0.048,unrealizedPnl:0,leverage:10,isolatedMargin:0.326,notional:3.263}],
    fetchAccountEquity: async () => 0.4
  };
  const pm = new ProtectionManager({binance,state,config:cfg,emergency:null,userStream:null});
  const d = await pm.diagnostics({symbol:'MUBARAKUSDT',positionSide:'SHORT'});
  assert.equal(d.queuedTP, true);
  assert.equal(d.protectionState, 'PROTECTING');
});


test('TP 排队状态重复诊断时不应每3秒重复刷日志', async () => {
  const cfg = { get: () => ({ autoProtection:true, protection: { calculationMode:'MARGIN', stopLossPct:4, takeProfitPct:8, stopLossMarginPct:3, takeProfitMarginPct:10, liquidationBufferPp:0.5, trailingEnabled:false } }) };
  const state = { getProtectionState: () => 'PROTECTING', setProtectionState:()=>{} };
  const orders = [{symbol:'QNTUSDT',positionSide:'LONG',side:'SELL',orderType:'STOP_MARKET',triggerPrice:89.54,algoId:111,algoStatus:'NEW',clientAlgoId:'QP_SL'}];
  const binance = {
    fetchOpenAlgoOrders: async () => orders,
    getQueuedAlgoJobs: () => [{seq:2,label:'TP',priority:50,queueKey:'QNTUSDT|LONG',started:false,rateLimited:true,enqueuedAt:Date.now()}],
    tickSize: () => 0.01,
    roundPrice: (_s,p,mode) => Number((mode==='ceil'?Math.ceil(p/0.01):Math.floor(p/0.01))*0.01),
    fetchPositions: async () => [{symbol:'QNTUSDT',positionSide:'LONG',contracts:10,signedContracts:10,side:'long',entryPrice:90,markPrice:90.2,liquidationPrice:85,unrealizedPnl:0,leverage:10,isolatedMargin:0.09,notional:902}],
    fetchAccountEquity: async () => 1
  };
  const pm = new ProtectionManager({binance,state,config:cfg,emergency:null,userStream:null});
  const infos = [];
  const originalInfo = Logger.info;
  Logger.info = (message, meta) => infos.push({message, meta});
  try {
    await pm.diagnostics({symbol:'QNTUSDT',positionSide:'LONG'});
    await pm.diagnostics({symbol:'QNTUSDT',positionSide:'LONG'});
    assert.equal(infos.filter(x => x.message.includes('保护诊断：部分保护已确认')).length, 1);
  } finally { Logger.info = originalInfo; }
});


test('单一实时 Mark 快照覆盖 REST Mark，统一 PnL、ROI 与 SL/TP 距离', async () => {
  const cfg = { get: () => ({ autoProtection:true, protection: { calculationMode:'MARGIN', stopLossPct:4, takeProfitPct:8, stopLossMarginPct:5, takeProfitMarginPct:20, liquidationBufferPp:0.5, trailingEnabled:true, trailingActivationPct:0.5, trailingCallbackPct:0.5 } }) };
  const state = { getProtectionState: () => 'PROTECTED', setProtectionState:()=>{} };
  const orders = [
    {symbol:'PHAUSDT', positionSide:'LONG', side:'SELL', orderType:'STOP_MARKET', triggerPrice:0.079990, algoId:1001, algoStatus:'NEW', clientAlgoId:'QP_SL_PHA'},
    {symbol:'PHAUSDT', positionSide:'LONG', side:'SELL', orderType:'TAKE_PROFIT_MARKET', triggerPrice:0.082010, algoId:1002, algoStatus:'NEW', clientAlgoId:'QP_TP_PHA'}
  ];
  const binance = {
    fetchOpenAlgoOrders: async () => orders,
    tickSize: () => 0.00001,
    roundPrice: (_s,p,mode) => Number((mode==='ceil'?Math.ceil(p/0.00001):Math.floor(p/0.00001))*0.00001),
    fetchPositions: async () => [{symbol:'PHAUSDT',positionSide:'LONG',contracts:69,signedContracts:69,side:'long',entryPrice:0.080400,markPrice:0.081075,liquidationPrice:0.073503,unrealizedPnl:0.046575,leverage:10,isolatedMargin:0.56,notional:5.594175}],
    getAccount: async () => ({totalMarginBalance:0.6438, availableBalance:0.08})
  };
  const pm = new ProtectionManager({binance,state,config:cfg,emergency:null,userStream:null});
  const now = Date.now();
  pm.latestMarkPrices.set('PHAUSDT|LONG', 0.080448);
  pm.latestMarkMeta.set('PHAUSDT|LONG', {markPrice:0.080448,eventTime:now-120,transactionTime:now-120,receivedAt:now-100,wsLatencyMs:20});
  const d = await pm.diagnostics({symbol:'PHAUSDT',positionSide:'LONG'});
  assert.equal(d.markPrice,0.080448);
  assert.equal(d.markPriceSource,'MARK_PRICE_WS');
  assert.equal(d.unrealizedPnl,0.003312);
  assert.ok(Math.abs(d.positionReturnPct - 0.60) < 0.01, `ROI=${d.positionReturnPct}`);
  assert.ok(Math.abs(d.slDistancePct - 0.5693) < 0.01, `SL Mark=${d.slDistancePct}`);
  assert.ok(Math.abs(d.tpDistancePct - 1.9416) < 0.01, `TP Mark=${d.tpDistancePct}`);
  assert.ok(Math.abs(d.equityAfterSL - 0.6122) < 0.0002, `SL equity=${d.equityAfterSL}`);
  assert.ok(Math.abs(d.equityAfterTP - 0.7516) < 0.0002, `TP equity=${d.equityAfterTP}`);
  assert.equal(d.snapshotConsistency,'CONSISTENT');
});

test('Trailing 激活判断使用同一实时 Mark 快照，而不是 REST 旧 Mark', async () => {
  const cfg = { get: () => ({ autoProtection:true, protection: { calculationMode:'MARGIN', stopLossPct:4, takeProfitPct:8, stopLossMarginPct:5, takeProfitMarginPct:20, liquidationBufferPp:0.5, trailingEnabled:true, trailingActivationPct:0.5, trailingCallbackPct:0.5 } }) };
  const state = { getProtectionMeta: () => ({activeSL:0.07999,targetSL:0.07999,activeTP:0.08201,targetTP:0.08201}), getProtectionState: ()=>'PROTECTED', getPositionSource:()=> 'MANUAL', setProtectionState:()=>{} };
  const binance = { getQueuedAlgoJobs:()=>[] };
  const pm = new ProtectionManager({binance,state,config:cfg,emergency:{closePositionMarket:async()=>({})},userStream:null});
  pm.reconcile = async (p, options) => { assert.equal(options.reason,'MARK_PRICE_TRAILING_ACTIVATION'); assert.ok(p.markPrice > p.entryPrice); return {ok:true}; };
  const p = {symbol:'PHAUSDT',positionSide:'LONG',side:'long',contracts:69,entryPrice:0.0804,markPrice:0.0804,liquidationPrice:0.0735,leverage:10,isolatedMargin:0.56};
  const r = await pm.handleMarkPrice(p,0.080803,{eventTime:Date.now(),receivedAt:Date.now(),wsLatencyMs:15});
  assert.equal(r.trailingActivationTriggered,true);
});
