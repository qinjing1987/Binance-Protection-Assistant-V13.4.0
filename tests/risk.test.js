const test = require('node:test');
const assert = require('node:assert/strict');
const RiskManager = require('../server/risk/RiskManager');

const cfg = { get: () => ({ risk: { minSLPct:2,maxSLPct:7,minTPPct:4,maxTPPct:20,minRR:2,minAIConfidence:60,maxAIPositions:3,maxAITotalRiskPct:3,riskPerTradePct:1 }, dailyLossLimitPct:10 }) };
const fakeState = { getPositionSource: () => 'MANUAL', getCooldown: () => 0 };
const fakeBinance = {};

function check(signal) { return new RiskManager({config:cfg,state:fakeState,binance:fakeBinance}).validateSignal(signal, [], ['BTCUSDT']); }

test('risk rejects low RR', () => {
  const r = check({action:'LONG',symbol:'BTCUSDT',stop_loss_pct:4,take_profit_pct:5,confidence:70});
  assert.equal(r.ok, false);
});

test('risk accepts valid signal shape', () => {
  const r = check({action:'SHORT',symbol:'BTCUSDT',stop_loss_pct:4,take_profit_pct:8,confidence:70});
  assert.equal(r.ok, true);
});
