import type { WorldDefinition } from 'cortico/world.ts';
import { WBTASK_DEFAULTS, type WBTaskConfig } from './config.ts';
import { WBTaskWorld } from './world.ts';

export const WBTASK: WorldDefinition<WBTaskConfig> = {
  id: 'wbtask',
  label: 'WorkBuddy 任务',
  // 装好先不启用：要不要让手伸到本机文件，得主人点头
  defaults: () => ({ ...WBTASK_DEFAULTS }),
  create: (ctx) => new WBTaskWorld({ cfg: ctx.cfg, dataDir: ctx.dataDir }),
  describe: {
    tools: [
      {
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
        summary: {
          zh: '把一件要动手的活交给本机 WorkBuddy，等它办完（或先拿任务号）。',
          en: 'Hand a hands-on job to the local WorkBuddy agent, waiting for the result or taking a job id.',
        },
      },
      {
        name: 'wb_status',
        description: '看 WorkBuddy 任务办得怎么样了：不填 job_id 就列最近几条，填了就看那一条的详情。',
        parameters: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'wb_run 返回的任务号；留空看最近几条。' },
          },
        },
        tags: ['internal-state', 'task'],
        summary: {
          zh: '查最近交办的活办到哪一步了。',
          en: 'Check the status of recent jobs or one specific job.',
        },
      },
    ],
    events: [
      {
        type: 'wbtask.done',
        description: {
          zh: '后台任务办完了（成功、失败或超时）：带上任务号、交办内容和结果摘要。',
          en: 'A background job finished (done, failed or timed out), with its id, request and result summary.',
        },
        trigger: 'flush',
        tags: ['task'],
      },
    ],
  },
};
