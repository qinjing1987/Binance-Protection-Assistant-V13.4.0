const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const EventEmitter = require('events');

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor() {
    super();
    this.readyState = FakeWebSocket.CONNECTING;
    this.closeCalls = 0;
    this.terminateCalls = 0;
  }
  close() {
    this.closeCalls++;
    if (this.readyState === FakeWebSocket.CONNECTING) {
      // 模拟 ws v8：握手未建立时 close 会异步产生 uncaught error 风险。
      queueMicrotask(() => this.emit('error', new Error('WebSocket was closed before the connection was established')));
      return;
    }
    this.readyState = FakeWebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close', 1000, Buffer.from(''));
    });
  }
  terminate() {
    this.terminateCalls++;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.emit('close', 1000, Buffer.from('')));
  }
  pong() {}
}

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'ws') return FakeWebSocket;
  return originalLoad.call(this, request, parent, isMain);
};
const MarkPriceStream = require('../server/binance/MarkPriceStream');
const UserDataStream = require('../server/binance/UserDataStream');
Module._load = originalLoad;

const config = { get: () => ({ binanceSandbox: false }) };

test('MarkPriceStream：CONNECTING 状态销毁必须 terminate，不能 close', async () => {
  const stream = new MarkPriceStream({ config });
  const ws = new FakeWebSocket();
  stream.ws = ws;
  await stream.disposeSocket('TEST_CONNECTING');
  assert.equal(ws.closeCalls, 0);
  assert.equal(ws.terminateCalls, 1);
  await new Promise(r => setImmediate(r));
  assert.equal(stream.ws, null);
});

test('MarkPriceStream：OPEN 状态销毁使用 close 且不会提前移除 error listener', async () => {
  const stream = new MarkPriceStream({ config });
  const ws = new FakeWebSocket();
  ws.readyState = FakeWebSocket.OPEN;
  stream.ws = ws;
  await stream.disposeSocket('TEST_OPEN');
  assert.equal(ws.closeCalls, 1);
  assert.equal(ws.terminateCalls, 0);
  await new Promise(r => setImmediate(r));
  assert.equal(ws.listenerCount('error'), 0);
});

test('UserDataStream：stop 不应在 dispose 前把 ws 引用置空', async () => {
  const binance = { config, rawRequest: async () => ({ listenKey: 'lk' }) };
  const stream = new UserDataStream(binance);
  const ws = new FakeWebSocket();
  ws.readyState = FakeWebSocket.CONNECTING;
  stream.ws = ws;
  stream.stop();
  await new Promise(r => setImmediate(r));
  assert.equal(ws.closeCalls, 0);
  assert.equal(ws.terminateCalls, 1);
});



test('MarkPriceStream：并发重连请求只允许最后一次建立新连接', async () => {
  const stream = new MarkPriceStream({ config });
  stream.running = true;
  stream.symbols = new Set(['BTCUSDT']);
  let connects = 0;
  stream.disposeSocket = async () => { await new Promise(r => setTimeout(r, 5)); };
  stream.connect = async () => { connects++; };
  await Promise.all([
    stream.reconnectNow('A'),
    stream.reconnectNow('B')
  ]);
  assert.equal(connects, 1);
});
