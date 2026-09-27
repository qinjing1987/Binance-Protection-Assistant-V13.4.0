const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.join(__dirname, '..', 'frontend', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';

function declaredFunctions(source) {
  return new Set([...source.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
}

test('V13.3.4：frontend 定义 logMsg，测试 Binance 连接错误不会被二次 ReferenceError 覆盖', () => {
  const funcs = declaredFunctions(script);
  assert.ok(funcs.has('logMsg'));
  assert.ok(funcs.has('testBinance'));
});

test('V13.3.4：所有 onclick/onchange handler 均有对应函数定义', () => {
  const funcs = declaredFunctions(script);
  const handlers = [...html.matchAll(/(?:onclick|onchange)="([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
  for (const name of handlers) assert.ok(funcs.has(name), `缺少 handler: ${name}`);
});
