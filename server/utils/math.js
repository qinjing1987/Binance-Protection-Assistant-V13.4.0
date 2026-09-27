function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function roundDown(value, step) { const v = Number(value), s = Number(step); if (!(v > 0) || !(s > 0)) return 0; return Math.floor((v + 1e-12) / s) * s; }
function roundToTick(value, tick) { const v = Number(value), t = Number(tick); if (!(v > 0) || !(t > 0)) return v; return Math.round((v + 1e-12) / t) * t; }
function roundPriceForSide(value, tick, mode) {
  const v = Number(value), t = Number(tick); if (!(v > 0) || !(t > 0)) return v;
  return mode === 'floor' ? Math.floor(v / t) * t : mode === 'ceil' ? Math.ceil(v / t) * t : Math.round(v / t) * t;
}
function pctDistance(a, b) { return Math.abs(Number(a) - Number(b)) / Number(b) * 100; }
module.exports = { clamp, roundDown, roundToTick, roundPriceForSide, pctDistance };
