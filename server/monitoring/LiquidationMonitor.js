// 强平距离监控：优先使用 Binance positionRisk 返回的 liquidationPrice。
class LiquidationMonitor {
  snapshot(positions) {
    return positions.map(p => {
      const liq = Number(p.liquidationPrice || 0), mark = Number(p.markPrice || 0);
      const distancePct = liq > 0 && mark > 0 ? Math.abs(mark - liq) / mark * 100 : null;
      let level = 'NORMAL'; if (distancePct != null && distancePct < 5) level = 'DANGER'; else if (distancePct != null && distancePct < 7) level = 'HIGH'; else if (distancePct != null && distancePct < 10) level = 'WARN';
      return { symbol: p.symbol, positionSide: p.positionSide, liquidationPrice: liq, distancePct, level };
    });
  }
}
module.exports = LiquidationMonitor;
