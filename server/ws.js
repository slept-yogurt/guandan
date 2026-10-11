'use strict';

/**
 * 零依赖的 WebSocket 服务端（RFC 6455 子集）。
 *
 * 加固点：
 *  - 分片重组按"累计总量"限流（只卡单帧挡不住几千个小分片）
 *  - 控制帧不可分片、负载 ≤ 125 字节（否则是现成的放大攻击）
 *  - 客户端帧必须带掩码、RSV 必须为 0，违规直接 1002
 *  - 连接数上限
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class Conn extends EventEmitter {
  constructor(socket, opts) {
    super();
    opts = opts || {};
    this.socket = socket;
    this.closed = false;
    this.buf = Buffer.alloc(0);
    this.fragOp = 0;
    this.fragLen = 0;
    this.fragChunks = [];
    this.maxMessage = opts.maxMessage || 256 * 1024;
    this.isAlive = true;

    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.on('data', d => this._onData(d));
    socket.on('close', () => this._destroy());
    socket.on('error', () => this._destroy());
  }

  _destroy() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (e) { /* ignore */ }
    this.emit('close');
  }

  _fail(code, reason) {
    if (this.closed) return;
    this.close(code, String(reason || '').slice(0, 100));
  }

  close(code, reason) {
    if (this.closed) return;
    const text = Buffer.from(String(reason || ''), 'utf8');
    const payload = Buffer.alloc(2 + Math.min(text.length, 123));
    payload.writeUInt16BE(code || 1000, 0);
    text.copy(payload, 2, 0, Math.min(text.length, 123));
    try { this.socket.write(encodeFrame(OP.CLOSE, payload)); } catch (e) { /* ignore */ }
    this._destroy();
  }

  send(data) {
    if (this.closed) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    try {
      this.socket.write(encodeFrame(Buffer.isBuffer(data) ? OP.BIN : OP.TEXT, payload));
      return true;
    } catch (e) {
      this._destroy();
      return false;
    }
  }

  ping() {
    if (this.closed) return;
    this.isAlive = false;
    try { this.socket.write(encodeFrame(OP.PING, Buffer.alloc(0))); } catch (e) { this._destroy(); }
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      this._parse();
    } catch (e) {
      this._fail(1002, '协议错误');
    }
  }

  _parse() {
    for (;;) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let p = 2;

      if (rsv !== 0) return this._fail(1002, 'RSV 必须为 0');
      if (!masked) return this._fail(1002, '客户端帧必须加掩码');
      if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) return this._fail(1002, '未知 opcode');

      const control = opcode >= 0x8;
      if (control && !fin) return this._fail(1002, '控制帧不能分片');

      if (len === 126) {
        if (buf.length < p + 2) return;
        len = buf.readUInt16BE(p); p += 2;
      } else if (len === 127) {
        if (buf.length < p + 8) return;
        const hi = buf.readUInt32BE(p);
        const lo = buf.readUInt32BE(p + 4);
        if (hi !== 0) return this._fail(1009, '负载过大');
        len = lo; p += 8;
      }
      if (control && len > 125) return this._fail(1002, '控制帧负载超限');
      if (len > this.maxMessage) return this._fail(1009, '负载过大');

      if (buf.length < p + 4) return;
      const mask = buf.subarray(p, p + 4); p += 4;
      if (buf.length < p + len) return;

      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[p + i] ^ mask[i & 3];
      p += len;
      this.buf = buf.subarray(p);

      if (control) {
        if (opcode === OP.PING) this.send(encodeFrame(OP.PONG, payload));
        else if (opcode === OP.PONG) this.isAlive = true;
        else if (opcode === OP.CLOSE) this._destroy();
        continue;
      }

      if (opcode === OP.CONT) {
        if (!this.fragOp) return this._fail(1002, '没有待续的分片');
        this.fragChunks.push(payload);
        this.fragLen += payload.length;
        if (this.fragLen > this.maxMessage) return this._fail(1009, '分片总量超限');
        if (fin) this._finishFrag();
      } else {
        if (this.fragOp) return this._fail(1002, '分片未结束又收到新帧');
        if (fin) this._emitMessage(opcode, payload);
        else {
          this.fragOp = opcode;
          this.fragChunks = [payload];
          this.fragLen = payload.length;
        }
      }
    }
  }

  _finishFrag() {
    const op = this.fragOp;
    const data = Buffer.concat(this.fragChunks);
    this.fragOp = 0; this.fragChunks = []; this.fragLen = 0;
    this._emitMessage(op, data);
  }

  _emitMessage(opcode, payload) {
    if (opcode === OP.TEXT) this.emit('message', payload.toString('utf8'));
    else this.emit('binary', payload);
  }
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

class WSServer extends EventEmitter {
  constructor(httpServer, opts) {
    super();
    opts = opts || {};
    this.opts = opts;
    this.maxConnections = opts.maxConnections || 500;
    this.clients = new Set();
    this.httpServer = httpServer;
    httpServer.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));
  }

  _upgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (upgrade !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (this.clients.size >= this.maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );

    const conn = new Conn(socket, this.opts);
    if (head && head.length) conn._onData(head);
    this.clients.add(conn);
    conn.on('close', () => this.clients.delete(conn));
    this.emit('connection', conn, req);
  }

  closeAll() {
    for (const c of [...this.clients]) c.close(1001, 'server shutdown');
  }
}

module.exports = { WSServer, Conn, encodeFrame, OP };
