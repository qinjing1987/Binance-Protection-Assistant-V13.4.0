const test = require('node:test');
const assert = require('node:assert/strict');
const RiskManager = require('../server/risk/RiskManager');
const { RuleAutoTrader } = require('../server/monitoring/RuleAutoTrader');

function riskConfig(limit=10){
  return { get:()=>({ risk:{dailyLossLimitPct:limit,riskPerTradePct:1,maxAIPositions:3,maxAITotalRiskPct:3,minSLPct:2,maxSLPct:7,minTPPct:4,maxTPPct:20,minRR:2,minAIConfidence:60,lossStreakLimit:3,lossStreakCooldownMinutes:60}})};
}

test('日亏损熔断覆盖实时权益回撤，规则与AI共用', async()=>{
  const date=new Date().toISOString().slice(0,10);
  const state={rawGet:(k,d)=>k==='dailyRisk'?{date,dayStartEquity:100,realizedPnl:0,fees:0,funding:0}:d,rawSet:()=>{},getCooldown:()=>0};
  const binance={fetchAccountEquity:async()=>80};
  const risk=new RiskManager({config:riskConfig(10),state,binance});
  assert.equal((await risk.canAutoTrade()).ok,false);
  assert.equal((await risk.canRuleAutoTrade()).ok,false);
  assert.equal((await risk.daily()).lossPct,20);
});

test('账户权益读取失败时禁止自动开仓', async()=>{
  const date=new Date().toISOString().slice(0,10);
  const state={rawGet:(k,d)=>k==='dailyRisk'?{date,dayStartEquity:100,realizedPnl:0,fees:0,funding:0}:d,rawSet:()=>{}};
  const risk=new RiskManager({config:riskConfig(0),state,binance:{fetchAccountEquity:async()=>{throw new Error('REST down')}}});
  const r=await risk.canRuleAutoTrade();
  assert.equal(r.ok,false);
  assert.match(r.reason,/账户权益数据不可用/);
});

test('连续亏损按完整订单FILLED计一次，不按每个TRADE事件重复计数',()=>{
  const date=new Date().toISOString().slice(0,10);
  let state={dailyRisk:{date,dayStartEquity:100,realizedPnl:0,fees:0,funding:0},lossStreak:0};
  const store={rawGet:(k,d)=> k==='dailyRisk'?state.dailyRisk:k==='lossStreak'?state.lossStreak:k==='lossStreakPausedUntil'?0:d,rawSet:(k,v)=>{if(k==='dailyRisk')state.dailyRisk=v;if(k==='lossStreak')state.lossStreak=v;}};
  const risk=new RiskManager({config:{get:()=>({risk:{lossStreakLimit:3,lossStreakCooldownMinutes:60}})},state:store,binance:{}});
  risk.recordTradeEvent({e:'ORDER_TRADE_UPDATE',o:{x:'TRADE',i:1,s:'ABCUSDT',S:'SELL',ps:'LONG',T:1,l:'1',z:'1',rp:'-1',n:'0',X:'PARTIALLY_FILLED'}});
  risk.recordTradeEvent({e:'ORDER_TRADE_UPDATE',o:{x:'TRADE',i:1,s:'ABCUSDT',S:'SELL',ps:'LONG',T:2,l:'1',z:'2',rp:'-1',n:'0',X:'PARTIALLY_FILLED'}});
  assert.equal(state.lossStreak,0);
  risk.recordTradeEvent({e:'ORDER_TRADE_UPDATE',o:{x:'TRADE',i:1,s:'ABCUSDT',S:'SELL',ps:'LONG',T:3,l:'1',z:'3',rp:'-1',n:'0',X:'FILLED'}});
  assert.equal(state.lossStreak,1);
});

test('规则下单前复核账户总持仓上限，拦截扫描期间新增持仓', async()=>{
  const cfg={get:()=>({ruleTrading:{enabled:true,maxPositions:1,maxPendingOrders:2}})};
  let call=0, placed=0;
  const trader=new RuleAutoTrader({config:cfg,state:{getRuleCooldown:()=>0,getCooldown:()=>0},risk:{canRuleAutoTrade:async()=>({ok:true})},ranking:{getTop10:async()=>({gainers:[{symbol:'ABCUSDT',changePct:5}],losers:[]})},binance:{fetchPositions:async()=>{call++;return call===1?[]:[{symbol:'XYZUSDT',contracts:1}]},fetchOpenOrders:async()=>[],fetchKlines:async()=>[],fetchMarkPrice:async()=>({markPrice:100}),createLimitOrder:async()=>{placed++}}});
  trader.running=true;
  trader.evaluateCandidate=async()=>({symbol:'ABCUSDT',action:'LONG',eligible:true,entry:99,quantity:1,leverage:10,plannedSLPct:1,plannedTPPct:2});
  await trader.scan();
  assert.equal(placed,0);
});

test('V13规则代码使用轻量三指标：5m SuperTrend + 1m RSI + 1m Volume，不再走BB/MACD交易路径',()=>{
  const fs=require('fs');
  const s=fs.readFileSync(require.resolve('../server/monitoring/RuleAutoTrader'),'utf8');
  assert.equal(s.includes('trend1mMismatch'),false);
  assert.equal(s.includes('rsiTrigger(c1'),true);
  assert.equal(s.includes('volumeConfirmation(c1'),true);
  assert.equal(s.includes('calculateSuperTrend(c5'),true);
  assert.equal(s.includes('bollinger(c1'),false);
  assert.equal(s.includes('macd(c1'),false);
});

test('开仓成交手续费不计入连亏，平仓订单完整成交才计一次',()=>{
  const date=new Date().toISOString().slice(0,10);
  let state={dailyRisk:{date,dayStartEquity:100,realizedPnl:0,fees:0,funding:0},lossStreak:0};
  const store={rawGet:(k,d)=> k==='dailyRisk'?state.dailyRisk:k==='lossStreak'?state.lossStreak:k==='lossStreakPausedUntil'?0:d,rawSet:(k,v)=>{if(k==='dailyRisk')state.dailyRisk=v;if(k==='lossStreak')state.lossStreak=v;}};
  const risk=new RiskManager({config:{get:()=>({risk:{lossStreakLimit:3,lossStreakCooldownMinutes:60}})},state:store,binance:{}});
  risk.recordTradeEvent({e:'ORDER_TRADE_UPDATE',o:{x:'TRADE',i:9,s:'ABCUSDT',S:'BUY',ps:'LONG',T:1,l:'1',z:'1',rp:'0',n:'-0.01',X:'FILLED'}});
  assert.equal(state.lossStreak,0);
  risk.recordTradeEvent({e:'ORDER_TRADE_UPDATE',o:{x:'TRADE',i:10,s:'ABCUSDT',S:'SELL',ps:'LONG',T:2,l:'1',z:'1',rp:'-1',n:'-0.01',X:'FILLED'}});
  assert.equal(state.lossStreak,1);
});
