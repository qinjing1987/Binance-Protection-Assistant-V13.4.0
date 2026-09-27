// 安全凭据存储：Windows 下优先使用 Electron safeStorage（DPAPI）。
// API Key / Secret 只在本机加密保存，绝不写入普通 settings.json 或日志。
const fs = require('fs');
const path = require('path');

function cleanCredential(value, label) {
  if (value == null) return '';
  let s = String(value).replace(/^\uFEFF/, '').trim();
  const prefixes = [`${label}=`, `${label} :`];
  for (const prefix of prefixes) {
    if (s.toUpperCase().startsWith(prefix.toUpperCase())) {
      s = s.slice(prefix.length).trim();
      break;
    }
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  if (/[^\x21-\x7E]/.test(s)) throw new Error(`${label} 含有空格、中文或不可见字符，请直接粘贴纯凭据内容`);
  return s;
}

class CredentialStore {
  constructor(userDataDir, safeStorage) {
    this.file = path.join(userDataDir, 'credentials.enc.json');
    this.safeStorage = safeStorage;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }
  _read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; } }
  _write(data) {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temp, this.file);
  }
  _encrypt(text) {
    if (!text) return '';
    if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error('当前 Windows 安全存储不可用，请重新启动 Electron 应用');
    return this.safeStorage.encryptString(String(text)).toString('base64');
  }
  _decrypt(encoded) {
    if (!encoded) return '';
    if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error('当前 Windows 安全存储不可用');
    return this.safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  }
  get() {
    const raw = this._read();
    let aiApiKeys = {};
    if (raw.aiApiKeys) {
      try { aiApiKeys = JSON.parse(this._decrypt(raw.aiApiKeys) || '{}'); } catch { aiApiKeys = {}; }
    } else if (raw.aiApiKey) {
      try {
        const legacy = this._decrypt(raw.aiApiKey || '');
        if (legacy) aiApiKeys.legacy = legacy;
      } catch {}
    }
    return {
      binanceApiKey: this._decrypt(raw.binanceApiKey || ''),
      binanceApiSecret: this._decrypt(raw.binanceApiSecret || ''),
      aiApiKeys
    };
  }
  masked() {
    const c = this.get();
    const mask = v => v ? `${v.slice(0, 4)}••••${v.slice(-4)}` : '';
    const aiApiKeysMasked = {};
    for (const [id, key] of Object.entries(c.aiApiKeys || {})) aiApiKeysMasked[id] = mask(key);
    return {
      binanceApiKey: mask(c.binanceApiKey),
      aiApiKeysMasked,
      hasBinanceSecret: !!c.binanceApiSecret,
      hasBinanceKey: !!c.binanceApiKey,
      hasAIKey: Object.keys(c.aiApiKeys || {}).length > 0,
      binanceApiKeyLength: c.binanceApiKey.length,
      binanceSecretLength: c.binanceApiSecret.length
    };
  }
  save(patch) {
    const current = this._read();
    if (patch.binanceApiKey !== undefined) {
      const v = cleanCredential(patch.binanceApiKey, 'BINANCE_API_KEY');
      if (v) current.binanceApiKey = this._encrypt(v);
    }
    if (patch.binanceApiSecret !== undefined) {
      const v = cleanCredential(patch.binanceApiSecret, 'BINANCE_API_SECRET');
      if (v) current.binanceApiSecret = this._encrypt(v);
    }
    if (patch.aiApiKeys && typeof patch.aiApiKeys === 'object') {
      let existing = {};
      if (current.aiApiKeys) {
        try { existing = JSON.parse(this._decrypt(current.aiApiKeys) || '{}'); } catch { existing = {}; }
      } else if (current.aiApiKey) {
        try {
          const legacy = this._decrypt(current.aiApiKey || '');
          if (legacy) existing.legacy = legacy;
        } catch {}
      }
      for (const [id, value] of Object.entries(patch.aiApiKeys)) {
        const key = String(id).trim();
        if (!key) continue;
        if (value === '' || value == null) { delete existing[key]; continue; }
        if (String(value).includes('••••')) continue;
        existing[key] = cleanCredential(value, `AI_API_KEY_${key.toUpperCase()}`);
      }
      current.aiApiKeys = this._encrypt(JSON.stringify(existing));
      delete current.aiApiKey;
    }
    this._write(current);
  }
  clear() { try { fs.unlinkSync(this.file); } catch {} }
}
module.exports = CredentialStore;
module.exports.cleanCredential = cleanCredential;
