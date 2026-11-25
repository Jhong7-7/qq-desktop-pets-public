/**
 * 泡泡任务通道。
 *
 * 私聊里以「任务：」等前缀开头的消息不进 LLM、不写聊天记录：
 * 落盘 tasks/inbox → 白名单动作执行 → 写 tasks/out → 直接私聊回报。
 *
 * 设计原则：
 * - 只认配置里的 allowedUsers，其他人发同样前缀不拦、照常聊天。
 * - 默认关闭（enabled:false），要显式打开才生效。
 * - 执行只走内置只读动作和 commands 白名单，永远不进 shell；
 *   超时强杀、输出截断、串行执行（并发 1）。
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import type { OneBotDriver } from './driver.ts';
import { buildOutgoing, renderSegmentsPlain, type OneBotGroupMessage } from './normalize.ts';

/** 配置里的一条命令白名单。命中 keywords 才执行，参数原样传给可执行文件，不经 shell。 */
export interface TaskCommandRule {
  keywords: string[];
  command: string;
  args?: string[];
}

export interface TaskConfig {
  enabled?: boolean;
  /** 任务口令前缀，按最长匹配 */
  prefixes?: string[];
  /** 允许下任务的 QQ 号；不在名单里的一律不拦 */
  allowedUsers?: number[];
  /** 收单后立刻回执 */
  ackText?: string;
  /** 单条任务执行上限 */
  timeoutMs?: number;
  /** 回报正文上限（QQ 长消息容易被吞） */
  maxOutputChars?: number;
  /** 额外命令白名单 */
  commands?: TaskCommandRule[];
}

export const TASK_DEFAULTS = {
  enabled: false,
  prefixes: ['任务：', '任务:', '帮我做：', '帮我做:'],
  allowedUsers: [10000],
  ackText: '收到啦，我去办，办好了回你。',
  timeoutMs: 30_000,
  maxOutputChars: 1200,
  commands: [] as TaskCommandRule[],
};

interface TaskBridgeDeps {
  driver: () => OneBotDriver | undefined;
  log: () => Logger;
  /** World 的数据目录；为空时不落盘，只在内存里跑 */
  dataDir?: string;
  /** 「状态」类任务要报的运行时信息，由 World 提供 */
  status: () => string;
}

interface PrivateConv {
  kind: 'group' | 'private';
  id: number;
}

export class TaskBridge {
  private readonly cfg: {
    enabled: boolean;
    prefixes: string[];
    allowedUsers: number[];
    ackText: string;
    timeoutMs: number;
    maxOutputChars: number;
    commands: TaskCommandRule[];
  };
  private chain: Promise<void> = Promise.resolve();
  private readonly deps: TaskBridgeDeps;

  constructor(cfg: TaskConfig, deps: TaskBridgeDeps) {
    this.deps = deps;
    this.cfg = {
      enabled: cfg.enabled ?? TASK_DEFAULTS.enabled,
      prefixes: (cfg.prefixes ?? TASK_DEFAULTS.prefixes).filter(Boolean),
      allowedUsers: cfg.allowedUsers ?? TASK_DEFAULTS.allowedUsers,
      ackText: cfg.ackText ?? TASK_DEFAULTS.ackText,
      timeoutMs: cfg.timeoutMs ?? TASK_DEFAULTS.timeoutMs,
      maxOutputChars: cfg.maxOutputChars ?? TASK_DEFAULTS.maxOutputChars,
      commands: cfg.commands ?? [],
    };
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /**
   * 在 World 收到私聊消息、投递给 LLM 之前调用。
   * 返回 true = 这条已被任务通道吃掉，调用方必须直接 return。
   */
  tryAccept(msg: OneBotGroupMessage, conv: PrivateConv): boolean {
    if (!this.cfg.enabled || conv.kind !== 'private') return false;
    if (!this.cfg.allowedUsers.includes(conv.id)) return false;

    const raw = renderSegmentsPlain(msg.message ?? []).trim();
    const prefix = [...this.cfg.prefixes]
      .sort((a, b) => b.length - a.length)
      .find((p) => raw.startsWith(p));
    if (!prefix) return false;

    const body = raw.slice(prefix.length).trim();
    if (!body) {
      void this.reply(conv.id, '任务内容是空的，把要做的事写在前缀后面。');
      return true;
    }

    const id = `t-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const log = this.deps.log();
    log.info('QQ 任务通道接单', { id, user: conv.id, body });
    this.chain = this.chain
      .then(() => this.run(id, body, conv.id, msg.message_id))
      .catch((err) => {
        log.error('QQ 任务执行异常', { id, err: err instanceof Error ? err.message : String(err) });
      });
    return true;
  }

  private async run(id: string, body: string, userId: number, messageId: number): Promise<void> {
    const startedAt = new Date().toISOString();
    const base = { id, text: body, userId, messageId, startedAt };
    await this.persist('inbox', id, { ...base, status: 'accepted' });
    await this.safeReply(userId, this.cfg.ackText);

    let result: string;
    let ok = true;
    try {
      result = await this.execute(body);
    } catch (err) {
      ok = false;
      result = `办砸了：${err instanceof Error ? err.message : String(err)}`;
    }

    await this.persist('out', id, {
      ...base,
      status: ok ? 'done' : 'failed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await this.safeReply(userId, `（办完了）${result}`);
  }

  private async execute(body: string): Promise<string> {
    const t = body.toLowerCase();

    if (/^ping$|^在吗$/.test(t) || t.includes('测试通道')) {
      return 'pong，任务通道在线。';
    }
    if (/时间|几点|现在几点|date/.test(t)) {
      return `现在是 ${new Date().toLocaleString('zh-CN', { hour12: false })}。`;
    }
    if (/状态|在线|运行|status/.test(t)) {
      return this.deps.status();
    }
    if (/端口|监听|port/.test(t)) {
      return this.runCommand('netstat', ['-ano'], filterListening);
    }

    const rule = this.cfg.commands.find((r) =>
      (r.keywords ?? []).some((k) => k && body.includes(k)),
    );
    if (rule) return this.runCommand(rule.command, rule.args ?? []);

    return '这个我暂时办不了：没配可执行动作。写具体一点，或者给我加一条命令白名单。';
  }

  private runCommand(
    command: string,
    args: string[],
    transform?: (out: string) => string,
  ): Promise<string> {
    const timeoutMs = this.cfg.timeoutMs;
    const max = this.cfg.maxOutputChars;
    return new Promise((resolve) => {
      let out = '';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (note?: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        let text = transform ? transform(out) : out;
        text = text.trim();
        if (note) text = `${text}\n${note}`.trim();
        if (text.length > max) text = `${text.slice(0, max)}…(已截断)`;
        resolve(text || '(没有输出)');
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args, { windowsHide: true, shell: false });
      } catch (err) {
        resolve(`启动失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已经退出 */
        }
        finish('[超时，已终止]');
      }, timeoutMs);

      child.stdout?.on('data', (d) => {
        if (out.length < max * 4) out += String(d);
      });
      child.stderr?.on('data', (d) => {
        if (out.length < max * 4) out += String(d);
      });
      child.on('error', (err) => {
        out += `\n[启动失败：${err.message}]`;
        finish();
      });
      child.on('close', () => finish());
    });
  }

  private async reply(userId: number, text: string): Promise<void> {
    const driver = this.deps.driver();
    if (!driver) throw new Error('QQ 未连接');
    await driver.callApi('send_private_msg', {
      user_id: userId,
      message: buildOutgoing({ text }),
    });
  }

  private async safeReply(userId: number, text: string): Promise<void> {
    try {
      await this.reply(userId, text);
    } catch (err) {
      this.deps.log().warn('QQ 任务回报失败', {
        user: userId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async persist(dir: 'inbox' | 'out', id: string, payload: unknown): Promise<void> {
    const root = this.deps.dataDir;
    if (!root) return;
    try {
      const target = join(root, 'tasks', dir);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, `${id}.json`), JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      this.deps.log().warn('QQ 任务落盘失败', {
        dir,
        id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** netstat -ano 只留 LISTENING 行，够看端口又不至于刷屏 */
function filterListening(out: string): string {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.includes('LISTENING'));
  if (!lines.length) return out;
  return lines.slice(0, 40).join('\n');
}
