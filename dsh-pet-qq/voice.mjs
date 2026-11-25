/**
 * voice.mjs —— 让 dsh 的溪颜也能在 QQ 发语音，并支持运行时换音色。
 *
 * 思路：复用 Coo 的 gpt-sovits 插件在本地开的语音接口（默认 127.0.0.1:9880），
 * 它支持 POST /tts { text, voice } → 直接回 WAV，`voice` 可点名已登记的音色
 * （预设 xll 或自定义音色名 / id）。QQ 侧 OneBot v11 用 record 段发 base64 音频，
 * 协议端（SnowLuma/NapCat）自己把 WAV 转成 SILK，不需要额外编码器。
 *
 * 触发约定：桌宠想说语音时，把要念的话写进 [voice]...[/voice]；
 * 桥在 deliver 里认这个标记，合成后发一条语音条，并把标记从气泡文字里剥掉。
 * 合成失败一律降级成纯文字——绝不让语音拖垮正常的 QQ 回复链路。
 *
 * 换音色两条路：
 *   1) 哥哥在私聊说「换成卡提希娅的声音」→ bridge 用 detectVoiceSwitch 识别 → setVoice；
 *   2) 溪颜自己想换 → 回复里写 [voice:use 卡提希娅] → bridge 用 extractVoiceUse 识别 → setVoice。
 * setVoice 只改运行时音色，并回调 cfg.onVoiceChange 让 bridge 写回配置持久化。
 */

/** 带超时的 fetch（Node 18+ 内置 fetch + AbortSignal.timeout）。 */
async function fetchWithTimeout(url, options, ms) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
}

/** 转义正则里的特殊字符。 */
function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 在 WAV 的 data 块末尾补一段静音（默认 300ms）。
 *
 * 背景：桥把 WAV 交给 OneBot 协议端转 SILK 发出。句尾轻声语气词（啦/嘛/呀）
 * 能量低，转码时容易被当静音裁掉，听感上就是「最后一个字没录上」。合成后补
 * 一小段静音当缓冲，让转码的静音检测把真正的尾字留下来。
 *
 * 只处理「data 是最后一个块」的单声道 PCM WAV（gpt-sovits 的合成结果正是这种）；
 * 其它结构一律原样返回，绝不把音频改坏。同时同步刷新 RIFF 与 data 两个长度字段。
 */
export function padWavTail(wav, ms) {
  if (!Buffer.isBuffer(wav) || !Number.isFinite(ms) || ms <= 0) return wav;
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return wav;
  let sampleRate = 0, channels = 0, bits = 0, dataAt = -1, dataSize = 0;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 22 <= wav.length) {
      channels = wav.readUInt16LE(at + 10);
      sampleRate = wav.readUInt32LE(at + 12);
      bits = wav.readUInt16LE(at + 22);
    }
    if (id === 'data') { dataAt = at; dataSize = size; break; }
    at += 8 + size + (size & 1);
  }
  // 结构不满足就原样返回：单声道、16bit、采样率正常、data 是最后一块、长度自洽。
  if (dataAt < 0 || !sampleRate || channels !== 1 || bits !== 16) return wav;
  const dataStart = dataAt + 8;
  if (dataStart + dataSize > wav.length || dataStart + dataSize !== wav.length) return wav;
  const perSample = channels * (bits / 8);
  const padBytes = Math.round((sampleRate * ms) / 1000) * perSample;
  if (padBytes <= 0) return wav;
  const out = Buffer.alloc(wav.length + padBytes);
  wav.copy(out, 0);
  out.fill(0, wav.length);                       // 静音 = PCM 全 0
  out.writeUInt32LE(wav.readUInt32LE(4) + padBytes, 4);       // RIFF size
  out.writeUInt32LE(dataSize + padBytes, dataAt + 4);          // data size
  return out;
}

/** 提取 [voice]...[/voice] / [语音]...[/语音]；返回去掉标记后的纯文本与片段列表。 */
export function extractVoice(text) {
  const re = /\[(?:voice|语音)\]([\s\S]*?)\[\/(?:voice|语音)\]/gi;
  const parts = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = m[1].trim();
    if (t) parts.push(t);
  }
  const clean = text
    .replace(re, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { clean, parts };
}

/**
 * 把用户/桌宠说出的音色称呼解析成 TTS 的 voice 参数。
 * switchMap: { 称呼: voice参数 }；精确匹配优先，其次忽略大小写，最后允许 voice 参数本身。
 */
export function resolveVoiceName(raw, switchMap = {}) {
  const name = String(raw ?? '').trim();
  if (!name) return null;
  const entries = Object.entries(switchMap || {}).filter(([k, v]) => k && v);
  const hit = entries.find(([k]) => k === name) || entries.find(([k]) => k.toLowerCase() === name.toLowerCase());
  if (hit) return { voice: String(hit[1]), label: hit[0] };
  const asValue = entries.find(([, v]) => String(v) === name);
  if (asValue) return { voice: String(asValue[1]), label: asValue[0] };
  return null;
}

/** 从哥哥的话里识别「换成 X 的声音」这类换音色指令；返回 {voice,label} 或 null。 */
export function detectVoiceSwitch(text, switchMap = {}) {
  if (!text) return null;
  const s = String(text);
  const entries = Object.entries(switchMap || {})
    .filter(([k, v]) => k && v)
    .sort((a, b) => b[0].length - a[0].length);
  if (!entries.length) return null;
  // 换声动词：长的放前面，避免「换」先于「换成」命中后语义仍对但读起来别扭。
  const lead = '(?:换成|换为|换到|换回|换|改用|改为|改成|改|切换到|切换成|切换|变回|变成|用|学|模仿|听)';
  for (const [key, voiceParam] of entries) {
    const k = escRe(key);
    // ① 动词在前：换成卡提希娅 / 用胡桃的声音 / 学葱说话 / 换回默认
    const p1 = new RegExp(`${lead}\\s*[「"'']?\\s*${k}\\s*[」"'']?\\s*(?:的)?(?:声音|音色|说话|念|讲)?`);
    // ② 音色词在前：音色换成希美 / 声音改用洛琪希
    const p2 = new RegExp(`(?:声音|音色|语气)\\s*(?:换成|换为|换到|换回|换|改用|改为|改成|改|切换到|切换成|切换|用)?\\s*[「"'']?\\s*${k}`);
    if (p1.test(s) || p2.test(s)) return { voice: String(voiceParam), label: key };
  }
  return null;
}

/**
 * 从溪颜的回复里提取 [voice:use X] 自主换声标记（私聊才生效，由 bridge 把关）。
 * 返回去掉标记后的文本与解析出的换声列表。
 */
export function extractVoiceUse(text, switchMap = {}) {
  const re = /\[voice\s*:\s*use\s*([^\]]+)\]/gi;
  const switches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const hit = resolveVoiceName(m[1], switchMap);
    if (hit) switches.push(hit);
  }
  const clean = text
    .replace(re, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { clean, switches };
}

/**
 * 把 switchMap 整理成音色清单：同一个音色参数被多个称呼指向时（默认/原声都是 xll），
 * 合并成一条并带上别名，免得哥哥以为只有一种。
 * 返回 [{ voice, labels, label, display }]。
 */
export function voiceCatalog(switchMap = {}) {
  const entries = Object.entries(switchMap || {}).filter(([k, v]) => k && v);
  const groups = new Map();
  for (const [k, v] of entries) {
    const key = String(v);
    if (!groups.has(key)) groups.set(key, []);
    const aliases = groups.get(key);
    if (!aliases.includes(String(k))) aliases.push(String(k));
  }
  return [...groups.entries()].map(([voice, labels]) => ({
    voice,
    labels,
    label: labels[0],
    display: labels.length > 1 ? `${labels[0]}（也叫${labels.slice(1).join('、')}）` : labels[0],
  }));
}

/** 给桌宠的旁白模板：哥哥问「有哪些音色可换」时，把动态清单交给他自己数出来。 */
export function voiceListNote(switchMap = {}, current = '') {
  const items = voiceCatalog(switchMap);
  if (!items.length) return '';
  const now = String(current ?? '');
  const currentItem = items.find((it) => it.voice === now);
  const currentLabel = currentItem?.label || now || '默认';
  return (
    `\n（旁白：哥哥在问你有哪些音色可以换。你现在能用的一共有 ${items.length} 种：` +
    `${items.map((it) => it.display).join('、')}。你现在用的是「${currentLabel}」。` +
    `把这些音色名一个个数给他听，开头说句「我能换成这些」之类的话，一个都别漏；` +
    `语气照你平时的样子，别像报菜单，也别提桥、配置、参数这些词。）`
  );
}

/**
 * 识别「有哪些音色 / 能换成什么声音」这类查询意图。
 * 只认明确的问法，避免把「你声音怎么变了」这类普通聊天误判成查询。
 */
export function detectVoiceQuery(text) {
  if (!text) return false;
  const s = String(text).trim();
  if (!s || s.length > 60) return false;
  return [
    /(?:哪些|什么|啥|几种|多少|几个).{0,10}(?:音色|声音|声线)/,
    /(?:音色|声音|声线).{0,10}(?:有哪些|有什么|有啥|几种|多少|列表|清单|能换|可以换|可选|都有)/,
    /(?:能|可以|会|想).{0,6}(?:换成|换|变成|变|模仿|学).{0,8}(?:什么|啥|哪些|谁)/,
    /^(?:音色|声音)(?:列表|清单)$/,
  ].some((re) => re.test(s));
}

/** 给桌宠看的提示词：语音标记写法、分寸，以及自主换声标记。 */
export const VOICE_HINT =
  '\n（想用声音说一句话时，把要念的原文放进 [voice] 和 [/voice] 之间，' +
  '例如 [voice]早点睡，别熬太晚。[/voice]，桥会用你的声音发成一条语音条；' +
  '别写 [语音 3″] 这种空占位。一次最多一段语音、不超过 200 字、别在标记外重复这句话。' +
  '想换声音时，单独写一行 [voice:use 音色名]，桥会把你的音色换成那个；' +
  '哥哥问你「有哪些音色 / 能换成什么声音」时，照旁白里给你的清单数给他听，别漏、别自己瞎编。' +
  '念台词时语气要自然：一句话只在一个地方收尾、只用一个语气词，放在整句最后，别每半句都加；' +
  '语气词用「呢、啦、嘛、呗」这类字更清楚，少用「呀」；想在语气词前停顿一下，就在它前面写个中文逗号（像「……了，呀。」这样），别用空格；' +
  '别用「真好」「我好开心啊」这种两个字的短尾巴收句，会把字拖长变调，改说三个字以上或把整句连着说完。' +
  '普通聊天照常只写字，不要每句都用语音。）';

/** 给桌宠的旁白模板：哥哥下了换声指令后注入。 */
export function voiceSwitchNote(label) {
  return (
    `\n（旁白：哥哥刚说想听「${label}」的声音，你已经把自己的音色换成「${label}」了。` +
    `回他一句，可以在回复里用 [voice]要说的话[/voice] 发条语音让他听听；` +
    `语气照你平时的样子，别机械地复述「已切换」。）`
  );
}

/**
 * 创建语音客户端。
 * cfg: { enabled, ttsUrl, voice, timeoutMs, maxChars, token, allowGroups, switchMap, onVoiceChange }
 * log: info/warn 函数
 */
export function createVoice(cfg = {}, log = {}) {
  const enabled = cfg.enabled !== false;
  const base = String(cfg.ttsUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '');
  let voice = String(cfg.voice || '葱').trim();
  const switchMap = cfg.switchMap && typeof cfg.switchMap === 'object' ? cfg.switchMap : {};
  const onVoiceChange = typeof cfg.onVoiceChange === 'function' ? cfg.onVoiceChange : null;
  const timeoutMs = Number(cfg.timeoutMs ?? 120000);
  const maxChars = Number(cfg.maxChars ?? 80);
  const allowGroups = cfg.allowGroups === true;
  // 语速与采样种子：Coo 的 9880 /tts 透传这两个字段。不填就不发，保持引擎默认。
  const speed = typeof cfg.speed === 'number' && cfg.speed > 0 ? cfg.speed : null;
  const seed = typeof cfg.seed === 'number' && cfg.seed >= 0 ? cfg.seed : null;
  const token = String(cfg.token ?? '').trim();
  // 句尾补静音：给协议端转 SILK 留缓冲，避免低能量尾字被当静音裁掉。0 = 关闭。
  const tailPadMs = Math.max(0, Number(cfg.tailPadMs ?? 300));
  const info = log.info ?? (() => {});
  const warn = log.warn ?? (() => {});

  /** 当前音色（运行时，可切换）。 */
  function getVoice() {
    return voice;
  }

  /** 切换音色：只改运行时，并回调持久化；失败不抛错。 */
  function setVoice(name) {
    const next = String(name ?? '').trim();
    if (!next) return { ok: false, voice };
    if (next !== voice) {
      voice = next;
      info(`音色已切换为「${voice}」`);
      if (onVoiceChange) {
        try {
          onVoiceChange(voice);
        } catch (e) {
          warn(`音色写回配置失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return { ok: true, voice };
  }

  /** 接口当前是否可用（health 探测）。 */
  async function health() {
    try {
      const res = await fetchWithTimeout(`${base}/health`, {}, Math.min(timeoutMs, 8000));
      if (!res.ok) return { ok: false, state: `HTTP ${res.status}` };
      const j = await res.json();
      return { ok: !!(j && j.ready), state: j?.state ?? '' };
    } catch (e) {
      return { ok: false, state: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 合成一句 → 返回 WAV Buffer；失败返回 null（调用方据此降级）。 */
  async function synthesize(text) {
    const said = String(text ?? '').trim();
    if (!said) return null;
    if ([...said].length > maxChars) {
      warn(`语音跳过：超过 ${maxChars} 字（${[...said].length} 字）`);
      return null;
    }
    const headers = { 'content-type': 'application/json' };
    const url = token ? `${base}/tts?token=${encodeURIComponent(token)}` : `${base}/tts`;
    const body = JSON.stringify({
      text: said,
      voice,
      ...(speed !== null ? { speed } : {}),
      ...(seed !== null ? { seed } : {}),
    });
    const started = Date.now();
    try {
      const res = await fetchWithTimeout(url, { method: 'POST', headers, body }, timeoutMs);
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 160); } catch { /* ignore */ }
        warn(`语音合成失败 HTTP ${res.status} ${detail}`);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 44 || buf.subarray(0, 4).toString() !== 'RIFF') {
        warn('语音合成返回不是 WAV，已忽略');
        return null;
      }
      info(`语音合成 OK：${[...said].length} 字 / ${Math.round(buf.length / 1024)} KB / ${Date.now() - started}ms / 音色「${voice}」`);
      return buf;
    } catch (e) {
      warn(`语音合成异常：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** WAV → OneBot record CQ 码（base64://）。发送前按配置补一段尾部静音。 */
  function recordCq(wav) {
    if (!wav) return '';
    const padded = padWavTail(wav, tailPadMs);
    return `[CQ:record,file=base64://${padded.toString('base64')}]`;
  }

  return { enabled, allowGroups, getVoice, setVoice, switchMap, base, health, synthesize, recordCq };
}

/** 离线自测 padWavTail：构造标准 44 字节头 WAV，验证补尾长度、长度字段同步、关闭与幂等边界。 */
export function tailPadTest() {
  const results = [];
  const t = (name, got, want) => results.push({ name, ok: got === want, got, want });
  const mk = (dataBytes, rate = 48000) => {
    const b = Buffer.alloc(44 + dataBytes);
    b.write('RIFF', 0); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
    return b;
  };
  const src = mk(96000); // 1 秒 48k 16bit 单声道
  const padded = padWavTail(src, 300);
  t('补尾后长度 +300ms 样本', padded.length - src.length, 48000 * 0.3 * 2);
  t('RIFF size 同步', padded.readUInt32LE(4), padded.length - 8);
  t('data size 同步', padded.readUInt32LE(40), padded.length - 44);
  t('尾部字节是静音', padded.subarray(src.length).every((x) => x === 0), true);
  t('源文件未被改动', src.length, 44 + 96000);
  t('ms=0 不补', padWavTail(src, 0) === src, true);
  t('非 WAV 原样返回', padWavTail(Buffer.from('nope'), 300).toString(), 'nope');
  let pass = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}：得到 ${String(r.got)}，期望 ${String(r.want)}`);
    if (r.ok) pass++;
  }
  console.log(`尾字补静音自测：${pass}/${results.length} 通过`);
  return results.every((r) => r.ok);
}
