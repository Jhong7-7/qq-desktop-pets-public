#!/usr/bin/env node
/**
 * douyin-plugin-bridge.mjs — 让 QQ 桥复用 DSH 插件那一个抖音浏览器。
 *
 * 问题（2026-11-24）：插件和桥各 pw.chromium.launch() 了一个抖音窗口，
 * 两个独立的推荐流游标。她在 DSH 里说"这个好搞笑"（看的是 A），
 * 桥这边每 20 秒自己翻页抓图（发的可能是 B）——于是"他看不到我看到的画面"。
 *
 * 做法：插件在本机 Web 端口上挂 /dsh-douyin/*，并把 {origin, token} 写进
 * endpoint.json；桥启动抖音时先找这个文件 + 探活，找到就整套代理过去。
 * 找不到（插件没装/没启用/宿主没 webServer）才退回桥自己开浏览器，行为不变。
 *
 * 只用全局 fetch，不引依赖。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const ROUTE_SEGMENT = '/dsh-douyin';

/** 端点文件的候选位置：显式配置 > 桥目录 > DSH home 下的插件目录。 */
export function endpointCandidates({ cfg = {}, bridgeDir = '', dshHome = '' } = {}) {
  const out = [];
  const explicit = String(cfg.pluginEndpointFile ?? '').trim();
  if (explicit) out.push(explicit.startsWith('/') || /^[A-Za-z]:[\\/]/.test(explicit) ? explicit : join(bridgeDir, explicit));
  if (bridgeDir) out.push(join(bridgeDir, 'endpoint.json'));
  const home = dshHome || process.env.DSH_HOME || join(homedir(), '.dsh');
  out.push(join(home, 'dsh-douyin', 'endpoint.json'));
  return [...new Set(out.filter(Boolean))];
}

function readEndpointFile(file) {
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const origin = String(j?.origin ?? '').replace(/\/$/, '');
    const token = String(j?.token ?? '');
    if (!origin || !token) return null;
    return { origin, token, pid: Number(j.pid) || 0, version: String(j.version ?? ''), file };
  } catch {
    return null;
  }
}

/** 找到活着的插件端点；找不到返回 null（桥照旧自己开浏览器）。 */
export async function resolvePluginEndpoint({
  cfg = {}, bridgeDir = '', dshHome = '', log = () => {}, timeoutMs = 800, fetchImpl = fetch,
} = {}) {
  for (const file of endpointCandidates({ cfg, bridgeDir, dshHome })) {
    const ep = readEndpointFile(file);
    if (!ep) continue;
    try {
      // 用带 token 的 /status 探活：既证明它活着，也证明这个 token 还没失效
      //（插件重载会换 token，旧 endpoint.json 会留在原地，不能只看 /health）。
      const res = await fetchImpl(`${ep.origin}${ROUTE_SEGMENT}/status?token=${encodeURIComponent(ep.token)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const body = await res.json().catch(() => ({}));
      if (!body?.ok) continue;
      log(`抖音：找到 DSH 插件端点 ${ep.origin}（v${ep.version ?? '?'}，登录=${body.loggedIn ? '是' : '否'}）`);
      return { ...ep, pluginVersion: String(ep.version ?? ''), loggedIn: Boolean(body.loggedIn) };
    } catch {
      log(`抖音：端点文件 ${file} 探活失败，跳过`);
    }
  }
  return null;
}

/** 把插件端点包成和 createDouyinBrowser 同形的对象。 */
export function createProxyBrowser(endpoint, { log = () => {}, fetchImpl = fetch } = {}) {
  const origin = String(endpoint.origin).replace(/\/$/, '');
  const token = String(endpoint.token);

  async function call(path, { method = 'GET', body, timeoutMs = 20_000 } = {}) {
    const url = `${origin}${ROUTE_SEGMENT}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
    const res = await fetchImpl(url, {
      method,
      headers: {
        'x-douyin-token': token,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `插件端点 ${res.status}` };
    return res.json().catch(() => ({ ok: false, reason: '端点返回的不是 JSON' }));
  }

  return {
    kind: 'proxy',
    endpoint: origin,

    async open() {
      const r = await call('/open', { method: 'POST', timeoutMs: 200_000 }).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
      if (r?.ok === false) return r;
      return { ok: true, needLogin: r?.loggedIn === false };
    },

    async isLoggedIn() {
      const r = await call('/status').catch(() => null);
      return Boolean(r?.loggedIn);
    },

    async next() {
      const r = await call('/next', { method: 'POST' }).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
      return r?.ok === false ? r : { ok: true };
    },

    async capture() {
      const r = await call('/capture', { timeoutMs: 60_000 }).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
      if (!r?.ok) return { ok: false, reason: String(r?.reason ?? '插件抓帧失败') };
      return {
        ok: true,
        jpeg: String(r.jpeg ?? ''),
        text: String(r.text ?? ''),
        shotPath: String(r.shotPath ?? ''),
        kept: Number(r.kept) || 1,
        contentKey: String(r.contentKey ?? ''),
        at: Number(r.at) || Date.now(),
        seenBefore: Boolean(r.seenBefore),
        source: String(r.source ?? 'capture'),
      };
    },

    /** 优先拿"她刚看到的那一帧"：共看推过去的就是她眼里的画面。 */
    async lastFrame(maxAgeMs = 90_000) {
      const r = await call(`/last-frame?maxAgeMs=${Math.max(0, Math.floor(maxAgeMs))}`).catch(() => null);
      if (!r?.ok) return null;
      return {
        ok: true,
        jpeg: String(r.jpeg ?? ''),
        text: String(r.text ?? ''),
        shotPath: String(r.shotPath ?? ''),
        kept: Number(r.kept) || 1,
        contentKey: String(r.contentKey ?? ''),
        at: Number(r.at) || 0,
      };
    },

    async focus(onScreen = true) {
      const r = await call('/focus', { method: 'POST', body: { on: Boolean(onScreen) } }).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
      return r?.ok === false ? r : { ok: true };
    },

    async like() {
      const r = await call('/like', { method: 'POST' }).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
      return r?.ok === false ? r : { ok: true };
    },

    /** 插件没有发动态能力：明确拒绝，别让桥上层的 [发:...] 假成功。 */
    async post() {
      return { ok: false, reason: '插件侧没有发动态能力，这条先别发' };
    },

    async comment(text, mention = false) {
      const r = await call('/send-comment', { method: 'POST', body: { text: String(text), mention: Boolean(mention) }, timeoutMs: 60_000 }).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
      if (!r) return { ok: false, reason: '插件端点无响应' };
      return { ok: Boolean(r.ok), reason: String(r.reason ?? ''), mention: Boolean(mention), mentionNote: String(r.mentionNote ?? '') };
    },

    async close() {
      // 插件侧是共享浏览器：桥"停抖音"就真的收掉，她下次用工具会自己重开。
      await call('/close', { method: 'POST', timeoutMs: 6000 }).catch(() => {});
    },
  };
}
