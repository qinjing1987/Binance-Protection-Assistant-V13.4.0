// 行情排行榜：只允许 USDT 永续、TRADING、满足最低成交额的合约进入候选池。
const { normalizeSymbol } = require('../utils/symbol');
class RankingService {
  constructor({ binance, config }) { this.binance = binance; this.config = config; this.cache = null; this.cacheByN = new Map(); this.updatedAt = 0; }
  async getRankings(requestedN = null) {
    await this.binance.loadExchangeInfo(false);
    const allowed = new Set(this.binance.listTradableUSDT());
    const tickers = await this.binance.fetchTickers24h();
    const rows = (tickers || []).filter(t => allowed.has(normalizeSymbol(t.symbol)) && Number(t.quoteVolume || 0) >= Number(this.config.get().ranking.minQuoteVolumeUSDT))
      .map(t => ({ symbol: normalizeSymbol(t.symbol), changePct: Number(t.priceChangePercent || 0), quoteVolume: Number(t.quoteVolume || 0), last: Number(t.lastPrice || 0), high: Number(t.highPrice || 0), low: Number(t.lowPrice || 0) }))
      .filter(x => Number.isFinite(x.changePct) && x.last > 0).sort((a, b) => b.changePct - a.changePct);
    const configured = Number(this.config.get().ranking.topN) || 5;
    const n = Math.max(1, Math.min(50, Number(requestedN ?? configured)));
    const gainers = rows.filter(x => x.changePct > 0).slice(0, n);
    const losers = rows.filter(x => x.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, n);
    this.cache = { gainers, losers, updatedAt: Date.now(), n };
    this.cacheByN.set(n, this.cache);
    this.updatedAt = this.cache.updatedAt;
    return this.cache;
  }
  async getTop5() { return this.getRankings(); }
  async getTop10() { return this.getRankings(10); }
  getCached(n = null) { return n == null ? this.cache : (this.cacheByN.get(Number(n)) || null); }
}
module.exports = RankingService;
