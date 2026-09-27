// ============================================================
// Binance USDⓈ-M Futures API 适配层（V11.2.0）
//
// 设计原则：
// 1. 业务代码禁止直接 fetch Binance，只能通过本类。
// 2. 所有签名请求统一使用同一套：时间偏移、参数编码、HMAC、重试。
// 3. 固定保护单 / Trailing 统一走 Binance Algo Order API。
// 4. 普通 MARKET 开仓/平仓仍走 /fapi/v1/order。
// 5. 测试连接时直接使用当前输入凭据，不读取旧缓存。
// 6. 软件只做仓位保护，不做加仓、减仓、自动调仓。
// ============================================================

const crypto = require('crypto');
const { normalizeSymbol } = require('../utils/symbol');
const { roundDown, roundPriceForSide } = require('../utils/math');
const Logger = require('../Logger');

class BinanceApiError extends Error {
  constructor(message, code, status, payload) {
    super(message);
    this.name = 'BinanceApiError';
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Binance 新版签名要求：先对 payload 做 URL percent-encoding，再计算 HMAC。
// encodeURIComponent 基础上再处理 RFC3986 中容易产生歧义的字符。
function encodeRFC3986(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildCanonicalQuery(params = {}) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeRFC3986(key)}=${encodeRFC3986(value)}`)
    .join('&');
}

class AlgoQueueCancelledError extends Error {
  constructor(message = 'Algo 保护任务已取消', reason = null) {
    super(message);
    this.name = 'AlgoQueueCancelledError';
    this.code = 'QUEUE_JOB_CANCELLED';
    this.status = 0;
    this.reason = reason || 'POSITION_CLOSED_WHILE_QUEUED';
  }
}

class BinanceClient {
  constructor({ credentialStore, config }) {
    this.credentialStore = credentialStore;
    this.config = config;

    // Binance serverTime - Date.now()，单位毫秒。
    this.timeOffset = 0;
    this.lastTimeSyncAt = 0;

    this.markets = new Map();
    this.brackets = new Map();
    this.symbolConfigs = new Map();
    this.symbolConfigsLoadedAt = 0;
    this.symbolConfigsTtlMs = 5000;
    this.initialized = false;
    this.actualHedgeMode = null;

    // 最近一次成功账户快照；风控在瞬时 REST 波动时只能回退到短时新鲜缓存，过期则继续拒绝自动开仓。
    this.lastAccountSnapshot = null;
    this.lastAccountSnapshotAt = 0;

    // Binance 当前 U 本位 Algo 下单限频：10s=1、1min=1。保护单必须全局串行。
    // 这里按 61 秒安全间隔实现，优先保证不因第二笔 Algo 创建撞限频而让保护流程进入失败。
    this.algoOrderMinIntervalMs = 61 * 1000;
    this.algoOrderQueue = [];
    this.algoOrderQueueRunning = false;
    this.algoOrderQueueSeq = 0;
    this.algoOrderJobs = new Map();
    this.lastAlgoOrderSubmitAt = 0;
  }

  credentials() {
    return this.credentialStore.get();
  }

  // 正式盘 / 测试网地址集中在这里，业务代码不得自己写 URL。
  baseUrl() {
    return this.config.get().binanceSandbox
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';
  }

  symbolId(symbol) {
    return normalizeSymbol(symbol);
  }

  // ----------------------------------------------------------
  // 时间同步
  // ----------------------------------------------------------

  async syncTime() {
    const before = Date.now();
    const data = await this.rawRequest('GET', '/fapi/v1/time', {
      signed: false,
      skipTimeSync: true
    });
    const after = Date.now();

    // 用请求前后中点，降低网络往返时间带来的误差。
    const localMid = Math.floor((before + after) / 2);
    this.timeOffset = Number(data.serverTime) - localMid;
    this.lastTimeSyncAt = Date.now();

    Logger.info('Binance时间同步完成', {
      offsetMs: this.timeOffset,
      rttMs: after - before
    });

    return this.timeOffset;
  }

  async ensureTimeFresh() {
    // 正常情况下 3 分钟重新同步一次；发生 -1021 时立即重同步。
    if (!this.lastTimeSyncAt || Date.now() - this.lastTimeSyncAt > 3 * 60 * 1000) {
      await this.syncTime();
    }
  }

  // ----------------------------------------------------------
  // 统一 REST 请求 / 签名 / 重试
  // ----------------------------------------------------------

  async rawRequest(
    method,
    path,
    {
      params = {},
      signed = false,
      apiKeyHeader = false,
      timeoutMs = 12000,
      retryTimestamp = true,
      credentialsOverride = null,
      skipTimeSync = false
    } = {}
  ) {
    const c = credentialsOverride || this.credentials();

    if (signed && (!c.binanceApiKey || !c.binanceApiSecret)) {
      throw new BinanceApiError(
        '未配置 Binance API Key / Secret',
        'NO_API_CREDENTIALS',
        0,
        null
      );
    }

    if (signed && !skipTimeSync) {
      await this.ensureTimeFresh();
    }

    // 约束：path 只能是路径，不允许把 ?a=b 混到 path 内。
    // 这样可以彻底避免“LeverageBracket 出现两个 ?”这种签名错误。
    if (path.includes('?')) {
      throw new BinanceApiError(
        `BinanceAdapter 禁止在 path 中携带查询参数：${path}`,
        'INVALID_PATH_QUERY',
        0,
        null
      );
    }

    let timestampRetried = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const requestParams = { ...params };

      if (signed) {
        requestParams.timestamp = Date.now() + this.timeOffset;
        requestParams.recvWindow = 10000;
      }

      const queryBeforeSign = buildCanonicalQuery(requestParams);
      const signature = signed
        ? crypto.createHmac('sha256', c.binanceApiSecret).update(queryBeforeSign).digest('hex')
        : '';

      const query = signed
        ? `${queryBeforeSign}&signature=${signature}`
        : queryBeforeSign;

      const url = `${this.baseUrl()}${path}${query ? `?${query}` : ''}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, {
          method: String(method).toUpperCase(),
          headers: (signed || apiKeyHeader)
            ? {
                'X-MBX-APIKEY': c.binanceApiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
              }
            : {},
          signal: controller.signal
        });

        const text = await res.text();
        let data;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = { raw: text };
        }

        if (!res.ok || (data && typeof data.code === 'number' && data.code < 0)) {
          const err = new BinanceApiError(
            `Binance ${String(method).toUpperCase()} ${path} ${res.status}: ${data.msg || JSON.stringify(data)}`,
            data.code,
            res.status,
            data
          );
          const retryAfterHeader = Number(res.headers.get('retry-after') || 0);
          if (retryAfterHeader > 0) err.retryAfterMs = Math.ceil(retryAfterHeader * 1000) + 1000;

          Logger.error('Binance REST 请求失败', {
            method: String(method).toUpperCase(),
            path,
            attempt: attempt + 1,
            code: err.code ?? null,
            status: err.status ?? null,
            retryAfterMs: err.retryAfterMs || null,
            binanceMessage: data?.msg || null
          });

          // Algo 下单限频与普通 REST 5xx/429 不同：不能用几百毫秒快速重试。
          // POST /fapi/v1/algoOrder 在队列中已经全局串行，这里遇到 429 直接交给上层队列处理。
          if (res.status === 429 && path === '/fapi/v1/algoOrder') {
            err.retryAfterMs = Math.max(Number(err.retryAfterMs || 0), this.algoOrderMinIntervalMs);
            throw err;
          }

          // -1021：先重新同步服务器时间，然后只重试一次。
          if (err.code === -1021 && signed && retryTimestamp && !timestampRetried) {
            timestampRetried = true;
            await this.syncTime();
            continue;
          }

          // 429 / 5xx：短暂退避后重试。
          if (res.status === 429 || res.status >= 500) {
            await wait(400 * (attempt + 1));
            continue;
          }

          throw err;
        }

        return data;
      } catch (error) {
        if (error.name === 'AbortError') {
          if (attempt < 2) {
            await wait(500 * (attempt + 1));
            continue;
          }
          const timeoutError = new BinanceApiError(
            `Binance请求超时：${String(method).toUpperCase()} ${path}`,
            'TIMEOUT',
            0,
            null
          );
          Logger.error('Binance REST 请求超时', { method: String(method).toUpperCase(), path, attempt: attempt + 1, error: timeoutError });
          throw timeoutError;
        }

        if (error instanceof BinanceApiError) throw error;

        if (attempt < 2) {
          await wait(500 * (attempt + 1));
          continue;
        }

        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new BinanceApiError('Binance请求失败', 'REQUEST_FAILED', 0, null);
  }

  // ----------------------------------------------------------
  // 初始化 / 账户
  // ----------------------------------------------------------

  async init() {
    const c = this.credentials();

    if (!c.binanceApiKey || !c.binanceApiSecret) {
      this.initialized = false;
      return { connected: false, reason: '未配置API' };
    }

    await this.syncTime();
    await this.loadExchangeInfo(true);

    const mode = await this.getPositionMode();
    this.actualHedgeMode = !!mode.dualSidePosition;

    const expected = !!this.config.get().hedgeModeExpected;
    if (expected !== this.actualHedgeMode) {
      Logger.warn('账户持仓模式与软件预期不一致', {
        expected,
        actual: this.actualHedgeMode
      });
    }

    // 初始化阶段最后再访问账户，确保所有基础规则都已加载。
    await this.getAccount();

    this.initialized = true;

    return {
      connected: true,
      hedgeMode: this.actualHedgeMode,
      timeOffsetMs: this.timeOffset
    };
  }

  async getPositionMode() {
    return this.rawRequest('GET', '/fapi/v1/positionSide/dual', { signed: true });
  }

  async getAccount() {
    const account = await this.rawRequest('GET', '/fapi/v3/account', { signed: true });
    if (account && typeof account === 'object') {
      this.lastAccountSnapshot = account;
      this.lastAccountSnapshotAt = Date.now();
    }
    return account;
  }

  getCachedAccountSnapshot(maxAgeMs = 15000) {
    if (!this.lastAccountSnapshot || !(this.lastAccountSnapshotAt > 0)) return null;
    if (Date.now() - this.lastAccountSnapshotAt > Number(maxAgeMs || 0)) return null;
    return { account: this.lastAccountSnapshot, ageMs: Date.now() - this.lastAccountSnapshotAt };
  }

  async getBalance() {
    return this.rawRequest('GET', '/fapi/v3/balance', { signed: true });
  }

  async getLeverageBracket(symbol) {
    // 参数必须放在 params，绝不能拼进 path，否则会破坏签名/查询参数。
    return this.rawRequest('GET', '/fapi/v1/leverageBracket', {
      signed: true,
      params: symbol ? { symbol: this.symbolId(symbol) } : {}
    });
  }

  // ----------------------------------------------------------
  // ExchangeInfo / 交易规则
  // ----------------------------------------------------------

  async loadExchangeInfo(force = false) {
    if (!force && this.markets.size) return this.markets;

    const data = await this.rawRequest('GET', '/fapi/v1/exchangeInfo');
    this.markets.clear();

    for (const s of data.symbols || []) {
      if (s.contractType !== 'PERPETUAL') continue;
      if (s.quoteAsset !== 'USDT') continue;
      if (s.status !== 'TRADING') continue;

      const filters = Object.fromEntries(
        (s.filters || []).map(item => [item.filterType, item])
      );

      this.markets.set(s.symbol, { ...s, filters });
    }

    return this.markets;
  }

  getMarket(symbol) {
    const id = this.symbolId(symbol);
    const market = this.markets.get(id);
    if (!market) throw new Error(`找不到可交易合约规则：${id}`);
    return market;
  }

  pricePrecision(symbol) {
    return this.getMarket(symbol).pricePrecision;
  }

  quantityPrecision(symbol) {
    return this.getMarket(symbol).quantityPrecision;
  }

  tickSize(symbol) {
    return Number(this.getMarket(symbol).filters.PRICE_FILTER?.tickSize || 0);
  }

  stepSize(symbol) {
    return Number(this.getMarket(symbol).filters.LOT_SIZE?.stepSize || 0);
  }

  minQty(symbol) {
    return Number(this.getMarket(symbol).filters.LOT_SIZE?.minQty || 0);
  }

  maxQty(symbol) {
    return Number(this.getMarket(symbol).filters.LOT_SIZE?.maxQty || 0);
  }

  minNotional(symbol) {
    return Number(this.getMarket(symbol).filters.MIN_NOTIONAL?.notional || 0);
  }

  roundPrice(symbol, price, mode = 'nearest') {
    return Number(
      roundPriceForSide(price, this.tickSize(symbol), mode)
        .toFixed(this.pricePrecision(symbol))
    );
  }

  roundQty(symbol, qty) {
    const market = this.getMarket(symbol);
    return Number(
      roundDown(qty, this.stepSize(symbol))
        .toFixed(market.quantityPrecision)
    );
  }

  // ----------------------------------------------------------
  // 仓位 / 订单 / 市场数据
  // ----------------------------------------------------------

  async getSymbolConfigs(force = false) {
    if (!force && this.symbolConfigs.size && Date.now() - this.symbolConfigsLoadedAt < this.symbolConfigsTtlMs) {
      return this.symbolConfigs;
    }
    const rows = await this.rawRequest('GET', '/fapi/v1/symbolConfig', { signed: true });
    const next = new Map();
    for (const row of rows || []) {
      if (!row?.symbol) continue;
      next.set(String(row.symbol).toUpperCase(), row);
    }
    this.symbolConfigs = next;
    this.symbolConfigsLoadedAt = Date.now();
    return this.symbolConfigs;
  }

  async getSymbolConfig(symbol, force = false) {
    const map = await this.getSymbolConfigs(force);
    return map.get(this.symbolId(symbol)) || null;
  }

  async fetchPositions(symbol = null, { forceConfig = false } = {}) {
    // V3 positionRisk 负责实时仓位事实；当前用户杠杆/保证金模式由 symbolConfig 补齐。
    // 不再依赖即将弃用的 V2 positionRisk。
    const rows = await this.rawRequest('GET', '/fapi/v3/positionRisk', {
      signed: true,
      params: symbol ? { symbol: this.symbolId(symbol) } : {}
    });
    let configs = new Map();
    let configReadError = null;
    try {
      configs = await this.getSymbolConfigs(forceConfig);
    } catch (error) {
      configReadError = error.message;
      Logger.warn('Binance symbolConfig 读取失败，仓位继续显示但保护禁止猜测杠杆', { symbol: symbol || null, error: error.message });
    }

    return (rows || [])
      .filter(row => Math.abs(Number(row.positionAmt || 0)) > 0)
      .map(row => {
        const config = configs.get(String(row.symbol || '').toUpperCase()) || null;
        const signedQty = Number(row.positionAmt || 0);
        return {
          symbol: row.symbol,
          positionSide: row.positionSide || 'BOTH',
          contracts: Math.abs(signedQty),
          signedContracts: signedQty,
          side: signedQty > 0 ? 'long' : 'short',
          entryPrice: Number(row.entryPrice || row.breakEvenPrice || 0),
          markPrice: Number(row.markPrice || 0),
          liquidationPrice: Number(row.liquidationPrice || 0),
          unrealizedPnl: Number(row.unRealizedProfit || 0),
          leverage: Number(config?.leverage || 0),
          marginType: config?.marginType || row.marginType || '',
          autoAddMargin: config?.isAutoAddMargin === true,
          isolatedMargin: Number(row.isolatedMargin || 0),
          notional: Number(row.notional || 0),
          leverageSource: config?.leverage != null ? 'BINANCE_SYMBOL_CONFIG' : 'NOT_READ',
          configReadError: configReadError || (!config ? 'SYMBOL_CONFIG_NOT_FOUND' : null),
          raw: row,
          symbolConfig: config
        };
      });
  }

  async fetchOpenOrders(symbol) {
    return this.rawRequest('GET', '/fapi/v1/openOrders', {
      signed: true,
      params: symbol ? { symbol: this.symbolId(symbol) } : {}
    });
  }

  async fetchOpenAlgoOrders(symbol) {
    return this.rawRequest('GET', '/fapi/v1/openAlgoOrders', {
      signed: true,
      params: symbol ? { symbol: this.symbolId(symbol) } : {}
    });
  }

  async getAlgoOrder(symbol, algoId) {
    return this.rawRequest('GET', '/fapi/v1/algoOrder', {
      signed: true,
      params: { symbol: this.symbolId(symbol), algoId }
    });
  }

  async cancelAlgoOrder(symbol, algoId) {
    // DELETE 撤单进入同一个全局 Algo 变更队列，防止多仓位并发修改互相打架。
    // 但不占用 POST /fapi/v1/algoOrder 的“提交限频”时间窗；Binance 当前官方文档明确给 POST 下单定义 10s=1、1min=1 的订单限频，DELETE 撤单当前按普通请求权重计。 
    return this.enqueueAlgoOrder(
      () => this.rawRequest('DELETE', '/fapi/v1/algoOrder', {
        signed: true,
        params: { symbol: this.symbolId(symbol), algoId }
      }),
      { label: 'CANCEL', priority: 20, rateLimited: false }
    );
  }

  async fetchTickers24h() {
    return this.rawRequest('GET', '/fapi/v1/ticker/24hr');
  }

  // 市场扫描：读取 USDⓈ-M K 线，不参与账户交易。默认只取已足够计算指标的历史K线。
  async fetchKlines(symbol, interval = '1m', limit = 120) {
    return this.rawRequest('GET', '/fapi/v1/klines', {
      signed: false,
      params: {
        symbol: this.symbolId(symbol),
        interval,
        limit: Math.max(20, Math.min(1500, Number(limit) || 120))
      }
    });
  }

  async fetchTicker(symbol) {
    return this.rawRequest('GET', '/fapi/v1/ticker/24hr', {
      params: { symbol: this.symbolId(symbol) }
    });
  }

  async fetchMarkPrice(symbol) {
    return this.rawRequest('GET', '/fapi/v1/premiumIndex', {
      params: { symbol: this.symbolId(symbol) }
    });
  }

  async fetchFundingRate(symbol) {
    return this.rawRequest('GET', '/fapi/v1/premiumIndex', {
      params: { symbol: this.symbolId(symbol) }
    });
  }

  // 一次取回全市场资金费率：/fapi/v1/premiumIndex 不带 symbol 时返回数组。
  // 逐 symbol 请求会产生 N 次调用，这里用单次调用换取限流安全。
  async fetchFundingRates() {
    const rows = await this.rawRequest('GET', '/fapi/v1/premiumIndex', {});
    return Array.isArray(rows) ? rows : [];
  }

  async fetchAccountEquity() {
    const account = await this.getAccount();
    const totalMargin = Number(account?.totalMarginBalance);
    if (Number.isFinite(totalMargin) && totalMargin > 0) return totalMargin;
    const totalWallet = Number(account?.totalWalletBalance);
    if (Number.isFinite(totalWallet) && totalWallet > 0) return totalWallet;
    const balance = await this.getBalance();
    const usdt = (balance || []).find(item => item.asset === 'USDT');
    const balanceValue = Number(usdt?.balance);
    if (Number.isFinite(balanceValue)) return balanceValue;
    return Number.isFinite(totalMargin) ? totalMargin : 0;
  }

  async setLeverage(symbol, leverage) {
    return this.rawRequest('POST', '/fapi/v1/leverage', {
      signed: true,
      params: {
        symbol: this.symbolId(symbol),
        leverage: Number(leverage)
      }
    });
  }

  // ----------------------------------------------------------
  // 普通市场单
  // ----------------------------------------------------------

  async createMarketOrder({ symbol, side, quantity, positionSide, newClientOrderId }) {
    const q = this.roundQty(symbol, Math.abs(quantity));
    if (!(q >= this.minQty(symbol))) throw new Error(`数量低于最小值：${q}`);

    const params = {
      symbol: this.symbolId(symbol),
      side: String(side).toUpperCase(),
      type: 'MARKET',
      quantity: q,
      positionSide: positionSide || 'BOTH',
      newOrderRespType: 'RESULT'
    };

    if (newClientOrderId) params.newClientOrderId = newClientOrderId;

    return this.rawRequest('POST', '/fapi/v1/order', {
      signed: true,
      params
    });
  }

  async createLimitOrder({ symbol, side, quantity, price, positionSide, timeInForce = 'GTC', newClientOrderId }) {
    const q = this.roundQty(symbol, Math.abs(quantity));
    const p = this.roundPrice(symbol, Number(price), String(side).toUpperCase() === 'BUY' ? 'floor' : 'ceil');
    if (!(q >= this.minQty(symbol))) throw new Error(`LIMIT 数量低于最小值：${q}`);
    const maxQty = this.maxQty(symbol);
    if (maxQty > 0 && q > maxQty) throw new Error(`LIMIT 数量超过交易所最大值：${q} > ${maxQty}`);
    if (!(p > 0)) throw new Error('LIMIT 价格无效');
    if (q * p < this.minNotional(symbol)) throw new Error(`LIMIT 名义价值低于交易所最小值：${q * p}`);
    const mode = positionSide || 'BOTH';
    const params = {
      symbol: this.symbolId(symbol),
      side: String(side).toUpperCase(),
      type: 'LIMIT',
      timeInForce: String(timeInForce || 'GTC').toUpperCase(),
      quantity: q,
      price: p,
      positionSide: mode,
      newOrderRespType: 'RESULT'
    };
    if (newClientOrderId) params.newClientOrderId = newClientOrderId;
    return this.rawRequest('POST', '/fapi/v1/order', { signed: true, params });
  }

  async cancelOrder(symbol, orderId = null, origClientOrderId = null) {
    const params = { symbol: this.symbolId(symbol) };
    if (orderId != null && orderId !== '') params.orderId = orderId;
    else if (origClientOrderId) params.origClientOrderId = origClientOrderId;
    else throw new Error('撤销普通订单必须提供 orderId 或 origClientOrderId');
    return this.rawRequest('DELETE', '/fapi/v1/order', { signed: true, params });
  }

  async createCloseMarketOrder({ symbol, side, quantity, positionSide, newClientOrderId }) {
    const q = this.roundQty(symbol, Math.abs(quantity));
    if (!(q >= this.minQty(symbol))) throw new Error(`平仓数量低于最小值：${q}`);

    const mode = positionSide || 'BOTH';
    const params = {
      symbol: this.symbolId(symbol),
      side: String(side).toUpperCase(),
      type: 'MARKET',
      quantity: q,
      positionSide: mode,
      newOrderRespType: 'RESULT'
    };

    // One-way 模式下才使用 reduceOnly；Hedge Mode 不发送该字段。
    if (mode === 'BOTH') params.reduceOnly = 'true';
    if (newClientOrderId) params.newClientOrderId = newClientOrderId;

    return this.rawRequest('POST', '/fapi/v1/order', {
      signed: true,
      params
    });
  }

  // ----------------------------------------------------------
  // 固定 SL / TP：Algo Order
  // ----------------------------------------------------------

  _algoOrderPriority(type) {
    if (type === 'STOP_MARKET') return 100; // 新仓位先保证止损
    if (type === 'TAKE_PROFIT_MARKET') return 50;
    return 10;
  }

  async enqueueAlgoOrder(task, { label = 'ALGO', priority = 0, rateLimited = true, queueKey = null, queueGuard = null } = {}) {
    return new Promise((resolve, reject) => {
      const job = {
        task, resolve, reject, label, priority, rateLimited: rateLimited !== false, seq: this.algoOrderQueueSeq++,
        queueKey: queueKey ? String(queueKey) : null,
        queueGuard: typeof queueGuard === 'function' ? queueGuard : null,
        started: false, settled: false, cancelled: false, cancelReason: null, enqueuedAt: Date.now(), waitLogAt: 0
      };
      this.algoOrderJobs.set(job.seq, job);
      this.algoOrderQueue.push(job);
      this.algoOrderQueue.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
      void this._drainAlgoOrderQueue();
    });
  }

  _queueCancellationError(job, reason = null) {
    const resolved = reason || `Algo 保护任务已取消：${job.label}`;
    const err = new AlgoQueueCancelledError(resolved, reason || null);
    err.queueKey = job.queueKey || null;
    err.queueLabel = job.label;
    err.queueSeq = job.seq;
    return err;
  }

  getQueuedAlgoJobs(queueKey = null) {
    const key = queueKey ? String(queueKey) : null;
    return [...this.algoOrderJobs.values()]
      .filter(job => !job.settled && !job.cancelled && (!key || job.queueKey === key))
      .map(job => ({
        seq: job.seq,
        label: job.label,
        priority: job.priority,
        queueKey: job.queueKey,
        started: !!job.started,
        rateLimited: !!job.rateLimited,
        enqueuedAt: job.enqueuedAt || null,
        ageMs: job.enqueuedAt ? Math.max(0, Date.now() - job.enqueuedAt) : null
      }));
  }

  cancelQueuedAlgoJobs(queueKey, reason = 'POSITION_CLOSED_WHILE_QUEUED') {
    const key = String(queueKey || '');
    if (!key) return 0;
    let cancelled = 0;
    for (const job of this.algoOrderJobs.values()) {
      if (job.queueKey !== key || job.started || job.cancelled || job.settled) continue;
      job.cancelled = true;
      job.cancelReason = reason;
      const idx = this.algoOrderQueue.indexOf(job);
      if (idx >= 0) this.algoOrderQueue.splice(idx, 1);
      job.settled = true;
      job.reject(this._queueCancellationError(job, reason));
      this.algoOrderJobs.delete(job.seq);
      cancelled += 1;
    }
    if (cancelled > 0) Logger.info('已取消仓位排队 Algo 任务', { queueKey: key, cancelled, reason });
    return cancelled;
  }

  async _waitForAlgoJob(job, waitMs) {
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    const guardReason = () => {
      if (!job.queueGuard) return true;
      return job.queueGuard();
    };
    while (Date.now() < deadline) {
      const guard = guardReason();
      if (job.cancelled || guard !== true) {
        throw this._queueCancellationError(job, job.cancelReason || (typeof guard === 'string' ? guard : 'POSITION_CLOSED_WHILE_QUEUED'));
      }
      await wait(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    const guard = guardReason();
    if (job.cancelled || guard !== true) {
      throw this._queueCancellationError(job, job.cancelReason || (typeof guard === 'string' ? guard : 'POSITION_CLOSED_WHILE_QUEUED'));
    }
  }

  async _drainAlgoOrderQueue() {
    if (this.algoOrderQueueRunning) return;
    this.algoOrderQueueRunning = true;
    try {
      while (this.algoOrderQueue.length) {
        // 清理已取消/已失效任务。
        for (let i = this.algoOrderQueue.length - 1; i >= 0; i--) {
          const stale = this.algoOrderQueue[i];
          const guard = stale?.queueGuard ? stale.queueGuard() : true;
          if (!stale || stale.cancelled || guard !== true) {
            const reason = stale?.cancelReason || (typeof guard === 'string' ? guard : 'POSITION_CLOSED_WHILE_QUEUED');
            if (stale && !stale.settled) { stale.settled = true; stale.reject(this._queueCancellationError(stale, reason)); }
            if (stale) this.algoOrderJobs.delete(stale.seq);
            this.algoOrderQueue.splice(i, 1);
          }
        }
        if (!this.algoOrderQueue.length) break;

        // 关键优化：不要拿着队头任务睡满整个限频窗口。
        // 如果当前窗口不可提交，就先执行可以立即执行的 DELETE/CANCEL；
        // 新进来的高优先级 SL 也可以在等待结束前插到队首。
        const postReadyAt = this.lastAlgoOrderSubmitAt + this.algoOrderMinIntervalMs;
        const postReady = Date.now() >= postReadyAt;

        // 重新按 priority/seq 排序后再取任务，确保新到的 SL 能抢在待执行 TP 前。
        this.algoOrderQueue.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
        let index = 0;
        if (!postReady) {
          index = this.algoOrderQueue.findIndex(job => !job.rateLimited);
          if (index < 0) {
            const waitMs = Math.min(250, Math.max(1, postReadyAt - Date.now()));
            const preview = this.algoOrderQueue[0];
            const now = Date.now();
            if (preview && now - Number(preview.waitLogAt || 0) >= 5000) {
              preview.waitLogAt = now;
              Logger.info('Algo 变更进入限频等待队列', { label: preview.label || 'ALGO', waitMs, intervalMs: this.algoOrderMinIntervalMs, queueKey: preview.queueKey || null, queueLength: this.algoOrderQueue.length });
            }
            await wait(waitMs);
            continue;
          }
        }
        const job = this.algoOrderQueue.splice(index, 1)[0];
        if (!job) continue;

        const preGuard = job.queueGuard ? job.queueGuard() : true;
        if (job.cancelled || preGuard !== true) {
          const cancelReason = job.cancelReason || (typeof preGuard === 'string' ? preGuard : 'POSITION_CLOSED_WHILE_QUEUED');
          if (!job.settled) { job.settled = true; job.reject(this._queueCancellationError(job, cancelReason)); }
          this.algoOrderJobs.delete(job.seq);
          continue;
        }

        // rateLimited=false 的 DELETE/CANCEL 不受 POST Algo 限频等待影响。
        job.started = true;
        let attempt = 0;
        while (true) {
          try {
            const result = await job.task();
            if (job.rateLimited) this.lastAlgoOrderSubmitAt = Date.now();
            if (!job.settled) { job.settled = true; job.resolve(result); }
            break;
          } catch (error) {
            const rateLimited = error?.status === 429 || error?.code === -1003;
            if (rateLimited && attempt < 1) {
              attempt += 1;
              const delay = Math.max(this.algoOrderMinIntervalMs, Number(error.retryAfterMs || 0) || 0);
              Logger.warn('Binance Algo 变更被限频，自动延后重试', { label: job.label, waitMs: delay, code: error.code || null, status: error.status || null, queueKey: job.queueKey || null });
              await wait(delay);
              continue;
            }
            if (!job.settled) { job.settled = true; job.reject(error); }
            break;
          }
        }
        this.algoOrderJobs.delete(job.seq);
      }
    } finally {
      this.algoOrderQueueRunning = false;
      if (this.algoOrderQueue.length) void this._drainAlgoOrderQueue();
    }
  }

  buildProtectionAlgoParams({ symbol, side, type, triggerPrice, positionSide, clientAlgoId, priceProtect = false }) {
    if (!['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(type)) {
      throw new Error('非法固定保护单类型');
    }

    const mode = positionSide || 'BOTH';
    const closeSide = mode === 'LONG'
      ? 'SELL'
      : mode === 'SHORT'
        ? 'BUY'
        : String(side).toUpperCase();

    if (mode === 'LONG' && closeSide !== 'SELL') throw new Error('Hedge LONG 的保护单必须为 SELL');
    if (mode === 'SHORT' && closeSide !== 'BUY') throw new Error('Hedge SHORT 的保护单必须为 BUY');

    const priceMode = type === 'STOP_MARKET'
      ? (closeSide === 'SELL' ? 'floor' : 'ceil')
      : (closeSide === 'SELL' ? 'ceil' : 'floor');
    const price = this.roundPrice(symbol, triggerPrice, priceMode);

    return {
      algoType: 'CONDITIONAL',
      symbol: this.symbolId(symbol),
      side: closeSide,
      type,
      positionSide: mode,
      triggerPrice: price,
      workingType: 'MARK_PRICE',
      closePosition: 'true',
      priceProtect: priceProtect === true ? 'true' : 'false',
      clientAlgoId: clientAlgoId || `QP_${type === 'STOP_MARKET' ? 'SL' : 'TP'}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      newOrderRespType: 'ACK'
    };
  }

  async createProtectionOrder(opts) {
    const params = this.buildProtectionAlgoParams(opts);
    const type = opts.type;
    return this.enqueueAlgoOrder(
      () => this.rawRequest('POST', '/fapi/v1/algoOrder', { signed: true, params }),
      { label: type === 'STOP_MARKET' ? 'SL' : 'TP', priority: this._algoOrderPriority(type), rateLimited: true, queueKey: opts.queueKey, queueGuard: opts.queueGuard }
    );
  }

  // 在同一个全局 Algo 变更队列任务内“先撤旧、再建新”。
  // 这样队列先等待 POST 的限频窗口，进入任务后立即撤旧单并创建新单，
  // 不会出现“先撤掉旧保护，再等待 61 秒”的不必要裸仓窗口。
  async replaceProtectionOrder({ existingAlgoId, ...opts }) {
    const params = this.buildProtectionAlgoParams(opts);
    const type = opts.type;
    return this.enqueueAlgoOrder(
      async () => {
        try {
          await this.rawRequest('DELETE', '/fapi/v1/algoOrder', {
            signed: true,
            params: { symbol: this.symbolId(opts.symbol), algoId: existingAlgoId }
          });
        } catch (e) {
          // 旧单已经不存在/已终态时，允许继续创建新保护；其它撤单失败必须阻止替换。
          const msg = String(e?.message || '');
          const code = Number(e?.code);
          const alreadyGone = [-2011, -2013].includes(code) || /Unknown order|not found|does not exist|already.*cancel/i.test(msg);
          if (!alreadyGone) throw e;
          Logger.warn('替换保护时旧 Algo 已不存在，继续创建新保护', { symbol: opts.symbol, positionSide: opts.positionSide, type, existingAlgoId, code: e?.code ?? null, status: e?.status ?? null });
        }
        return this.rawRequest('POST', '/fapi/v1/algoOrder', { signed: true, params });
      },
      { label: `REPLACE_${type === 'STOP_MARKET' ? 'SL' : 'TP'}`, priority: this._algoOrderPriority(type) + 5, rateLimited: true, queueKey: opts.queueKey, queueGuard: opts.queueGuard }
    );
  }

  // ----------------------------------------------------------
  // Trailing Stop
  // ----------------------------------------------------------

  async createTrailingOrder({ symbol, side, quantity, activationPrice = null, callbackRate, positionSide, clientAlgoId, queueKey, queueGuard }) {
    const q = this.roundQty(symbol, Math.abs(quantity));
    if (!(q >= this.minQty(symbol))) throw new Error(`Trailing 数量低于最小值：${q}`);

    const callback = Number(callbackRate);
    // Binance 当前公开接口文档中的 callbackRate 上限按 10% 校验。
    if (!(callback >= 0.1 && callback <= 10)) {
      throw new Error('Trailing 回调比例必须在 0.1%～10%');
    }

    const s = String(side).toUpperCase();
    const params = {
      algoType: 'CONDITIONAL',
      symbol: this.symbolId(symbol),
      side: s,
      type: 'TRAILING_STOP_MARKET',
      positionSide: positionSide || 'BOTH',
      quantity: q,
      callbackRate: callback,
      workingType: 'MARK_PRICE',
      clientAlgoId: clientAlgoId || `QP_TR_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      newOrderRespType: 'ACK'
    };

    // 已经达到移动保护激活条件时不强行提供一个“未来的”激活价。
    // Binance 文档规定 activationPrice 省略时默认使用最新价格，适合立即开始跟踪。
    if (activationPrice != null && Number(activationPrice) > 0) {
      const ap = this.roundPrice(
        symbol,
        activationPrice,
        s === 'SELL' ? 'ceil' : 'floor'
      );
      params.activatePrice = ap;
    }

    // Hedge Mode 禁止 reduceOnly。
    if ((positionSide || 'BOTH') === 'BOTH') params.reduceOnly = 'true';

    return this.enqueueAlgoOrder(
      () => this.rawRequest('POST', '/fapi/v1/algoOrder', { signed: true, params }),
      { label: 'TRAILING', priority: 10, queueKey, queueGuard }
    );
  }

  listTradableUSDT() {
    return [...this.markets.values()].map(item => item.symbol);
  }

  async maxInitialLeverage(symbol) {
    const id = this.symbolId(symbol);
    const cached = this.brackets.get(id);
    if (cached) return cached;

    const rows = await this.getLeverageBracket(id);
    const list = Array.isArray(rows) ? rows : [];
    const first = list.find(x => normalizeSymbol(x?.symbol) === id) || list[0];
    const brackets = Array.isArray(first?.brackets) ? first.brackets : [];
    const maxLev = brackets.reduce(
      (max, item) => Math.max(max, Number(item.initialLeverage || 0)),
      0
    );
    if (!(maxLev > 0)) throw new Error(`无法读取 ${id} 的 Binance 最大初始杠杆，禁止猜测默认杠杆`);

    this.brackets.set(id, maxLev);
    return maxLev;
  }

  // ----------------------------------------------------------
  // 测试连接：严格直接使用当前输入的凭据
  // ----------------------------------------------------------

  async testConnection(credentialsOverride = null) {
    const source = credentialsOverride || this.credentials();
    const apiKey = String(source.binanceApiKey || '').trim();
    const apiSecret = String(source.binanceApiSecret || '').trim();

    if (!apiKey || !apiSecret) {
      throw new BinanceApiError(
        '未配置 Binance API Key / Secret',
        'NO_API_CREDENTIALS',
        0,
        null
      );
    }

    if (!/^[\x21-\x7E]+$/.test(apiKey) || !/^[\x21-\x7E]+$/.test(apiSecret)) {
      throw new BinanceApiError(
        'Binance API Key / Secret 含有空白、中文或不可见字符，请重新复制纯凭据内容',
        'INVALID_CREDENTIAL_FORMAT',
        0,
        null
      );
    }

    // 测试连接时不依赖 credentialStore 的历史值。
    const testCredentials = {
      binanceApiKey: apiKey,
      binanceApiSecret: apiSecret
    };

    // 强制重新同步服务器时间，确保诊断结果真实。
    const before = Date.now();
    const server = await this.rawRequest('GET', '/fapi/v1/time', {
      signed: false,
      skipTimeSync: true
    });
    const after = Date.now();
    const localMid = Math.floor((before + after) / 2);

    this.timeOffset = Number(server.serverTime) - localMid;
    this.lastTimeSyncAt = Date.now();

    // 两个关键签名接口：账户 + Hedge Mode。
    const account = await this.rawRequest('GET', '/fapi/v3/account', {
      signed: true,
      credentialsOverride: testCredentials
    });

    const mode = await this.rawRequest('GET', '/fapi/v1/positionSide/dual', {
      signed: true,
      credentialsOverride: testCredentials
    });

    // 公共接口，顺便确认市场环境/ExchangeInfo。
    const exchangeInfo = await this.rawRequest('GET', '/fapi/v1/exchangeInfo');

    return {
      ok: true,
      environment: this.config.get().binanceSandbox ? '测试网' : '正式盘',
      baseUrl: this.baseUrl(),
      serverTime: Number(server.serverTime),
      serverTimeOffsetMs: this.timeOffset,
      publicApiConnectivity: true,
      signedAccount: true,
      signedPositionMode: true,
      exchangeInfo: true,
      hedgeMode: !!mode.dualSidePosition,
      canTrade: !!account,
      walletBalance: Number(account.totalWalletBalance || 0),
      availableBalance: Number(account.availableBalance || 0),
      symbolCount: Array.isArray(exchangeInfo.symbols) ? exchangeInfo.symbols.length : 0,
      apiKeyMasked: `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`,
      apiKeyLength: apiKey.length,
      secretLength: apiSecret.length
    };
  }
}

module.exports = BinanceClient;
module.exports.BinanceApiError = BinanceApiError;
module.exports.buildCanonicalQuery = buildCanonicalQuery;
