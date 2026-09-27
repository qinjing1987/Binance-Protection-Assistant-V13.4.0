const test = require('node:test');
const assert = require('node:assert/strict');
const BinanceClient = require('../server/binance/BinanceClient');

test('V13.3.5：账户接口 totalMarginBalance 为0时，权益读取回退 totalWalletBalance', async () => {
  const client = Object.create(BinanceClient.prototype);
  client.getAccount = async () => ({ totalMarginBalance: '0', totalWalletBalance: '1.25' });
  client.getBalance = async () => [{ asset: 'USDT', balance: '1.25' }];
  assert.equal(await client.fetchAccountEquity(), 1.25);
});

test('V13.3.5：账户接口完全无正权益时仍返回0，不伪造可用资金', async () => {
  const client = Object.create(BinanceClient.prototype);
  client.getAccount = async () => ({ totalMarginBalance: '0', totalWalletBalance: '0' });
  client.getBalance = async () => [{ asset: 'USDT', balance: '0' }];
  assert.equal(await client.fetchAccountEquity(), 0);
});
