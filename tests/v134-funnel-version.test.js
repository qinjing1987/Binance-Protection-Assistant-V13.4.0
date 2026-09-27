// V13.4.0：版本号单一真相源 + 逐阶段通过率漏斗 回归测试
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { RuleAutoTrader } = require('../server/monitoring/RuleAutoTrader');
const { readVersion } = require('../server/core/version');

const root = path.join(__dirname, '..');

function makeTrader(cfg = {}) {
  return new RuleAutoTrader({
    config: { get: () => ({ ruleTrading: { rsiLongDepth: 42, rsiShortDepth: 58, ...cfg } }) },
    state: { getRuleCooldown: () => 0, getCooldown: () => 0 },
    ranking: {},
    risk: {},
    binance: {}
  });
}

// 构造一个进入 RSI 阶段且带三条件的决策对象
function rsiDecision({ action = 'LONG', depthReached, crossed, slopeConfirmed, depthExtreme = 50 }) {
  return { stage: 'RSI', action, status: 'SKIP', rsiDepthReached: depthReached, rsiCrossed: crossed, rsiSlopeConfirmed: slopeConfirmed, rsiDepthExtreme: depthExtreme };
}

// 漏斗结构断言：主链严格单调，RSI 背离是"旁路"而非链环，单独校验它的不变式。
// 主链：FUNDING → TREND → RSI_DEPTH → RSI_RECOVERY → RSI_SLOPE →(并入背离)→ VOLUME → ENTRY → RISK → PLACE
function assertFunnelShape(f) {
  const byKey = Object.fromEntries(f.stages.map(s => [s.key, s]));
  let prev = Infinity;
  for (const k of ['FUNDING', 'TREND', 'RSI_DEPTH', 'RSI_RECOVERY', 'RSI_SLOPE']) {
    const s = byKey[k];
    assert.ok(s, `缺少阶段 ${k}`);
    assert.ok(s.passed <= s.entered, `${k}: passed(${s.passed}) 不得超过 entered(${s.entered})`);
    assert.ok(s.passed <= prev, `${k}: passed 必须单调不增`);
    assert.ok(s.blocked >= 0, `${k}: blocked 不得为负`);
    prev = s.passed;
  }
  const div = byKey.RSI_DIVERGENCE;
  assert.ok(div, '缺少 RSI_DIVERGENCE 阶段');
  // 背离的"进入数"= 到了 RSI 但三条件没过的币（只有它们会被判背离）
  assert.equal(div.entered, Math.max(0, byKey.TREND.passed - byKey.RSI_SLOPE.passed), '背离进入数应等于三条件失败者数量');
  assert.ok(div.passed <= div.entered, '背离通过数不得超过进入数');
  // 主链在 RSI 之后的入口 = 三条件通过 + 背离通过（两条通路互斥，不重复计数）
  assert.equal(byKey.VOLUME.entered, byKey.RSI_SLOPE.passed + div.passed, 'Volume 入口应等于三条件通过 + 背离通过');
  let p2 = byKey.VOLUME.passed;
  assert.ok(p2 <= byKey.VOLUME.entered);
  for (const k of ['ENTRY', 'RISK', 'PLACE']) {
    const s = byKey[k];
    assert.ok(s, `缺少阶段 ${k}`);
    assert.ok(s.passed <= s.entered, `${k}: passed 不得超过 entered`);
    assert.ok(s.passed <= p2, `${k}: passed 必须单调不增`);
    p2 = s.passed;
  }
}

test('V13.4.0：readVersion 返回 package.json 的版本，与 RELEASE_VERSION.txt 一致', () => {
  const pkgVersion = require('../package.json').version;
  assert.equal(readVersion(), pkgVersion);
  assert.equal(readVersion(), '13.4.0');
  const txt = fs.readFileSync(path.join(root, 'RELEASE_VERSION.txt'), 'utf8').trim();
  assert.equal(txt, pkgVersion, 'RELEASE_VERSION.txt 必须与 package.json 一致');
});

test('V13.4.0：后端不再硬编码版本号赋值（历史注释不算）', () => {
  // 只禁止「版本号赋值」，不禁用历史注释里提到的旧版本 —— 那些注释解释了代码为何如此，必须保留。
  const runtimeState = fs.readFileSync(path.join(root, 'server/core/RuntimeState.js'), 'utf8');
  assert.ok(!/this\.version\s*=\s*'/.test(runtimeState), 'RuntimeState 不应硬编码 this.version 字面量');

  const app = fs.readFileSync(path.join(root, 'server/app.js'), 'utf8');
  assert.ok(!/runtime\.version\s*=\s*'/.test(app), 'app.js 不应再覆盖 runtime.version');

  const main = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
  assert.ok(!/title:\s*'[^']*V\d/.test(main), '窗口标题不应硬编码版本号');
  assert.ok(main.includes('readVersion()'), '窗口标题应来自 readVersion()');
});

test('V13.4.0：策略标识符里的 V13.3 不能被误改（测试与持久化数据依赖）', () => {
  const src = fs.readFileSync(path.join(root, 'server/monitoring/RuleAutoTrader.js'), 'utf8');
  assert.ok(src.includes("entryMode: 'V13.3_TREND_RSI_DEPTH_VOLUME_PULLBACK'"));
  assert.ok(src.includes("source: 'RULE_V13.3_STRUCTURE_PULLBACK'"));
});

test('V13.4.0：漏斗各阶段通过人数单调不增，且不超过候选总数', () => {
  const t = makeTrader();
  const decisions = [];
  // 40 候选：14 个趋势不符
  for (let i = 0; i < 14; i++) decisions.push({ stage: 'TREND', action: 'LONG', status: 'SKIP' });
  // 26 个进入 RSI：7 个深度不够
  for (let i = 0; i < 7; i++) decisions.push(rsiDecision({ depthReached: false, crossed: false, slopeConfirmed: false }));
  // 剩余 19 个过深度，其中 7 个未回升 → 12 个过回升
  for (let i = 0; i < 7; i++) decisions.push(rsiDecision({ depthReached: true, crossed: false, slopeConfirmed: false }));
  // 12 个过回升，其中 4 个斜率不确认 → 8 个过斜率
  for (let i = 0; i < 4; i++) decisions.push(rsiDecision({ depthReached: true, crossed: true, slopeConfirmed: false }));
  // 8 个过 RSI，成交量拦 3 → 5
  for (let i = 0; i < 3; i++) decisions.push({ stage: 'VOLUME', action: 'LONG', status: 'SKIP' });
  // 5 个过成交量，结构拦 1 → 4
  decisions.push({ stage: 'ENTRY', action: 'LONG', status: 'SKIP' });
  // 4 个过结构，风控拦 2 → 2
  for (let i = 0; i < 2; i++) decisions.push({ stage: 'RISK', action: 'LONG', status: 'SKIP' });
  // 2 个全通过
  for (let i = 0; i < 2; i++) decisions.push({ stage: 'PASS', action: 'LONG', status: 'READY' });

  const f = t.buildFunnel({ decisions, candidates: 40, ordersPlaced: 2, indicatorPass: 2 });
  const byKey = Object.fromEntries(f.stages.map(s => [s.key, s]));

  assert.equal(f.candidates, 40);
  assert.equal(byKey.TREND.entered, 40);
  assert.equal(byKey.TREND.passed, 26, '40 候选 - 14 趋势不符 = 26');
  assert.equal(byKey.RSI_DEPTH.passed, 19);
  assert.equal(byKey.RSI_RECOVERY.passed, 12);
  assert.equal(byKey.RSI_SLOPE.passed, 8);
  assert.equal(byKey.VOLUME.passed, 5);
  assert.equal(byKey.ENTRY.passed, 4);
  assert.equal(byKey.RISK.passed, 2);
  assert.equal(byKey.PLACE.passed, 2);

  assertFunnelShape(f);
  assert.ok(f.stages[0].entered <= f.candidates);
});

test('V13.4.0：RSI 一币多 reason 只计一次（用户观察到的 19+26+16=75≠40 问题的根因）', () => {
  const t = makeTrader();
  // 一个币同时命中深度/回升/斜率三个失败条件
  const decisions = [{
    stage: 'RSI',
    action: 'LONG',
    status: 'SKIP',
    reason: 'RSI_DEPTH_NOT_REACHED',
    reasons: ['RSI_DEPTH_NOT_REACHED', 'RSI_RECOVERY_NOT_CONFIRMED', 'RSI_SLOPE_NOT_CONFIRMED'],
    rsiDepthReached: false,
    rsiCrossed: false,
    rsiSlopeConfirmed: false,
    rsiDepthExtreme: 55
  }];
  const f = t.buildFunnel({ decisions, candidates: 1, ordersPlaced: 0, indicatorPass: 0 });
  const byKey = Object.fromEntries(f.stages.map(s => [s.key, s]));
  assert.equal(byKey.TREND.passed, 1, '该币通过了趋势阶段');
  assert.equal(byKey.RSI_DEPTH.passed, 0, '深度未过');
  assert.equal(byKey.RSI_DEPTH.blocked, 1, '只应计 1 次，而非 3 次');
  // 全链通过人数任何一格都不得超过候选总数
  for (const s of f.stages) assert.ok(s.passed <= 1 && s.entered <= 1, `${s.key} 不得超过候选总数`);
});

test('V13.4.0：前置校验与评估异常计入 preTrendBlocked，漏斗仍单调', () => {
  const t = makeTrader();
  const decisions = [
    { stage: 'PRECHECK', action: 'LONG', status: 'SKIP' },
    { stage: 'ERROR', action: 'LONG', status: 'ERROR' },
    { stage: 'TREND', action: 'LONG', status: 'SKIP' },
    { stage: 'PASS', action: 'LONG', status: 'READY' }
  ];
  const f = t.buildFunnel({ decisions, candidates: 4, ordersPlaced: 1, indicatorPass: 1 });
  assert.equal(f.preTrendBlocked, 2, 'PRECHECK + ERROR 都应计入');
  const byKey = Object.fromEntries(f.stages.map(s => [s.key, s]));
  assert.equal(byKey.FUNDING.entered, 2, '4 - 2 前置出局 = 2 进入费率阶段');
  assert.equal(byKey.FUNDING.passed, 2, '本轮无费率拦截');
  assert.equal(byKey.TREND.entered, 2, '费率阶段未拦截，2 个进入趋势');
  assert.equal(byKey.TREND.passed, 1, '再减去 1 个趋势不符');
});

test('V13.4.0：candidates=0（整轮被闸门跳过）时漏斗不炸且全为 0', () => {
  const t = makeTrader();
  const f = t.buildFunnel({ decisions: [], candidates: 0, ordersPlaced: 0, indicatorPass: 0 });
  assert.equal(f.candidates, 0);
  assert.equal(f.stages.length, 10);
  for (const s of f.stages) {
    assert.equal(s.passed, 0);
    assert.equal(s.entered, 0);
    assert.equal(s.blocked, 0);
  }
});

test('V13.4.0：RSI 深度 0 通过时给出参数敏感度提示', () => {
  const t = makeTrader({ rsiLongDepth: 42, rsiShortDepth: 58 });
  const decisions = [
    rsiDecision({ action: 'LONG', depthReached: false, crossed: false, slopeConfirmed: false, depthExtreme: 46 }),
    rsiDecision({ action: 'LONG', depthReached: false, crossed: false, slopeConfirmed: false, depthExtreme: 49 }),
    rsiDecision({ action: 'SHORT', depthReached: false, crossed: false, slopeConfirmed: false, depthExtreme: 53 })
  ];
  const f = t.buildFunnel({ decisions, candidates: 3, ordersPlaced: 0, indicatorPass: 0 });
  assert.ok(f.rsiSensitivity, '深度 0 通过时应给出敏感度');
  assert.equal(f.rsiSensitivity.longNeedsDepth, 46, 'LONG 需放宽到最浅的那个极值 46');
  assert.equal(f.rsiSensitivity.shortNeedsDepth, 53, 'SHORT 需收紧到 53');
  assert.equal(f.rsiSensitivity.longCurrentDepth, 42);
  assert.equal(f.rsiSensitivity.shortCurrentDepth, 58);
});

test('V13.4.0：RSI 深度有通过时不报敏感度（避免噪音）', () => {
  const t = makeTrader();
  const decisions = [rsiDecision({ depthReached: true, crossed: true, slopeConfirmed: true, depthExtreme: 30 })];
  const f = t.buildFunnel({ decisions, candidates: 1, ordersPlaced: 0, indicatorPass: 1 });
  assert.equal(f.rsiSensitivity, null);
});

test('V13.4.0：有决策未打 stage 标记时标记为降级，不给出貌似可信的错数', () => {
  const t = makeTrader();
  // 模拟将来某条返回路径忘记打 stage
  const decisions = [{ stage: 'TREND', action: 'LONG', status: 'SKIP' }, { action: 'LONG', status: 'SKIP', reason: 'FORGOT_STAGE' }];
  const f = t.buildFunnel({ decisions, candidates: 2, ordersPlaced: 0, indicatorPass: 0 });
  assert.equal(f.unstaged, 1, '未打标记的决策应被单独计数');
  assert.equal(f.degraded, true, '应标记降级，前端据此显示告警');

  // 全部打了标记则不应降级
  const ok = t.buildFunnel({ decisions: [{ stage: 'TREND', action: 'LONG', status: 'SKIP' }], candidates: 1, ordersPlaced: 0, indicatorPass: 0 });
  assert.equal(ok.degraded, false);
});

test('V13.4.0：真实 scan() 端到端把 funnel 写进 lastSummary', async () => {
  const trader = new RuleAutoTrader({
    config: { get: () => ({ ruleTrading: { enabled: true, topN: 20, maxPositions: 99, maxPendingOrders: 99, rsiLongDepth: 42, rsiShortDepth: 58 } }) },
    state: { getRuleCooldown: () => 0, getCooldown: () => 0, setRuleCooldown: () => {}, rawGet: () => null, rawSet: () => {} },
    ranking: {},
    risk: { canRuleAutoTrade: async () => ({ ok: true }) },
    binance: { fetchPositions: async () => [], fetchOpenOrders: async () => [] }
  });
  trader.running = true;
  trader.ranking = {
    getRankings: async () => ({
      gainers: Array.from({ length: 20 }, (_, i) => ({ symbol: `G${i}USDT`, changePct: 20 - i })),
      losers: Array.from({ length: 20 }, (_, i) => ({ symbol: `L${i}USDT`, changePct: -20 + i }))
    })
  };
  // 用 mapLimit 传入的 index（与候选数组顺序对应），不能用自增计数器 —— 并发完成顺序不确定。
  trader.evaluateCandidate = async (c, ctx, index) => {
    const base = { symbol: c.symbol, action: c.action, rank: index + 1, status: 'SKIP' };
    if (index < 14) return { ...base, stage: 'TREND', reason: '5M_TREND_MISMATCH' };
    if (index < 21) return { ...base, stage: 'RSI', reason: 'RSI_DEPTH_NOT_REACHED', rsiDepthReached: false, rsiCrossed: false, rsiSlopeConfirmed: false, rsiDepthExtreme: 50 };
    if (index < 28) return { ...base, stage: 'RSI', reason: 'RSI_RECOVERY_NOT_CONFIRMED', rsiDepthReached: true, rsiCrossed: false, rsiSlopeConfirmed: false, rsiDepthExtreme: 40 };
    if (index < 32) return { ...base, stage: 'RSI', reason: 'RSI_SLOPE_NOT_CONFIRMED', rsiDepthReached: true, rsiCrossed: true, rsiSlopeConfirmed: false, rsiDepthExtreme: 40 };
    return { ...base, stage: 'RISK', reason: 'QTY_BELOW_MIN' };
  };

  const result = await trader.scan();
  const f = result.lastSummary.funnel;
  assert.ok(f, 'funnel 必须出现在 lastSummary 中');
  assert.equal(result.lastSummary.candidates, 40);
  assert.equal(f.degraded, false, '真实扫描路径所有决策都应有 stage');
  const byKey = Object.fromEntries(f.stages.map(s => [s.key, s]));
  assert.equal(byKey.TREND.passed, 26, '40 - 14 趋势不符');
  assert.equal(byKey.RSI_DEPTH.passed, 19, '26 进入 RSI - 7 深度不足');
  assert.equal(byKey.RSI_RECOVERY.passed, 12, '19 - 7 未回升');
  assert.equal(byKey.RSI_SLOPE.passed, 8, '12 - 4 斜率不确认');
  assert.equal(byKey.RISK.passed, 0, '8 个全通过被风控拦下');
  assert.equal(f.stages[0].entered, 40);
  assertFunnelShape(f);
});

test('V13.4.0：renderRuleFunnel 把各阶段人数渲染到正确的格子（功能性验证）', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
  const src = script.match(/function renderRuleFunnel\([\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'renderRuleFunnel 必须已声明');

  // 极简 DOM 桩：只实现 $ / className / querySelector('i')
  const els = {};
  const mkEl = () => {
    const count = { innerHTML: '' };
    return { className: '', textContent: '', innerHTML: '', querySelector: () => count, _count: count };
  };
  for (const id of ['flowRank', 'flowTrend', 'flowRsiDepth', 'flowRsiRecovery', 'flowRsiSlope', 'flowVol', 'flowEntry', 'flowRisk', 'flowPlace', 'ruleFunnelNote']) els[id] = mkEl();
  const $ = (id) => els[id];
  const render = new Function('$', `${src}\nreturn renderRuleFunnel;`)($);

  const t = makeTrader();
  const decisions = [];
  for (let i = 0; i < 14; i++) decisions.push({ stage: 'TREND', action: 'LONG', status: 'SKIP' });
  for (let i = 0; i < 7; i++) decisions.push(rsiDecision({ depthReached: false, crossed: false, slopeConfirmed: false }));
  for (let i = 0; i < 7; i++) decisions.push(rsiDecision({ depthReached: true, crossed: false, slopeConfirmed: false }));
  for (let i = 0; i < 4; i++) decisions.push(rsiDecision({ depthReached: true, crossed: true, slopeConfirmed: false }));
  for (let i = 0; i < 3; i++) decisions.push({ stage: 'VOLUME', action: 'LONG', status: 'SKIP' });
  decisions.push({ stage: 'ENTRY', action: 'LONG', status: 'SKIP' });
  for (let i = 0; i < 2; i++) decisions.push({ stage: 'RISK', action: 'LONG', status: 'SKIP' });
  for (let i = 0; i < 2; i++) decisions.push({ stage: 'PASS', action: 'LONG', status: 'READY' });
  const funnel = t.buildFunnel({ decisions, candidates: 40, ordersPlaced: 2, indicatorPass: 2 });

  render({ funnel }, {});

  // 每个格子的 class 与「通过/进入」计数都应落到对应元素上
  assert.equal(els.flowRank.className, 'flow-step pass');
  assert.equal(els.flowRank._count.innerHTML, '40<em>/40</em>', '候选池应显示 40/40');
  assert.equal(els.flowTrend._count.innerHTML, '26<em>/40</em>');
  assert.equal(els.flowRsiDepth._count.innerHTML, '19<em>/26</em>');
  assert.equal(els.flowRsiRecovery._count.innerHTML, '12<em>/19</em>');
  assert.equal(els.flowRsiSlope._count.innerHTML, '8<em>/12</em>');
  assert.equal(els.flowVol._count.innerHTML, '5<em>/8</em>');
  assert.equal(els.flowEntry._count.innerHTML, '4<em>/5</em>');
  assert.equal(els.flowRisk._count.innerHTML, '2<em>/4</em>');
  assert.equal(els.flowPlace._count.innerHTML, '2<em>/2</em>');
  assert.ok(els.ruleFunnelNote.textContent.includes('候选 40'), '备注应显示候选数');

  // 未扫描时不应抛错，且格子回到 wait 状态
  const blank = mkEl();
  els.flowTrend.className = 'flow-step pass';
  render({}, {});
  assert.equal(els.flowTrend.className, 'flow-step wait');
  assert.equal(els.ruleFunnelNote.textContent, '等待扫描…');
  assert.ok(blank.className === '', 'DOM 桩不应被污染');
});

test('V13.4.0：漏斗数据降级时前端显示告警，不照常展示可能失真的数字', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
  const src = script.match(/function renderRuleFunnel\([\s\S]*?\n\}/)?.[0];
  const els = {};
  const mkEl = () => { const count = { innerHTML: '' }; return { className: '', textContent: '', innerHTML: '', querySelector: () => count, _count: count }; };
  for (const id of ['flowRank', 'flowTrend', 'flowRsiDepth', 'flowRsiRecovery', 'flowRsiSlope', 'flowVol', 'flowEntry', 'flowRisk', 'flowPlace', 'ruleFunnelNote']) els[id] = mkEl();
  const render = new Function('$', `${src}\nreturn renderRuleFunnel;`)((id) => els[id]);

  const t = makeTrader();
  const funnel = t.buildFunnel({ decisions: [{ action: 'LONG', status: 'SKIP', reason: 'FORGOT_STAGE' }], candidates: 1, ordersPlaced: 0, indicatorPass: 0 });
  assert.equal(funnel.degraded, true);
  render({ funnel }, {});
  assert.ok(els.ruleFunnelNote.innerHTML.includes('漏斗数据降级'), '应显示降级告警');
});

test('V13.4.0：未配置时 Logger 不得写入 process.cwd()，避免测试污染项目日志', () => {
  const src = fs.readFileSync(path.join(root, 'server/Logger.js'), 'utf8');
  assert.ok(!/new Logger\(process\.cwd\(\)\)/.test(src), '未配置时不应回退到 process.cwd()');
  assert.ok(src.includes("os.tmpdir()"), '应回退到系统临时目录');
  // 生产路径仍必须显式配置 userDataDir
  const app = fs.readFileSync(path.join(root, 'server/app.js'), 'utf8');
  assert.ok(app.includes('Logger.configure(userDataDir)'), '生产启动必须显式 configure(userDataDir)');
});

test('V13.4.0：规则面板子块横向并排（漏斗嵌入三列诊断区）', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const diag = html.match(/<div class="rule-diagnostics">([\s\S]*?)\n\s*<\/div>\n/) || [];
  const block = diag[1] || '';
  assert.ok(block.includes('class="rule-flow"'), '漏斗应嵌入 rule-diagnostics 内作为第一列');
  assert.ok(block.includes('id="ruleFunnelNote"'), '漏斗备注也应同列');
  assert.ok(block.includes('本轮阻断原因'), '第二列应为阻断原因');
  assert.ok(block.includes('逐币诊断'), '第三列应为逐币诊断');
  // 三列布局
  assert.ok(/\.rule-diagnostics\{[^}]*grid-template-columns:minmax\(150px/.test(html), '诊断区应为三列 minmax 布局');
  // 漏斗在其窄列内应为纵向单列（而非原来的 9 列横排）
  assert.ok(/\.rule-flow\{display:grid;grid-template-columns:1fr;/.test(html), '漏斗应改为纵向单列');
});

test('V13.4.0：规则面板跨满 grid-main 整行，不再被挤在窄列里', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  // 面板必须带 grid-column:1/-1 才能跨满三列
  assert.ok(/<div class="panel" id="ruleTradingPanel" style="grid-column:1\/-1"/.test(html), '规则面板应跨满整行');

  // 且必须是 grid-main 的直接子元素 —— 位于 right-col 闭合之后、grid-main 的 </section> 之前
  const s = html.indexOf('<section class="grid-main">');
  const e = html.indexOf('id="logPanel"', s);
  const seg = html.slice(s, e);
  const panelAt = seg.indexOf('id="ruleTradingPanel"');
  assert.ok(panelAt > 0, '规则面板应在 grid-main 段内');
  // 截到面板开标签之前，避免切进标签中间
  const panelTagAt = seg.lastIndexOf('<div class="panel" id="ruleTradingPanel"', panelAt);
  const before = seg.slice(0, panelTagAt);
  // 面板之前应恰好出现 3 个列容器，且 right-col 已经闭合（div 配平为 0）
  assert.equal((before.match(/<div class="col/g) || []).length, 3, '面板之前应有三个列容器');
  const rightColAt = before.lastIndexOf('<div class="col right-col"');
  assert.ok(rightColAt > 0, '应能找到 right-col');
  const afterRightCol = before.slice(rightColAt);
  const o = (afterRightCol.match(/<div\b/g) || []).length;
  const c = (afterRightCol.match(/<\/div>/g) || []).length;
  assert.equal(o, c, `right-col 必须已在规则面板之前闭合（开 ${o} / 闭 ${c}），否则面板仍在窄列内`);

  // 防御：漏斗渲染抛错不得连累其余面板（曾导致逐币诊断整块不显示）
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
  assert.ok(/try\{renderRuleFunnel\(sum,x\)\}catch/.test(script), 'renderRuleFunnel 调用必须被 try/catch 包裹');
});

test('V13.4.0：当前委托面板紧跟实时持仓，且在 refresh 中被渲染', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const positionsAt = html.indexOf('id="positionsPanel"');
  const ordersAt = html.indexOf('id="ordersPanel"');
  assert.ok(ordersAt > positionsAt && positionsAt > 0, '当前委托面板必须在实时持仓面板之后');

  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
  assert.ok(/function renderOrders\s*\(/.test(script), 'renderOrders 必须已声明');
  assert.ok(script.includes('renderPositions();renderOrders();'), 'refresh 中必须调用 renderOrders');
  // 数据必须来自快照，前端不得直接打 Binance
  assert.ok(script.includes('runtimeOpenOrders=s.openOrders||[]'), '应从 /api/status 的快照读取');
});

test('V13.4.0：后端把当前委托快照放进 /api/status，且失败时不清空快照', () => {
  const app = fs.readFileSync(path.join(root, 'server/app.js'), 'utf8');
  assert.ok(app.includes('openOrders: runtime.openOrders || []'), '/api/status 必须暴露 openOrders');
  assert.ok(app.includes('openOrdersError: runtime.openOrdersError'), '/api/status 必须暴露快照错误');
  assert.ok(/async function refreshOpenOrders\s*\(/.test(app), '必须有 refreshOpenOrders');
  assert.ok(app.includes('await refreshOpenOrders()'), 'scheduledTasks 必须周期刷新');

  // 失败分支必须保留旧快照（只在成功分支赋值），否则会把"读取失败"显示成"没有委托"
  const fn = app.match(/async function refreshOpenOrders\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.ok(fn, '应能取出 refreshOpenOrders 函数体');
  const catchBlock = fn.slice(fn.indexOf('} catch (e) {'));
  assert.ok(!catchBlock.includes('runtime.openOrders ='), 'catch 分支不得清空 openOrders 快照');
  // Algo 未到刷新点时必须沿用上次快照，避免条件单从列表里闪没
  assert.ok(fn.includes('keptAlgo'), '应保留未刷新时的 Algo 委托');
});

test('V13.4.0：renderOrders 正确渲染委托行（功能性验证）', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
  const src = script.match(/function renderOrders\(\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(src, '应能取出 renderOrders 函数体');

  const els = { orders: { innerHTML: '' }, ordersNote: { textContent: '' } };
  const $ = (id) => els[id];
  const esc = (s) => String(s == null ? '' : s);
  const money = (v, n) => Number(v || 0).toFixed(n == null ? 2 : n);
  const fmtTime = () => '12:00:00';
  // 每次用一组快照构造一次函数：真实代码里 runtimeOpenOrders 是模块级变量、由 refresh() 重新赋值，
  // 函数参数绑定无法反映后续变更，所以按场景分别构造。
  const build = (orders, at, err) => new Function(
    '$', 'esc', 'money', 'fmtTime', 'runtimeOpenOrders', 'runtimeOpenOrdersAt', 'runtimeOpenOrdersError',
    `${src}\nreturn renderOrders;`
  )($, esc, money, fmtTime, orders, at, err);

  const two = [
    { kind: 'ORDER', symbol: 'BTCUSDT', positionSide: 'LONG', side: 'BUY', type: 'LIMIT', price: 50000, origQty: 2, executedQty: 0, status: 'NEW', source: 'RULE', updateTime: 1 },
    { kind: 'ALGO', symbol: 'ETHUSDT', positionSide: 'SHORT', side: 'SELL', type: 'STOP_MARKET', price: 3000, origQty: 1, executedQty: 0, status: 'WORKING', source: 'PROTECT', reduceOnly: true, updateTime: 2 }
  ];
  build(two, 1, null)();
  assert.ok(els.orders.innerHTML.includes('BTCUSDT'), '应渲染规则 LIMIT 委托');
  assert.ok(els.orders.innerHTML.includes('ETHUSDT'), '应渲染保护 Algo 委托');
  assert.ok(els.orders.innerHTML.includes('规则') && els.orders.innerHTML.includes('保护'), '应显示来源标签');
  assert.ok(els.orders.innerHTML.includes('只减仓'), 'Algo 只减仓标记应显示');
  assert.ok(els.ordersNote.textContent.includes('共 2 笔'), '备注应显示委托笔数');

  // 空快照 → 显示"当前无委托"，不抛错
  build([], 1, null)();
  assert.ok(els.orders.innerHTML.includes('当前无委托'));
  assert.ok(els.ordersNote.textContent.includes('共 0 笔'));

  // 快照异常 → 备注显示异常而不是假装没有委托
  build([], 1, { message: '限流' })();
  assert.ok(els.ordersNote.textContent.includes('快照异常'), '读取失败必须显性提示');
});

test('V13.4.0：前端已声明 renderRuleFunnel，且漏斗格子数量与后端阶段数一致', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
  const funcs = new Set([...script.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
  assert.ok(funcs.has('renderRuleFunnel'), 'renderRuleFunnel 必须已声明');

  // 前端不能残留旧的二值 stage() 判定 bug
  assert.ok(!script.includes("startsWith('ENTRY_')"), '旧的 ENTRY_ 前缀判定必须已移除');

  // 漏斗容器应有 11 格（候选池 + 10 个后端阶段）
  const flow = html.match(/<div class="rule-flow">([\s\S]*?)<\/div>\s*<div class="rule-funnel-note"/)?.[1] || '';
  const steps = [...flow.matchAll(/class="flow-step/g)].length;
  assert.equal(steps, 11, `漏斗应为 11 格，实际 ${steps}`);
  // 11 格必须有唯一 id，且与后端阶段 key 一一对应
  for (const id of ['flowRank', 'flowFunding', 'flowTrend', 'flowRsiDepth', 'flowRsiRecovery', 'flowRsiSlope', 'flowRsiDivergence', 'flowVol', 'flowEntry', 'flowRisk', 'flowPlace']) {
    assert.ok(flow.includes(`id="${id}"`), `缺少漏斗格子 ${id}`);
  }
});

test('V13.4.0：资金费率过滤只拦"自己付费"的方向', () => {
  const t = makeTrader();
  const ctx = (rates) => ({ fundingRates: new Map(rates), maxFundingPct: 0.07 });

  // 做多 + 高正费率 → 拦（多头要付费率）
  assert.equal(t.shouldBlockForFunding('LONG', 0.08, 0.07), true);
  // 做多 + 负费率 → 不拦（负费率对多头是收益）
  assert.equal(t.shouldBlockForFunding('LONG', -0.5, 0.07), false);
  // 做空 + 负费率 → 拦（空头要付费率）
  assert.equal(t.shouldBlockForFunding('SHORT', -0.08, 0.07), true);
  // 做空 + 正费率 → 不拦（正费率对空头是收益）
  assert.equal(t.shouldBlockForFunding('SHORT', 0.5, 0.07), false);
  // 边界：恰好等于阈值不拦
  assert.equal(t.shouldBlockForFunding('LONG', 0.07, 0.07), false);
  // 阈值 0 = 关闭过滤
  assert.equal(t.shouldBlockForFunding('LONG', 5, 0), false);
  // 费率缺失/非法不拦
  assert.equal(t.shouldBlockForFunding('LONG', NaN, 0.07), false);
});

test('V13.4.0：费率拦截计入 FUNDING 阶段，漏斗仍单调', () => {
  const t = makeTrader();
  const f = t.buildFunnel({
    decisions: [
      { stage: 'FUNDING', action: 'LONG', status: 'SKIP', reason: 'FUNDING_RATE_TOO_HIGH' },
      { stage: 'FUNDING', action: 'SHORT', status: 'SKIP', reason: 'FUNDING_RATE_TOO_HIGH' },
      { stage: 'TREND', action: 'LONG', status: 'SKIP' },
      { stage: 'PASS', action: 'LONG', status: 'READY' }
    ],
    candidates: 4, ordersPlaced: 1, indicatorPass: 1
  });
  const byKey = Object.fromEntries(f.stages.map(s => [s.key, s]));
  assert.equal(byKey.FUNDING.entered, 4);
  assert.equal(byKey.FUNDING.passed, 2, '2 个被费率拦下');
  assert.equal(byKey.FUNDING.blocked, 2);
  assert.equal(byKey.TREND.entered, 2);
  assert.equal(byKey.TREND.passed, 1);
  assertFunnelShape(f);
});
