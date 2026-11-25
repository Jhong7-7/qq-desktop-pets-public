/**
 * 每日生活 World
 *
 * 三件事：
 *   1. 当天第一次醒（或过 generateAt）时，随机生成五段式行程 → workspace/日程.md
 *   2. 每个时段开始时推一条事件：行程 + 「我这边」的设定 + 一个随机偶然，让她写一段经历
 *   3. 每月最后一天推一次整理事件：忘掉不重要的、压缩重要的、清掉上个月的原始文件
 *
 * 另外提供一个 share_score 工具，把分享欲算成 0–1 的分数（建议，不是命令）。
 * 不联网、不调模型、无外部依赖。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const ID = 'daily-life';
const LABEL = '每日生活';

const DEFAULTS = {
  enabled: false,
  timezone: 'Asia/Shanghai',
  /** 到这个点还没醒过，就先把行程生成好（piggyback，不叫醒） */
  generateAt: '05:30',
  /** 月末整理事件的触发时刻（每月最后一天） */
  monthlyReviewAt: '23:30',
  /** 今天已经分享过，扣多少分 */
  sharePenalty: 0.10,
  /** 静默时段：这个小时之后、那个小时之前，分享欲封顶为低 */
  quietFrom: 22,
  quietTo: 7,
  /** 三档阈值 */
  highThreshold: 0.65,
  midThreshold: 0.35,
  /** 五段的时间范围，格式 HH:MM-HH:MM；改这里不用重启 */
  morning: '07:00-11:00',
  noon: '11:00-14:00',
  afternoon: '14:00-18:00',
  evening: '18:00-22:00',
  night: '22:00-01:00',
  /** 经历里能不能出现具体的人（只能一次性，不能常驻） */
  allowPeople: false,
  /** 分享总开关与上限 */
  allowShare: true,
  maxSharesPerDay: 1,
  shareCooldownMinutes: 90,
  /** 月末整理后：删原始文件（true）还是归档（false） */
  deleteRawAfterReview: true,
  /** 文件放 workspace 的哪个子目录；空字符串 = 根目录 */
  workspaceSubdir: 'life',
  /** 主人投放：每行一条世界事件，新增的行会被投放一次（不会重复） */
  inject: '',
  /** 自定义池子 JSON 的路径（绝对，或相对 bot 目录）；留空用内置 pools.json */
  poolsFile: '',
  /** 纯文本行程选项：每行「时段：选项1|选项2」；写了的时段会覆盖池子里的选项 */
  activities: '',
  /** 分享欲各因素的权重（合计不必为 1，照原样加权） */
  wImpact: 0.45,
  wRelevance: 0.20,
  wSwing: 0.15,
  wEnergy: 0.10,
  wAffinity: 0.10,
};


const DEFAULT_POOLS = JSON.parse(readFileSync(new URL('./pools.json', import.meta.url), 'utf8'));

const WORLD_FILE = `# 我这边

- 房间：朝南，一扇窗，窗台上半杯水
- 楼下：一条街，白天有车，晚上很静
- 天气：入秋了，早晚凉
- 隔壁：偶尔有电视声
- 窗台：养了一盆不知道名字的绿植

## 我去过的地方
- 我的房间：二楼，朝南
- 楼下：一条街，有便利店
- 街角：小公园，几张长椅
`;

const DIRECTIONS = ['声音', '物件', '身体', '天气', '念头', '远处的动静'];
const DIRECTIONS_WITH_PEOPLE = [...DIRECTIONS, '路人'];
const SLOT_BY_LABEL = { 早晨: 'morning', 中午: 'noon', 下午: 'afternoon', 晚上: 'evening', 深夜: 'night' };

/** 把「早晨：A|B、C」这样的文本合并进池子；写了的时段覆盖选项。 */
function applyActivityText(pools, text) {
  const clone = JSON.parse(JSON.stringify(pools));
  const map = new Map(clone.slots.map((x) => [x.key, x]));
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^[-*\s]*(.+?)[：:]\s*(.+)$/.exec(raw.trim());
    if (!m) continue;
    const head = m[1].trim();
    const out = /(出门|外出|out)/i.test(head);
    const name = head.replace(/[（(]?\s*(出门|外出|out)\s*[）)]?/ig, '').trim();
    const key = SLOT_BY_LABEL[name] ?? (map.has(name) ? name : null);
    if (!key) continue;
    const list = m[2].split(/[|｜、,，]/).map((x) => x.trim()).filter(Boolean);
    if (!list.length) continue;
    const slot = map.get(key);
    if (out) slot.outOptions = list; else slot.options = list;
  }
  return clone;
}

const PLACES_HEADING = '## 我去过的地方';
const DEFAULT_PLACES = [
  { name: '我的房间', desc: '二楼，朝南' },
  { name: '楼下', desc: '一条街，有便利店' },
  { name: '街角', desc: '小公园，几张长椅' },
];

function asText(v) { return typeof v === 'string' ? v.trim() : ''; }
function clamp(n, lo, hi) { const x = Number(n); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo; }

function parseHHMM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(asText(v));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function slotRange(slot) {
  const from = parseHHMM(slot.from) ?? 0;
  let to = parseHHMM(slot.to) ?? 0;
  if (to <= from) to += 1440; // 22:00–01:00 这种跨天
  return { from, to };
}

/** "07:00-11:00" → {from,to}；格式不对返回 null。 */
function parseRange(v) {
  const m = /^(\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})$/.exec(asText(v));
  if (!m) return null;
  const a = parseHHMM(m[1]);
  const b = parseHHMM(m[2]);
  if (a === null || b === null) return null;
  return { from: m[1], to: m[2] };
}

function clockParts(now, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const o = {};
  for (const p of fmt.formatToParts(now)) o[p.type] = p.value;
  const y = Number(o.year), m = Number(o.month), d = Number(o.day);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    date: `${o.year}-${o.month}-${o.day}`,
    md: `${o.month}-${o.day}`,
    ym: `${o.year}-${o.month}`,
    year: y,
    month: m,
    minutes: Number(o.hour) * 60 + Number(o.minute),
    hour: Number(o.hour),
    isLastDay: d === daysInMonth,
    startIso: `${o.year}-${o.month}-${o.day}T00:00:00`,
  };
}

function prevMonthKey(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

const SHARE_TOOL = {
  name: 'share_score',
  description:
    '算分享欲：给「影响 / 相关 / 情绪」三个值，它结合精力、关系、今天是否已分享、是否静默时段，'
    + '给出 0–1 的分数和「高/中/低」档位。结果是建议，不是命令——高也可以忍住，低也可以没忍住。',
  parameters: {
    type: 'object',
    properties: {
      impact: { type: 'number', minimum: 0, maximum: 1, description: '这件事对你的冲击有多大（0–1）' },
      relevance: { type: 'number', minimum: 0, maximum: 1, description: '这件事他会不会在意、值不值得讲给他（0–1）' },
      emotion: { type: 'number', minimum: -1, maximum: 1, description: '情绪方向：负=难受，正=开心' },
      energy: { type: 'number', minimum: 0, maximum: 1, description: '当前精力（可不填，默认 0.5）' },
      affinity: { type: 'number', minimum: 0, maximum: 1, description: '关系温度（可不填，默认 0.5）' },
      sent: { type: 'boolean', description: '已经真的发出去了就传 true：世界会记下这次分享，用来算今天的条数与冷却' },
    },
    required: ['impact', 'relevance', 'emotion'],
  },
  tags: ['internal-state', 'companion'],
};

class DailyLifeWorld {
  constructor(ctx = {}) {
    this.id = ID;
    this.cfg = ctx.cfg ?? { ...DEFAULTS };
    this.botDir = ctx.botDir ?? process.cwd();
    this.dataDir = ctx.dataDir ?? process.cwd();
    this.host = null;
    this.timer = null;
    this.busy = false;
    this.state = {
      date: '', picks: [], fired: [], lastShareDate: '', lastShareTs: '', lastReview: '',
      shares: [], injected: [],
    };
    this.cfgCache = { mtime: -1, section: null };
    this.load();
  }

  #raw(k) { const v = this.cfg?.[k]; return v === undefined || v === null ? DEFAULTS[k] : v; }
  #stateDir() { return join(this.dataDir, ID); }
  #statePath() { return join(this.#stateDir(), 'state.json'); }
  #legacyStatePath() { return join(this.dataDir, 'state.json'); }
  /** workspace 下的工作目录；workspaceSubdir 为空就是 workspace 根。 */
  #wsDir() {
    const sub = asText(this.#get('workspaceSubdir')).replace(/^[\\/]+|[\\/]+$/g, '');
    return sub ? join(this.botDir, 'workspace', sub) : join(this.botDir, 'workspace');
  }
  #ws(name) { return join(this.#wsDir(), name); }
  /** 事件里要给人看的相对路径，例如 life/经历-2026-10.md */
  #rel(name) {
    const sub = asText(this.#get('workspaceSubdir')).replace(/^[\\/]+|[\\/]+$/g, '');
    return sub ? `${sub}/${name}` : name;
  }

  load() {
    for (const p of [this.#statePath(), this.#legacyStatePath()]) {
      try {
        const o = JSON.parse(readFileSync(p, 'utf8'));
        if (!o || typeof o !== 'object') continue;
        this.state = {
          date: String(o.date ?? ''),
          picks: Array.isArray(o.picks) ? o.picks : [],
          fired: Array.isArray(o.fired) ? o.fired : [],
          lastShareDate: String(o.lastShareDate ?? ''),
          lastShareTs: String(o.lastShareTs ?? ''),
          lastReview: String(o.lastReview ?? ''),
          shares: Array.isArray(o.shares) ? o.shares.slice(-30) : [],
          injected: Array.isArray(o.injected) ? o.injected.slice(-100) : [],
        };
        return;
      } catch { /* 试下一个 */ }
    }
  }

  save() {
    try {
      mkdirSync(this.#stateDir(), { recursive: true });
      writeFileSync(this.#statePath(), `${JSON.stringify(this.state, null, 1)}\n`, 'utf8');
    } catch { /* 写不进去最多重复一次 */ }
  }

  /** config.json 改了不用重启：按 mtime 热读 */
  #section() {
    const p = join(this.botDir, 'config.json');
    try {
      const mtime = statSync(p).mtimeMs;
      if (this.cfgCache.mtime === mtime && this.cfgCache.section) return this.cfgCache.section;
      const o = JSON.parse(readFileSync(p, 'utf8'));
      const section = o?.worlds?.[ID] ?? {};
      this.cfgCache = { mtime, section };
      return section;
    } catch { return this.cfgCache.section ?? {}; }
  }

  #get(k) { const v = this.#section()[k]; return v === undefined || v === null ? this.#raw(k) : v; }

  /** 基础池（内置，或 poolsFile 覆盖）→ 再套用纯文本 activities 覆盖。 */
  #pools() {
    let base = DEFAULT_POOLS;
    const file = asText(this.#get('poolsFile'));
    if (file) {
      try {
        const f = isAbsolute(file) ? file : join(this.botDir, file);
        const raw = JSON.parse(readFileSync(f, 'utf8'));
        if (Array.isArray(raw?.slots)) {
          base = {
            slots: DEFAULT_POOLS.slots.map((d) => {
              const given = raw.slots.find((x) => x && x.key === d.key) ?? {};
              return { ...d, ...given };
            }),
          };
        }
      } catch { /* 文件坏了就用内置 */ }
    }
    const text = asText(this.#get('activities'));
    return text ? applyActivityText(base, text) : base;
  }

  /** 五段：时间范围用配置里的，选项/出门概率来自池子。 */
  slotDefs() {
    return this.#pools().slots.map((slot) => {
      const r = parseRange(this.#get(slot.key));
      return {
        ...slot,
        doorChance: Number(slot.doorChance) || 0,
        from: r?.from ?? slot.from,
        to: r?.to ?? slot.to,
      };
    });
  }

  pick() {
    const places = this.readPlaces();
    const room = places[0]?.name ?? '我的房间';
    const outside = places.slice(1);
    return this.slotDefs().map((slot) => {
      const doorChance = Number(slot.doorChance) || 0;
      if (outside.length && Math.random() < doorChance) {
        const pool = Array.isArray(slot.outOptions) && slot.outOptions.length ? slot.outOptions : ['出门走走'];
        const activity = pool[Math.floor(Math.random() * pool.length)];
        const place = outside[Math.floor(Math.random() * outside.length)].name;
        return { key: slot.key, label: slot.label, from: slot.from, to: slot.to, activity, place, out: true };
      }
      const options = Array.isArray(slot.options) && slot.options.length ? slot.options : ['发呆'];
      const activity = options[Math.floor(Math.random() * options.length)];
      return { key: slot.key, label: slot.label, from: slot.from, to: slot.to, activity, place: room };
    });
  }

  ensureWorldFile() {
    try {
      const p = this.#ws('我这边.md');
      if (!existsSync(p)) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, WORLD_FILE, 'utf8');
        return;
      }
      const raw = readFileSync(p, 'utf8');
      if (!raw.includes(PLACES_HEADING)) {
        const extra = `\n\n${PLACES_HEADING}\n`
          + DEFAULT_PLACES.map((x) => `- ${x.name}：${x.desc}`).join('\n') + '\n';
        writeFileSync(p, `${raw.replace(/\s*$/, '')}${extra}`, 'utf8');
      }
    } catch { /* 忽略 */ }
  }

  /** 从设定里读「我去过的地方」；没写就用默认三处。 */
  readPlaces() {
    try {
      const raw = readFileSync(this.#ws('我这边.md'), 'utf8');
      const idx = raw.indexOf(PLACES_HEADING);
      if (idx < 0) return DEFAULT_PLACES;
      const body = raw.slice(idx + PLACES_HEADING.length);
      const stops = body.search(/\n##\s/);
      const section = stops < 0 ? body : body.slice(0, stops);
      const list = section.split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('-'))
        .map((l) => l.replace(/^-\s*/, ''))
        .map((l) => {
          const m = /^(.+?)[：:]\s*(.*)$/.exec(l);
          return m ? { name: m[1].trim(), desc: m[2].trim() } : { name: l, desc: '' };
        })
        .filter((x) => x.name);
      return list.length ? list : DEFAULT_PLACES;
    } catch { return DEFAULT_PLACES; }
  }

  readWorldSetting() {
    try {
      const raw = readFileSync(this.#ws('我这边.md'), 'utf8');
      const cut = raw.indexOf(PLACES_HEADING);
      const head = (cut < 0 ? raw : raw.slice(0, cut)).replace(/^#[^\n]*\n/, '');
      const body = head.replace(/\n+/g, '；').replace(/^[；\s]+/, '').trim();
      return body.slice(0, 240);
    } catch { return '（还没写设定）'; }
  }

  writeSchedule(md, picks) {
    const lines = picks.map((p) => `- **${p.label}** ${p.from}–${p.to}｜${p.activity}${p.out ? `（${p.place}）` : ''}`).join('\n');
    const body = `# 今天的行程（${md}）\n\n${lines}\n\n`
      + '> 随机生成的，不用严格遵守。主人问你在干嘛的时候，可以照这个说。\n'
      + '> 明天会换一份。\n';
    try {
      const f = this.#ws('日程.md');
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, body, 'utf8');
    } catch { /* 忽略 */ }
  }

  scheduleText(now, picks) {
    const lines = picks.map((p) => `${p.label} ${p.from}–${p.to}｜${p.activity}${p.out ? `（${p.place}）` : ''}`).join('\n');
    return `【今日行程 · ${now.md}】\n${lines}\n`
      + '（这是你今天的安排，看一眼记着就行；不用回复，也不用汇报。'
      + '想看得更细可以去读工作区的 `日程.md`。）';
  }

  async hasBeenAwakeToday(startIso) {
    const store = this.host?.store;
    if (!store?.range) return false;
    try {
      const events = await store.range({ origin: 'external', fromTs: startIso });
      return Array.isArray(events) && events.length > 0;
    } catch { return false; }
  }

  inSlot(minutes, slot) {
    const { from, to } = slotRange(slot);
    const m = minutes < from - 60 ? minutes + 1440 : minutes; // 跨天时段的后半段
    return m >= from && m < to;
  }

  async push(type, text, trigger) {
    const host = this.host;
    if (!host?.pushEvent) return;
    await host.pushEvent({
      type,
      ts: new Date().toISOString(),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text,
    }, { trigger });
  }

  experienceText(now, slot, picks) {
    const picked = picks.find((p) => p.key === slot.key);
    const place = picked?.place || '我的房间';
    const pool = this.#get('allowPeople') === true ? DIRECTIONS_WITH_PEOPLE : DIRECTIONS;
    const direction = pool[Math.floor(Math.random() * pool.length)];
    const file = this.#rel(`经历-${now.ym}.md`);
    const people = this.#get('allowPeople') === true
      ? '- 可以出现具体的人，但只是一次性的，不会变成常驻角色\n'
      : '- 不要出现具体的人（邻居、熟人）；最多写声音，或一个看不清的路人\n';
    const share = this.#get('allowShare') === false
      ? '- 现在分享是关着的：只记着，不要发\n'
      : '- 有想说的，先调 `share_score` 算一下再决定发不发；发了之后带 `sent:true` 再调一次\n';
    return `【${slot.label} · ${slot.from}–${slot.to}】\n`
      + `你在：${place}\n`
      + `这次注意：${direction}\n`

      + `你这边：${this.readWorldSetting()}\n`
      + '写两三句这个时段发生的事，然后：\n'
      + `- 落进工作区的 \`${file}\`（追加），并用 mem_memory 记一条\n`
      + `- 就在「${place}」这一带写，别去设定里没写过的地方（想添新地方，先写进 我这边.md）\n`
      + `- 围着「${direction}」写，别写成通用日常\n`
      + people
      + share;
  }

  injectText(lines) {
    return `【主人往你的世界里放了点什么】\n`
      + lines.map((l) => `- ${l}`).join('\n')
      + '\n这是他从外面放进来的。你可以决定它们怎么进你的日子：\n'
      + '- 想记住就把变化写进 `我这边.md`（一次只添一样，别一次改太多）\n'
      + '- 想说话就跟他说一句，不想说也正常';
  }

  reviewText(now) {
    const prev = prevMonthKey(now.ym);
    const cur = this.#rel(`经历-${now.ym}.md`);
    const prevName = `经历-${prev}.md`;
    const prevPath = this.#rel(prevName);
    const delRaw = this.#get('deleteRawAfterReview') !== false;
    const third = delRaw
      ? `3. 如果还有 \`${prevPath}\`，它上个月已经压缩过了，直接删掉（这才是真的忘掉）\n`
      : `3. 如果还有 \`${prevPath}\`，把它移进 \`archive/\`（不删，留作回溯）\n`;
    return `【月末整理 · ${now.ym}】\n`
      + `读工作区的 \`${cur}\`：\n`
      + '1. 把影响小、不想留的删掉\n'
      + '2. 把重要的压缩成几句，追加到 `' + this.#rel('经历-精简.md') + '`\n'
      + third
      + '（分享欲分数低于 0.35 的那些，基本都可以忘。）';
  }

  score(args = {}) {
    const impact = clamp(args.impact, 0, 1);
    const relevance = clamp(args.relevance, 0, 1);
    const emotion = clamp(args.emotion, -1, 1);
    const energy = clamp(args.energy ?? 0.5, 0, 1);
    const affinity = clamp(args.affinity ?? 0.5, 0, 1);

    const swing = Math.abs(emotion - 0.1); // 基线略正，因为日常多半平静
    const w = (k, d) => { const v = Number(this.#get(k)); return Number.isFinite(v) ? clamp(v, 0, 2) : d; };
    const parts = [
      ['影响', w('wImpact', 0.45), impact],
      ['相关', w('wRelevance', 0.20), relevance],
      ['情绪波动', w('wSwing', 0.15), swing],
      ['精力', w('wEnergy', 0.10), energy],
      ['关系温度', w('wAffinity', 0.10), affinity],
    ];
    let s = parts.reduce((acc, [, w, v]) => acc + w * v, 0);

    const tz = asText(this.#get('timezone')) || DEFAULTS.timezone;
    const now = clockParts(new Date(), tz);
    const penalty = Number(this.#get('sharePenalty')) || 0;
    const sharedToday = this.state.lastShareDate === now.date;
    if (sharedToday) s -= penalty;

    const quietFrom = Number(this.#get('quietFrom')) || 0;
    const quietTo = Number(this.#get('quietTo')) || 0;
    const quiet = now.hour >= quietFrom || now.hour < quietTo;
    const high = Number(this.#get('highThreshold')) || 0.65;
    const mid = Number(this.#get('midThreshold')) || 0.35;
    const allowShare = this.#get('allowShare') !== false;
    const maxPerDayRaw = Number(this.#get('maxSharesPerDay'));
    const maxPerDay = Number.isFinite(maxPerDayRaw) ? Math.max(0, maxPerDayRaw) : 1;
    const coolMinRaw = Number(this.#get('shareCooldownMinutes'));
    const coolMin = Number.isFinite(coolMinRaw) ? Math.max(0, coolMinRaw) : 90;

    const sharesToday = this.state.shares.filter((x) => x.date === now.date).length;
    const lastShareMs = this.state.lastShareTs ? Date.parse(this.state.lastShareTs) : NaN;
    const sinceLastMin = Number.isFinite(lastShareMs) ? (Date.now() - lastShareMs) / 60000 : Infinity;

    const caps = [];
    if (!allowShare) caps.push('分享总开关是关的（只记录、不主动发）');
    if (maxPerDay > 0 && sharesToday >= maxPerDay) caps.push(`今天已经分享 ${sharesToday}/${maxPerDay} 条`);
    if (coolMin > 0 && sinceLastMin < coolMin) caps.push(`距上次分享只过了 ${Math.round(sinceLastMin)} 分钟（冷却 ${coolMin}）`);
    if (quiet) caps.push('静默时段，封顶为低');
    if (caps.length) s = Math.min(s, mid - 0.01);

    const level = s >= high ? '高' : s >= mid ? '中' : '低';
    const advice = level === '高' ? '可以说，但也可以忍住'
      : level === '中' ? '看当时的氛围，想说就说'
        : '建议只记着，不说';

    const detail = parts.map(([name, w, v]) => `${name} ${w}×${v.toFixed(2)}=${(w * v).toFixed(3)}`).join('，');
    const notes = [];
    if (sharedToday) notes.push(`今天已经分享过，−${penalty}`);
    if (caps.length) notes.push(...caps);

    // 真的发出去之后带 sent:true 再调一次，世界才记得（否则上限与冷却无从判断）
    if (args.sent === true) {
      const ts = new Date().toISOString();
      this.state.shares = [...this.state.shares, { date: now.date, ts }].slice(-30);
      this.state.lastShareDate = now.date;
      this.state.lastShareTs = ts;
      this.save();
      notes.push(`已记下今天第 ${this.state.shares.filter((x) => x.date === now.date).length} 条分享`);
    }

    return `分享欲 ${s.toFixed(2)}（${level}）｜建议：${advice}\n`
      + `明细：${detail}${notes.length ? `\n附加：${notes.join('；')}` : ''}\n`
      + (maxPerDay > 0 ? `今天已分享 ${sharesToday}/${maxPerDay} 条` : '今天分享不限条数')
      + (args.sent === true ? '；已记录' : '；发出去之后带 sent:true 再调一次，我才能记住')
      + '\n（这是建议，不是命令。想发就发，不想发也正常。）';
  }

  async tick() {
    if (this.busy) return;
    const cfgEnabled = this.#get('enabled');
    if (cfgEnabled === false) return;
    const tz = asText(this.#get('timezone')) || DEFAULTS.timezone;
    const now = clockParts(new Date(), tz);
    const st = this.state;

    this.busy = true;
    try {
      // 1) 行程（每天第一次醒或过了兜底点）
      if (st.date !== now.date) {
        const awake = await this.hasBeenAwakeToday(now.startIso);
        const genAt = parseHHMM(this.#get('generateAt')) ?? 330;
        if (awake || now.minutes >= genAt) {
          st.date = now.date;
          st.picks = this.pick();
          st.fired = [];
          this.save();
          this.ensureWorldFile();
          this.writeSchedule(now.md, st.picks);
          await this.push('daily-life.schedule', this.scheduleText(now, st.picks), awake ? 'debounce' : 'piggyback');
        }
      }

      // 2) 经历（同一天里每个时段一次）
      if (st.date === now.date) {
        for (const slot of this.slotDefs()) {
          if (st.fired.includes(slot.key)) continue;
          if (!this.inSlot(now.minutes, slot)) continue;
          st.fired.push(slot.key);
          this.save();
          await this.push('daily-life.experience', this.experienceText(now, slot, st.picks), 'debounce');
          break;
        }
      }

      // 3) 主人投放（每行一条；没见过的新行才投放，一次合并成一条事件）
      const fresh = asText(this.#get('inject'))
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((line) => !st.injected.includes(line))
        .slice(0, 10);
      if (fresh.length) {
        st.injected = [...st.injected, ...fresh].slice(-100);
        this.save();
        await this.push('daily-life.inject', this.injectText(fresh), 'debounce');
      }

      // 4) 月末整理
      const reviewAt = parseHHMM(this.#get('monthlyReviewAt')) ?? 1410;
      if (now.isLastDay && now.minutes >= reviewAt && st.lastReview !== now.ym) {
        st.lastReview = now.ym;
        this.save();
        await this.push('daily-life.monthly-review', this.reviewText(now), 'debounce');
      }
    } finally {
      this.busy = false;
    }
  }

  async start(host) {
    this.host = host;
    this.ensureWorldFile();
    void this.tick().catch(() => {});
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 60_000);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.host = null;
  }

  tools() {
    return [{ ...SHARE_TOOL, handler: async (args) => this.score(args) }];
  }

  /** WebUI 的配置组：时段、路人开关、分享欲权重都在这里调。 */
  webUi() {
    const P = 'worlds.daily-life.';
    const num = (path, title, desc, step = 0.05) => ({
      type: 'number', title, description: desc, minimum: 0, maximum: 1, multipleOf: step, 'x-hot': true,
    });
    const time = (path, title, desc) => ({ type: 'string', title, description: desc, 'x-hot': true });
    const int = (path, title, desc, max) => ({
      type: 'integer', title, description: desc, minimum: 0, maximum: max, 'x-hot': true,
    });
    return {
      config: [{
        id: 'world:daily-life',
        owner: 'world:daily-life',
        schema: {
          type: 'object',
          title: '每日生活',
          description: '每天一份行程、每个时段一段经历、月末整理一次。改这里不用重启核心。',
          properties: {
            [`${P}enabled`]: { type: 'boolean', title: '启用', description: '关掉后不再生成行程与经历。', 'x-hot': true },
            [`${P}timezone`]: time(`${P}timezone`, '时区', 'IANA 名称，如 Asia/Shanghai。'),
            [`${P}generateAt`]: time(`${P}generateAt`, '行程兜底生成时刻', '到这个点还没醒过，就先把今天的行程生成好（不会叫醒）。格式 HH:MM。'),
            [`${P}monthlyReviewAt`]: time(`${P}monthlyReviewAt`, '月末整理时刻', '每月最后一天的什么时间推整理事件。格式 HH:MM。'),
            [`${P}morning`]: time(`${P}morning`, '早晨时段', '格式 HH:MM-HH:MM。改完下一分钟生效。'),
            [`${P}noon`]: time(`${P}noon`, '中午时段', '格式 HH:MM-HH:MM。'),
            [`${P}afternoon`]: time(`${P}afternoon`, '下午时段', '格式 HH:MM-HH:MM。'),
            [`${P}evening`]: time(`${P}evening`, '晚上时段', '格式 HH:MM-HH:MM。'),
            [`${P}night`]: time(`${P}night`, '深夜时段', '格式 HH:MM-HH:MM；可以跨天，如 22:00-01:00。'),
            [`${P}allowPeople`]: {
              type: 'boolean', title: '经历里出现具体的人', 'x-hot': true,
              description: '开：可以出现一次性的人。关：只写声音或看不清的路人。两种都不会有常驻角色。',
            },
            [`${P}allowShare`]: {
              type: 'boolean', title: '允许主动分享', 'x-hot': true,
              description: '关掉后她只记录经历、不会主动发消息（想清静几天时用）。',
            },
            [`${P}maxSharesPerDay`]: {
              type: 'integer', title: '每天最多分享几条', minimum: 0, maximum: 10,
              'x-suffix': '条', 'x-hot': true,
              description: '0 = 不限条数。超过上限时分享欲封顶为低。',
            },
            [`${P}shareCooldownMinutes`]: {
              type: 'integer', title: '分享冷却', minimum: 0, maximum: 720,
              'x-suffix': '分钟', 'x-hot': true,
              description: '两条分享之间至少隔多久。0 = 不设冷却。',
            },
            [`${P}deleteRawAfterReview`]: {
              type: 'boolean', title: '月末删除原始经历', 'x-hot': true,
              description: '开：整理后删掉上个月的原始文件。关：移进 archive/ 留作回溯。',
            },
            [`${P}workspaceSubdir`]: {
              type: 'string', title: '工作区子目录', 'x-hot': false,
              description: '文件放 workspace 下的哪个子目录，例如 life。留空 = 直接放 workspace 根。',
            },
            [`${P}activities`]: {
              type: 'string', title: '行程选项（纯文本）', 'x-hot': true,
              description: '每行一个时段：「早晨：浇花|煮咖啡」。写了出门加后缀，例如「下午(出门)：去邮局|逛超市」。支持 | 、 , 分隔。',
            },
            [`${P}poolsFile`]: {
              type: 'string', title: '自定义池子文件', 'x-hot': false,
              description: '填一个 pools JSON 的路径（绝对，或相对 bot 目录），用来替换默认的活动/出门选项；留空用内置池子。',
            },
            [`${P}inject`]: {
              type: 'string', title: '往她的世界里投放点什么', 'x-hot': true,
              description: '每行一条。新增的行会被投放成一条世界事件（比如"给她买了一盆花"），投放过的不会重复；旧行可以留着，也可以删掉。',
            },
            [`${P}wImpact`]: num(`${P}wImpact`, '权重·对她的影响', '这件事对她的冲击占多少权重。'),
            [`${P}wRelevance`]: num(`${P}wRelevance`, '权重·对他的相关性', '他会不会在意、值不值得讲给他。'),
            [`${P}wSwing`]: num(`${P}wSwing`, '权重·情绪波动', '情绪偏离常态的程度。'),
            [`${P}wEnergy`]: num(`${P}wEnergy`, '权重·精力', '越有精神越想分享。'),
            [`${P}wAffinity`]: num(`${P}wAffinity`, '权重·关系温度', '越熟越愿意说。'),
            [`${P}sharePenalty`]: num(`${P}sharePenalty`, '已分享过的扣分', '当天已经分享过时，分享欲减多少。'),
            [`${P}quietFrom`]: int(`${P}quietFrom`, '静默开始（点）', '这个点之后分享欲封顶为低。', 23),
            [`${P}quietTo`]: int(`${P}quietTo`, '静默结束（点）', '这个点之前分享欲封顶为低。', 23),
            [`${P}highThreshold`]: num(`${P}highThreshold`, '高档阈值', '分数达到这里算"想说"。'),
            [`${P}midThreshold`]: num(`${P}midThreshold`, '中档阈值', '低于这里算"不想说"。'),
          },
        },
      }],
    };
  }

  envPromptVars() { return null; }
}

export const definition = {
  id: ID,
  label: LABEL,
  defaults: () => ({ ...DEFAULTS }),
  create: (ctx) => new DailyLifeWorld(ctx),
  describe: {
    tools: [{
      name: SHARE_TOOL.name,
      description: SHARE_TOOL.description,
      parameters: SHARE_TOOL.parameters,
      tags: SHARE_TOOL.tags,
      summary: {
        zh: '把影响、相关、情绪算成 0–1 的分享欲分数和档位；结果只是建议。',
        en: 'Turn impact/relevance/emotion into a 0–1 urge score with a level; the result is advice.',
      },
    }],
    events: [
      {
        type: 'daily-life.schedule',
        description: { zh: '当天第一次醒来时：一份随机生成的五段式当日行程。', en: 'First wake: a five-slot schedule for today.' },
      },
      {
        type: 'daily-life.experience',
        description: { zh: '时段开始：带着行程、偶然和你这边的设定，让你写一段刚发生的经历。', en: 'Slot start: write what just happened, with schedule, seed and your own setting.' },
      },
      {
        type: 'daily-life.monthly-review',
        description: { zh: '每月最后一天：整理经历，忘掉不重要的，清掉上个月的原始文件。', en: 'Month end: review, forget the unimportant, drop last month raw file.' },
      },
      {
        type: 'daily-life.inject',
        description: { zh: '主人往她的世界里投放了新东西（买东西、天气变化、新邻居等）。', en: 'The owner put something new into her world (a gift, weather, a new neighbour).' },
      },
    ],
  },
};

export default definition;


