#!/usr/bin/env node
/**
 * image-input.mjs —— 把 QQ 消息里的图片 / 表情包变成 dsh-pet `/chat` 能收的 attachment。
 *
 * 参考 Coo 的 cortico-world-qq：
 *   · extractImageUrl(data) = data.url || data.file（world.ts:1928）
 *   · downloadImageBytes() 的超时 / 大小上限 / MIME 处理（image-download.ts）
 *   · image 段与 face 段都渲染进正文（normalize.ts）
 * 不同的是 dsh-pet 宿主原生支持多模态：POST /chat 的 body 里带
 *   { text, attachment: { mediaType, data } }
 * 宿主会落盘图片、把 `{type:'image', attachment}` 追加到 user content，
 * 所以模型能直接看见画面，不需要 Coo 那种辅助 VLM 转文字。
 *
 * 宿主约束（routes/chat.ts + image-attachment.ts）：
 *   mediaType ∈ image/png | image/jpeg | image/webp | image/gif
 *   base64 ≤ 900_000 字符，请求体 ≤ 1 MiB，text ≤ 2000 字
 *   独立模式（无附件服务）会回 bad-request，调用方要能降级成纯文本
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, extname } from 'node:path';
import { QFACE_NAMES } from './qface-map.mjs';

/** 宿主接受的媒体类型；顺序只用于错误文案。 */
export const ALLOWED_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** QQ 小黄脸 face 段 → 中文标记，与 Coo 的渲染保持一致。 */
export function faceLabel(id) {
  const name = QFACE_NAMES[String(id ?? '').trim()];
  return name ? `[表情:${name}]` : '[QQ表情]';
}

/** URL 扩展名 → MIME（仅用于本地文件与 content-type 缺失时）。 */
function mimeFromExt(path) {
  const ext = extname(String(path).split('?')[0]).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return '';
}

/** 按文件头认图：QQ 的下载 URL 没有扩展名，content-type 也未必准。 */
function mimeFromMagic(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function normalizeMediaType(raw) {
  const mime = String(raw ?? '').split(';')[0].trim().toLowerCase();
  if (mime === 'image/jpg') return 'image/jpeg';
  return ALLOWED_MEDIA_TYPES.includes(mime) ? mime : '';
}

/**
 * image 段里挑一个能下载的地址。
 * SnowLuma 的 `file` 常只是文件名哈希（8A26….jpg），不是本地路径，不能用。
 */
export function pickImageUrl(data = {}) {
  const url = typeof data.url === 'string' ? data.url.trim() : '';
  if (url) return url;
  const file = typeof data.file === 'string' ? data.file.trim() : '';
  if (/^(https?|file):\/\//i.test(file) || /^base64:\/\//i.test(file) || isAbsolute(file)) return file;
  return '';
}

/**
 * 一个 image 段 → 描述信息。
 * @returns {{url: string, label: string, sticker: boolean}}
 *   label 是 QQ 自带的 summary（如「动画表情」「啊」），只作为语义提示，不是谁说的话。
 */
export function describeImageSegment(data = {}) {
  const url = pickImageUrl(data);
  const raw = typeof data.summary === 'string' ? data.summary.trim() : '';
  const summary = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
  const subType = Number(data.sub_type ?? 0);
  const sticker = subType > 0 || (!!summary && summary !== '图片');
  let label = '';
  if (summary && summary !== '图片') label = sticker ? `表情包：${summary}` : summary;
  return { url, label, sticker };
}

/** 一批 segments 里的图片（供离线自测与合并窗口使用）。 */
export function collectImageSegments(segments) {
  const out = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (seg?.type === 'image') out.push(describeImageSegment(seg?.data ?? {}));
  }
  return out;
}

function fail(reason) {
  return { ok: false, reason };
}

/**
 * 下载并把一张图转成 /chat 的 attachment。任何失败都返回 {ok:false, reason}，
 * 调用方只记日志、保留 [图片] 占位，不中断这一轮回复。
 */
export async function fetchAttachment(url, opts = {}) {
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs ?? 12000));
  const maxBytes = Math.max(1024, Number(opts.maxImageBytes ?? 600000));
  if (!url) return fail('消息里没有可用的图片地址');
  try {
    let buf;
    let hinted = '';
    if (/^base64:\/\//i.test(url)) {
      const raw = url.slice('base64://'.length);
      buf = Buffer.from(raw, 'base64');
      if (buf.length === 0 || buf.toString('base64') !== raw) return fail('base64 图片不合法');
    } else if (/^https?:\/\//i.test(url)) {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'Mozilla/5.0' },
      });
      if (!res.ok) return fail(`图片下载失败 HTTP ${res.status}`);
      hinted = res.headers.get('content-type') ?? '';
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      const path = /^file:\/\//i.test(url) ? fileURLToPath(url) : url;
      buf = await readFile(path);
      hinted = mimeFromExt(path);
    }
    if (buf.length === 0) return fail('图片是空的');
    if (buf.length > maxBytes) return fail(`图片过大（${buf.length} > ${maxBytes} 字节）`);
    const mediaType = normalizeMediaType(hinted) || mimeFromMagic(buf) || normalizeMediaType(mimeFromExt(url));
    if (!mediaType) return fail(`不支持的图片类型（${hinted || '未知格式'}）`);
    const data = buf.toString('base64');
    if (data.length > 900000) return fail('图片 base64 超出宿主 900000 字符上限');
    return { ok: true, attachment: { mediaType, data }, bytes: buf.length, mediaType };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(e?.name === 'TimeoutError' || /abort/i.test(msg) ? '图片下载超时' : `图片下载异常：${msg}`);
  }
}
