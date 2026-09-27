const test = require('node:test');
const assert = require('node:assert/strict');
const { RuleAutoTrader, rsiSeries, rsiTrigger, classifyRsiTriggerValues, rsiExitReverse, volumeConfirmation, atr, precisionEntry, superTrendMarketState, shouldExitRulePosition } = require('../server/monitoring/RuleAutoTrader');

function candles(closes, volumes=null){
  return closes.map((close,i)=>({
    openTime:i*60000, closeTime:i*60000+59000,
    open:i ? closes[i-1] : close, close, high:Math.max(close, i?closes[i-1]:close)*1.001,
    low:Math.min(close, i?closes[i-1]:close)*0.999, volume:volumes ? volumes[i] : 100
  }));
}

test('V13 RSI做多触发：从40下方上穿40',()=>{
  const rows=candles(Array.from({length:40},(_,i)=>100-i*0.5).concat([80,79,79.5,80.5,81,81.5]));
  const vals=rsiSeries(rows,14);
  assert.ok(vals.length>4);
  const hit=rsiTrigger(rows,'LONG',14,40,3);
  assert.ok(hit);
});

test('V13 RSI多空退出反向阈值函数可用',()=>{
  const longRows=candles(Array.from({length:60},(_,i)=>100+i*0.2).concat([112,111.8,111.5]));
  const shortRows=candles(Array.from({length:60},(_,i)=>110-i*0.2).concat([98,98.2,98.5]));
  assert.equal(typeof rsiExitReverse(longRows,'LONG',14,60),'boolean');
  assert.equal(typeof rsiExitReverse(shortRows,'SHORT',14,40),'boolean');
});

test('V13 成交量按前20根均量计算，0.9倍通过，低于则拒绝',()=>{
  const rows=candles(Array.from({length:30},()=>100), Array.from({length:29},()=>100).concat([95]));
  const v=volumeConfirmation(rows,20,0.9);
  assert.ok(v);
  assert.equal(Number(v.ratio.toFixed(2)),0.95);
  const v2=volumeConfirmation(candles(Array.from({length:30},()=>100), Array.from({length:29},()=>100).concat([89])),20,0.9);
  assert.ok(v2 && v2.ratio<0.9);
});

test('V13 结构LIMIT与ATR使用相对距离，不依赖布林/MACD',()=>{
  const rows=candles(Array.from({length:80},(_,i)=>100+Math.sin(i/4)));
  const a=atr(rows,10);
  assert.ok(a>0);
  const recent=rows.slice(-3);
  const low=Math.min(...recent.map(x=>x.low));
  const entry=low+a*0.25;
  assert.ok(entry>low);
});


test('V13.1 精确入场：结构、触发K线与38.2%回撤共同确定被动价格',()=>{
  const rows=candles(Array.from({length:60},(_,i)=>100+i*0.15).concat([108,107.2,107.6,108.2]));
  const a=atr(rows,10);
  const mark=108.5;
  const e=precisionEntry(rows,'LONG',a,mark,0.01,{lookbackBars:4,offsetAtr:0.15,retraceRatio:0.38});
  assert.ok(e);
  assert.ok(e.entryRaw < mark);
  assert.ok(e.entryRaw >= e.recentLow);
  assert.equal(e.retraceRatio,0.38);
});

test('V13.1 精确入场：空头价格保持在Mark上方',()=>{
  const rows=candles(Array.from({length:60},(_,i)=>110-i*0.15).concat([101,100.8,101.4,102]));
  const a=atr(rows,10);
  const mark=100.5;
  const e=precisionEntry(rows,'SHORT',a,mark,0.01,{lookbackBars:4,offsetAtr:0.15,retraceRatio:0.38});
  assert.ok(e);
  assert.ok(e.entryRaw > mark);
  assert.ok(e.entryRaw <= e.recentHigh);
});


test('V13.3 真实统计初始化并计算成交率',()=>{
  const state={rawGet:(k,d)=>k==='ruleTradingStats'?{date:new Date().toISOString().slice(0,10),ordersPlaced:4,filledOrders:2,totalFillWaitMs:4000}:d,rawSet:()=>{}};
  const t=new RuleAutoTrader({config:{get:()=>({ruleTrading:{enabled:true}})},state,binance:{},ranking:{},risk:{}});
  const s=t.getRuleStats();
  assert.equal(s.orderFillRatePct,50);
  assert.equal(s.averageFillWaitSec,2);
});


test('V13.3 浮亏时只有 RSI+5m SuperTrend 同时反转并连续2根确认才退出',()=>{
  assert.equal(shouldExitRulePosition({profitable:false,rsiReverse:true,trendReverse:true,lossReverseCount:1,lossExitConfirmBars:2}).exit,false);
  assert.equal(shouldExitRulePosition({profitable:false,rsiReverse:true,trendReverse:true,lossReverseCount:2,lossExitConfirmBars:2}).exit,true);
  assert.equal(shouldExitRulePosition({profitable:false,rsiReverse:true,trendReverse:false,lossReverseCount:5,lossExitConfirmBars:2}).exit,false);
});

test('V13.3 盈利仓位指标反转可直接退出',()=>{
  assert.equal(shouldExitRulePosition({profitable:true,rsiReverse:true,trendReverse:false}).exit,true);
  assert.equal(shouldExitRulePosition({profitable:true,rsiReverse:false,trendReverse:true}).exit,true);
});

test('V13.3 震荡过滤增加趋势效率指标',()=>{
  const rows=candles(Array.from({length:70},(_,i)=>100 + (i%2 ? 0.3 : 0)));
  const m=superTrendMarketState(rows,10,3,6,2,1,0.22);
  assert.ok(m);
  assert.ok(Object.prototype.hasOwnProperty.call(m,'efficiency'));
  assert.equal(typeof m.choppy,'boolean');
});


test('V13.3 RSI深度回踩：深度窗口6根严格排除当前K线',()=>{
  const values=[34,36,38,39,41,42,44,35];
  const hit=classifyRsiTriggerValues(values,'LONG',40,35,2,6);
  assert.ok(hit);
  // 当前K=35不参与“最近6根”的深度统计，因此前6根最低=36，深度未达到。
  assert.equal(hit.depthSeries.length,6);
  assert.equal(Math.min(...hit.depthSeries),36);
  assert.equal(hit.depthReached,false);
  assert.equal(hit.reason,'RSI_DEPTH_NOT_REACHED');
});

test('V13.4 RSI 同时返回全部失败条件，reason保留首个失败项兼容旧版',()=>{
  const shallow=[37,38,39,39.5,38,39,39.5];
  const a=classifyRsiTriggerValues(shallow,'LONG',40,35,2,6);
  assert.equal(a.reason,'RSI_DEPTH_NOT_REACHED');
  assert.deepEqual(a.reasons,['RSI_DEPTH_NOT_REACHED','RSI_RECOVERY_NOT_CONFIRMED']);

  const noRecovery=[34,35,36,37,38,39,39.5];
  const b=classifyRsiTriggerValues(noRecovery,'LONG',40,35,2,6);
  assert.equal(b.reason,'RSI_RECOVERY_NOT_CONFIRMED');
  assert.deepEqual(b.reasons,['RSI_RECOVERY_NOT_CONFIRMED']);

  const noSlope=[34,35,36,37,39,42,40.5];
  const c=classifyRsiTriggerValues(noSlope,'LONG',40,35,2,6);
  assert.equal(c.reason,'RSI_SLOPE_NOT_CONFIRMED');
  assert.deepEqual(c.reasons,['RSI_SLOPE_NOT_CONFIRMED']);
});

test('V13.3 RSI有效触发：深度35 + 回到40上方 + 同K斜率确认',()=>{
  const ok=[34,35,36,37,39,42,43];
  const hit=classifyRsiTriggerValues(ok,'LONG',40,35,2,6);
  assert.equal(hit.confirmed,true);
  assert.equal(hit.reason,null);
  assert.equal(hit.depthExtreme,34);
  assert.equal(hit.crossed,true);
  assert.equal(hit.slopeConfirmed,true);
});

test('V13.3 RSI空头对称逻辑：深度65 + 回到60下方 + 同K斜率确认',()=>{
  const ok=[66,65,64,63,61,58,57];
  const hit=classifyRsiTriggerValues(ok,'SHORT',60,65,2,6);
  assert.equal(hit.confirmed,true);
  assert.equal(hit.depthExtreme,66);
  assert.equal(hit.crossed,true);
  assert.equal(hit.slopeConfirmed,true);
});
