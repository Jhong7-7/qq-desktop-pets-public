/**
 * 执行器 B：走桌面版 WorkBuddy 自带的本地 agent 服务。
 *
 * 为什么需要它：CLI 独立进程拿不到登录态（accessToken 只在桌面版进程内存里），
 * 而桌面版拉起的 `codebuddy --serve --port 0` 继承了登录态，可以直接派活。
 *
 * 代价：端口每次启动都变、密码要从进程环境读，所以这里做了自动发现与缓存。
 *
 * 只用 node: 内置模块。
 */
import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';

export interface GatewayOptions {
  prompt: string;
  /** 已知端口；0 或空 = 自动发现 */
  port?: number;
  /** 已知密码；空 = 从桌面版进程环境读 */
  password?: string;
  /** 读环境变量用的 python 解释器 */
  pythonPath?: string;
  /** read_env.py 的路径 */
  envScript?: string;
  /** 单次任务上限 */
  timeoutMs: number;
  maxOutputChars: number;
}

export interface GatewayResult {
  ok: boolean;
  text: string;
  ms: number;
  hint?: string;
  /** 本次实际使用的端口，便于排查 */
  port?: number;
}

interface Resolved {
  port: number;
  password: string;
}

/** 发现结果缓存：端口和密码在一段时间内不会变，避免每个任务都查进程。 */
let cache: { value: Resolved; ts: number } | null = null;
const CACHE_TTL_MS = 60_000;

export function resetGatewayCache(): void {
  cache = null;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…（后面还有 ${t.length - max} 字，已截断）`;
}

function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ out: string; ok: boolean }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve({ out: String(stdout ?? ''), ok: !err }),
    );
  });
}

/** 列出桌面版拉起的所有 `codebuddy --serve` 进程 PID。 */
async function findServePids(): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'WorkBuddy.exe\'" | '
    + 'Where-Object { $_.CommandLine -like \'*codebuddy*\' -and $_.CommandLine -like \'*--serve*\' } | '
    + 'ForEach-Object { $_.ProcessId }';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  return r.out
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** 查某个 PID 在本地监听的端口。 */
async function listeningPort(pid: number): Promise<number | null> {
  const r = await run('netstat', ['-ano'], 20_000);
  for (const line of r.out.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    if (Number(cols[cols.length - 1]) !== pid) continue;
    const addr = cols[1] ?? '';
    if (!addr.startsWith('127.0.0.1:')) continue;
    const port = Number(addr.slice(addr.lastIndexOf(':') + 1));
    if (Number.isInteger(port) && port > 0) return port;
  }
  return null;
}

/** 从目标进程的环境变量里读出 gateway 密码。 */
async function readPassword(pid: number, pythonPath: string, envScript: string): Promise<string> {
  const r = await run(pythonPath, [envScript, String(pid), '--raw'], 20_000);
  if (!r.ok) return '';
  const m = r.out.match(/^CODEBUDDY_GATEWAY_PASSWORD=(.+)$/m);
  return m ? m[1].trim() : '';
}

function getJson(port: number, path: string, password: string, timeoutMs = 6000): Promise<any> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Authorization: `Bearer ${password}` }, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** 依次试候选 PID，第一个 health 通的就用它。 */
async function discover(opts: GatewayOptions): Promise<Resolved | null> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.value;

  const pids = await findServePids();
  for (const pid of pids) {
    const port = await listeningPort(pid);
    if (!port) continue;

    let pwd = opts.password?.trim() ?? '';
    if (!pwd && opts.pythonPath && opts.envScript) {
      pwd = await readPassword(pid, opts.pythonPath, opts.envScript);
    }
    if (!pwd) continue;

    const health = await getJson(port, '/api/v1/health', pwd);
    if (!health?.data?.status) continue;

    const value = { port, password: pwd };
    cache = { value, ts: Date.now() };
    return value;
  }
  return null;
}

function postRun(port: number, password: string, prompt: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      id: `wbtask-${Date.now()}`,
      type: 'run',
      payload: { text: prompt },
    });
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/runs',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${password}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            const o = JSON.parse(raw);
            resolve(o?.data?.runId ?? null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/** 订阅 SSE，一直读到任务结束或超时。 */
function readStream(port: number, password: string, runId: string, timeoutMs: number): Promise<{ text: string; done: boolean }> {
  return new Promise((resolve) => {
    let buf = '';
    let final = '';
    const chunks: string[] = [];
    let settled = false;

    const finish = (done: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req.destroy(); } catch { /* 已结束 */ }
      resolve({ text: final || chunks.join(''), done });
    };

    const handle = (block: string) => {
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (!data) return;
      let o: any;
      try {
        o = JSON.parse(data);
      } catch {
        return;
      }
      const status = String(o?.status ?? '');
      const markdown = o?.content?.markdown;
      const delta = o?.delta?.text ?? o?.text;
      if (typeof markdown === 'string' && markdown.trim()) final = markdown;
      else if (typeof delta === 'string' && delta.trim()) chunks.push(delta);
      if (status === 'completed' || status === 'failed' || status === 'cancelled') finish(true);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1/runs/${encodeURIComponent(runId)}/stream`,
        method: 'GET',
        headers: { Authorization: `Bearer ${password}`, Accept: 'text/event-stream' },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(false);
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          buf += c;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            handle(block);
          }
        });
        res.on('end', () => finish(true));
        res.on('error', () => finish(false));
      },
    );
    req.on('error', () => finish(false));
    req.on('timeout', () => finish(false));
    req.end();
  });
}

function isQuotaError(text: string): boolean {
  return /429|频率限制|使用量已超出|rate limit/i.test(text);
}

/** 派一个任务给桌面版服务，等结果。不 reject。 */
export async function runViaGateway(opts: GatewayOptions): Promise<GatewayResult> {
  const started = Date.now();
  const target = await discover(opts);
  if (!target) {
    return {
      ok: false,
      text: '',
      ms: Date.now() - started,
      hint: '找不到桌面版 WorkBuddy 的本地服务：确认 WorkBuddy 客户端在运行，且 worlds.wbtask.gateway.password 有值或 python 路径正确。',
    };
  }

  const runId = await postRun(target.port, target.password, opts.prompt, 30_000);
  if (!runId) {
    return {
      ok: false,
      text: '',
      ms: Date.now() - started,
      hint: `已连上本地服务（端口 ${target.port}）但派任务被拒：检查口令是否正确，或服务是否忙于别的任务。`,
      port: target.port,
    };
  }

  // 任务一旦完成 run 就会被清理，所以必须紧接着订阅，不能等
  const { text, done } = await readStream(target.port, target.password, runId, opts.timeoutMs);
  const ms = Date.now() - started;
  const clean = clip(text, opts.maxOutputChars);

  if (!clean) {
    return {
      ok: false,
      text: done ? '它没有输出任何内容。' : '超时了，没等到结果。',
      ms,
      hint: done ? undefined : '可以把 worlds.wbtask.timeoutSec 调大。',
      port: target.port,
    };
  }

  if (isQuotaError(clean)) {
    return {
      ok: false,
      text: clean,
      ms,
      hint: 'WorkBuddy 账号额度用完了，等配额重置或换账号；这不是通道故障。',
      port: target.port,
    };
  }

  return { ok: true, text: clean, ms, port: target.port };
}
