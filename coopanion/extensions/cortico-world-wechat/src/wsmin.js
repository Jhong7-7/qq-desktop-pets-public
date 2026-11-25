// 极简 WebSocket 服务端：只支持文本帧、ping/pong、close。
// 目的：不引入 ws 依赖，扩展免 pnpm 安装（加 junction 即可）。
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 4 * 1024 * 1024;

class Conn {
  constructor(socket, log) {
    this.socket = socket;
    this.log = log;
    this.buf = Buffer.alloc(0);
    this.frag = Buffer.alloc(0);
    this.alive = true;
    this.handlers = { message: [], close: [] };
    socket.on('data', (chunk) => this.#append(chunk));
    socket.on('error', () => this.#closed());
    socket.on('close', () => this.#closed());
  }

  on(event, fn) {
    this.handlers[event]?.push(fn);
    return this;
  }

  #emit(event, arg) {
    for (const fn of this.handlers[event] || []) {
      try {
        fn(arg);
      } catch (err) {
        this.log?.warn?.('ws handler failed', { err: String(err) });
      }
    }
  }

  #append(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.#parse();
  }

  #parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) return this.close(1009);
        len = Number(big);
        off = 10;
      }
      if (len > MAX_FRAME) return this.close(1009);
      let key;
      if (masked) {
        if (this.buf.length < off + 4) return;
        key = this.buf.subarray(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= key[i & 3];
      }
      this.buf = this.buf.subarray(off + len);
      this.#frame(fin, opcode, payload);
    }
  }

  #frame(fin, opcode, payload) {
    if (opcode === 0x8) return this.#closed(true);
    if (opcode === 0x9) return this.#send(0xa, payload);
    if (opcode === 0xa) return;
    if (opcode === 0x0) {
      this.frag = Buffer.concat([this.frag, payload]);
      if (fin) {
        const data = this.frag;
        this.frag = Buffer.alloc(0);
        this.#emit('message', data.toString('utf8'));
      }
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) return this.#emit('message', payload.toString('utf8'));
      this.frag = payload;
    }
  }

  #send(opcode, payload) {
    if (!this.alive) return;
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([head, payload]));
    } catch {
      this.#closed();
    }
  }

  send(obj) {
    this.#send(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (!this.alive) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.#send(0x8, body);
    this.#closed();
  }

  #closed(fromPeer = false) {
    if (!this.alive) return;
    this.alive = false;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    if (!fromPeer) this.#emit('close');
    else this.#emit('close');
  }
}

export function startWsServer({ host, port, log, onConnection }) {
  const server = createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('WebSocket only');
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(String(key) + GUID).digest('base64');
    socket.setNoDelay(true);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const conn = new Conn(socket, log);
    onConnection(conn);
  });
  server.on('error', (err) => log?.error?.('ws server error', { err: String(err) }));
  server.listen(port, host);
  return server;
}
