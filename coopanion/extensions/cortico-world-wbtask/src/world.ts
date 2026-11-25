/**
 * WorkBuddy 任务 World。
 *
 * 它只做三件事：接一句话、交给本机 WorkBuddy 去办、把结果说回来。
 * 不连 QQ、不碰聊天记录、不改人设——QQ 那边怎么把话递进来，是 QQ World 的事。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WBTASK_DEFAULTS, WBTASK_LOG_DIR, type WBTaskConfig } from './config.ts';
import { runTask, type RunResult } from './runner.ts';
import { runViaGateway } from './gateway.ts';
import { JobStore, type JobRecord } from './store.ts';

/** 环境提示词模板就在本文件旁边；WebUI 的 promptDocs 要用绝对路径。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

interface HostLike {
  pushEvent: (event: Record<string, unknown>, opts?: { trigger?: string; deliver?: boolean }) => Promise<unknown>;
  log?: { info: (msg: string, ...rest: unknown[]) => void; warn: (msg: string, ...rest: unknown[]) => void };
}

interface QueuedJob {
  job: JobRecord;
  prompt: string;
  background: boolean;
  resolve: (r: RunResult) => void;
}

const RUN_TOOL = {
  name: 'wb_run',
  description:
    '把一件具体的事交给本机的 WorkBuddy（CodeBuddy Agent）去办：它能读写文件、跑命令、查资料、改代码。'
    + '适合「帮我整理/检查/生成点什么」这类要动手的活，不适合闲聊或凭记忆就能答的问题。'
    + '默认会等结果（最多 timeoutSec 秒）；活太大就把 background 设 true，先拿一个任务号，办完会有人通知你。',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: '要说清楚：办什么、在哪办（路径）、办成什么样算完。像给同事派活那样写，不要写寒暄。',
      },
      background: {
        type: 'boolean',
        description: 'true=立刻返回任务号，办完再通知；false 或不填=当场等结果。',
      },
    },
    required: ['task'],
  },
  tags: ['external-action', 'task'],
};

const STATUS_TOOL = {
  name: 'wb_status',
  description: '看 WorkBuddy 任务办得怎么样了：不填 job_id 就列最近几条，填了就看那一条的详情。',
  parameters: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'wb_run 返回的任务号；留空看最近几条。' },
    },
  },
  tags: ['internal-state', 'task'],
};

function nowIso(): string {
  return new Date().toISOString();
}

export class WBTaskWorld {
  readonly id = 'wbtask';

  /** ctx.cfg 是配置段的共享引用，WebUI 原地改写它，所以每次用都现读。 */
  private readonly section: Partial<WBTaskConfig>;
  private readonly dataDir: string;
  private readonly store: JobStore;
  private host: HostLike | null = null;
  private queue: QueuedJob[] = [];
  private running = 0;
  private stopped = false;

  constructor(ctx: { cfg?: Partial<WBTaskConfig>; dataDir?: string }) {
    this.section = ctx.cfg ?? {};
    this.dataDir = ctx.dataDir ?? process.cwd();
    this.store = new JobStore(this.dataDir);
  }

  private get cfg(): WBTaskConfig {
    return { ...WBTASK_DEFAULTS, ...this.section };
  }

  async start(host: HostLike): Promise<void> {
    this.host = host;
    this.stopped = false;
    try {
      mkdirSync(join(this.dataDir, WBTASK_LOG_DIR), { recursive: true });
    } catch {
      /* 日志目录建不出来不影响执行 */
    }
    const orphans = this.store.markOrphansFailed();
    if (orphans) host.log?.warn(`[wbtask] 上次有 ${orphans} 个任务没跑完，已标记为失败`);
    host.log?.info('[wbtask] 已就绪，工具 wb_run / wb_status 可用');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queue = [];
    this.host = null;
  }

  tools() {
    return [
      { ...RUN_TOOL, handler: (args: Record<string, unknown>) => this.runTool(args) },
      { ...STATUS_TOOL, handler: (args: Record<string, unknown>) => this.statusTool(args) },
    ];
  }

  /** WebUI 页声明：没有它，环境提示词整段不会进前缀。 */
  webUi() {
    return {
      label: 'WorkBuddy 任务',
      promptDocs: [
        {
          key: 'worlds.wbtask.envPrompt',
          title: 'WorkBuddy 任务 · 环境说明',
          description: '决定她知不知道什么时候该把活交出去、交出去之后回执怎么读。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt' as const,
          vars: [
            { name: 'workdir', description: '任务默认在哪个目录执行。' },
            { name: 'timeout', description: '当场等结果最多几秒。' },
            { name: 'recent', description: '最近交办过的任务。' },
          ],
        },
      ],
    };
  }

  envPromptVars(): Record<string, string> | null {
    if (!this.cfg.enabled) return null;
    const recent = this.store.recent(3);
    const tail = recent.length
      ? recent
          .map((j) => `- ${j.id}（${j.status}）${j.prompt.slice(0, 40)}`)
          .join('\n')
      : '- 还没有任务';
    return {
      workdir: this.cfg.cwd,
      timeout: String(this.cfg.timeoutSec),
      recent: tail,
    };
  }

  // ---------------------------------------------------------------- 工具

  private async runTool(args: Record<string, unknown>): Promise<string> {
    if (!this.cfg.enabled) return 'WorkBuddy 任务通道现在是关着的（worlds.wbtask.enabled=false）。';
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task) return '[bad input] task 不能为空：要说清办什么、在哪办。';

    const background = args.background === true;
    const job: JobRecord = {
      id: this.store.newId(),
      ts: nowIso(),
      from: 'hub',
      prompt: task,
      status: 'running',
    };
    this.store.upsert(job);

    const result = await this.enqueue(job, task, background);

    if (background) {
      return `接下了（任务号 ${job.id}），我让它后台办，办完会跟你说一声。`;
    }
    return this.formatResult(job, result);
  }

  private statusTool(args: Record<string, unknown>): string {
    const id = typeof args.job_id === 'string' ? args.job_id.trim() : '';
    if (id) {
      const job = this.store.get(id);
      if (!job) return `没有这个任务号：${id}`;
      const when = job.finishedTs ?? job.ts;
      return [
        `${job.id}｜${job.status}｜${when}`,
        `交办：${job.prompt}`,
        job.result ? `结果：${job.result}` : '还没结果。',
      ].join('\n');
    }
    const recent = this.store.recent(5);
    if (!recent.length) return '还没接过任务。';
    const lines = recent.map((j) => `${j.id}｜${j.status}｜${j.ts}｜${j.prompt.slice(0, 50)}`);
    const busy = this.running > 0 ? `（正在跑 ${this.running} 个，排队 ${this.queue.length} 个）` : '';
    return [`最近的任务${busy}：`, ...lines].join('\n');
  }

  // ---------------------------------------------------------------- 队列

  private enqueue(job: JobRecord, prompt: string, background: boolean): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      this.queue.push({ job, prompt, background, resolve });
      this.pump();
    });
  }

  private pump(): void {
    if (this.stopped) return;
    const max = Math.max(1, Number(this.cfg.maxConcurrent) || 1);
    while (this.running < max && this.queue.length > 0) {
      const item = this.queue.shift() as QueuedJob;
      this.running += 1;
      void this.execute(item).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async execute(item: QueuedJob): Promise<void> {
    const { job, prompt, background, resolve } = item;
    const timeoutMs = background
      ? Math.max(this.cfg.timeoutSec, 1800) * 1000 // 后台任务给足半小时
      : Math.max(5, this.cfg.timeoutSec) * 1000;

    let result: { ok: boolean; text: string; timedOut: boolean; ms: number; hint?: string };
    if (this.cfg.executor === 'cli') {
      result = await runTask(prompt, {
        nodePath: this.cfg.nodePath,
        cliEntry: this.cfg.cliEntry,
        cwd: this.cfg.cwd,
        model: this.cfg.model || undefined,
        permissionMode: this.cfg.permissionMode,
        skipPermissions: this.cfg.skipPermissions,
        extraArgs: this.cfg.extraArgs,
        env: this.cfg.env,
        timeoutMs,
        maxOutputChars: this.cfg.maxOutputChars,
      });
    } else {
      const g = await runViaGateway({
        prompt,
        port: this.cfg.gatewayPort || undefined,
        password: this.cfg.gatewayPassword || undefined,
        pythonPath: this.cfg.pythonPath || undefined,
        envScript: this.cfg.envScript || undefined,
        timeoutMs,
        maxOutputChars: this.cfg.maxOutputChars,
      });
      result = { ok: g.ok, text: g.text, timedOut: false, ms: g.ms, hint: g.hint };
    }

    job.status = result.timedOut ? 'timeout' : result.ok ? 'done' : 'failed';
    job.result = result.hint ? `${result.text}\n（${result.hint}）` : result.text;
    job.ms = result.ms;
    job.finishedTs = nowIso();
    job.hint = result.hint;
    this.store.upsert(job);

    if (background) await this.announce(job);
    resolve(result);
  }

  private async announce(job: JobRecord): Promise<void> {
    const host = this.host;
    if (!host) return;
    const label = job.status === 'done' ? '办完了' : job.status === 'timeout' ? '超时了' : '没办成';
    const text = [
      `WorkBuddy 任务 ${job.id} ${label}。`,
      `交办的是：${job.prompt.slice(0, 120)}`,
      `结果：${job.result ?? '（没有输出）'}`,
      '这句话只是通知，不用复述给我看；要跟主人说，就挑他关心的那部分说。',
    ].join('\n');
    try {
      await host.pushEvent(
        {
          type: 'wbtask.done',
          ts: nowIso(),
          source: this.id,
          origin: 'internal',
          senderKey: 'wbtask',
          text,
          meta: { jobId: job.id, status: job.status, ms: job.ms ?? 0 },
        },
        { trigger: 'flush' },
      );
    } catch {
      /* 事件推不进去也不能让任务本身失败 */
    }
  }

  private formatResult(job: JobRecord, result: RunResult): string {
    if (result.timedOut) {
      return `这个活超过 ${this.cfg.timeoutSec} 秒还没办完，我先掐了（任务号 ${job.id}）。`
        + '要么把活拆小一点，要么下次用 background 让它慢慢办。';
    }
    if (!result.ok && result.hint) return `没办成。${result.hint}`;
    const secs = (result.ms / 1000).toFixed(1);
    return `办完了（${secs}s）：\n${result.text}`;
  }
}
