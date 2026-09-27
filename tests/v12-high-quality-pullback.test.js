const test = require('node:test');
const assert = require('node:assert/strict');
const { RuleAutoTrader, bollinger, macd, detectBollingerPullback, macdMomentum } = require('../server/monitoring/RuleAutoTrader');

function c(rows) {
  return rows.map((x, i) => {
    const [open, high, low, close] = Array.isArray(x) ? x : [x, x * 1.002, x * 0.998, x];
    return { openTime:i*60000, closeTime:i*60000+59000, open, high, low, close };
  });
}
function config(overrides={}) {
  return { get:()=>({ruleTrading:{enabled:true,leverage:10,riskPerTradePct:.5,maxPositions:1,maxPendingOrders:2,orderTtlMinutes:5,cooldownMinutes:10,bbPeriod:20,bbStdDev:2,macdFast:12,macdSlow:26,macdSignal:9,maxEntryDistanceAtr:1.5,require5mTrendMatch:true,stFlipCooldownBars:1,bbTouchLookbackBars:6,bbEntryOffsetPct:15,macdConfirmBars:3,minRuleSLPct:.4,maxRuleSLPct:2.5,ruleTakeProfitRR:2,exitOnIndicatorReverse:true,...overrides}})};
}

function trader(state={}) {
  return new RuleAutoTrader({
    config:config(),
    state:{getRuleCooldown:()=>0,setRuleCooldown:()=>{},getCooldown:()=>0,setProtectionParams:()=>{},deleteRuleOrderPlan:()=>{},getRuleOrderPlan:()=>null,...state},
    ranking:{},risk:{},binance:{actualHedgeMode:true,tickSize:()=>.01,roundPrice:(_s,p)=>p,roundQty:(_s,q)=>Math.floor(q),minQty:()=>1,maxQty:()=>1e6,minNotional:()=>1,maxInitialLeverage:async()=>20,getAccount:async()=>({totalMarginBalance:'100',availableBalance:'100'}),fetchAccountEquity:async()=>100,fetchPositions:async()=>[],fetchOpenOrders:async()=>[],fetchMarkPrice:async()=>({markPrice:100}),getSymbolConfig:async()=>({leverage:10}),setLeverage:async()=>{},createLimitOrder:async a=>({orderId:101,status:'NEW',executedQty:0,...a}),cancelOrder:async()=>{},...{}}
  });
}

// 构造“先刺破下轨、随后重新收回”的LONG回踩K线序列。
test('V12.0.1布林带允许刺破外轨后在后1～2根K线收回', ()=>{
  const closes = Array.from({length:50},(_,i)=>100 + Math.sin(i/3));
  const rows = c(closes);
  const touchIndex = rows.length - 3;
  const slice = rows.slice(touchIndex - 19, touchIndex + 1).map(x=>x.close);
  const middle = slice.reduce((a,b)=>a+b,0)/slice.length;
  const sd = Math.sqrt(slice.reduce((a,b)=>a+(b-middle)**2,0)/slice.length);
  const lower = middle - 2*sd;
  rows[touchIndex].low = lower * 0.995;
  // 刺破K线收盘仍在下轨外，下一根才重新收回带内。
  rows[touchIndex].close = lower * 0.997;
  rows[touchIndex + 1].open=lower*0.998; rows[touchIndex + 1].close=lower*1.002; rows[touchIndex + 1].high=lower*1.004; rows[touchIndex + 1].low=lower*0.996;
  rows[rows.length-1].open=99.9; rows[rows.length-1].close=100.0; rows[rows.length-1].high=100.1; rows[rows.length-1].low=99.7;
  const pull = detectBollingerPullback(rows,'LONG',20,2,6);
  assert.ok(pull);
  assert.equal(pull.touchIndex,touchIndex);
  assert.equal(pull.reclaimIndex,touchIndex + 1);
  assert.equal(pull.barsToReclaim,1);
});

test('V12.1 MACD最近3根至少1次改善且最新不明显恶化即可通过', ()=>{
  const closes = Array.from({length:100},(_,i)=>100 + (i<70 ? i*0.03 : 2.1-(i-70)*0.08));
  const rows = c(closes);
  const m = macd(rows,12,26,9);
  const mom = macdMomentum(rows,'SHORT',12,26,9,3);
  assert.ok(m && Number.isFinite(m.hist) && Number.isFinite(m.prev2Hist));
  assert.ok(mom && Array.isArray(mom.histSeries) && mom.histSeries.length >= 3);
});


// V12.1：验证“触轨→第3根收回”以及“当前价格已离开外轨但仍未远离setup”不会被误判。
test('V12.1布林回踩最多允许3根收回，不要求同一根K线完成', ()=>{
  const closes = Array.from({length:70},(_,i)=>100 + Math.sin(i/5));
  const rows = c(closes);
  const touchIndex = rows.length - 5;
  const prior = rows.slice(touchIndex - 19, touchIndex + 1);
  const b = bollinger(prior,20,2);
  assert.ok(b);
  rows[touchIndex].low=b.lower*0.995; rows[touchIndex].close=b.lower*0.997;
  rows[touchIndex+1].low=b.lower*0.996; rows[touchIndex+1].close=b.lower*0.997;
  rows[touchIndex+2].low=b.lower*0.997; rows[touchIndex+2].close=b.lower*0.998;
  rows[touchIndex+3].open=98.9; rows[touchIndex+3].close=99.1; rows[touchIndex+3].high=99.3; rows[touchIndex+3].low=98.8;
  rows[touchIndex+4].open=99.1; rows[touchIndex+4].close=99.4; rows[touchIndex+4].high=99.6; rows[touchIndex+4].low=99.0;
  const pull = detectBollingerPullback(rows,'LONG',20,2,6);
  assert.ok(pull);
  assert.ok(pull.reclaimIndex > pull.touchIndex);
  assert.ok(pull.barsToReclaim <= 3);
});

test('V13兼容配置保留旧版字段且采用5m主趋势、10分钟冷却、1.5ATR和2R', ()=>{
  const t=trader();
  assert.equal(t.cfg.require5mTrendMatch,true);
  assert.equal(t.cfg.cooldownMinutes,10);
  assert.equal(t.cfg.minRuleSLPct,.4);
  assert.equal(t.cfg.maxRuleSLPct,2.5);
  assert.equal(t.cfg.ruleTakeProfitRR,2);
  assert.equal(t.cfg.maxEntryDistanceAtr,1.5);
  assert.equal(t.settingsSummary().entryMode,'V13.3_TREND_RSI_DEPTH_VOLUME_PULLBACK');
});

test('V12部分成交必须立即写入规则专属保护参数', ()=>{
  let params=null;
  const t=trader({setProtectionParams:(_p,x)=>{params=x;},getRuleOrderPlan:()=>({plannedSLPct:.8,plannedTPPct:1.6,entry:99,stopPrice:98.2,tpPrice:100.58})});
  t.pending.set('101',{orderId:101,symbol:'ABCUSDT',positionSide:'LONG',status:'NEW',plannedSLPct:.8,plannedTPPct:1.6,entry:99,stopPrice:98.2,tpPrice:100.58});
  t.handleUserEvent({e:'ORDER_TRADE_UPDATE',o:{s:'ABCUSDT',ps:'LONG',c:'QP_RULE_TEST',i:101,X:'PARTIALLY_FILLED',x:'TRADE',ap:'99.2',z:'1'}});
  assert.ok(params);
  assert.equal(params.stopLossPct,.8);
  assert.equal(params.takeProfitPct,1.6);
  assert.equal(params.source,'RULE_V13.3_STRUCTURE_PULLBACK');
  assert.equal(t.pending.has('101'),true);
});

test('V12完全成交后删除规则订单计划并保留10分钟冷却', ()=>{
  let deleted=0, until=0;
  const t=trader({getRuleOrderPlan:()=>({plannedSLPct:.8,plannedTPPct:1.6,entry:99,stopPrice:98.2,tpPrice:100.58}),setRuleCooldown:(_s,u)=>{until=u;},deleteRuleOrderPlan:()=>{deleted++;},setProtectionParams:()=>{}});
  t.pending.set('102',{orderId:102,symbol:'ABCUSDT',positionSide:'LONG',status:'NEW',plannedSLPct:.8,plannedTPPct:1.6,entry:99,stopPrice:98.2,tpPrice:100.58});
  t.handleUserEvent({e:'ORDER_TRADE_UPDATE',o:{s:'ABCUSDT',ps:'LONG',c:'QP_RULE_TEST2',i:102,X:'FILLED',x:'TRADE',ap:'99.2',z:'2'}});
  assert.equal(t.pending.has('102'),false);
  assert.equal(deleted,1);
  assert.ok(until-Date.now() > 9*60*1000);
});
