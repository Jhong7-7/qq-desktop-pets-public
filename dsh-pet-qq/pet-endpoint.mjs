#!/usr/bin/env node
/**
 * 桌宠 HTTP 端点发现（pet-endpoint.mjs）
 *
 * 背景：dsh-pet 的路由挂在 DSH 宿主分配的 ctx.webServer.port 上。
 * DSH 每次重启都会重新分配这个端口（实测 1882 → 8726），
 * 桥里写死 baseUrl 就会在重启后一直 fetch failed，直到人手改配置。
 *
 * 做法：启动时、以及 /chat 调用失败时，从本机 LISTENING 端口里
 * 找出真正挂了 /dsh-pet-7340/state 的那一个，自动切过去。
 * 探针只发无害的 GET，且严格校验响应体（必须带 counter / sections），
 * 不会把别的服务误当成桌宠。
 */
import { execFileSync } from 'node:child_process';

const normalize = (s) => String(s ?? '').replace(/\/+$/, '');

/** 用 netstat 取本机所有 TCP LISTENING 端口（不依赖进程名，也不依赖系统语言）。 */
function listeningPorts() {
  if (process.platform !== 'win32') return [];
  let raw;
  try {
    raw = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      timeout: 6000,
      windowsHide: true,
    });
  } catch {
    return [];
  }
  // 中文版 netstat 的状态词可能不是 LISTENING，匹配不到就放宽为「只要是 TCP 行」
  const strict = /LISTENING|LISTEN|监听/i.test(raw);
  const ports = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)\s+\S+\s+(\S+)/i);
    if (!m) continue;
    if (strict && !/LISTENING|LISTEN|监听/i.test(m[2])) continue;
    const port = Number(m[1]);
    if (port > 1024 && port < 65536) ports.add(port);
  }
  return [...ports];
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl      配置里的首选地址
 * @param {string[]} opts.baseUrls   额外候选地址（按优先级）
 * @param {string} opts.route        桌宠路由前缀，如 /dsh-pet-7340
 * @param {string} opts.petId
 * @param {string} opts.surface
 * @param {boolean} opts.autoDiscover 关闭后只用静态候选
 * @param {(msg: string) => void} opts.log
 */
export function createPetEndpoint(opts) {
  const {
    baseUrl = 'http://127.0.0.1:1882',
    baseUrls = [],
    route = '/dsh-pet-7340',
    petId = 'main',
    surface = 'any',
    autoDiscover = true,
    probeTimeoutMs = 1500,
    log = () => {},
  } = opts;

  let base = normalize(baseUrl);
  let lastProbeAt = 0;
  let probing = null;

  const chatUrl = () =>
    `${base}${route}/chat?pet=${encodeURIComponent(petId)}&surface=${encodeURIComponent(surface)}`;
  const stateUrl = () => `${base}${route}/state`;

  function candidates() {
    const list = [base, ...baseUrls.map(normalize)];
    if (autoDiscover) {
      for (const port of listeningPorts()) list.push(`http://127.0.0.1:${port}`);
    }
    return [...new Set(list.filter(Boolean))];
  }

  async function probeOne(candidate) {
    try {
      const res = await fetch(`${candidate}${route}/state`, {
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (!res.ok) return null;
      const json = await res.json();
      if (!json || typeof json !== 'object') return null;
      // dsh-pet 的 /state 特征：{ counter, sections: {...} }
      if (!('counter' in json) && !('sections' in json)) return null;
      return candidate;
    } catch {
      return null;
    }
  }

  async function doResolve() {
    const list = candidates();
    const results = await Promise.all(list.map(probeOne));
    const hit = results.find(Boolean); // 按候选顺序取第一个成功的：当前地址优先
    if (hit) {
      if (hit !== base) log(`桌宠端点自动切换：${base} → ${hit}（DSH 重启后端口漂移）`);
      base = hit;
      return true;
    }
    log(`桌宠端点发现失败：${list.length} 个候选里没有 ${route}/state（DSH 或 dsh-pet 没起来？）`);
    return false;
  }

  /** force=true 用于「刚失败过」或自检；10 秒内不重复探测。 */
  async function resolve(force = false) {
    const now = Date.now();
    if (!force && now - lastProbeAt < 10_000) return base;
    if (probing) {
      await probing;
      return base;
    }
    lastProbeAt = now;
    probing = doResolve().finally(() => {
      probing = null;
    });
    await probing;
    return base;
  }

  return {
    get base() {
      return base;
    },
    chatUrl,
    stateUrl,
    resolve,
    /** 给离线测试用 */
    _candidates: candidates,
  };
}
