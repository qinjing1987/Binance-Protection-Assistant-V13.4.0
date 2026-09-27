// 配置持久化：普通设置写 JSON，API Secret 永远不放这里。
const fs = require('fs');
const path = require('path');

const BUILTIN_PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek V4 Pro', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', enabled: true },
  { id: 'groq', label: 'Groq（OpenAI兼容）', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b', enabled: true },
  { id: 'openrouter', label: 'OpenRouter 免费模型（需免费 Key）', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free', enabled: false, requiresKey: true, free: true },
  { id: 'geminiFree', label: 'Gemini 3.8 Flash 免费层（需免费 Key）', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-3.8-flash', enabled: false, requiresKey: true, free: true },
  { id: 'ollama', label: 'Ollama 本地免费 AI（免 Key）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', enabled: false, requiresKey: false, free: true },
  { id: 'custom', label: '自定义 OpenAI 兼容接口', baseUrl: '', model: '', enabled: false, requiresKey: true }
];

const DEFAULTS = {
  serverPort: 8787,
  autoProtection: true,
  aiTrading: false,
  paperTrading: false,
  binanceSandbox: false,
  hedgeModeExpected: true,
  protection: {
    calculationMode: 'MARGIN',
    stopLossPct: 4,
    takeProfitPct: 8,
    stopLossMarginPct: 20,
    takeProfitMarginPct: 40,
    liquidationBufferPp: 0.5,
    priceProtect: false,
    fastFixedProtection: true,
    closeOnImmediateTarget: true,
    // 移动止盈止损：盈利达到激活阈值后启用 Binance 原生 Trailing，追踪回撤保护利润；固定 TP 继续保留。
    trailingEnabled: true,
    trailingActivationPct: 1,
    trailingCallbackPct: 1
  },
  risk: {
    defaultLeverage: 15,
    riskPerTradePct: 1,
    maxAIPositions: 3,
    maxAITotalRiskPct: 3,
    minSLPct: 2,
    maxSLPct: 7,
    minTPPct: 4,
    maxTPPct: 20,
    minRR: 2,
    minAIConfidence: 60,
    symbolCooldownMinutes: 30,
    lossStreakLimit: 3,
    lossStreakCooldownMinutes: 60,
    dailyLossLimitPct: 0,
    maxSlippagePct: 0.5
  },
  ranking: { topN: 5, minQuoteVolumeUSDT: 1000000 },
  // 无 AI 规则自动交易：默认关闭；V13仅计算 5m SuperTrend + 1m RSI + 1m 成交量，保持轻量。
  ruleTrading: {
    enabled: false,
    topN: 20,
    leverage: 10,
    riskPerTradePct: 0.5,
    maxPositions: 1,
    maxPendingOrders: 2,
    orderTtlMinutes: 5,
    cooldownMinutes: 10,
    marketStateLookbackBars: 6,
    marketStateMaxFlipCount: 2,
    marketStateMinRangeAtr: 1.0,
    marketStateMinEfficiency: 0.22,
    rsiPeriod: 14,
    rsiLongTrigger: 40,
    rsiShortTrigger: 60,
    rsiLookbackBars: 2,
    rsiLongDepth: 35,
    rsiShortDepth: 65,
    rsiDepthLookbackBars: 6,
    volumePeriod: 20,
    volumeMinRatio: 0.9,
    volumeStrongRatio: 1.2,
    entryLookbackBars: 4,
    entryOffsetAtr: 0.15,
    entryRetraceRatio: 0.38,
    maxEntryDistanceAtr: 1.5,
    stFlipCooldownBars: 1,
    minRuleSLPct: 0.4,
    maxRuleSLPct: 2.5,
    ruleTakeProfitRR: 2.0,
    exitOnIndicatorReverse: true,
    lossExitConfirmBars: 2,
    exitRsiLong: 60,
    exitRsiShort: 40,
    // 以下字段保留用于兼容旧版 settings.json，不再参与 V13 自动交易计算。
    require5mTrendMatch: true,
    bbPeriod: 20,
    bbStdDev: 2,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    bbTouchLookbackBars: 6,
    bbEntryOffsetPct: 15,
    macdConfirmBars: 3
  },
  ai: {
    providers: JSON.parse(JSON.stringify(BUILTIN_PROVIDERS)),
    autoFailover: true,
    freeFirst: true,
    signalTtlMinutes: 5,
    closeOnProtectionFailure: true
  }
};

function migrateLegacyAI(saved) {
  if (!saved || !saved.ai) return;
  const legacy = saved.ai;
  if (!Array.isArray(legacy.providers) && (legacy.baseUrl || legacy.model || legacy.provider)) {
    const id = legacy.provider || 'custom';
    const migrated = {
      id,
      label: `迁移自旧配置（${id}）`,
      baseUrl: legacy.baseUrl || '',
      model: legacy.model || '',
      enabled: true
    };
    saved.ai.providers = [
      migrated,
      ...BUILTIN_PROVIDERS.filter(x => x.id !== id).map(x => ({ ...x }))
    ];
  }
  delete legacy.provider;
  delete legacy.baseUrl;
  delete legacy.model;
}

function normalizeProviders(saved) {
  const incoming = Array.isArray(saved?.ai?.providers) ? saved.ai.providers : [];
  const map = new Map(incoming.map((p, i) => [String(p.id || `provider_${i + 1}`).trim(), p]));
  const merged = BUILTIN_PROVIDERS.map(def => {
    const p = map.get(def.id);
    if (!p) return { ...def };
    return { ...def, ...p, id: def.id, label: String(p.label || def.label).trim(), baseUrl: String(p.baseUrl ?? def.baseUrl).trim().replace(/\/+$/, ''), model: String(p.model ?? def.model).trim(), enabled: p.enabled !== false, requiresKey: p.requiresKey === undefined ? def.requiresKey !== false : p.requiresKey !== false, free: p.free === true || ['openrouter','geminiFree','ollama'].includes(def.id) };
  });
  const builtinIds = new Set(BUILTIN_PROVIDERS.map(x => x.id));
  for (const [id, p] of map.entries()) {
    if (builtinIds.has(id)) continue;
    merged.push({ id, label: String(p.label || id).trim(), baseUrl: String(p.baseUrl || '').trim().replace(/\/+$/, ''), model: String(p.model || '').trim(), enabled: p.enabled !== false, requiresKey: p.requiresKey === undefined ? true : p.requiresKey !== false });
  }
  saved.ai = saved.ai || {};
  saved.ai.providers = merged;
}

function deepMerge(base, incoming) {
  const out = { ...base };
  for (const [k, v] of Object.entries(incoming || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else out[k] = v;
  }
  return out;
}

class ConfigStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.data = this.load();
  }
  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      migrateLegacyAI(saved);
      const merged = deepMerge(DEFAULTS, saved);
      // V12：旧版规则默认冷却统一迁移为 10 分钟；用户后续可继续修改。
      if ([15, 30].includes(Number(saved?.ruleTrading?.cooldownMinutes))) merged.ruleTrading.cooldownMinutes = 10;
      // V13：只迁移明确的旧版兼容参数，不覆盖用户主动保存的新参数。
      if (saved?.ruleTrading) {
        if (Number(saved.ruleTrading.stFlipCooldownBars) === 2) merged.ruleTrading.stFlipCooldownBars = 1;
        // V13：旧版1.8 ATR默认迁移为1.5；若用户已明确保存其它值则保持。
        if (Number(saved.ruleTrading.maxEntryDistanceAtr) === 1.8) merged.ruleTrading.maxEntryDistanceAtr = 1.5;
        if (saved.ruleTrading.entryRetraceRatio == null && Number(saved.ruleTrading.entryLookbackBars) === 3 && Number(saved.ruleTrading.entryOffsetAtr) === 0.25) {
          merged.ruleTrading.entryLookbackBars = 4;
          merged.ruleTrading.entryOffsetAtr = 0.15;
          merged.ruleTrading.entryRetraceRatio = 0.38;
        }
        // V13 新字段只在缺失时由 DEFAULTS 提供，不覆盖用户现有设置。
      }
      normalizeProviders(merged);
      return merged;
    } catch {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }
  get() { return this.data; }
  save(patch) {
    this.data = deepMerge(this.data, patch);
    normalizeProviders(this.data);
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(temp, this.file);
    return this.data;
  }
  defaults() { return JSON.parse(JSON.stringify(DEFAULTS)); }
}
module.exports = ConfigStore;
module.exports.BUILTIN_PROVIDERS = BUILTIN_PROVIDERS;
