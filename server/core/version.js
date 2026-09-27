// 版本号单一真相源：优先 package.json，其次 RELEASE_VERSION.txt。
// 目的：消除 runtime.version 与 package.json 脱钩导致的版本漂移。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function readVersion() {
  try {
    const pkg = require(path.join(ROOT, 'package.json'));
    if (pkg && pkg.version) return String(pkg.version);
  } catch (e) { /* 打包后 package.json 可能不可读，退化到 RELEASE_VERSION.txt */ }
  try {
    const txt = fs.readFileSync(path.join(ROOT, 'RELEASE_VERSION.txt'), 'utf8').trim();
    if (txt) return txt;
  } catch (e) { /* 两个来源都不可用时返回占位符，不抛错 */ }
  return '0.0.0-unknown';
}

module.exports = { readVersion };
