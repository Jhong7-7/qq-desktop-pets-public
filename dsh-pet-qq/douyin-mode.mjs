#!/usr/bin/env node
/**
 * douyin-mode.mjs —— 溪颜自己的抖音浏览模块（第一版骨架）。
 *
 * 目的：让她有自己的账号、自己刷推荐流，刷到的内容看图理解后主动拿来聊。
 * 复用桥的 /chat 多模态 attachment（照 watch-mode.mjs 的 ask(prompt, {mediaType,data})），
 * 不引入额外视觉模型。发言走 deliver() 发回 QQ，与观赛模式互斥（观赛开着时不发言）。
 *
 * 互动安全闸门：
 *   · 她在回复里写 [赞] / [评:内容] / [发:内容] / [skip]，模块解析后执行；
 *   · 评论和发动态默认人审：先进待审清单（douyin-pending.json），哥哥在 QQ 里
 *     「抖音同意 <编号>」才真正提交；只有 config.douyin.humanReview=false 才自动执行；
 *   · 硬上限：每小时评论数 / 每天发动态数 / 单次会话互动总数，超限只记审计不执行；
 *   · 敏感内容过滤：政治敏感词、手机号/身份证/银行卡等隐私一律不发，拿不准进待审；
 *   · 所有自动操作写本地审计日志（只记动作和内容摘要，不记登录态）。
 *
 * 登录态：
 *   · storageState 存 .secret/douyin-state.json，不写日志、不写记忆、不进 git；
 *   · 首次由用户本人扫码：模块拉起登录页等待，超时自动放弃；
 *   · 登录态失效时明确提示「抖音登录过期，需要重新扫码」，不静默失败。
 *
 * 桌面共看（2026-11-24 加）：
 *   · 浏览器窗口默认开在屏幕外（--window-position=-32000,-32000），页面可见、媒体能播、
 *     不抢键盘焦点、不挡你；只有登录扫码或你发「抖音抬窗」时才搬到屏幕里。
 *   · 共看模式每 20 秒抓 1~9 帧拼成一张分镜图（裁黑边、去重），连她一句话发回 QQ；
 *     每小时最多 20 条，观赛开着/夜间静默时不播。
 *   · 截图落 tmp/douyin-shots，经 deliver(rawImageFile) 用 base64 CQ 发图，不进表情包池。
 *
 * 评论区 @ 主人：她写 [评@:内容] 时，评论会带上 @ownerDouyinName（配置里留空则不 @）。
 * 仍走人审：待审清单里标注「带@」，同意才提交。
 *
 * 口令：开抖音/刷抖音 → 停抖音 → 抖音状态 → 抖音待审 → 抖音同意 <编号> → 抖音拒绝 <编号>
 *   共看/不共看了 → 你在看啥 → 抖音抬窗/抖音收窗 → 下一条
 * 默认 config.douyin.enabled=false：模块加载但不响应任何口令，聊天零影响。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { createProxyBrowser, resolvePluginEndpoint } from './douyin-plugin-bridge.mjs';

// ── 口令解析 ────────────────────────────────────────────────────────────

export const START_WORDS = Object.freeze(['开抖音', '刷抖音', '开个抖音', '打开抖音']);
export const STOP_WORDS = Object.freeze(['停抖音', '不刷了', '别刷了', '关闭抖音', '关抖音', '停止刷抖音']);
export const STATUS_WORDS = Object.freeze(['抖音状态', '在刷抖音吗', '抖音开着吗']);
export const PENDING_WORDS = Object.freeze(['抖音待审', '待审清单']);
export const LOGIN_WORDS = Object.freeze(['抖音登录过期', '重新扫码']);
// 桌面共看口令
export const COWATCH_ON_WORDS = Object.freeze(['共看', '一起刷', '开共看']);
export const COWATCH_OFF_WORDS = Object.freeze(['不共看了', '关共看', '结束共看']);
export const WHAT_NOW_WORDS = Object.freeze(['你在看啥', '看到哪了', '现在看的是什么', '抖音在看啥']);
export const RAISE_WORDS = Object.freeze(['抖音抬窗', '把抖音抬出来', '让我看抖音窗口']);
export const PARK_WORDS = Object.freeze(['抖音收窗', '把抖音收回去']);
export const NEXT_WORDS = Object.freeze(['下一条', '换一个', '抖音下一条']);

/** 「抖音同意 3」/「抖音拒绝 3」→ { kind:'approve'|'reject', id:3 } */
export function parsePendingCommand(text) {
  const s = String(text ?? '').trim();
  const ap = s.match(/^抖音(?:同意|通过|发)\s*[#＃]?\s*(\d+)$/);
  if (ap) return { kind: 'approve', id: Number(ap[1]) };
  const rj = s.match(/^抖音(?:拒绝|不要|算了)\s*[#＃]?\s*(\d+)$/);
  if (rj) return { kind: 'reject', id: Number(rj[1]) };
  return null;
}

export function parseDouyinCommand(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const pend = parsePendingCommand(s);
  if (pend) return pend;
  // 顺序要紧：「不共看了」里含「共看」，必须先匹配关闭，再匹配开启。
  if (COWATCH_OFF_WORDS.some((w) => s.includes(w))) return { kind: 'cowatch-off' };
  if (COWATCH_ON_WORDS.some((w) => s.includes(w))) return { kind: 'cowatch-on' };
  if (WHAT_NOW_WORDS.some((w) => s.includes(w))) return { kind: 'what-now' };
  if (RAISE_WORDS.some((w) => s.includes(w))) return { kind: 'raise' };
  if (PARK_WORDS.some((w) => s.includes(w))) return { kind: 'park' };
  if (NEXT_WORDS.some((w) => s.includes(w))) return { kind: 'next' };
  if (PENDING_WORDS.some((w) => s.includes(w))) return { kind: 'pending' };
  if (STOP_WORDS.some((w) => s.includes(w))) return { kind: 'stop' };
  if (STATUS_WORDS.some((w) => s.includes(w))) return { kind: 'status' };
  if (START_WORDS.some((w) => s.includes(w))) return { kind: 'start' };
  return null;
}

// ── 回复标记解析：[赞] [评:内容] [发:内容] [skip] ────────────────────────

const MARKER_RE = /[[【](评@|赞|评|发|skip)(?:[:：]\s*([^\]】]+))?[\]】]/g;

/**
 * 把她的回复拆成：普通聊天内容（talk）+ 结构化意图。
 * [评@:内容] 同时进 comments 和 mentionComments，向后兼容老的 comments 字符串数组。
 * @returns {{talk:string, skip:boolean, like:boolean, comments:string[], mentionComments:string[], posts:string[], markers:string[]}}
 */
export function parseDouyinReply(text) {
  const raw = String(text ?? '');
  const out = { talk: '', skip: false, like: false, comments: [], mentionComments: [], posts: [], markers: [] };
  const stripped = raw.replace(MARKER_RE, (m, tag, body) => {
    out.markers.push(tag);
    const t = String(tag).toLowerCase();
    if (t === 'skip') out.skip = true;
    else if (t === '赞') out.like = true;
    else if (t === '评' || t === '评@') {
      const c = String(body ?? '').trim();
      if (c) { out.comments.push(c); if (t === '评@') out.mentionComments.push(c); }
    }
    else if (t === '发') { const c = String(body ?? '').trim(); if (c) out.posts.push(c); }
    return '';
  });
  out.talk = stripped.replace(/【私聊[^\n】]*】/g, '').replace(/（旁白：[\s\S]*?）?$/g, '').trim();
  return out;
}

// ── 敏感内容过滤 ────────────────────────────────────────────────────────

export const DEFAULT_SENSITIVE_WORDS = Object.freeze([
  '习近平', '毛泽东', '李克强', '温家宝', '胡锦涛', '邓小平', '江泽民',
  '六四', '天安门事件', '法轮功', '台独', '港独', '疆独', '藏独',
  '共党', '共产党倒台', '颠覆国家', '分裂国家', '游行示威',
  '枪支买卖', '毒品', '代开发票', '洗钱', '博彩', '赌场',
]);

const PRIVACY_RES = Object.freeze([
  [/\b1[3-9]\d{9}\b/, '手机号'],
  [/\b\d{17}[\dXx]\b/, '身份证号'],
  [/\b\d{16,19}\b/, '疑似银行卡号'],
]);

/**
 * 评论/动态内容闸门。返回 {ok:true} 或 {ok:false, reason}。
 * 命中敏感词或隐私格式一律拒绝；内容超长拒绝。拿不准的场景由人审兜底
 * （默认 humanReview=true，自动执行本来就过不了这一层）。
 */
export function sanitizeContent(text, cfg = {}) {
  const s = String(text ?? '').trim();
  const maxChars = Number(cfg.maxContentChars ?? 120);
  if (!s) return { ok: false, reason: '内容为空' };
  if (s.length > maxChars) return { ok: false, reason: `内容太长（${s.length} > ${maxChars} 字）` };
  const words = Array.isArray(cfg.sensitiveWords) && cfg.sensitiveWords.length
    ? cfg.sensitiveWords : DEFAULT_SENSITIVE_WORDS;
  const hit = words.find((w) => w && s.includes(String(w)));
  if (hit) return { ok: false, reason: '命中敏感词' };
  for (const [re, label] of PRIVACY_RES) {
    if (re.test(s)) return { ok: false, reason: `包含${label}等隐私信息` };
  }
  return { ok: true, reason: '' };
}

// ── 频率上限 ────────────────────────────────────────────────────────────

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/**
 * 频率闸门。counters 形如 { commentTimes:number[], postTimes:number[], interactions:number }。
 * kind: 'comment' | 'post' | 'like'（like 只占单次会话互动总数）。
 */
export function rateGate(counters, kind, now, cfg = {}) {
  const maxCommentsPerHour = Math.max(0, Math.floor(Number(cfg.maxCommentsPerHour ?? 5)));
  const maxPostsPerDay = Math.max(0, Math.floor(Number(cfg.maxPostsPerDay ?? 2)));
  const maxInteractions = Math.max(0, Math.floor(Number(cfg.maxInteractionsPerSession ?? 20)));
  const comments = (Array.isArray(counters.commentTimes) ? counters.commentTimes : []).filter((t) => now - t < HOUR_MS);
  const posts = (Array.isArray(counters.postTimes) ? counters.postTimes : []).filter((t) => now - t < DAY_MS);
  if (counters.interactions >= maxInteractions) {
    return { allow: false, reason: `本次会话互动已达上限（${counters.interactions}/${maxInteractions}）`, counters };
  }
  if (kind === 'comment' && comments.length >= maxCommentsPerHour) {
    return { allow: false, reason: `每小时评论已达上限（${comments.length}/${maxCommentsPerHour}）`, counters };
  }
  if (kind === 'post' && posts.length >= maxPostsPerDay) {
    return { allow: false, reason: `今天发动态已达上限（${posts.length}/${maxPostsPerDay}）`, counters };
  }
  return { allow: true, reason: '', counters: { ...counters, commentTimes: comments, postTimes: posts } };
}

// ── 发言闸门（话题分享）：与观赛同款思路，两条主动线互斥 ────────────────

export function topicGate(speakTimes, lastSpeakAt, now, cfg = {}) {
  const minGap = Number(cfg.minTopicIntervalMs ?? 180000);
  if (now - lastSpeakAt < minGap) return { allow: false, reason: '距上一条话题太近' };
  const recent = (Array.isArray(speakTimes) ? speakTimes : []).filter((t) => now - t < HOUR_MS);
  const cap = Math.max(1, Math.floor(Number(cfg.maxTopicsPerHour ?? 10)));
  if (recent.length >= cap) return { allow: false, reason: `一小时已分享 ${recent.length} 条（上限 ${cap}）`, recent };
  return { allow: true, reason: '', recent };
}

// ── 共看播报闸门（纯函数，便于离线自测）────────────────────────────────

export function coWatchGate(coWatchTimes, lastCoWatchAt, now, cfg = {}) {
  if (cfg.enabled === false) return { allow: false, reason: '共看没开' };
  const interval = Math.max(15000, Number(cfg.coWatchIntervalMs ?? 20000));
  const cap = Math.max(1, Math.floor(Number(cfg.coWatchMaxPerHour ?? 20)));
  if (now - lastCoWatchAt < interval) return { allow: false, reason: '距上一条共看太近' };
  const recent = (Array.isArray(coWatchTimes) ? coWatchTimes : []).filter((t) => now - t < HOUR_MS);
  if (recent.length >= cap) {
    return { allow: false, reason: `共看一小时已发 ${recent.length} 条（上限 ${cap}）`, recent };
  }
  return { allow: true, reason: '', recent };
}

// ── 默认 prompt ────────────────────────────────────────────────────────

export const DEFAULT_BROWSE_PROMPT =
  '【私聊｜只有你和哥哥两个人｜下面的聊天内容会发回私聊】\n' +
  '（旁白：你正登录着自己的抖音号刷推荐流，下面是当前这条内容的截图和文字，你自己能看见。' +
  '看完这条，如果有值得跟哥哥说的（好笑的、新鲜的、想吐槽的、想问他的），说一两句，短，像刷到东西顺手分享；没什么可说就别硬说。' +
  '只说你真的看见的东西，看不清就说看不清，不要编作者名、标题、数据，也不要说「我看到了图片」「收到截图」。' +
  '说完聊天内容后，可以在末尾另起一行写操作标记（都可以不写）：\n' +
  '[赞] —— 给这条点个赞\n' +
  '[评:内容] —— 想评论这句（会先给哥哥过目，同意才发出去）\n' +
  '[评@:内容] —— 想评论且想喊哥哥来看（会在评论里 @ 哥哥，同样要他同意）\n' +
  '[发:内容] —— 想发一条动态（同样先给哥哥过目）\n' +
  '[skip] —— 这条不值得互动\n' +
  '评论和动态都会先给哥哥人审；涉及政治敏感、别人隐私的内容绝对不要写，拿不准就不写。' +
  '别把群里的事、泡泡说过的话带进来。这条内容实在没什么意思，就只回 [skip]。）';

/** 共看时追加：让她每帧都用一句话讲讲当前画面，QQ 那头才不会收到一张没头没尾的图。 */
export const COWATCH_PROMPT_ADDON =
  '\n（现在是和哥哥一起看的共看时间：不管有没有值得互动的，都用一句话说说你眼前这条是什么、你在想什么，短的、像边刷边随口讲；这张画面会连同你这句话一起发到 QQ 给他看。）';

// ── 真实浏览器层（playwright-core 连系统 Edge/Chrome，不下载二进制）────

const LOGIN_TIMEOUT_MS_DEFAULT = 180000;

/**
 * 创建真实抖音浏览器会话。仅当 config.douyin.enabled=true 且收到开启口令时才启动；
 * 停抖音 / 自动结束时关闭。不常驻、不占前台（headless 默认 true，只有扫码登录时用有头窗口）。
 */
export async function createDouyinBrowser(cfg = {}, log = () => {}) {
  let pw;
  try {
    pw = await import('playwright-core');
  } catch (e) {
    return { ok: false, reason: `playwright-core 没装上（${e instanceof Error ? e.message : String(e)}）` };
  }
  const statePath = String(cfg.statePath ?? '');
  // 桌面共看：默认「屏幕外可见窗口」——页面 visible、媒体能播、不抢键盘焦点、不挡你。
  // 只有扫码登录或收到「抖音抬窗」时才搬回屏幕。
  const visibleWindow = cfg.visibleWindow === true;
  const parkOffscreen = cfg.windowParkOffscreen !== false;
  const w = Math.max(640, Number(cfg.viewportWidth ?? 1280));
  const h = Math.max(480, Number(cfg.viewportHeight ?? 800));
  const headless = visibleWindow ? false : (cfg.headless !== false);
  const launchOpts = {
    headless,
    args: [
      // 窗口被挡/最小化时别让页面停止渲染（Coo 浏览器扩展实测必需）
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-blink-features=AutomationControlled',
      `--window-size=${w},${h}`,
    ],
  };
  if (visibleWindow) {
    launchOpts.args.push(parkOffscreen ? '--window-position=-32000,-32000' : `--window-position=${String(cfg.windowPosition ?? '120,80')}`);
  }
  // 复用系统已装的 Edge/Chrome（playwright-core 不自带浏览器二进制）。
  // 显式配置优先；否则按常见安装路径探测，避免去找并不存在的自带 Chromium。
  const exeCandidates = [
    cfg.browserPath, cfg.edgePath,
    'D:/Quark/7.4.7.1036/quark.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean).map((p) => String(p));
  const exe = exeCandidates.find((p) => { try { return existsSync(p); } catch { return false; } });
  if (exe) launchOpts.executablePath = exe;
  else return { ok: false, reason: '没找到可用的浏览器（系统 Edge/Chrome 都没装或路径不对），麻烦哥哥装一下 Edge' };

  let browser = null;
  let context = null;
  let page = null;
  let windowOnScreen = false;

  /** CDP 搬窗口：true=抬到眼前，false=收回屏幕外。抬 z 序 CDP 做不到，Windows 侧由宿主补。 */
  async function moveWindow(onScreen) {
    if (!context || !page) return { ok: false, reason: '浏览器没打开' };
    try {
      const session = await context.newCDPSession(page);
      const { windowId } = await session.send('Browser.getWindowForTarget');
      const [px, py] = String(cfg.windowPosition ?? '120,80').split(',').map(Number);
      const bounds = onScreen
        ? { left: Number.isFinite(px) ? px : 120, top: Number.isFinite(py) ? py : 80, width: w, height: h, windowState: 'normal' }
        : { left: -32000, top: -32000, width: w, height: h, windowState: 'normal' };
      await session.send('Browser.setWindowBounds', { windowId, bounds });
      windowOnScreen = onScreen;
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 多帧拼分镜图：在 about:blank 里用 canvas 合成，不依赖图像库、不受抖音页 CSP 影响。 */
  async function stitchFrames(frames) {
    if (frames.length <= 1) return { jpeg: frames[0] ?? '', kept: frames.length };
    let sp = null;
    try {
      sp = await context.newPage();
      const r = await sp.evaluate(async ({ frames, cellW, cellH, threshold }) => {
        const load = (b64) => new Promise((resolve) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => resolve(null);
          im.src = 'data:image/jpeg;base64,' + b64;
        });
        const imgs = (await Promise.all(frames.map(load))).filter(Boolean);
        if (!imgs.length) return { jpeg: '', kept: 0 };
        const sigOf = (im) => {
          const c = document.createElement('canvas'); c.width = 24; c.height = 14;
          const x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(im, 0, 0, 24, 14);
          return x.getImageData(0, 0, 24, 14).data;
        };
        const diff = (a, b) => {
          let s = 0;
          for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          return s / (a.length / 4 * 3);
        };
        const keep = [];
        for (const im of imgs) {
          const sg = sigOf(im);
          if (keep.length && diff(sg, keep[keep.length - 1].sig) < threshold) continue; // 画面没变就不重复占一格
          keep.push({ im, sig: sg });
        }
        if (!keep.length) return { jpeg: '', kept: 0 };
        const cols = Math.ceil(Math.sqrt(keep.length));
        const rows = Math.ceil(keep.length / cols);
        const cv = document.createElement('canvas');
        cv.width = cols * cellW; cv.height = rows * cellH;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#101010'; ctx.fillRect(0, 0, cv.width, cv.height);
        keep.forEach((k, i) => {
          const scale = Math.min(cellW / k.im.width, cellH / k.im.height);
          const cw = k.im.width * scale, ch = k.im.height * scale;
          ctx.drawImage(k.im, (i % cols) * cellW + (cellW - cw) / 2, Math.floor(i / cols) * cellH + (cellH - ch) / 2, cw, ch);
        });
        return { jpeg: cv.toDataURL('image/jpeg', 0.72).split(',')[1] || '', kept: keep.length };
      }, {
        frames,
        cellW: Math.max(240, Number(cfg.coWatchCellWidth ?? 480)),
        cellH: Math.max(160, Number(cfg.coWatchCellHeight ?? 300)),
        threshold: Number(cfg.coWatchDedupThreshold ?? 4),
      });
      return r && r.jpeg ? { jpeg: r.jpeg, kept: Number(r.kept) || 1 } : { jpeg: frames[0], kept: 1 };
    } catch {
      return { jpeg: frames[0], kept: 1 };
    } finally {
      if (sp) { try { await sp.close(); } catch { /* ignore */ } }
    }
  }

  async function launchForLogin() {
    try {
      browser = await pw.chromium.launch({ ...launchOpts, headless: false });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // 把 Playwright 的长篇英文报错翻译成一句人话，方便她转述给哥哥。
      const reason = /Executable doesn't exist|Looks like Playwright/i.test(raw)
        ? '系统浏览器路径找不到，得让哥哥确认 Edge 装好了'
        : `浏览器启动失败（${raw.slice(0, 120)}）`;
      const err = new Error(reason);
      err.douyinReason = reason;
      throw err;
    }
    context = await browser.newContext({
      viewport: { width: Number(cfg.viewportWidth ?? 1280), height: Number(cfg.viewportHeight ?? 800) },
      locale: 'zh-CN',
      storageState: statePath && existsSync(statePath) ? statePath : undefined,
    });
    page = await context.newPage();
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  }

  return {
    /** 拉起浏览器并确认登录态。未登录 → 等扫码（loginTimeoutMs），成功落 storageState。 */
    async open() {
      await launchForLogin();
      if (await this.isLoggedIn()) {
        log('抖音：已有登录态，直接开始浏览');
        return { ok: true, needLogin: false };
      }
      log('抖音：没有登录态，等用户扫码');
      await page.goto('https://www.douyin.com/login?enter_from=main', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      // 屏幕外窗口用户看不见：扫码前把窗口抬回来，扫完再收回去。
      const raised = await moveWindow(true);
      if (!raised.ok) log(`抖音：抬窗失败（${raised.reason}），扫码可能看不见窗口`);
      const deadline = Date.now() + Number(cfg.loginTimeoutMs ?? LOGIN_TIMEOUT_MS_DEFAULT);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2500));
        if (await this.isLoggedIn()) {
          if (statePath) {
            mkdirSync(dirname(statePath), { recursive: true });
            await context.storageState({ path: statePath });
            log(`抖音：扫码登录成功，登录态已保存到 ${statePath}`);
          }
          if (visibleWindow && parkOffscreen && cfg.keepWindowAfterLogin !== true) await moveWindow(false);
          return { ok: true, needLogin: true };
        }
      }
      await this.close();
      return { ok: false, reason: '等待扫码超时，没有登录成功' };
    },

    async isLoggedIn() {
      if (!context) return false;
      try {
        const cookies = await context.cookies('https://www.douyin.com');
        return cookies.some((c) => c.name === 'sessionid' || c.name === 'sessionid_ss');
      } catch { return false; }
    },

    /** 翻到下一条：优先方向键，兜底滚轮。 */
    async next() {
      if (!page) return;
      await page.keyboard.press('ArrowDown').catch(() => {});
      await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 1800)));
    },

    /** 抓 1~9 帧拼成分镜图 + 可见文本；落盘供 QQ 发图用。 */
    async capture() {
      if (!page) return { ok: false, reason: '页面没打开' };
      try {
        const n = Math.max(1, Math.min(9, Math.floor(Number(cfg.coWatchFrames ?? 3))));
        const frames = [];
        for (let i = 0; i < n; i += 1) {
          if (i) await new Promise((r) => setTimeout(r, Math.max(200, Number(cfg.coWatchFrameGapMs ?? 600))));
          const buf = await page.screenshot({ type: 'jpeg', quality: Number(cfg.jpegQuality ?? 60) });
          frames.push(buf.toString('base64'));
        }
        const stitched = cfg.coWatchStitch === false
          ? { jpeg: frames[0], kept: 1 }
          : await stitchFrames(frames);
        let jpeg = String(stitched?.jpeg ?? '');
        const text = await page.evaluate(() => {
          const el = document.querySelector('[data-e2e="feed-item"], .web-feed-item, article, main')
            || document.body;
          return String(el?.innerText ?? '').replace(/\s+\n/g, '\n').slice(0, 600);
        }).catch(() => '');
        // /chat 一次只带一张图：超上限时降级为纯文字，整条仍算抓帧成功。
        const maxB64 = Number(cfg.maxScreenshotBase64 ?? 900000);
        if (jpeg.length > maxB64) { jpeg = ''; log('抖音：截图过大，这条只发文字'); }
        let shotPath = '';
        const dir = String(cfg.shotDir ?? '');
        if (jpeg && dir) {
          try {
            mkdirSync(dir, { recursive: true });
            shotPath = join(dir, `${Date.now()}-${Math.floor(Math.random() * 1000)}.jpg`);
            writeFileSync(shotPath, Buffer.from(jpeg, 'base64'));
          } catch { shotPath = ''; }
        }
        return { ok: true, jpeg, text, shotPath, kept: Number(stitched?.kept) || 1 };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    /** 点赞（尽力而为：抖音 DOM 会改版，失败只记原因，不影响浏览）。 */
    async like() {
      if (!page) return { ok: false, reason: '页面没打开' };
      for (const sel of ['[data-e2e="feed-like-icon"]', '.xgplayer-dm', 'button[aria-label*="赞"]', '[class*="like"]']) {
        try {
          const el = page.locator(sel).first();
          if (await el.count() && await el.isVisible()) { await el.click({ timeout: 3000 }); return { ok: true }; }
        } catch { /* 尝试下一个选择器 */ }
      }
      return { ok: false, reason: '没找到点赞按钮' };
    },

    /** 评论（默认人审）。mention=true 时尝试在评论里 @ 主人；候选没弹出就留纯文本 @。 */
    async comment(text, mention = false) {
      if (!page) return { ok: false, reason: '页面没打开' };
      const name = String(cfg.ownerDouyinName ?? '').trim();
      const body = String(text);
      let mentionNote = '';
      for (const sel of ['[data-e2e="comment-input"]', '[class*="comment"] textarea', '[contenteditable="true"]']) {
        try {
          const el = page.locator(sel).first();
          if (await el.count() && await el.isVisible()) {
            await el.click({ timeout: 3000 });
            if (mention && name) {
              await page.keyboard.type(`@${name}`, { delay: 60 }).catch(() => {});
              await new Promise((r) => setTimeout(r, 700));
              let picked = false;
              for (const ms of ['[data-e2e*="mention"]', '[class*="mention"] li', '[class*="at-user"]', '[class*="suggest"] li']) {
                try {
                  const cand = page.locator(ms).filter({ hasText: name }).first();
                  if (await cand.count() && await cand.isVisible()) { await cand.click({ timeout: 2000 }); picked = true; break; }
                } catch { /* 试下一个候选选择器 */ }
              }
              if (!picked) {
                await page.keyboard.press('Enter').catch(() => {}); // 让 @ 文本落进输入框
                mentionNote = '（@候选没弹出，按纯文本发了）';
              }
              await page.keyboard.type(` ${body}`, { delay: 35 }).catch(() => {});
            } else {
              await el.fill(body).catch(async () => { await page.keyboard.type(body, { delay: 40 }); });
            }
            await page.keyboard.press('Enter');
            return { ok: true, mention: Boolean(mention && name), mentionNote };
          }
        } catch { /* 尝试下一个选择器 */ }
      }
      return { ok: false, reason: '没找到评论输入框' };
    },

    /** 发动态（默认人审，真正提交发生在用户确认之后）。 */
    async post(text) {
      if (!page) return { ok: false, reason: '页面没打开' };
      try {
        await page.goto('https://www.douyin.com/community', { waitUntil: 'domcontentloaded', timeout: 45000 });
        for (const sel of ['textarea', '[contenteditable="true"]']) {
          const el = page.locator(sel).first();
          if (await el.count() && await el.isVisible()) {
            await el.click({ timeout: 3000 });
            await el.fill(String(text)).catch(async () => { await page.keyboard.type(String(text), { delay: 40 }); });
            const btn = page.locator('button:has-text("发布")').first();
            if (await btn.count()) { await btn.click({ timeout: 5000 }); return { ok: true }; }
          }
        }
        return { ok: false, reason: '没找到发布入口' };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    /** 「抖音抬窗」/「抖音收窗」：true 搬到屏幕里，false 收回屏幕外。 */
    async focus(onScreen = true) { return moveWindow(Boolean(onScreen)); },
    windowOnScreen: () => windowOnScreen,

    async close() {
      try { if (browser) await browser.close(); } catch { /* ignore */ }
      browser = null; context = null; page = null; windowOnScreen = false;
    },
  };
}

// ── 主状态机 ───────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} deps.cfg            config.json 的 douyin 段
 * @param {boolean} deps.enabled       总开关（enabled=false 时所有口令都不响应）
 * @param {(msg:string)=>void} deps.log
 * @param {(prompt:string, attachment:object)=>Promise<{text:string,image?:string}>} deps.ask
 * @param {(target:object, reply:object)=>Promise<number>} deps.send
 * @param {(target:object)=>void} deps.onSpoke    让桥把常规主动续话往后推
 * @param {()=>boolean} deps.watchActive        观赛模式是否开着（互斥：开着就不发言）
 * @param {()=>boolean} deps.quietActive
 * @param {()=>number} deps.now
 * @param {string} deps.here                     桥目录绝对路径（落待审/审计文件用）
 * @param {()=>Promise<object>} deps.browserFactory  可注入 mock（离线自测）
 */
export function createDouyinMode(deps) {
  const {
    cfg = {}, enabled = true, log = () => {}, ask, send, onSpoke = () => {},
    watchActive = () => false, quietActive = () => false, now = () => Date.now(),
    here = process.cwd(), browserFactory,
  } = deps;

  const intervalMs = Math.max(15000, Number(cfg.intervalMs ?? 90000));
  const jitterMs = Math.max(0, Number(cfg.jitterMs ?? 30000));
  // 共看节奏：默认 20 秒一张拼图、每小时 20 条上限；间隔别低于 15 秒（免得刷屏）。
  const coWatchIntervalMs = Math.max(15000, Number(cfg.coWatchIntervalMs ?? 20000));
  const coWatchJitterMs = Math.max(0, Number(cfg.coWatchJitterMs ?? 5000));
  const coWatchMaxPerHour = Math.max(1, Math.floor(Number(cfg.coWatchMaxPerHour ?? 20)));
  let coWatch = cfg.coWatch !== false;
  const autoStopMs = Math.max(60000, Number(cfg.autoStopMs ?? 3600000));
  const humanReview = cfg.humanReview !== false;
  const statePath = (() => {
    const p = String(cfg.statePath ?? join(here, '.secret', 'douyin-state.json'));
    return isAbsolute(p) ? p : join(here, p);
  })();
  const pendingFile = (() => {
    const p = String(cfg.pendingFile ?? 'douyin-pending.json');
    return isAbsolute(p) ? p : join(here, p);
  })();
  const auditFile = (() => {
    const p = String(cfg.auditFile ?? join(here, 'logs', 'douyin-audit.log'));
    return isAbsolute(p) ? p : join(here, p);
  })();
  const bypassQuiet = cfg.bypassQuietHours === true;

  let phase = 'off';           // off | login | active
  let target = null;
  let browser = null;
  let loopTimer = null;
  let stopTimer = null;
  let busy = false;
  let startedAt = 0;
  let browsed = 0;
  let lastSpeakAt = 0;
  let speakTimes = [];
  let lastCoWatchAt = 0;
  let coWatchTimes = [];
  let currentShot = '';      // 本轮抓帧落盘路径，随这条消息一起发 QQ
  let lastPushedKey = '';    // 上一次共看推过去的"内容指纹"，同一条不重复播报
  let counters = { commentTimes: [], postTimes: [], interactions: 0 };
  let loginExpired = false;
  let pending = loadPending();

  function absPath(p) { return isAbsolute(p) ? p : join(here, p); }

  function loadPending() {
    try {
      if (!existsSync(pendingFile)) return [];
      const arr = JSON.parse(readFileSync(pendingFile, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function savePending() {
    try {
      mkdirSync(dirname(pendingFile), { recursive: true });
      writeFileSync(pendingFile, JSON.stringify(pending, null, 2));
    } catch (e) {
      log(`抖音：待审清单写盘失败（${e instanceof Error ? e.message : String(e)}）`);
    }
  }

  function audit(action, summary) {
    try {
      mkdirSync(dirname(auditFile), { recursive: true });
      appendFileSync(auditFile, `${new Date().toISOString()} ${action} ${String(summary).slice(0, 80).replace(/\n/g, ' ')}\n`);
    } catch { /* 审计失败不阻塞主流程 */ }
  }

  function rejectInteraction(reason) {
    audit('blocked', reason);
    log(`抖音：互动被闸门拦下（${reason}）`);
  }

  /** shotFile 是分镜图落盘路径，桥的 deliver(rawImageFile) 会把它当图片段发；普通提示不传。 */
  async function say(text, shotFile = '') {
    if (!target) return;
    try { await send(target, { text, image: '', shotFile }); } catch (e) {
      log(`抖音：提示没发出去（${e instanceof Error ? e.message : String(e)}）`);
    }
  }

  function clearTimers() {
    if (loopTimer) clearTimeout(loopTimer);
    if (stopTimer) clearTimeout(stopTimer);
    loopTimer = null;
    stopTimer = null;
  }

  function reset() {
    clearTimers();
    phase = 'off';
    busy = false;
    startedAt = 0;
    browsed = 0;
    lastSpeakAt = 0;
    speakTimes = [];
    lastCoWatchAt = 0;
    coWatchTimes = [];
    currentShot = '';
    lastPushedKey = '';
    counters = { commentTimes: [], postTimes: [], interactions: 0 };
    // loginExpired 只在明确重新登录后清除；coWatch 开关跨会话保留
  }

  async function stop(reason, notify = true) {
    if (phase === 'off') return;
    const t = target;
    log(`抖音浏览结束：${reason}（共刷 ${browsed} 条，会话互动 ${counters.interactions} 次）`);
    reset();
    if (browser) { await browser.close(); browser = null; }
    if (notify && t) await say('好，抖音我先关啦，想让我再刷就说「开抖音」。');
  }

  /** 随机化间隔：共看用 20s±5s，普通话题用 90s±30s，绝不准点。同一时刻只保留一条循环链。 */
  function scheduleNext(delay = null) {
    if (loopTimer) clearTimeout(loopTimer);
    const base = coWatch ? coWatchIntervalMs : intervalMs;
    const jit = coWatch ? coWatchJitterMs : jitterMs;
    const d = delay === null ? base + Math.floor((Math.random() * 2 - 1) * jit) : delay;
    loopTimer = setTimeout(() => void tick(), Math.max(5000, d));
    loopTimer.unref?.();
  }

  async function ensureBrowser() {
    if (browser) return { ok: true };
    // 优先复用 DSH 插件那一个浏览器：她在那边看到的、和共看推过去的，必须是同一张画面。
    // 注入 browserFactory（离线自测）时不走这条路，测试保持零依赖。
    if (!browserFactory && cfg.preferPluginBrowser !== false) {
      const ep = await resolvePluginEndpoint({ cfg, bridgeDir: here, dshHome: process.env.DSH_HOME, log })
        .catch(() => null);
      if (ep) {
        browser = createProxyBrowser(ep, { log });
        log(`抖音：复用插件的浏览器（${ep.origin}），共看画面与她看到的一致`);
        return { ok: true };
      }
      log('抖音：没找到插件端点，退回桥自己开浏览器（共看可能与她看到的不是同一条）');
    }
    const make = browserFactory ?? createDouyinBrowser;
    const b = await make({ ...cfg, statePath }, log);
    if (!b || b.ok === false) {
      const reason = String(b?.reason ?? '浏览器创建失败');
      log(`抖音：${reason}`);
      await stop(reason, false);
      if (target) await say(`抖音开不起来：${reason}`);
      return { ok: false };
    }
    browser = b;
    return { ok: true };
  }

  async function tick() {
    if (phase !== 'active' || busy) return;
    if (now() - startedAt > autoStopMs) {
      await stop('一小时自动结束');
      await say('刷了一个钟头啦，我先歇会儿，想让我接着刷就说「开抖音」。');
      return;
    }
    busy = true;
    try {
      // 登录态失效检测：明确提示，不静默失败。
      if (browser?.isLoggedIn && !(await browser.isLoggedIn())) {
        loginExpired = true;
        await stop('登录态失效', false);
        await say('抖音登录过期，需要重新扫码。你说一声「开抖音」，我拉起登录页等你扫。');
        return;
      }
      const autoNext = !coWatch || cfg.coWatchAutoNext === true;
      let cap = null;
      // 共看时优先用"她刚看到的那一帧"：QQ 那头收到的，就是她正在说的那条。
      if (coWatch && typeof browser.lastFrame === 'function') {
        const lf = await browser.lastFrame(Number(cfg.lastFrameMaxAgeMs ?? 90000)).catch(() => null);
        if (lf?.ok && lf.contentKey && lf.contentKey !== lastPushedKey) {
          cap = { ...lf, source: 'her-frame' };
          log(`抖音：共看用她刚看的那一帧（${lf.contentKey}）`);
        }
      }
      if (!cap) {
        if (autoNext) await browser.next();
        cap = await browser.capture();
      }
      if (!cap?.ok) {
        log(`抖音：抓帧失败（${String(cap?.reason ?? 'unknown')}），这一条跳过`);
        return; // finally 统一续期，不在这里重复排期
      }
      const contentKey = String(cap.contentKey ?? '');
      // 共看且不自动翻页时：还是同一条内容就不再重复播报（省 token，也不会刷屏）。
      if (coWatch && !autoNext && contentKey && contentKey === lastPushedKey) {
        log('抖音：共看这条没翻页、画面没变，这轮不重复播报');
        return;
      }
      browsed += 1;
      if (browsed === 1) log(`抖音：首条采集成功（文本 ${String(cap.text ?? '').length} 字）`);
      const prompt = String(cfg.prompt?.browse ?? DEFAULT_BROWSE_PROMPT);
      // 共看时多一句要求：每帧都用一句话讲讲眼前是什么，QQ 那头才不是一张没头没尾的图。
      const basePrompt = coWatch ? `${prompt}${COWATCH_PROMPT_ADDON}` : prompt;
      // 可见文本直接拼进 prompt：attachment 原样透传给宿主，宿主只认 mediaType/data，
      // 未知字段不可靠；文本走 prompt 才保证她一定看得见。
      const promptFull = cap.text
        ? `${basePrompt}\n（这条内容的可见文字：\n${String(cap.text).slice(0, 600)}）`
        : basePrompt;
      // 截图超上限时 cap.jpeg 为空：不传附件，让桥走纯文本降级。
      const attachment = cap.jpeg ? { mediaType: 'image/jpeg', data: cap.jpeg } : undefined;
      const reply = await ask(promptFull, attachment);
      const parsed = parseDouyinReply(reply?.text ?? '');
      currentShot = String(cap.shotPath ?? '');
      await handleParsed(parsed, { shotFile: currentShot, kept: Number(cap.kept) || 1, contentKey });
    } catch (e) {
      log(`抖音：这一轮出错，已跳过（${e instanceof Error ? e.message : String(e)}）`);
    } finally {
      busy = false;
      if (phase === 'active') scheduleNext();
    }
  }

  /** 「你在看啥」：立刻抓一张发回去。你主动问的，绕开间隔/静默，但仍走互动闸门。 */
  async function broadcastNow() {
    if (!browser || phase !== 'active') { await say('抖音还没开着呢，先说「开抖音」。'); return; }
    if (busy) { await say('这轮还没刷完，等一秒我再给你看～'); return; }
    const cap = await browser.capture();
    if (!cap?.ok) { await say(`这张没抓到（${String(cap?.reason ?? 'unknown')}），等下一条我再给你看。`); return; }
    const prompt = String(cfg.prompt?.browse ?? DEFAULT_BROWSE_PROMPT);
    const full = `${prompt}${COWATCH_PROMPT_ADDON}`
      + (cap.text ? `\n（这条内容的可见文字：\n${String(cap.text).slice(0, 600)}）` : '');
    const attachment = cap.jpeg ? { mediaType: 'image/jpeg', data: cap.jpeg } : undefined;
    const reply = await ask(full, attachment);
    const parsed = parseDouyinReply(reply?.text ?? '');
    const talk = String(parsed.talk ?? '').trim() || '这就是我现在看到的。';
    const shotFile = String(cap.shotPath ?? '');
    const sent = await send(target, { text: talk, image: '', shotFile });
    if (sent > 0) {
      lastPushedKey = String(cap.contentKey ?? lastPushedKey);
      audit('what-now', talk);
      log(`抖音：按口令即时播报（${Number(cap.kept) || 1} 格）：${talk.slice(0, 60)}`);
      try { onSpoke(target); } catch { /* ignore */ }
    }
    // 她这一轮顺手写的操作标记照常执行，但不许再发第二条消息。
    await handleParsed({ ...parsed, talk: '' }, { shotFile: '', kept: Number(cap.kept) || 1 });
  }

  /** 包一层纯闸门，带上当前开关与配置；观赛互斥/夜间静默在调用处判断。 */
  function gateForCoWatch(t) {
    return coWatchGate(coWatchTimes, lastCoWatchAt, t, {
      enabled: coWatch, coWatchIntervalMs, coWatchMaxPerHour,
    });
  }

  /** 解析她的意图并执行（受闸门约束）。frame.shotFile 是本轮分镜图落盘路径。 */
  async function handleParsed(parsed, frame = {}) {
    const t = now();
    // 1) 共看播报 / 话题分享：一条内容只发一条消息，绝不「话题一条、共看又一条」。
    const talk = String(parsed.talk ?? '').trim();
    if (talk && !parsed.skip) {
      if (watchActive()) {
        log('抖音：观赛模式开着，这条不发言（互斥）');
      } else if (!bypassQuiet && quietActive()) {
        log('抖音：夜间静默期内，这条不发言');
      } else {
        const cg = gateForCoWatch(t);
        if (cg.allow) {
          // 共看：拼图 + 她一句话，一次性发出去。
          const sent = await send(target, { text: talk, image: '', shotFile: String(frame.shotFile ?? '') });
          if (sent > 0) {
            lastCoWatchAt = t;
            coWatchTimes = [...cg.recent, t];
            lastSpeakAt = t;
            speakTimes = [...speakTimes.filter((x) => t - x < HOUR_MS), t];
            lastPushedKey = String(frame.contentKey ?? lastPushedKey);
            audit('cowatch', talk);
            try { onSpoke(target); } catch { /* ignore */ }
            log(`抖音：共看播报（${Number(frame.kept) || 1} 格）：${talk.slice(0, 60)}`);
          }
        } else {
          const gate = topicGate(speakTimes, lastSpeakAt, t, cfg);
          if (gate.allow) {
            speakTimes = gate.recent;
            const sent = await send(target, { text: talk, image: '' });
            if (sent > 0) {
              lastSpeakAt = t;
              speakTimes.push(t);
              audit('topic', talk);
              try { onSpoke(target); } catch { /* ignore */ }
              log(`抖音：分享话题：${talk.slice(0, 60)}`);
            }
          } else {
            log(`抖音：话题被发言闸门拦下（${gate.reason}）`);
          }
        }
      }
    }
    // 2) [赞]
    if (parsed.like) {
      const gate = rateGate(counters, 'like', t, cfg);
      if (!gate.allow) { rejectInteraction(gate.reason); }
      else {
        counters = gate.counters;
        const r = await browser.like();
        if (r.ok) {
          counters.interactions += 1;
          audit('like', '(点赞)');
          log('抖音：点了赞');
        } else log(`抖音：点赞没执行（${r.reason}）`);
      }
    }
    // 3) [评:内容] / [评@:内容]（后者要在评论里 @ 主人）
    for (const c of parsed.comments) {
      const mention = (Array.isArray(parsed.mentionComments) ? parsed.mentionComments : []).includes(c);
      const check = sanitizeContent(c, cfg);
      const gate = rateGate(counters, 'comment', t, cfg);
      if (!check.ok) { rejectInteraction(`评论未过敏感过滤：${check.reason}`); continue; }
      if (!gate.allow) { rejectInteraction(`评论未执行：${gate.reason}`); continue; }
      counters = gate.counters;
      if (humanReview) {
        // 入队也要占额度，否则待审清单能被无限灌满（硬上限形同虚设）。
        counters.interactions += 1;
        counters.commentTimes.push(t);
        enqueuePending('comment', c, t, mention);
      } else {
        const r = await browser.comment(c, mention);
        if (r.ok) {
          counters.interactions += 1;
          counters.commentTimes.push(t);
          audit(mention ? 'comment-at' : 'comment', c);
          log(`抖音：已自动${mention ? '@主人' : ''}评论：${c.slice(0, 40)}${r.mentionNote ?? ''}`);
        } else log(`抖音：评论没执行（${r.reason}）`);
      }
    }
    // 4) [发:内容]
    for (const p of parsed.posts) {
      const check = sanitizeContent(p, cfg);
      const gate = rateGate(counters, 'post', t, cfg);
      if (!check.ok) { rejectInteraction(`动态未过敏感过滤：${check.reason}`); continue; }
      if (!gate.allow) { rejectInteraction(`动态未执行：${gate.reason}`); continue; }
      counters = gate.counters;
      if (humanReview) {
        counters.interactions += 1;
        counters.postTimes.push(t);
        enqueuePending('post', p, t);
      } else {
        const r = await browser.post(p);
        if (r.ok) {
          counters.interactions += 1;
          counters.postTimes.push(t);
          audit('post', p);
          log(`抖音：已自动发动态：${p.slice(0, 40)}`);
        } else log(`抖音：动态没执行（${r.reason}）`);
      }
    }
  }

  function enqueuePending(kind, content, queuedAt, mention = false) {
    const id = pending.reduce((m, x) => Math.max(m, x.id), 0) + 1;
    pending.push({
      id, kind, content: String(content).slice(0, 200),
      createdAt: new Date().toISOString(),
      queuedAt, // 入队时已占的额度，同意提交时释放后再按新时刻占回
      mention: kind === 'comment' ? Boolean(mention) : false,
      note: `刷到第 ${browsed} 条时想${kind === 'comment' ? (mention ? '评论并@哥哥' : '评论') : '发的动态'}`,
    });
    savePending();
    audit('pending', `${kind}#${id}${mention ? '@' : ''} ${content}`);
    log(`抖音：${kind === 'comment' ? (mention ? '带@评论' : '评论') : '动态'}进待审（#${id}）：${String(content).slice(0, 40)}`);
  }

  // ── 人审：QQ 口令确认 ────────────────────────────────────────────────

  function pendingListText() {
    if (!pending.length) return '待审清单是空的，现在没有要确认的评论或动态。';
    const lines = pending.slice(-10).map((x) => `#${x.id} ${x.kind === 'comment' ? (x.mention ? '[评@]' : '[评]') : '[发]'} ${x.content}`);
    return `待审 ${pending.length} 条（最新的在下面）：\n${lines.join('\n')}\n回复「抖音同意 编号」发出去，「抖音拒绝 编号」不要。`;
  }

  async function approvePending(id) {
    const item = pending.find((x) => x.id === id);
    if (!item) { await say(`待审里没有 #${id} 这一条。说「抖音待审」我列给你。`); return; }
    const check = sanitizeContent(item.content, cfg);
    if (!check.ok) {
      pending = pending.filter((x) => x.id !== id);
      savePending();
      audit('rejected-by-filter', `#${id} ${check.reason}`);
      await say(`#${id} 过不了内容检查（${check.reason}），我直接帮你删掉了。`);
      return;
    }
    if (phase !== 'active') {
      await say(`#${item.id} 记着呢，但抖音现在没开着；等我「开抖音」的时候再发。`);
      return;
    }
    // 先释放入队时占的额度，再按提交时刻重新过闸门，避免同一动作占两次。
    if (item.kind === 'comment') {
      counters.commentTimes = counters.commentTimes.filter((x) => x !== item.queuedAt);
    } else {
      counters.postTimes = counters.postTimes.filter((x) => x !== item.queuedAt);
    }
    const gate = rateGate(counters, item.kind, now(), cfg);
    if (!gate.allow) {
      audit('blocked', `人审 #${id} 超限：${gate.reason}`);
      await say(`#${id} 现在发不了：${gate.reason}。先留在待审里。`);
      return;
    }
    counters = gate.counters;
    const mention = item.kind === 'comment' && item.mention === true;
    const r = item.kind === 'comment' ? await browser.comment(item.content, mention) : await browser.post(item.content);
    if (r.ok) {
      if (item.kind === 'comment') counters.commentTimes.push(now()); else counters.postTimes.push(now());
      audit(mention ? 'comment-at' : item.kind, item.content);
      log(`抖音：人审通过，已${mention ? '@主人评论' : (item.kind === 'comment' ? '评论' : '发动态')}（#${id}）${r.mentionNote ?? ''}`);
      const atNote = mention
        ? (r.mention === true ? `（@了${String(cfg.ownerDouyinName ?? '').trim() || '哥哥'}）` : '（没在 config 里填 ownerDouyinName，这次没@成，当普通评论发了）')
        : '';
      await say(`#${id} 发出去啦。${atNote}${r.mentionNote ?? ''}`);
    } else {
      audit('failed', `${item.kind}#${id} ${r.reason}`);
      await say(`#${id} 没发出去（${r.reason}），先留在待审里。`);
      return;
    }
    pending = pending.filter((x) => x.id !== id);
    savePending();
  }

  async function rejectPending(id) {
    const item = pending.find((x) => x.id === id);
    if (!item) { await say(`待审里没有 #${id} 这一条。`); return; }
    pending = pending.filter((x) => x.id !== id);
    savePending();
    audit('rejected', `${item.kind}#${id} ${item.content}`);
    log(`抖音：哥哥拒绝了 #${id}`);
    await say(`好，#${id} 不发了。`);
  }

  // ── 口令入口 ─────────────────────────────────────────────────────────

  /** 返回 {handled}：true 表示这条消息是抖音口令，桥不要再当普通聊天处理。 */
  async function onUserLine(text, incomingTarget, group, atSelf) {
    if (!enabled) return { handled: false };
    const cmd = parseDouyinCommand(text);
    if (!cmd) return { handled: false };
    // 群里没点名她，不响应口令；人审确认只认私聊，避免群内误触。
    if (group && !atSelf) return { handled: false };
    const privateOnlyCmd = cmd.kind === 'pending' || cmd.kind === 'approve' || cmd.kind === 'reject';
    if (group && privateOnlyCmd) return { handled: false };
    if (cmd.kind === 'stop' && phase === 'off') return { handled: false };

    if (!target) target = { type: incomingTarget?.type ?? 'private', id: incomingTarget?.id };

    // 共看开关：没开抖音也能切，下次开就按新节奏走。
    if (cmd.kind === 'cowatch-on') {
      coWatch = true;
      lastCoWatchAt = 0;
      lastPushedKey = '';
      await say(`好，共看开啦：我每 ${Math.round(coWatchIntervalMs / 1000)} 秒给你看一张画面，说「不共看了」就停。`);
      if (phase === 'active') scheduleNext(5000);
      return { handled: true };
    }
    if (cmd.kind === 'cowatch-off') {
      coWatch = false;
      await say('好，不共看了。我还是照老样子，刷到有意思的才跟你说。');
      if (phase === 'active') scheduleNext(8000);
      return { handled: true };
    }
    // 下面几条都得先开着抖音。
    if (['what-now', 'raise', 'park', 'next'].includes(cmd.kind) && phase !== 'active') {
      await say('抖音还没开着呢，先说「开抖音」我就开始。');
      return { handled: true };
    }
    if (cmd.kind === 'raise' || cmd.kind === 'park') {
      const wantOn = cmd.kind === 'raise';
      const r = browser?.focus ? await browser.focus(wantOn) : { ok: false, reason: '这个浏览器不支持搬窗口' };
      if (r.ok) await say(wantOn ? '窗口抬出来啦，你看这边～' : '我把窗口收回去了，想看再喊我「抖音抬窗」。');
      else await say(`窗口没搬动（${r.reason ?? 'unknown'}），你直接将就 QQ 里的画面看吧。`);
      return { handled: true };
    }
    if (cmd.kind === 'what-now' || cmd.kind === 'next') {
      if (cmd.kind === 'next') await browser.next();
      await broadcastNow();
      return { handled: true };
    }

    if (cmd.kind === 'status') {
      await say(statusText());
      return { handled: true };
    }
    if (cmd.kind === 'pending') {
      await say(pendingListText());
      return { handled: true };
    }
    if (cmd.kind === 'approve') {
      await approvePending(cmd.id);
      return { handled: true };
    }
    if (cmd.kind === 'reject') {
      await rejectPending(cmd.id);
      return { handled: true };
    }
    if (cmd.kind === 'stop') {
      await stop('哥哥说停抖音');
      return { handled: true };
    }
    // start
    if (phase !== 'off') {
      await say(phase === 'login'
        ? '还在等你扫码呢～'
        : '我正刷着呢，你聊你的就好～');
      return { handled: true };
    }
    target = { type: incomingTarget?.type ?? 'private', id: incomingTarget?.id };
    phase = 'login';
    loginExpired = false;
    log('抖音：收到开启口令，拉起浏览器');
    const ok = await ensureBrowser();
    if (!ok.ok) return { handled: true };
    const r = await browser.open();
    if (!r.ok) {
      phase = 'off';
      browser = null;
      await say(`抖音没开起来：${r.reason}。等你想再试就说「开抖音」。`);
      return { handled: true };
    }
    if (r.needLogin) await say('登录好啦，我开始刷咯～ 刷到有意思的会跟你说。');
    else await say('好呀，我上抖音刷一会儿，刷到有意思的跟你讲。');
    phase = 'active';
    startedAt = now();
    // 只排一条链：3 秒后首条，之后由 tick() 的 finally 续期。
    scheduleNext(3000);
    return { handled: true };
  }

  function statusText() {
    if (phase === 'off') {
      return loginExpired
        ? '抖音登录过期，需要重新扫码。说「开抖音」，我拉起登录页等你扫。'
        : '现在没在刷抖音。说「开抖音」我就开始（第一次要你本人扫个码）。';
    }
    if (phase === 'login') return '正在等你扫码登录抖音呢～';
    const mins = Math.max(0, Math.round((now() - startedAt) / 60000));
    const hourComments = counters.commentTimes.filter((t) => now() - t < HOUR_MS).length;
    const dayPosts = counters.postTimes.filter((t) => now() - t < DAY_MS).length;
    const hourCoWatch = coWatchTimes.filter((t) => now() - t < HOUR_MS).length;
    const cwText = coWatch
      ? `共看开着（${Math.round(coWatchIntervalMs / 1000)} 秒/条，这小时 ${hourCoWatch}/${coWatchMaxPerHour}）`
      : '共看关着（说「共看」打开）';
    const winText = browser?.windowOnScreen?.()
      ? '窗口在眼前'
      : '窗口在屏幕外（说「抖音抬窗」抬出来）';
    const quiet = quietActive() ? ' 当前静默期内，有话题也先不吱声' : '';
    return `正在刷抖音，开了 ${mins} 分钟，看了 ${browsed} 条，本次互动 ${counters.interactions} 次；`
      + `这小时评论 ${hourComments}，今天动态 ${dayPosts}，待审 ${pending.length} 条；`
      + `${cwText}；${winText}。${quiet}说「停抖音」我就停。`;
  }

  function summary() {
    const base = `抖音浏览：${enabled ? '开启' : '关闭'}（口令「开抖音」/「停抖音」/「抖音状态」；`
      + `评论和动态默认${humanReview ? '人审（抖音同意 编号 才发）' : '自动执行'}；`
      + `每评论≤${cfg.maxCommentsPerHour ?? 5}/小时、动态≤${cfg.maxPostsPerDay ?? 2}/天、互动≤${cfg.maxInteractionsPerSession ?? 20}/次；`
      + `共看${coWatch ? `开启（${Math.round(coWatchIntervalMs / 1000)}秒/条，≤${coWatchMaxPerHour}条/小时，屏幕外可见窗口+按需抬窗）` : '关闭'}；`
      + `评论区@主人${String(cfg.ownerDouyinName ?? '').trim() ? `（@${String(cfg.ownerDouyinName).trim()}，走人审）` : '（未填 ownerDouyinName，暂不生效）'}）`;
    return base + (phase === 'off' ? '' : `；当前 ${statusText()}`);
  }

  return {
    onUserLine, stop, statusText, summary,
    active: () => phase !== 'off', phase: () => phase,
    pendingSnapshot: () => pending.map((x) => ({ ...x })),
    countersSnapshot: () => JSON.parse(JSON.stringify(counters)),
    coWatchSnapshot: () => ({
      enabled: coWatch, times: [...coWatchTimes], lastAt: lastCoWatchAt,
      intervalMs: coWatchIntervalMs, maxPerHour: coWatchMaxPerHour,
    }),
  };
}
