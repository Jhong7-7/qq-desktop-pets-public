/** 任务账本：每个任务一条记录，落在 dataDir/wbtask-jobs.json，重启后还能查。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WBTASK_STATE_FILE } from './config.ts';

export type JobStatus = 'running' | 'done' | 'failed' | 'timeout';

export interface JobRecord {
  id: string;
  ts: string;
  from: string;
  prompt: string;
  status: JobStatus;
  result?: string;
  ms?: number;
  finishedTs?: string;
  hint?: string;
}

const KEEP = 100;

export class JobStore {
  private readonly path: string;
  private jobs: JobRecord[] = [];

  constructor(dataDir: string) {
    this.path = join(dataDir, WBTASK_STATE_FILE);
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw?.jobs;
      if (Array.isArray(list)) this.jobs = list.filter((j) => j && typeof j.id === 'string');
    } catch {
      /* 账本坏了就从空的开始，最多丢历史，不影响接新任务 */
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ jobs: this.jobs.slice(0, KEEP) }, null, 1)}\n`, 'utf8');
      renameSync(tmp, this.path);
    } catch {
      /* 写不进去只丢历史记录，任务本身照跑 */
    }
  }

  newId(): string {
    return `wb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  }

  upsert(job: JobRecord): void {
    const i = this.jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) this.jobs[i] = job;
    else this.jobs.unshift(job);
    this.jobs = this.jobs.slice(0, KEEP);
    this.save();
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  recent(n = 5): JobRecord[] {
    return this.jobs.slice(0, n);
  }

  /** 启动时把上次没跑完的标记成失败：进程都重启了，那些任务不可能还在跑。 */
  markOrphansFailed(): number {
    let n = 0;
    for (const j of this.jobs) {
      if (j.status === 'running') {
        j.status = 'failed';
        j.result = '进程重启，这次任务没跑完。';
        j.finishedTs = new Date().toISOString();
        n += 1;
      }
    }
    if (n) this.save();
    return n;
  }
}
