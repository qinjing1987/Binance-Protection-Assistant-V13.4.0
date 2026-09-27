// 无 AI 规则自动交易 V13.4：涨跌幅 Top20（多/空各20） + 5m SuperTrend + 1m RSI + 1m 成交量。
// 核心原则：5m 判方向，1m RSI 判回调时机，成交量做参与度确认，最近 K 线结构确定被动 LIMIT；不追价，成交后由现有 ProtectionManager 接管保护。
const Logger = require('../Logger');
const { normalizeSymbol } = require('../utils/symbol');
const { calculateSuperTrend, closedCandles } = require('./SuperTrendScanner');

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function trueRange(c, prevClose = null) {
  const h = Number(c.high), l = Number(c.low), pc = Number(prevClose);
  if (!(h > 0 && l > 0)) return 0;
  if (!(pc > 0)) return h - l;
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const tr = candles.map((c, i) => trueRange(c, i ? candles[i - 1].close : null));
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i];
  let value = seed / period;
  for (let i = period + 1; i < candles.length; i++) value = ((value * (period - 1)) + tr[i]) / period;
  return value;
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const alpha = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += Number(values[i]);
  out[period - 1] = seed / period;
  for (let i = period; i < values.length; i++) out[i] = Number(values[i]) * alpha + Number(out[i - 1]) * (1 - alpha);
  return out;
}

function bollinger(candles, period = 20, stdDev = 2) {
  if (!Array.isArray(candles) || candles.length < period) return null;
  const closes = candles.map(c => Number(c.close));
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, x) => sum + Math.pow(x - middle, 2), 0) / period;
  const sd = Math.sqrt(Math.max(variance, 0));
  const upper = middle + sd * Number(stdDev);
  const lower = middle - sd * Number(stdDev);
  const width = upper - lower;
  return { middle, upper, lower, width, bandwidthPct: middle > 0 ? width / middle * 100 : 0 };
}

function macd(candles, fast = 12, slow = 26, signal = 9) {
  if (!Array.isArray(candles) || candles.length < slow + signal + 3) return null;
  const closes = candles.map(c => Number(c.close));
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) => fastEma[i] != null && slowEma[i] != null ? fastEma[i] - slowEma[i] : null);
  const valid = line.filter(v => v != null);
  const signalVals = ema(valid, signal);
  const combined = [];
  let vi = 0;
  for (let i = 0; i < line.length; i++) combined.push(line[i] == null ? null : signalVals[vi++]);
  const hist = line.map((v, i) => v != null && combined[i] != null ? v - combined[i] : null);
  const last = line.length - 1;
  const prev = last - 1;
  const prev2 = last - 2;
  const lastSignal = combined[last], prevSignal = combined[prev], prev2Signal = combined[prev2];
  if ([line[last], lastSignal, line[prev], prevSignal, line[prev2], prev2Signal].some(v => v == null)) return null;
  const histSeries = hist.slice(Math.max(0, last - 4), last + 1).filter(v => v != null);
  return {
    macd: line[last], signal: lastSignal, hist: hist[last],
    prevMacd: line[prev], prevSignal, prevHist: hist[prev],
    prev2Macd: line[prev2], prev2Signal, prev2Hist: hist[prev2],
    histSeries,
    bullishCross: line[last] >= lastSignal && line[prev] < prevSignal,
    bearishCross: line[last] <= lastSignal && line[prev] > prevSignal
  };
}

function bollingerAt(candles, endIndex, period = 20, stdDev = 2) {
  if (!Array.isArray(candles) || endIndex < period - 1) return null;
  const closes = candles.slice(endIndex - period + 1, endIndex + 1).map(c => Number(c.close));
  if (closes.some(v => !(v > 0))) return null;
  const middle = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((sum, x) => sum + Math.pow(x - middle, 2), 0) / period;
  const sd = Math.sqrt(Math.max(variance, 0));
  const upper = middle + sd * Number(stdDev);
  const lower = middle - sd * Number(stdDev);
  return { middle, upper, lower, width: upper - lower };
}

function bollingerSeries(candles, period = 20, stdDev = 2) {
  const out = [];
  if (!Array.isArray(candles)) return out;
  for (let i = period - 1; i < candles.length; i++) {
    const b = bollingerAt(candles, i, period, stdDev);
    if (b) out.push({ index: i, candle: candles[i], ...b });
  }
  return out;
}

function macdMomentum(candles, action, fast = 12, slow = 26, signal = 9, confirmBars = 3) {
  const need = Math.max(2, Math.min(3, Number(confirmBars) || 3));
  if (!Array.isArray(candles) || candles.length < slow + signal + need + 2) return null;
  const closes = candles.map(c => Number(c.close));
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) => fastEma[i] != null && slowEma[i] != null ? fastEma[i] - slowEma[i] : null);
  const validLine = line.filter(v => v != null);
  const signalVals = ema(validLine, signal);
  const sig = new Array(line.length).fill(null);
  let svi = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] == null) continue;
    sig[i] = signalVals[svi++] ?? null;
  }
  const h = line.map((v, i) => v != null && sig[i] != null ? v - sig[i] : null).filter(v => v != null);
  if (h.length < need + 1) return null;
  const recent = h.slice(-need - 1);
  const changes = recent.slice(1).map((v, i) => v - recent[i]);
  const toleranceBase = Math.max(Math.abs(recent[recent.length - 2] || 0) * 0.15, 1e-12);
  const improvingCount = action === 'LONG'
    ? changes.filter(v => v > 0).length
    : changes.filter(v => v < 0).length;
  // 最少出现一次动能改善；最后一根允许轻微噪声，但不能明显重新恶化。
  const lastChange = changes[changes.length - 1] || 0;
  const latestNotWorsening = action === 'LONG'
    ? lastChange >= -toleranceBase
    : lastChange <= toleranceBase;
  const improving = improvingCount >= 1 && latestNotWorsening;
  const lastMacd = line[line.length - 1], prevMacd = line[line.length - 2];
  const cross = action === 'LONG'
    ? lastMacd >= sig[sig.length - 1] && prevMacd < sig[sig.length - 2]
    : lastMacd <= sig[sig.length - 1] && prevMacd > sig[sig.length - 2];
  return {
    improving, cross, improvingCount, latestNotWorsening,
    histSeries: recent, changes, macd: lastMacd, signal: sig[sig.length - 1], hist: recent[recent.length - 1]
  };
}

function detectBollingerPullback(candles, action, period = 20, stdDev = 2, lookbackBars = 6) {
  const series = bollingerSeries(candles, period, stdDev);
  const lookback = Math.max(4, Number(lookbackBars) || 6);
  if (series.length < lookback + 1) return null;

  const recent = series.slice(-lookback);
  const maxReclaimBars = 3;
  const maxAgeBars = 4;
  let touch = null;
  let reclaim = null;

  // V13：轻量回踩状态机（保留旧函数仅用于兼容测试，不参与 V13 自动交易路径）。
  // 允许“先触轨/刺破 → 后续最多3根已收盘K线重新回到布林带”，
  // 并允许回踩确认后再经过1～2根K线寻找更好的被动 LIMIT 价格。
  for (let i = recent.length - 1; i >= 0; i--) {
    const x = recent[i];
    const touched = action === 'LONG'
      ? Number(x.candle.low) <= Number(x.lower)
      : Number(x.candle.high) >= Number(x.upper);
    if (!touched) continue;
    for (let j = i + 1; j <= Math.min(recent.length - 1, i + maxReclaimBars); j++) {
      const r = recent[j];
      const reentered = action === 'LONG'
        ? Number(r.candle.close) > Number(r.lower)
        : Number(r.candle.close) < Number(r.upper);
      if (reentered) {
        touch = x;
        reclaim = r;
        break;
      }
    }
    if (touch && reclaim) break;
  }

  if (!touch || !reclaim) return null;
  const current = series[series.length - 1];
  const currentClose = Number(current.candle.close);
  const pos = (currentClose - current.lower) / Math.max(current.width, 1e-12);
  const barsSinceTouch = current.index - touch.index;
  if (barsSinceTouch > maxAgeBars) return null;

  // 不要求当前价仍贴着外轨；只禁止已经远离回踩区域、穿过中轨太多的陈旧 setup。
  const currentInSetupZone = action === 'LONG' ? pos <= 0.85 : pos >= 0.15;
  if (!currentInSetupZone) return null;

  return {
    touchIndex: touch.index,
    touchCandleTime: touch.candle.openTime,
    touchPrice: action === 'LONG' ? Number(touch.candle.low) : Number(touch.candle.high),
    reclaimIndex: reclaim.index,
    reclaimCandleTime: reclaim.candle.openTime,
    reclaimPrice: Number(reclaim.candle.close),
    current,
    position: pos,
    barsSinceTouch,
    barsToReclaim: reclaim.index - touch.index,
    setupAgeBars: barsSinceTouch,
    state: 'TOUCH_RECLAIMED'
  };
}

function pivotLevels(candles, side) {
  const out = [];
  for (let i = 2; i < candles.length - 2; i++) {
    if (side === 'LONG') {
      const x = candles[i].low;
      if (x <= candles[i - 1].low && x <= candles[i - 2].low && x <= candles[i + 1].low && x <= candles[i + 2].low) out.push({ price: x, index: i });
    } else {
      const x = candles[i].high;
      if (x >= candles[i - 1].high && x >= candles[i - 2].high && x >= candles[i + 1].high && x >= candles[i + 2].high) out.push({ price: x, index: i });
    }
  }
  return out;
}

function clusterLevels(points, tolerance) {
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const avg = current.reduce((s, x) => s + x.price, 0) / current.length;
    if (Math.abs(sorted[i].price - avg) <= tolerance) current.push(sorted[i]);
    else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);
  return clusters.map(items => ({
    price: items.reduce((s, x) => s + x.price, 0) / items.length,
    touches: items.length,
    firstIndex: Math.min(...items.map(x => x.index)),
    lastIndex: Math.max(...items.map(x => x.index))
  }));
}

function findSupportResistance(candles, currentPrice, atrValue, { lookback = 60, clusterAtr = 0.25, maxDistanceAtr = 1.5, fallbackLookback = 12 } = {}) {
  const rows = candles.slice(-Math.max(20, lookback));
  const atrSafe = Number(atrValue);
  if (!(atrSafe > 0) || !(currentPrice > 0)) return { support: null, resistance: null, atr: atrSafe || null };
  const tolerance = atrSafe * clusterAtr;
  const supports = clusterLevels(pivotLevels(rows, 'LONG'), tolerance)
    .filter(x => x.price < currentPrice)
    .sort((a, b) => b.price - a.price);
  const resistances = clusterLevels(pivotLevels(rows, 'SHORT'), tolerance)
    .filter(x => x.price > currentPrice)
    .sort((a, b) => a.price - b.price);
  const maxDistance = atrSafe * maxDistanceAtr;
  let support = supports.find(x => currentPrice - x.price <= maxDistance) || null;
  let resistance = resistances.find(x => x.price - currentPrice <= maxDistance) || null;

  // 真实交易里新高/新低附近经常还没有形成“2左2右”完整 pivot，增加最近12根已收盘K线极值作为软回退水平。
  const recent = rows.slice(-Math.max(4, fallbackLookback));
  if (!support) {
    const lows = recent.map((c, i) => ({ price: Number(c.low), index: rows.length - recent.length + i })).filter(x => x.price > 0 && x.price < currentPrice);
    if (lows.length) {
      const x = lows.reduce((a, b) => b.price > a.price ? b : a);
      if (currentPrice - x.price <= maxDistance) support = { price: x.price, touches: 1, firstIndex: x.index, lastIndex: x.index, fallback: true };
    }
  }
  if (!resistance) {
    const highs = recent.map((c, i) => ({ price: Number(c.high), index: rows.length - recent.length + i })).filter(x => x.price > currentPrice);
    if (highs.length) {
      const x = highs.reduce((a, b) => b.price < a.price ? b : a);
      if (x.price - currentPrice <= maxDistance) resistance = { price: x.price, touches: 1, firstIndex: x.index, lastIndex: x.index, fallback: true };
    }
  }
  return {
    atr: atrSafe,
    support,
    resistance,
    supportCandidates: [support, ...supports].filter(Boolean).slice(0, 5),
    resistanceCandidates: [resistance, ...resistances].filter(Boolean).slice(0, 5)
  };
}

function reversalConfirmation(candles, action, level, atrValue, lookback = 3) {
  if (!candles.length || !(Number(level) > 0) || !(Number(atrValue) > 0)) return false;
  const atrSafe = Number(atrValue);
  const zone = Math.max(atrSafe * 0.35, atrSafe * 0.08);
  const recent = candles.slice(-Math.max(1, Number(lookback) || 3));
  const touched = recent.some(c => action === 'LONG' ? Number(c.low) <= Number(level) + zone : Number(c.high) >= Number(level) - zone);
  if (!touched) return false;
  const c = candles[candles.length - 1];
  const p = candles.length > 1 ? candles[candles.length - 2] : null;
  const body = Math.abs(Number(c.close) - Number(c.open));
  const lowerWick = Math.max(0, Math.min(Number(c.open), Number(c.close)) - Number(c.low));
  const upperWick = Math.max(0, Number(c.high) - Math.max(Number(c.open), Number(c.close)));
  if (action === 'LONG') {
    const reclaim = Number(c.close) > Number(level);
    const bullishBody = Number(c.close) > Number(c.open) && body >= atrSafe * 0.02;
    const higherClose = p && Number(c.close) >= Number(p.close);
    const wick = lowerWick >= Math.max(body * 0.35, atrSafe * 0.015);
    const engulf = p && Number(p.close) < Number(p.open) && Number(c.close) >= Number(p.open) && Number(c.open) <= Number(p.close);
    return reclaim && (bullishBody || higherClose || wick || engulf);
  }
  const reclaim = Number(c.close) < Number(level);
  const bearishBody = Number(c.close) < Number(c.open) && body >= atrSafe * 0.02;
  const lowerClose = p && Number(c.close) <= Number(p.close);
  const wick = upperWick >= Math.max(body * 0.35, atrSafe * 0.015);
  const engulf = p && Number(p.close) > Number(p.open) && Number(c.close) <= Number(p.open) && Number(c.open) >= Number(p.close);
  return reclaim && (bearishBody || lowerClose || wick || engulf);
}


function rsiSeries(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 2) return [];
  const closes = candles.map(c => Number(c.close));
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) { avgGain += gains[i]; avgLoss += losses[i]; }
  avgGain /= period; avgLoss /= period;
  const out = new Array(closes.length).fill(null);
  const calc = () => avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - (100 / (1 + avgGain / avgLoss));
  out[period] = calc();
  for (let i = period + 1; i < closes.length; i++) {
    avgGain = ((avgGain * (period - 1)) + gains[i - 1]) / period;
    avgLoss = ((avgLoss * (period - 1)) + losses[i - 1]) / period;
    out[i] = calc();
  }
  return out.filter(v => v != null);
}

function classifyRsiTriggerValues(values, action, threshold, depthThreshold, triggerLookbackBars = 2, depthLookbackBars = 6) {
  const actionName = String(action || '').toUpperCase();
  const triggerLookback = Math.max(1, Math.min(3, Number(triggerLookbackBars) || 2));
  const depthLookback = Math.max(3, Math.min(12, Number(depthLookbackBars) || 6));
  const nums = Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
  if (nums.length < Math.max(triggerLookback, depthLookback) + 1) return null;

  // 关键边界：深度回看只检查“当前触发K线之前”的最近 depthLookback 个 RSI，严格排除 now。
  // triggerLookback 同样只检查 now 之前的最近 triggerLookback 个 RSI，当前K只负责回升/斜率确认。
  const now = nums[nums.length - 1];
  const previous = nums[nums.length - 2];
  const triggerPrev = nums.slice(-(triggerLookback + 1), -1);
  const depthPrev = nums.slice(-(depthLookback + 1), -1);
  const actionLong = actionName === 'LONG';
  const depthExtreme = actionLong ? Math.min(...depthPrev) : Math.max(...depthPrev);
  const depthReached = actionLong
    ? depthExtreme <= Number(depthThreshold)
    : depthExtreme >= Number(depthThreshold);
  const recoveryConfirmed = actionLong
    ? now >= Number(threshold)
    : now <= Number(threshold);
  const crossed = actionLong
    ? triggerPrev.some(v => v < Number(threshold)) && recoveryConfirmed
    : triggerPrev.some(v => v > Number(threshold)) && recoveryConfirmed;
  const slopeConfirmed = actionLong ? now > previous : now < previous;

  // V13.4：不再短路。reason 保留首个失败项兼容旧 UI/统计，reasons 返回全部失败条件。
  const reasons = [];
  if (!depthReached) reasons.push('RSI_DEPTH_NOT_REACHED');
  if (!crossed) reasons.push('RSI_RECOVERY_NOT_CONFIRMED');
  if (!slopeConfirmed) reasons.push('RSI_SLOPE_NOT_CONFIRMED');
  const reason = reasons[0] || null;

  return {
    confirmed: reasons.length === 0,
    reason,
    reasons,
    value: now,
    previous,
    threshold: Number(threshold),
    depthThreshold: Number(depthThreshold),
    depthExtreme,
    depthReached,
    recoveryConfirmed,
    crossed,
    slopeConfirmed,
    triggerLookback,
    depthLookback,
    triggerSeries: triggerPrev.slice(),
    depthSeries: depthPrev.slice()
  };
}

function rsiTrigger(candles, action, period = 14, threshold = action === 'LONG' ? 40 : 60, lookbackBars = 2, depthThreshold = action === 'LONG' ? 35 : 65, depthLookbackBars = 6) {
  const vals = rsiSeries(candles, period);
  const result = classifyRsiTriggerValues(vals, action, threshold, depthThreshold, lookbackBars, depthLookbackBars);
  if (!result) return null;
  return {
    ...result,
    triggerIndex: candles.length - 1,
    triggerCandle: candles[candles.length - 1] || null,
    series: vals.slice(-(Math.max(result.triggerLookback, result.depthLookback) + 1))
  };
}

function precisionEntry(candles, action, atrValue, mark, tickSize = 0, { lookbackBars = 4, offsetAtr = 0.15, retraceRatio = 0.38 } = {}) {
  if (!Array.isArray(candles) || candles.length < 3 || !(atrValue > 0) || !(mark > 0)) return null;
  const lookback = Math.max(3, Math.min(5, Number(lookbackBars) || 4));
  const setupBars = candles.slice(-lookback);
  if (setupBars.length < 3) return null;
  const recentLow = Math.min(...setupBars.map(c => Number(c.low)));
  const recentHigh = Math.max(...setupBars.map(c => Number(c.high)));
  const signal = candles[candles.length - 1];
  const signalLow = Number(signal.low), signalHigh = Number(signal.high), signalClose = Number(signal.close);
  if (![recentLow, recentHigh, signalLow, signalHigh, signalClose].every(Number.isFinite)) return null;

  // 三个独立的“价格参考”都来自K线结构，而不是新增指标：
  // 1) 最近结构极值；2) RSI触发K线中位位置；3) 从结构极值到触发收盘价的38.2%回撤。
  const structureEntry = action === 'LONG'
    ? recentLow + atrValue * Math.max(0, Math.min(0.8, Number(offsetAtr)))
    : recentHigh - atrValue * Math.max(0, Math.min(0.8, Number(offsetAtr)));
  const candleMidEntry = (signalLow + signalHigh) / 2;
  const rr = Math.max(0.2, Math.min(0.7, Number(retraceRatio) || 0.38));
  const retraceEntry = action === 'LONG'
    ? signalClose - (signalClose - recentLow) * rr
    : signalClose + (recentHigh - signalClose) * rr;

  const refs = [structureEntry, candleMidEntry, retraceEntry].filter(Number.isFinite).sort((a, b) => a - b);
  const median = refs.length === 3 ? refs[1] : refs[0];
  const safety = tickSize > 0 ? tickSize * 2 : mark * 0.0001;
  const raw = action === 'LONG' ? Math.min(median, mark - safety) : Math.max(median, mark + safety);
  if (!(raw > 0)) return null;
  const distanceAtr = Math.abs(mark - raw) / atrValue;
  const levelToExtremeAtr = action === 'LONG'
    ? Math.abs(raw - recentLow) / atrValue
    : Math.abs(recentHigh - raw) / atrValue;
  return {
    entryRaw: raw,
    recentLow,
    recentHigh,
    structureEntry,
    candleMidEntry,
    retraceEntry,
    retraceRatio: rr,
    distanceAtr,
    levelToExtremeAtr,
    signalCandleTime: Number(signal.openTime || 0),
    signalCandleRange: Math.max(0, signalHigh - signalLow),
    signalCandleCloseLocation: signalHigh > signalLow ? (signalClose - signalLow) / (signalHigh - signalLow) : 0.5
  };
}

function rsiExitReverse(candles, action, period = 14, threshold) {
  const vals = rsiSeries(candles, period);
  if (vals.length < 2) return false;
  const a = vals[vals.length - 2], b = vals[vals.length - 1];
  return action === 'LONG' ? (a >= threshold && b < threshold) : (a <= threshold && b > threshold);
}

function volumeConfirmation(candles, period = 20, minRatio = 0.9) {
  if (!Array.isArray(candles) || candles.length < period + 2) return null;
  const current = Number(candles[candles.length - 1].volume || 0);
  const baseRows = candles.slice(-(period + 1), -1);
  const avg = baseRows.reduce((sum, c) => sum + Number(c.volume || 0), 0) / period;
  if (!(current >= 0) || !(avg > 0)) return null;
  return { current, average: avg, ratio: current / avg, minRatio: Number(minRatio), strong: current / avg >= 1.2 };
}

function superTrendMarketState(candles, period = 10, multiplier = 3, lookbackBars = 6, maxFlipCount = 2, minRangeAtr = 1.0, minEfficiency = 0.22) {
  const lookback = Math.max(4, Math.min(10, Number(lookbackBars) || 6));
  if (!Array.isArray(candles) || candles.length < period + lookback + 3) return null;
  const dirs = [];
  for (let end = period + 3; end < candles.length; end++) {
    const st = calculateSuperTrend(candles.slice(0, end + 1), period, multiplier);
    if (st?.direction) dirs.push({ index: end, direction: st.direction });
  }
  const recentDirs = dirs.slice(-lookback);
  let flips = 0;
  for (let i = 1; i < recentDirs.length; i++) {
    if (recentDirs[i].direction !== recentDirs[i - 1].direction) flips++;
  }
  const recentBars = candles.slice(-lookback);
  const hi = Math.max(...recentBars.map(c => Number(c.high)));
  const lo = Math.min(...recentBars.map(c => Number(c.low)));
  const range = Math.max(0, hi - lo);
  const firstOpen = Number(recentBars[0]?.open);
  const lastClose = Number(recentBars.at(-1)?.close);
  const efficiency = range > 0 && Number.isFinite(firstOpen) && Number.isFinite(lastClose)
    ? Math.abs(lastClose - firstOpen) / range
    : null;
  const rangeAtr = atr(candles.slice(-Math.max(period + lookback + 2, 30)), period);
  const normalizedRange = rangeAtr > 0 ? range / rangeAtr : null;
  const lowEfficiency = efficiency != null && efficiency < Number(minEfficiency);
  const compressedRange = normalizedRange != null && normalizedRange < Number(minRangeAtr);
  // 两种轻量震荡识别：高频翻转；或有翻转但价格走势效率很低/波动被压缩。
  const choppy = flips > Number(maxFlipCount)
    || (flips >= Number(maxFlipCount) && compressedRange)
    || (flips >= 1 && lowEfficiency && normalizedRange != null && normalizedRange < Math.max(2.5, Number(minRangeAtr) * 1.5));
  return {
    flips,
    lookbackBars: lookback,
    range,
    rangeAtr,
    normalizedRange,
    efficiency,
    choppy,
    direction: recentDirs.at(-1)?.direction || null
  };
}

function shouldExitRulePosition({ profitable, rsiReverse, trendReverse, lossReverseCount = 0, lossExitConfirmBars = 2 } = {}) {
  const profitExit = !!profitable && (!!rsiReverse || !!trendReverse);
  const lossExit = !profitable && !!rsiReverse && !!trendReverse && Number(lossReverseCount) >= Number(lossExitConfirmBars || 2);
  return { exit: profitExit || lossExit, profitExit, lossExit };
}

function plannedProtectionPercents(config, leverage) {
  const p = config.get().protection || {};
  const mode = String(p.calculationMode || 'MARGIN').toUpperCase();
  if (mode === 'PRICE') return { mode, slPct: Number(p.stopLossPct || 0), tpPct: Number(p.takeProfitPct || 0) };
  return {
    mode,
    slPct: Number(p.stopLossMarginPct || 0) / Number(leverage || 0),
    tpPct: Number(p.takeProfitMarginPct || 0) / Number(leverage || 0)
  };
}

function utcDayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function defaultRuleStats(date = utcDayKey()) {
  return {
    date,
    scans: 0,
    candidates: 0,
    signalGenerated: 0,
    ordersPlaced: 0,
    filledOrders: 0,
    partialFills: 0,
    ttlCanceled: 0,
    canceledOrders: 0,
    expiredOrders: 0,
    orderFailed: 0,
    totalFillWaitMs: 0,
    lastScanAt: 0,
    lastOrderAt: 0,
    lastFillAt: 0,
    reasonCounts: {}
  };
}

function normalizeRuleStats(saved) {
  const day = utcDayKey();
  if (!saved || saved.date !== day) return defaultRuleStats(day);
  const base = defaultRuleStats(day);
  const legacyReasons = { ...(saved.reasonCounts || {}) };
  // V13.3开始 reason code 拆分。旧版当天的总量不能伪装成新分类，因此保留为明确的 LEGACY 项。
  if (legacyReasons.RSI_TRIGGER_NOT_CONFIRMED != null) {
    legacyReasons.LEGACY_RSI_TRIGGER_NOT_CONFIRMED = Number(legacyReasons.LEGACY_RSI_TRIGGER_NOT_CONFIRMED || 0) + Number(legacyReasons.RSI_TRIGGER_NOT_CONFIRMED || 0);
    delete legacyReasons.RSI_TRIGGER_NOT_CONFIRMED;
  }
  return {
    ...base,
    ...saved,
    reasonCounts: { ...base.reasonCounts, ...legacyReasons },
    scans: Number(saved.scans || 0), candidates: Number(saved.candidates || 0),
    signalGenerated: Number(saved.signalGenerated || 0), ordersPlaced: Number(saved.ordersPlaced || 0),
    filledOrders: Number(saved.filledOrders || 0), partialFills: Number(saved.partialFills || 0),
    ttlCanceled: Number(saved.ttlCanceled || 0), canceledOrders: Number(saved.canceledOrders || 0),
    expiredOrders: Number(saved.expiredOrders || 0), orderFailed: Number(saved.orderFailed || 0),
    totalFillWaitMs: Number(saved.totalFillWaitMs || 0)
  };
}

class RuleAutoTrader {
  constructor({ binance, ranking, risk, config, state, emergency }) {
    Object.assign(this, { binance, ranking, risk, config, state, emergency });
    this.running = false;
    this.scanBusy = false;
    this.scanTimer = null;
    this.maintenanceTimer = null;
    this.lastScanAt = 0;
    this.lastSuccessfulAt = 0;
    this.nextScanAt = 0;
    this.lastError = null;
    this.lastSummary = null;
    this.lastSignal = null;
    this.pending = new Map();
    this.recentRuleFills = new Map();
    this.ruleExitBusy = new Set();
    this.exitCheckedAt = new Map();
    this.klineCache = new Map();
    this.lastExit = null;
    this.lastExitScanAt = 0;
    this.exitReverseState = new Map();
    this.countedOrderEvents = new Set();
    this.localRuleStats = defaultRuleStats();
    this.maxConcurrency = 3;
  }

  get cfg() { return this.config.get().ruleTrading || {}; }
  key(symbol, positionSide) { return `${normalizeSymbol(symbol)}|${String(positionSide || 'BOTH').toUpperCase()}`; }
  enabled() { return this.cfg.enabled === true; }
  canContinue() { return this.running && this.enabled(); }

  statusLabel() {
    if (!this.enabled()) return '关闭';
    if (!this.running) return '已停止';
    if (this.scanBusy) return '扫描中';
    if (this.lastError) return '异常';
    if (this.lastSuccessfulAt) return '正常';
    return '等待首次扫描';
  }

  getStatus() {
    return {
      enabled: this.enabled(),
      running: this.running,
      status: this.statusLabel(),
      intervalMs: 60000,
      timeframe: '1m',
      trendTimeframe: '5m',
      topN: Math.max(1, Math.min(50, Number(this.cfg.topN ?? 20))),
      lastScanAt: this.lastScanAt,
      lastSuccessfulAt: this.lastSuccessfulAt,
      nextScanAt: this.nextScanAt,
      lastError: this.lastError,
      lastSignal: this.lastSignal ? { ...this.lastSignal } : null,
      lastExit: this.lastExit ? { ...this.lastExit } : null,
      lastSummary: this.lastSummary,
      pendingOrders: [...this.pending.values()].map(x => ({ ...x })),
      recentFills: [...this.recentRuleFills.values()]
        .filter(x => Date.now() - x.at < 30 * 60 * 1000)
        .map(x => ({ ...x })),
      stats: this.getRuleStats(),
      activeParams: this.settingsSummary()
    };
  }

  getRuleStats() {
    const stored = typeof this.state.rawGet === 'function' ? this.state.rawGet('ruleTradingStats', null) : null;
    const s = normalizeRuleStats(stored || this.localRuleStats);
    const placed = Number(s.ordersPlaced || 0);
    const filled = Number(s.filledOrders || 0);
    return {
      ...s,
      orderFillRatePct: placed > 0 ? Number((filled / placed * 100).toFixed(2)) : 0,
      signalToFillRatePct: Number(s.signalGenerated || 0) > 0 ? Number((filled / Number(s.signalGenerated) * 100).toFixed(2)) : 0,
      averageFillWaitMs: filled > 0 ? Math.round(Number(s.totalFillWaitMs || 0) / filled) : 0,
      averageFillWaitSec: filled > 0 ? Number((Number(s.totalFillWaitMs || 0) / filled / 1000).toFixed(1)) : 0
    };
  }

  // 资金费率判定：只拦"自己要付费"的方向。
  // 做多在正费率时付费、做空在负费率时付费；反向的高费率对持仓者是收益，不该拦。
  // 阈值单位是百分比（0.07 = 0.07%）；<=0 表示关闭过滤。
  shouldBlockForFunding(action, ratePct, maxFundingPct) {
    const max = Number(maxFundingPct);
    if (!(max > 0)) return false;
    const rate = Number(ratePct);
    if (!Number.isFinite(rate)) return false;
    return String(action).toUpperCase() === 'LONG' ? rate > max : rate < -max;
  }

  // 逐阶段通过率漏斗。
  // 语义是「通过人数」而非「失败人数」：每一格 = 走到该阶段且全部条件通过的币数，
  // 因此天然单调不增。用单值 stage 计数（而非 reasonCounts）保证一币只算一次 ——
  // RSI 阶段一个币可能同时命中深度/回升/斜率多个 reasons，相加会超过候选总数。
  buildFunnel({ decisions, candidates, ordersPlaced, indicatorPass }) {
    const list = Array.isArray(decisions) ? decisions : [];
    const blockedAt = (name) => list.filter(d => d && d.stage === name).length;

    // 诚实性保障：任何未通过但没打 stage 的决策都会让漏斗失真（会被静默算进 RSI 阶段）。
    // 生产代码所有返回点都已打标记；这里兜底是为了让"忘记打标记"这种 bug 显性化，而不是给出貌似合理的错数。
    const KNOWN = ['PRECHECK', 'FUNDING', 'TREND', 'RSI', 'VOLUME', 'ENTRY', 'RISK', 'PASS', 'PLACE', 'ERROR'];
    const unstaged = list.filter(d => {
      if (!d) return false;
      if (d.status === 'READY' || d.status === 'ORDER_PLACED') return false;
      return !KNOWN.includes(d.stage);
    }).length;

    // 进入趋势阶段前出局：前置校验未过 + 评估异常
    const blockedPreTrend = blockedAt('PRECHECK') + blockedAt('ERROR');
    const enteredFunding = Math.max(0, Number(candidates || 0) - blockedPreTrend);
    const passedFunding = Math.max(0, enteredFunding - blockedAt('FUNDING'));
    const enteredTrend = passedFunding;
    const passedTrend = Math.max(0, enteredTrend - blockedAt('TREND'));

    // 进入 RSI 的池子 = 通过趋势的币（RSI 失败者 + 继续往后走的全部币）
    const rsiPool = list.filter(d => ['RSI', 'VOLUME', 'ENTRY', 'RISK', 'PASS', 'PLACE'].includes(d?.stage));
    // 能走到 VOLUME 及之后，在构造上就等价于 RSI 三条件全过 —— 这些返回对象不携带
    // RSI 布尔量（只有 rsi 数值），所以必须按 stage 判定，不能只看字段。
    const passedWholeRsi = (d) => ['VOLUME', 'ENTRY', 'RISK', 'PASS', 'PLACE'].includes(d?.stage);
    // RSI 失败时 rsi 是数值、布尔量在顶层；通过时 rsi 是对象。两种形状统一取。
    const rsiFlags = (d) => {
      const nested = d?.rsi && typeof d.rsi === 'object' ? d.rsi : null;
      return {
        depth: Boolean(d?.rsiDepthReached ?? nested?.depthReached),
        crossed: Boolean(d?.rsiCrossed ?? nested?.crossed),
        slope: Boolean(d?.rsiSlopeConfirmed ?? nested?.slopeConfirmed)
      };
    };
    // RSI 三条件不短路，用累积条件统计才能保证漏斗单调
    let passedDepth = 0, passedRecovery = 0, passedSlope = 0;
    for (const d of rsiPool) {
      if (passedWholeRsi(d)) { passedDepth++; passedRecovery++; passedSlope++; continue; }
      const f = rsiFlags(d);
      if (f.depth) passedDepth++;
      if (f.depth && f.crossed) passedRecovery++;
      if (f.depth && f.crossed && f.slope) passedSlope++;
    }

    const passedVolume = Math.max(0, passedSlope - blockedAt('VOLUME'));
    const passedEntry = Math.max(0, passedVolume - blockedAt('ENTRY'));
    const passedRisk = Math.max(0, passedEntry - blockedAt('RISK'));
    const passedPlace = Math.max(0, passedRisk - blockedAt('PLACE'));

    const stages = [
      { key: 'FUNDING', entered: enteredFunding, passed: passedFunding, blocked: blockedAt('FUNDING') },
      { key: 'TREND', entered: enteredTrend, passed: passedTrend, blocked: blockedAt('TREND') },
      { key: 'RSI_DEPTH', entered: passedTrend, passed: passedDepth, blocked: passedTrend - passedDepth },
      { key: 'RSI_RECOVERY', entered: passedDepth, passed: passedRecovery, blocked: passedDepth - passedRecovery },
      { key: 'RSI_SLOPE', entered: passedRecovery, passed: passedSlope, blocked: passedRecovery - passedSlope },
      { key: 'VOLUME', entered: passedSlope, passed: passedVolume, blocked: blockedAt('VOLUME') },
      { key: 'ENTRY', entered: passedVolume, passed: passedEntry, blocked: blockedAt('ENTRY') },
      { key: 'RISK', entered: passedEntry, passed: passedRisk, blocked: blockedAt('RISK') },
      { key: 'PLACE', entered: passedRisk, passed: passedPlace, blocked: blockedAt('PLACE') }
    ];

    // 参数敏感度：只在 RSI 深度 0 通过时给「放宽到多少才有第一个币」，用现有数据推算而非猜阈值。
    let rsiSensitivity = null;
    if (passedDepth === 0 && rsiPool.length) {
      const extremes = (dir) => rsiPool
        .filter(d => d?.action === dir)
        .map(d => Number(d?.rsiDepthExtreme ?? (d?.rsi && typeof d.rsi === 'object' ? d.rsi.depthExtreme : NaN)))
        .filter(Number.isFinite);
      const longExtremes = extremes('LONG');
      const shortExtremes = extremes('SHORT');
      rsiSensitivity = {
        longCurrentDepth: Number(this.cfg.rsiLongDepth ?? 35),
        shortCurrentDepth: Number(this.cfg.rsiShortDepth ?? 65),
        longNeedsDepth: longExtremes.length ? Number(Math.min(...longExtremes).toFixed(2)) : null,
        shortNeedsDepth: shortExtremes.length ? Number(Math.max(...shortExtremes).toFixed(2)) : null
      };
    }

    return {
      candidates: Number(candidates || 0),
      preTrendBlocked: blockedPreTrend,
      indicatorPass: Number(indicatorPass || 0),
      ordersPlaced: Number(ordersPlaced || 0),
      stages,
      rsiSensitivity,
      // >0 表示有决策未打 stage 标记，漏斗数字不可信，前端应显示告警而不是照常展示。
      unstaged,
      degraded: unstaged > 0
    };
  }

  saveRuleStats(stats) {
    const normalized = normalizeRuleStats(stats);
    this.localRuleStats = normalized;
    if (typeof this.state.rawSet === 'function') this.state.rawSet('ruleTradingStats', normalized);
  }

  updateRuleStats(mutator) {
    const stored = typeof this.state.rawGet === 'function' ? this.state.rawGet('ruleTradingStats', null) : null;
    const s = normalizeRuleStats(stored || this.localRuleStats);
    mutator(s);
    s.date = utcDayKey();
    this.saveRuleStats(s);
    return this.getRuleStats();
  }

  countReason(reason, amount = 1) {
    if (!reason) return;
    this.updateRuleStats(s => { s.reasonCounts[reason] = Number(s.reasonCounts[reason] || 0) + amount; });
  }

  markOrderEnded(orderId, kind) {
    const key = `${String(orderId)}|ENDED`;
    if (this.countedOrderEvents.has(key)) return false;
    this.countedOrderEvents.add(key);
    if (this.countedOrderEvents.size > 5000) this.countedOrderEvents.clear();
    this.updateRuleStats(s => {
      if (kind === 'TTL') s.ttlCanceled++;
      else if (kind === 'CANCELED') s.canceledOrders++;
      else if (kind === 'EXPIRED') s.expiredOrders++;
      else if (kind === 'FAILED') s.orderFailed++;
    });
    return true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.scheduleNextScan(true);
    this.exitReverseState.clear();
    this.maintenanceTimer = setInterval(() => {
      this.maintainPending().catch(e => Logger.error('规则自动交易挂单维护失败', { error: e, code: e?.code ?? null, status: e?.status ?? null }));
    }, 2000);
    Logger.info('规则自动交易已启动', { ...this.settingsSummary(), strategy: 'RULE_NO_AI' });
  }

  stop(reason = 'MANUAL_STOP') {
    this.running = false;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.scanTimer = null;
    this.maintenanceTimer = null;
    this.exitReverseState.clear();
    // 规则自动交易关闭后，不留下新的自动 LIMIT；已有手动仓位保护不受影响。
    for (const item of [...this.pending.values()]) {
      void this.cancelPendingItem(item, 'RULE_TRADING_STOP').catch(() => {});
    }
    Logger.info('规则自动交易已停止', { reason });
  }

  settingsSummary() {
    const c = this.cfg;
    return {
      topN: Math.max(1, Math.min(50, Number(c.topN ?? 20))),
      scanIntervalMs: 60000,
      signalTimeframe: '1m',
      trendTimeframe: '5m',
      leverage: Number(c.leverage || 10),
      riskPerTradePct: Number(c.riskPerTradePct ?? this.config.get().risk?.riskPerTradePct ?? 1),
      maxPositions: Number(c.maxPositions || 1),
      maxPendingOrders: Number(c.maxPendingOrders || 2),
      ttlMinutes: Number(c.orderTtlMinutes || 5),
      cooldownMinutes: Number(c.cooldownMinutes || 10),
      rsiPeriod: Number(c.rsiPeriod || 14),
      rsiLongTrigger: Number(c.rsiLongTrigger ?? 40),
      rsiShortTrigger: Number(c.rsiShortTrigger ?? 60),
      rsiLookbackBars: Number(c.rsiLookbackBars ?? 2),
      rsiLongDepth: Number(c.rsiLongDepth ?? 35),
      rsiShortDepth: Number(c.rsiShortDepth ?? 65),
      rsiDepthLookbackBars: Number(c.rsiDepthLookbackBars ?? 6),
      volumePeriod: Number(c.volumePeriod || 20),
      volumeMinRatio: Number(c.volumeMinRatio ?? 0.9),
      volumeStrongRatio: Number(c.volumeStrongRatio ?? 1.2),
      entryLookbackBars: Number(c.entryLookbackBars ?? 3),
      entryOffsetAtr: Number(c.entryOffsetAtr ?? 0.15),
      entryRetraceRatio: Number(c.entryRetraceRatio ?? 0.38),
      marketStateLookbackBars: Number(c.marketStateLookbackBars ?? 6),
      marketStateMaxFlipCount: Number(c.marketStateMaxFlipCount ?? 2),
      marketStateMinRangeAtr: Number(c.marketStateMinRangeAtr ?? 1.0),
      maxEntryDistanceAtr: Number(c.maxEntryDistanceAtr ?? 1.5),
      stFlipCooldownBars: Number(c.stFlipCooldownBars ?? 1),
      minRuleSLPct: Number(c.minRuleSLPct ?? 0.4),
      maxRuleSLPct: Number(c.maxRuleSLPct ?? 2.5),
      ruleTakeProfitRR: Number(c.ruleTakeProfitRR ?? 2),
      exitOnIndicatorReverse: c.exitOnIndicatorReverse !== false,
      exitRsiLong: Number(c.exitRsiLong ?? 60),
      exitRsiShort: Number(c.exitRsiShort ?? 40),
      entryMode: 'V13.3_TREND_RSI_DEPTH_VOLUME_PULLBACK',
      lossExitConfirmBars: Number(c.lossExitConfirmBars ?? 2),
      marketStateMinEfficiency: Number(c.marketStateMinEfficiency ?? 0.22)
    };
  }

  scheduleNextScan(initial = false) {
    if (!this.running) return;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    const now = Date.now();
    const delay = initial ? 1500 : (60000 - (now % 60000)) + 1000;
    this.nextScanAt = now + delay;
    this.scanTimer = setTimeout(async () => {
      if (!this.running) return;
      try {
        await this.scan();
      } catch (e) {
        this.lastError = e?.message || String(e);
        Logger.error('规则自动交易扫描失败', { error: e, code: e?.code ?? null, status: e?.status ?? null });
      } finally {
        this.scheduleNextScan(false);
      }
    }, delay);
  }

  async cancelPendingItem(item, reason) {
    const orderId = String(item.orderId);
    try {
      const open = await this.binance.fetchOpenOrders(item.symbol);
      const found = (open || []).find(o => String(o.orderId) === orderId || String(o.clientOrderId) === String(item.clientOrderId));
      if (found && ['NEW', 'PARTIALLY_FILLED'].includes(String(found.status || '').toUpperCase())) {
        await this.binance.cancelOrder(item.symbol, orderId, item.clientOrderId);
        this.markOrderEnded(orderId, reason === 'ORDER_TTL_EXPIRED' ? 'TTL' : 'CANCELED');
        Logger.info('规则自动交易自动挂单已取消', {
          traceId: item.traceId || null,
          symbol: item.symbol,
          positionSide: item.positionSide,
          orderId,
          clientOrderId: item.clientOrderId,
          reason
        });
      }
    } finally {
      this.pending.delete(orderId);
    }
  }

  async maintainPending() {
    const now = Date.now();
    if (this.pending.size) {
      const ttl = Number(this.cfg.orderTtlMinutes || 5) * 60 * 1000;
      for (const item of [...this.pending.values()]) {
        if (now - Number(item.createdAt || 0) < ttl) continue;
        try {
          await this.cancelPendingItem(item, 'ORDER_TTL_EXPIRED');
        } catch (e) {
          Logger.warn('规则自动交易挂单到期取消失败', {
            symbol: item.symbol,
            positionSide: item.positionSide,
            orderId: item.orderId,
            clientOrderId: item.clientOrderId,
            error: e,
            code: e?.code ?? null,
            status: e?.status ?? null
          });
        }
      }
    }
    for (const [k, v] of this.recentRuleFills) {
      if (now - v.at > 30 * 60 * 1000) this.recentRuleFills.delete(k);
    }
    // 指标平仓不依赖 pending：LIMIT 一旦成交，pending 会立即清空，但规则仓位仍需持续监控。
    if (now - Number(this.lastExitScanAt || 0) >= 8000) {
      this.lastExitScanAt = now;
      await this.monitorRuleExits();
    }
  }

  shouldTagPosition(p) {
    const key = this.key(p.symbol, p.positionSide);
    const x = this.recentRuleFills.get(key);
    return !!x && Date.now() - x.at < 30 * 60 * 1000;
  }

  handleUserEvent(e) {
    if (e?.e !== 'ORDER_TRADE_UPDATE') return;
    const o = e.o || {};
    const cid = String(o.c || '');
    if (!cid.startsWith('QP_RULE_')) return;
    const symbol = normalizeSymbol(o.s);
    const positionSide = String(o.ps || 'BOTH').toUpperCase();
    const status = String(o.X || '').toUpperCase();
    const orderId = String(o.i || '');
    const plan = this.pending.get(orderId) || this.state.getRuleOrderPlan?.(cid) || null;
    if (['CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH'].includes(status)) {
      const item = this.pending.get(orderId);
      const ttlExpired = item?.expiresAt && Date.now() >= Number(item.expiresAt) - 1500;
      this.pending.delete(orderId);
      this.state.deleteRuleOrderPlan?.(cid);
      this.markOrderEnded(orderId, status.startsWith('EXPIRED') ? 'EXPIRED' : (ttlExpired ? 'TTL' : 'CANCELED'));
      Logger.info('规则自动交易挂单状态结束', { symbol, positionSide, orderId, clientOrderId: cid, status, ttlExpired: !!ttlExpired });
      return;
    }
    const pendingItem = this.pending.get(orderId);
    if (status === 'PARTIALLY_FILLED') {
      const old = this.pending.get(orderId);
      if (old) {
        old.status = status;
        old.executedQty = Number(o.z || o.l || old.executedQty || 0);
      }
    }
    if (status === 'FILLED') this.pending.delete(orderId);
    if (['FILLED', 'PARTIALLY_FILLED'].includes(status) || String(o.x || '').toUpperCase() === 'TRADE') {
      const fill = { symbol, positionSide, orderId, clientOrderId: cid, at: Date.now(), avgPrice: Number(o.ap || o.L || 0), qty: Number(o.z || o.l || 0), status };
      this.recentRuleFills.set(this.key(symbol, positionSide), fill);
      if (typeof this.state.setRuleCooldown === 'function') this.state.setRuleCooldown(symbol, Date.now() + Number(this.cfg.cooldownMinutes || 10) * 60000);
      // 部分成交也已经形成真实仓位，必须立即把V13.3规则的SL/TP参数写入保护状态，不能等到完全成交。
      if (plan) {
        const sl = Number(plan.plannedSLPct || 0), tp = Number(plan.plannedTPPct || 0);
        if (sl > 0 && tp > 0) {
          this.state.setProtectionParams?.({ symbol, positionSide }, { mode: 'PRICE', stopLossPct: sl, takeProfitPct: tp, source: 'RULE_V13.3_STRUCTURE_PULLBACK', setupEntry: Number(plan.entry || fill.avgPrice || 0), setupStop: Number(plan.stopPrice || 0), setupTarget: Number(plan.tpPrice || 0), ruleOrderId: orderId });
          Logger.info(status === 'FILLED' ? '规则V13.3成交保护参数已写入' : '规则V13.3部分成交保护参数已提前写入', { symbol, positionSide, orderId, stopLossPct: sl, takeProfitPct: tp, source: 'RULE_V13.3_STRUCTURE_PULLBACK' });
        }
        if (status === 'FILLED') this.state.deleteRuleOrderPlan?.(cid);
      }
      if (status === 'PARTIALLY_FILLED') {
        const partialKey = `${orderId}|PARTIAL`;
        if (!this.countedOrderEvents.has(partialKey)) {
          this.countedOrderEvents.add(partialKey);
          this.updateRuleStats(s => { s.partialFills++; });
        }
      }
      if (status === 'FILLED' && !this.countedOrderEvents.has(`${orderId}|FILLED`)) {
        this.countedOrderEvents.add(`${orderId}|FILLED`);
        const planCreated = Number(plan?.createdAt || pendingItem?.createdAt || 0);
        const waitMs = planCreated > 0 ? Math.max(0, Date.now() - planCreated) : 0;
        this.updateRuleStats(s => { s.filledOrders++; s.lastFillAt = Date.now(); s.totalFillWaitMs += waitMs; });
      }
      Logger.info(status === 'FILLED' ? '规则自动交易 LIMIT 已完全成交' : '规则自动交易 LIMIT 发生部分成交', { ...fill, cooldownMinutes: Number(this.cfg.cooldownMinutes || 10) });
    }
  }

  async getCachedKlines(symbol, timeframe, limit = 80, ttlMs = null) {
    const key = `${normalizeSymbol(symbol)}|${timeframe}`;
    const effectiveTtl = ttlMs ?? (timeframe === '1m' ? 45000 : 240000);
    const cached = this.klineCache.get(key);
    if (cached && Date.now() - cached.at < effectiveTtl) return cached.rows;
    const rows = await this.binance.fetchKlines(symbol, timeframe, limit);
    this.klineCache.set(key, { at: Date.now(), rows });
    return rows;
  }

  async scan() {
    if (!this.enabled() || this.scanBusy) return this.getStatus();
    this.scanBusy = true;
    this.lastScanAt = Date.now();
    this.lastError = null;
    const scanStartedAt = Date.now();
    const traceId = `RULESCAN-${Date.now().toString(36)}`;
    Logger.info('规则自动交易扫描开始', {
      traceId,
      strategy: 'RULE_NO_AI',
      timeframe: '1m',
      trendTimeframe: '5m',
      topN: Math.max(1, Math.min(50, Number(this.cfg.topN ?? 20)))
    });
    // 每次真正启动的扫描都进入日统计，即使随后因为风控、持仓或挂单上限提前结束。
    this.updateRuleStats(s => { s.scans++; s.lastScanAt = Date.now(); });
    try {
      const positions = await this.binance.fetchPositions();
      if (!this.canContinue()) return this.getStatus();
      await this.syncPendingFromExchange();
      if (!this.canContinue()) return this.getStatus();
      const gate = typeof this.risk.canRuleAutoTrade === 'function' ? await this.risk.canRuleAutoTrade() : await this.risk.canAutoTrade();
      if (!gate.ok) {
        Logger.warn('规则自动交易风控拦截', { traceId, reason: gate.reason });
        this.lastSummary = { traceId, candidates: 0, ordersPlaced: 0, pendingOrders: this.pending.size, eligible: 0, skipped: gate.reason, reasonCounts: { [gate.reason]: 1 }, funnel: this.buildFunnel({ decisions: [], candidates: 0, ordersPlaced: 0, indicatorPass: 0 }), decisions: [], updatedAt: Date.now() };
        this.lastSuccessfulAt = Date.now();
        return this.getStatus();
      }
      if (positions.length >= Number(this.cfg.maxPositions || 1)) {
        Logger.info('规则自动交易达到最大持仓数，跳过本轮', { traceId, positions: positions.length, maxPositions: Number(this.cfg.maxPositions || 1) });
        this.lastSummary = { traceId, candidates: 0, ordersPlaced: 0, pendingOrders: this.pending.size, eligible: 0, skipped: '达到最大持仓数', reasonCounts: { MAX_POSITIONS: positions.length }, funnel: this.buildFunnel({ decisions: [], candidates: 0, ordersPlaced: 0, indicatorPass: 0 }), decisions: [], updatedAt: Date.now() };
        this.lastSuccessfulAt = Date.now();
        return this.getStatus();
      }
      if (!this.canContinue()) return this.getStatus();
      if (this.pending.size >= Number(this.cfg.maxPendingOrders || 2)) {
        Logger.info('规则自动交易达到最大待成交 LIMIT 数，跳过本轮', { traceId, pendingOrders: this.pending.size, maxPendingOrders: Number(this.cfg.maxPendingOrders || 2) });
        this.lastSummary = { traceId, candidates: 0, ordersPlaced: 0, pendingOrders: this.pending.size, eligible: 0, skipped: '达到最大待成交 LIMIT', reasonCounts: { MAX_PENDING_ORDERS: this.pending.size }, funnel: this.buildFunnel({ decisions: [], candidates: 0, ordersPlaced: 0, indicatorPass: 0 }), decisions: [], updatedAt: Date.now() };
        this.lastSuccessfulAt = Date.now();
        return this.getStatus();
      }

      if (!this.canContinue()) return this.getStatus();
      const topN = Math.max(1, Math.min(50, Number(this.cfg.topN ?? 20)));
      const rankings = typeof this.ranking.getRankings === 'function'
        ? await this.ranking.getRankings(topN)
        : await this.ranking.getTop10();
      const candidates = [
        ...(rankings.gainers || []).map((x, i) => ({ ...x, action: 'LONG', group: 'GAINER', rank: i + 1 })),
        ...(rankings.losers || []).map((x, i) => ({ ...x, action: 'SHORT', group: 'LOSER', rank: i + 1 }))
      ].slice(0, topN * 2);
      // 资金费率过滤：一次取回全市场费率，避免逐个 symbol 请求。
      // 取不到时不清空、不阻塞交易，只记录降级状态 —— 让瞬时接口故障不至于停摆整个策略。
      const maxFundingPct = Number(this.cfg.maxFundingRatePct ?? 0.07);
      const fundingRates = new Map();
      let fundingFilterActive = false;
      if (maxFundingPct > 0 && typeof this.binance.fetchFundingRates === 'function') {
        try {
          const rows = await this.binance.fetchFundingRates();
          for (const r of rows || []) {
            const sym = normalizeSymbol(r.symbol);
            const rate = Number(r.lastFundingRate);
            if (sym && Number.isFinite(rate)) fundingRates.set(sym, rate);
          }
          fundingFilterActive = fundingRates.size > 0;
        } catch (e) {
          Logger.warn('资金费率快照获取失败，本轮不按费率过滤', { traceId, error: e, code: e.code || null, status: e.status || null });
        }
      }
      const currentSymbols = new Set(positions.map(p => normalizeSymbol(p.symbol)));
      const pendingSymbols = new Set([...this.pending.values()].map(x => normalizeSymbol(x.symbol)));
      this.updateRuleStats(s => { s.candidates += candidates.length; });
      const decisions = await this.mapLimit(candidates, async (candidate, index) => this.evaluateCandidate(candidate, { currentSymbols, pendingSymbols, traceId, fundingRates, maxFundingPct, fundingFilterActive }, index));
      if (!this.canContinue()) return this.getStatus();
      let placed = 0;
      const reservedSymbols = new Set([...currentSymbols, ...pendingSymbols]);
      const indicatorPassCount = decisions.filter(x => x?.status === 'READY' || x?.status === 'ORDER_PLACED').length;
      this.updateRuleStats(s => { s.signalGenerated += decisions.filter(x => x?.status === 'READY').length; });
      const orderedDecisions = [...decisions].sort((a, b) => {
        const sa = Number(a?.signalStrength || 0), sb = Number(b?.signalStrength || 0);
        if (sb !== sa) return sb - sa;
        return Number(a?.rank || 999) - Number(b?.rank || 999);
      });
      for (const d of orderedDecisions) {
        if (!this.canContinue()) {
          Logger.info('规则自动交易扫描因运行状态变化停止新下单', { traceId, strategy: 'RULE_NO_AI', ordersPlaced: placed });
          break;
        }
        if (!d?.eligible) continue;
        const maxPositions = Number(this.cfg.maxPositions || 1);
        const maxPendingOrders = Number(this.cfg.maxPendingOrders || 2);
        // 每个候选真正下单前重新读取账户事实，避免扫描开始时的旧仓位快照导致并发超限。
        const livePositions = await this.binance.fetchPositions();
        if (livePositions.length >= maxPositions) {
          d.eligible = false;
          d.status = 'SKIP';
          d.stage = 'PLACE';
          d.reason = 'MAX_POSITIONS_LIVE';
          continue;
        }
        await this.syncPendingFromExchange();
        if (this.pending.size >= maxPendingOrders) {
          d.eligible = false;
          d.status = 'SKIP';
          d.stage = 'PLACE';
          d.reason = 'MAX_PENDING_ORDERS_LIVE';
          continue;
        }
        if (reservedSymbols.has(d.symbol)) {
          d.eligible = false;
          d.status = 'SKIP';
          d.stage = 'PLACE';
          d.reason = 'SYMBOL_RESERVED';
          continue;
        }
        try {
          if (!this.canContinue()) break;
          const placedOrder = await this.placeLimit(d, traceId);
          d.order = placedOrder;
          d.eligible = false;
          d.status = 'ORDER_PLACED';
          placed++;
          this.updateRuleStats(s => { s.ordersPlaced++; s.lastOrderAt = Date.now(); });
          reservedSymbols.add(d.symbol);
          currentSymbols.add(normalizeSymbol(d.symbol));
          this.lastSignal = {
            symbol: d.symbol,
            action: d.action,
            entry: d.entry,
            quantity: d.quantity,
            leverage: d.leverage,
            support: d.support?.price || null,
            resistance: d.resistance?.price || null,
            trend5m: d.trend5m,
            rsi: d.rsi ? { value: d.rsi.value, threshold: d.rsi.threshold, crossed: d.rsi.crossed } : null,
            volume: d.volume ? { ratio: d.volume.ratio, strong: d.volume.strong } : null,
            recentLow: d.structure?.recentLow ?? null,
            recentHigh: d.structure?.recentHigh ?? null,
            distanceAtr: d.distanceAtr ?? null,
            rr: d.rr,
            at: Date.now(),
            status: 'ORDER_PLACED'
          };
        } catch (e) {
          this.updateRuleStats(stats => { stats.orderFailed++; });
          d.status = 'ORDER_FAILED';
          d.stage = 'PLACE';
          d.error = e.message;
          Logger.error('规则自动交易 LIMIT 下单失败', { traceId, symbol: d.symbol, action: d.action, error: e, code: e.code || null, status: e.status || null });
        }
      }
      const reasonCounts = {};
      for (const d of decisions) {
        if (d?.status === 'READY' || d?.status === 'ORDER_PLACED') continue;
        const reasons = Array.isArray(d?.reasons) && d.reasons.length ? d.reasons : [d?.reason || d?.status || 'UNKNOWN'];
        for (const reason of reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      }
      this.updateRuleStats(s => {
        for (const [reason, count] of Object.entries(reasonCounts)) s.reasonCounts[reason] = Number(s.reasonCounts[reason] || 0) + Number(count || 0);
      });
      const funnel = this.buildFunnel({ decisions, candidates: candidates.length, ordersPlaced: placed, indicatorPass: indicatorPassCount });
      this.lastSummary = {
        traceId,
        updatedAt: Date.now(),
        candidates: candidates.length,
        ordersPlaced: placed,
        pendingOrders: this.pending.size,
        eligible: indicatorPassCount,
        indicatorPass: indicatorPassCount,
        reasonCounts,
        funnel,
        decisions: decisions.slice(0, topN * 2),
        durationMs: Date.now() - scanStartedAt
      };
      this.lastSuccessfulAt = Date.now();
      Logger.info('规则自动交易扫描完成', {
        traceId,
        strategy: 'RULE_NO_AI',
        candidates: candidates.length,
        ordersPlaced: placed,
        pendingOrders: this.pending.size,
        eligible: indicatorPassCount,
        funnel: funnel.stages.map(s => `${s.key}:${s.passed}/${s.entered}`),
        rsiSensitivity: funnel.rsiSensitivity,
        reasonCounts
      });
      if (funnel.degraded) {
        Logger.warn('规则自动交易漏斗数据降级：存在未打 stage 标记的决策，漏斗数字不可信', { traceId, unstaged: funnel.unstaged, candidates: candidates.length });
      }
      return this.getStatus();
    } finally {
      this.scanBusy = false;
    }
  }

  async syncPendingFromExchange() {
    const open = await this.binance.fetchOpenOrders();
    const seen = new Set();
    for (const o of open || []) {
      const cid = String(o.clientOrderId || '');
      if (!cid.startsWith('QP_RULE_')) continue;
      const orderId = String(o.orderId);
      if (!['NEW', 'PARTIALLY_FILLED'].includes(String(o.status || '').toUpperCase())) continue;
      seen.add(orderId);
      this.pending.set(orderId, {
        orderId: o.orderId,
        clientOrderId: cid,
        symbol: normalizeSymbol(o.symbol),
        positionSide: String(o.positionSide || 'BOTH').toUpperCase(),
        side: String(o.side || '').toUpperCase(),
        price: Number(o.price || 0),
        quantity: Number(o.origQty || 0),
        executedQty: Number(o.executedQty || 0),
        status: String(o.status || '').toUpperCase(),
        createdAt: Number(o.time || o.updateTime || Date.now()),
        recovered: true
      });
    }
    for (const [orderId, item] of this.pending) {
      if (!seen.has(String(orderId))) this.pending.delete(orderId);
    }
  }

  async mapLimit(items, worker) {
    const out = new Array(items.length);
    let next = 0;
    const run = async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        try {
          out[i] = await worker(items[i], i);
        } catch (e) {
          out[i] = { index: i, symbol: normalizeSymbol(items[i]?.symbol), action: items[i]?.action, eligible: false, status: 'ERROR', stage: 'ERROR', reason: 'EVALUATION_ERROR', error: e.message };
          Logger.warn('规则自动交易候选分析异常', { symbol: items[i]?.symbol, action: items[i]?.action, error: e, code: e?.code ?? null, status: e?.status ?? null });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxConcurrency, items.length) }, () => run()));
    return out;
  }

  async evaluateCandidate(candidate, ctx, index = null) {
    const symbol = normalizeSymbol(candidate.symbol);
    const action = candidate.action;
    const base = { index, symbol, action, group: candidate.group, rank: candidate.rank || null, changePct: Number(candidate.changePct || 0), eligible: false, status: 'SKIP' };
    if (!symbol) return { ...base, stage: 'PRECHECK', reason: 'SYMBOL_INVALID' };
    if (ctx.currentSymbols.has(symbol)) return { ...base, stage: 'PRECHECK', reason: 'ALREADY_POSITION' };
    if (ctx.pendingSymbols.has(symbol)) return { ...base, stage: 'PRECHECK', reason: 'ALREADY_PENDING' };
    const cooldown = typeof this.state.getRuleCooldown === 'function' ? this.state.getRuleCooldown(symbol) : this.state.getCooldown(symbol);
    if (Date.now() < cooldown) return { ...base, stage: 'PRECHECK', reason: 'COOLDOWN', until: cooldown };

    // 资金费率过滤：只拦"自己要付费"的方向 —— 做多付费率(rate>0)，做空付负费率(rate<0)。
    // 反向的高费率对持仓者是收益，不该拦。
    if (ctx.fundingRates instanceof Map && ctx.fundingRates.has(symbol)) {
      const ratePct = ctx.fundingRates.get(symbol) * 100;
      if (this.shouldBlockForFunding(action, ratePct, ctx.maxFundingPct)) {
        return {
          ...base, stage: 'FUNDING', reason: 'FUNDING_RATE_TOO_HIGH',
          fundingRatePct: Number(ratePct.toFixed(4)), maxFundingRatePct: ctx.maxFundingPct
        };
      }
    }

    const [rows1m, rows5m] = await Promise.all([
      this.getCachedKlines(symbol, '1m', 120, 5000),
      this.getCachedKlines(symbol, '5m', 90, 30000)
    ]);
    const c1 = closedCandles(rows1m);
    const c5 = closedCandles(rows5m);
    const st5 = calculateSuperTrend(c5, 10, 3);
    if (!st5) return { ...base, stage: 'TREND', reason: 'SUPERTREND_5M_UNAVAILABLE' };

    const desiredDir = action === 'LONG' ? 1 : -1;
    const trend5mMatch = st5.direction === desiredDir;
    if (!trend5mMatch) return { ...base, stage: 'TREND', reason: '5M_TREND_MISMATCH', trend5m: st5.direction === 1 ? 'UP' : 'DOWN', barsSinceFlip: st5.barsSinceFlip };
    const flipCooldown = Number(this.cfg.stFlipCooldownBars ?? 1);
    if (st5.barsSinceFlip != null && st5.barsSinceFlip < flipCooldown) {
      return { ...base, stage: 'TREND', reason: 'ST_FLIP_COOLDOWN', trend5m: st5.direction === 1 ? 'UP' : 'DOWN', barsSinceFlip: st5.barsSinceFlip, requiredBars: flipCooldown };
    }

    const marketState = superTrendMarketState(
      c5, 10, 3,
      Number(this.cfg.marketStateLookbackBars ?? 6),
      Number(this.cfg.marketStateMaxFlipCount ?? 2),
      Number(this.cfg.marketStateMinRangeAtr ?? 1.0),
      Number(this.cfg.marketStateMinEfficiency ?? 0.22)
    );
    if (marketState?.choppy) {
      return { ...base, stage: 'TREND', reason: '5M_MARKET_CHOP', trend5m: st5.direction === 1 ? 'UP' : 'DOWN', barsSinceFlip: st5.barsSinceFlip, marketState };
    }

    const rsiPeriod = Number(this.cfg.rsiPeriod || 14);
    const rsiThreshold = action === 'LONG' ? Number(this.cfg.rsiLongTrigger ?? 40) : Number(this.cfg.rsiShortTrigger ?? 60);
    const rsiDepthThreshold = action === 'LONG' ? Number(this.cfg.rsiLongDepth ?? 35) : Number(this.cfg.rsiShortDepth ?? 65);
    const rsiTriggerLookback = Number(this.cfg.rsiLookbackBars ?? 2);
    const rsiDepthLookback = Number(this.cfg.rsiDepthLookbackBars ?? 6);
    const rsi = rsiTrigger(c1, action, rsiPeriod, rsiThreshold, rsiTriggerLookback, rsiDepthThreshold, rsiDepthLookback);
    if (!rsi) return { ...base, stage: 'RSI', reason: 'RSI_DATA_UNAVAILABLE' };
    if (!rsi.confirmed) {
      return {
        ...base,
        stage: 'RSI',
        reason: rsi.reason || 'RSI_RECOVERY_NOT_CONFIRMED',
        rsi: rsi.value,
        rsiPrevious: rsi.previous,
        rsiThreshold,
        rsiDepthThreshold,
        rsiDepthExtreme: rsi.depthExtreme,
        rsiDepthReached: rsi.depthReached,
        rsiCrossed: rsi.crossed,
        rsiSlopeConfirmed: rsi.slopeConfirmed,
        rsiTriggerLookback: rsi.triggerLookback,
        rsiDepthLookback: rsi.depthLookback,
        rsiReasons: Array.isArray(rsi.reasons) ? rsi.reasons.slice() : (rsi.reason ? [rsi.reason] : []),
        reasons: Array.isArray(rsi.reasons) ? rsi.reasons.slice() : (rsi.reason ? [rsi.reason] : []),
        trend5m: st5.direction === 1 ? 'UP' : 'DOWN'
      };
    }

    const volume = volumeConfirmation(c1, Number(this.cfg.volumePeriod || 20), Number(this.cfg.volumeMinRatio ?? 0.9));
    if (!volume) return { ...base, stage: 'VOLUME', reason: 'VOLUME_DATA_UNAVAILABLE', rsi: rsi.value };
    if (volume.ratio < Number(this.cfg.volumeMinRatio ?? 0.9)) {
      return { ...base, stage: 'VOLUME', reason: 'VOLUME_TOO_LOW', rsi: rsi.value, volumeRatio: volume.ratio, volumeMinRatio: Number(this.cfg.volumeMinRatio ?? 0.9) };
    }

    const mark = Number((await this.binance.fetchMarkPrice(symbol)).markPrice || 0);
    if (!(mark > 0)) return { ...base, stage: 'ENTRY', reason: 'MARK_PRICE_UNAVAILABLE' };
    const atrValue = atr(c1.slice(-70), 10);
    if (!(atrValue > 0)) return { ...base, stage: 'ENTRY', reason: 'ATR_UNAVAILABLE' };

    const entryLookback = Math.max(3, Math.min(5, Number(this.cfg.entryLookbackBars || 4)));
    const offsetAtr = Math.max(0, Math.min(0.8, Number(this.cfg.entryOffsetAtr ?? 0.15)));
    const tick = Number(this.binance.tickSize(symbol) || 0);
    const precision = precisionEntry(c1, action, atrValue, mark, tick, {
      lookbackBars: entryLookback,
      offsetAtr,
      retraceRatio: Number(this.cfg.entryRetraceRatio ?? 0.38)
    });
    if (!precision) return { ...base, stage: 'ENTRY', reason: 'ENTRY_PRICE_INVALID', mark };
    const recentLow = precision.recentLow;
    const recentHigh = precision.recentHigh;
    const entryRaw = precision.entryRaw;
    const entry = this.binance.roundPrice(symbol, entryRaw, action === 'LONG' ? 'floor' : 'ceil');
    if (!(entry > 0)) return { ...base, stage: 'ENTRY', reason: 'ENTRY_PRICE_INVALID', mark };
    if ((action === 'LONG' && entry >= mark) || (action === 'SHORT' && entry <= mark)) return { ...base, stage: 'ENTRY', reason: 'LIMIT_WOULD_BE_MARKETABLE', entry, mark };
    const maxEntryDistanceAtr = Number(this.cfg.maxEntryDistanceAtr ?? 1.5);
    const distanceAtr = Math.abs(mark - entry) / atrValue;
    if (distanceAtr > maxEntryDistanceAtr) return { ...base, stage: 'ENTRY', reason: 'ENTRY_TOO_FAR', entry, mark, distanceAtr, maxEntryDistanceAtr };

    // 结构止损：最近回调极值外再留0.15 ATR缓冲，RiskManager负责按实际止损距离缩放数量。
    const structureBuffer = atrValue * 0.15;
    let stopPrice = action === 'LONG' ? recentLow - structureBuffer : recentHigh + structureBuffer;
    let slPct = action === 'LONG' ? ((entry - stopPrice) / entry * 100) : ((stopPrice - entry) / entry * 100);
    const minSLPct = Number(this.cfg.minRuleSLPct ?? 0.4);
    const maxSLPct = Number(this.cfg.maxRuleSLPct ?? 2.5);
    if (!(slPct > 0)) return { ...base, stage: 'ENTRY', reason: 'STOP_DISTANCE_INVALID', entry, stopPrice };
    if (slPct < minSLPct) {
      slPct = minSLPct;
      stopPrice = action === 'LONG' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
    }
    if (slPct > maxSLPct) return { ...base, stage: 'ENTRY', reason: 'STOP_TOO_WIDE', entry, stopPrice, slPct, maxSLPct };
    const rrTarget = Number(this.cfg.ruleTakeProfitRR ?? 2);
    const tpPct = slPct * rrTarget;
    const tpPrice = action === 'LONG' ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);

    const configuredLeverage = Number(this.cfg.leverage || 10);
    const maxLeverage = await this.binance.maxInitialLeverage(symbol);
    if (!(maxLeverage > 0)) return { ...base, stage: 'RISK', reason: 'LEVERAGE_UNAVAILABLE' };
    if (configuredLeverage > Number(maxLeverage)) return { ...base, stage: 'RISK', reason: 'LEVERAGE_EXCEEDS_MAX', configuredLeverage, maxLeverage };
    const leverage = configuredLeverage;

    const account = typeof this.binance.getAccount === 'function' ? await this.binance.getAccount() : null;
    const equity = Number(account?.totalMarginBalance ?? account?.totalWalletBalance ?? await this.binance.fetchAccountEquity());
    const availableBalance = Number(account?.availableBalance ?? equity);
    const riskPct = Number(this.cfg.riskPerTradePct ?? this.config.get().risk?.riskPerTradePct ?? 1);
    const riskMoney = equity * riskPct / 100;
    if (!(equity > 0 && riskMoney > 0)) return { ...base, stage: 'RISK', reason: 'ACCOUNT_EQUITY_UNAVAILABLE' };
    const stopDistance = entry * slPct / 100;
    const rawQty = riskMoney / stopDistance;
    const minQty = Number(this.binance.minQty(symbol) || 0);
    const quantity = this.binance.roundQty(symbol, rawQty);
    if (!(quantity >= minQty)) {
      const requiredEquity = riskPct > 0 ? (minQty * stopDistance * 100) / riskPct : 0;
      return { ...base, stage: 'RISK', reason: 'QTY_BELOW_MIN', quantity, rawQty, minQty, requiredEquity, currentEquity: equity };
    }
    const maxQty = typeof this.binance.maxQty === 'function' ? Number(this.binance.maxQty(symbol) || 0) : 0;
    if (maxQty > 0 && quantity > maxQty) return { ...base, stage: 'RISK', reason: 'QTY_ABOVE_MAX', quantity, maxQty, rawQty };
    const notional = quantity * entry;
    const minNotional = Number(this.binance.minNotional(symbol) || 0);
    if (minNotional > 0 && notional < minNotional) {
      const requiredEquity = riskPct > 0 ? minNotional * slPct / riskPct : 0;
      return { ...base, stage: 'RISK', reason: 'NOTIONAL_BELOW_MIN', quantity, notional, minNotional, requiredEquity, currentEquity: equity };
    }
    const requiredMargin = notional / leverage;
    if (availableBalance > 0 && requiredMargin > availableBalance * 0.95) return { ...base, stage: 'RISK', reason: 'INSUFFICIENT_AVAILABLE_MARGIN', requiredMargin, availableBalance };

    const signalStrength = 2 + (rsi.crossed ? 1 : 0) + (volume.ratio >= Number(this.cfg.volumeStrongRatio ?? 1.2) ? 1 : 0) + Math.max(0, 2 - Math.min(2, Number(candidate.rank || 3) - 1));
    Logger.info('规则自动交易候选通过V13回踩检查', {
      traceId: ctx.traceId || null, strategy: 'RULE_V13.3_RSI_DEPTH_VOLUME_PULLBACK', symbol, action,
      rank: candidate.rank || null, changePct: Number(candidate.changePct || 0), mark, entry, quantity, leverage,
      trend5m: st5.direction === 1 ? 'UP' : 'DOWN', barsSinceFlip: st5.barsSinceFlip,
      marketState,
      rsi: rsi.value, rsiThreshold, rsiCrossed: rsi.crossed,
      volumeRatio: volume.ratio, volumeAverage: volume.average, volumeStrong: volume.strong,
      recentLow, recentHigh, distanceAtr, stopPrice, plannedSLPct: slPct, tpPrice, plannedTPPct: tpPct,
      rr: rrTarget, signalStrength, marketState, entryPrecision: { structureEntry: precision.structureEntry, candleMidEntry: precision.candleMidEntry, retraceEntry: precision.retraceEntry, chosenEntry: entry, retraceRatio: precision.retraceRatio, levelToExtremeAtr: precision.levelToExtremeAtr }
    });
    return {
      ...base, stage: 'PASS', eligible: true, status: 'READY', mark, entry, quantity, notional, requiredMargin, equity, availableBalance, leverage,
      plannedSLPct: slPct, plannedTPPct: tpPct, rr: rrTarget, stopPrice, tpPrice,
      trend5m: st5.direction === 1 ? 'UP' : 'DOWN', trend5mMatch, barsSinceFlip: st5.barsSinceFlip,
      // depthReached/slopeConfirmed 一并带出，供逐阶段漏斗对「进入 RSI 的全部币」统一统计。
      rsi: { value: rsi.value, previous: rsi.previous, threshold: rsi.threshold, crossed: rsi.crossed, tooLate: rsi.tooLate, depthReached: rsi.depthReached, slopeConfirmed: rsi.slopeConfirmed, depthExtreme: rsi.depthExtreme },
      volume: { current: volume.current, average: volume.average, ratio: volume.ratio, minRatio: volume.minRatio, strong: volume.strong },
      structure: { recentLow, recentHigh, entryLookback, offsetAtr, retraceRatio: precision.retraceRatio, structureEntry: precision.structureEntry, candleMidEntry: precision.candleMidEntry, retraceEntry: precision.retraceEntry, levelToExtremeAtr: precision.levelToExtremeAtr, signalCandleTime: precision.signalCandleTime },
      distanceAtr, signalStrength, signalAt: Date.now()
    };
  }

  async monitorRuleExits() {
    if (!this.running || !this.enabled() || this.cfg.exitOnIndicatorReverse === false) return;
    const positions = await this.binance.fetchPositions();
    for (const p of positions || []) {
      if (Math.abs(Number(p.contracts || 0)) <= 0) continue;
      if (this.state.getPositionSource(p) !== 'RULE') continue;
      const key = this.key(p.symbol, p.positionSide);
      if (this.ruleExitBusy.has(key)) continue;
      if (Date.now() - Number(this.exitCheckedAt.get(key) || 0) < 8000) continue;
      this.exitCheckedAt.set(key, Date.now());
      const [rows1m, rows5m] = await Promise.all([
        this.getCachedKlines(p.symbol, '1m', 100, 5000),
        this.getCachedKlines(p.symbol, '5m', 80, 30000)
      ]);
      const c1 = closedCandles(rows1m), c5 = closedCandles(rows5m);
      const side = String(p.positionSide || '').toUpperCase();
      const action = side === 'LONG' ? 'LONG' : 'SHORT';
      const rsiExitLevel = action === 'LONG' ? Number(this.cfg.exitRsiLong ?? 60) : Number(this.cfg.exitRsiShort ?? 40);
      const rsiReverse = rsiExitReverse(c1, action, Number(this.cfg.rsiPeriod || 14), rsiExitLevel);
      const st5 = calculateSuperTrend(c5, 10, 3);
      const mark = Number(p.markPrice || 0);
      const entry = Number(p.entryPrice || 0);
      const profitable = action === 'LONG' ? mark > entry : mark < entry;
      const trendReverseRaw = !!st5 && st5.direction !== (action === 'LONG' ? 1 : -1);
      const candleTime = Number(c1.at(-1)?.openTime || 0);
      const reverseState = this.exitReverseState.get(key) || { candleTime: 0, bothCount: 0 };
      let lossConfirmed = false;
      if (candleTime > 0 && candleTime !== reverseState.candleTime) {
        reverseState.candleTime = candleTime;
        if (!profitable && rsiReverse && trendReverseRaw) reverseState.bothCount += 1;
        else reverseState.bothCount = 0;
        this.exitReverseState.set(key, reverseState);
      }
      const lossExitConfirmBars = Math.max(2, Number(this.cfg.lossExitConfirmBars ?? 2));
      lossConfirmed = !profitable && reverseState.bothCount >= lossExitConfirmBars;
      const exitDecision = shouldExitRulePosition({ profitable, rsiReverse, trendReverse: trendReverseRaw, lossReverseCount: reverseState.bothCount, lossExitConfirmBars });
      const exit = exitDecision.exit;
      if (!exit) continue;
      this.ruleExitBusy.add(key);
      try {
        const reason = lossConfirmed ? 'LOSS_INDICATOR_INVALIDATED' : (rsiReverse ? (action === 'LONG' ? 'RSI_BEARISH_REVERSE' : 'RSI_BULLISH_REVERSE') : 'ST_5M_REVERSE');
        const result = typeof this.emergency?.closePositionMarket === 'function'
          ? await this.emergency.closePositionMarket(p)
          : await this.binance.createCloseMarketOrder({ symbol: p.symbol, side: side === 'LONG' ? 'SELL' : 'BUY', quantity: p.contracts, positionSide: p.positionSide, newClientOrderId: `QP_RULE_EXIT_${Date.now().toString(36)}` });
        this.lastExit = { symbol: p.symbol, positionSide: side, reason, mark, entry, rsiExitLevel, rsiReverse, trendReverse: trendReverseRaw, profitable, lossReverseCount: reverseState.bothCount, lossExitConfirmBars, orderId: result?.orderId || null, at: Date.now() };
        if (typeof this.state.setRuleCooldown === 'function') this.state.setRuleCooldown(p.symbol, Date.now() + Number(this.cfg.cooldownMinutes || 10) * 60000);
        Logger.warn('规则自动交易指标平仓已发送', { symbol: p.symbol, positionSide: side, reason, mark, entry, orderId: result?.orderId || null });
      } catch (e) {
        Logger.error('规则自动交易指标平仓失败', { symbol: p.symbol, positionSide: side, error: e, code: e?.code ?? null, status: e?.status ?? null });
      } finally {
        this.ruleExitBusy.delete(key);
      }
    }
  }

  async ensureSymbolLeverage(symbol, leverage, { positions = null, openOrders = null } = {}) {
    const currentPositions = positions || await this.binance.fetchPositions(symbol);
    if ((currentPositions || []).some(p => Math.abs(Number(p.contracts || 0)) > 0)) {
      throw Object.assign(new Error('下单前检测到该合约已有持仓，禁止规则自动交易修改现有仓位杠杆'), { code: 'SYMBOL_HAS_POSITION' });
    }
    const currentOpenOrders = openOrders || await this.binance.fetchOpenOrders(symbol);
    const active = (currentOpenOrders || []).find(o => ['NEW', 'PARTIALLY_FILLED'].includes(String(o.status || '').toUpperCase()));
    if (active) throw Object.assign(new Error(`下单前检测到该合约已有挂单，禁止规则自动交易修改该合约设置：${active.orderId}`), { code: 'OPEN_ORDER_EXISTS' });
    const cfg = typeof this.binance.getSymbolConfig === 'function' ? await this.binance.getSymbolConfig(symbol, true) : null;
    const current = Number(cfg?.leverage || 0);
    if (current === Number(leverage)) return { leverage: current, changed: false };
    if (typeof this.binance.setLeverage !== 'function') throw Object.assign(new Error('Binance 客户端不支持设置规则自动交易杠杆'), { code: 'SET_LEVERAGE_UNAVAILABLE' });
    await this.binance.setLeverage(symbol, leverage);
    const verified = typeof this.binance.getSymbolConfig === 'function' ? await this.binance.getSymbolConfig(symbol, true) : null;
    const actual = Number(verified?.leverage || 0);
    if (!(actual > 0) || actual !== Number(leverage)) throw Object.assign(new Error(`规则自动交易杠杆设置后复核失败：期望 ${leverage}x，实际 ${actual || '未读取'}x`), { code: 'LEVERAGE_VERIFY_FAILED' });
    Logger.info('规则自动交易已设置新仓位杠杆', { symbol, leverage, previousLeverage: current || null });
    return { leverage: actual, changed: true };
  }

  async placeLimit(signal, traceId) {
    const symbol = normalizeSymbol(signal.symbol);
    const positions = await this.binance.fetchPositions(symbol);
    if ((positions || []).some(p => Math.abs(Number(p.contracts || 0)) > 0)) {
      throw Object.assign(new Error('下单瞬间检测到该合约已有持仓，取消规则 LIMIT'), { code: 'SYMBOL_HAS_POSITION' });
    }
    const openOrders = await this.binance.fetchOpenOrders(symbol);
    const active = (openOrders || []).find(o => ['NEW', 'PARTIALLY_FILLED'].includes(String(o.status || '').toUpperCase()));
    if (active) throw Object.assign(new Error(`该合约已有挂单，拒绝重复自动交易：${active.orderId}`), { code: 'OPEN_ORDER_EXISTS' });

    await this.ensureSymbolLeverage(symbol, signal.leverage, { positions, openOrders });
    // 杠杆设置后再做一次最终持仓检查，避免检查与实际下单之间出现竞态。
    const finalPositions = await this.binance.fetchPositions();
    if (finalPositions.length >= Number(this.cfg.maxPositions || 1)) {
      throw Object.assign(new Error('最终下单检查发现账户持仓已达到规则最大持仓数，取消规则 LIMIT'), { code: 'MAX_POSITIONS_RACE' });
    }
    if (finalPositions.some(p => normalizeSymbol(p.symbol) === symbol && Math.abs(Number(p.contracts || 0)) > 0)) {
      throw Object.assign(new Error('最终下单检查发现该合约已出现持仓，取消规则 LIMIT'), { code: 'SYMBOL_HAS_POSITION_RACE' });
    }
    await this.syncPendingFromExchange();
    if (this.pending.size >= Number(this.cfg.maxPendingOrders || 2)) {
      throw Object.assign(new Error('最终下单检查发现规则待成交 LIMIT 已达到上限，取消本次下单'), { code: 'MAX_PENDING_ORDERS_RACE' });
    }
    const liveMark = Number((await this.binance.fetchMarkPrice(symbol)).markPrice || 0);
    if (!(liveMark > 0)) throw Object.assign(new Error('下单前无法读取实时 Mark Price，取消规则 LIMIT'), { code: 'MARK_PRICE_UNAVAILABLE' });
    if ((signal.action === 'LONG' && signal.entry >= liveMark) || (signal.action === 'SHORT' && signal.entry <= liveMark)) {
      throw Object.assign(new Error('下单前价格已使 LIMIT 变成可立即成交价格，取消本次下单'), { code: 'LIMIT_WOULD_BE_MARKETABLE_LIVE' });
    }
    const maxSlippagePct = Number(this.config.get().risk?.maxSlippagePct ?? 0.5);
    if (signal.mark > 0 && maxSlippagePct > 0) {
      const driftPct = Math.abs(liveMark - Number(signal.mark)) / Number(signal.mark) * 100;
      if (driftPct > maxSlippagePct) throw Object.assign(new Error(`扫描到下单期间 Mark 漂移 ${driftPct.toFixed(3)}%，超过允许 ${maxSlippagePct.toFixed(3)}%`), { code: 'MARK_DRIFT_EXCEEDED', driftPct, maxSlippagePct });
    }
    if (!this.canContinue()) {
      throw Object.assign(new Error('规则自动交易已停止，取消本次 LIMIT 下单'), { code: 'RULE_TRADING_STOPPED' });
    }
    const positionSide = this.binance.actualHedgeMode === true ? signal.action : 'BOTH';
    const side = signal.action === 'LONG' ? 'BUY' : 'SELL';
    const clientOrderId = `QP_RULE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`.toUpperCase().slice(0, 32);
    this.state.setRuleOrderPlan?.(clientOrderId, { symbol, positionSide, action: signal.action, entry: signal.entry, stopPrice: signal.stopPrice, tpPrice: signal.tpPrice, plannedSLPct: signal.plannedSLPct, plannedTPPct: signal.plannedTPPct, leverage: signal.leverage, traceId });
    let order;
    try {
      order = await this.binance.createLimitOrder({
      symbol,
      side,
      quantity: signal.quantity,
      price: signal.entry,
      positionSide,
      timeInForce: 'GTC',
        newClientOrderId: clientOrderId
      });
    } catch (e) {
      this.state.deleteRuleOrderPlan?.(clientOrderId);
      throw e;
    }
    this.state.setRuleOrderPlan?.(clientOrderId, { orderId: String(order.orderId), createdAt: Date.now() });
    const orderId = String(order.orderId);
    this.pending.set(orderId, {
      orderId: order.orderId,
      clientOrderId,
      symbol,
      positionSide,
      side,
      price: signal.entry,
      quantity: signal.quantity,
      executedQty: Number(order.executedQty || 0),
      status: order.status || 'NEW',
      createdAt: Date.now(),
      expiresAt: Date.now() + Number(this.cfg.orderTtlMinutes || 5) * 60 * 1000,
      traceId,
      reason: 'V13.3_RSI_VOLUME_ST_LIMIT'
    });
    Logger.info('规则自动交易 LIMIT 已挂出', {
      traceId,
      symbol,
      action: signal.action,
      positionSide,
      orderId: order.orderId,
      clientOrderId,
      quantity: signal.quantity,
      price: signal.entry,
      leverage: signal.leverage,
      plannedSLPct: signal.plannedSLPct,
      plannedTPPct: signal.plannedTPPct,
      support: signal.support?.price || null,
      resistance: signal.resistance?.price || null,
      distanceAtr: signal.distanceAtr
    });
    return { orderId: order.orderId, clientOrderId, status: order.status || 'NEW', price: signal.entry, quantity: signal.quantity, leverage: signal.leverage };
  }
}

module.exports = { RuleAutoTrader, findSupportResistance, reversalConfirmation, atr, bollinger, macd, ema, bollingerAt, bollingerSeries, macdMomentum, detectBollingerPullback, rsiSeries, rsiTrigger, rsiExitReverse, volumeConfirmation, precisionEntry, superTrendMarketState, shouldExitRulePosition, utcDayKey, defaultRuleStats, normalizeRuleStats, classifyRsiTriggerValues };
