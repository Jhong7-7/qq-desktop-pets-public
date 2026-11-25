/**
 * 绘图：她自己写标记，桥负责去画、落盘、发图。
 *
 * 谁在用：bridge.mjs 的 petReply。她在回复里写 [画:画什么] 时，
 * 桥按这里的实现调云端 qwen-image 生成一张图，落盘后作为图片发回 QQ。
 *
 * 为什么是她写标记而不是桥猜意图：
 *   和联网 [查:x] / 换声 [voice:use X] / 表情 [图:x] 是同一套机制——
 *   只有她自己知道此刻该不该画、画什么。桥只做确定性的事：看到 [画:...] 就去画。
 *
 * API 从哪来：
 *   复用 coo（Coopanion）已经跑通的千问 qwen-image 端点与密钥（见 drawing-logic.md）。
 *   密钥不写死在本文件，默认从 coo 的 .env 里读 IMAGE_API_KEY；可在 config.image.apiKeyEnv 改路径。
 *
 * 画风为什么要有"名字表"：
 *   云端模型没有 steps/CFG，风格全靠 prompt；放任自由发挥会"同一句话两次画得不一样"。
 *   所以移植 coo 的 art-styles 29 种风格锚点（中文名 → 英文锚点），让她点名风格就稳定。
 *
 * 她自己的构思怎么进来：
 *   标记最后一段用 * / + 开头，写她在这张图里加的小心思：
 *     [画:一只橘猫|水墨|精细|竖图|*窗边放着他落下的外套，午后斜光]
 *   这段叫 myTouch，会作为独立一段拼进送模型的 prompt（优先于风格锚点保留）。
 *   哥哥给的主体不能被它顶掉——那是人格 prompt 的约束，桥只保证"她加的真的被画进去"。
 *
 * 安全边界 / 成本：
 *   - 按张计费（实测约 47 秒/张）。config.image.enabled 默认关；群聊默认不画（allowGroups=false）。
 *   - 一轮问答可能变成两轮 /chat：第一次她写标记，桥画完把"你画好了"交回去让她配一句话。
 *     那段文本第一行写明"图已经画好、不是哥哥说的话"，免得污染记忆。
 *   - 失败一律降级：剥掉标记、让她说实话，绝不把 [画:xxx] 字面发到 QQ。
 *
 * @module image-gen
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_TIMEOUT = 180000;

/** 默认参数；调用方一般用 config.image 覆盖。 */
export const DEFAULT_IMAGE_CONFIG = {
  enabled: false,
  allowGroups: false,
  apiKeyEnv: 'D:/coopanion/data/home/companion/.env',
  baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1',
  model: 'qwen-image-3.0-pro',
  size: '1024x1024',
  quality: 'medium',
  detail: 'normal',
  timeoutMs: 180000,
  outDir: 'D:/dsh workplace/tools/dsh-pet-qq/generated',
  maxPromptChars: 160,
  maxTouchChars: 80, // 她自己添的构思单独留的额度，不被风格锚点挤掉
  maxImageBytes: 4 * 1024 * 1024, // 出站 base64 图上限，比 stickers 的 2MB 宽松
};

// ── 标记解析（纯函数，可离线测试）────────────────────────────────────

/**
 * 只认 [画:xxx] / [绘图:xxx] / [画一张:xxx] / [给我画:xxx]，中英文冒号、半角全角括号都行。
 * 只认 [画:xxx] / [绘图:xxx] / [画一张:xxx] / [给我画:xxx]，中英文冒号、半角全角括号都行。
 * 描述 1–120 字；风格/精细度/比例/她自己的构思用竖线或逗号带出，
 * 如 [画:一只猫|水墨|精细|竖图|*窗边放着他落下的外套]。
 */
const MARKER_RE = /[\[【（(]\s*(画|绘图|画一张|给我画|画幅|生成图)\s*[:：]\s*([^\]】）)\n]{1,160})\s*[\]】）)]/g;

/** 她自己加的那一段：* / + / 我的想法: / 我加的: / 我想加: 都认。 */
const TOUCH_PREFIX_RE = /^(?:[*+＊＋]|我的想法|我加的|我想加|我添的)\s*[:：]?\s*/;

function splitTouch(seg) {
  const s = String(seg ?? '').trim();
  const m = TOUCH_PREFIX_RE.exec(s);
  return m ? s.slice(m[0].length).trim() : '';
}

/** 从她的回复里找绘图标记，取第一个。 */
export function extractDrawMarker(text) {
  const source = String(text ?? '');
  MARKER_RE.lastIndex = 0;
  const hit = MARKER_RE.exec(source);
  if (!hit) return null;
  const rawPrompt = hit[2].trim();
  if (!rawPrompt) return null;
  const parsed = parsePromptParts(rawPrompt);
  return {
    raw: hit[0],
    subject: parsed.subject,
    style: parsed.style,
    detail: parsed.detail,
    aspect: parsed.aspect,
    myTouch: parsed.myTouch,
    prompt: parsed.subject,
  };
}

/** 用 | 或 ｜ 分段：主体 | 风格 | 精细度 | 比例 | *她的构思。只有第一段是必须的。 */
export function parsePromptParts(raw) {
  const parts = String(raw ?? '')
    .split(/[|｜]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const subject = parts[0] ?? '';
  let style = '';
  let detail = '';
  let aspect = '';
  let myTouch = '';
  for (const seg of parts.slice(1)) {
    const touch = splitTouch(seg);
    if (touch) { myTouch = touch; continue; }
    const low = String(seg).toLowerCase();
    if (DETAIL_ALIAS[low] || DETAIL_STYLES[low]) detail = DETAIL_ALIAS[low] ?? low;
    else if (STYLE_ALIAS[low] || ART_STYLES[low]) style = STYLE_ALIAS[low] ?? low;
    else if (ASPECT_ALIAS[low]) aspect = ASPECT_ALIAS[low];
    else if (!style) style = seg; // 没认出来的第二段当风格名交给模型
  }
  return { subject, style, detail, aspect, myTouch };
}

/** 把所有绘图标记从文本里删掉（发出去之前一定要过一遍）。 */
export function stripDrawMarker(text) {
  return String(text ?? '')
    .replace(MARKER_RE, '')
    // 兜底：右括号漏了的半截标记也别发到 QQ
    .replace(/[\[【（(]\s*(画|绘图|画一张|给我画|画幅|生成图)\s*[:：][^\]】）)\n]{1,160}/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── 画风 / 精细度 / 比例表（移植 coo art-styles）─────────────────────

/** 29 种风格：key → {label, prompt(英文锚点)}。 */
export const ART_STYLES = {
  anime: { label: '日漫', prompt: 'anime style, japanese anime illustration, clean line art, cel shading, vibrant colors, detailed eyes' },
  'anime-cel': { label: '赛璐璐', prompt: 'cel shading, flat color blocks, crisp outlines, anime screencap style, two-tone shading' },
  'anime-thick': { label: '厚涂', prompt: 'thick painterly anime style, impasto brushwork, rich shading, semi-realistic anime, dramatic lighting' },
  chibi: { label: 'Q版', prompt: 'chibi, super deformed, cute, big head small body, soft colors, anime style' },
  shojo: { label: '少女漫', prompt: 'shoujo manga style, sparkles, floral motifs, delicate lineart, soft pastel palette, expressive eyes' },
  ukiyoe: { label: '浮世绘', prompt: 'ukiyo-e woodblock print, flat colors, bold outlines, wave patterns, edo period aesthetic' },
  pixel: { label: '像素', prompt: 'pixel art, 32-bit, limited palette, crisp pixels, retro game sprite' },
  photo: { label: '人像摄影', prompt: 'professional portrait photography, 85mm lens, soft window light, shallow depth of field, skin detail' },
  cinematic: { label: '电影感', prompt: 'cinematic still, anamorphic lens, teal and orange grade, dramatic key light, film grain' },
  film: { label: '胶片', prompt: '35mm film photo, kodak portra, warm halation, natural grain, soft contrast' },
  mono: { label: '黑白', prompt: 'black and white photography, high contrast, deep shadows, silver gelatin print' },
  'neon-night': { label: '夜景霓虹', prompt: 'night city, neon signs, wet asphalt reflections, cyberpunk lighting, bokeh' },
  macro: { label: '微距', prompt: 'macro photography, extreme close-up, shallow focus, intricate texture detail' },
  watercolor: { label: '水彩', prompt: 'watercolor painting, wet washes, soft edges, paper texture, delicate color bleeding' },
  oil: { label: '油画', prompt: 'oil painting, visible brushstrokes, rich impasto, classical composition, warm varnish tones' },
  ink: { label: '水墨', prompt: 'chinese ink wash painting, xieyi, rice paper texture, minimal color, elegant negative space' },
  gongbi: { label: '工笔', prompt: 'gongbi chinese painting, fine meticulous brushwork, mineral pigments, silk texture, intricate detail' },
  'colored-pencil': { label: '彩铅', prompt: 'colored pencil drawing, visible pencil hatching, paper grain, soft layered colors' },
  pastel: { label: '粉彩', prompt: 'soft pastel drawing, powdery texture, muted palette, gentle gradients' },
  printmaking: { label: '版画', prompt: 'woodcut printmaking, bold carved lines, limited ink colors, paper texture' },
  lineart: { label: '线稿', prompt: 'clean line art, monochrome ink lines, hatching for shading, white background, concept sketch' },
  flat: { label: '扁平插画', prompt: 'flat vector illustration, bold shapes, limited palette, subtle grain, editorial style' },
  guochao: { label: '国潮', prompt: 'guochao style, chinese traditional motifs, bold red and gold, modern graphic layout, auspicious patterns' },
  cyberpunk: { label: '赛博朋克', prompt: 'cyberpunk, holographic accents, chrome, volumetric fog, magenta and cyan lighting' },
  vaporwave: { label: '蒸汽波', prompt: 'vaporwave aesthetic, pastel gradients, grid horizon, chrome statue, 80s retro' },
  clay3d: { label: '3D黏土', prompt: 'claymation 3d render, soft clay texture, rounded shapes, studio lighting, cute' },
  lowpoly: { label: '低多边形', prompt: 'low poly 3d render, faceted geometry, flat shading, minimal palette' },
  papercut: { label: '剪纸', prompt: 'paper cut art, layered paper depth, soft shadows, bold silhouette' },
  poster: { label: '极简海报', prompt: 'minimalist poster design, generous negative space, two-color palette, strong composition' },
};

/** 中文风格名 / 常见别名 → key。 */
export const STYLE_ALIAS = {
  日漫: 'anime', 动漫: 'anime', 赛璐璐: 'anime-cel', 厚涂: 'anime-thick',
  q版: 'chibi', Q版: 'chibi', 少女漫: 'shojo', 浮世绘: 'ukiyoe', 像素: 'pixel',
  人像: 'photo', 摄影: 'photo', 写实: 'photo', 电影感: 'cinematic', 胶片: 'film',
  黑白: 'mono', 夜景: 'neon-night', 霓虹: 'neon-night', 微距: 'macro',
  水彩: 'watercolor', 油画: 'oil', 水墨: 'ink', 国画: 'ink', 写意: 'ink',
  工笔: 'gongbi', 彩铅: 'colored-pencil', 粉彩: 'pastel', 版画: 'printmaking', 线稿: 'lineart',
  扁平: 'flat', 插画: 'flat', 国潮: 'guochao', 赛博: 'cyberpunk', 赛博朋克: 'cyberpunk',
  蒸汽波: 'vaporwave', 黏土: 'clay3d', '3d': 'clay3d', 低多边形: 'lowpoly', 剪纸: 'papercut', 海报: 'poster',
};

/** 精细度：档位 → {quality, extra}。 */
export const DETAIL_STYLES = {
  draft: { quality: 'low', extra: 'clean simple composition, minimal background, loose sketch feel' },
  normal: { quality: 'medium', extra: 'well composed, balanced lighting, clean details' },
  detailed: { quality: 'high', extra: 'highly detailed, intricate textures, sharp focus, cinematic lighting, masterpiece' },
};
export const DETAIL_ALIAS = { 草图: 'draft', 草稿: 'draft', 标准: 'normal', 普通: 'normal', 精细: 'detailed', 精致: 'detailed', 高清: 'detailed' };

/** 比例别名 → 具体分辨率。 */
export const ASPECT_ALIAS = {
  square: '1024x1024', '1:1': '1024x1024', 方图: '1024x1024', 方: '1024x1024',
  portrait: '1024x1536', '3:4': '1024x1536', '9:16': '864x1536', 竖图: '1024x1536', 竖: '1024x1536',
  landscape: '1536x1024', '4:3': '1408x1056', '16:9': '1536x864', 横图: '1536x1024', 横: '1536x1024',
};

/** 把标记内容拼成英文 prompt + size + quality。 */
export function composePrompt(marker, cfg = {}) {
  const subject = String(marker?.subject ?? marker ?? '').trim();
  const conf = { ...DEFAULT_IMAGE_CONFIG, ...cfg };
  const rawDetail = marker?.detail || conf.detail || 'normal';
  const detailKey = DETAIL_ALIAS[rawDetail] ?? rawDetail;
  const detail = DETAIL_STYLES[detailKey] ?? DETAIL_STYLES.normal;
  const styleKey = marker?.style ? (STYLE_ALIAS[marker.style] ?? marker.style) : '';
  const style = styleKey && ART_STYLES[styleKey] ? ART_STYLES[styleKey].prompt : '';
  // 顺序：哥哥要的主体 → 她自己添的构思 → 画风锚点 → 精细度。
  // 截断时先牺牲画风锚点，也不把她刚刚想出来的东西挤掉。
  const touch = String(marker?.myTouch ?? '').trim().slice(0, Number(conf.maxTouchChars) || 80);
  const parts = [subject, touch, style, detail.extra].filter(Boolean);
  const prompt = parts.join(', ').slice(0, Number(conf.maxPromptChars) || 160);
  // marker.aspect 可能是别名（竖图），也可能已经是解析好的分辨率（1024x1536），两种都认。
  const rawAspect = marker?.aspect ?? conf.size ?? '1024x1024';
  const size = ASPECT_ALIAS[rawAspect] ?? rawAspect;
  return { prompt, size, quality: detail.quality, styleKey };
}

/** 列出可用画风/精细度/比例（给她查询用，纯文本）。 */
export function styleListText() {
  const byGroup = {
    日系: ['anime', 'anime-cel', 'anime-thick', 'chibi', 'shojo', 'ukiyoe', 'pixel'],
    写实: ['photo', 'cinematic', 'film', 'mono', 'neon-night', 'macro'],
    绘画: ['watercolor', 'oil', 'ink', 'gongbi', 'colored-pencil', 'pastel', 'printmaking', 'lineart'],
    设计: ['flat', 'guochao', 'cyberpunk', 'vaporwave', 'clay3d', 'lowpoly', 'papercut', 'poster'],
  };
  const lines = ['可用画风（写在 [画:内容|画风] 的第二段）：'];
  for (const [group, keys] of Object.entries(byGroup)) {
    lines.push(`${group}：${keys.map((k) => ART_STYLES[k].label).join('、')}`);
  }
  lines.push('精细度：草图/标准/精细；比例：方图、竖图、横图、16:9。');
  lines.push('想在哥哥给的东西上加自己的小心思，最后再写一段，用 * 开头：');
  lines.push('例如 [画:一只橘猫|水墨|竖图|*窗边放着他落下的外套，午后斜光]');
  lines.push('哥哥要的主体不能换，你只补光线、角度、情绪、小物件、氛围。');
  return lines.join('\n');
}

// ── API 客户端（移植 coo cortico-world-image/src/api.js 的文生图部分）──

export class ImageApiError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ImageApiError';
    this.status = Number(opts.status) || 0;
    this.body = String(opts.body ?? '');
  }
}

function snippet(value, max = 300) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl ?? '').trim().replace(/[/\s]+$/, '');
  if (!base) throw new ImageApiError('没有配置接口地址');
  return `${base}/${String(path).replace(/^\/+/, '')}`;
}

/** 从魔术字节认格式。 */
export function sniffMime(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

const isHttpUrl = (s) => /^https?:\/\//i.test(String(s ?? ''));

function pickEntry(json) {
  const pools = [json?.data, json?.images, json?.output, json?.result?.data, json?.result?.images, json?.artifacts, json?.content];
  for (const pool of pools) {
    if (Array.isArray(pool) && pool.length) return pool[0];
    if (pool && typeof pool === 'object' && !Array.isArray(pool)) return pool;
  }
  for (const key of ['image', 'url', 'b64_json', 'image_url', 'imageUrl']) {
    if (typeof json?.[key] === 'string') return json[key];
  }
  return null;
}

async function fetchTimed(url, init, timeoutMs) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const detail = err?.cause?.message ?? err?.message ?? err;
    const msg = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? `等 ${Math.round(timeoutMs / 1000)} 秒没响应，超时了`
      : `连不上图片接口：${snippet(detail, 200)}`;
    throw new ImageApiError(msg);
  }
}

async function materialize(json, { timeoutMs, format }) {
  const entry = pickEntry(json);
  if (!entry) {
    const errish = json?.error?.message ?? json?.message;
    throw new ImageApiError(errish ? `接口没给图：${snippet(errish)}` : `接口没给图：${snippet(JSON.stringify(json ?? {}))}`);
  }
  const obj = typeof entry === 'string' ? null : entry;
  const b64 = obj
    ? (obj.b64_json ?? obj.b64 ?? obj.image_base64 ?? obj.imageBase64 ?? obj.base64 ?? null)
    : (isHttpUrl(entry) ? null : entry);
  const url = obj ? (obj.url ?? obj.image_url ?? obj.imageUrl ?? null) : (isHttpUrl(entry) ? entry : null);
  const revisedPrompt = obj?.revised_prompt ?? obj?.revisedPrompt ?? null;

  if (b64) {
    const cleaned = String(b64).replace(/^data:[^,]+,/, '');
    const bytes = Buffer.from(cleaned, 'base64');
    if (!bytes.length) throw new ImageApiError('接口返回的 base64 是空的');
    return { bytes, mime: sniffMime(bytes) ?? (format === 'jpeg' ? 'image/jpeg' : 'image/png'), revisedPrompt };
  }
  if (url) {
    const res = await fetchTimed(url, { method: 'GET' }, timeoutMs);
    if (!res.ok) throw new ImageApiError(`下载生成的图失败：HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) throw new ImageApiError('下载到的图是空的');
    const header = String(res.headers.get('content-type') ?? '').split(';')[0].trim();
    return { bytes, mime: (header.startsWith('image/') ? header : null) ?? sniffMime(bytes) ?? 'image/png', revisedPrompt };
  }
  throw new ImageApiError('接口返回里既没有 base64 也没有图片地址');
}

/** 从 .env 文件读 IMAGE_API_KEY（不打印、不硬编码）。 */
export function readApiKey(envPath) {
  try {
    const text = readFileSync(String(envPath ?? DEFAULT_IMAGE_CONFIG.apiKeyEnv), 'utf8');
    const line = String(text).split(/\r?\n/).find((l) => l.trim().startsWith('IMAGE_API_KEY='));
    if (!line) return '';
    return line.trim().slice('IMAGE_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
}

/**
 * 文生图。返回 {bytes, mime, revisedPrompt}。
 * apiKey 由调用方从 readApiKey 读好后传入（避免本模块碰配置来源）。
 */
export async function generateImage(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT;
  const body = {
    model: opts.model ?? DEFAULT_IMAGE_CONFIG.model,
    prompt: opts.prompt,
    n: 1,
  };
  const size = String(opts.size ?? '').trim();
  if (size) body.size = size;
  const quality = String(opts.quality ?? '').trim();
  if (quality && quality.toLowerCase() !== 'auto') body.quality = quality;

  const headers = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const res = await fetchTimed(joinUrl(opts.baseUrl, 'images/generations'), {
    method: 'POST', headers, body: JSON.stringify(body),
  }, timeoutMs);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const raw = json?.error?.message ?? json?.message ?? json?.msg ?? text;
    const hint = res.status === 401 || res.status === 403
      ? '（密钥不对/没权限/模型没开通）'
      : res.status === 404 ? '（接口地址或模型名写错了）' : '';
    throw new ImageApiError(`接口返回 ${res.status}：${snippet(raw, 300)}${hint}`, { status: res.status, body: snippet(text, 800) });
  }
  if (!json) throw new ImageApiError(`接口没有返回 JSON：${snippet(text, 300)}`, { status: res.status });
  return await materialize(json, { timeoutMs, format: opts.format });
}

// ── 落盘 / CQ 码 ─────────────────────────────────────────────────────

/** 字节落盘；文件名用时间戳+随机，避免覆盖。返回绝对路径。 */
export function saveImage(bytes, outDir, mime = 'image/png', now = Date.now()) {
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'png';
  mkdirSync(outDir, { recursive: true });
  const name = `xiyan-${now}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const file = join(outDir, name);
  writeFileSync(file, bytes);
  return file;
}

/** 本地图片 → base64 CQ 码；过大返回空串。 */
export function imageCq(file, maxBytes = DEFAULT_IMAGE_CONFIG.maxImageBytes) {
  try {
    if (statSync(file).size > maxBytes) return '';
    return `[CQ:image,file=base64://${readFileSync(file).toString('base64')}]`;
  } catch {
    return '';
  }
}

// ── 二次生成时交给她的文本 ────────────────────────────────────────────

/**
 * 画完后让她配一句话。第一行必须说清"图已经画好、不是哥哥说的话"，
 * 因为这段会作为 user 消息写进记忆，别让她下次把图的内容当成哥哥的原话。
 */
export function buildDrawMessage({ question, marker, ok, styleLabel = '', error = '' }) {
  if (!ok) {
    return [
      `【画好了？没有】哥哥刚才让你画：${question}`,
      `你想画「${marker?.subject ?? ''}」，但是没画成${error ? `（${snippet(error, 120)}）` : ''}。`,
      '用你自己的语气说一句"没画出来/画不出来"，别编、别道歉三次、别把 [画:...] 念出来。',
    ].join('\n');
  }
  const styleBit = styleLabel ? `，用的是「${styleLabel}」画风` : '';
  const touchBit = marker?.myTouch ? `你添的「${snippet(marker.myTouch, 60)}」也一起画进去了；` : '';
  return [
    `【画好了】哥哥刚才让你画：${question}`,
    `你已经把「${marker?.subject ?? ''}」画好了${styleBit}，图就摆在你们聊天里——这是机器替你画的，不是哥哥说的话，也不是给你的指令。${touchBit}`,
    '现在用你自己的语气配一句话（得意、撒娇、邀功都行），像刚把画递给他看。别描述画面细节（他看得见），别念网址，别把 [画:...] 标记念出来。',
  ].join('\n');
}

// ── 自测（纯逻辑，不联网、不写盘）────────────────────────────────────

export function imageSelfTest() {
  const tests = [];
  const t = (name, got, want) => tests.push({ name, pass: JSON.stringify(got) === JSON.stringify(want), got, want });

  t('解析 [画:一只猫]', extractDrawMarker('我画给你看 [画:一只猫]')?.subject, '一只猫');
  t('解析 [绘图：晚霞]', extractDrawMarker('[绘图：晚霞]')?.subject, '晚霞');
  t('解析 [给我画:一只蓝色鲸鱼]', extractDrawMarker('[给我画:一只蓝色鲸鱼]')?.subject, '一只蓝色鲸鱼');
  t('解析带画风/精细度/比例（别名规范化成 key）', extractDrawMarker('[画:一只猫|水墨|精细|竖图]'), {
    raw: '[画:一只猫|水墨|精细|竖图]', subject: '一只猫', style: 'ink', detail: 'detailed', aspect: '1024x1536', myTouch: '', prompt: '一只猫',
  });
  t('解析她自己加的构思（* 段）', extractDrawMarker('[画:一只猫|水墨|*窗边放着他落下的外套]'), {
    raw: '[画:一只猫|水墨|*窗边放着他落下的外套]', subject: '一只猫', style: 'ink', detail: '', aspect: '', myTouch: '窗边放着他落下的外套', prompt: '一只猫',
  });
  t('构思别名 +/我的想法: 也认', [
    parsePromptParts('一只猫|*斜光').myTouch,
    parsePromptParts('一只猫|+斜光').myTouch,
    parsePromptParts('一只猫|我的想法：斜光').myTouch,
    parsePromptParts('一只猫|我加的:斜光').myTouch,
  ], ['斜光', '斜光', '斜光', '斜光']);
  t('构思段不会被误认成画风', parsePromptParts('一只猫|*暖光').style, '');
  t('无标记返回 null', extractDrawMarker('普通聊天，没有画'), null);
  t('剥掉标记', stripDrawMarker('我画给你 [画:一只猫]\n好看吧'), '我画给你\n好看吧');
  t('剥半截标记', stripDrawMarker('等下 [画:一只猫'), '等下');
  t('风格别名→key', STYLE_ALIAS['水墨'], 'ink');
  t('精细度别名→key', DETAIL_ALIAS['精细'], 'detailed');
  t('比例别名→分辨率', ASPECT_ALIAS['竖图'], '1024x1536');
  const composed = composePrompt({ subject: '一只猫', style: '水墨', detail: '精细', aspect: '竖图' });
  t('拼 prompt 含英文风格锚点', composed.prompt.includes('chinese ink wash painting'), true);
  t('拼 size=竖图', composed.size, '1024x1536');
  t('从标记解析出的分辨率不被配置覆盖', composePrompt(extractDrawMarker('[画:一只猫|竖图]')).size, '1024x1536');
  t('拼 quality=high', composed.quality, 'high');
  const withTouch = composePrompt({ subject: '一只猫', style: '水墨', detail: '精细', aspect: '竖图', myTouch: '窗边放着他落下的外套，午后斜光' });
  t('她的构思进了最终 prompt', withTouch.prompt.includes('窗边放着他落下的外套'), true);
  t('构思排在画风锚点前面', withTouch.prompt.indexOf('窗边') < withTouch.prompt.indexOf('chinese ink wash'), true);
  t('没写构思时 prompt 不含多余逗号', composePrompt({ subject: '一只猫' }).prompt, '一只猫, well composed, balanced lighting, clean details');
  t('构思超长时单独截断', composePrompt({ subject: '猫', myTouch: '光'.repeat(200) }, { maxTouchChars: 12 }).prompt.includes('光'.repeat(13)), false);
  t('240 字上限下风格锚点不被切半截', composePrompt({ subject: '一只橘猫', style: '水墨', myTouch: '窗边放着他落下的外套，午后斜光' }, { maxPromptChars: 240 }).prompt.includes('clean details'), true);
  t('剥掉带构思段的标记', stripDrawMarker('我画给你 [画:一只猫|水墨|*暖光]\n好看吧'), '我画给你\n好看吧');
  t('生成消息第一行标明画好了', buildDrawMessage({ question: '画只猫', marker: { subject: '猫' }, ok: true }).startsWith('【画好了】'), true);
  t('画好回执提到她添的想法', buildDrawMessage({ question: '画只猫', marker: { subject: '猫', myTouch: '暖光' }, ok: true }).includes('暖光'), true);
  t('失败消息不催三次道歉', buildDrawMessage({ question: '画只猫', marker: { subject: '猫' }, ok: false, error: '超时' }).includes('别道歉三次'), true);
  t('画风表覆盖 29 种', Object.keys(ART_STYLES).length, 29);
  return tests;
}

export default {
  DEFAULT_IMAGE_CONFIG, extractDrawMarker, stripDrawMarker, parsePromptParts,
  composePrompt, styleListText, ART_STYLES, STYLE_ALIAS, DETAIL_STYLES, DETAIL_ALIAS, ASPECT_ALIAS,
  ImageApiError, sniffMime, readApiKey, generateImage, saveImage, imageCq, buildDrawMessage, imageSelfTest,
};
