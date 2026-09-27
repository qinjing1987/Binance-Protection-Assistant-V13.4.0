const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Logger = require('../server/Logger');

test('Logger 静态方法可用并写入日志', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qprotect-logger-'));
  Logger.configure(dir);
  assert.equal(typeof Logger.info, 'function');
  assert.equal(typeof Logger.warn, 'function');
  assert.equal(typeof Logger.error, 'function');
  Logger.info('测试日志', { apiKey: 'SHOULD_BE_REDACTED' });
  Logger.error('测试错误', { apiSecret: 'SECRET_SHOULD_NOT_APPEAR' });
  const file = path.join(dir, 'logs', 'app.log');
  assert.equal(fs.existsSync(file), true);
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /测试错误/);
  assert.match(content, /\"logId\":\"LOG-/);
  assert.doesNotMatch(content, /SECRET_SHOULD_NOT_APPEAR/);
});

test('日志脱敏会屏蔽 Bearer / key / secret', () => {
  Logger.info('敏感测试', {
    Authorization: 'Bearer VERY_SECRET_TOKEN',
    apiKey: 'PUBLIC_KEY_EXAMPLE',
    secret: 'PRIVATE_SECRET_EXAMPLE'
  });
});


test('Logger 记录 Error 对象的 code/status/stack 并保持脱敏', () => {
  const err = new Error('Binance测试失败');
  err.code = -1003;
  err.status = 429;
  err.retryAfterMs = 61000;
  err.stack = 'Error: Binance测试失败\n    at test SECRET=TOPSECRET';
  err.traceId = 'PROTECT-test';
  const detail = Logger.errorDetails(err);
  assert.equal(detail.code, -1003);
  assert.equal(detail.status, 429);
  assert.equal(detail.retryAfterMs, 61000);
  assert.equal(detail.traceId, 'PROTECT-test');
  assert.doesNotMatch(JSON.stringify(detail), /TOPSECRET/);
});


test('Logger 支持10MB前轮转并保留最多5份备份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qprotect-logger-rotate-'));
  Logger.configure(dir);
  const logger = Logger.instance();
  logger.maxBytes = 1024;
  logger.maxBackups = 5;
  logger.info('x'.repeat(900));
  logger.info('y'.repeat(900));
  assert.equal(fs.existsSync(path.join(dir, 'logs', 'app.log')), true);
  assert.equal(fs.existsSync(path.join(dir, 'logs', 'app.log.1')), true);
});

test('Logger 服务端读取支持级别与关键词过滤', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qprotect-logger-filter-'));
  Logger.configure(dir);
  const logger = Logger.instance();
  logger.info('alpha message', { module:'RULE' });
  logger.warn('beta message', { module:'PROTECT' });
  logger.error('alpha error', { module:'RULE' });
  assert.equal(logger.readLines({level:'WARN'}).length, 1);
  assert.equal(logger.readLines({q:'alpha'}).length, 2);
  assert.equal(logger.readLines({level:'ERROR',q:'alpha'}).length, 1);
});

test('Logger 清空会删除当前日志与轮转备份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qprotect-logger-clear-'));
  Logger.configure(dir);
  const logger = Logger.instance();
  logger.info('to clear');
  fs.writeFileSync(path.join(dir, 'logs', 'app.log.1'), 'backup');
  const removed = logger.clearLogs();
  assert.ok(removed.includes('app.log'));
  assert.ok(removed.includes('app.log.1'));
  assert.equal(fs.existsSync(path.join(dir, 'logs', 'app.log')), false);
});
