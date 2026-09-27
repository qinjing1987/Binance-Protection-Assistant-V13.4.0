const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSymbol, positionKey } = require('../server/utils/symbol');

const BinanceClient = require('../server/binance/BinanceClient');
const PositionMonitor = require('../server/protection/PositionMonitor');


test('symbol normalization', () => {
  assert.equal(normalizeSymbol('BTCUSDT'), 'BTCUSDT');
  assert.equal(normalizeSymbol('BTC/USDT'), 'BTCUSDT');
  assert.equal(normalizeSymbol('BTC/USDT:USDT'), 'BTCUSDT');
  assert.equal(positionKey('BTC/USDT:USDT', 'LONG'), 'BTCUSDT|LONG');
});

test('long / short position keys remain independent', () => {
  assert.notEqual(positionKey('ETHUSDT', 'LONG'), positionKey('ETHUSDT', 'SHORT'));
});

const { buildCanonicalQuery } = require('../server/binance/BinanceClient');

test('Binance signed query is canonical and URL-encoded', () => {
  assert.equal(
    buildCanonicalQuery({ symbol: 'BTCUSDT', recvWindow: 10000, timestamp: 123 }),
    'recvWindow=10000&symbol=BTCUSDT&timestamp=123'
  );
  assert.equal(buildCanonicalQuery({ reason: 'A B' }), 'reason=A%20B');
});

test('Binance path must not contain query string', () => {
  assert.equal(typeof buildCanonicalQuery, 'function');
});

test('持仓读取使用 V3 positionRisk，并通过 symbolConfig 获取真实当前杠杆', async () => {
  const cfg = { get: () => ({ binanceSandbox: false }) };
  const creds = { get: () => ({ binanceApiKey: 'k', binanceApiSecret: 's' }) };
  const client = new BinanceClient({ credentialStore: creds, config: cfg });
  const calls = [];
  client.rawRequest = async (method, path, opts) => {
    calls.push({ method, path, opts });
    if (path === '/fapi/v3/positionRisk') return [{
      symbol: '4USDT', positionSide: 'SHORT', positionAmt: '-203',
      entryPrice: '0.025039', markPrice: '0.025019', liquidationPrice: '0.025637',
      unRealizedProfit: '0.00', isolatedMargin: '0.26', notional: '-5.08'
    }];
    if (path === '/fapi/v1/symbolConfig') return [{ symbol: '4USDT', leverage: '20', marginType: 'ISOLATED', isAutoAddMargin: false }];
    throw new Error(`unexpected ${path}`);
  };
  const rows = await client.fetchPositions('4USDT', { forceConfig: true });
  assert.ok(calls.some(x => x.path === '/fapi/v3/positionRisk'));
  assert.ok(calls.some(x => x.path === '/fapi/v1/symbolConfig'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].leverage, 20);
  assert.equal(rows[0].leverageSource, 'BINANCE_SYMBOL_CONFIG');
  assert.equal(rows[0].side, 'short');
  assert.equal(rows[0].contracts, 203);
});

test('symbolConfig 读取失败时仍保留真实仓位，但杠杆明确标记未读取', async () => {
  const cfg = { get: () => ({ binanceSandbox: false }) };
  const creds = { get: () => ({ binanceApiKey: 'k', binanceApiSecret: 's' }) };
  const client = new BinanceClient({ credentialStore: creds, config: cfg });
  client.rawRequest = async (_m, path) => {
    if (path === '/fapi/v3/positionRisk') return [{ symbol: '4USDT', positionSide: 'SHORT', positionAmt: '-203', entryPrice: '0.025', markPrice: '0.025', liquidationPrice: '0.026', unRealizedProfit: '0', isolatedMargin: '0.25', notional: '-5' }];
    throw new Error('SYMBOL CONFIG DOWN');
  };
  const rows = await client.fetchPositions('4USDT', { forceConfig: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].leverage, 0);
  assert.equal(rows[0].leverageSource, 'NOT_READ');
  assert.match(rows[0].configReadError, /SYMBOL CONFIG DOWN/);
});

test('ACCOUNT_CONFIG_UPDATE 同步时强制刷新 symbolConfig，不能命中旧杠杆缓存', async () => {
  const calls = [];
  const pos = () => ({ symbol: '4USDT', positionSide: 'SHORT', contracts: 203, entryPrice: 0.025, leverage: 20, liquidationPrice: 0.026, side: 'short' });
  const monitor = new PositionMonitor({
    binance: {
      fetchPositions: async (_symbol, opts) => { calls.push(opts); return [pos()]; }
    },
    userStream: { handlers: {}, on(name, fn) { this.handlers[name] = fn; }, start: async () => {}, stop() {} }
  });
  await monitor.start();
  await monitor.userStream.handlers.event({ e: 'ACCOUNT_CONFIG_UPDATE', ac: { s: '4USDT', l: 20 } });
  assert.equal(calls[0].forceConfig, false);
  assert.equal(calls[1].forceConfig, true);
  monitor.stop();
});
