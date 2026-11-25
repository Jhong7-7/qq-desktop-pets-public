/**
 * 执行器：把一句话交给 WorkBuddy 的 codebuddy CLI（无头模式），把结果收回来。
 *
 * 只用 node: 内置模块，不引第三方依赖——world 是独立包，装进别人机器上也不该多一层 node_modules。
 */
import { spawn } from 'node:child_process';

export interface RunOptions {
  nodePath: string;
  cliEntry: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  skipPermissions?: boolean;
  extraArgs?: string[];
  /** 额外注入给 CLI 的环境变量（如 CODEBUDDY_API_KEY），覆盖继承值 */
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputChars: number;
}

export interface RunResult {
  ok: boolean;
  /** 给模型看的文本，已截断 */
  text: string;
  /** 原始退出码；超时被杀时为 null */
  code: number | null;
  timedOut: boolean;
  ms: number;
  /** CLI 自己的错误行（如未登录），便于排查 */
  hint?: string;
}

/** Windows 上 kill 只杀父进程，CLI 会留下孙进程；用 taskkill /T 整棵树带走。 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 进程可能已经没了，忽略 */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 同上 */
    }
  }
}

/** CLI 的 --output-format json 偶尔会被启动日志污染，尽量把最后一个 JSON 对象捞出来。 */
function parseJsonOutput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const o = JSON.parse(trimmed);
    return pickResult(o);
  } catch {
    /* 继续尝试局部解析 */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return pickResult(JSON.parse(trimmed.slice(start, end + 1)));
    } catch {
      return null;
    }
  }
  return null;
}

function pickResult(o: unknown): string | null {
  // 指定 --model 时 CLI 会输出事件数组，真正的答案在最后一条 type=result 里
  if (Array.isArray(o)) {
    const items = o as unknown[];
    for (let i = items.length - 1; i >= 0; i--) {
      const rec = items[i] as Record<string, unknown> | null;
      if (!rec || typeof rec !== 'object' || rec.type !== 'result') continue;
      const r = rec.result;
      if (typeof r === 'string' && r.trim()) return r;
      break;
    }
    // 没有 result 项时，退回最后一条 assistant 文本
    for (let i = items.length - 1; i >= 0; i--) {
      const rec = items[i] as Record<string, unknown> | null;
      if (!rec || typeof rec !== 'object' || rec.role !== 'assistant') continue;
      const content = rec.content;
      if (!Array.isArray(content)) continue;
      const parts = content
        .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>).text : null))
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      if (parts.length) return parts.join('\n');
    }
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const rec = o as Record<string, unknown>;
  if (typeof rec.result === 'string' && rec.result.trim()) return rec.result;
  for (const key of ['text', 'response', 'output', 'message']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…（后面还有 ${t.length - max} 字，已截断）`;
}

/**
 * 跑一次任务。resolve 的时机是「CLI 结束」或「超时被杀」。
 * 不 reject：所有失败都变成 ok=false 的回执，调用方不必包 try。
 */
export function runTask(prompt: string, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const args = [opts.cliEntry, '-p', prompt, '--output-format', 'json'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.skipPermissions) args.push('-y');
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);

  return new Promise<RunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const env: NodeJS.ProcessEnv = { ...process.env };
    // 从 Electron 继承来的这个变量会让 node 以 Electron 身份启动，CLI 会直接失灵
    delete env.ELECTRON_RUN_AS_NODE;
    // 配置里显式给的变量优先（API Key、国内端点等）
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (typeof v === 'string' && v) env[k] = v;
    }

    let child;
    try {
      child = spawn(opts.nodePath, args, {
        cwd: opts.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        ok: false,
        text: `启动不了 WorkBuddy CLI：${(err as Error).message}`,
        code: null,
        timedOut: false,
        ms: Date.now() - started,
        hint: '检查 worlds.wbtask.nodePath 与 cliEntry 是否指向真实文件',
      });
      return;
    }

    const hardCap = 4 * 1024 * 1024;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, Math.max(5_000, opts.timeoutMs));

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ms = Date.now() - started;

      const raw = stdout.trim();
      let text = parseJsonOutput(raw);
      if (text === null) text = raw || stderr.trim();
      text = clip(text, opts.maxOutputChars);

      // 认证、限流、路径问题是最常见的三种「啥也没干成」，把话说明白。
      // 注意：CLI 未登录、被限流时退出码都是 0，只能靠输出判断，不能让回执显示「办完了」。
      const joined = `${raw}\n${stderr}`;
      const authFailed = /Authentication required|Please use \/login|not logged in/i.test(joined);
      const rateLimited = /\b429\b|频率限制|使用量已超出|rate[_ ]?limit|too many requests|quota exceeded/i.test(
        joined,
      );
      let hint: string | undefined;
      if (authFailed) {
        hint = 'WorkBuddy CLI 还没登录：先在终端跑一次 codebuddy 并输入 /login，或者给 worlds.wbtask 配 CODEBUDDY_API_KEY。';
      } else if (rateLimited) {
        hint = '模型额度或频率受限（429）：等额度重置，或在 worlds.wbtask.model 里换一个模型再试。';
      } else if (/ENOENT|not found|cannot find/i.test(joined)) {
        hint = '找不到 CLI 或 node：检查 worlds.wbtask.nodePath 与 cliEntry。';
      }

      resolve({
        ok: code === 0 && !timedOut && !authFailed && !rateLimited,
        text: text || (timedOut ? '超时了，没等到结果。' : '它没有输出任何内容。'),
        code,
        timedOut,
        ms,
        hint,
      });
    };

    child.stdout?.on('data', (buf: Buffer) => {
      if (stdout.length < hardCap) stdout += buf.toString('utf8');
    });
    child.stderr?.on('data', (buf: Buffer) => {
      if (stderr.length < hardCap) stderr += buf.toString('utf8');
    });
    child.on('error', (err) => {
      if (!stderr) stderr = err.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
