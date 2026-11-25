/**
 * task-notify.mjs —— 方案①的「回报通道」：独立进程，把 tasks/out 里未回报的结果发回 QQ。
 *
 * 复用本轮已验证的旁路发送法：独立连 OneBot 3011 WS（Bearer），只发不收，
 * 发完即断开，不经过 bridge.mjs 本体 → 不中断溪颜正常聊天。
 *
 * 用法：
 *   node task-notify.mjs --list              列出待回报结果（只读，不发送）
 *   node task-notify.mjs --dry-run           预览将发什么（默认，不真发）
 *   node task-notify.mjs --send              真正发送，并把已发的标记 notified
 *   node task-notify.mjs --send --id <id>    只发指定 id
 *
 * 安全：默认 dry-run；--send 也要先过 config.onebot 的账号校验（expectSelfId）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createTaskQueue, reportText } from './task-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const CONFIG_PATH = (() => {
  const i = argv.indexOf('--config');
  const raw = i >= 0 ? argv[i + 1] : 'config.json';
  return isAbsolute(raw) ? raw : join(HERE, raw);
})();
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const TASK_CFG = CONFIG.task ?? {};
const queue = createTaskQueue({ root: HERE, cfg: TASK_CFG });

function loadWebSocket() {
  const anchors = [CONFIG.onebot?.wsModuleAnchor].filter(Boolean);
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor);
      const mod = req('ws');
      const ctor = mod?.WebSocket ?? mod?.default ?? mod;
      if (typeof ctor === 'function') return { ctor, headers: true };
    } catch { /* 往下 */ }
  }
  try {
    const req = createRequire(import.meta.url);
    const mod = req('ws');
    const ctor = mod?.WebSocket ?? mod?.default ?? mod;
    if (typeof ctor === 'function') return { ctor, headers: true };
  } catch { /* 往下 */ }
  if (typeof WebSocket !== 'undefined') return { ctor: WebSocket, headers: false };
  throw new Error('找不到可用的 WebSocket 实现');
}

async function sendOne({ ctor, headers }, text, timeoutMs = 10000) {
  const base = String(CONFIG.onebot.wsUrl);
  const token = CONFIG.onebot.token ?? '';
  const url = (headers || !token) ? base : base + (base.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(token)}`;
  return new Promise((resolve, reject) => {
    let ws;
    let done = false;
    const finish = (ok, msg) => { if (done) return; done = true; try { ws?.close(); } catch {} ok ? resolve(msg) : reject(new Error(msg)); };
    const timer = setTimeout(() => finish(false, 'WS 超时'), timeoutMs);
    try {
      const opts = headers && token ? { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: timeoutMs } : undefined;
      ws = opts ? new ctor(url, opts) : new ctor(url);
    } catch (e) { clearTimeout(timer); return reject(e); }
    ws.onopen = () => {
      const echo = `tasknotify-${Date.now()}`;
      ws.send(JSON.stringify({
        action: 'send_private_msg',
        params: { user_id: 10000, message: text },
        echo,
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data ?? ev));
        if (msg.echo && String(msg.echo).startsWith('tasknotify-')) {
          clearTimeout(timer);
          finish(msg.retcode === 0, `retcode=${msg.retcode}`);
        }
      } catch { /* 忽略非回执 */ }
    };
    ws.onerror = (e) => { clearTimeout(timer); finish(false, 'WS 错误：' + (e?.message ?? 'unknown')); };
  });
}

async function main() {
  const doSend = argv.includes('--send');
  const idArg = argv.indexOf('--id');
  const onlyId = idArg >= 0 ? argv[idArg + 1] : undefined;
  let items = queue.pendingReports();
  if (onlyId) items = items.filter((r) => String(r.id) === String(onlyId));

  if (argv.includes('--list') || (!doSend && !argv.includes('--dry-run'))) {
    console.log(`待回报 ${items.length} 条：`);
    for (const r of items) console.log(`  ${r.id} | ${r.status} | ${String(r.result).slice(0, 60)}`);
    return;
  }
  if (items.length === 0) { console.log('没有待回报的结果'); return; }

  const preview = items.map((r) => ({ id: r.id, text: reportText(r, TASK_CFG) }));
  if (!doSend) {
    console.log('dry-run，以下为预览（未发送）：');
    for (const p of preview) console.log(`  ${p.id} → ${p.text}`);
    return;
  }

  const ws = loadWebSocket();
  let okCount = 0;
  for (const p of preview) {
    try {
      const res = await sendOne(ws, p.text);
      queue.markNotified(p.id);
      okCount += 1;
      console.log(`已回报 ${p.id}（${res}）`);
    } catch (e) {
      console.log(`回报失败 ${p.id}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`完成：${okCount}/${preview.length} 条已发送并标记`);
}

await main();
