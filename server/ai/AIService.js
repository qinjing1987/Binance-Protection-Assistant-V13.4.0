// AI Provider：只让模型做市场判断，输出严格 JSON。
// V11.2.0：统一 OpenAI Chat Completions 兼容格式，并支持供应商自动故障切换与免费供应商优先。
const { normalizeSymbol } = require('../utils/symbol');
const Logger = require('../Logger');

class AIService {
  constructor({ credentials, config }) {
    this.credentials = credentials;
    this.config = config;
    this.lastProvider = null;
    this.lastAttempts = [];
  }

  providers() {
    const cfg = this.config.get().ai || {};
    const list = (cfg.providers || [])
      .filter(p => p && p.enabled !== false && p.baseUrl && p.model)
      .map(p => ({
        id: String(p.id),
        label: String(p.label || p.id),
        baseUrl: String(p.baseUrl).replace(/\/+$/, ''),
        model: String(p.model),
        requiresKey: p.requiresKey !== false,
        free: p.free === true || ['openrouter','geminiFree','ollama'].includes(String(p.id))
      }));
    return cfg.freeFirst === true ? list.sort((a,b) => Number(b.free) - Number(a.free)) : list;
  }

  keyFor(providerId, keys) {
    return String(keys?.[providerId] || keys?.legacy || '');
  }

  endpoint(provider, pathname = '/chat/completions') {
    return `${provider.baseUrl}/${String(pathname).replace(/^\/+/, '')}`;
  }

  async requestProvider(provider, apiKey, messages, options = {}) {
    if (provider.requiresKey && !apiKey) throw new Error('未配置 API Key');
    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs || 25000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = {
        model: provider.model,
        messages,
        max_tokens: Number(options.maxTokens || 300),
        temperature: 0
      };
      // DeepSeek 等支持 JSON mode；若某兼容服务不接受该字段，下面会自动按同一供应商重试一次。
      if (options.jsonMode !== false) body.response_format = { type: 'json_object' };
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const r = await fetch(this.endpoint(provider), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await r.text();
      if (!r.ok) {
        const detail = text.length > 500 ? `${text.slice(0, 500)}…` : text;
        const err = new Error(`HTTP ${r.status}: ${detail}`);
        err.status = r.status;
        throw err;
      }
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('接口返回不是有效 JSON'); }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('接口未返回文本内容');
      return { data, text: content.trim() };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`请求超时（${timeoutMs}ms）`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async call(messages, options = {}) {
    const cfg = this.config.get().ai || {};
    const providers = this.providers();
    const credentials = this.credentials.get();
    if (!providers.length) throw new Error('没有启用且配置完整的 AI 供应商');
    const attempts = [];
    for (const provider of providers) {
      const key = this.keyFor(provider.id, credentials.aiApiKeys);
      if (provider.requiresKey && !key) {
        attempts.push({ provider: provider.id, label: provider.label, ok: false, error: '未配置 API Key' });
        if (!cfg.autoFailover) break;
        continue;
      }
      const started = Date.now();
      try {
        let result;
        try {
          result = await this.requestProvider(provider, key, messages, options);
        } catch (first) {
          // 某些 OpenAI 兼容服务暂不支持 response_format；去掉后只重试一次。
          if (options.jsonMode !== false && /HTTP 400|HTTP 422/i.test(first.message)) {
            result = await this.requestProvider(provider, key, messages, { ...options, jsonMode: false });
          } else throw first;
        }
        const item = { provider: provider.id, label: provider.label, ok: true, latencyMs: Date.now() - started };
        attempts.push(item);
        this.lastProvider = item;
        this.lastAttempts = attempts;
        return { ...result, provider: item, attempts };
      } catch (e) {
        const item = { provider: provider.id, label: provider.label, ok: false, latencyMs: Date.now() - started, error: e.message };
        attempts.push(item);
        Logger.warn('AI供应商请求失败', item);
        if (!cfg.autoFailover) break;
      }
    }
    this.lastAttempts = attempts;
    const detail = attempts.map(x => `${x.label}: ${x.error || '失败'}`).join('；');
    throw new Error(`所有已启用 AI 供应商均失败：${detail}`);
  }

  async test() {
    const started = Date.now();
    const messages = [
      { role: 'system', content: '只输出一个合法 JSON：{"ok":true}' },
      { role: 'user', content: '连通性测试，只回复 JSON。' }
    ];
    const cfg = this.config.get().ai || {};
    const providers = this.providers();
    const keys = this.credentials.get().aiApiKeys || {};
    const results = [];
    for (const provider of providers) {
      const key = this.keyFor(provider.id, keys);
      if (provider.requiresKey && !key) {
        results.push({ provider: provider.id, label: provider.label, ok: false, error: '未配置 API Key' });
        continue;
      }
      const t = Date.now();
      try {
        const r = await this.requestProvider(provider, key, messages, { maxTokens: 30, timeoutMs: 12000 });
        results.push({ provider: provider.id, label: provider.label, ok: true, status: 200, latencyMs: Date.now() - t, model: provider.model, free: provider.free === true });
      } catch (e) {
        results.push({ provider: provider.id, label: provider.label, ok: false, latencyMs: Date.now() - t, error: e.message });
        if (!cfg.autoFailover) break;
      }
    }
    return { ok: results.some(x => x.ok), total: results.length, results, elapsedMs: Date.now() - started };
  }

  parseSignal(text, candidates) {
    const clean = String(text).replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    let json;
    try { json = JSON.parse(clean); }
    catch {
      const m = clean.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('AI返回不是有效JSON');
      json = JSON.parse(m[0]);
    }
    const candidateSet = new Set(candidates.map(x => normalizeSymbol(x.symbol)));
    const action = String(json.action || '').toUpperCase();
    const symbol = normalizeSymbol(json.symbol);
    const sl = Number(json.stop_loss_pct);
    const tp = Number(json.take_profit_pct);
    const confidence = Number(json.confidence);
    if (!['LONG', 'SHORT', 'HOLD'].includes(action)) throw new Error('AI action 必须为 LONG / SHORT / HOLD');
    if (action !== 'HOLD' && !candidateSet.has(symbol)) throw new Error('AI选择了候选池之外的币种');
    if (action !== 'HOLD' && (!Number.isFinite(sl) || !Number.isFinite(tp) || !Number.isFinite(confidence))) throw new Error('AI信号缺少 SL / TP / confidence');
    return {
      action, symbol: action === 'HOLD' ? '' : symbol,
      stop_loss_pct: sl, take_profit_pct: tp, confidence,
      reason: String(json.reason || '').slice(0, 500)
    };
  }

  async analyze(ranking) {
    const candidates = [...(ranking.gainers || []), ...(ranking.losers || [])];
    const prompt = `你是短线合约行情分析器。只分析给定候选池。禁止追涨杀跌，优先观察突破后回踩、二次推动、假突破回收及量价确认。
严格只输出一个 JSON：{"action":"LONG|SHORT|HOLD","symbol":"候选symbol","stop_loss_pct":4,"take_profit_pct":8,"confidence":0,"reason":"简短理由"}。
规则：HOLD 时 symbol 可为空；非 HOLD 时 SL 2-7%，TP 4-20%，TP/SL>=2；不得输出数量、杠杆、仓位、最大亏损、加仓、减仓或关闭风控指令。
候选池：${JSON.stringify(candidates)}`;
    const r = await this.call([
      { role: 'system', content: '你必须严格输出 JSON，绝不能输出 Markdown。' },
      { role: 'user', content: prompt }
    ], { maxTokens: 300, timeoutMs: 25000, jsonMode: true });
    const signal = this.parseSignal(r.text, candidates);
    return { ...signal, provider: r.provider.provider, providerLabel: r.provider.label, providerLatencyMs: r.provider.latencyMs, providerAttempts: r.attempts };
  }
}
module.exports = AIService;
