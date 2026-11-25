#!/usr/bin/env node
/**
 * dsh-pet-qq / pet-state.mjs —— 溪颜「吃东西」数值养成（方案2）的状态机。
 *
 * 两个数值 + 一个心愿食物，落盘到 JSON，重启桥不丢：
 *   hunger  饥饿度 0-100，越高越饿；随时间上升，投喂下降。
 *   energy  精力   0-100，越高越精神；随时间下降，投喂略回升。
 *   craving 心愿食物：她说 [想吃:XXX] 时记下，哥哥投喂时按它回应；带时间戳，过期作废。
 *
 * 关键设计：衰减按「距上次更新经过的真实时间」计算，不靠定时器累加。
 * 所以桥重启、机器关机、进程被杀都不会让数值错乱——下次读取时按真实经过时间补齐。
 *
 * 纯模块：不连 WS、不读 config.json（配置由 bridge.mjs 注入），带离线自测，方便单独测。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** 默认配置。bridge.mjs 用 config.petState 覆盖。 */
export const DEFAULT_PET_STATE_CONFIG = {
  enabled: false,
  stateFile: 'pet-state.json',
  // 衰减速率：每小时变化多少（0-100 刻度）
  hungerPerHour: 6,     // 饥饿度每小时 +6（约 16 小时从饱到饿透）
  energyPerHour: 4,     // 精力每小时 -4（约 24 小时从满到困透）
  // 投喂效果
  feedHunger: -45,      // 投喂后饥饿度下降
  feedEnergy: 8,        // 投喂后精力回升
  feedCooldownMs: 60000,// 投喂冷却，防连点刷数值
  // 心愿食物有效期（她说想吃之后多久内投喂还算数）
  cravingTtlMs: 30 * 60 * 1000,
  // 阈值：超过/低于即进入该状态描述
  hungryAt: 60,         // 饥饿度 >= 60 算「饿了」
  starvingAt: 85,       // 饥饿度 >= 85 算「饿扁了」
  tiredAt: 30,          // 精力 <= 30 算「困了」
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * @param {object} opts
 * @param {string} [opts.stateFile]      状态落盘路径（相对路径按 process.cwd()）
 * @param {object} [opts.config]         覆盖 DEFAULT_PET_STATE_CONFIG 的字段
 * @param {(msg:string)=>void} [opts.log]
 */
export function createPetState(opts = {}) {
  const cfg = { ...DEFAULT_PET_STATE_CONFIG, ...(opts.config ?? {}) };
  // opts.stateFile 优先于 config.stateFile（自测用临时文件，避免污染真实状态）
  if (opts.stateFile) cfg.stateFile = opts.stateFile;
  const file = isAbsolute(cfg.stateFile)
    ? cfg.stateFile
    : join(process.cwd(), cfg.stateFile);
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  // 落盘结构：{ hunger, energy, craving, cravingAt, updatedAt }
  let s = { hunger: 20, energy: 85, craving: '', cravingAt: 0, updatedAt: Date.now() };
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    s = {
      hunger: clamp(num(saved?.hunger, 20), 0, 100),
      energy: clamp(num(saved?.energy, 85), 0, 100),
      craving: typeof saved?.craving === 'string' ? saved.craving.slice(0, 120) : '',
      cravingAt: num(saved?.cravingAt, 0) || 0,
      updatedAt: num(saved?.updatedAt, Date.now()) || Date.now(),
    };
  } catch {
    /* 没有状态文件就从「微饿、精神」起步 */
  }

  function persist() {
    s.updatedAt = Date.now();
    try {
      writeFileSync(file, JSON.stringify(s, null, 2) + '\n', 'utf8');
    } catch (e) {
      log(`pet-state 落盘失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 按真实经过时间把数值推进到「现在」；只改内存，不写盘（读路径无需写）。 */
  function advanceTo(now = Date.now()) {
    const hours = Math.max(0, (now - s.updatedAt) / 3600000);
    if (hours > 0) {
      s.hunger = clamp(s.hunger + cfg.hungerPerHour * hours, 0, 100);
      s.energy = clamp(s.energy - cfg.energyPerHour * hours, 0, 100);
      s.updatedAt = now;
    }
    return s;
  }

  /** 心愿食物是否仍在有效期内。 */
  function hasCraving(now = Date.now()) {
    if (!s.craving) return false;
    if (!s.cravingAt) return true; // 老数据没时间戳，当作有效
    return now - s.cravingAt <= cfg.cravingTtlMs;
  }

  /** 当前状态快照（含派生状态词）。 */
  function snapshot(now = Date.now()) {
    advanceTo(now);
    let hungerWord = '还好';
    if (s.hunger >= cfg.starvingAt) hungerWord = '饿扁了';
    else if (s.hunger >= cfg.hungryAt) hungerWord = '饿了';
    let energyWord = '还行';
    if (s.energy <= cfg.tiredAt) energyWord = '困了';
    const craving = hasCraving(now) ? s.craving : '';
    return {
      hunger: Math.round(s.hunger),
      energy: Math.round(s.energy),
      hungerWord,
      energyWord,
      craving,
      hungry: s.hunger >= cfg.hungryAt,
      tired: s.energy <= cfg.tiredAt,
    };
  }

  /** 她写了 [想吃:XXX] → 记下心愿食物。 */
  function setCraving(food, now = Date.now()) {
    const cleaned = String(food ?? '').trim().slice(0, 120);
    if (!cleaned) return false;
    advanceTo(now);
    s.craving = cleaned;
    s.cravingAt = now;
    persist();
    log(`心愿食物：记下「${cleaned}」`);
    return true;
  }

  /**
   * 哥哥投喂。@returns {{ok:boolean, reason?:string, food?:string, snap:object}}
   * ok=false 的情况：冷却中、或数值已满（吃不下）。
   */
  function feed(now = Date.now()) {
    advanceTo(now);
    if (now - (s.lastFedAt ?? 0) < cfg.feedCooldownMs) {
      return { ok: false, reason: 'cooldown', snap: snapshot(now) };
    }
    if (s.hunger <= 5) {
      return { ok: false, reason: 'full', snap: snapshot(now) };
    }
    const food = hasCraving(now) ? s.craving : '';
    s.hunger = clamp(s.hunger + cfg.feedHunger, 0, 100);
    s.energy = clamp(s.energy + cfg.feedEnergy, 0, 100);
    s.craving = '';
    s.cravingAt = 0;
    s.lastFedAt = now;
    persist();
    log(`投喂：${food ? `她选的「${food}」` : '随便喂了点'}；饥饿 ${Math.round(s.hunger)} 精力 ${Math.round(s.energy)}`);
    return { ok: true, food, snap: snapshot(now) };
  }

  /** 注入给桌宠的状态提示。只在开启、且有明显状态（饿/困/有心愿）时返回内容。 */
  function stateHint(now = Date.now()) {
    const v = snapshot(now);
    const lines = [];
    if (v.hungry) {
      lines.push(v.hungerWord === '饿扁了'
        ? '（你现在饿得有点狠了。真饿了你会自然流露出想吃点什么，但别每句都喊饿——克制点，像真人。）'
        : '（你现在有点饿了。顺着话题可以流露出想吃东西的意思，但不必每句都说。）');
    }
    if (v.tired) {
      lines.push('（你现在有点困。说话可以慢一点、短一点，但别把困挂在每个句尾。）');
    }
    if (v.craving) {
      lines.push(`（你之前说过想吃「${v.craving}」。哥哥要是问你想吃什么、或说要喂你，你就按这个来，别临时改口说别的。）`);
    }
    if (lines.length === 0) return '';
    return ['', ...lines].join('\n');
  }

  return {
    get file() { return file; },
    get config() { return cfg; },
    snapshot,
    setCraving,
    feed,
    stateHint,
    /** 离线测试钩子：直接注入一份状态，跳过文件读写 */
    _reset(state, now = Date.now()) {
      s = {
        hunger: clamp(num(state?.hunger, 20), 0, 100),
        energy: clamp(num(state?.energy, 85), 0, 100),
        craving: String(state?.craving ?? '').slice(0, 120),
        cravingAt: num(state?.cravingAt, 0) || 0,
        lastFedAt: num(state?.lastFedAt, 0) || 0,
        updatedAt: now,
      };
    },
  };
}

/** 从桌宠回复里提取 [想吃:XXX]，返回 { food, clean } 或 null。 */
export function extractCravingMarker(text) {
  const raw = String(text ?? '');
  const m = /\[想吃[:：]\s*([^\]\n]{1,60})\]/.exec(raw);
  if (!m) return null;
  const food = m[1].trim();
  if (!food) return null;
  return { food, clean: raw.replace(m[0], '').trim() };
}

/** 哥哥的投喂口令识别。只认明确口令，避免「你吃了吗」误触。 */
export function detectFeedCommand(text) {
  const raw = String(text ?? '');
  const words = ['喂她', '喂你', '给她买的', '给他买的', '给你买的', '给她吃', '给你吃', '投喂', '请她吃', '请你吃', '买给她', '买给你'];
  for (const w of words) if (raw.includes(w)) return true;
  return false;
}

/** 注入给桌宠的说明：她想吃什么时用 [想吃:XXX] 标记，让桥记下来。 */
export const CRAVING_HINT = [
  '',
  '【吃东西】你能真的吃东西、会饿也会困。哥哥问你想吃什么、或你此刻真馋某个东西时，',
  '在这一轮回复里写一行标记把你馋的东西告诉桥（别把标记字面发给哥哥，桥会处理）：',
  '[想吃:草莓蛋糕]  例如你突然想起巷口那家店，就写 [想吃:那家草莓蛋糕]',
  '要写你此刻真的想吃的、具体一点，别每次都是同一个；不想吃就别写，哥哥问你时随口答也行。',
  '哥哥说要喂你时，就按你之前写的那个东西回应——吃到的是你自己挑的，别谢一句就完了，像真人那样有点小反应。',
].join('\n');

/** 离线自测：直接 node pet-state.mjs --test 运行。 */
export function petStateSelfTest() {
  const out = [];
  const t = (name, got, want) => out.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

  // 标记提取
  t('提取-普通', extractCravingMarker('好呀[想吃:草莓蛋糕]我也正想说')?.food, '草莓蛋糕');
  t('提取-剥标记', extractCravingMarker('好呀[想吃:草莓蛋糕]我也正想说')?.clean, '好呀我也正想说');
  t('提取-中文冒号', extractCravingMarker('[想吃：那家拉面]')?.food, '那家拉面');
  t('提取-无标记', extractCravingMarker('随便吃点就好'), null);
  t('提取-空内容', extractCravingMarker('[想吃:]'), null);

  // 口令识别
  t('口令-喂她', detectFeedCommand('喏，喂她吃吧'), true);
  t('口令-给你买的', detectFeedCommand('给你买的，尝尝'), true);
  t('口令-误触排除', detectFeedCommand('你吃饭了吗'), false);
  t('口令-误触排除2', detectFeedCommand('今天吃了没'), false);

  // 状态机：用一个不落盘的临时实例（_reset 跳过文件）
  const st = createPetState({ stateFile: 'pet-state.test.json', config: { ...DEFAULT_PET_STATE_CONFIG } });
  const NOW = 1_700_000_000_000;
  st._reset({ hunger: 70, energy: 40, craving: '草莓蛋糕', cravingAt: NOW, lastFedAt: 0 }, NOW);
  const v = st.snapshot(NOW);
  t('状态-饿了', v.hungerWord, '饿了');
  t('状态-不困', v.tired, false);
  t('状态-心愿有效', v.craving, '草莓蛋糕');
  const hint = st.stateHint(NOW);
  t('提示-含饿', hint.includes('饿'), true);
  t('提示-含心愿', hint.includes('草莓蛋糕'), true);

  // 衰减：8 小时后更饿更困（hunger 70+48→封顶100；energy 40-32→8）
  const v2 = st.snapshot(NOW + 8 * 3600000);
  t('衰减-更饿', v2.hunger >= 100, true);
  t('衰减-更困', v2.energy, 8);

  // 投喂：饥饿下降、心愿被消费
  st._reset({ hunger: 80, energy: 30, craving: '那家拉面', cravingAt: NOW, lastFedAt: 0 }, NOW);
  const fed = st.feed(NOW);
  t('投喂-成功', fed.ok, true);
  t('投喂-按心愿', fed.food, '那家拉面');
  t('投喂-饥饿下降', fed.snap.hunger, 35);
  t('投喂-精力回升', fed.snap.energy, 38);
  t('投喂-心愿清空', fed.snap.craving, '');

  // 冷却：紧接着再喂失败
  const fed2 = st.feed(NOW + 1000);
  t('投喂-冷却拦截', fed2.ok, false);

  // 心愿过期
  st._reset({ hunger: 50, energy: 70, craving: '过期的蛋糕', cravingAt: NOW, lastFedAt: 0 }, NOW);
  t('心愿-过期失效', st.snapshot(NOW + 31 * 60000).craving, '');

  const pass = out.filter((x) => x.ok).length;
  return { pass, total: out.length, cases: out };
}

if (process.argv.includes('--test')) {
  const r = petStateSelfTest();
  for (const c of r.cases) {
    console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
  }
  console.log(`\n${r.pass}/${r.total} 通过`);
  process.exitCode = r.pass === r.total ? 0 : 1;
}
