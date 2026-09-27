// Funding 监控：只提醒，不自动平仓。
class FundingMonitor {
  constructor({ binance }) { this.binance = binance; }
  async get(symbol) {
    const d = await this.binance.fetchFundingRate(symbol);
    return { symbol, fundingRate: Number(d.lastFundingRate || 0), nextFundingTime: Number(d.nextFundingTime || 0) };
  }
}
module.exports = FundingMonitor;
