// 只保存当前进程状态，不保存秘密。
const { readVersion } = require('./version');

class RuntimeState {
  constructor() {
    // 单一真相源：读 package.json，避免与前端/日志版本号漂移。
    this.version = readVersion();
    this.status = 'STARTING';
    this.wsConnected = false;
    this.positions = [];
    this.ranking = null;
    this.lastAI = null;
    this.lastError = null;
    this.binance = null;
    this.ai = null;
    this.equity = 0;
    this.availableBalance = 0;
    this.lastSyncAt = 0;
    this.lastAccountAt = 0;
  }
}
module.exports = RuntimeState;
