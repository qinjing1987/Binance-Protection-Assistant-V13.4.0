// ============================================================
// Binance USDⓈ-M User Data Stream
// V11.2.0：正式盘/测试网 WS 地址一致映射；支持杠杆配置变更触发保护重算；修复 CONNECTING 状态下 close() 崩溃竞态。
// ============================================================
const EventEmitter = require('events');
const WebSocket = require('ws');
const Logger = require('../Logger');

class UserDataStream extends EventEmitter {
  constructor(binance) {
    super();
    this.binance = binance;
    this.ws = null;
    this.listenKey = '';
    this.stopped = true;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.rotationTimer = null;
    this.startedAt = 0;
    this.backoff = 2000;
    this.lastEventAt = 0;
    this.generation = 0;
  }

  wsBaseUrl() {
    // Binance USDⓈ-M 于 2026-04-23 起停用旧 /ws 用户数据路径，私有流必须走 /private。
    return this.binance.config.get().binanceSandbox
      ? 'wss://stream.binancefuture.com/private'
      : 'wss://fstream.binance.com/private';
  }

  wsUrl(listenKey) {
    const events = [
      'ORDER_TRADE_UPDATE',
      'ACCOUNT_UPDATE',
      'ACCOUNT_CONFIG_UPDATE',
      'ALGO_UPDATE',
      'MARGIN_CALL',
      'listenKeyExpired'
    ].join('/');
    return `${this.wsBaseUrl()}/ws?listenKey=${encodeURIComponent(listenKey)}&events=${events}`;
  }

  async createListenKey() {
    const data = await this.binance.rawRequest('POST', '/fapi/v1/listenKey', {
      signed: false,
      apiKeyHeader: true,
      skipTimeSync: true
    });
    if (!data.listenKey) throw new Error('Binance 未返回 listenKey');
    return data.listenKey;
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await this.connect();
  }

  clearTimers() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.rotationTimer);
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.rotationTimer = null;
  }

  async connect() {
    if (this.stopped) return;
    const myGeneration = ++this.generation;

    try {
      await this.disposeSocket();
      const listenKey = await this.createListenKey();
      if (this.stopped || myGeneration !== this.generation) return;

      this.listenKey = listenKey;
      this.startedAt = Date.now();
      this.backoff = 2000;

      const endpoint = this.wsBaseUrl();
      const ws = new WebSocket(this.wsUrl(listenKey));
      this.ws = ws;

      ws.on('open', () => {
        if (this.ws !== ws) return;
        Logger.info('Binance 用户数据 WS 已连接', { endpoint });
        this.emit('status', { connected: true, startedAt: this.startedAt, endpoint });
      });
      ws.on('message', buffer => {
        if (this.ws !== ws) return;
        this.handleMessage(buffer.toString());
      });
      ws.on('error', error => {
        if (this.ws !== ws) return;
        Logger.warn('用户数据 WS 错误', { error, endpoint, readyState: ws.readyState });
      });
      ws.on('close', (code, reason) => {
        if (this.ws !== ws) return;
        this.ws = null;
        Logger.warn('用户数据 WS 连接关闭', { endpoint, code, reason: String(reason || '') });
        this.emit('status', { connected: false, endpoint, code, reason: String(reason || '') });
        if (!this.stopped) this.scheduleReconnect();
      });
      ws.on('ping', data => { try { ws.pong(data); } catch {} });

      this.clearTimers();
      this.keepaliveTimer = setInterval(() => this.keepAlive().catch(() => {}), 25 * 60 * 1000);
      this.rotationTimer = setTimeout(() => {
        if (this.stopped || this.ws !== ws) return;
        Logger.info('用户数据 WS 接近 23 小时，主动换代');
        try { ws.close(1000, 'planned rotation'); } catch {}
      }, 23 * 60 * 60 * 1000);
    } catch (error) {
      Logger.error('用户数据 WS 连接失败', { error, endpoint: this.wsBaseUrl() });
      this.emit('status', { connected: false, endpoint: this.wsBaseUrl() });
      this.scheduleReconnect();
    }
  }

  async keepAlive() {
    if (this.stopped || !this.listenKey) return;
    try {
      const data = await this.binance.rawRequest('PUT', '/fapi/v1/listenKey', {
        params: { listenKey: this.listenKey },
        signed: false,
        apiKeyHeader: true,
        skipTimeSync: true
      });
      if (data?.listenKey) this.listenKey = data.listenKey;
      Logger.info('用户数据 listenKey 续期成功');
    } catch (error) {
      Logger.warn('listenKey 续期失败，将重新建立 WS', { error });
      try { if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(); else if (this.ws?.readyState === WebSocket.CONNECTING) this.ws.terminate(); } catch {}
    }
  }

  handleMessage(text) {
    let data;
    try { data = JSON.parse(text); }
    catch (error) { Logger.warn('用户数据 WS JSON 解析失败', { error, sample: String(text).slice(0, 300) }); return; }
    this.lastEventAt = Date.now();
    if (data?.e) this.emit('event', data);
    if (data?.e === 'listenKeyExpired') {
      Logger.warn('listenKeyExpired，立即重连');
      try { if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(); else if (this.ws?.readyState === WebSocket.CONNECTING) this.ws.terminate(); } catch {}
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, delay);
    Logger.warn(`用户数据 WS 将在 ${delay}ms 后重连`);
  }

  async disposeSocket(reason = 'DISPOSE') {
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.rotationTimer);
    this.keepaliveTimer = null;
    this.rotationTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;

    // 与 MarkPriceStream 相同：CONNECTING 状态禁止直接 close()+removeAllListeners，
    // 否则 ws v8 可能异步抛出 handshake 尚未建立的 error，导致主进程崩溃。
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { ws.removeAllListeners(); } catch {}
    };
    const safeReason = String(reason || 'DISPOSE').slice(0, 123);
    try {
      ws.once('error', () => {});
      ws.once('close', cleanup);
      const state = ws.readyState;
      if (state === WebSocket.CONNECTING) {
        ws.terminate();
      } else if (state === WebSocket.OPEN) {
        ws.close(1000, safeReason);
      } else if (state === WebSocket.CLOSING) {
        // 已在关闭，等待 close。
      } else {
        cleanup();
      }
    } catch (error) {
      Logger.warn('用户数据 WS 关闭过程异常，尝试 terminate', { error, reason: safeReason });
      try { ws.terminate(); } catch {}
      setImmediate(cleanup);
    }
    setTimeout(cleanup, 5000);
  }

  stop() {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    // 不要提前将 this.ws 置空，否则 disposeSocket 无法取得待关闭连接。
    void this.disposeSocket('STOP');
    this.emit('status', { connected: false, endpoint: this.wsBaseUrl() });
  }
}

module.exports = UserDataStream;
