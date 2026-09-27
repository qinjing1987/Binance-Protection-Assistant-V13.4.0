// 统一日志模块。
// 业务模块既可以 new Logger(dataDir) 使用实例，也可以直接调用 Logger.info/warn/error。
// V11.2.0：增强故障可追踪性。所有关键错误支持 code/status/阶段/traceId/stack，
// 同时继续对 API Key / Secret / Authorization / Signature 做脱敏。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redact } = require('./security/Redactor');

function buildErrorDetails(error, { includeStack = true } = {}) {
  if (!error) return null;
  const detail = {
    name: error.name || 'Error',
    message: String(error.message || error),
    code: error.code ?? null,
    status: error.status ?? null,
    retryAfterMs: error.retryAfterMs ?? null,
    protectionStage: error.protectionStage ?? null,
    traceId: error.traceId ?? null,
    targetType: error.targetType ?? null
  };
  if (error.payload && typeof error.payload === 'object') {
    detail.binance = {
      code: error.payload.code ?? null,
      msg: error.payload.msg ?? null
    };
  }
  if (includeStack && error.stack) detail.stack = String(error.stack).slice(0, 4000);
  return redact(detail);
}

class Logger {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'logs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'app.log');
    this.maxBytes = 10 * 1024 * 1024;
    this.maxBackups = 5;
    this.sequence = 0;
  }

  nextId(prefix = 'LOG') {
    this.sequence = (this.sequence + 1) % 1000000;
    return `${prefix}-${Date.now().toString(36)}-${this.sequence.toString(36)}`;
  }

  static errorDetails(error, options = {}) { return buildErrorDetails(error, options); }

  rotateIfNeeded(incomingBytes = 0) {
    try {
      const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      if (size + Number(incomingBytes || 0) < this.maxBytes) return false;
      for (let i = this.maxBackups; i >= 1; i--) {
        const src = i === 1 ? this.file : `${this.file}.${i - 1}`;
        const dst = `${this.file}.${i}`;
        if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      }
      return true;
    } catch (e) {
      process.stderr.write(`[Logger] 日志轮转失败: ${e.message}\n`);
      return false;
    }
  }

  readLines({ level = '', q = '', limit = 1000 } = {}) {
    const text = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : '';
    const wantedLevel = String(level || '').toUpperCase();
    const keyword = String(q || '').trim().toLowerCase();
    const max = Math.max(1, Math.min(5000, Number(limit) || 1000));
    const rows = text.split('\n').filter(Boolean).filter(line => {
      if (!wantedLevel && !keyword) return true;
      let obj = null;
      try { obj = JSON.parse(line); } catch {}
      if (wantedLevel && String(obj?.level || '').toUpperCase() !== wantedLevel) return false;
      if (keyword && !line.toLowerCase().includes(keyword)) return false;
      return true;
    });
    return rows.slice(-max).reverse();
  }

  clearLogs() {
    const removed = [];
    for (let i = 0; i <= this.maxBackups; i++) {
      const file = i === 0 ? this.file : `${this.file}.${i}`;
      try { if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); removed.push(path.basename(file)); } } catch {}
    }
    return removed;
  }

  normalizeMeta(meta = {}) {
    if (!meta || typeof meta !== 'object') return { value: meta };
    const out = { ...meta };
    const err = out.error instanceof Error ? out.error : (out.exception instanceof Error ? out.exception : null);
    if (err) {
      out.error = Logger.errorDetails(err);
      delete out.exception;
    }
    if (out.error && typeof out.error === 'object' && out.error.stack) {
      out.error = { ...out.error, stack: String(out.error.stack).slice(0, 4000) };
    }
    return redact(out);
  }

  log(level, message, meta = {}) {
    const row = {
      logId: this.nextId('LOG'),
      time: new Date().toISOString(),
      level,
      message: String(message),
      meta: this.normalizeMeta(meta)
    };
    const line = JSON.stringify(row);
    process.stdout.write(line + '\n');
    try {
      const bytes = Buffer.byteLength(line + '\n', 'utf8');
      this.rotateIfNeeded(bytes);
      fs.appendFileSync(this.file, line + '\n', 'utf8');
    } catch {}
  }

  info(message, meta = {}) { this.log('INFO', message, meta); }
  warn(message, meta = {}) { this.log('WARN', message, meta); }
  error(message, meta = {}) { this.log('ERROR', message, meta); }

  static configure(dataDir) {
    if (!dataDir) throw new Error('Logger.configure 缺少 dataDir');
    Logger._default = new Logger(dataDir);
    return Logger._default;
  }
  static instance() {
    // 未显式 configure 时（例如单元测试直接调用业务模块）写入系统临时目录，
    // 而不是 process.cwd() —— 否则测试从项目根运行会把日志写进项目的 logs/app.log，
    // 污染真实运行日志、误导排查。生产启动时 app.js 一定会先 configure(userDataDir)。
    if (!Logger._default) Logger._default = new Logger(path.join(os.tmpdir(), 'binance-protection-assistant'));
    return Logger._default;
  }
  static nextId(prefix) { return Logger.instance().nextId(prefix); }
  static log(level, message, meta = {}) { return Logger.instance().log(level, message, meta); }
  static info(message, meta = {}) { return Logger.instance().info(message, meta); }
  static warn(message, meta = {}) { return Logger.instance().warn(message, meta); }
  static error(message, meta = {}) { return Logger.instance().error(message, meta); }
}

module.exports = Logger;
