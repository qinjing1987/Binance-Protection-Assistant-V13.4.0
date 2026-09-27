// V13.4.0：RSI 顶底背离检测（开仓替代触发 + 平仓保护）回归测试
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RuleAutoTrader, rsiSeries, rsiAt, pivotLevels, detectRsiDivergence, shouldExitRulePosition
} = require('../server/monitoring/RuleAutoTrader');

const PERIOD = 14;

// 构造K线：low/high 基线随下标单调抬升，保证只有显式覆盖的下标才会成为 pivot
// （pivotLevels 用 <= / >=，平坦区会制造大量假 pivot）
function buildCandles({ length = 40, lows = {}, highs = {} } = {}) {
  return Array.from({ length }, (_, i) => {
    const base = 100 + i * 0.1;
    const low = lows[i] != null ? lows[i] : base;
    const high = highs[i] != null ? highs[i] : base + 5;
    const mid = (low + high) / 2;
    return { openTime: i * 60000, closeTime: i * 60000 + 59000, open: mid, high, low, close: mid, volume: 100 };
  });
}

// 手工 RSI 序列：rsiSeries 会剥掉前 period 个 null，所以 candle i 的 RSI 落在 rsiVals[i - period]
function buildRsi(length, override = {}) {
  const out = new Array(length - PERIOD).fill(50);
  for (const [candleIndex, v] of Object.entries(override)) {
    const idx = Number(candleIndex) - PERIOD;
    if (idx >= 0 && idx < out.length) out[idx] = v;
  }
  return out;
}

// 底背离蜡烛：index 16 低点 95、index 26 低点 90（价格更低低点）
const bullCandles = () => buildCandles({ length: 40, lows: { 16: 95, 26: 90 } });
// 顶背离蜡烛：index 16 高点 205、index 26 高点 210（价格更高高点）
const bearCandles = () => buildCandles({ length: 40, highs: { 16: 205, 26: 210 } });
const OPT = { period: PERIOD, lookbackBars: 60, pivotSpan: 2, minRsiDelta: 2, minBarsBetween: 5, maxAgeBars: 15 };

test('V13.4.0：rsiAt 必须补偿 rsiSeries 的下标偏移（本次最易错处）', () => {
  const vals = [10, 20, 30, 40, 50];
  assert.equal(rsiAt(vals, 14, 14), 10, 'candle 14 对应 vals[0]');
  assert.equal(rsiAt(vals, 16, 14), 30, 'candle 16 对应 vals[2]');
  assert.equal(rsiAt(vals, 18, 14), 50);
  // 越界必须返回 null，而不是 undefined 或错位值
  assert.equal(rsiAt(vals, 13, 14), null, '早于 period 的 candle 没有 RSI');
  assert.equal(rsiAt(vals, 19, 14), null);
  assert.equal(rsiAt(vals, 5, 14), null);
  assert.equal(rsiAt(null, 20, 14), null);
});

test('V13.4.0：rsiAt 与真实 rsiSeries 输出对齐', () => {
  const candles = buildCandles({ length: 40 });
  const vals = rsiSeries(candles, PERIOD);
  assert.equal(vals.length, 40 - PERIOD, 'rsiSeries 会剥掉前 period 个 null');
  // 最后一根 candle（下标 39）的 RSI 必须是序列末位
  assert.equal(rsiAt(vals, 39, PERIOD), vals[vals.length - 1]);
  assert.ok(rsiAt(vals, 39, PERIOD) != null);
  // 若漏掉偏移（直接 vals[candleIndex]）会越界取到 undefined
  assert.equal(vals[39], undefined, '验证直接索引确实会错位');
});

test('V13.4.0：pivotLevels 泛化后默认 span=2 行为不变', () => {
  const lows = { 16: 95, 26: 90 };
  const candles = buildCandles({ length: 40, lows });
  const p = pivotLevels(candles, 'LONG');
  assert.equal(p.length, 2, '只有显式覆盖的两个下标是摆动低点');
  assert.deepEqual(p.map(x => x.index), [16, 26]);
  assert.equal(p[0].price, 95);
  assert.equal(p[1].price, 90);
  // span=1 会放宽、找到更多 pivot
  assert.ok(pivotLevels(candles, 'LONG', 1).length >= 2);
});

test('V13.4.0：底背离（价格更低低点 + RSI 更高低点）确认', () => {
  const candles = bullCandles();
  const rsi = buildRsi(40, { 16: 30, 26: 38 });
  const d = detectRsiDivergence(candles, rsi, 'LONG', OPT);
  assert.equal(d.confirmed, true);
  assert.equal(d.type, 'BULLISH_DIVERGENCE');
  assert.equal(d.reason, null);
  assert.equal(d.pricePrev, 95);
  assert.equal(d.priceLast, 90);
  assert.equal(d.rsiPrev, 30);
  assert.equal(d.rsiLast, 38);
  assert.equal(d.rsiDelta, 8);
  assert.equal(d.barsBetween, 10);
});

test('V13.4.0：顶背离（价格更高高点 + RSI 更低高点）确认', () => {
  const candles = bearCandles();
  const rsi = buildRsi(40, { 16: 70, 26: 62 });
  const d = detectRsiDivergence(candles, rsi, 'SHORT', OPT);
  assert.equal(d.confirmed, true);
  assert.equal(d.type, 'BEARISH_DIVERGENCE');
  assert.equal(d.pricePrev, 205);
  assert.equal(d.priceLast, 210);
  assert.equal(d.rsiDelta, 8);
});

test('V13.4.0：价格与 RSI 同向创新极值时不算背离', () => {
  // 价格更低低点，但 RSI 也更低 → 没有背离，只是同步走弱
  const d = detectRsiDivergence(bullCandles(), buildRsi(40, { 16: 38, 26: 30 }), 'LONG', OPT);
  assert.equal(d.confirmed, false);
  assert.equal(d.reason, 'RSI_NOT_DIVERGENT');
});

test('V13.4.0：价格没创新极值时不算背离', () => {
  // index 16 低点 90、index 26 低点 95 → 后一个低点更高，不构成"创新低"
  const candles = buildCandles({ length: 40, lows: { 16: 90, 26: 95 } });
  const d = detectRsiDivergence(candles, buildRsi(40, { 16: 30, 26: 38 }), 'LONG', OPT);
  assert.equal(d.confirmed, false);
  assert.equal(d.reason, 'PRICE_NOT_EXTREME');
});

test('V13.4.0：两个 pivot 间隔太近时因 RSI 平滑失真而不采信', () => {
  const candles = buildCandles({ length: 40, lows: { 16: 95, 19: 90 } }); // 间隔仅 3 根
  const d = detectRsiDivergence(candles, buildRsi(40, { 16: 30, 19: 38 }), 'LONG', OPT);
  assert.equal(d.confirmed, false);
  assert.equal(d.reason, 'PIVOTS_TOO_CLOSE');
  assert.equal(d.barsBetween, 3);
});

test('V13.4.0：陈旧背离不触发', () => {
  const candles = bullCandles();
  const rsi = buildRsi(40, { 16: 30, 26: 38 });
  // 最新 pivot 距末尾 13 根，把上限压到 3 即应拒绝
  const d = detectRsiDivergence(candles, rsi, 'LONG', { ...OPT, maxAgeBars: 3 });
  assert.equal(d.confirmed, false);
  assert.equal(d.reason, 'DIVERGENCE_STALE');
  assert.equal(d.ageBars, 13);
});

test('V13.4.0：pivot 不足 / RSI 取不到值时给出可读原因', () => {
  const only = buildCandles({ length: 40, lows: { 26: 90 } });
  assert.equal(detectRsiDivergence(only, buildRsi(40), 'LONG', OPT).reason, 'NO_TWO_PIVOTS');
  // RSI 序列太短 → 取不到 pivot 位置的 RSI
  const short = detectRsiDivergence(bullCandles(), new Array(5).fill(50), 'LONG', OPT);
  assert.equal(short.confirmed, false);
  assert.equal(short.reason, 'RSI_DATA_MISSING');
  // K 线不足
  assert.equal(detectRsiDivergence([], [], 'LONG', OPT).reason, 'CANDLES_INSUFFICIENT');
});

test('V13.4.0：背离的 RSI 差值门槛生效', () => {
  const candles = bullCandles();
  const rsi = buildRsi(40, { 16: 30, 26: 31 }); // 差值仅 1
  assert.equal(detectRsiDivergence(candles, rsi, 'LONG', OPT).confirmed, false);
  assert.equal(detectRsiDivergence(candles, rsi, 'LONG', OPT).reason, 'RSI_NOT_DIVERGENT');
  // 放宽门槛到 1 则通过
  assert.equal(detectRsiDivergence(candles, rsi, 'LONG', { ...OPT, minRsiDelta: 1 }).confirmed, true);
});

test('V13.4.0：平仓真值表纳入 divergenceReverse', () => {
  // 盈利：任一反向信号即可（背离单独即可平仓）
  assert.equal(shouldExitRulePosition({ profitable: true, rsiReverse: false, trendReverse: false, divergenceReverse: true }).exit, true);
  assert.equal(shouldExitRulePosition({ profitable: true, rsiReverse: false, trendReverse: false, divergenceReverse: false }).exit, false);
  // 亏损：背离可独立构成反向，但仍需 N 根确认（不放松非对称确认设计）
  assert.equal(shouldExitRulePosition({ profitable: false, divergenceReverse: true, lossReverseCount: 1, lossExitConfirmBars: 2 }).exit, false);
  assert.equal(shouldExitRulePosition({ profitable: false, divergenceReverse: true, lossReverseCount: 2, lossExitConfirmBars: 2 }).exit, true);
  // 原有的 RSI+趋势 双确认路径不受影响
  assert.equal(shouldExitRulePosition({ profitable: false, rsiReverse: true, trendReverse: true, lossReverseCount: 2, lossExitConfirmBars: 2 }).exit, true);
  assert.equal(shouldExitRulePosition({ profitable: false, rsiReverse: true, trendReverse: false, lossReverseCount: 9, lossExitConfirmBars: 2 }).exit, false);
});

test('V13.4.0：背离开关默认开、可关闭', () => {
  const withCfg = (rt) => new RuleAutoTrader({
    config: { get: () => ({ ruleTrading: { enabled: true, ...rt } }) },
    state: { getRuleCooldown: () => 0, getCooldown: () => 0 }, ranking: {}, risk: {}, binance: {}
  });
  assert.equal(withCfg({}).divergenceEnabled(), true, '缺省即开');
  assert.equal(withCfg({ divergenceEnabled: false }).divergenceEnabled(), false);
  // 参数带边界钳制
  const o = withCfg({ divergenceLookbackBars: 9999, divergencePivotSpan: 0, divergenceMinBarsBetween: 0 }).divergenceOpts();
  assert.equal(o.lookbackBars, 200, '回看K线上限 200');
  assert.equal(o.pivotSpan, 1, 'pivot 跨度下限 1');
  assert.equal(o.minBarsBetween, 2, '最小间隔下限 2');
});

// ——— 集成：evaluateCandidate 是否真的在 RSI 三条件失败时走背离通路 ———

// 这组K线经过调校，同时满足两件事（否则测试无意义）：
//   ① RSI 三条件失败（RSI_RECOVERY_NOT_CONFIRMED）
//   ② 底背离成立（第二个摆动低点更低、RSI 更高）
// 低点用显式 low 字段控制 —— 若从 close 推导，拐点处会产生并列低点导致 pivot 识别错乱。
function divergenceCandles() {
  const closes = [
    ...Array.from({ length: 9 }, (_, i) => 100 - i * 0.4),
    ...Array.from({ length: 4 }, (_, i) => 97.4 + i * 0.6),
    ...Array.from({ length: 4 }, (_, i) => 99.2 - i * 1.6),
    ...Array.from({ length: 6 }, (_, i) => 92.8 + i * 0.75),
    ...Array.from({ length: 5 }, (_, i) => 97.3 - i * 0.85),
    ...Array.from({ length: 12 }, (_, i) => 93.05 + i * 0.25)
  ];
  const lows = closes.map(c => c - 0.4);
  lows[16] = 93.0;
  lows[27] = 92.0; // 第二个摆动低点更低 → 价格创新低
  return closes.map((c, i) => ({
    openTime: (i + 1) * 60000, closeTime: (i + 1) * 60000 + 59000, open: i ? closes[i - 1] : c, close: c,
    high: Math.max(c, lows[i]) + 0.5, low: lows[i], volume: 100
  }));
}
// 5m 干净上升趋势 → SuperTrend UP，且不会被震荡市过滤拦下
const uptrendCandles5m = () => Array.from({ length: 90 }, (_, i) => {
  const c = 100 + i * 0.5;
  return { openTime: (i + 1) * 300000, closeTime: (i + 1) * 300000 + 299000, open: c - 0.4, high: c + 0.5, low: c - 0.6, close: c, volume: 100 };
});

// getCachedKlines 返回的是币安原始二维数组，closedCandles 按下标 0..7 取值：
// [openTime, open, high, low, close, volume, closeTime, quoteVolume]。
// 直接塞对象会让 closedCandles 产出空数组（曾被这个坑卡住）。
const toRawKlines = (candles) => candles.map(c => [
  c.openTime, c.open, c.high, c.low, c.close, c.volume, c.closeTime, c.volume * c.close
]);

function makeEvalTrader(rt = {}) {
  const c1 = divergenceCandles(), c5 = uptrendCandles5m();
  const t = new RuleAutoTrader({
    config: {
      get: () => ({
        ruleTrading: {
          enabled: true, rsiPeriod: PERIOD, rsiLongTrigger: 44, rsiLongDepth: 42,
          rsiShortTrigger: 56, rsiShortDepth: 58, rsiLookbackBars: 2, rsiDepthLookbackBars: 8,
          stFlipCooldownBars: 1, volatilityGuardPct: 0,
          // 默认关掉 1m 趋势确认，让本文件专注测背离行为；
          // 1m 过滤另有专项测试，也可由 rt 覆盖后单独开启。
          require1mTrendMatch: false, ...rt
        }
      })
    },
    state: { getRuleCooldown: () => 0, getCooldown: () => 0 },
    ranking: {}, risk: {},
    binance: {
      fetchMarkPrice: async () => ({ markPrice: 100 }),
      tickSize: () => 0.01,
      roundPrice: (_s, p) => p,
      roundQty: (_s, q) => q,
      minQty: () => 1, maxQty: () => 1000000, minNotional: () => 0,
      maxInitialLeverage: async () => 20,
      getAccount: async () => ({ totalMarginBalance: '100', availableBalance: '100' })
    }
  });
  t.getCachedKlines = async (_symbol, tf) => toRawKlines(tf === '1m' ? c1 : c5);
  return t;
}

test('V13.4.0 集成：三条件失败但背离成立 → 未被 RSI 段拦下，标记为背离触发', async () => {
  const t = makeEvalTrader();
  const d = await t.evaluateCandidate(
    { symbol: 'ABCUSDT', action: 'LONG', group: 'GAINER', rank: 1 },
    { currentSymbols: new Set(), pendingSymbols: new Set(), traceId: 'T1' }, 0
  );
  assert.equal(d.triggerBy, 'DIVERGENCE', '应标记为背离触发');
  assert.notEqual(d.stage, 'RSI', '不应停在 RSI 阶段');
  assert.equal(d.divergence && d.divergence.confirmed, true, '决策应带背离详情供诊断展示');
  assert.ok(d.divergence.rsiLast > d.divergence.rsiPrev, '底背离：后一个 RSI 更高');
  assert.ok(d.divergence.priceLast < d.divergence.pricePrev, '底背离：后一个低点更低');
});

test('V13.4.0 集成：关闭背离开关后同一场景被 RSI 段拦下（零行为变化）', async () => {
  const t = makeEvalTrader({ divergenceEnabled: false });
  const d = await t.evaluateCandidate(
    { symbol: 'ABCUSDT', action: 'LONG', group: 'GAINER', rank: 1 },
    { currentSymbols: new Set(), pendingSymbols: new Set(), traceId: 'T2' }, 0
  );
  assert.equal(d.stage, 'RSI', '关闭开关后应回到原逻辑，停在 RSI 段');
  assert.equal(d.triggerBy, null);
  assert.equal(d.divergence, null, '关闭时不评估背离');
  assert.equal(d.reason, 'RSI_RECOVERY_NOT_CONFIRMED', '失败原因仍是原有的 RSI 原因');
});

test('V13.4.0 集成：1m 趋势确认开启时，1m 反向的候选被拦在 TREND_1M', async () => {
  // divergenceCandles 是"先跌后弹"的形态，1m SuperTrend 为 DOWN；
  // 这里开一个 LONG，应当被 1m 趋势确认拦下（5m 用的是上升序列，能过 TREND）。
  const t = makeEvalTrader({ require1mTrendMatch: true });
  const d = await t.evaluateCandidate(
    { symbol: 'ABCUSDT', action: 'LONG', group: 'GAINER', rank: 1 },
    { currentSymbols: new Set(), pendingSymbols: new Set(), traceId: 'T3' }, 0
  );
  assert.equal(d.stage, 'TREND_1M');
  assert.equal(d.reason, '1M_TREND_MISMATCH');
  assert.equal(d.trend1m, 'DOWN', '记录 1m 方向便于诊断');
  assert.equal(d.trend5m, 'UP', '5m 是通过的，说明拦在 1m 这一层');
});

test('V13.4.0：1m 趋势确认默认开启，可关闭', () => {
  const withCfg = (rt) => new RuleAutoTrader({
    config: { get: () => ({ ruleTrading: { enabled: true, ...rt } }) },
    state: { getRuleCooldown: () => 0, getCooldown: () => 0 }, ranking: {}, risk: {}, binance: {}
  });
  assert.equal(withCfg({}).settingsSummary().require1mTrendMatch, true, '缺省即开');
  assert.equal(withCfg({ require1mTrendMatch: false }).settingsSummary().require1mTrendMatch, false);
});

test('V13.4.0：divergenceReversal 用相反方向检测持仓的反转背离', () => {
  const t = new RuleAutoTrader({
    config: { get: () => ({ ruleTrading: { enabled: true, rsiPeriod: PERIOD } }) },
    state: { getRuleCooldown: () => 0, getCooldown: () => 0 }, ranking: {}, risk: {}, binance: {}
  });
  // 持多头 → 找顶背离（SHORT 型）
  const bear = t.divergenceReversal(bearCandles(), 'LONG');
  assert.equal(bear.type, 'BEARISH_DIVERGENCE', '持多头要检测的是看跌的顶背离');
  // 持空头 → 找底背离（LONG 型）
  const bull = t.divergenceReversal(bullCandles(), 'SHORT');
  assert.equal(bull.type, 'BULLISH_DIVERGENCE', '持空头要检测的是看涨的底背离');
});
