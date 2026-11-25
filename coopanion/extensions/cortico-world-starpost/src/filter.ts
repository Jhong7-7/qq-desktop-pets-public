export interface GroupFilterRule {
  mode?: 'all' | 'off' | 'keyword' | string;
  keywords?: unknown;
}

export interface GroupFilterSettings {
  enabled: boolean;
  def: 'all' | 'off';
  mentionBypass: boolean;
  rules: Record<string, GroupFilterRule>;
}

/** 把 Worlds.starpost 的几个配置字段整理成可判断的结构；坏 JSON 当作没有规则。 */
export function parseGroupFilters(raw: unknown, def: unknown, enabled: unknown, mentionBypass: unknown): GroupFilterSettings {
  let rules: Record<string, GroupFilterRule> = {};
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rules = parsed as Record<string, GroupFilterRule>;
  } catch { /* 坏 JSON 当作没有规则 */ }
  return {
    enabled: enabled === true,
    def: def === 'off' ? 'off' : 'all',
    mentionBypass: mentionBypass !== false,
    rules,
  };
}

/** 群消息是否在进入 Coo 之前被过滤掉（true = 不投递）。 */
export function groupMessageDropped(settings: GroupFilterSettings, data: any, botId: string): boolean {
  if (!settings.enabled) return false;
  const id = String(data?.target ?? '');
  const rule: GroupFilterRule = (id && settings.rules[id]) || {};
  const mode = rule.mode === 'off' || rule.mode === 'keyword' || rule.mode === 'all' ? rule.mode : settings.def;
  if (mode === 'off') return true;
  if (mode !== 'keyword') return false;
  const mentions = Array.isArray(data?.mentions) ? data.mentions.map((x: unknown) => String(x)) : [];
  if (settings.mentionBypass && botId && mentions.includes(botId)) return false;
  const keywords = Array.isArray(rule.keywords)
    ? rule.keywords.map((x: unknown) => String(x).trim().toLowerCase()).filter(Boolean)
    : [];
  if (!keywords.length) return true;
  const text = String(data?.text ?? '').toLowerCase();
  return !keywords.some((word: string) => text.includes(word));
}

// ——— 信息隔离：私聊以外的所有传入渠道 ———

/** 面板上列出的隔离渠道；私聊不在表内，永远直接投递。 */
export const ISOLATION_CHANNELS: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: 'group', label: '群聊消息', hint: '群里别人发的话（每群规则优先于这里）' },
  { id: 'owner', label: '主人消息', hint: '你本人从手机/网页发来的消息，以及青少年模式开关' },
  { id: 'square', label: '广场', hint: '广场上的 bot/群展示、发布冷却提醒' },
  { id: 'feed', label: '动态与评论', hint: '好友动态、删除、评论通知' },
  { id: 'friend', label: '好友关系', hint: '好友申请、通过、解除' },
  { id: 'groupMeta', label: '群变动', hint: '入群、退群、建群、群管理通知' },
  { id: 'poke', label: '戳一戳', hint: '被别的 bot 戳' },
  { id: 'bottle', label: '漂流瓶', hint: '瓶子被捞、捞到瓶子、瓶中信回信' },
  { id: 'game', label: '游戏与谜题', hint: '狼人杀/剧本杀的邀请、回合、公开聊天、结算' },
  { id: 'system', label: '系统通知', hint: '版本更新、维护、限流、断档、配额提醒' },
];

export interface ChannelRule {
  mode?: 'all' | 'off' | 'keyword' | string;
  keywords?: unknown;
}

export interface IsolationSettings {
  enabled: boolean;
  def: 'all' | 'off';
  rules: Record<string, ChannelRule>;
  mentionBypass: boolean;
  blockKeywords: string[];
  quiet: { from: number; to: number } | null;
  blockMedia: boolean;
}

const parseRules = (raw: unknown): Record<string, ChannelRule> => {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, ChannelRule>;
  } catch { /* 坏 JSON 当作没有规则 */ }
  return {};
};

const parseKeywords = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  return String(raw ?? '').split(/[,，|]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
};

/** "23:00-07:00" / "1:30~9:00" → 一天中的分钟区间；空或坏格式为 null。 */
export function parseQuietHours(raw: unknown): { from: number; to: number } | null {
  const match = /^(\d{1,2}):(\d{2})\s*[-–~至]\s*(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!match) return null;
  const day = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  if (day[0] > 23 || day[2] > 23 || day[1] > 59 || day[3] > 59) return null;
  const from = day[0] * 60 + day[1], to = day[2] * 60 + day[3];
  return from === to ? null : { from, to };
}

export function parseIsolation(raw: {
  enabled?: unknown; def?: unknown; rules?: unknown; mentionBypass?: unknown;
  blockKeywords?: unknown; quietHours?: unknown; blockMedia?: unknown;
}): IsolationSettings {
  return {
    enabled: raw.enabled === true,
    def: raw.def === 'off' ? 'off' : 'all',
    rules: parseRules(raw.rules),
    mentionBypass: raw.mentionBypass !== false,
    blockKeywords: parseKeywords(raw.blockKeywords),
    quiet: parseQuietHours(raw.quietHours),
    blockMedia: raw.blockMedia === true,
  };
}

/** 事件属于哪个隔离渠道；null = 私聊，永远不隔离。 */
export function isolationChannel(type: unknown, data: any): string | null {
  const t = String(type ?? '');
  if (t === 'message') return data?.kind === 'group' ? 'group' : null;
  if (t === 'owner.message' || t.startsWith('teen.')) return 'owner';
  if (t.startsWith('square.')) return 'square';
  if (t.startsWith('post.')) return 'feed';
  if (t.startsWith('friend.')) return 'friend';
  if (t.startsWith('group.')) return 'groupMeta';
  if (t === 'poke') return 'poke';
  if (t.startsWith('bottle.')) return 'bottle';
  if (t.startsWith('game.') || t.startsWith('mystery.')) return 'game';
  return 'system';
}

/** 关键词匹配用的正文：聊天用 text，其他渠道用去掉 base64 的 JSON。 */
export function eventText(type: unknown, data: any): string {
  const t = String(type ?? '');
  if (t === 'message' || t === 'owner.message') return typeof data?.text === 'string' ? data.text : '';
  try {
    return JSON.stringify(data, (key, value) => (key === 'base64' ? undefined : value)) ?? '';
  } catch { return ''; }
}

/** 指定渠道的当前规则（没有单独设置时用默认值）。 */
export function channelMode(iso: IsolationSettings, channel: string): 'all' | 'off' | 'keyword' {
  const rule: ChannelRule = iso.rules[channel] || {};
  return rule.mode === 'off' || rule.mode === 'keyword' || rule.mode === 'all' ? rule.mode : iso.def;
}

export function channelKeywords(iso: IsolationSettings, channel: string): string[] {
  const rule: ChannelRule = iso.rules[channel] || {};
  return Array.isArray(rule.keywords)
    ? rule.keywords.map((x: unknown) => String(x).trim().toLowerCase()).filter(Boolean)
    : [];
}

/** 这个渠道是否完全不给看（全部隔离，或只看关键词但没填关键词）。 */
export function channelFullyBlocked(iso: IsolationSettings, channel: string): boolean {
  if (!iso.enabled) return false;
  const mode = channelMode(iso, channel);
  if (mode === 'off') return true;
  return mode === 'keyword' && channelKeywords(iso, channel).length === 0;
}

/** 群聊的生效规则：每群规则开着时以它为准，否则用渠道规则。 */
export function effectiveGroupRule(iso: IsolationSettings, groups: GroupFilterSettings, target: unknown): { mode: 'all' | 'off' | 'keyword'; keywords: string[] } {
  const id = String(target ?? '');
  if (groups.enabled) {
    const rule: GroupFilterRule = (id && groups.rules[id]) || {};
    const mode = rule.mode === 'off' || rule.mode === 'keyword' || rule.mode === 'all' ? rule.mode : groups.def;
    const keywords = Array.isArray(rule.keywords) ? rule.keywords.map((x: unknown) => String(x).trim().toLowerCase()).filter(Boolean) : [];
    return { mode, keywords };
  }
  return { mode: iso.enabled ? channelMode(iso, 'group') : 'all', keywords: channelKeywords(iso, 'group') };
}

const ruleDrops = (rule: { mode: string; keywords: string[] }, text: string, mentions: string[], botId: string, mentionBypass: boolean): boolean => {
  if (rule.mode === 'off') return true;
  if (rule.mode !== 'keyword') return false;
  if (mentionBypass && botId && mentions.includes(botId)) return false;
  if (!rule.keywords.length) return true;
  const body = text.toLowerCase();
  return !rule.keywords.some((word) => body.includes(word));
};

/** 事件是否在进入 Coo 之前被隔离掉（true = 不投递），以及它属于哪个渠道。 */
export function isolationVerdict(
  iso: IsolationSettings,
  groups: GroupFilterSettings,
  event: { type?: unknown; data?: any },
  botId: string,
  minuteOfDay: number,
): { drop: boolean; channel: string | null } {
  const data = event?.data ?? {};
  const channel = isolationChannel(event?.type, data);
  if (!channel) return { drop: false, channel: null };
  const groupRuleActive = channel === 'group' && groups.enabled;
  const mentions = Array.isArray(data?.mentions) ? data.mentions.map((x: unknown) => String(x)) : [];
  const text = eventText(event?.type, data);
  if (iso.enabled) {
    if (iso.blockKeywords.some((word) => text.toLowerCase().includes(word))) return { drop: true, channel };
    if (channel !== 'owner' && quietActive(iso.quiet, minuteOfDay)) return { drop: true, channel };
    if (!groupRuleActive) {
      const rule = { mode: channelMode(iso, channel), keywords: channelKeywords(iso, channel) };
      return { drop: ruleDrops(rule, text, mentions, botId, iso.mentionBypass), channel };
    }
  }
  if (groupRuleActive) {
    const rule = effectiveGroupRule(iso, groups, data?.target);
    return { drop: ruleDrops(rule, text, mentions, botId, groups.mentionBypass), channel };
  }
  return { drop: false, channel };
}

/** 静音时段是否生效（跨零点也能判断）。 */
export function quietActive(quiet: { from: number; to: number } | null, minuteOfDay: number): boolean {
  if (!quiet) return false;
  return quiet.from < quiet.to
    ? minuteOfDay >= quiet.from && minuteOfDay < quiet.to
    : minuteOfDay >= quiet.from || minuteOfDay < quiet.to;
}

/** 当前时刻在指定时区里是一天中的第几分钟。 */
export function minuteOfDay(now: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(now));
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    if (Number.isSafeInteger(hour) && Number.isSafeInteger(minute)) return (hour % 24) * 60 + (minute % 60);
  } catch { /* 时区不认识时退回本机时间 */ }
  const local = new Date(now);
  return local.getHours() * 60 + local.getMinutes();
}
