/**
 * appointments.mjs —— 「约定闹钟」的纯逻辑部分。
 *
 * 背景：桥原本只有固定 30/60 分钟的「静默续话」，桌宠模型自己没有定时器工具，
 * 所以哥哥说「五分钟后找我」时她只能口头答应，没有任何机制真的在五分钟后叫她。
 * 这里负责：从哥哥的原话里解析时间约定（相对时长 + 绝对时刻）、判断取消意图、
 * 以及约定的落盘/恢复。真正的 setTimeout 与发送由 bridge.mjs 负责
 * （本模块不碰网络、不碰桌宠；解析函数接受 now 参数，便于离线确定性测试）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/** 默认到点旁白。{phrase} 会被替换成哥哥当时说的原话。 */
export const DEFAULT_APPOINTMENT_PROMPT =
  '（旁白：这句只会发到【私聊】里，给哥哥一个人看。现在到了你亲口答应哥哥的时间点了——'
  + '他之前说「{phrase}」，你当时答应会在这个时辰来找他。以系统给你的【当前时间】为准，别再等、别再说还差多久，'
  + '也不用解释为什么晚了，就像准点赴约一样轻轻说一句：说你来了、打个招呼、'
  + '或者顺着当时的话题接一句，带一点点撒娇也行。一两句，短。'
  + '别问「在吗」「还在吗」，别提「定时器」「分钟」「后台」「桥」这些词，别把群里的事带进来。）';

const CN_DIGIT = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 廿: 20, 卅: 30,
};

/** 中文数字 / 阿拉伯数字 → number。支持 五 / 十五 / 二十 / 二十五 / 半。 */
export function cnNumber(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s === '半') return 0.5;
  if (s === '十') return 10;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    const tens = a === '' ? 1 : cnNumber(a);
    const ones = b === '' || b === undefined ? 0 : cnNumber(b);
    if (!Number.isFinite(tens) || !Number.isFinite(ones)) return NaN;
    return tens * 10 + ones;
  }
  let n = 0;
  for (const ch of s) {
    const v = CN_DIGIT[ch];
    if (v === undefined || v >= 10) return NaN;
    n = n * 10 + v;
  }
  return /^[零一二两三四五六七八九]+$/.test(s) && s.length > 1 ? n : (CN_DIGIT[s] ?? NaN);
}

// 意图词：只有同时出现「时间表达式 + 意图」才算约定，避免把「这五分钟真难熬」误判成定时。
const INTENT_RE = /(找我|提醒我|提醒一下|叫我|喊我|来找我|说一声|发我消息|给我发消息|找我说话|找我聊|跟我说|说句话|再来一句|到时候叫我|发条消息)/;

// ── 相对时间：五分钟后 / 半小时后 / 一个半小时后 ────────────────────────
const NUM = '[0-9零一二两三四五六七八九十廿卅]+(?:\\.[0-9]+)?';
const UNIT = '(?:秒钟|秒|分钟|分|小时|钟头|个钟头|个钟|钟)';
const REL_RE = new RegExp(`(?:过|再|等|等过)?\\s*(${NUM})\\s*(${UNIT})\\s*(?:之|以)?后`, 'g');
const REL_LOOSE_RE = new RegExp(`(?:过|再|等)\\s*(${NUM})\\s*(${UNIT})`, 'g');
// 「半」不进 NUM，交给 HALF_RE 统一处理，否则「一个半小时」会被拆成「半小时」算成 30 分钟。
const HALF_RE = /([0-9零一二两三四五六七八九十]+)?\s*(?:个)?\s*半\s*(?:个)?\s*小时\s*(?:之|以)?后/g;

const UNIT_MS = (u) => {
  if (u.startsWith('秒')) return 1000;
  if (u.startsWith('分')) return 60_000;
  return 3_600_000; // 小时 / 钟头 / 个钟
};

// 事后吐槽不算新约定：哥哥在抱怨「都十点十四了」「怎么还没来」时，
// 句子里往往也会带上「五分钟后找我」，不能因此又排一个新闹钟。
const COMPLAIN_RE = /(现在|都|已经)\s*.{0,8}(点|分|钟|小时)|(怎么|为啥|为什么)\s*还|没(有)?(来|找我|提醒)|迟到|说了不算|不靠谱|甩锅/;

/** 从一句话里解析「多久之后找我」。 @returns {{delayMs:number, matched:string}|null} */
export function parseDelayMs(text) {
  const s = String(text ?? '');
  if (!s || !INTENT_RE.test(s) || COMPLAIN_RE.test(s)) return null;
  const intentAt = s.search(INTENT_RE);

  const candidates = [];
  const collect = (re, kind) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      // 时间表达式必须离意图词不太远，避免跨句误判
      if (Math.abs(m.index - intentAt) > 30) continue;
      let value;
      if (kind === 'half') {
        const whole = m[1] ? cnNumber(m[1]) : 0;
        value = (Number.isFinite(whole) ? whole : 0) + 0.5;
        candidates.push({ delayMs: value * 3_600_000, matched: m[0], at: m.index });
        continue;
      }
      value = cnNumber(m[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      candidates.push({ delayMs: value * UNIT_MS(m[2]), matched: m[0], at: m.index });
    }
  };
  collect(HALF_RE, 'half');
  collect(REL_RE, 'rel');
  if (candidates.length === 0) collect(REL_LOOSE_RE, 'loose');

  if (candidates.length === 0) return null;
  // 同一句里出现多个时间时，取最靠近意图词的那个
  candidates.sort((a, b) => Math.abs(a.at - intentAt) - Math.abs(b.at - intentAt));
  const best = candidates[0];
  return { delayMs: best.delayMs, matched: best.matched };
}

// ── 绝对时刻：明天八点 / 今晚十点半 / 后天下午三点 / 周五 19:00 ───────────
const NUM_CHAR = /[0-9零一二两三四五六七八九十]/;
const SEP_RE = /点钟|点|[:：]/g;
const MIN_HEAD_RE = /^\s*(半|一刻|三刻)/;
const MIN_NUM_RE = /^\s*([0-9]{1,2}|[零一二两三四五六七八九十]{1,3})\s*分?/;
// 只认「点 / 点钟 / : / ：」，刻意不认「时」，否则「两小时后」会被当成时刻。

/**
 * 手动扫描比一条大正则稳：中文数字串容易把前一词吞进来
 * （「周五八点」若贪婪取「五八」会算出 58 点），所以先定位分隔符，
 * 再向前取紧邻的数字串，并从最长到最短挑一个解析成 0..24 的小时。
 */
function findClocks(s) {
  const out = [];
  SEP_RE.lastIndex = 0;
  let sep;
  while ((sep = SEP_RE.exec(s)) !== null) {
    let i = sep.index;
    while (i > 0 && /\s/.test(s[i - 1])) i -= 1;
    let j = i;
    while (j > 0 && NUM_CHAR.test(s[j - 1])) j -= 1;
    const numStr = s.slice(j, i);
    if (!numStr) continue;

    let hour = NaN;
    for (let len = Math.min(3, numStr.length); len >= 1; len -= 1) {
      const v = cnNumber(numStr.slice(numStr.length - len));
      if (Number.isFinite(v) && v >= 0 && v <= 24) { hour = v; break; }
    }
    if (!Number.isFinite(hour)) continue;

    const rest = s.slice(sep.index + sep[0].length);
    const head = MIN_HEAD_RE.exec(rest);
    let numM = null;
    let minute = 0;
    if (head) {
      minute = head[1] === '半' ? 30 : head[1] === '一刻' ? 15 : 45;
    } else {
      numM = MIN_NUM_RE.exec(rest);
      if (numM) minute = clockMinute(numM[1]);
    }
    if (minute < 0 || minute > 59) continue;
    const tailLen = head ? head[0].length : (numM ? numM[0].length : 0);
    out.push({
      hour,
      minute,
      raw: s.slice(j, sep.index + sep[0].length + tailLen),
      at: j,
      hasColon: sep[0] === ':' || sep[0] === '：',
    });
  }
  return out;
}

// 日期前缀。顺序要长词优先；「明早 / 明晚 / 今晚 / 今早」同时给出时段。
const DAY_RULES = [
  { re: /大后天/, day: 3 },
  { re: /后天/, day: 2 },
  { re: /明(?:天|日|儿)?\s*(?:凌晨|早上|早晨|清晨|上午|早)/, day: 1, part: 'am' },
  { re: /明(?:天|日|儿)?\s*(?:傍晚|晚上|夜里|下午|晚)/, day: 1, part: 'pm' },
  { re: /明(?:天|日|儿|早|晚)/, day: 1 },
  { re: /今(?:天|日)?\s*(?:凌晨|早上|早晨|清晨|上午|早)/, day: 0, part: 'am' },
  { re: /今(?:天|日)?\s*(?:傍晚|晚上|夜里|下午|晚)/, day: 0, part: 'pm' },
  { re: /今(?:天|日|晚|早)/, day: 0 },
];

const PART_RULES = [
  { re: /凌晨|半夜/, part: 'am' },
  { re: /中午|正午/, part: 'noon' },
  { re: /下午|傍晚|晚上|夜里|晚/, part: 'pm' },
  { re: /早上|早晨|清晨|上午|早/, part: 'am' },
];

const WEEKDAY_CN = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const WEEK_RE = /(下)?\s*(?:周|星期|礼拜)\s*([日天一二三四五六])/;

// 绝对时刻的吐槽过滤比相对宽松一点：「现在八点提醒我」不该被当成抱怨，
// 只拦明显在追责/复查的说法。
const ABSOLUTE_COMPLAIN_RE =
  /((怎么|为啥|为什么)\s*还)|(没(有)?(来|找我|提醒|到))|(迟到|说了不算|不靠谱|甩锅)|(现在都)|(都\s*[0-9零一二两三四五六七八九十]{1,3}\s*[点:：])/;

function clockMinute(raw) {
  if (!raw) return 0;
  if (raw === '半') return 30;
  if (raw === '一刻') return 15;
  if (raw === '三刻') return 45;
  const n = cnNumber(raw);
  return Number.isFinite(n) ? n : 0;
}

/** 把 12 小时制的小时数按时段词换成 24 小时制。 */
function to24(h, part) {
  if (part === 'am') return h === 12 ? 0 : h;
  if (part === 'pm' || part === 'noon') return h >= 1 && h <= 11 ? h + 12 : h;
  return h;
}

/** 把时间戳写成「明天 08:00」这种人能核对的标签。 */
export function formatWhen(at, now = Date.now()) {
  const d = new Date(at);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  const near = ['今天', '明天', '后天', '大后天'];
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const prefix = diff >= 0 && diff < near.length
    ? near[diff]
    : `${d.getMonth() + 1}/${d.getDate()} ${wd}`;
  return `${prefix} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 解析「明天八点叫我」这类绝对时刻。
 *
 * 规则（重要，日志里也会打出实际时间供核对）：
 *  - 带冒号的数字（8:30 / 19:00）或 hour>12 一律按 24 小时制；
 *  - 有「上午/下午/晚上/凌晨」等时段词 → 按词换算；
 *  - 有日期前缀（明天/后天/周五）但没时段词 → 按上午那一次，如「明天八点」= 08:00；
 *  - 什么都没有的口语「十点」「八点半」→ 在 08:00/20:00 这种 12 小时循环里
 *    取**下一个**未来时刻（傍晚说「十点」就是今晚 22:00）；
 *  - 算出来的时刻已经过去 → 顺延到下一个同名时刻，绝不排一个过去的定时器。
 *
 * @returns {{at:number, delayMs:number, matched:string, kind:'absolute', label:string}|null}
 */
export function parseAbsoluteTime(text, now = Date.now()) {
  const s = String(text ?? '');
  if (!s || !INTENT_RE.test(s) || ABSOLUTE_COMPLAIN_RE.test(s)) return null;
  const intentAt = s.search(INTENT_RE);

  const clocks = findClocks(s).filter((c) => Math.abs(c.at - intentAt) <= 30);
  if (clocks.length === 0) return null;
  clocks.sort((a, b) => Math.abs(a.at - intentAt) - Math.abs(b.at - intentAt));
  const clock = clocks[0];

  let dayOffset = 0;
  let part = null;
  let hasDayPrefix = false;
  let weekMode = false;
  const week = WEEK_RE.exec(s);
  if (week) {
    // 中文「周三」「下周三」都按「下一个该星期几」处理；若正好是今天但时刻已过，顺延 7 天。
    const targetWd = WEEKDAY_CN[week[2]];
    dayOffset = (targetWd - new Date(now).getDay() + 7) % 7;
    hasDayPrefix = true;
    weekMode = true;
  } else {
    for (const r of DAY_RULES) {
      const hit = r.re.exec(s);
      if (!hit || Math.abs(hit.index - clock.at) > 24) continue;
      dayOffset = r.day;
      part = r.part ?? null;
      hasDayPrefix = true;
      break;
    }
  }
  if (!part) {
    for (const r of PART_RULES) {
      const hit = r.re.exec(s);
      if (!hit || Math.abs(hit.index - clock.at) > 24) continue;
      part = r.part;
      break;
    }
  }

  const is24h = clock.hour > 12 || clock.hour === 0 || clock.hasColon;
  const base = new Date(now);
  const atDay = (d, h, mi) => new Date(
    base.getFullYear(), base.getMonth(), base.getDate() + d, h, mi, 0, 0,
  ).getTime();

  let pool;
  const nextDay = dayOffset + (weekMode ? 7 : 1);
  if (is24h || part) {
    const h = is24h ? clock.hour : to24(clock.hour, part);
    pool = [atDay(dayOffset, h, clock.minute), atDay(nextDay, h, clock.minute)];
  } else if (hasDayPrefix || clock.hour === 12) {
    pool = [atDay(dayOffset, clock.hour, clock.minute), atDay(nextDay, clock.hour, clock.minute)];
  } else {
    // 12 小时循环：8 点 → 08:00 与 20:00，谁先到就用谁
    pool = [];
    for (let d = dayOffset; d <= dayOffset + 1; d += 1) {
      pool.push(atDay(d, clock.hour, clock.minute));
      pool.push(atDay(d, clock.hour + 12, clock.minute));
    }
  }

  const target = pool.filter((t) => t > now).sort((a, b) => a - b)[0];
  if (!target || !Number.isFinite(target)) return null;
  return {
    at: target,
    delayMs: target - now,
    matched: clock.raw,
    kind: 'absolute',
    label: formatWhen(target, now),
  };
}

/** 统一入口：先认相对时长，没认出来再认绝对时刻。 */
export function parseAppointment(text, now = Date.now()) {
  const rel = parseDelayMs(text);
  if (rel) return { ...rel, kind: 'relative' };
  return parseAbsoluteTime(text, now);
}

/** 哥哥反悔了：取消还没触发的约定。 */
const CANCEL_SHORT_RE = /^(?:取消|撤销|不用了|不必了|别找我了|不用找我了)\s*(?:吧|啦|了)?\s*[。.!！~～\s]*$/;
export function isCancelRequest(text) {
  const s = String(text ?? '');
  return CANCEL_SHORT_RE.test(s.trim())
    || (/(取消|撤销)\s*(?:刚才|那个|这个)?\s*(?:的)?\s*(?:约定|提醒|定时|找我)?/.test(s) && /(约定|提醒|找我|定时|闹钟)/.test(s))
    || /(别|不用|不必|不用再|不要再)\s*(?:再|来)?\s*(?:找我|提醒我|叫我|喊我)/.test(s);
}

/** 读盘；文件坏了就当没有，绝不让一条脏数据把桥启动卡死。 */
export function loadAppointments(file) {
  try {
    if (!existsSync(file)) return [];
    const d = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(d?.items) ? d.items : [];
  } catch {
    return [];
  }
}

/** 落盘；失败只影响重启后恢复，不影响当前进程里的定时器。 */
export function saveAppointments(file, items) {
  try {
    writeFileSync(file, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}
