// 对账恢复：以 Binance 实时仓位/Algo Orders 为依据，修复本地状态，不凭本地旧缓存臆测交易所状态。
const Logger = require('../Logger');
class Reconciliation {
  constructor({ binance, protection, state }) { this.binance = binance; this.protection = protection; this.state = state; this.lastSummary = { positions: 0, protectionFailures: 0 }; }
  async run() {
    if (!this.binance.initialized) await this.binance.init();
    const positions = await this.binance.fetchPositions();
    let protectionFailures = 0;
    for (const p of positions) {
      // 没有来源记录的一律按手动仓位处理，这是更保守的默认。
      if (!this.state.rawGet('positions', {})[this.state.key(p)]) this.state.setPositionSource(p, 'MANUAL');
      if (this.binance.actualHedgeMode && !['LONG', 'SHORT'].includes(p.positionSide)) Logger.warn('Hedge Mode 出现异常持仓方向', { symbol: p.symbol, positionSide: p.positionSide });
      try { await this.protection.reconcile(p, { forceConfig: true, reason: 'RECOVERY_RECONCILIATION' }); } catch (e) {
        protectionFailures++;
        if (!e.protectionLogged) Logger.error('恢复期间保护失败', { symbol: p.symbol, positionSide: p.positionSide, error: e, code: e.code || null, status: e.status || null, protectionStage: e.protectionStage || null, traceId: e.traceId || null });
      }
    }
    this.lastSummary = { positions: positions.length, protectionFailures };
    if (protectionFailures > 0) Logger.warn('恢复对账完成，但仍有保护失败', { positions: positions.length, protectionFailures }); else Logger.info('恢复对账完成', { positions: positions.length, protectionFailures });
    return positions;
  }
}
module.exports = Reconciliation;
