// Binance/前端/旧库可能出现 BTCUSDT、BTC/USDT、BTC/USDT:USDT 等格式。
// 统一为 Binance 原生 BTCUSDT，避免保护订单重复判断失败。
function normalizeSymbol(symbol) {
  let s = String(symbol || '').trim().toUpperCase();
  s = s.replace(/:\s*(USDT|USDC)$/i, ''); // BTC/USDT:USDT -> BTC/USDT
  s = s.replace(/[\/_-]/g, '');            // BTC/USDT -> BTCUSDT
  return s;
}
function positionKey(symbol, positionSide = 'BOTH') { return `${normalizeSymbol(symbol)}|${String(positionSide || 'BOTH').toUpperCase()}`; }
module.exports = { normalizeSymbol, positionKey };
