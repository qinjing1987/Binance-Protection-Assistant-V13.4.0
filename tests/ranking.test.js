const test = require('node:test');
const assert = require('node:assert/strict');
const RankingService = require('../server/ai/RankingService');

function makeService(tickers) {
  return new RankingService({
    binance: {
      loadExchangeInfo: async () => {},
      listTradableUSDT: () => tickers.map(x => x.symbol),
      fetchTickers24h: async () => tickers
    },
    config: { get: () => ({ ranking: { topN: 5, minQuoteVolumeUSDT: 1 } }) }
  });
}

test('涨幅与跌幅候选严格只包含正负涨跌幅，不能把正涨幅放进SHORT候选', async () => {
  const s = makeService([
    { symbol: 'AUSDT', priceChangePercent: '5', quoteVolume: '100', lastPrice: '1' },
    { symbol: 'BUSDT', priceChangePercent: '2', quoteVolume: '100', lastPrice: '1' },
    { symbol: 'CUSDT', priceChangePercent: '0', quoteVolume: '100', lastPrice: '1' },
    { symbol: 'DUSDT', priceChangePercent: '-1', quoteVolume: '100', lastPrice: '1' },
    { symbol: 'EUSDT', priceChangePercent: '-3', quoteVolume: '100', lastPrice: '1' },
    { symbol: 'FUSDT', priceChangePercent: '-8', quoteVolume: '100', lastPrice: '1' }
  ]);
  const r = await s.getTop10();
  assert.deepEqual(r.gainers.map(x => x.symbol), ['AUSDT', 'BUSDT']);
  assert.deepEqual(r.losers.map(x => x.symbol), ['FUSDT', 'EUSDT', 'DUSDT']);
  assert.ok(r.losers.every(x => x.changePct < 0));
  assert.ok(r.gainers.every(x => x.changePct > 0));
});
