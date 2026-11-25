/**
 * 定时问候 World：每天固定时刻往事件总线推一条能唤醒她的事件，
 * 由人格自己决定要不要给主人发消息（用当前会话的消息工具）。
 *
 * 只读本地时钟和 config.json，不联网、不调用模型。
 * 配置改了不用重启：每 20 秒按 mtime 检查一次 config.json 里的 worlds.greetings。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ID = 'greetings';
const LABEL = '定时问候';

const DEFAULTS = {
  enabled: false,
  target: '10000',
  morning: '08:30',
  night: '23:30',
  timezone: 'Asia/Shanghai',
  catchUpMinutes: 20,
};

const SLOTS = [
  { key: 'morning', label: '早安' },
  { key: 'night', label: '晚安' },
];

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 'HH:MM' → 当天的分钟数；不合法返回 null。 */
function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(asText(value));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function two(n) {
  return String(n).padStart(2, '0');
}

/** 按指定时区取“今天”和“现在几点”。 */
function clockParts(now, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const o = {};
  for (const p of fmt.formatToParts(now)) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, minutes: Number(o.hour) * 60 + Number(o.minute) };
}

class GreetingsWorld {
  constructor(ctx = {}) {
    this.id = ID;
    this.cfg = ctx.cfg ?? { ...DEFAULTS };
    this.botDir = ctx.botDir ?? process.cwd();
    this.dataDir = ctx.dataDir ?? process.cwd();
    this.host = null;
    this.timer = null;
    this.state = { morning: '', night: '' };
    this.cfgCache = { mtime: -1, section: null };
    this.loadState();
  }

  #raw(key) {
    const v = this.cfg?.[key];
    return v === undefined || v === null ? DEFAULTS[key] : v;
  }

  #statePath() {
    return join(this.dataDir, 'greetings.json');
  }

  loadState() {
    try {
      const p = this.#statePath();
      if (!existsSync(p)) return;
      const o = JSON.parse(readFileSync(p, 'utf8'));
      if (o && typeof o === 'object') {
        this.state = { morning: String(o.morning ?? ''), night: String(o.night ?? '') };
      }
    } catch {
      /* 状态文件坏了就当今天还没发过，最多多一句问候 */
    }
  }

  saveState() {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.#statePath(), `${JSON.stringify(this.state, null, 1)}\n`, 'utf8');
    } catch {
      /* 写不进去只丢当天的去重，不影响运行 */
    }
  }

  /** config.json 里的 worlds.greetings；按 mtime 缓存，改完 20 秒内生效。 */
  #section() {
    const p = join(this.botDir, 'config.json');
    try {
      const mtime = statSync(p).mtimeMs;
      if (this.cfgCache.mtime === mtime && this.cfgCache.section) return this.cfgCache.section;
      const o = JSON.parse(readFileSync(p, 'utf8'));
      const section = (o?.worlds?.greetings ?? null) || {};
      this.cfgCache = { mtime, section };
      return section;
    } catch {
      return this.cfgCache.section ?? {};
    }
  }

  #get(key) {
    const v = this.#section()[key];
    return v === undefined || v === null ? this.#raw(key) : v;
  }

  async start(host) {
    this.host = host;
    void this.tick().catch(() => {});
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 20_000);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.host = null;
  }

  tools() {
    return [];
  }

  envPromptVars() {
    return null;
  }

  async tick() {
    const host = this.host;
    if (!host) return;
    if (this.#get('enabled') === false) return;

    const tz = asText(this.#get('timezone')) || DEFAULTS.timezone;
    const { date, minutes } = clockParts(new Date(), tz);
    const catchUp = Math.max(0, Number(this.#get('catchUpMinutes')) || 0);
    const target = asText(this.#get('target')) || DEFAULTS.target;

    for (const slot of SLOTS) {
      const at = parseHHMM(this.#get(slot.key));
      if (at === null) continue;
      if (this.state[slot.key] === date) continue;
      const delta = minutes - at;
      if (delta < 0 || delta > catchUp) continue;

      this.state[slot.key] = date;
      this.saveState();

      const hhmm = `${two(Math.floor(at / 60))}:${two(at % 60)}`;
      await host.pushEvent(
        {
          type: 'greetings.due',
          ts: new Date().toISOString(),
          source: this.id,
          origin: 'internal',
          senderKey: this.id,
          text:
            `定时问候(${slot.label})：现在是 ${hhmm}。` +
            `要不要给主人 private:${target} 说句话（用 qq_draft 带上 send:true）？` +
            `想发就发，不想发就保持安静，不用解释自己为什么没发。`,
          meta: { slot: slot.key, target },
        },
        { trigger: slot.key === 'night' ? 'piggyback' : 'flush' },
      );
    }
  }
}

export const definition = {
  id: ID,
  label: LABEL,
  defaults: () => ({ ...DEFAULTS }),
  create: (ctx) => new GreetingsWorld(ctx),
  describe: {
    tools: [],
    events: [
      {
        type: 'greetings.due',
        description: {
          zh: '到了配置的固定时刻（默认早安 08:30、晚安 23:30）：提醒她可以主动给主人发一条消息。',
          en: 'A configured fixed time was reached (morning 08:30 / night 23:30 by default): a cue that she may message her owner.',
        },
      },
    ],
  },
};

export default definition;
