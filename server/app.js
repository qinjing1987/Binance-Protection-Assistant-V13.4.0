// 后端应用入口：只监听 127.0.0.1，前端通过本机 HTTP 与后端通信。
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { positionKey, normalizeSymbol } = require('./utils/symbol');
const Logger = require('./Logger');
const StateStore = require('./persistence/StateStore');
const BinanceClient = require('./binance/BinanceClient');
const UserDataStream = require('./binance/UserDataStream');
const MarkPriceStream = require('./binance/MarkPriceStream');
const PositionMonitor = require('./protection/PositionMonitor');
const ProtectionManager = require('./protection/ProtectionManager');
const EmergencyManager = require('./EmergencyManager');
const RiskManager = require('./risk/RiskManager');
const RankingService = require('./ai/RankingService');
const AIService = require('./ai/AIService');
const AITrader = require('./ai/AITrader');
const Reconciliation = require('./recovery/Reconciliation');
const FundingMonitor = require('./monitoring/FundingMonitor');
const LiquidationMonitor = require('./monitoring/LiquidationMonitor');
const { SuperTrendScanner } = require('./monitoring/SuperTrendScanner');
const { RuleAutoTrader } = require('./monitoring/RuleAutoTrader');
const RuntimeState = require('./core/RuntimeState');

function validateSettingsPatch(patch) {
  if (patch.protection) {
    const p = patch.protection;
    if (p.calculationMode != null && !['MARGIN','PRICE'].includes(String(p.calculationMode).toUpperCase())) throw new Error('保护计算模式必须为 MARGIN 或 PRICE');
    if (p.stopLossPct != null && !(Number(p.stopLossPct) >= 0.1 && Number(p.stopLossPct) <= 20)) throw new Error('价格止损必须在 0.1%～20%');
    if (p.takeProfitPct != null && !(Number(p.takeProfitPct) >= 0.1 && Number(p.takeProfitPct) <= 50)) throw new Error('价格止盈必须在 0.1%～50%');
    if (p.stopLossMarginPct != null && !(Number(p.stopLossMarginPct) >= 1 && Number(p.stopLossMarginPct) <= 100)) throw new Error('保证金止损必须在 1%～100%');
    if (p.takeProfitMarginPct != null && !(Number(p.takeProfitMarginPct) >= 1 && Number(p.takeProfitMarginPct) <= 200)) throw new Error('保证金止盈必须在 1%～200%');
    if (p.liquidationBufferPp != null && !(Number(p.liquidationBufferPp) >= 0 && Number(p.liquidationBufferPp) <= 3)) throw new Error('强平安全缓冲必须在 0～3 个百分点');
    if (p.trailingCallbackPct != null && !(Number(p.trailingCallbackPct) >= 0.1 && Number(p.trailingCallbackPct) <= 10)) throw new Error('Trailing回调必须在 0.1%～10%');
    if (p.trailingActivationPct != null && !(Number(p.trailingActivationPct) >= 0.1 && Number(p.trailingActivationPct) <= 20)) throw new Error('Trailing激活必须在 0.1%～20%');
    if (p.priceProtect != null && typeof p.priceProtect !== 'boolean') throw new Error('priceProtect 必须是 true 或 false');
    if (p.fastFixedProtection != null && typeof p.fastFixedProtection !== 'boolean') throw new Error('fastFixedProtection 必须是 true 或 false');
    if (p.closeOnImmediateTarget != null && typeof p.closeOnImmediateTarget !== 'boolean') throw new Error('closeOnImmediateTarget 必须是 true 或 false');
    if (p.trailingEnabled != null && typeof p.trailingEnabled !== 'boolean') throw new Error('trailingEnabled 必须是 true 或 false');
  }
  if (patch.ruleTrading) {
    const r = patch.ruleTrading;
    if (r.enabled != null && typeof r.enabled !== 'boolean') throw new Error('规则自动交易 enabled 必须是 true 或 false');
    if (r.leverage != null && !(Number(r.leverage) >= 1 && Number(r.leverage) <= 125)) throw new Error('规则自动交易杠杆范围无效');
    if (r.riskPerTradePct != null && !(Number(r.riskPerTradePct) > 0 && Number(r.riskPerTradePct) <= 10)) throw new Error('规则自动交易单笔风险必须大于0且不超过10%');
    if (r.maxFundingRatePct != null && !(Number(r.maxFundingRatePct) >= 0 && Number(r.maxFundingRatePct) <= 1)) throw new Error('规则自动交易资金费率上限必须在0～1%（0 表示关闭过滤）');
    if (r.maxPositions != null && !(Number(r.maxPositions) >= 1 && Number(r.maxPositions) <= 5)) throw new Error('规则自动交易最大持仓必须在1～5');
    if (r.maxPendingOrders != null && !(Number(r.maxPendingOrders) >= 1 && Number(r.maxPendingOrders) <= 10)) throw new Error('规则自动交易最大挂单必须在1～10');
    if (r.orderTtlMinutes != null && !(Number(r.orderTtlMinutes) >= 1 && Number(r.orderTtlMinutes) <= 30)) throw new Error('规则自动交易挂单有效期必须在1～30分钟');
    if (r.cooldownMinutes != null && !(Number(r.cooldownMinutes) >= 5 && Number(r.cooldownMinutes) <= 240)) throw new Error('规则自动交易冷却必须在5～240分钟');
    if (r.rsiPeriod != null && !(Number(r.rsiPeriod) >= 7 && Number(r.rsiPeriod) <= 30)) throw new Error('RSI周期必须在7～30');
    if (r.rsiLongTrigger != null && !(Number(r.rsiLongTrigger) >= 30 && Number(r.rsiLongTrigger) < 50)) throw new Error('RSI做多触发必须在30～49');
    if (r.rsiShortTrigger != null && !(Number(r.rsiShortTrigger) > 50 && Number(r.rsiShortTrigger) <= 70)) throw new Error('RSI做空触发必须在51～70');
    if (r.rsiLookbackBars != null && !(Number(r.rsiLookbackBars) >= 1 && Number(r.rsiLookbackBars) <= 3)) throw new Error('RSI触发回看必须在1～3根K线');
    if (r.rsiLongDepth != null && !(Number(r.rsiLongDepth) >= 20 && Number(r.rsiLongDepth) < Number(r.rsiLongTrigger ?? 40))) throw new Error('RSI做多回撤深度必须低于做多触发阈值，范围20～49');
    if (r.rsiShortDepth != null && !(Number(r.rsiShortDepth) > Number(r.rsiShortTrigger ?? 60) && Number(r.rsiShortDepth) <= 80)) throw new Error('RSI做空回撤深度必须高于做空触发阈值，范围51～80');
    if (r.rsiDepthLookbackBars != null && !(Number(r.rsiDepthLookbackBars) >= 3 && Number(r.rsiDepthLookbackBars) <= 12)) throw new Error('RSI深度回看必须在3～12根K线');
    if (r.volumePeriod != null && !(Number(r.volumePeriod) >= 10 && Number(r.volumePeriod) <= 50)) throw new Error('成交量均值周期必须在10～50');
    if (r.volumeMinRatio != null && !(Number(r.volumeMinRatio) >= 0.5 && Number(r.volumeMinRatio) <= 2)) throw new Error('最低成交量倍数必须在0.5～2');
    if (r.volumeStrongRatio != null && !(Number(r.volumeStrongRatio) >= Number(r.volumeMinRatio ?? 0))) throw new Error('强成交量倍数不能低于最低成交量倍数');
    if (r.entryLookbackBars != null && !(Number(r.entryLookbackBars) >= 2 && Number(r.entryLookbackBars) <= 5)) throw new Error('入场结构回看必须在2～5根K线');
    if (r.entryOffsetAtr != null && !(Number(r.entryOffsetAtr) >= 0 && Number(r.entryOffsetAtr) <= 0.8)) throw new Error('结构入场偏移必须在0～0.8 ATR');
    if (r.bbPeriod != null && !(Number(r.bbPeriod) >= 10 && Number(r.bbPeriod) <= 50)) throw new Error('布林带周期必须在10～50');
    if (r.bbStdDev != null && !(Number(r.bbStdDev) >= 1 && Number(r.bbStdDev) <= 3)) throw new Error('布林带标准差必须在1～3');
    if (r.macdFast != null && !(Number(r.macdFast) >= 5 && Number(r.macdFast) <= 20)) throw new Error('MACD Fast必须在5～20');
    if (r.macdSlow != null && !(Number(r.macdSlow) >= 20 && Number(r.macdSlow) <= 50)) throw new Error('MACD Slow必须在20～50');
    if (r.macdSignal != null && !(Number(r.macdSignal) >= 3 && Number(r.macdSignal) <= 15)) throw new Error('MACD Signal必须在3～15');
    if (r.maxEntryDistanceAtr != null && !(Number(r.maxEntryDistanceAtr) >= 0.2 && Number(r.maxEntryDistanceAtr) <= 2)) throw new Error('入场最大距离必须在0.2～2 ATR');
    if (r.require5mTrendMatch != null && typeof r.require5mTrendMatch !== 'boolean') throw new Error('5m主趋势过滤必须是 true 或 false');
    if (r.stFlipCooldownBars != null && !(Number(r.stFlipCooldownBars) >= 0 && Number(r.stFlipCooldownBars) <= 5)) throw new Error('SuperTrend翻转等待必须在0～5根5m K线');
    if (r.bbTouchLookbackBars != null && !(Number(r.bbTouchLookbackBars) >= 2 && Number(r.bbTouchLookbackBars) <= 8)) throw new Error('布林回踩确认K线必须在2～8根');
    if (r.bbEntryOffsetPct != null && !(Number(r.bbEntryOffsetPct) >= 0 && Number(r.bbEntryOffsetPct) <= 40)) throw new Error('布林入场偏移必须在0～40%');
    if (r.macdConfirmBars != null && !(Number(r.macdConfirmBars) >= 2 && Number(r.macdConfirmBars) <= 3)) throw new Error('MACD确认必须为2～3根K线');
    if (r.minRuleSLPct != null && !(Number(r.minRuleSLPct) >= 0.2 && Number(r.minRuleSLPct) <= 2)) throw new Error('规则最小结构止损必须在0.2%～2%');
    if (r.maxRuleSLPct != null && !(Number(r.maxRuleSLPct) >= 0.5 && Number(r.maxRuleSLPct) <= 5)) throw new Error('规则最大结构止损必须在0.5%～5%');
    if (r.minRuleSLPct != null && r.maxRuleSLPct != null && Number(r.maxRuleSLPct) < Number(r.minRuleSLPct)) throw new Error('规则最大结构止损不能小于最小结构止损');
    if (r.ruleTakeProfitRR != null && !(Number(r.ruleTakeProfitRR) >= 1.2 && Number(r.ruleTakeProfitRR) <= 4)) throw new Error('规则止盈RR必须在1.2～4R');
    if (r.exitRsiLong != null && !(Number(r.exitRsiLong) >= 50 && Number(r.exitRsiLong) <= 80)) throw new Error('多头RSI退出阈值必须在50～80');
    if (r.exitRsiShort != null && !(Number(r.exitRsiShort) >= 20 && Number(r.exitRsiShort) <= 50)) throw new Error('空头RSI退出阈值必须在20～50');
    if (r.exitOnIndicatorReverse != null && typeof r.exitOnIndicatorReverse !== 'boolean') throw new Error('指标平仓必须是 true 或 false');
    if (r.divergenceEnabled != null && typeof r.divergenceEnabled !== 'boolean') throw new Error('背离检测开关必须是 true 或 false');
    if (r.require1mTrendMatch != null && typeof r.require1mTrendMatch !== 'boolean') throw new Error('1m趋势确认必须是 true 或 false');
    if (r.divergenceLookbackBars != null && !(Number(r.divergenceLookbackBars) >= 20 && Number(r.divergenceLookbackBars) <= 200)) throw new Error('背离回看K线必须在20～200');
    if (r.divergencePivotSpan != null && !(Number(r.divergencePivotSpan) >= 1 && Number(r.divergencePivotSpan) <= 5)) throw new Error('背离pivot跨度必须在1～5');
    if (r.divergenceMinRsiDelta != null && !(Number(r.divergenceMinRsiDelta) >= 0 && Number(r.divergenceMinRsiDelta) <= 20)) throw new Error('背离RSI最小差值必须在0～20');
    if (r.divergenceMinBarsBetween != null && !(Number(r.divergenceMinBarsBetween) >= 2 && Number(r.divergenceMinBarsBetween) <= 30)) throw new Error('背离两个pivot最小间隔必须在2～30');
    if (r.divergenceMaxAgeBars != null && !(Number(r.divergenceMaxAgeBars) >= 1 && Number(r.divergenceMaxAgeBars) <= 60)) throw new Error('背离最大陈旧根数必须在1～60');
  }
  if (patch.risk) {
    const r = patch.risk;
    if (r.riskPerTradePct != null && !(Number(r.riskPerTradePct) > 0 && Number(r.riskPerTradePct) <= 10)) throw new Error('单笔风险必须大于0且不超过10%');
    if (r.defaultLeverage != null && !(Number(r.defaultLeverage) >= 1 && Number(r.defaultLeverage) <= 125)) throw new Error('杠杆范围无效');
    if (r.maxAIPositions != null && !(Number(r.maxAIPositions) >= 1 && Number(r.maxAIPositions) <= 3)) throw new Error('AI最大持仓目前限制为1～3');
    if (r.maxAITotalRiskPct != null && !(Number(r.maxAITotalRiskPct) >= Number(r.riskPerTradePct ?? 0))) throw new Error('AI总风险不能小于单笔风险');
    if (r.dailyLossLimitPct != null && !(Number(r.dailyLossLimitPct) >= 0 && Number(r.dailyLossLimitPct) <= 20)) throw new Error('日亏损上限必须在0～20%，0表示关闭');
  }
}

function errorSummary(e) {
  const detail = Logger.errorDetails(e, { includeStack: false });
  return detail ? `${detail.message}${detail.code != null ? ` [code=${detail.code}]` : ''}${detail.status != null ? ` [HTTP=${detail.status}]` : ''}${detail.protectionStage ? ` [stage=${detail.protectionStage}]` : ''}` : String(e?.message || e);
}

async function createApplicationServer({ userDataDir, credentials, configStore }) {
  // 所有业务模块统一使用这个默认 Logger 实例；兼容 Logger.info()/warn()/error() 的旧调用方式。
  Logger.configure(userDataDir);
  const app = express();
  const localSessionToken = crypto.randomBytes(24).toString('hex');
  const state = new StateStore(userDataDir);
  const runtime = new RuntimeState();
  runtime.lastSyncAt = 0;
  runtime.markWsConnected = false;
  runtime.markWsLastEventAt = 0;
  // 当前委托快照：由 scheduledTasks 周期性刷新，前端只读快照，不直接打 Binance。
  runtime.openOrders = [];
  runtime.openOrdersAt = 0;
  runtime.openOrdersError = null;
  const config = configStore;
  const binance = new BinanceClient({ credentialStore: credentials, config });
  const userStream = new UserDataStream(binance);
  const markStream = new MarkPriceStream({ config });
  const emergency = new EmergencyManager(binance);
  const protection = new ProtectionManager({ binance, state, config, emergency, userStream });
  const risk = new RiskManager({ binance, state, config });
  const monitor = new PositionMonitor({ binance, userStream });
  const ranking = new RankingService({ binance, config });
  const ai = new AIService({ credentials, config });
  const aiTrader = new AITrader({ binance, ai, risk, protection, state, config });
  const reconcile = new Reconciliation({ binance, protection, state });
  const funding = new FundingMonitor({ binance });
  const liquidation = new LiquidationMonitor();
  const supertrend = new SuperTrendScanner({ binance, ranking });
  const ruleTrader = new RuleAutoTrader({ binance, ranking, risk, config, state, emergency });
  runtime.supertrend = supertrend.getStatus();
  runtime.ruleTrading = ruleTrader.getStatus();

  runtime.binance = binance; runtime.ai = ai;
  let server;
  let started = false;
  let aiLoopTimer = null;
  let lastEquityAt = 0;
  const algoReviewTimers = new Map();

  app.use(express.json({ limit: '1mb' }));

  // 本机 API 增加 HttpOnly + SameSite 会话 Cookie，降低本地跨站页面直接调用交易操作接口的风险。
  app.use((req, res, next) => {
    if (!req.headers.cookie || !req.headers.cookie.includes(`QP_SESSION=${localSessionToken}`)) {
      res.setHeader('Set-Cookie', `QP_SESSION=${localSessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    }
    next();
  });
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const cookie = String(req.headers.cookie || '');
    if (!cookie.includes(`QP_SESSION=${localSessionToken}`)) return res.status(403).json({ error: '本地会话无效，请刷新软件窗口' });
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'frontend')));

  function decorateLiveMark(p, markPrice, meta = {}) {
    const mark = Number(markPrice);
    const next = { ...p, markPrice: mark };
    const qty = Math.abs(Number(next.contracts || 0));
    const entry = Number(next.entryPrice || 0);
    if (mark > 0 && qty > 0 && entry > 0) {
      const side = String(next.side || '').toLowerCase();
      const livePnl = side === 'long' ? (mark - entry) * qty : (entry - mark) * qty;
      next.unrealizedPnl = Number(livePnl.toFixed(8));
      next.notional = Number((mark * qty).toFixed(8));
      next.unrealizedPnlSource = 'MARK_PRICE_WS_DERIVED';
    }
    next.markPriceSource = 'MARK_PRICE_WS';
    next.markPriceEventTime = Number(meta.eventTime || 0);
    next.markPriceReceivedAt = Number(meta.receivedAt || Date.now());
    next.markPriceLatencyMs = Number.isFinite(Number(meta.wsLatencyMs)) ? Number(meta.wsLatencyMs) : null;
    next.markPriceSnapshotAt = next.markPriceReceivedAt;
    return decoratePosition(next);
  }

  function upsertRuntimePosition(p) {
    const k = positionKey(p.symbol, p.positionSide);
    const existing = (runtime.positions || []).find(x => positionKey(x.symbol, x.positionSide) === k);
    const latestMark = Number(protection.latestMarkPrices?.get(k) || existing?.markPrice || p.markPrice || 0);
    const markMeta = protection.latestMarkMeta?.get(k) || {};
    const markFresh = latestMark > 0 && Number(markMeta.receivedAt || 0) > 0 && Date.now() - Number(markMeta.receivedAt) <= 5000;
    const merged = markFresh ? decorateLiveMark(p, latestMark, markMeta) : { ...p };
    const next = decoratePosition({ ...merged, positionSource: state.getPositionSource(merged), protectionStatus: state.getProtectionState(merged) });
    const index = (runtime.positions || []).findIndex(x => positionKey(x.symbol, x.positionSide) === k);
    if (index >= 0) runtime.positions[index] = next;
    else runtime.positions = [...(runtime.positions || []), next];
    markStream.setSymbols((runtime.positions || []).map(x => x.symbol));
    updateRuntimeHealth();
    return next;
  }

  async function handlePositionEvent(change) {
    try {
      const p = change.position;
      if (change.type === 'CLOSED') {
        await protection.cleanup(change.old);
        if (typeof state.deletePosition === 'function') state.deletePosition(change.old);
        runtime.positions = (runtime.positions || []).filter(x => positionKey(x.symbol, x.positionSide) !== positionKey(change.old.symbol, change.old.positionSide));
        markStream.setSymbols((runtime.positions || []).map(x => x.symbol));
        updateRuntimeHealth();
        return;
      }
      if (!p) return;
      if (!state.rawGet('positions', {})[positionKey(p.symbol, p.positionSide)]) {
        state.setPositionSource(p, ruleTrader.shouldTagPosition(p) ? 'RULE' : 'MANUAL');
      }

      // 新仓位必须先进入 runtime + Mark Price 订阅，再等待保护队列；
      // 否则在 SL/TP 受 Binance Algo 限频等待时，本地 1s Mark Price 兜底根本收不到该 symbol。
      upsertRuntimePosition({ ...p, protectionStatus: 'PROTECTING' });

      let protectionResult = null;
      if (config.get().autoProtection) protectionResult = await protection.reconcile(p, { forceConfig: String(change.reason || '').includes('ACCOUNT_CONFIG_UPDATE'), reason: change.reason || change.type || 'POSITION_EVENT' });
      upsertRuntimePosition(p);
      return protectionResult;
    } catch (e) {
      if (e?.code === 'POSITION_CLOSED_WHILE_QUEUED' || e?.code === 'QUEUE_JOB_CANCELLED') {
        Logger.info('仓位已关闭，排队保护任务取消', { symbol: change.position?.symbol || change.old?.symbol || null, positionSide: change.position?.positionSide || change.old?.positionSide || null, code: e.code, message: e.message });
        return;
      }
      runtime.lastError = errorSummary(e);
      if (change.position) {
        const p = change.position;
        const k = positionKey(p.symbol, p.positionSide);
        const index = (runtime.positions || []).findIndex(x => positionKey(x.symbol, x.positionSide) === k);
        const next = decoratePosition({ ...p, positionSource: state.getPositionSource(p), protectionStatus: state.getProtectionState(p) });
        if (index >= 0) runtime.positions[index] = next; else runtime.positions = [...(runtime.positions || []), next];
        updateRuntimeHealth();
      }
      if (!e.protectionLogged) Logger.error('仓位事件处理失败', { error: e, code: e.code || null, status: e.status || null, protectionStage: e.protectionStage || null, traceId: e.traceId || null, eventReason: change.reason || change.type || null });
    }
  }

  function updateRuntimeHealth() {
    const positions = runtime.positions || [];
    const protectionIssue = positions.some(p => ['ERROR','PARTIAL','UNKNOWN','UNPROTECTED'].includes(p.protectionStatus));
    const transportIssue = started && !runtime.wsConnected;
    const markIssue = started && positions.length > 0 && (!runtime.markWsConnected || (runtime.markWsLastEventAt > 0 && Date.now() - runtime.markWsLastEventAt > 5000));
    if (started) { runtime.status = (protectionIssue || transportIssue || markIssue) ? 'DEGRADED' : 'READY'; if (!protectionIssue && !transportIssue && !markIssue) runtime.lastError = null; }
  }

  function decoratePosition(p) {
    const meta = state.getProtectionMeta?.(p) || {};
    const leverage = Number(p.leverage || meta.lastLeverage || 0);
    const entryPrice = Number(p.entryPrice || p.avgEntryPrice || 0);
    const markPrice = Number(p.markPrice || 0);
    const qty = Math.abs(Number(p.contracts || 0));
    const side = String(p.side || (String(p.positionSide || '').toUpperCase() === 'SHORT' ? 'short' : 'long')).toLowerCase();
    // 对 USDⓈ-M 线性合约，实时 Mark PnL = 价格差 × 合约数量。优先用这一口径计算 ROI，
    // 避免 Binance REST 旧快照与当前 Mark Price 混用导致“实际盈亏/收益率”互相矛盾。
    const markDerivedPnl = entryPrice > 0 && markPrice > 0 && qty > 0
      ? (side === 'short' ? (entryPrice - markPrice) : (markPrice - entryPrice)) * qty
      : null;
    const effectivePnl = markDerivedPnl != null && Number.isFinite(markDerivedPnl)
      ? markDerivedPnl
      : Number(p.unrealizedPnl || 0);
    const notional = Math.abs(Number(p.notional || 0)) > 0
      ? Math.abs(Number(p.notional || 0))
      : (markPrice > 0 && qty > 0 ? markPrice * qty : 0);
    const marginBasis = Number(p.isolatedMargin || 0) > 0
      ? Number(p.isolatedMargin)
      : (leverage > 0 && notional > 0 ? notional / leverage : 0);
    const positionReturnPct = marginBasis > 0 ? Number((effectivePnl / marginBasis * 100).toFixed(2)) : null;
    const priceMovePct = entryPrice > 0 && markPrice > 0
      ? Number((((markPrice - entryPrice) / entryPrice * 100) * (side === 'short' ? -1 : 1)).toFixed(3))
      : null;
    return {
      ...p,
      unrealizedPnl: Number(effectivePnl.toFixed(8)),
      unrealizedPnlSource: markDerivedPnl != null ? 'MARK_PRICE_DERIVED' : (p.unrealizedPnlSource || 'BINANCE_POSITION_REST'),
      leverage: leverage || 0,
      positionReturnPct,
      positionReturnPctSource: 'UNREALIZED_PNL_DIV_MARGIN',
      priceMovePct,
      protectionSL: meta.activeSL ?? meta.targetSL ?? null,
      protectionTP: meta.activeTP ?? meta.targetTP ?? null,
      protectionVerifiedAt: meta.verifiedAt || null,
      protectionLastError: meta.lastError || null
    };
  }

  monitor.on('snapshot', positions => {
    runtime.lastSyncAt = Date.now();
    runtime.positions = positions.map(p => {
      const k = positionKey(p.symbol, p.positionSide);
      const markMeta = protection.latestMarkMeta?.get(k) || {};
      const wsMark = Number(markMeta.markPrice || protection.latestMarkPrices?.get(k) || 0);
      const merged = wsMark > 0 && Date.now() - Number(markMeta.receivedAt || 0) <= 5000 ? decorateLiveMark(p, wsMark, markMeta) : p;
      return decoratePosition({ ...merged, positionSource: state.getPositionSource(merged), protectionStatus: state.getProtectionState(merged) });
    });
    updateRuntimeHealth();
  });
  monitor.on('transport', s => {
    runtime.wsConnected = !!s.wsConnected;
    runtime.wsEndpoint = s.endpoint || null;
    updateRuntimeHealth();
  });
  monitor.on('userEvent', e => {
    risk.recordTradeEvent(e);
    ruleTrader.handleUserEvent(e);
    if (e.e === 'ALGO_UPDATE') protection.handleAlgoUpdate(e);
    if (e.e === 'ACCOUNT_CONFIG_UPDATE') Logger.info('Binance 杠杆配置发生变化，已触发仓位风险重新对账', { symbol: e.ac?.s, leverage: e.ac?.l, eventTime: e.E || null });
    if (e.e === 'ORDER_TRADE_UPDATE') {
      const o = e.o || {};
      if (String(o.X || '').toUpperCase() === 'FILLED' || String(o.x || '').toUpperCase() === 'TRADE') {
        Logger.info('Binance 订单成交/执行状态变化', { symbol: o.s, positionSide: o.ps, side: o.S, type: o.o, executionType: o.x, orderStatus: o.X, orderId: o.i || null, algoId: o.algoId || o.aid || o.id || null, realizedPnl: o.rp ?? null, commission: o.n ?? null, eventTime: e.E || null, transactionTime: e.T || o.T || null });
      }
    }
    if (e.e === 'MARGIN_CALL') Logger.warn('Binance 推送强平风险提醒', { positions: e.p?.length || 0 });
  });
  markStream.on('status', s => {
    runtime.markWsConnected = !!s.connected;
    runtime.markWsEndpoint = s.endpoint || null;
    Logger.info('Mark Price 1s WS 状态变化', { connected: !!s.connected, endpoint: s.endpoint || null, streams: s.streams || 0, reason: s.reason || null });
  });
  markStream.on('markPrice', ({ symbol, markPrice, eventTime, transactionTime, receivedAt }) => {
    const receiveServerNow = Date.now() + Number(binance.timeOffset || 0);
    const wsLatencyMs = Math.max(0, receiveServerNow - Number(eventTime || receiveServerNow));
    const affected = (runtime.positions || []).filter(p => normalizeSymbol(p.symbol) === normalizeSymbol(symbol));
    for (const p of affected) {
      const live = decorateLiveMark(p, Number(markPrice), { eventTime, transactionTime, receivedAt, wsLatencyMs });
      Object.assign(p, live);
      runtime.markWsLastEventAt = receivedAt || Date.now();
      try {
        protection.handleMarkPrice({ ...p }, Number(markPrice), {
          eventTime: Number(eventTime || 0), transactionTime: Number(transactionTime || 0), receivedAt: receivedAt || Date.now(), wsLatencyMs
        }).catch(error => {
          if (!error?.protectionLogged) Logger.error('Mark Price 保护兜底处理失败', { symbol: p.symbol, positionSide: p.positionSide, error, code: error.code || null, status: error.status || null });
        });
      } catch (error) {
        Logger.error('Mark Price 保护兜底调用异常', { symbol: p.symbol, positionSide: p.positionSide, error });
      }
    }
  });
  monitor.on('snapshot', positions => {
    const symbols = positions.map(p => p.symbol);
    markStream.setSymbols(symbols);
  });
  markStream.setSymbols((runtime.positions || []).map(p => p.symbol));
  markStream.start().catch(error => Logger.error('Mark Price 1s WS 启动失败', { error }));

  monitor.on('positionChanged', handlePositionEvent);
  monitor.on('protectionChanged', e => {
    if (!config.get().autoProtection) return;
    const symbol = e.o?.s || e.ao?.s || e.s || e.symbol;
    const positionSide = e.o?.ps || e.ao?.ps || e.ps || e.positionSide;
    const candidates = (runtime.positions || []).filter(p =>
      String(p.symbol || '').toUpperCase() === String(symbol || '').toUpperCase()
      && (!positionSide || String(p.positionSide || '').toUpperCase() === String(positionSide).toUpperCase())
      && protection.shouldReviewAlgoUpdate(e, p)
    );
    for (const p of candidates) {
      const key = positionKey(p.symbol, p.positionSide);
      clearTimeout(algoReviewTimers.get(key));
      const timerId = setTimeout(async () => {
        algoReviewTimers.delete(key);
        const latest = (runtime.positions || []).find(x => positionKey(x.symbol, x.positionSide) === key);
        if (!latest || !config.get().autoProtection) return;
        try {
          await protection.reconcile(latest, { forceConfig: false, reason: 'ALGO_UPDATE' });
          const index = (runtime.positions || []).findIndex(x => positionKey(x.symbol, x.positionSide) === key);
          const next = decoratePosition({ ...latest, positionSource: state.getPositionSource(latest), protectionStatus: state.getProtectionState(latest) });
          if (index >= 0) runtime.positions[index] = next;
          updateRuntimeHealth();
          Logger.info('ALGO_UPDATE 触发保护复核完成', { symbol: latest.symbol, positionSide: latest.positionSide, status: protection.algoStatusOf(e) });
        } catch (err) {
          runtime.lastError = errorSummary(err);
          if (!err.protectionLogged) Logger.error('ALGO_UPDATE 触发保护复核失败', { symbol: latest.symbol, positionSide: latest.positionSide, error: err, code: err.code || null, status: err.status || null, protectionStage: err.protectionStage || null, traceId: err.traceId || null });
        }
      }, 250);
      algoReviewTimers.set(key, timerId);
    }
  });

  async function startRuntime() {
    if (started) return;
    runtime.status = 'CONNECTING'; runtime.lastError = null;
    try {
      const c = credentials.get(); if (!c.binanceApiKey || !c.binanceApiSecret) { runtime.status = 'CONFIG_REQUIRED'; return; }
      await binance.init();
      Logger.info('运行环境初始化完成', { environment: config.get().binanceSandbox ? 'TESTNET' : 'MAINNET', baseUrl: binance.baseUrl(), hedgeMode: binance.actualHedgeMode, autoProtection: !!config.get().autoProtection, calculationMode: config.get().protection?.calculationMode, freeFirst: !!config.get().ai?.freeFirst });
      const account = await binance.getAccount();
      runtime.equity = Number(account.totalMarginBalance ?? account.totalWalletBalance ?? 0);
      runtime.availableBalance = Number(account.availableBalance || 0);
      runtime.lastAccountAt = Date.now();
      await risk.ensureDayStartEquity(runtime.equity);
      // 初始 REST 同步只建立 monitor 快照，不在此处触发保护；启动保护统一由 Reconciliation 串行负责。
      await monitor.start({ emitInitialPositionEvents: false });
      const reconciled = await reconcile.run();
      runtime.positions = reconciled.map(p => {
        const k = positionKey(p.symbol, p.positionSide);
        const wsMark = Number(protection.latestMarkPrices?.get(k) || 0);
        const merged = wsMark > 0 ? { ...p, markPrice: wsMark, markPriceSource: 'MARK_PRICE_WS' } : p;
        return decoratePosition({ ...merged, positionSource: state.getPositionSource(merged), protectionStatus: state.getProtectionState(merged) });
      });
      markStream.setSymbols((runtime.positions || []).map(p => p.symbol));
      started = true;
      updateRuntimeHealth();
      runtime.ruleTrading = ruleTrader.getStatus();
      if (reconcile.lastSummary.protectionFailures > 0) runtime.status = 'DEGRADED';
      else if (runtime.status === 'CONNECTING') runtime.status = 'READY';
      Logger.info('系统启动完成', { version: runtime.version, positions: reconciled.length, protectionFailures: reconcile.lastSummary.protectionFailures, status: runtime.status });
    } catch (e) { runtime.status = 'ERROR'; runtime.lastError = errorSummary(e); Logger.error('系统启动失败', { error: e, code: e.code || null, status: e.status || null }); }
  }

  // 当前委托快照。普通挂单每 10 秒刷新；Algo（SL/TP/追踪）每 30 秒刷新一次 ——
  // 遵循原作者"不频繁轮询 Algo 接口"的限流考虑（/api/positions/diagnostics 也是按需读取）。
  // 失败时保留上一次快照并记录错误，绝不清空成"没有委托"，避免误导。
  let lastAlgoOrdersAt = 0;
  const ACTIVE_ORDER_STATUSES = new Set(['NEW', 'WORKING', 'PARTIALLY_FILLED']);
  const isActiveOrder = (o) => ACTIVE_ORDER_STATUSES.has(String(o?.algoStatus || o?.status || o?.strategyStatus || '').toUpperCase());
  const orderSource = (clientId) => {
    const id = String(clientId || '');
    if (/^QP_RULE_/i.test(id)) return 'RULE';
    if (/^QP_/i.test(id)) return 'PROTECT';
    return 'MANUAL';
  };
  function normalizeAlgoOrder(o) {
    const qty = Number(o.quantity ?? o.origQty ?? 0);
    const clientId = o.clientAlgoId ?? o.clientOrderId ?? o.newClientStrategyId ?? null;
    return {
      kind: 'ALGO',
      symbol: normalizeSymbol(o.symbol),
      positionSide: String(o.positionSide || 'BOTH').toUpperCase(),
      side: String(o.side || '').toUpperCase(),
      type: String(o.orderType || o.type || o.strategyType || 'ALGO').toUpperCase(),
      price: Number(o.triggerPrice ?? o.stopPrice ?? o.activatePrice ?? 0),
      origQty: qty,
      executedQty: 0,
      remainingQty: qty,
      status: String(o.algoStatus || o.status || '').toUpperCase(),
      clientId,
      source: orderSource(clientId),
      reduceOnly: o.reduceOnly === true || o.closePosition === true,
      updateTime: Number(o.bookTime ?? o.time ?? o.updateTime ?? 0)
    };
  }
  function normalizeNormalOrder(o) {
    const qty = Number(o.origQty || 0);
    const done = Number(o.executedQty || 0);
    return {
      kind: 'ORDER',
      symbol: normalizeSymbol(o.symbol),
      positionSide: String(o.positionSide || 'BOTH').toUpperCase(),
      side: String(o.side || '').toUpperCase(),
      type: String(o.type || 'LIMIT').toUpperCase(),
      price: Number(o.price || 0) || Number(o.stopPrice || 0),
      origQty: qty,
      executedQty: done,
      remainingQty: Math.max(0, qty - done),
      status: String(o.status || '').toUpperCase(),
      clientId: o.clientOrderId || null,
      source: orderSource(o.clientOrderId),
      reduceOnly: o.reduceOnly === true,
      updateTime: Number(o.updateTime || o.time || 0)
    };
  }
  async function refreshOpenOrders() {
    const now = Date.now();
    const wantAlgo = now - lastAlgoOrdersAt >= 29000;
    try {
      const [normal, algo] = await Promise.all([
        typeof binance.fetchOpenOrders === 'function' ? binance.fetchOpenOrders() : Promise.resolve([]),
        wantAlgo && typeof binance.fetchOpenAlgoOrders === 'function' ? binance.fetchOpenAlgoOrders() : Promise.resolve(null)
      ]);
      const merged = [
        ...(Array.isArray(algo) ? algo.filter(isActiveOrder).map(normalizeAlgoOrder) : []),
        ...(Array.isArray(normal) ? normal.filter(isActiveOrder).map(normalizeNormalOrder) : [])
      ];
      // Algo 未到刷新点时，沿用上一次快照里的 Algo 部分，避免它们从列表里闪没。
      const keptAlgo = Array.isArray(algo) ? [] : (runtime.openOrders || []).filter(o => o.kind === 'ALGO');
      runtime.openOrders = [...keptAlgo, ...merged];
      runtime.openOrdersAt = now;
      runtime.openOrdersError = null;
      if (Array.isArray(algo)) lastAlgoOrdersAt = now;
    } catch (e) {
      runtime.openOrdersError = errorSummary(e);
      Logger.error('开放委托同步失败', { error: e, code: e.code || null, status: e.status || null });
    }
  }

  async function scheduledTasks() {
    if (!started) return;
    try { runtime.positions = (await monitor.sync('TIMER')).map(p => {
      const k = positionKey(p.symbol, p.positionSide);
      const wsMark = Number(protection.latestMarkPrices?.get(k) || 0);
      const markMeta = protection.latestMarkMeta?.get(k) || {};
      const merged = wsMark > 0 && Date.now() - Number(markMeta.receivedAt || 0) <= 5000 ? decorateLiveMark(p, wsMark, markMeta) : p;
      return decoratePosition({ ...merged, positionSource: state.getPositionSource(merged), protectionStatus: state.getProtectionState(merged) });
    }); markStream.setSymbols((runtime.positions || []).map(p => p.symbol)); } catch (e) { runtime.lastError = errorSummary(e); Logger.error('定时仓位同步失败', { error: e, code: e.code || null, status: e.status || null }); }
    if (Date.now() - lastEquityAt > 15000) {
      try {
        const prevEquity = Number(runtime.equity || 0);
        const prevAvailableBalance = Number(runtime.availableBalance || 0);
        const account = await binance.getAccount();
        runtime.equity = Number(account.totalMarginBalance ?? account.totalWalletBalance ?? 0);
        runtime.availableBalance = Number(account.availableBalance || 0);
        runtime.lastAccountAt = Date.now();
        // 正常同步不刷屏；只有账户权益/可用余额真正变化才记录。
        if (Math.abs(runtime.equity - prevEquity) > 1e-8 || Math.abs(runtime.availableBalance - prevAvailableBalance) > 1e-8) {
          Logger.info('账户余额发生变化', {
            equityBefore: prevEquity, equityAfter: runtime.equity,
            availableBefore: prevAvailableBalance, availableAfter: runtime.availableBalance
          });
        }
        updateRuntimeHealth();
        lastEquityAt = Date.now();
      } catch (e) { runtime.lastError = errorSummary(e); Logger.error('定时账户权益同步失败', { error: e, code: e.code || null, status: e.status || null }); }
    }
    if (started && config.get().ruleTrading?.enabled === true && !ruleTrader.running) {
      ruleTrader.start();
      Logger.warn('规则自动交易调度自愈：检测到已启用但未运行，已自动重新启动');
    }
    runtime.ruleTrading = ruleTrader.getStatus();
    // 放在最后：委托快照不是关键路径，网络慢时不应拖住仓位同步/自愈看门狗。
    await refreshOpenOrders();
  }

  const timer = setInterval(() => scheduledTasks().catch(() => {}), 10000);
  // 规则交易独立自愈看门狗：避免账户同步/其他定时任务阻塞时，规则开关已开启却长期停摆。
  const ruleGuardTimer = setInterval(() => {
    try {
      if (started && config.get().ruleTrading?.enabled === true && !ruleTrader.running) {
        ruleTrader.start();
        runtime.ruleTrading = ruleTrader.getStatus();
        Logger.warn('规则自动交易独立自愈：检测到已启用但未运行，已重新启动');
      }
    } catch (e) {
      runtime.lastError = errorSummary(e);
      Logger.error('规则自动交易独立自愈失败', { error: e, code: e.code || null, status: e.status || null });
    }
  }, 5000);
  let supertrendTimer = null;
  const scheduleSupertrend = () => {
    clearTimeout(supertrendTimer);
    if (!started) return;
    // 每分钟对齐到下一根 1m K 线收盘后约 1 秒，避免在整分钟边界抢到尚未闭合的 K 线。
    const delay = (60 * 1000 - (Date.now() % (60 * 1000))) + 1000;
    supertrendTimer = setTimeout(async () => {
      if (!started) return;
      try {
        if (!supertrend.running) runtime.supertrend = await supertrend.scan();
      } catch (e) {
        runtime.supertrend = supertrend.getStatus();
        runtime.lastError = errorSummary(e);
        Logger.error('SuperTrend定时扫描失败', { error: e, code: e.code || null, status: e.status || null });
      } finally {
        scheduleSupertrend();
      }
    }, delay);
  };
  scheduleSupertrend();

  function scheduleAILoop() {
    clearTimeout(aiLoopTimer); if (!started) return;
    aiLoopTimer = setTimeout(async () => {
      try {
        const cfg = config.get();
        if (cfg.aiTrading && !state.rawGet('aiEmergencyStopped', false) && !state.rawGet('aiLoopBusy', false)) {
          state.rawSet('aiLoopBusy', true);
          const r = await ranking.getTop5();
          runtime.lastAI = await aiTrader.run(r, runtime.positions, true);
        }
      } catch (e) { runtime.lastError = errorSummary(e); Logger.error('AI自动巡检失败', { error: e }); }
      finally { state.rawSet('aiLoopBusy', false); scheduleAILoop(); }
    }, 5 * 60 * 1000);
  }

  app.get('/api/health', (req, res) => res.json({ ok: true, status: runtime.status, version: runtime.version }));
  app.get('/api/status', async (req, res) => {
    let daily = null; try { daily = await risk.daily(); } catch {}
    let liq = liquidation.snapshot(runtime.positions || []);
    res.json({
      status: runtime.status, wsConnected: runtime.wsConnected, wsEndpoint: runtime.wsEndpoint || null, markWsConnected: !!runtime.markWsConnected, markWsEndpoint: runtime.markWsEndpoint || null, markWsLastEventAt: runtime.markWsLastEventAt || 0, equity: runtime.equity || 0, availableBalance: runtime.availableBalance || 0,
      version: runtime.version, lastSyncAt: runtime.lastSyncAt,
      timeOffsetMs: Number(binance.timeOffset || 0), lastTimeSyncAt: Number(binance.lastTimeSyncAt || 0),
      hedgeMode: binance.actualHedgeMode, baseUrl: binance.baseUrl(),
      positions: (runtime.positions || []).map(decoratePosition),
      openOrders: runtime.openOrders || [],
      openOrdersAt: Number(runtime.openOrdersAt || 0),
      openOrdersError: runtime.openOrdersError || null,
      ranking: runtime.ranking || ranking.getCached(), supertrend: runtime.supertrend || supertrend.getStatus(), ruleTrading: ruleTrader.getStatus(), lastAI: runtime.lastAI,
      lastError: runtime.lastError, liquidation: liq, daily,
      config: config.get(), credentials: credentials.masked(), aiEmergencyStopped: !!state.rawGet('aiEmergencyStopped', false),
      dataDir: userDataDir
    });
  });

  // V11.2.0：只有用户主动查看诊断时才读取 Binance Algo Orders，避免定时轮询造成限流。
  app.get('/api/positions/diagnostics', async (req, res) => {
    try {
      const symbol = normalizeSymbol(req.query.symbol);
      const positionSide = String(req.query.positionSide || 'BOTH').toUpperCase();
      const p = (runtime.positions || []).find(x =>
        normalizeSymbol(x.symbol) === symbol &&
        String(x.positionSide || 'BOTH').toUpperCase() === positionSide
      );
      if (!p) return res.status(404).json({ error: '未找到该仓位，可能已平仓，请先同步复核' });
      const d = await protection.diagnostics(p);
      const runtimeIndex = (runtime.positions || []).findIndex(x => normalizeSymbol(x.symbol) === symbol && String(x.positionSide || 'BOTH').toUpperCase() === positionSide);
      if (runtimeIndex >= 0 && d.protectionState !== 'UNKNOWN') runtime.positions[runtimeIndex] = decoratePosition({
        ...runtime.positions[runtimeIndex],
        contracts: d.contracts,
        side: d.side,
        entryPrice: d.entryPrice,
        markPrice: d.markPrice,
        unrealizedPnl: d.unrealizedPnl,
        leverage: d.leverage || 0,
        liquidationPrice: d.liquidationPrice || 0,
        protectionSL: d.actualSL ?? d.expectedSL ?? null,
        protectionTP: d.actualTP ?? d.expectedTP ?? null,
        positionReturnPct: d.positionReturnPct,
        protectionStatus: d.protectionState,
        protectionVerifiedAt: d.checkedAt
      }); updateRuntimeHealth();
      res.json(d);
    } catch (e) {
      runtime.lastError = errorSummary(e);
      Logger.error('保护诊断接口失败', { error: e, code: e.code || null, status: e.status || null, endpoint: '/api/positions/diagnostics', symbol: req.query.symbol || null, positionSide: req.query.positionSide || null });
      res.status(500).json({ error: e.message, code: e.code || null, status: e.status || null });
    }
  });

  app.get('/api/settings', (req, res) => res.json({ config: config.get(), credentials: credentials.masked() }));
  app.post('/api/settings', async (req, res) => {
    try {
      const body = req.body || {}; const { binance: b, ai: a, ...cfgPatch } = body;
      validateSettingsPatch(cfgPatch);
      // 只有用户明确提供非空字段才更新 Secret，避免前端的掩码覆盖真实 Secret。
      if (b) credentials.save({ ...(b.apiKey !== undefined && b.apiKey !== '' && !b.apiKey.includes('••••') ? { binanceApiKey: b.apiKey } : {}), ...(b.apiSecret !== undefined && b.apiSecret !== '' && !b.apiSecret.includes('••••') ? { binanceApiSecret: b.apiSecret } : {}) });
      if (a) {
        const currentKeys = credentials.get().aiApiKeys || {};
        const providerKeys = a.apiKeys && typeof a.apiKeys === 'object' ? { ...currentKeys, ...a.apiKeys } : { ...currentKeys };
        if (a.apiKey !== undefined && a.apiKey !== '' && !a.apiKey.includes('••••') && !Object.keys(a.apiKeys || {}).length) providerKeys.legacy = a.apiKey;
        credentials.save({ aiApiKeys: providerKeys });
      }
      const cleaned = { ...cfgPatch };
      delete cleaned.binanceApiKey; delete cleaned.binanceApiSecret; delete cleaned.aiApiKey;
      if (a) {
        cleaned.ai = {
          providers: Array.isArray(a.providers) ? a.providers : config.get().ai?.providers,
          autoFailover: a.autoFailover !== undefined ? !!a.autoFailover : config.get().ai?.autoFailover !== false,
          freeFirst: a.freeFirst !== undefined ? !!a.freeFirst : !!config.get().ai?.freeFirst
        };
      }
      config.save(cleaned);
      if (config.get().ruleTrading?.enabled === true && !ruleTrader.running && started) ruleTrader.start();
      if (config.get().ruleTrading?.enabled !== true && ruleTrader.running) ruleTrader.stop('SETTINGS_DISABLED');
      // Binance 凭据变更才需要重启 WS/REST 运行时；单纯修改 AI 供应商无需中断持仓保护。
      if (b) {
        if (started || monitor.running) monitor.stop();
        started = false;
        await startRuntime();
      }
      res.json({ ok: true, config: config.get(), credentials: credentials.masked(), status: runtime.status });
    } catch (e) { runtime.lastError = errorSummary(e); Logger.error('设置保存失败', { error: e, code: e.code || null, status: e.status || null }); res.status(400).json({ error: e.message, code: e.code || null, status: e.status || null }); }
  });
  app.post('/api/settings/auto-protection', async (req, res) => {
    try {
      const enabled = !!req.body.enabled;
      config.save({ autoProtection: enabled });
      Logger.warn('自动保护开关变更', { enabled });
      if (enabled && started) {
        await reconcile.run();
      }
      res.json({ ok: true, enabled: config.get().autoProtection });
    } catch (e) {
      runtime.lastError = errorSummary(e);
      Logger.error('自动保护开关变更失败', { error: e, code: e.code || null, status: e.status || null });
      res.status(400).json({ error: e.message, code: e.code || null, status: e.status || null });
    }
  });
  app.post('/api/settings/ai-trading', (req, res) => { const enabled = !!req.body.enabled; config.save({ aiTrading: enabled }); if (enabled) state.rawSet('aiEmergencyStopped', false); Logger.warn('AI实盘开关变更', { enabled }); scheduleAILoop(); res.json({ ok: true, enabled }); });
  app.get('/api/rule-trading', (req, res) => { runtime.ruleTrading = ruleTrader.getStatus(); res.json(runtime.ruleTrading); });
  app.post('/api/settings/rule-trading', async (req, res) => { try { const enabled = !!req.body.enabled; config.save({ ruleTrading: { ...(config.get().ruleTrading || {}), enabled } }); if (enabled) { if (started && !ruleTrader.running) ruleTrader.start(); } else ruleTrader.stop('USER_DISABLED'); runtime.ruleTrading = ruleTrader.getStatus(); Logger.warn('规则自动交易开关变更', { enabled }); res.json({ ok: true, enabled, ruleTrading: runtime.ruleTrading }); } catch (e) { runtime.lastError = errorSummary(e); Logger.error('规则自动交易开关变更失败', { error: e, code: e.code || null, status: e.status || null }); res.status(400).json({ error: e.message, code: e.code || null, status: e.status || null }); } });
  app.post('/api/rule-trading/scan', async (req, res) => { try { runtime.ruleTrading = await ruleTrader.scan(); res.json(runtime.ruleTrading); } catch (e) { runtime.lastError = errorSummary(e); Logger.error('规则自动交易手动扫描失败', { error: e, code: e.code || null, status: e.status || null }); res.status(400).json({ error: e.message, code: e.code || null, status: e.status || null }); } });

  app.post('/api/binance/test', async (req, res) => {
    try {
      const b = req.body?.binance || {};
      const input = (b.apiKey && b.apiSecret) ? { binanceApiKey: b.apiKey, binanceApiSecret: b.apiSecret } : null;
      const r = await binance.testConnection(input);
      // 测试成功后才保存当前输入，防止旧凭据被误认为当前凭据。
      if (input) credentials.save(input);
      runtime.lastError = null;
      // 测试连接成功且当前 runtime 尚未成功启动时，立即用刚验证通过的凭据重建运行时。
      // 若当前已有正常运行实例，不在“测试连接”按钮中强制重启，避免干扰实时保护。
      if (input && !started) {
        await startRuntime();
      }
      res.json({ ...r, runtimeStatus: runtime.status, runtimeStarted: started });
    } catch (e) {
      runtime.lastError = errorSummary(e);
      Logger.error('Binance连接测试失败', { error: e.message, code: e.code || null, status: e.status || null });
      res.status(400).json({ error: e.message, code: e.code || null, status: e.status || null, credentials: credentials.masked() });
    }
  });
  app.post('/api/ai/test', async (req, res) => { try { res.json(await ai.test()); } catch (e) { runtime.lastError = errorSummary(e); res.status(400).json({ error: e.message }); } });

  app.get('/api/positions', async (req, res) => { try { const p = await binance.fetchPositions(); res.json(p.map(x => decoratePosition({ ...x, positionSource: state.getPositionSource(x), protectionStatus: state.getProtectionState(x) }))); } catch (e) { runtime.lastError = errorSummary(e); Logger.error('持仓查询接口失败', { error: e, code: e.code || null, status: e.status || null }); res.status(400).json({ error: e.message, code: e.code || null, status: e.status || null }); } });
  app.post('/api/sync', async (req, res) => { try { const p = await reconcile.run(); runtime.positions = p.map(x => decoratePosition({ ...x, positionSource: state.getPositionSource(x), protectionStatus: state.getProtectionState(x) })); updateRuntimeHealth(); if (runtime.status === 'CONNECTING') runtime.status = 'READY'; res.json({ ok: true, positions: runtime.positions }); } catch (e) { runtime.lastError = errorSummary(e); Logger.error('手动同步失败', { error: e, code: e.code || null, status: e.status || null }); res.status(400).json({ error: e.message, code: e.code || null, status: e.status || null }); } });
  app.get('/api/market/:symbol', async (req, res) => {
    try {
      const symbol = normalizeSymbol(req.params.symbol);
      const [ticker, mark] = await Promise.all([
        binance.fetchTicker(symbol),
        binance.fetchMarkPrice(symbol)
      ]);
      res.json({
        symbol,
        price: Number(ticker.lastPrice || 0),
        changePct: Number(ticker.priceChangePercent || 0),
        high: Number(ticker.highPrice || 0),
        low: Number(ticker.lowPrice || 0),
        volume: Number(ticker.quoteVolume || 0),
        markPrice: Number(mark.markPrice || 0),
        indexPrice: Number(mark.indexPrice || 0),
        fundingRate: Number(mark.lastFundingRate || 0),
        nextFundingTime: Number(mark.nextFundingTime || 0),
        updatedAt: Date.now()
      });
    } catch (e) {
      runtime.lastError = errorSummary(e);
      res.status(400).json({ error: e.message, code: e.code || null, status: e.status || null });
    }
  });

  app.get('/api/ranking', async (req, res) => { try { runtime.ranking = await ranking.getTop5(); res.json(runtime.ranking); } catch (e) { runtime.lastError = errorSummary(e); res.status(400).json({ error: e.message }); } });
  app.get('/api/supertrend', (req, res) => { res.json(runtime.supertrend || supertrend.getStatus()); });
  app.get('/api/funding/:symbol', async (req, res) => { try { res.json(await funding.get(normalizeSymbol(req.params.symbol))); } catch (e) { runtime.lastError = errorSummary(e); Logger.warn('Funding 查询失败', { symbol: req.params.symbol, error: e, code: e.code || null, status: e.status || null }); res.status(400).json({ error: e.message, code: e.code || null, status: e.status || null }); } });

  app.post('/api/emergency-stop-ai', (req, res) => { state.rawSet('aiEmergencyStopped', true); config.save({ aiTrading: false }); Logger.warn('AI紧急停止'); scheduleAILoop(); res.json({ ok: true }); });
  app.post('/api/emergency-close', async (req, res) => { try { state.rawSet('aiEmergencyStopped', true); config.save({ aiTrading: false }); const r = await emergency.closeAll(); res.json(r); } catch (e) { runtime.lastError = errorSummary(e); res.status(400).json({ error: e.message }); } });

  app.post('/api/ai/analyze', async (req, res) => { try { const r = runtime.ranking || await ranking.getTop5(); runtime.lastAI = await aiTrader.run(r, runtime.positions, false); res.json(runtime.lastAI); } catch (e) { runtime.lastError = errorSummary(e); res.status(400).json({ error: e.message }); } });
  app.post('/api/ai/trade', async (req, res) => { try { if (!config.get().aiTrading || state.rawGet('aiEmergencyStopped', false)) throw new Error('AI实盘当前未开启'); const r = runtime.ranking || await ranking.getTop5(); runtime.lastAI = await aiTrader.run(r, runtime.positions, true); res.json(runtime.lastAI); } catch (e) { runtime.lastError = errorSummary(e); res.status(400).json({ error: e.message }); } });

  app.get('/api/logs', (req, res) => {
    try {
      const level = String(req.query.level || '').trim().toUpperCase();
      const q = String(req.query.q || '').trim();
      const limit = Math.max(1, Math.min(5000, Number(req.query.limit) || 1000));
      const lines = Logger.instance().readLines({ level, q, limit });
      res.json({ lines, level, q, limit, total: lines.length });
    } catch (e) { runtime.lastError = errorSummary(e); Logger.error('日志读取接口失败', { error: e }); res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/logs', (req, res) => {
    try {
      const removed = Logger.instance().clearLogs();
      Logger.info('服务器日志文件已清空', { removed });
      res.json({ ok: true, removed });
    } catch (e) { runtime.lastError = errorSummary(e); Logger.error('日志清空接口失败', { error: e }); res.status(500).json({ error: e.message }); }
  });

  // 不把服务暴露到局域网：只监听本机。若默认端口被占用，自动尝试 8788-8795。
  async function listenLocal() {
    const preferred = Number(config.get().serverPort) || 8787;
    for (let p = preferred; p <= preferred + 8; p++) {
      try {
        await new Promise((resolve, reject) => {
          const s = app.listen(p, '127.0.0.1', () => { server = s; resolve(); });
          s.on('error', reject);
        });
        return p;
      } catch (e) { if (p >= preferred + 8) throw e; }
    }
  }
  const actualPort = await listenLocal();
  await startRuntime();
  try { runtime.supertrend = await supertrend.scan(); } catch (e) { runtime.supertrend = supertrend.getStatus(); runtime.lastError = errorSummary(e); Logger.error('SuperTrend首次扫描失败', { error: e }); }
  // 首次扫描完成后再启动每分钟定时器；原 V11.2.0 在 started=true 之前调用，导致后续定时器没有真正建立。
  scheduleSupertrend();
  if (started && config.get().ruleTrading?.enabled === true) ruleTrader.start();
  scheduleAILoop();
  return { port: actualPort, server, shutdown: async () => { clearInterval(timer); clearInterval(ruleGuardTimer); clearTimeout(supertrendTimer); clearTimeout(aiLoopTimer); for (const t of algoReviewTimers.values()) clearTimeout(t); algoReviewTimers.clear(); ruleTrader.stop('APP_SHUTDOWN'); monitor.stop(); markStream.stop(); await new Promise(r => server?.close(() => r())); } };
}
module.exports = { createApplicationServer };
