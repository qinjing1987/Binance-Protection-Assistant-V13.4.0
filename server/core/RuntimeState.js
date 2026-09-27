// 只保存当前进程状态，不保存秘密。
class RuntimeState {
  constructor() {
    this.version = '13.3.5';
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
