// V13.4.0：止损的 ATR 相对下限（computeRuleStop）
//
// 背景（真实事故）：原实现只用固定百分比下限（minRuleSLPct 0.4%），完全不看币的波动大小。
// 同样 0.4% 止损，对 1m ATR 0.15% 的币是 2.7×ATR（合理），对 ATR 0.43% 的币只有 0.94×ATR
// —— 止损埋在正常波动带里，开仓即被扫。四单实测止损仅 0.47~1.37×ATR，全部被扫出局。
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeRuleStop } = require('../server/monitoring/RuleAutoTrader');

// 构造一个"结构止损很紧"的场景：极值贴着入场价，让下限规则成为唯一约束
const tightShort = (atrValue, entry = 100) => ({
  action: 'SHORT', entry, recentHigh: entry * 1.0005, recentLow: entry * 0.99, atrValue
});
const tightLong = (atrValue, entry = 100) => ({
  action: 'LONG', entry, recentLow: entry * 0.9995, recentHigh: entry * 1.01, atrValue
});

test('V13.4.0：ATR 下限生效时，止损正好落在 minStopAtrRatio × ATR', () => {
  // ATR = 0.5（占价 0.5%），k=1.5 → 下限 0.75%
  const r = computeRuleStop({ ...tightShort(0.5), minSLPct: 0.4, minStopAtrRatio: 1.5 });
  assert.equal(r.ok, true);
  assert.equal(Number(r.slPct.toFixed(4)), 0.75, '止损应为 1.5×ATR = 0.75%');
  assert.equal(Number(r.stopAtrRatio.toFixed(4)), 1.5);
  assert.equal(Number(r.atrFloorPct.toFixed(4)), 0.75);
});

test('V13.4.0：低波动币回落到固定下限，不会被 ATR 规则过度收窄', () => {
  // ATR 仅 0.1% → 1.5×ATR = 0.15%，低于固定下限 0.4%，应取 0.4%
  const r = computeRuleStop({ ...tightShort(0.1), minSLPct: 0.4, minStopAtrRatio: 1.5 });
  assert.equal(r.ok, true);
  assert.equal(Number(r.slPct.toFixed(4)), 0.4, '应取固定下限 0.4%');
  assert.equal(Number(r.stopAtrRatio.toFixed(2)), 4.0, '此时相当于 4×ATR');
});

test('V13.4.0：结构止损本身更宽时，以结构为准（下限只托底不压缩）', () => {
  // recentHigh 距入场 2% → 结构止损 2%，远宽于 ATR 下限 0.75%
  const r = computeRuleStop({
    action: 'SHORT', entry: 100, recentHigh: 102, recentLow: 99, atrValue: 0.5,
    minSLPct: 0.4, minStopAtrRatio: 1.5
  });
  assert.equal(r.ok, true);
  assert.ok(r.slPct > 2 && r.slPct < 2.1, `结构止损应保留（实际 ${r.slPct}）`);
});

test('V13.4.0：minStopAtrRatio=0 时关闭 ATR 规则，回到纯固定下限', () => {
  const r = computeRuleStop({ ...tightShort(0.5), minSLPct: 0.4, minStopAtrRatio: 0 });
  assert.equal(Number(r.slPct.toFixed(4)), 0.4, '关闭后应回到固定下限');
  assert.equal(r.atrFloorPct, 0);
});

test('V13.4.0：超过上限返回 STOP_TOO_WIDE，且带上 ATR 倍数便于诊断', () => {
  const r = computeRuleStop({
    action: 'SHORT', entry: 100, recentHigh: 110, recentLow: 99, atrValue: 0.5,
    minSLPct: 0.4, maxSLPct: 2.5, minStopAtrRatio: 1.5
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'STOP_TOO_WIDE');
  assert.ok(r.slPct > 2.5);
  assert.ok(Number.isFinite(r.stopAtrRatio));
});

test('V13.4.0：止损方向错误时返回 STOP_DISTANCE_INVALID', () => {
  // 空单但极值低于入场价 → slPct 为负
  const r = computeRuleStop({ action: 'SHORT', entry: 100, recentHigh: 99, recentLow: 98, atrValue: 0.5 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'STOP_DISTANCE_INVALID');
});

test('V13.4.0：多空对称，LONG 用低点做结构止损', () => {
  const r = computeRuleStop({ ...tightLong(0.5), minSLPct: 0.4, minStopAtrRatio: 1.5 });
  assert.equal(r.ok, true);
  assert.equal(Number(r.slPct.toFixed(4)), 0.75);
  assert.ok(r.stopPrice < 100, '多单止损应在入场价下方');
  // 空单止损应在入场价上方
  const s = computeRuleStop({ ...tightShort(0.5), minSLPct: 0.4, minStopAtrRatio: 1.5 });
  assert.ok(s.stopPrice > 100, '空单止损应在入场价上方');
});

test('V13.4.0：只要 ATR 规则开启，止损就不会低于 1.5×ATR（真实事故复现）', () => {
  // 用四笔真实事故的 ATR 与开仓价回放：旧逻辑给出 0.4%（0.94~2.73×ATR），
  // 新逻辑应一律 ≥1.5×ATR。
  const cases = [
    { symbol: 'KMNOUSDT', entry: 0.0448, atr: 7.45e-5 },
    { symbol: 'PONSUSDT', entry: 0.5885, atr: 1.52e-3 },
    { symbol: 'INITUSDT', entry: 0.08992, atr: 1.31e-4 },
    { symbol: 'RAREUSDT', entry: 0.01934, atr: 8.24e-5 }
  ];
  for (const c of cases) {
    const r = computeRuleStop({ ...tightShort(c.atr, c.entry), minSLPct: 0.4, minStopAtrRatio: 1.5 });
    assert.equal(r.ok, true, `${c.symbol} 应产出有效止损`);
    assert.ok(
      r.stopAtrRatio >= 1.5 - 1e-9,
      `${c.symbol} 止损应 ≥1.5×ATR，实际 ${r.stopAtrRatio.toFixed(2)}×`
    );
  }
  // 旧逻辑（无 ATR 规则）下 RARE 只有 0.94×ATR —— 这正是它被扫掉的原因
  const old = computeRuleStop({ ...tightShort(8.24e-5, 0.01934), minSLPct: 0.4, minStopAtrRatio: 0 });
  assert.ok(old.stopAtrRatio < 1, `旧逻辑 RARE 止损仅 ${old.stopAtrRatio.toFixed(2)}×ATR，埋在噪音里`);
});
