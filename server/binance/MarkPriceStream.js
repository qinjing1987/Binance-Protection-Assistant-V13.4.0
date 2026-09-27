// Binance USDⓈ-M 公共 Mark Price 1s 行情流。
// 用于保护辅助链：快速观察触发价，不替代 Binance 交易所端 Algo 保护。
// V11.2.0：修复 CONNECTING 状态下 ws.close() 引发未捕获异常的重连竞态。
const EventEmitter = require('events');
const WebSocket = require('ws');
const Logger = require('../Logger');
const { normalizeSymbol } = require('../utils/symbol');

class MarkPriceStream extends EventEmitter {
  constructor({ config }) {
    super();
    this.config = config;
    this.ws = null;
    this.running = false;
    this.symbols = new Set();
    this.reconnectTimer = null;
    this.generation = 0;
    this.reconnectSerial = 0;
    this.backoff = 1000;
    this.lastEventAt = 0;
  }

  baseUrl() {
    return this.config.get().binanceSandbox
      ? 'wss://fstream.binancefuture.com/public'
      : 'wss://fstream.binance.com/public';
  }

  streams() {
    return [...this.symbols]
      .map(s => `${normalizeSymbol(s).toLowerCase()}@markPrice@1s`)
      .join('/');
  }

  wsUrl() {
    const streams = this.streams();
    return streams ? `${this.baseUrl()}/stream?streams=${streams}` : null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    if (this.symbols.size) await this.connect();
  }

  setSymbols(symbols = []) {
    const next = new Set((symbols || []).filter(Boolean).map(normalizeSymbol));
    const same = next.size === this.symbols.size && [...next].every(x => this.symbols.has(x));
    if (same) return;
    this.symbols = next;
    if (!this.running) return;
    void this.reconnectNow('SYMBOL_SET_CHANGED');
  }

  async reconnectNow(reason = 'MANUAL') {
    const serial = ++this.reconnectSerial;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.disposeSocket(reason);
    if (serial !== this.reconnectSerial) return;
    if (!this.running || !this.symbols.size) {
      this.emit('status', { connected: false, endpoint: this.baseUrl(), reason });
      return;
    }
    await this.connect();
  }

  async connect() {
    if (!this.running || !this.symbols.size) return;
    const myGeneration = ++this.generation;
    const endpoint = this.baseUrl();
    const url = this.wsUrl();
    try {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on('open', () => {
        if (this.ws !== ws || myGeneration !== this.generation) return;
        this.backoff = 1000;
        Logger.info('Binance Mark Price 1s WS 已连接', { endpoint, streams: this.symbols.size });
        this.emit('status', { connected: true, endpoint, streams: this.symbols.size });
      });
      ws.on('message', buffer => {
        if (this.ws !== ws || myGeneration !== this.generation) return;
        this.handleMessage(buffer.toString());
      });
      ws.on('error', error => {
        if (this.ws !== ws || myGeneration !== this.generation) return;
        Logger.warn('Mark Price WS 错误', { error, endpoint });
      });
      ws.on('close', (code, reason) => {
        if (this.ws !== ws || myGeneration !== this.generation) return;
        this.ws = null;
        Logger.warn('Mark Price WS 连接关闭', { endpoint, code, reason: String(reason || '') });
        this.emit('status', { connected: false, endpoint, code, reason: String(reason || '') });
        this.scheduleReconnect();
      });
      ws.on('ping', data => { try { ws.pong(data); } catch {} });
    } catch (error) {
      Logger.error('Mark Price WS 连接失败', { endpoint, error });
      this.emit('status', { connected: false, endpoint });
      this.scheduleReconnect();
    }
  }

  handleMessage(text) {
    let data;
    try { data = JSON.parse(text); }
    catch (error) { Logger.warn('Mark Price WS JSON 解析失败', { error, sample: String(text).slice(0, 200) }); return; }
    const payload = data?.data || data;
    if (!payload?.s) return;
    const markPrice = Number(payload.p || payload.markPrice || 0);
    if (!(markPrice > 0)) return;
    const eventTime = Number(payload.E || payload.eventTime || Date.now());
    this.lastEventAt = Date.now();
    this.emit('markPrice', {
      symbol: normalizeSymbol(payload.s),
      markPrice,
      eventTime,
      transactionTime: Number(payload.T || eventTime),
      receivedAt: Date.now()
    });
  }

  scheduleReconnect() {
    if (!this.running || !this.symbols.size || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, delay);
    Logger.warn('Mark Price WS 将重连', { delayMs: delay });
  }

  async disposeSocket(reason = 'DISPOSE') {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;

    // 关键：ws 仍处于 CONNECTING 时不能直接 close()。ws v8 会在握手尚未建立时
    // 异步发出 error('WebSocket was closed before the connection was established')，
    // 如果此时先 removeAllListeners()，error 事件会变成未捕获异常并直接杀掉 Electron 主进程。
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { ws.removeAllListeners(); } catch {}
    };
    const safeReason = String(reason || 'DISPOSE').slice(0, 123);
    try {
      // 在清理期间始终保留 error 监听器，避免任何异步 error 变成 uncaughtException。
      ws.once('error', () => {});
      ws.once('close', cleanup);
      const state = ws.readyState;
      if (state === WebSocket.CONNECTING) {
        // CONNECTING：直接 terminate，不调用 close。
        ws.terminate();
      } else if (state === WebSocket.OPEN) {
        ws.close(1000, safeReason);
      } else if (state === WebSocket.CLOSING) {
        // 已经在关闭，不再重复 close；等待 close 事件清理。
      } else {
        // CLOSED 或未知状态：立即清理。
        cleanup();
      }
    } catch (error) {
      Logger.warn('Mark Price WS 关闭过程异常，尝试 terminate', { error, reason: safeReason });
      try { ws.terminate(); } catch {}
      setImmediate(cleanup);
    }

    // 某些网络异常下 close 事件可能迟迟不到，避免 listener 残留。
    setTimeout(cleanup, 5000);
  }

  stop() {
    this.running = false;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectSerial++;
    void this.disposeSocket('STOP');
    this.emit('status', { connected: false, endpoint: this.baseUrl(), reason: 'STOP' });
  }
}

module.exports = MarkPriceStream;
