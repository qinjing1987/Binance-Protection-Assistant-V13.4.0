// SuperTrend 扫描器：只做行情提示，不开仓、不平仓、不修改用户仓位保护。
const Logger = require('../Logger');
const { normalizeSymbol } = require('../utils/symbol');

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function closedCandles(rows) {
  const now = Date.now();
  return (rows || []).map(r => ({
    openTime: Number(r[0]),
    open: toNumber(r[1]),
    high: toNumber(r[2]),
    low: toNumber(r[3]),
    close: toNumber(r[4]),
    volume: toNumber(r[5]) || 0,
    quoteVolume: toNumber(r[7]) || 0,
    closeTime: Number(r[6])
  })).filter(r => r.openTime > 0 && r.closeTime > 0 && r.high > 0 && r.low > 0 && r.close > 0 && r.closeTime < now);
}

function calculateATR(candles, period) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  const atr = Array(candles.length).fill(null);
  if (candles.length <= period) return atr;
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i];
  atr[period] = seed / period;
  for (let i = period + 1; i < candles.length; i++) {
    atr[i] = ((atr[i - 1] * (period - 1)) + tr[i]) / period;
  }
  return atr;
}

/**
 * 标准 SuperTrend（ATR Wilder 平滑）：ATR10、倍数3。
 * direction: 1=看涨/多头趋势，-1=看跌/空头趋势。
 */
function calculateSuperTrend(candles, period = 10, multiplier = 3) {
  if (!Array.isArray(candles) || candles.length < period + 3) return null;
  const atr = calculateATR(candles, period);
  const upper = Array(candles.length).fill(null);
  const lower = Array(candles.length).fill(null);
  const st = Array(candles.length).fill(null);
  const direction = Array(candles.length).fill(null);

  for (let i = period; i < candles.length; i++) {
    const mid = (candles[i].high + candles[i].low) / 2;
    const basicUpper = mid + multiplier * atr[i];
    const basicLower = mid - multiplier * atr[i];
    if (i === period) {
      upper[i] = basicUpper;
      lower[i] = basicLower;
      st[i] = upper[i];
      direction[i] = -1;
      continue;
    }
    const prevClose = candles[i - 1].close;
    upper[i] = (basicUpper < upper[i - 1] || prevClose > upper[i - 1]) ? basicUpper : upper[i - 1];
    lower[i] = (basicLower > lower[i - 1] || prevClose < lower[i - 1]) ? basicLower : lower[i - 1];
    if (st[i - 1] === upper[i - 1]) {
      if (candles[i].close <= upper[i]) {
        st[i] = upper[i];
        direction[i] = -1;
      } else {
        st[i] = lower[i];
        direction[i] = 1;
      }
    } else {
      if (candles[i].close >= lower[i]) {
        st[i] = lower[i];
        direction[i] = 1;
      } else {
        st[i] = upper[i];
        direction[i] = -1;
      }
    }
  }
  let idx = candles.length - 1;
  while (idx >= 0 && direction[idx] == null) idx--;
  if (idx < 0) return null;
  let prevIdx = idx - 1;
  while (prevIdx >= 0 && direction[prevIdx] == null) prevIdx--;
  let flipIdx = -1;
  for (let i = idx - 1; i >= period; i--) {
    if (direction[i] != null && direction[i] !== direction[i + 1]) { flipIdx = i + 1; break; }
  }
  return {
    index: idx,
    candleTime: candles[idx].openTime,
    closeTime: candles[idx].closeTime,
    close: candles[idx].close,
    superTrend: st[idx],
    direction: direction[idx],
    previousDirection: prevIdx >= 0 ? direction[prevIdx] : null,
    previousCandleTime: prevIdx >= 0 ? candles[prevIdx].openTime : null,
    flipped: prevIdx >= 0 && direction[prevIdx] !== direction[idx],
    barsSinceFlip: flipIdx >= 0 ? idx - flipIdx : null
  };
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); }
      catch (e) { out[i] = { error: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
  return out;
}

class SuperTrendScanner {
  constructor({ binance, ranking }) {
    this.binance = binance;
    this.ranking = ranking;
    this.intervalMs = 60 * 1000;
    // 必须与规则交易开仓/平仓使用的周期一致（RuleAutoTrader 用 calculateSuperTrend(c5,10,3)）。
    // 原为 1m —— 面板显示的周期与策略实际使用的不同，用户无法据此验证为何开单，只会误导。
    this.timeframe = '5m';
    this.atrPeriod = 10;
    this.multiplier = 3;
    this.candleLimit = 120;
    this.maxConcurrency = 5;
    this.states = new Map();
    this.recentFlips = [];
    this.lastScanAt = 0;
    this.lastSuccessfulAt = 0;
    this.nextScanAt = 0;
    this.lastError = null;
    this.lastSummary = null;
    this.running = false;
  }

  statusLabel() {
    if (this.running) return '扫描中';
    if (this.lastError) return '异常';
    if (this.lastSuccessfulAt) return '正常';
    return '等待首次扫描';
  }

  getStatus() {
    return {
      enabled: true,
      status: this.statusLabel(),
      intervalMs: this.intervalMs,
      intervalMinutes: 1,
      timeframe: this.timeframe,
      atrPeriod: this.atrPeriod,
      multiplier: this.multiplier,
      candleLimit: this.candleLimit,
      lastScanAt: this.lastScanAt,
      lastSuccessfulAt: this.lastSuccessfulAt,
      nextScanAt: this.nextScanAt,
      lastError: this.lastError,
      lastSummary: this.lastSummary,
      recentFlips: this.recentFlips.slice(0, 20),
      gainers: this.lastSummary?.gainers || [],
      losers: this.lastSummary?.losers || [],
      counts: this.lastSummary?.counts || { gainers: 0, losers: 0, up: 0, down: 0, flips: 0, errors: 0 }
    };
  }

  async scan() {
    if (this.running) return this.getStatus();
    this.running = true;
    const started = Date.now();
    this.lastScanAt = started;
    this.nextScanAt = started + this.intervalMs;
    const traceId = `STSCAN-${started.toString(36)}`;
    try {
      Logger.info('SuperTrend扫描开始', { traceId, timeframe: this.timeframe, atrPeriod: this.atrPeriod, multiplier: this.multiplier });
      const rankings = await this.ranking.getTop10();
      const groups = new Map();
      for (const [group, rows] of [['GAINER', rankings.gainers || []], ['LOSER', rankings.losers || []]]) {
        (rows || []).forEach((row, i) => {
          const symbol = normalizeSymbol(row.symbol);
          if (!symbol) return;
          const item = groups.get(symbol) || { symbol, groups: [] };
          item.groups.push({ group, rank: i + 1, changePct: Number(row.changePct || 0), quoteVolume: Number(row.quoteVolume || 0) });
          groups.set(symbol, item);
        });
      }
      const symbols = Array.from(groups.values());
      const results = await mapLimit(symbols, this.maxConcurrency, async item => {
        try {
          const rows = await this.binance.fetchKlines(item.symbol, this.timeframe, this.candleLimit);
          const candles = closedCandles(rows);
          const st = calculateSuperTrend(candles, this.atrPeriod, this.multiplier);
          if (!st) throw new Error('有效已收盘K线不足，无法计算SuperTrend');
          const prev = this.states.get(item.symbol);
          let isNewFlip = false;
          let from = null;
          let to = null;
          if (prev && prev.direction != null && st.direction !== prev.direction && st.candleTime !== prev.candleTime) {
            isNewFlip = true;
            from = prev.direction === 1 ? 'UP' : 'DOWN';
            to = st.direction === 1 ? 'UP' : 'DOWN';
            const flip = {
              id: `${item.symbol}-${st.candleTime}-${st.direction}`,
              symbol: item.symbol,
              direction: to,
              from,
              to,
              candleTime: st.candleTime,
              closeTime: st.closeTime,
              price: st.close,
              groups: item.groups,
              detectedAt: Date.now()
            };
            this.recentFlips = [flip, ...this.recentFlips.filter(x => x.id !== flip.id)].slice(0, 20);
            Logger.warn('SuperTrend首次转换发现', {
              traceId, symbol: item.symbol, from, to, candleTime: st.candleTime, price: st.close,
              groups: item.groups.map(x => x.group), ranks: item.groups.map(x => x.rank)
            });
          }
          this.states.set(item.symbol, { direction: st.direction, candleTime: st.candleTime, updatedAt: Date.now() });
          return {
            symbol: item.symbol,
            groups: item.groups,
            direction: st.direction === 1 ? 'UP' : 'DOWN',
            directionLabel: st.direction === 1 ? '看涨' : '看跌',
            superTrend: st.superTrend,
            price: st.close,
            candleTime: st.candleTime,
            closeTime: st.closeTime,
            flip: isNewFlip ? { from, to, detectedAt: Date.now() } : null
          };
        } catch (e) {
          Logger.warn('SuperTrend单币扫描失败', { traceId, symbol: item.symbol, error: e?.message || String(e), code: e?.code ?? null, status: e?.status ?? null });
          return { symbol: item.symbol, groups: item.groups, error: e?.message || String(e) };
        }
      });

      const latestBySymbol = new Map(results.filter(Boolean).map(x => [x.symbol, x]));
      const enrichRank = rows => (rows || []).map(row => {
        const x = latestBySymbol.get(normalizeSymbol(row.symbol));
        return {
          ...row,
          superTrendDirection: x?.direction || null,
          superTrendLabel: x?.directionLabel || null,
          superTrendFlip: x?.flip || null,
          superTrendCandleTime: x?.candleTime || null,
          superTrendError: x?.error || null
        };
      });
      const gainers = enrichRank(rankings.gainers);
      const losers = enrichRank(rankings.losers);
      const successful = results.filter(x => x && !x.error);
      const errors = results.filter(x => x && x.error);
      const up = successful.filter(x => x.direction === 'UP').length;
      const down = successful.filter(x => x.direction === 'DOWN').length;
      const flips = successful.filter(x => x.flip).length;
      const durationMs = Date.now() - started;
      this.lastSummary = {
        updatedAt: Date.now(),
        durationMs,
        gainers,
        losers,
        counts: { gainers: gainers.length, losers: losers.length, up, down, flips, errors: errors.length },
        newFlips: successful.filter(x => x.flip).map(x => ({ symbol: x.symbol, ...x.flip, groups: x.groups }))
      };
      this.lastSuccessfulAt = Date.now();
      this.lastError = errors.length ? `${errors.length} 个合约扫描失败` : null;
      Logger.info('SuperTrend扫描完成', {
        traceId, durationMs, scanned: symbols.length, success: successful.length, errors: errors.length,
        up, down, flips
      });
      return this.getStatus();
    } catch (e) {
      this.lastError = e?.message || String(e);
      Logger.error('SuperTrend扫描整体失败', { traceId, error: e });
      throw e;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { SuperTrendScanner, calculateSuperTrend, closedCandles };
