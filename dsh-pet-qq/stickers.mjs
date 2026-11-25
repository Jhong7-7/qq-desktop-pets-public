#!/usr/bin/env node
/**
 * dsh-pet-qq / stickers.mjs —— 把桌宠回复里的「表情标记」翻译成 QQ 真正能渲染的消息段。
 *
 * 桌宠 /chat 的回复里可能同时出现三类东西，原来的桥一律当纯文本发出去，所以 QQ 里
 * 只会看到字面的 `[图:困]`、`[委屈]`：
 *
 *   1. `[图:名称]`  —— dsh-pet 的配图标记。名称命中表情包池时，桌宠会把它从 text 里
 *                      剥掉、改放到响应的 `image` 字段；没命中（模型把 QQ 表情名误写进来、
 *                      或幻觉出池外名字）时，标记会原样留在 text 里。
 *   2. `image` 字段 —— 桌宠替你挑中的池内表情包名，对应 assets/memes/<名称>.png。
 *   3. `[白眼]` 等  —— 人设里要求用的 QQ 小黄脸表情名，需要转成 `[CQ:face,id=N]`。
 *
 * 本模块只做纯翻译，不连 WS、不读配置、不写日志；调用方（bridge.mjs）负责发出去。
 * 图片以 base64:// 内联，SnowLuma 的 OneBot v11 实现支持该格式，不依赖 HTTP 服务或路径转义。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

/** 默认表情包目录链：用户自定义优先，其次插件包内置（顺序即优先级）。 */
export const DEFAULT_MEME_DIRS = [
  join(homedir(), '.dsh', 'dsh-pet', 'memes'),
  join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-pet', 'assets', 'memes'),
];

/**
 * QQ 经典表情名 → face id。人设里那六个（白眼/委屈/傲慢/困/快哭了/害羞）与
 * QQ 开放平台、OneBot 生态通用的 id 表一致；其余是常见补充。
 * 可在 config.reply.stickers.faceIds 里整体覆盖或追加。
 */
export const DEFAULT_FACE_IDS = {
  害羞: 6, 白眼: 22, 傲慢: 23, 困: 25, 委屈: 106, 快哭了: 107,
  微笑: 14, 难过: 15, 大哭: 9, 发怒: 11, 可爱: 21, 惊恐: 26,
  流汗: 27, 疑问: 32, 晕: 34, 再见: 39, 鼓掌: 99, 鄙视: 105,
  亲亲: 109, 可怜: 111,
};

/** `[图:名称]` / `[图：名称]`，允许冒号后空白；不要求一定在末尾（桥要兜住桌宠没剥干净的）。 */
const IMG_TAG = /\[图[:：]\s*([^\]\n]+?)\s*\]/g;
/** 独立的 `[表情名]`：只认白名单里的短名字，`[语音 3″]`、`[图片]` 之类会原样保留。 */
const PLAIN_TAG = /\[([^\]\n]{1,10})\]/g;

/**
 * 造一个渲染器。
 * @param {object} options config.reply.stickers 的内容；缺省即全部默认开启。
 */
export function makeRenderer(options = {}) {
  const cfg = {
    enabled: true,
    dirs: DEFAULT_MEME_DIRS,
    faceIds: {},
    maxImages: 1,
    maxImageBytes: 2 * 1024 * 1024,
    stripUnknown: true,
    ...options,
  };
  const dirs = (Array.isArray(cfg.dirs) && cfg.dirs.length ? cfg.dirs : DEFAULT_MEME_DIRS)
    .map((d) => (isAbsolute(d) ? d : join(process.cwd(), d)))
    .filter((d) => existsSync(d));
  const faces = { ...DEFAULT_FACE_IDS, ...(cfg.faceIds && typeof cfg.faceIds === 'object' ? cfg.faceIds : {}) };

  /** 表情包名 → 磁盘上的 PNG；同时挡住路径穿越与非法文件名。 */
  function resolveMeme(name) {
    const n = String(name ?? '').trim();
    if (!n || n.includes('..') || /[\\/:*?"<>|]/.test(n)) return '';
    for (const dir of dirs) {
      const file = join(dir, n + '.png');
      if (existsSync(file)) return file;
    }
    return '';
  }

  /** 表情名 → CQ face 码；不在白名单返回空串。 */
  function faceCq(name) {
    const n = String(name ?? '').trim();
    if (!Object.hasOwn(faces, n)) return '';
    const id = Number(faces[n]);
    return Number.isInteger(id) && id >= 0 ? `[CQ:face,id=${id}]` : '';
  }

  /** 本地 PNG → `[CQ:image,file=base64://…]`；过大或读失败返回空串。 */
  function imageCq(file) {
    try {
      if (statSync(file).size > cfg.maxImageBytes) return '';
      return `[CQ:image,file=base64://${readFileSync(file).toString('base64')}]`;
    } catch {
      return '';
    }
  }

  /**
   * 翻译一轮回复。
   * @param {string} said  /chat 响应里的 text
   * @param {string} image /chat 响应里的 image（桌宠剥出来的池内图名），可为 undefined
   * @returns {{text: string, images: string[], notes: string[]}}
   *          text 里已去掉配图标记、把 QQ 表情名换成 CQ 码；images 是要追加发送的 PNG 绝对路径。
   */
  function render(said, image) {
    const text0 = String(said ?? '');
    if (!cfg.enabled) return { text: text0, images: [], notes: [] };

    const images = [];
    const notes = [];

    // 1) 配图标记：池内 → 收进图片；QQ 表情名 → 换成小黄脸；其余 → 去掉（或保留，看配置）
    let text = text0.replace(IMG_TAG, (whole, rawName) => {
      const n = String(rawName).trim();
      const file = resolveMeme(n);
      if (file) {
        images.push(file);
        notes.push(`图:${n}`);
        return '';
      }
      const fc = faceCq(n);
      if (fc) {
        notes.push(`表情:${n}`);
        return fc;
      }
      notes.push(`未知:${n}`);
      return cfg.stripUnknown ? '' : whole;
    });

    // 2) 人设里那些独立的 `[委屈]` 等 → QQ 小黄脸
    text = text.replace(PLAIN_TAG, (whole, rawName) => faceCq(rawName) || whole);

    // 3) /chat 的 image 字段（桌宠已剥掉标记、只留字段名的那一类）
    const apiName = String(image ?? '').trim();
    if (apiName) {
      const file = resolveMeme(apiName);
      if (file) {
        images.push(file);
        notes.push(`接口图:${basename(file)}`);
      } else {
        notes.push(`接口图未找到:${apiName}`);
      }
    }

    const max = Math.max(0, Math.floor(Number(cfg.maxImages) || 0));
    return { text, images: [...new Set(images)].slice(0, max), notes };
  }

  return { render, imageCq, resolveMeme, faceCq, cfg, dirs, faces };
}
