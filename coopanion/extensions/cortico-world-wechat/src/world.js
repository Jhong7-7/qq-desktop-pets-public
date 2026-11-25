import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { chat } from './brain.js';
import { SYSTEM_PROMPT, sanitizeReply, splitReply } from './prompt.js';
import { startWsServer } from './wsmin.js';

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WechatWorld {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = null;
    this.server = null;
    this.conn = null;
    this.ready = false;
    this.hello = null;
    this.seq = 0;
    this.pending = new Map();
    this.history = new Map();
    this.window = new Map();
    this.busy = new Map();
    this.apiKey = '';
    this.contextPath = join(ctx.dataDir || '.', 'wechat-context.json');
  }

  envPromptVars() {
    return {};
  }

  tools() {
    return [];
  }

  async start(host) {
    this.host = host;
    const cfg = this.ctx.cfg;
    this.apiKey = readSecret(this.ctx, cfg.provider?.secretName);
    await this.loadHistory();
    this.server = startWsServer({
      host: cfg.host || '0.0.0.0',
      port: Number(cfg.port) || 17900,
      log: host?.log,
      onConnection: (conn) => this.onConnection(conn),
    });
    log(host, 'info', 'wechat world 已启动', { port: cfg.port, rooms: cfg.rooms });
    if (!this.apiKey) log(host, 'warn', '缺少 DeepSeek 密钥，收到 @ 也无法回复');
  }

  async stop() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    this.pending.clear();
    try {
      this.conn?.close();
    } catch {
      /* ignore */
    }
    this.conn = null;
    this.ready = false;
    await new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    this.host = null;
  }

  // ---------------- WebSocket ----------------
  onConnection(conn) {
    if (this.conn && this.conn !== conn) {
      try {
        this.conn.close();
      } catch {
        /* ignore */
      }
    }
    this.conn = conn;
    this.ready = false;
    this.hello = setTimeout(() => {
      if (!this.ready) conn.close(1008, 'hello timeout');
    }, 5000);

    conn.on('message', (raw) => this.onFrame(raw));
    conn.on('close', () => {
      if (this.conn === conn) {
        this.conn = null;
        this.ready = false;
      }
    });
  }

  onFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.type === 'hello') return this.onHello(frame);
    if (!this.ready) return;
    switch (frame.type) {
      case 'msg':
        return this.onInbound(frame);
      case 'sent':
        return this.onSent(frame);
      case 'ping':
        return this.send({ v: 1, type: 'pong', ts: nowSec() });
      case 'pong':
        return;
      case 'status':
        log(this.host, 'info', 'bridge 状态', frame);
        return;
      default:
        return;
    }
  }

  onHello(frame) {
    const token = String(this.ctx.cfg.token || '');
    if (token && String(frame.token || '') !== token) {
      this.send({ v: 1, type: 'error', code: 'auth', message: 'token mismatch' });
      this.conn?.close(1008, 'auth');
      return;
    }
    clearTimeout(this.hello);
    this.hello = null;
    this.ready = true;
    this.send({ v: 1, type: 'welcome', ok: true, world: 'wechat', name: '友利奈绪' });
    log(this.host, 'info', 'bridge 已接入', { rooms: frame.rooms, self: frame.self });
  }

  onSent(frame) {
    const p = this.pending.get(frame.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(frame.id);
    p.resolve(Boolean(frame.ok));
  }

  send(obj) {
    if (!this.conn || !this.ready) return false;
    try {
      this.conn.send(obj);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------- 入站 ----------------
  onInbound(frame) {
    const cfg = this.ctx.cfg;
    const room = String(frame.room || '').trim();
    const text = String(frame.text || '').trim();
    const sender = String(frame.sender || '未知').trim();
    if (!room || !sender) return;
    if (Array.isArray(cfg.rooms) && cfg.rooms.length && !cfg.rooms.includes(room)) return;

    const line = `${sender}: ${text || '（@了你，没说话）'}`;
    this.pushHistory(room, { role: 'user', content: line });

    if (frame.at_me) {
      const prev = this.busy.get(room) || Promise.resolve();
      const next = prev
        .then(() => this.reply(room, sender, line))
        .catch((err) => log(this.host, 'warn', '回复失败', { err: String(err) }))
        .finally(() => {
          if (this.busy.get(room) === next) this.busy.delete(room);
        });
      this.busy.set(room, next);
    } else {
      void this.saveHistory();
    }
  }

  // ---------------- 回复 ----------------
  async reply(room, sender, line) {
    const cfg = this.ctx.cfg;
    if (!this.apiKey) {
      log(this.host, 'warn', '没有密钥，跳过回复', { room });
      return;
    }
    if (this.limited(room)) {
      log(this.host, 'warn', '触发本群频率上限，跳过', { room });
      return;
    }
    const turns = Math.max(2, Number(cfg.context?.maxTurns) || 12) * 2;
    const history = this.history.get(room) || [];
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history.slice(-turns)];
    const raw = await chat({
      baseUrl: cfg.provider?.baseUrl,
      apiKey: this.apiKey,
      model: cfg.provider?.model,
      messages,
      temperature: cfg.provider?.temperature,
      maxTokens: cfg.provider?.maxTokens,
      timeoutMs: cfg.provider?.timeoutMs,
      log: this.host?.log,
    });
    const text = sanitizeReply(raw);
    if (!text) return;

    const maxParts = Math.max(1, Number(cfg.limits?.maxSendsPerReply) || 3);
    const parts = splitReply(text, 60).slice(0, maxParts);
    for (let i = 0; i < parts.length; i += 1) {
      const ok = await this.sendChunk(room, parts[i], i === 0 ? sender : null);
      log(this.host, 'info', '已发送', { room, ok, text: parts[i] });
      if (!ok) break;
      if (i + 1 < parts.length) await sleep(Number(cfg.limits?.sendIntervalMs) || 1500);
    }
    this.pushHistory(room, { role: 'assistant', content: text });
    await this.saveHistory();
  }

  sendChunk(room, text, at) {
    const id = `s-${++this.seq}`;
    return new Promise((resolve) => {
      if (!this.send({ v: 1, type: 'send', id, room, text, at, reply_to: null })) {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, 30000);
      this.pending.set(id, { resolve, timer });
    });
  }

  limited(room) {
    const cfg = this.ctx.cfg;
    const max = Number(cfg.limits?.roomMaxPerWindow) || 6;
    const span = Number(cfg.limits?.roomWindowSec) || 60;
    const now = nowSec();
    const list = (this.window.get(room) || []).filter((t) => now - t < span);
    list.push(now);
    this.window.set(room, list);
    return list.length > max;
  }

  // ---------------- 上下文 ----------------
  pushHistory(room, turn) {
    const cfg = this.ctx.cfg;
    const keep = Math.max(2, Number(cfg.context?.maxTurns) || 12) * 2;
    const list = this.history.get(room) || [];
    list.push(turn);
    this.history.set(room, list.slice(-keep));
  }

  async loadHistory() {
    try {
      const raw = await readFile(this.contextPath, 'utf8');
      const data = JSON.parse(raw);
      for (const [room, turns] of Object.entries(data || {})) {
        if (Array.isArray(turns)) this.history.set(room, turns.slice(-40));
      }
    } catch {
      /* 首次运行没有文件 */
    }
  }

  async saveHistory() {
    try {
      await mkdir(dirname(this.contextPath), { recursive: true });
      const data = Object.fromEntries(this.history);
      await writeFile(this.contextPath + '.tmp', JSON.stringify(data), 'utf8');
      await writeFile(this.contextPath, JSON.stringify(data), 'utf8');
    } catch (err) {
      log(this.host, 'warn', '保存上下文失败', { err: String(err) });
    }
  }
}

function readSecret(ctx, name) {
  try {
    return ctx.secret(String(name || 'DEEPSEEK_API_KEY')) || '';
  } catch {
    return '';
  }
}

function log(host, level, msg, extra) {
  const fn = host?.log?.[level];
  if (typeof fn === 'function') fn.call(host.log, msg, extra);
}
