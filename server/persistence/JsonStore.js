// 轻量原子 JSON 存储：V11.0 开发版为了减少 VSCode 安装难度不引入 native SQLite。
// 数据结构和接口已经独立，后续可无痛替换 SQLite。
const fs = require('fs');
const path = require('path');
class JsonStore {
  constructor(file, defaults = {}) { this.file = file; fs.mkdirSync(path.dirname(file), { recursive: true }); this.data = this.load(defaults); }
  load(defaults) { try { return { ...defaults, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { return JSON.parse(JSON.stringify(defaults)); } }
  save() { const temp = `${this.file}.tmp`; fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8'); fs.renameSync(temp, this.file); }
  get(key, fallback = null) { return this.data[key] ?? fallback; }
  set(key, value) { this.data[key] = value; this.save(); }
  patch(p) { Object.assign(this.data, p); this.save(); }
}
module.exports = JsonStore;
