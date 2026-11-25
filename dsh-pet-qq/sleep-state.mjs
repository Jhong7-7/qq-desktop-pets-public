#!/usr/bin/env node
/**
 * dsh-pet-qq / sleep-state.mjs —— 判断「溪颜现在是睡着还是清醒」，并把这个结论粘住。
 *
 * 两个信号源，优先级从高到低：
 *  1. 桌宠官方睡眠状态：GET /dsh-pet-7340/state → pets.<petId>.sleep.data.sleeping
 *     （桌面右键「睡觉 / 起来」或热键切换，最权威；data=null 表示还没用过这个功能）
 *  2. 剧情状态：最近几句她说的话（/state 的 say.text + memory.json 最近几条 assistant）。
 *     连续出现睡眠描写 → 判睡觉；出现「她自己醒了」的明确动作 → 立刻判清醒。
 *
 * 状态是粘性的：没有新信号时保持上一次结论，直到明确检测到清醒——不会因为中间
 * 一句没提「睡」就误判为醒了。结论落盘到 proactive-state.json，桥重启也不丢。
 * 纯模块：不连 WS、不读 config.json，参数由 bridge.mjs 注入，方便离线测试。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** 她自己醒过来的动作/说法。刻意不认裸的「醒了」——「醒了再跟你算账」「你醒了就别装了」说的是哥哥。 */
export const DEFAULT_WAKE_SELF = [
  '睁开', '睁眼', '半睁', '我醒了', '清醒', '不睡了', '睡够了', '不困了',
  '坐起来', '起身', '爬起来', '起床', '醒过来', '醒来了',
  /被.{0,8}(?:揉|叫|吵|弄|喊|推|摇)醒/,
];
/** 睡眠描写词。 */
export const DEFAULT_SLEEP_WORDS = [
  '睡着', '睡熟', '睡梦', '梦话', '没醒', '没真的醒', '睡沉', '沉沉睡',
  '困意', '打盹', '入睡', '闭着眼', '还在睡', '睡得', '睡不踏实', '睡眠中',
];
/** 哥哥主动叫醒她的话。 */
export const DEFAULT_WAKE_USER = [
  '醒醒', '起床', '别睡了', '该起了', '快醒', '醒一醒', '快起来', '起来啦',
];

function matches(text, patterns) {
  return (patterns ?? []).some((p) => {
    if (p instanceof RegExp) return p.test(text);
    const s = String(p ?? '').trim();
    return s !== '' && text.includes(s);
  });
}

/** 从 memory.json 里取最近 limit 条 assistant 的正文；读不到就返回空数组，绝不抛。 */
function recentAssistantTexts(memoryPath, entry, petId, limit = 3) {
  try {
    const d = JSON.parse(readFileSync(memoryPath, 'utf8'));
    let list = d?.[entry]?.[petId]?.messages;
    if (!Array.isArray(list)) {
      // 宠物包结构变了时的兜底：找出第一个 messages 数组
      const stack = [d];
      while (stack.length) {
        const cur = stack.pop();
        if (!cur || typeof cur !== 'object') continue;
        if (Array.isArray(cur.messages)) { list = cur.messages; break; }
        for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
      }
    }
    if (!Array.isArray(list)) return [];
    return list.filter((m) => m?.role === 'assistant').slice(-limit).map((m) => String(m?.content ?? ''));
  } catch {
    return [];
  }
}

/**
 * @param {object} opts
 * @param {string} opts.petId
 * @param {() => string} opts.stateUrl  桌宠 /state 的地址（由 pet-endpoint 提供，端口会自动漂移）
 * @param {string} opts.stateFile       状态落盘路径
 * @param {string} [opts.memoryPath]
 * @param {string} [opts.memoryEntry]
 * @param {(string|RegExp)[]} [opts.wakeWords]  她自己醒来的信号
 * @param {(string|RegExp)[]} [opts.sleepWords] 睡眠描写信号
 * @param {(msg: string) => void} [opts.log]
 */
export function createSleepWatcher(opts = {}) {
  const {
    petId = 'main',
    stateUrl,
    stateFile = 'proactive-state.json',
    memoryPath = join(homedir(), '.dsh', 'dsh-pet', 'memory.json'),
    memoryEntry = 'main',
    wakeWords = DEFAULT_WAKE_SELF,
    sleepWords = DEFAULT_SLEEP_WORDS,
    log = () => {},
  } = opts;
  const file = isAbsolute(stateFile) ? stateFile : join(process.cwd(), stateFile);
  let asleep = false;
  let source = '默认清醒';
  let updatedAt = 0;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof saved?.asleep === 'boolean') {
      asleep = saved.asleep;
      source = String(saved.source ?? '上次记录');
      updatedAt = Number(saved.updatedAt ?? 0) || 0;
    }
  } catch { /* 没有状态文件就按清醒开始 */ }

  function persist() {
    updatedAt = Date.now();
    try { writeFileSync(file, JSON.stringify({ asleep, source, updatedAt }, null, 2) + '\n', 'utf8'); }
    catch (e) { log(`状态落盘失败：${e instanceof Error ? e.message : String(e)}`); }
  }

  /** @returns {{asleep: boolean, source: string}|null} null = 没有可用信号，保持现状 */
  async function detect() {
    let said = '';
    try {
      const res = await fetch(stateUrl(), { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const j = await res.json();
        const leaf = j?.pets?.[petId]?.sleep?.data;
        if (leaf && typeof leaf === 'object' && typeof leaf.sleeping === 'boolean') {
          return { asleep: leaf.sleeping, source: leaf.sleeping ? '桌宠「睡觉」状态' : '桌宠「起来」状态' };
        }
        said = String(j?.pets?.[petId]?.say?.data?.text ?? '');
      }
    } catch { /* /state 不可用就只靠对话文本 */ }

    // 去重：/state.say.text 往往就是 memory 里最新那条 assistant，别把同一句算两遍
    const texts = [...new Set([said, ...recentAssistantTexts(memoryPath, memoryEntry, petId, 3)].filter(Boolean))];
    if (texts.length === 0) return null;
    // 清醒优先：只要最新一句里有她自己醒来的动作，立刻退出睡觉状态
    if (matches(texts[0], wakeWords)) return { asleep: false, source: '她自己醒了' };
    // 睡觉要连续几句都在演，避免「睡着了都这么坏」（说的是哥哥）这种一句带偏
    const hits = texts.slice(0, 3).filter((t) => matches(t, sleepWords)).length;
    if (hits >= 2) return { asleep: true, source: '最近几句都在睡' };
    return null;
  }

  /** 重新识别；只在结论真的翻转时写盘。@returns {{changed:boolean, asleep:boolean, source:string}} */
  async function refresh() {
    const before = asleep;
    const found = await detect();
    if (found && found.asleep !== asleep) {
      asleep = found.asleep;
      source = found.source;
      persist();
      log(`溪颜状态切换：${before ? '睡觉' : '清醒'} → ${asleep ? '睡觉' : '清醒'}（${source}）`);
    }
    return { changed: !!(found && found.asleep !== before), asleep, source };
  }

  /** 哥哥明确叫醒 / 手动标记，立即覆盖。 */
  function noteWake(reason = '哥哥叫醒') {
    const before = asleep;
    asleep = false;
    source = reason;
    persist();
    if (before) log(`溪颜状态切换：睡觉 → 清醒（${reason}）`);
    return { changed: before, asleep, source };
  }
  function noteSleep(reason = '手动标记睡觉') {
    const before = asleep;
    asleep = true;
    source = reason;
    persist();
    if (!before) log(`溪颜状态切换：清醒 → 睡觉（${reason}）`);
    return { changed: !before, asleep, source };
  }

  return {
    get asleep() { return asleep; },
    get source() { return source; },
    get updatedAt() { return updatedAt; },
    refresh, noteWake, noteSleep,
    summary() { return `${asleep ? '睡觉' : '清醒'}（${source}）`; },
    /** 离线测试用：直接喂一段文本看文本判据的结果 */
    _detectText(texts, wake = wakeWords, sleep = sleepWords) {
      const list = (Array.isArray(texts) ? texts : [texts]).filter(Boolean);
      if (list.length === 0) return null;
      if (matches(list[0], wake)) return { asleep: false, source: '她自己醒了' };
      return list.slice(0, 3).filter((t) => matches(t, sleep)).length >= 2
        ? { asleep: true, source: '最近几句都在睡' }
        : null;
    },
  };
}
