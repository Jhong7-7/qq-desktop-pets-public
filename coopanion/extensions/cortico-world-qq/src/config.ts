import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import type { VisionConfig } from './vision.ts';
import { TASK_DEFAULTS, type TaskConfig } from './task.ts';
import { text } from './strings.ts';

/** 关闭的 roster 条目仍持久化并显示,仅从监听集合中排除。 */
export interface QQRosterEntry {
  id: number;
  enabled: boolean;
}

export const QQ_DEFAULTS = {
  enabled: false,
  /** OneBot v11 协议端的正向 WS 地址 */
  wsUrl: 'ws://127.0.0.1:3001',
  groups: [] as QQRosterEntry[],
  privates: [] as QQRosterEntry[],
  token: '',
  /** 群里没被@时的唤醒方式(见 QQConfigSection.groupWake) */
  groupWake: 'mention',
  /** 每天不主动发消息的起点/终点(本地小时)；两者相等即关闭 */
  nightQuietFrom: 2,
  nightQuietTo: 7,
  /** 夜间收到真人来信后，多久之内仍算「回信」而允许发送(分钟) */
  nightQuietReplyGraceMinutes: 10,
  /** 私聊任务通道；默认关闭，开着也不影响其他人聊天 */
  task: { ...TASK_DEFAULTS },
} as const;

/**
 * 本 World 需要的密钥的**环境变量名**。辅助视觉用的是 OpenRouter——
 * core 不认识这个名字,装配层照 World 声明的名字取值。
 */
export const QQ_SECRETS = { vision: 'OPENROUTER_API_KEY' } as const;

/**
 * 本 World 声明的可调项。只声明**World 自己**的参数:连接与监听名单有
 * 专用面板(要卡片式增删、要重启),这里放的是自带视觉的行为旋钮。文案按界面语言给。
 */
export function qqConfigGroup(language: Language): ConfigGroup {
  const t = text(language);
  return {
    id: 'world:qq',
    owner: 'world:qq',
    schema: {
      type: 'object',
      title: t.configTitle,
      description: t.configDescription,
      properties: {
        'worlds.qq.vision.enabled': {
          type: 'boolean',
          title: t.visionEnabledTitle,
          'x-hot': false,
          description: t.visionEnabledDescription,
        },
        'worlds.qq.vision.model': {
          type: 'string',
          title: t.visionModelTitle,
          'x-hot': false,
          description: t.visionModelDescription,
        },
        'worlds.qq.vision.concurrency': {
          type: 'integer',
          title: t.concurrencyTitle,
          minimum: 1,
          maximum: 16,
          multipleOf: 1,
          'x-suffix': t.concurrencySuffix,
          'x-hot': true,
          description: t.concurrencyDescription,
        },
        'worlds.qq.vision.dedupPrecheckMs': {
          type: 'integer',
          title: t.dedupPrecheckTitle,
          minimum: 0,
          maximum: 30_000,
          multipleOf: 100,
          'x-suffix': 'ms',
          'x-hot': true,
          description: t.dedupPrecheckDescription,
        },
        'worlds.qq.vision.maxImageBytes': {
          type: 'integer',
          title: t.maxImageBytesTitle,
          minimum: 65_536,
          maximum: 104_857_600,
          multipleOf: 65_536,
          'x-scale': 1_048_576,
          'x-suffix': 'MB',
          'x-hot': true,
          description: t.maxImageBytesDescription,
        },
        'worlds.qq.vision.timeoutMs': {
          type: 'integer',
          title: t.timeoutTitle,
          minimum: 1000,
          maximum: 300_000,
          multipleOf: 1000,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': false,
          description: t.timeoutDescription,
        },
        // 夜间免打扰。这些值由 definition.ts 透传给 World，改完需重启 World/应用。
        'worlds.qq.nightQuietFrom': {
          type: 'integer', title: '免打扰开始（点）', minimum: 0, maximum: 23,
          'x-hot': false, description: '每天这个点起不主动发 QQ 消息；和结束时刻相同表示关闭。',
        },
        'worlds.qq.nightQuietTo': {
          type: 'integer', title: '免打扰结束（点）', minimum: 0, maximum: 23,
          'x-hot': false, description: '每天这个点恢复主动发言；小于开始时刻表示跨天区间。',
        },
        'worlds.qq.nightQuietReplyGraceMinutes': {
          type: 'integer', title: '夜间回信宽限（分钟）', minimum: 0, maximum: 120,
          'x-hot': false, description: '夜里哥哥刚发过消息，这段时间内仍照常回；超时后的自发消息一律拦下。',
        },
        // 发送闸门。这些值由 definition.ts 透传给 World，改完需重启 World/应用。
        'worlds.qq.privateNoReplyLimit': {
          type: 'boolean', title: '私聊不限制回复条数', 'x-hot': false,
          description: '开启后私聊跳过「同一封来信最多回几条」和「连发几条没回应就拦」；群聊闸门、发送间隔保持不变。',
        },
        'worlds.qq.maxSendsPerReply': {
          type: 'integer', title: '同一封来信最多回几条', minimum: 0, maximum: 50,
          'x-hot': false, description: '0 = 不限。发满会返回 [send blocked] 让她合并成一条。',
        },
        'worlds.qq.maxConsecutiveSends': {
          type: 'integer', title: '连发几条没等到回应就拦', minimum: 0, maximum: 50,
          'x-hot': false, description: '0 = 不限。用于防止两个桌宠你一句我一句停不下来。',
        },
        'worlds.qq.sendIntervalMs': {
          type: 'integer', title: '两条消息最小间隔(ms)', minimum: 0, maximum: 10_000,
          'x-hot': false, description: '连发多条时的节流，别刷屏。',
        },
        'worlds.qq.groupMaxPerWindow': {
          type: 'integer', title: '群聊窗口内最多发几条', minimum: 0, maximum: 100,
          'x-hot': false, description: '0 = 不限。配合下面窗口长度使用，是最后一道防刷屏闸门。',
        },
        'worlds.qq.groupWindowSec': {
          type: 'integer', title: '群聊限速窗口(秒)', minimum: 5, maximum: 3600,
          'x-hot': false, description: '滑动窗口长度。',
        },
      },
    },
  };
}

/** config.json 的 `worlds.qq` 节。 */
export interface QQConfigSection {
  enabled: boolean;
  /** OneBot v11 协议端的正向 WS 地址 */
  wsUrl: string;
  /** 群 roster,逐项热更新;关闭的条目仍持久化并显示,但不参与监听。 */
  groups: QQRosterEntry[];
  /** 监听的私聊 QQ 号 roster,语义同 groups */
  privates: QQRosterEntry[];
  /** OneBot access token,可空 */
  token: string;
  /** 群里没被@时的唤醒方式:mention=只入队不唤醒(默认),all=每条都按 debounce 唤醒 */
  groupWake?: 'mention' | 'all';
  /** 夜间免打扰起止(本地小时,相等=关闭)与回信宽限(分钟) */
  nightQuietFrom?: number;
  nightQuietTo?: number;
  nightQuietReplyGraceMinutes?: number;
  /** 私聊是否跳过条数/连发闸门(默认 true；群聊仍按下面各项限制) */
  privateNoReplyLimit?: boolean;
  /** 同一封来信最多回几条(0=不限)。曾长期只在 config.json 里写着、没透传给 World。 */
  maxSendsPerReply?: number;
  /** 连发多少条仍没等到对方回应就拦下(0=不限) */
  maxConsecutiveSends?: number;
  /** 两条发出消息之间的最小间隔(ms) */
  sendIntervalMs?: number;
  /** 群聊滑动窗口内最多发几条(0=不限) */
  groupMaxPerWindow?: number;
  /** 群聊滑动窗口长度(秒) */
  groupWindowSec?: number;
  /** 私聊任务通道：口令拦截、白名单执行、私聊回报 */
  task?: TaskConfig;
  vision: VisionConfig;
}
