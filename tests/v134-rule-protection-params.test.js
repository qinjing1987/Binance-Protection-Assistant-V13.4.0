// V13.4.0 回归：规则成交后必须把【规则自己的结构止损】写进保护状态。
//
// 背景（真实事故）：RuleAutoTrader 下单时把完整计划写进 ruleOrderPlans，
// 但挂单跟踪对象 this.pending 里没有 plannedSLPct/plannedTPPct。
// handleOrderUpdate 查计划的顺序是 `this.pending.get(orderId) || getRuleOrderPlan(cid)` ——
// pending 命中后遮蔽了持久化计划，导致 sl=0，规则算出的 0.4~2.5% 结构止损
// 从未写进保护状态，保护退回全局 MARGIN 配置（当时是 0.2% 价格止损），
// 开仓后几秒就被噪音扫掉。现场：KMNOUSDT 开仓到止损仅 4 秒。
const test = require('node:test');
const assert = require('node:assert/strict');

const { RuleAutoTrader } = require('../server/monitoring/RuleAutoTrader');

function makeTrader() {
  const protects = [];
  const plans = new Map();
  const trader = new RuleAutoTrader({
    config: {
      get: () => ({
        ruleTrading: { enabled: true, leverage: 10, orderTtlMinutes: 5, maxPendingOrders: 5, maxPositions: 5, cooldownMinutes: 10 },
        risk: { maxSlippagePct: 0 }
      })
    },
    state: {
      getRuleCooldown: () => 0, getCooldown: () => 0, setRuleCooldown: () => {},
      setRuleOrderPlan: (cid, plan) => plans.set(cid, { ...(plans.get(cid) || {}), ...plan }),
      getRuleOrderPlan: (cid) => plans.get(cid) || null,
      deleteRuleOrderPlan: (cid) => plans.delete(cid),
      setProtectionParams: (pos, p) => protects.push([pos, p]),
      rawGet: (_k, d) => d, rawSet: () => {}
    },
    ranking: {}, risk: {},
    binance: {
      actualHedgeMode: true,
      fetchPositions: async () => [],
      fetchOpenOrders: async () => [],
      fetchMarkPrice: async () => ({ markPrice: 100 }),
      createLimitOrder: async () => ({ orderId: '9001', status: 'NEW', executedQty: 0 }),
      maxInitialLeverage: async () => 20,
      // 杠杆复核用：返回与 signal.leverage 相同的值，ensureSymbolLeverage 直接早退
      getSymbolConfig: async () => ({ leverage: 10 }),
      setLeverage: async () => {}
    }
  });
  trader.running = true;
  return { trader, protects, plans };
}

const SIGNAL = {
  symbol: 'ABCUSDT', action: 'LONG', entry: 99.5, mark: 100,
  stopPrice: 97.0, tpPrice: 104.0, plannedSLPct: 2.5, plannedTPPct: 5.0,
  quantity: 10, leverage: 10
};

test('V13.4.0 回归：挂单跟踪对象必须带上结构止损字段（否则会遮蔽持久化计划）', async () => {
  const { trader } = makeTrader();
  await trader.placeLimit({ ...SIGNAL }, 'T1');

  const pending = [...trader.pending.values()][0];
  assert.ok(pending, '应登记挂单');
  assert.equal(pending.plannedSLPct, 2.5, 'pending 缺 plannedSLPct 会让成交时 sl=0');
  assert.equal(pending.plannedTPPct, 5.0);
  assert.equal(pending.stopPrice, 97.0);
  assert.equal(pending.tpPrice, 104.0);
  assert.equal(pending.entry, 99.5);
});

test('V13.4.0 回归：成交后写入 PRICE 模式的结构止损，而不是全局 MARGIN 配置', async () => {
  const { trader, protects } = makeTrader();
  await trader.placeLimit({ ...SIGNAL }, 'T2');
  const pending = [...trader.pending.values()][0];

  // 模拟币安成交推送
  trader.handleUserEvent({
    e: 'ORDER_TRADE_UPDATE',
    o: {
      c: pending.clientOrderId, i: '9001', s: 'ABCUSDT', ps: 'LONG', S: 'BUY',
      X: 'FILLED', x: 'TRADE', ap: '99.5', z: '10', l: '10', T: Date.now()
    }
  });

  assert.equal(protects.length, 1, '成交后必须写保护参数');
  const [pos, params] = protects[0];
  assert.equal(pos.symbol, 'ABCUSDT');
  assert.equal(params.mode, 'PRICE', '必须用 PRICE 模式，不能退回全局 MARGIN');
  assert.equal(params.stopLossPct, 2.5, '止损距离必须是规则算出的 2.5%，不是全局的 0.2%');
  assert.equal(params.takeProfitPct, 5.0);
  assert.equal(params.source, 'RULE_V13.3_STRUCTURE_PULLBACK');
  assert.equal(params.setupStop, 97.0);
});

test('V13.4.0 回归：即使 pending 缺字段，也应从持久化计划补全（防御性合并）', async () => {
  const { trader, protects, plans } = makeTrader();
  await trader.placeLimit({ ...SIGNAL }, 'T3');
  const pending = [...trader.pending.values()][0];

  // 人为抹掉 pending 上的结构止损字段，模拟旧数据 / 未来某条路径忘记赋值
  delete pending.plannedSLPct;
  delete pending.plannedTPPct;
  assert.ok(plans.get(pending.clientOrderId).plannedSLPct, '持久化计划里应有完整字段');

  trader.handleUserEvent({
    e: 'ORDER_TRADE_UPDATE',
    o: {
      c: pending.clientOrderId, i: '9001', s: 'ABCUSDT', ps: 'LONG', S: 'BUY',
      X: 'FILLED', x: 'TRADE', ap: '99.5', z: '10', l: '10', T: Date.now()
    }
  });

  assert.equal(protects.length, 1, '合并查找后仍应写入保护参数');
  assert.equal(protects[0][1].stopLossPct, 2.5, '缺失字段应由持久化计划补全');
});

test('V13.4.0 回归：计划彻底缺失时不写 PRICE 参数，也不抛错', async () => {
  const { trader, protects } = makeTrader();
  await trader.placeLimit({ ...SIGNAL }, 'T4');
  const pending = [...trader.pending.values()][0];
  trader.pending.delete(String(pending.orderId));
  trader.state.deleteRuleOrderPlan(pending.clientOrderId);

  trader.handleUserEvent({
    e: 'ORDER_TRADE_UPDATE',
    o: {
      c: pending.clientOrderId, i: '9001', s: 'ABCUSDT', ps: 'LONG', S: 'BUY',
      X: 'FILLED', x: 'TRADE', ap: '99.5', z: '10', l: '10', T: Date.now()
    }
  });

  assert.equal(protects.length, 0, '无计划时不应写入（由保护流程按全局配置兜底）');
});
