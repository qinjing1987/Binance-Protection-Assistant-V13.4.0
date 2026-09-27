const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateSuperTrend } = require('../server/monitoring/SuperTrendScanner');

function candlesFromCloses(closes) {
  return closes.map((close, i) => ({
    openTime: i * 300000,
    closeTime: i * 300000 + 299999,
    open: close,
    high: close * 1.002,
    low: close * 0.998,
    close
  }));
}

test('SuperTrend 返回最后一根已收盘K线方向，且不足历史K线时安全返回 null', () => {
  assert.equal(calculateSuperTrend(candlesFromCloses(Array.from({length: 8}, (_, i) => 10+i))), null);
  const r = calculateSuperTrend(candlesFromCloses(Array.from({length: 40}, (_, i) => 10+i*0.1)), 10, 3);
  assert.ok(r);
  assert.equal(r.candleTime, (39) * 300000);
  assert.ok([1,-1].includes(r.direction));
});

test('SuperTrend 能识别从下跌转为上涨的方向变化', () => {
  const values = [
    20,19.8,19.6,19.4,19.2,19.0,18.8,18.6,18.4,18.2,18.0,17.8,
    17.7,17.6,17.5,17.4,17.3,17.2,17.1,17.0,
    17.5,18.0,18.6,19.2,19.8,20.5,21.2,22.0,22.8,23.5,24.2,25.0,25.8,26.5,27.2,28.0,28.8,29.5,30.2,31.0
  ];
  const r = calculateSuperTrend(candlesFromCloses(values), 10, 3);
  assert.ok(r);
  assert.equal(r.direction, 1);
});


test('SuperTrend 首次扫描只建立基线，后续翻转才产生提示', async () => {
  const { SuperTrendScanner } = require('../server/monitoring/SuperTrendScanner');
  const ranking = {
    async getTop10() { return { gainers: [{ symbol: 'TESTUSDT', changePct: 15, quoteVolume: 1000000 }], losers: [] }; }
  };
  const down = Array.from({length: 40}, (_, i) => 20 - i * 0.1);
  const up = [...down, 26];
  const candles = closes => closes.map((close, i) => [i * 300000, close, close * 1.002, close * 0.998, close, 0, i * 300000 + 299999]);
  let phase = 0;
  const binance = { async fetchKlines() { return candles(phase === 0 ? down : up); } };
  const scanner = new SuperTrendScanner({ binance, ranking });
  const first = await scanner.scan();
  assert.equal(first.recentFlips.length, 0);
  phase = 1;
  const second = await scanner.scan();
  assert.ok(second.recentFlips.length >= 1);
  assert.equal(second.recentFlips[0].symbol, 'TESTUSDT');
  assert.equal(second.recentFlips[0].direction, 'UP');
});


test('BinanceClient.fetchKlines 使用 USDⓈ-M /fapi/v1/klines 公共接口并传入周期与数量', async () => {
  const BinanceClient = require('../server/binance/BinanceClient');
  const client = new BinanceClient({ credentialStore: { get: () => ({}) }, config: { get: () => ({ binanceSandbox: false }) } });
  let called = null;
  client.rawRequest = async (method, path, opts) => { called = { method, path, opts }; return []; };
  await client.fetchKlines('BTCUSDT', '1m', 120);
  assert.deepEqual(called, { method: 'GET', path: '/fapi/v1/klines', opts: { signed: false, params: { symbol: 'BTCUSDT', interval: '1m', limit: 120 } } });
});


test('SuperTrend 监控默认每1分钟扫描，并使用1m已收盘K线', () => {
  const { SuperTrendScanner } = require('../server/monitoring/SuperTrendScanner');
  const scanner = new SuperTrendScanner({ binance: {}, ranking: {} });
  const status = scanner.getStatus();
  assert.equal(status.intervalMs, 60 * 1000);
  assert.equal(status.intervalMinutes, 1);
  assert.equal(status.timeframe, '1m');
});
