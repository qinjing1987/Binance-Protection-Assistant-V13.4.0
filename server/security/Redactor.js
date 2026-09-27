// ============================================================
// 日志脱敏模块
// 任何 API Key / Secret / Authorization / Signature 都不允许进入日志。
// ============================================================

function maskToken(value) {
  const s = String(value);
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function redact(value) {
  if (value == null) return value;

  if (typeof value === 'string') {
    // 常见 Bearer / key=value 形式统一脱敏。
    let out = value.replace(/(Bearer\s+)[^\s]+/gi, '$1••••');
    out = out.replace(/((?:api[_-]?key|secret|authorization|signature)\s*[:=]\s*)[^,\s]+/gi, '$1••••');
    out = out.replace(/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1••••');
    return out;
  }

  if (Array.isArray(value)) return value.map(redact);

  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/api.?key|secret|authorization|signature/i.test(key)) {
        out[key] = item ? maskToken(item) : '';
      } else {
        out[key] = redact(item);
      }
    }
    return out;
  }

  return value;
}

module.exports = { redact };
