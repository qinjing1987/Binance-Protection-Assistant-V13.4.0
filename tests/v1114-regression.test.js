const test = require('node:test');
const assert = require('node:assert/strict');
const Reconciliation = require('../server/recovery/Reconciliation');

test('恢复对账明确使用 RECOVERY_RECONCILIATION reason', async () => {
  const calls = [];
  const protection = { reconcile: async (...args) => calls.push(args) };
  const state = { rawGet: () => ({}), key: p => `${p.symbol}:${p.positionSide}`, setPositionSource: () => {} };
  const binance = { initialized: true, actualHedgeMode: true, fetchPositions: async () => [{ symbol:'4USDT', positionSide:'SHORT' }] };
  const r = new Reconciliation({ binance, protection, state });
  await r.run();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { forceConfig:true, reason:'RECOVERY_RECONCILIATION' });
});
