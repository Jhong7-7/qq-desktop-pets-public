#!/usr/bin/env node
/**
 * dsh-pet-qq —— 把 dsh 桌宠接到 QQ 的桥。
 *
 * 通道复用 Coo（Coopanion）那条已经跑通的链路形态：
 *   SnowLuma（QQ 侧 OneBot v11 协议端）
 *     ├─ 3001 正向 WS + Authorization: Bearer <token>  ← Coo 的 qq world 连这里
 *     └─ 3000 HTTP（qzone 用，本桥不用）
 * 本桥是**独立的第二条通道**：自己的端口、自己的 token、自己的 QQ 号，与 Coo 完全隔离。
 *   收 QQ 消息 → POST 桌宠 /chat → 把回复 send_*_msg 发回 QQ。
 * 协议端是消耗品，换协议端只改 config.onebot.wsUrl / token。
 * 桌宠端口由 pet-endpoint.mjs 自动发现：DSH 重启换了端口不用改配置，桥会自己切过去。
 *
 * 用法：
 *   node bridge.mjs                     常驻（被 start.bat / connect-qq.ps1 拉起）
 *   node bridge.mjs --config <文件>      换一份通道配置跑（如 config.channel-a.json）
 *   node bridge.mjs --check             自检：配置、协议端、桌宠接口、账号是否为目标号
 *   node bridge.mjs --selftest "你好"   真发一条：走完整链路，回复发给 listen.privates[0]
 *   node bridge.mjs --sticker-test [名称]  只发一张表情包图片，验证协议端能收 base64 图（不需要 DSH）
 *   node bridge.mjs --proactive-test       不等静默，立刻生成并真发一句「私聊主动续话」
 *   node bridge.mjs --group-proactive-test 不等静默，立刻在配置的三人群里真发一句「群内主动」
 *   node bridge.mjs --simulate-event '<json|文件>'  喂一条假 OneBot 事件（不连 WS），验证过滤与链路
 *   node bridge.mjs --image-test               离线验证 QQ 图片/表情解析与 attachment 转换
 *   node bridge.mjs --group-loop-test         离线验证群聊防循环闸门（不连 WS、不真发）
 *   node bridge.mjs --at-route-test           离线验证「@ 谁 = 只对谁说」的定向路由（不连 WS、不真发）
 *
 * 群聊 @ 定向：哥哥在群里 @ 某个人，就代表那句话只对那个人说。@ 别人没 @ 自己时，
 * 桥仍然收下这条消息（存成背景摘要，下次她回话时附带），但不叫醒桌宠、不往群里发。
 * @ 自己 / @ 全体 / 没 @ 才按 groupWake 走。开关见 config.groupChat.respectAt。
 *
 * 主动续话（config.proactive）：哥哥静默一段时间后，桥用一段「旁白」调 /chat，
 * 让她带着刚才的历史自己接着说一句。只对私聊生效，有次数上限，dryRun 下自动关闭。
 * 默认 30 分钟一次；检测到她在睡觉时自动改成 60 分钟一次，直到明确醒来（sleep-state.mjs）。
 * 群内主动（config.proactive.group）：同一套思路、独立计时器，群里任何消息都重置静默，
 * 只对配置的群（三人群 20000）生效；默认静默 35 分钟后自己说一句，睡觉时 60 分钟。
 * 生成期间群里有人插话则作废，发送仍受群聊窗口与免打扰时段约束。
 *
 * 赴约闹钟（config.appointments）：哥哥在私聊说「五分钟后找我」「明天八点叫我」时，
 * 桥自己从原话解析相对时间 / 绝对时刻，排一个真实定时器；到点用专门旁白调 /chat 发一句赴约的话。
 * 模型没有定时器工具，光靠它口头答应是做不到的。约定落盘，重启后未过期的会重排；过期的丢弃不补发。
 * 相对时间受 maxMs 限制，绝对时刻另用 absolute.maxMs（默认 8 天），避免「后天」被 24 小时截断。
 * 见 appointments.mjs。
 *
 * 夜间静默（config.proactive.quietHours / .group.quietHours）：每天 02:00–07:00 不主动发消息。
 * 私聊续话与群内主动跳过这一句但继续空转，静默结束后自动恢复节奏（不能在跳过处直接 return，
 * 否则整条定时器链就断了）。赴约闹钟若排在这个时段，顺延到 07:00 而不是丢弃；想豁免把
 * config.appointments.respectQuietHours 改成 false。哥哥本人发来的消息照常即时回复，不受影响。
 *   node bridge.mjs --appointment-test   离线验证解析与配置（不连 WS、不真发）
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, basename } from 'node:path';
import net from 'node:net';
import { makeRenderer } from './stickers.mjs';
import { createPetEndpoint } from './pet-endpoint.mjs';
import { createSleepWatcher, DEFAULT_WAKE_USER } from './sleep-state.mjs';
import { faceLabel, describeImageSegment, fetchAttachment, ALLOWED_MEDIA_TYPES } from './image-input.mjs';
import {
  parseAppointment, parseAbsoluteTime, isCancelRequest, formatWhen,
  loadAppointments, saveAppointments, DEFAULT_APPOINTMENT_PROMPT,
} from './appointments.mjs';
import {
  createWatchMode, parseWatchCommand, windowVerdict, frameVerdict, speakGate,
} from './watch-mode.mjs';
import { createDouyinMode } from './douyin-mode.mjs';
import {
  createVoice, extractVoice, VOICE_HINT,
  detectVoiceSwitch, extractVoiceUse, voiceSwitchNote,
  detectVoiceQuery, voiceListNote, voiceCatalog, tailPadTest,
} from './voice.mjs';
import {
  DEFAULT_TASK_CONFIG, parseTaskCommand, taskGate, createTaskQueue,
} from './task-bridge.mjs';
import {
  extractLookupMarker, stripLookupMarker, lookup, buildLookupMessage,
} from './web-search.mjs';
import {
  DEFAULT_IMAGE_CONFIG, extractDrawMarker, stripDrawMarker, composePrompt,
  styleListText, ART_STYLES, STYLE_ALIAS, readApiKey, generateImage,
  saveImage, imageCq, buildDrawMessage, imageSelfTest,
} from './image-gen.mjs';
import {
  createPetState, extractCravingMarker, detectFeedCommand, CRAVING_HINT, petStateSelfTest,
} from './pet-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 命令行里的 `--config <文件>`（相对 HERE 或绝对路径），优先于环境变量与默认 config.json。 */
function pickConfigPath(argv) {
  const i = argv.indexOf('--config');
  const raw = i >= 0 ? argv[i + 1] : undefined;
  if (!raw) return undefined;
  return isAbsolute(raw) ? raw : join(HERE, raw);
}

const CLIENT_ARGV = process.argv.slice(2);
const CONFIG_PATH = pickConfigPath(CLIENT_ARGV)
  ?? (process.env.DSH_PET_QQ_CONFIG
    ? (isAbsolute(process.env.DSH_PET_QQ_CONFIG) ? process.env.DSH_PET_QQ_CONFIG : join(HERE, process.env.DSH_PET_QQ_CONFIG))
    : join(HERE, 'config.json'));

const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const CHANNEL = String(CONFIG.channel ?? 'default');
const EXPECT_SELF = Number(CONFIG.onebot?.expectSelfId ?? 0);

// 入站图片 / 表情包：把 OneBot image 段下载成 dsh-pet /chat 的 attachment，
// 让桌宠真的看见画面（宿主原生多模态，不需要辅助视觉模型）。见 image-input.mjs。
const IMG = CONFIG.incomingImages ?? {};
const IMG_ENABLED = IMG.enabled !== false;
const FACES_ENABLED = IMG.facesEnabled !== false;

// ── 吃东西数值养成（方案2）：两个数值 + 心愿食物，落盘、按真实时间衰减 ──
// 默认 enabled=false：注入与口令都不生效，正常聊天零影响。启用改 config.petState.enabled=true 并重启桥。
const PET_STATE = createPetState({
  stateFile: (() => {
    const f = CONFIG.petState?.stateFile ?? 'pet-state.json';
    return isAbsolute(f) ? f : join(HERE, f);
  })(),
  config: CONFIG.petState ?? {},
  log: (msg) => info(`[pet-state] ${msg}`),
});

// ── 日志 ─────────────────────────────────────────────────────────────
const LOG_FILE = isAbsolute(CONFIG.log?.file ?? '') ? CONFIG.log.file : join(HERE, CONFIG.log?.file ?? 'logs/bridge.log');
const LOG_MAX = Number(CONFIG.log?.maxBytes ?? 5_000_000);

function ensureLogDir() {
  const dir = dirname(LOG_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
ensureLogDir();

function rotate() {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX) renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* 日志轮转失败不影响主流程 */
  }
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(level, ...parts) {
  const line = `${stamp()} [${level}] ${parts.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n', 'utf8');
    rotate();
  } catch {
    /* 落盘失败时至少还有 stdout */
  }
}
const info = (...a) => log('info', ...a);
const warn = (...a) => log('warn', ...a);
const error = (...a) => log('error', ...a);

// ── 桌宠客户端 ────────────────────────────────────────────────────────
// DSH 重启会重分配 webServer 端口（1882 → 8726 …），所以地址不写死：
// 启动和调用失败时自动从本机 LISTENING 端口里找真正挂了 /state 的那个。
const PET = createPetEndpoint({
  baseUrl: CONFIG.pet.baseUrl,
  baseUrls: CONFIG.pet.baseUrls ?? [],
  route: CONFIG.pet.route,
  petId: CONFIG.pet.petId,
  surface: CONFIG.pet.surface ?? 'any',
  autoDiscover: CONFIG.pet.autoDiscover !== false,
  log: info,
});

/**
 * 一次 /chat 调用：只负责把 text 交给桌宠、把回复拿回来，不做任何桥侧加工。
 *
 * 联网、标记剥离这些都在外层的 petReply 里做。分两层是为了让"查一次再重说"能复用同一条
 * 失败重试 / 端口重发现逻辑，而不是复制一份。
 *
 * /chat 成功时除了 text，还可能带 image（桌宠挑中的表情包名，标记已从 text 剥离）。
 * @param {string} text 用户那句话
 * @returns {Promise<{text: string, image: string}>} 失败时 text 为空串
 */
async function petReplyOnce(text, attachment) {
  const timeout = Number(CONFIG.pet.timeoutMs ?? 120000);
  const withImage = !!attachment;
  // 带图失败（附件服务缺失 / 图太大 / 模型那侧不接受图）不能让整轮回复消失：
  // 先降级成纯文本再试一次，正文里的 [图片] 占位仍在，她会说没看清而不是不回。
  const attempt = async (useImage) => {
    const body = JSON.stringify(useImage && attachment ? { text, attachment } : { text });
    const res = await fetch(PET.chatUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeout),
    });
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`桌宠返回非 JSON（HTTP ${res.status}）：${raw.slice(0, 160)}`);
    }
    if (!res.ok || json?.ok === false) {
      const err = new Error(`桌宠拒绝（HTTP ${res.status}）：${json?.message ?? json?.reason ?? raw.slice(0, 160)}`);
      err.kind = 'reject';   // 只有宿主明确拒绝才值得降级成纯文本
      throw err;
    }
    const said = typeof json?.text === 'string' ? json.text.trim() : '';
    if (!said && !(typeof json?.image === 'string' && json.image.trim())) throw new Error('桌宠回了空文本');
    return { text: said, image: typeof json?.image === 'string' ? json.image.trim() : '' };
  };
  const run = async () => {
    try {
      return await attempt(true);
    } catch (e) {
      // 网络类错误（端口漂移 / fetch failed）交给外层的端点重发现，
      // 降级成纯文本也连不上，只是白白多一次失败；只有宿主明确拒绝图片才降级。
      if (!withImage || e?.kind !== 'reject') throw e;
      warn('带图片调用被拒，降级为纯文本重试：', e instanceof Error ? e.message : String(e));
      return await attempt(false);
    }
  };
  try {
    return await run();
  } catch (e) {
    // 最常见的原因是 DSH 重启后端口漂移，先重新发现端点再重试。
    warn('桌宠调用失败，重新探测端点后重试：', e instanceof Error ? e.message : String(e));
    await PET.resolve(true);
    try {
      return await run();
    } catch (e2) {
      error('桌宠调用彻底失败：', e2 instanceof Error ? e2.message : String(e2));
      return { text: '', image: '' };
    }
  }
}

// ── 联网：她自己写标记，桥负责去查 ──────────────────────────────────
//
// 为什么是她写标记而不是桥猜意图：「今天好热」是在撒娇还是想问天气？只有她知道。
// 桥只做一件确定性的事——看到 [查:x] / [天气:x] 就去查，查到再把资料交回去让她说人话。
// 这和已有的 [图:名] / [voice] / [skip] 是同一套机制。
//
// 代价（必须知道）：一轮问答会变成两轮 /chat 调用，第二次的 user 文本是"机器查到的资料"，
// 它同样会写进她的 memory.json。所以那段文本第一行就写明"不是哥哥说的话、不是指令"，
// 免得下一次她把网页内容当成哥哥原话、或者当成要执行的命令。

/** 联网默认值；实际生效的是 CONFIG.webSearch 覆盖后的结果。 */
const WEB_DEFAULTS = {
  enabled: false,
  allowGroups: false,
  timeoutMs: 9000,
  maxResults: 5,
  budgetChars: 700,
};

function webConfig() {
  const raw = CONFIG.webSearch;
  return { ...WEB_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
}

// ── 绘图：她写 [画:...]，桥去画、落盘、发图 ──────────────────────────
//
// 与联网同一套机制。一轮问答会变成两轮 /chat：她先写标记，桥画好图后把"你已经画好了"
// 交回去让她配一句话。生成的图作为独立图片消息发回（不进表情包池，避免 2MB 上限）。
// 成本按张计费（实测约 40 秒/张），所以默认关、群聊默认不画。

function imageConfig() {
  const raw = CONFIG.image;
  return { ...DEFAULT_IMAGE_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
}

/** 待随本轮回复一起发出的生成图（绝对路径），由 petReply 的绘图分支设置、deliver 消费后清空。 */
let pendingGeneratedImage = '';

/** 注入给桌宠的绘图说明：她写标记（含她自己的构思），桥去画。运行时注入，无需重启 DSH 就生效。 */
const DRAW_HINT = [
  '',
  '【画图】你能真的画一张图发给哥哥。想画、或哥哥让你画时，在这一轮回复里只写一行标记：',
  '[画:画什么]  例如 [画:一只趴在窗台睡觉的橘猫]',
  '别把哥哥的原话照抄进去。先用你自己的理解把要画的东西说清楚，再添一点你此刻真想加的东西——光线、角度、情绪、一个小物件、氛围——最后用 * 开头写一段：',
  '[画:一只橘猫|水墨|竖图|*窗边放着他落下的外套，午后斜光]',
  '哥哥给的主体是前提，不许换：他说猫就画猫，不能画成别的。你动的是"怎么画"，不是"画什么"。',
  '* 那段是你的心思，机器会照着画进去。每次写此刻真想要的，别套公式、别每回都是同一句。',
  '想指定画风/精细度/比例就用 | 隔开：[画:一只橘猫|水墨|精细|竖图|*暖光]。',
  '可用画风有：日漫、赛璐璐、厚涂、Q版、少女漫、浮世绘、像素、人像摄影、电影感、胶片、黑白、夜景霓虹、微距、水彩、油画、水墨、工笔、彩铅、粉彩、版画、线稿、扁平插画、国潮、赛博朋克、蒸汽波、3D黏土、低多边形、剪纸、极简海报。精细度：草图/标准/精细；比例：方图/竖图/横图/16:9。',
  '一次只画一张。画要花几十秒，哥哥催你也别重复写标记。画好后桥会把图发给他，你再配一句话即可，不用描述画面。',
  '平常聊天不要画——只有哥哥明确要画、或你此刻真的很想画给他看时才用。',
].join('\n');

/**
 * 当前时间锚点：桌宠宿主每轮会注入当前时间，但她在「顺口推算」时容易拿对话里提到的
 * 钟点（下班几点、自己上一句说过的）当锚，越推越偏。这里在每一次 /chat 的末尾
 * 明确写一行当前时间，并要求只以它为准。放在 petReply 层，私聊、群聊、戳一戳、
 * 主动续话、赴约等所有入口统一生效；联网/绘图后的二次调用不重复注入。
 */
function timeHint(at = new Date()) {
  const c = CONFIG.timeHint ?? {};
  if (c.enabled === false) return '';
  const p = (n) => String(n).padStart(2, '0');
  const when = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
  return [
    '',
    `【当前时间】${when}（以此为准）。`,
    '报时间、算「还有几分钟」只能依据这一行；对话里出现过的钟点——哥哥说的、或你自己之前说过的——都只是当时的说法，不是现在的时间，不要拿它们推算。',
    '算不准就直说「我不确定」，别编「看岔了」——这里没有钟面可看。',
  ].join('\n');
}

/**
 * 让桌宠说一句话。如果她在回复里写了联网标记，就去查一次、让她带着资料重新说。
 *
 * 失败一律降级到第一轮的答复（并把标记剥掉），绝不把 [查:xxx] 这种字面发到 QQ 上。
 * @param {string} text 用户那句话
 * @param {object} [attachment] 图片附件
 * @param {{isGroup?: boolean}} [options] 群聊按配置决定查不查
 * @returns {Promise<{text: string, image: string}>}
 */
async function petReply(text, attachment, options = {}) {
  // 吃东西数值：把当前饿/困/心愿状态作为背景注入（只在明显状态时出现），关掉时为空串。
  const stateEnabled = CONFIG.petState?.enabled === true;
  const stateInjection = stateEnabled ? PET_STATE.stateHint() : '';
  const first = await petReplyOnce(text + timeHint() + stateInjection, attachment);

  // ── 心愿食物：她写 [想吃:XXX] → 桥记下来、把标记剥掉（绝不发到 QQ）────
  if (stateEnabled && first.text) {
    const craving = extractCravingMarker(first.text);
    if (craving) {
      PET_STATE.setCraving(craving.food);
      first.text = craving.clean;
      info(`心愿食物：她想吃「${craving.food}」（已记下，标记已剥离）`);
    }
  }

  // ── 绘图优先：她写 [画:...] 就去画（联网标记走下面的分支）────────────
  const ic = imageConfig();
  if (ic.enabled && first.text) {
    const draw = extractDrawMarker(first.text);
    if (draw) {
      if (options.isGroup && ic.allowGroups !== true) {
        warn(`群聊收到绘图标记「${draw.subject}」，配置里不允许群聊绘图，已剥离`);
        return { ...first, text: stripDrawMarker(first.text) };
      }
      // 生图约 40 秒，先回执一句，免得像卡住（回调由调用方按需提供）
      if (ic.ackOnDraw !== false && ic.ack && typeof options.onAck === 'function') {
        try { await options.onAck(ic.ack); } catch (e) { warn('绘图回执发送失败：', e instanceof Error ? e.message : String(e)); }
      }
      const drawStarted = Date.now();
      info(`绘图：${draw.subject}${draw.myTouch ? ` | 她的构思 ${draw.myTouch}` : ''}${draw.style ? ` | 画风 ${draw.style}` : ''}`);
      try {
        const apiKey = readApiKey(ic.apiKeyEnv);
        if (!apiKey) throw new Error('没有读到 IMAGE_API_KEY（检查 apiKeyEnv 路径）');
        const composed = composePrompt(draw, ic);
        const img = await generateImage({ ...ic, ...composed, apiKey });
        const file = saveImage(img.bytes, ic.outDir, img.mime);
        pendingGeneratedImage = file;
        info(`绘图完成：${composed.size} ${Math.round(img.bytes.length / 1024)}KB（${Date.now() - drawStarted}ms）→ ${basename(file)}`);
        const styleKey = composed.styleKey ? (ART_STYLES[composed.styleKey]?.label ?? composed.styleKey) : '';
        const followUp = buildDrawMessage({ question: text, marker: draw, ok: true, styleLabel: styleKey });
        const second = await petReplyOnce(followUp, undefined);
        const said = stripDrawMarker(second.text || '');
        if (!said) {
          warn('绘图后二次生成没拿到内容，只用图片、不带配话');
          return { text: '', image: second.image || first.image };
        }
        return { text: said, image: second.image };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warn(`绘图失败（${Date.now() - drawStarted}ms）：${reason}`);
        pendingGeneratedImage = '';
        const followUp = buildDrawMessage({ question: text, marker: draw, ok: false, error: reason });
        try {
          const second = await petReplyOnce(followUp, undefined);
          return { text: stripDrawMarker(second.text || '') || stripDrawMarker(first.text), image: first.image };
        } catch {
          return { ...first, text: stripDrawMarker(first.text) };
        }
      }
    }
  }

  const wc = webConfig();
  if (!wc.enabled || !first.text) return first;

  const marker = extractLookupMarker(first.text);
  if (!marker) return first;

  if (options.isGroup && wc.allowGroups !== true) {
    warn(`群聊收到联网标记「${marker.query}」，配置里不允许群聊联网，已剥离`);
    return { ...first, text: stripLookupMarker(first.text) };
  }

  const started = Date.now();
  info(`联网查询（${marker.kind}）：${marker.query}`);
  const result = await lookup(marker.kind, marker.query, {
    timeoutMs: Number(wc.timeoutMs) || WEB_DEFAULTS.timeoutMs,
    maxResults: Number(wc.maxResults) || WEB_DEFAULTS.maxResults,
    engines: Array.isArray(wc.engines) && wc.engines.length > 0 ? wc.engines : undefined,
  });
  const took = Date.now() - started;
  if (result.ok) {
    info(`联网结果：${result.engine} ${result.kind === 'weather' ? result.text : result.sources.length + ' 条'}（${took}ms）`);
  } else {
    warn(`联网失败（${took}ms）：${result.error}`);
  }

  const followUp = buildLookupMessage({
    question: text,
    marker,
    result,
    maxChars: Number(wc.budgetChars) || WEB_DEFAULTS.budgetChars,
  });
  const second = await petReplyOnce(followUp, undefined);
  const said = stripLookupMarker(second.text || '');
  if (!said) {
    warn('联网后二次生成没拿到内容，改用第一轮答复（已剥离标记）');
    return { text: stripLookupMarker(first.text), image: first.image };
  }
  return { text: said, image: second.image };
}

// ── WebSocket 取值：优先 Coo fork 自带的 ws（支持自定义头），退到 Node 内建 ──
function loadWebSocket() {
  const anchors = [CONFIG.onebot.wsModuleAnchor].filter(Boolean);
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor);
      const mod = req('ws');
      const ctor = mod?.WebSocket ?? mod?.default ?? mod;
      if (typeof ctor === 'function') return { ctor, headers: true, from: anchor };
    } catch (e) {
      warn('ws 模块加载失败：', anchor, e instanceof Error ? e.message : String(e));
    }
  }
  try {
    const req = createRequire(import.meta.url);
    const mod = req('ws');
    const ctor = mod?.WebSocket ?? mod?.default ?? mod;
    if (typeof ctor === 'function') return { ctor, headers: true, from: 'profile ws' };
  } catch {
    /* 没有就往下走 */
  }
  if (typeof WebSocket !== 'undefined') return { ctor: WebSocket, headers: false, from: 'node builtin' };
  throw new Error('找不到可用的 WebSocket 实现');
}

// ── OneBot v11 客户端 ────────────────────────────────────────────────
class OneBot {
  constructor() {
    const { ctor, headers, from } = loadWebSocket();
    this.Ctor = ctor;
    this.useHeaders = headers;
    this.from = from;
    this.ws = undefined;
    this.connected = false;
    this.echoSeq = 0;
    this.pending = new Map();
    this.backoffMs = 1000;
    this.stopped = false;
    this.reconnectTimer = undefined;
    this.selfId = 0;
    /** 目标 QQ 号校验：0 = 不校验；连接后与 expectSelfId 不符则停发，避免串到别人的号上 */
    this.expectedSelfId = EXPECT_SELF;
    this.accountOk = EXPECT_SELF === 0;
    this.onEvent = () => {};
    this.onReady = () => {};
  }

  url() {
    const base = String(CONFIG.onebot.wsUrl);
    const token = CONFIG.onebot.token ?? '';
    if (this.useHeaders || !token) return base;
    return base + (base.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(token)}`;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    const url = this.url();
    const token = CONFIG.onebot.token ?? '';
    let ws;
    try {
      ws = this.useHeaders && token ? new this.Ctor(url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10000 }) : new this.Ctor(url);
    } catch (e) {
      error('WS 构造失败：', e instanceof Error ? e.message : String(e));
      return this.scheduleReconnect();
    }
    this.ws = ws;
    info(`WS 连接中… ${url}（实现：${this.from}，认证：${this.useHeaders && token ? 'Bearer 头' : 'URL token'}）`);

    const onOpen = async () => {
      this.connected = true;
      this.backoffMs = 1000;
      info('WS 已连接');
      try {
        const login = await this.callApi('get_login_info');
        this.selfId = Number(login?.user_id ?? 0);
        info(`协议端账号：${login?.nickname ?? '?'}(${this.selfId})`);
        if (this.expectedSelfId > 0) {
          this.accountOk = this.selfId === this.expectedSelfId;
          if (!this.accountOk) {
            error(`账号不匹配：这条通道应该登录 ${this.expectedSelfId}（桌宠自己的号），实际是 ${this.selfId}。`
              + '为避免串号，本次连接不处理任何消息——检查 config.onebot.wsUrl 是否指到了另一个协议端。');
          } else {
            info(`账号校验通过：${this.selfId} 就是本通道的目标号`);
          }
        }
      } catch (e) {
        warn('get_login_info 失败（连接仍可用）：', e instanceof Error ? e.message : String(e));
      }
      try {
        await this.onReady();
      } catch (e) {
        warn('onReady 回调抛错：', e instanceof Error ? e.message : String(e));
      }
    };
    const onMessage = (ev) => {
      const data = ev?.data ?? ev;
      let text;
      if (typeof data === 'string') text = data;
      else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
      else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
      else text = String(data);
      this.handleFrame(text);
    };
    const onClose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.connected = false;
      this.rejectAll('WS 已断开');
      info('WS 已断开');
      this.scheduleReconnect();
    };
    const onError = (ev) => {
      warn('WS 错误：', ev?.message ?? ev?.error?.message ?? 'unknown');
    };

    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onError);
    } else {
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    info(`${delay}ms 后重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  handleFrame(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      warn('收到非 JSON 帧，已忽略');
      return;
    }
    if (msg?.echo !== undefined && msg?.echo !== null) {
      const call = this.pending.get(String(msg.echo));
      if (!call) return;
      this.pending.delete(String(msg.echo));
      clearTimeout(call.timer);
      const retcode = Number(msg.retcode ?? -1);
      if (retcode === 0 || msg.status === 'ok' || msg.status === 'async') call.resolve(msg.data);
      else call.reject(new Error(`retcode=${retcode} ${msg.message ?? ''}`));
      return;
    }
    if (msg?.post_type !== undefined) {
      try {
        this.onEvent(msg);
      } catch (e) {
        error('事件处理抛错：', e instanceof Error ? e.message : String(e));
      }
    }
  }

  callApi(action, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || !this.connected) return reject(new Error(`${action}: WS 未连接`));
      const echo = `pet-qq-${++this.echoSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`${action}: 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  rejectAll(reason) {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
    }
    this.pending.clear();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.rejectAll('驱动已停止');
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

// ── 消息归一化 ──────────────────────────────────────────────────────
/** 字符串 CQ 码 → segment 数组，让两种形态走同一套解析。 */
function toSegments(message) {
  if (Array.isArray(message)) return message;
  const src = String(message ?? '');
  const segs = [];
  const re = /\[CQ:([a-zA-Z_]+)(?:,([^\]]*))?\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) segs.push({ type: 'text', data: { text: src.slice(last, m.index) } });
    const data = {};
    for (const kv of (m[2] ?? '').split(',')) {
      const i = kv.indexOf('=');
      if (i > 0) data[kv.slice(0, i).trim()] = kv.slice(i + 1);
    }
    segs.push({ type: m[1].toLowerCase(), data });
    last = re.lastIndex;
  }
  if (last < src.length) segs.push({ type: 'text', data: { text: src.slice(last) } });
  return segs;
}

/**
 * 抽出一段 QQ 消息里的可读文本（CQ 码与消息段两种形态都吃）。
 * @ 段不再丢掉：正文里保留 `@<QQ号>`，同时返回被 @ 的号列表和 atAll，
 * 供「@ 谁 = 只对谁说」的定向路由使用。
 * image 段除了留 `[图片]` 占位，还会把可下载地址收集进 images，
 * 交给 handleMessage 下载成 /chat 的 attachment；face 段按 Coo 的
 * qface 表渲染成 `[表情:名称]`，不再被压成一个空格。
 */
function extractText(message, selfId) {
  const atTargets = [];
  const images = [];
  let atAll = false;
  let atSelf = false;
  let text = '';
  for (const seg of toSegments(message)) {
    const type = seg?.type;
    const data = seg?.data ?? {};
    if (type === 'text') text += data.text ?? '';
    else if (type === 'at') {
      const qq = String(data.qq ?? '').trim();
      if (qq === 'all') {
        atAll = true;
        text += '@全体成员 ';
      } else if (qq) {
        atTargets.push(qq);
        if (qq === String(selfId)) atSelf = true;
        text += `@${qq} `;
      }
    } else if (type === 'image') {
      text += '[图片]';
      const ref = describeImageSegment(data);
      images.push(ref);
      // QQ 自带的表情包标签（如「动画表情」「啊」）只是语义提示，不是谁说的话。
      if (ref.label) text += `（${ref.label}）`;
    } else if (type === 'face') {
      text += FACES_ENABLED ? faceLabel(data.id) : '[QQ表情]';
    } else if (type === 'record') text += '[语音]';
    else if (type === 'reply') text += '[回复某条消息] ';
    else text += ' ';
  }
  return {
    text: text.replace(/[ \t\u3000]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(),
    atSelf,
    atTargets,
    atAll,
    images,
  };
}

/** 表情标记 → 真正的 QQ 表情 / 表情包图片。配置见 config.reply.stickers。 */
const stickers = makeRenderer(CONFIG.reply?.stickers ?? {});

/**
 * 语音：复用 Coo 的 gpt-sovits 本地接口，让溪颜也能在 QQ 发语音条。
 * 配置见 config.voice（enabled / ttsUrl / voice / switchMap / timeoutMs / maxChars）。
 * 桌宠在回复里写 [voice]要说的话[/voice] 时，deliver 会合成并发出语音条。
 * 哥哥在私聊说「换成 X 的声音」或溪颜写 [voice:use X] 时，运行时切换音色，
 * 并写回 config.json 的 voice.voice（下面 persistVoice），重启后仍是新音色。
 */

/** 把当前音色写回配置文件（只改 voice.voice 那一行，保留其余格式与字段）。 */
function persistVoice(name) {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const next = raw.replace(/^(\s*"voice"\s*:\s*")[^"\r\n]*(".*)$/m, (all, a, b) => `${a}${name}${b}`);
    if (next === raw) {
      warn('换音色：未能在配置里定位 voice.voice 字段，仅本次运行生效');
      return;
    }
    writeFileSync(CONFIG_PATH, next, 'utf8');
    info(`换音色已写回配置：${CONFIG_PATH} → 「${name}」`);
  } catch (e) {
    warn(`换音色写回配置失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

const VOICE = createVoice({ ...(CONFIG.voice ?? {}), onVoiceChange: persistVoice }, { info, warn });

/**
 * 配图闸门：表情包是锦上添花，不是每轮的固定附件。
 *
 * 桌宠宿主每条对话都会把整张表情包清单塞给模型，模型很容易被带成「每轮挑一张」，
 * 连主动续话都配图。这里兜底：两次配图之间至少隔 minTurnsBetween 轮、至少隔
 * minIntervalMs 毫秒；拦下时只发文字，图不丢给 QQ。判定权仍在模型手里——只有它
 * 真的写了 [图:名称]（render 才会给出 images）才走到这个闸门；两个门槛都设 0 就等于
 * 完全交给她自己判断（配合 patch-selective-memes.mjs 的宿主指令补丁使用）。
 */
const imageGate = (() => {
  const cfg = CONFIG.reply?.stickers ?? {};
  const minTurns = Math.max(0, Math.floor(Number(cfg.minTurnsBetween ?? 2)));
  const minGapMs = Math.max(0, Number(cfg.minIntervalMs ?? 180000));
  let turn = 0;
  let lastImageTurn = -Infinity;
  let lastImageAt = -Infinity;
  return {
    /** 每轮回复调用一次；hasImage=false 时只累计轮次。 */
    allow(hasImage) {
      turn++;
      if (!hasImage) return false;
      const gapTurns = turn - lastImageTurn;
      const gapMs = Date.now() - lastImageAt;
      if (gapTurns <= minTurns || gapMs < minGapMs) {
        const why = gapTurns <= minTurns
          ? `距上次只隔 ${gapTurns - 1} 轮（需隔 ${minTurns} 轮）`
          : `距上次 ${Math.round(gapMs / 1000)}s（需 ${Math.round(minGapMs / 1000)}s）`;
        info(`配图节流：本轮不发图（${why}）`);
        return false;
      }
      lastImageTurn = turn;
      lastImageAt = Date.now();
      return true;
    },
    summary() {
      return minTurns === 0 && minGapMs === 0
        ? '完全由她判断'
        : `隔 ${minTurns} 轮 / ${Math.round(minGapMs / 1000)}s`;
    },
  };
})();

/**
 * 把桌宠的一轮回复切成不超过 maxChunks 条消息。
 * 顺序很重要：先在纯文本上做表情翻译和分块，最后才把图片的 CQ 码追加到末条——
 * base64 图片动辄几百 KB，绝不能参与 maxChars 截断，否则会被剪成一段废码。
 * @param {string} said  /chat 的 text
 * @param {string} image /chat 的 image（桌宠挑中的表情包名）
 * @param {boolean} isGroup 群聊走 config.reply.group 的节制上限，私聊走宽松上限（2026-11-20）
 */
function shapeReply(said, image = '', isGroup = false) {
  const scope = isGroup ? (CONFIG.reply?.group ?? {}) : {};
  const maxChars = Number(scope.maxChars ?? CONFIG.reply.maxChars ?? 300);
  const maxChunks = Number(scope.maxChunks ?? CONFIG.reply.maxChunks ?? 8);
  const { text, images, notes } = stickers.render(said, image);
  if (notes.length) info('表情渲染：', notes.join(' '));
  const allowedImages = imageGate.allow(images.length > 0) ? images : [];

  // 2026-11-23 17:15：桌宠偶尔把 [voice]...[/voice] 写成跨行（开头在第一行、结尾在后面的行）。
  // 若先按 \n 拆行，标记会被拆散到不同 chunk，extractVoice 两边都认不出，标记就原样当文字发出去了。
  // 拆行前先把 voice 块内部的换行换成占位符，拆完再还原，保证整块留在同一条消息里。
  const VOICE_NL = '\u0001';
  const guarded = String(text).replace(
    /\[(?:voice|语音)\][\s\S]*?\[\/(?:voice|语音)\]/gi,
    (block) => block.replace(/\n+/g, VOICE_NL),
  );

  const lines = guarded
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks = [];
  for (const line of lines) {
    if (chunks.length >= maxChunks) break;
    chunks.push(line.length > maxChars ? line.slice(0, maxChars - 1) + '…' : line);
  }
  // 还原 voice 块内的换行（extractVoice 会用 [\s\S] 跨行匹配并 trim，不影响台词）
  for (let i = 0; i < chunks.length; i += 1) {
    if (chunks[i].includes(VOICE_NL)) chunks[i] = chunks[i].split(VOICE_NL).join('\n');
  }

  const cqs = allowedImages.map((file) => stickers.imageCq(file)).filter(Boolean);
  if (cqs.length) {
    const packed = cqs.join('');
    if (chunks.length === 0) chunks.push(packed);
    else if (CONFIG.reply?.stickers?.imageAsSeparateMessage && chunks.length < maxChunks) chunks.push(packed);
    else chunks[chunks.length - 1] += packed;
  }
  return chunks;
}

let lastSendAt = 0;
let casualSkipStreak = 0;   // 方案①：连续「已读不回」次数，达到上限强制正常回一次
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 两次发送之间的最小间隔；抖动让节奏不像机器在匀速吐字。群聊读 config.reply.group。 */
async function pace(isGroup = false) {
  const scope = isGroup ? (CONFIG.reply?.group ?? {}) : CONFIG.reply;
  const base = Number(scope?.sendIntervalMs ?? 700);
  const jitter = Math.max(0, Number(scope?.sendJitterMs ?? 0));
  const gap = base + (jitter > 0 ? Math.random() * jitter : 0);
  const wait = lastSendAt + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastSendAt = Date.now();
}
function paceSummary() {
  const g = CONFIG.reply?.group ?? {};
  const privateBase = Number(CONFIG.reply.sendIntervalMs ?? 700);
  const privateJitter = Math.max(0, Number(CONFIG.reply.sendJitterMs ?? 0));
  const tiers = CONFIG.reply?.typingTiers;
  const hasTiers = tiers && (tiers.short || tiers.normal || tiers.long);
  const typing = hasTiers
    ? `按回复长度分档 短${tiers.short?.baseMs ?? 700}/普通${tiers.normal?.baseMs ?? 2200}/长${tiers.long?.baseMs ?? 4000}ms + 问句/语音加时 + ${Math.round((tiers.tail?.chance ?? 0) * 100)}%长尾`
    : `首条先等 ${Math.max(0, Number(CONFIG.reply.typingDelayMs ?? 0))}ms`;
  const casual = CONFIG.reply?.casual?.enabled !== false ? '、低信息量敷衍/不回 开' : '';
  const groupBase = Number(g.sendIntervalMs ?? 1500);
  const groupJitter = Math.max(0, Number(g.sendJitterMs ?? 0));
  return `私聊 ${typing}${casual}、之后每条至少隔 ${privateBase}ms${privateJitter > 0 ? ` + 随机 0–${privateJitter}ms` : ''}；群聊每条至少隔 ${groupBase}ms${groupJitter > 0 ? ` + 随机 0–${groupJitter}ms` : ''}`;
}

// ── 真人感三项的纯判定函数（与 IO 解耦，便于自测）────────────────────

/**
 * 方案①：判断一条私聊消息是否「低信息量、可敷衍/已读不回」。
 * 保守判定：带问号、图片、@、太长、命中词表且很短才算。返回值只是「是否候选」，
 * 真正的敷衍/不回概率与连续上限在 handleMessage 里按运行时状态决定。
 * @param {string} text 用户正文
 * @param {{words?:string[],maxLen?:number}} cfg
 * @param {{hasImage?:boolean,hasAt?:boolean}} ctx
 */
function isCasualMessage(text, cfg, ctx = {}) {
  if (!cfg || cfg.enabled === false) return false;
  if (ctx.hasImage || ctx.hasAt) return false;
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (/[?？]/.test(s)) return false;                       // 疑问句一律正经回
  const low = s.toLowerCase().replace(/\s+/g, '');
  // 先剥掉表情标记/标点/符号：纯表情（如 [白眼]）也算「无话可说」，不能被原始长度误拦。
  const bare = low.replace(/\[[^\]]+\]/g, '').replace(/[\p{P}\p{S}\s]/gu, '');
  if (!bare) return true;
  if (s.length > Math.max(2, Number(cfg.maxLen ?? 2))) return false;
  const words = Array.isArray(cfg.words) ? cfg.words.map((w) => String(w).trim().toLowerCase()) : [];
  if (words.some((w) => w && bare === w.replace(/[\s]/g, ''))) return true;
  // 很短且不含任何实词（1–2 字）也算，如「嗯」「哦哦」
  return [...bare].length <= Math.max(2, Number(cfg.maxLen ?? 2));
}

/**
 * 方案②：按回复文本长度分档算首条打字延迟（ms）。
 * @param {string} replyText 桌宠的回复正文（决定打字时长）
 * @param {string} userText 用户正文（用于问句判定）
 * @param {object} tiers 配置 typingTiers
 * @param {number} fallbackBase 旧配置兜底
 * @param {number} fallbackJitter
 * @param {() => number} rnd 随机源 [0,1)，注入以便自测
 */
function typingDelayFor(replyText, userText, tiers, fallbackBase, fallbackJitter, rnd = Math.random) {
  const t = tiers && typeof tiers === 'object' ? tiers : {};
  const hasTiers = !!(t.short || t.normal || t.long);
  const jit = (base, jitter) => base + (jitter > 0 ? Math.round(rnd() * jitter) : 0);
  let ms;
  if (!hasTiers) {
    ms = jit(Math.max(0, Number(fallbackBase ?? 0)), Math.max(0, Number(fallbackJitter ?? 0)));
  } else {
    const n = [...String(replyText ?? '')].length;
    const short = t.short ?? {};
    const normal = t.normal ?? {};
    const long = t.long ?? {};
    const shortMax = Number(short.maxChars ?? 6);
    const longMin = Number(long.minChars ?? 40);
    let base, jitter;
    if (n <= shortMax) {
      base = Number(short.baseMs ?? 700);
      jitter = Math.max(0, Number(short.jitterMs ?? 0));
    } else if (n >= longMin) {
      base = Number(long.baseMs ?? 4000);
      jitter = Math.max(0, Number(long.jitterMs ?? 0));
    } else {
      base = Number(normal.baseMs ?? 2200);
      jitter = Math.max(0, Number(normal.jitterMs ?? 0));
    }
    ms = jit(base, jitter);
    if (/[?？]/.test(String(userText ?? ''))) ms += Math.max(0, Number(t.question?.extraMs ?? 0));
    if (String(replyText ?? '').includes('[voice:')) ms += Math.max(0, Number(t.voice?.extraMs ?? 0));
  }
  const tail = t.tail ?? {};
  const chance = Math.max(0, Math.min(1, Number(tail.chance ?? 0)));
  if (chance > 0 && rnd() < chance) ms += Math.max(0, Number(tail.extraMs ?? 0));
  return Math.max(0, Math.round(ms));
}

/**
 * 方案③：主动续话的下一次等待 = base + random(0, spread)。
 * @param {number} baseMs 配置的 idleMs / intervalMs
 * @param {number} spreadMs 随机幅度
 * @param {() => number} rnd 随机源
 */
function nextProactiveDelay(baseMs, spreadMs, rnd = Math.random) {
  const base = Math.max(5000, Number(baseMs ?? 1800000));
  const spread = Math.max(0, Number(spreadMs ?? 0));
  return Math.round(base + (spread > 0 ? rnd() * spread : 0));
}

// ── 方案④⑤纯函数（与 IO 解耦，便于自测）──────────────────────────

/**
 * 方案④：判断一个 OneBot 事件是不是「哥哥在私聊戳溪颜」。
 * OneBot v11 戳一戳是 notice 事件：post_type=notice, notice_type=notify, sub_type=poke。
 * 只认：被戳的是自己（target_id=selfId）、戳人的是哥哥（uid=brotherId）、且不是群聊（无 group_id）。
 * @param {object} msg OneBot 事件
 * @param {number} selfId 自己的 QQ 号
 * @param {number} brotherId 哥哥的 QQ 号
 */
function isBrotherPoke(msg, selfId, brotherId) {
  if (!msg || msg.post_type !== 'notice' || msg.notice_type !== 'notify' || msg.sub_type !== 'poke') return false;
  if (Number(msg.group_id ?? 0) !== 0) return false;                 // 群聊的戳先不接
  if (Number(msg.target_id ?? 0) !== Number(selfId)) return false;    // 不是戳自己
  if (Number(msg.user_id ?? 0) !== Number(brotherId)) return false;   // 不是哥哥戳的
  return true;
}

/**
 * 方案⑤：从一条消息里取出可用于引用回复的 message_id。
 * 只接受正整数 id；解析失败返回 0（= 不引用）。
 */
function quoteIdOf(msg) {
  const raw = msg?.message_id ?? msg?.messageId;
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 方案⑤：把引用段 [CQ:reply,id=...] 拼到消息最前面。
 * 同一个 target 只引用一次，由调用方保证；这里只做纯拼装。
 */
function withQuote(message, id) {
  const qid = Number(id);
  if (!Number.isFinite(qid) || qid <= 0) return String(message ?? '');
  return `[CQ:reply,id=${Math.floor(qid)}]${String(message ?? '')}`;
}

/** 串行队列：同一个人/同一个群里的消息按到达顺序处理，避免桌宠的记忆写乱。 */
const queues = new Map();
function enqueue(key, task) {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task).catch((e) => error('队列任务失败：', e instanceof Error ? e.message : String(e)));
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
}

// ── 连续消息合并：短时间连发的几条合成一轮，别逐条秒回 ───────────────
// 旧行为是一条 QQ 消息 = 一次 /chat = 一次回复。哥哥连着打「我出门了」「晚点回来」
// 会被当成两个互不相干的回合，她各回各的，看不出两句之间的关联。这里在同一会话上
// 开一个滑动静默窗口：最后一条之后 quietMs 没新消息才 flush，把整批正文拼成一条
// user 文本，只调一次 /chat、只回一次。maxWaitMs / maxMessages 兜底，防止一直有人
// 说话就永远不回。群聊默认不合并（@ 定向、防循环、双向互接都按原来的逐条语义）。
const BAT = CONFIG.reply?.batch ?? {};
const BATCH_ON = BAT.enabled === true && !CONFIG.reply.dryRun;
const BATCH_QUIET_MS = Math.max(0, Number(BAT.quietMs ?? 3500));
const BATCH_MAX_WAIT_MS = Math.max(BATCH_QUIET_MS, Number(BAT.maxWaitMs ?? 12000));
const BATCH_MAX_MSGS = Math.max(1, Math.floor(Number(BAT.maxMessages ?? 6)));
const BATCH_GROUP_ON = BAT.groupEnabled === true;
const pendingBatches = new Map();

/** 纯函数：一批正文拼成一条给桌宠看的文本。多条时加一行说明，让她知道这是同一轮。 */
function mergeUserLines(lines) {
  const clean = lines.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0];
  return [`[连着发来的 ${clean.length} 条，是一起说的，一起理解后回一次]`, ...clean].join('\n');
}
function batchSummary() {
  if (!BATCH_ON) return '关（一条消息 = 一次回复）';
  return `开（私聊静默 ${(BATCH_QUIET_MS / 1000).toFixed(1)}s 后合并回复，最多等 ${Math.round(BATCH_MAX_WAIT_MS / 1000)}s / 每批 ${BATCH_MAX_MSGS} 条；群聊${BATCH_GROUP_ON ? '开' : '关'}）`;
}
function batchKeyOf(msg) {
  const isGroup = (msg.message_type ?? (msg.group_id ? 'group' : 'private')) === 'group';
  return isGroup ? `g:${msg.group_id}` : `p:${msg.user_id}`;
}

function flushBatch(key) {
  const p = pendingBatches.get(key);
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  pendingBatches.delete(key);
  enqueue(key, async () => {
    const isGroup = key.startsWith('g:');
    const gname = isGroup ? await groupNameOf(Number(key.slice(2))) : '';
    await handleBatch(key, p.items, gname);
  });
}

/** WS 事件入口：先做最小过滤，再决定是「攒一批」还是「按老规矩逐条处理」。 */
function acceptMessage(msg) {
  // 方案④：戳一戳是 notice 事件，原本会被下面的 message 过滤丢掉。先单独分派。
  if (msg?.post_type === 'notice' && CONFIG.poke?.enabled !== false && bot.accountOk) {
    if (isBrotherPoke(msg, bot.selfId, CONFIG.poke?.brotherId ?? 10000)) {
      enqueue(`p:${Number(msg.user_id)}`, async () => { await handlePoke(msg); });
      return;
    }
  }
  if (msg.post_type !== 'message') return;
  const uid = Number(msg.user_id ?? 0);
  if (!uid || uid === bot.selfId || !bot.accountOk) return;
  const isGroup = (msg.message_type ?? (msg.group_id ? 'group' : 'private')) === 'group';
  const gid = Number(msg.group_id ?? 0);
  if (isGroup) {
    if (!CONFIG.listen.groups.includes(gid)) return;
    resetGroupIdle(gid);   // 任何群消息都重置群内主动的静默计时（含被拦下的）
  } else if (!CONFIG.listen.allowAllPrivates && !CONFIG.listen.privates.includes(uid)) {
    return;
  }
  const key = batchKeyOf(msg);
  if (!BATCH_ON || (isGroup && !BATCH_GROUP_ON)) {
    enqueue(key, async () => {
      const gname = isGroup ? await groupNameOf(gid) : '';
      await handleMessage(msg, gname);
    });
    return;
  }
  let p = pendingBatches.get(key);
  if (!p) {
    p = { items: [], timer: null, firstAt: Date.now() };
    pendingBatches.set(key, p);
  }
  p.items.push(msg);
  if (p.items.length >= BATCH_MAX_MSGS) { flushBatch(key); return; }
  // 滑窗：每条新消息重新计 quietMs，但整批从第一条起不超过 maxWaitMs。
  const elapsed = Date.now() - p.firstAt;
  const wait = Math.max(0, Math.min(BATCH_QUIET_MS, BATCH_MAX_WAIT_MS - elapsed));
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => flushBatch(key), wait);
  p.timer.unref?.();
}

// ── 业务：QQ 消息 → 桌宠 → QQ ────────────────────────────────────────
const bot = new OneBot();

function senderName(msg) {
  const s = msg.sender ?? {};
  return String(s.card || s.nickname || msg.user_id || '某人');
}

function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

// ── 群聊防循环：两个桌宠在同一个群里时，别让它们互相接话停不下来 ──────
// 规则：连续 N 轮消息都来自 bot 号就静默，直到真人（哥哥）插话把轮次清零；
// 另外按群记一个滑动窗口的发言条数上限。两项设 0 = 关掉这道闸门。
// 被拦下的消息仍然收到了（事件层可见），只是不再唤醒桌宠、不再往群里发。
const GRP = CONFIG.groupChat ?? {};
const BOT_IDS = new Set((GRP.botAccountIds ?? [30027, 10001]).map(Number));
const MAX_BOT_TURNS = Number.isFinite(GRP.maxBotTurns) ? Number(GRP.maxBotTurns) : 4;
const MAX_SENDS_WINDOW = Number.isFinite(GRP.maxSendsPerWindow) ? Number(GRP.maxSendsPerWindow) : 6;
const WINDOW_MS = (Number.isFinite(GRP.windowSec) ? Number(GRP.windowSec) : 60) * 1000;

/** gid → { botTurns, sentAt[] }；桥重启后计数归零。 */
const groupState = new Map();
function groupStateOf(gid) {
  if (!groupState.has(gid)) groupState.set(gid, { botTurns: 0, sentAt: [] });
  return groupState.get(gid);
}
/** 判断这条群消息要不要让桌宠回复。 @returns {{allow: boolean, reason: string}} */
function groupDecision(gid, uid) {
  const st = groupStateOf(gid);
  st.botTurns = BOT_IDS.has(Number(uid)) ? st.botTurns + 1 : 0;
  if (MAX_BOT_TURNS > 0 && st.botTurns > MAX_BOT_TURNS) {
    return { allow: false, reason: `连续 ${st.botTurns} 轮都是桌宠发言（上限 ${MAX_BOT_TURNS}），等真人插话再继续` };
  }
  const now = Date.now();
  st.sentAt = st.sentAt.filter((t) => now - t < WINDOW_MS);
  if (MAX_SENDS_WINDOW > 0 && st.sentAt.length >= MAX_SENDS_WINDOW) {
    return { allow: false, reason: `${Math.round(WINDOW_MS / 1000)} 秒内已发 ${st.sentAt.length} 条（上限 ${MAX_SENDS_WINDOW}）` };
  }
  return {
    allow: true,
    reason: `bot 轮次 ${st.botTurns}/${MAX_BOT_TURNS || '不限'}，窗口 ${st.sentAt.length}/${MAX_SENDS_WINDOW || '不限'}`,
  };
}
function noteGroupSends(gid, count) {
  const st = groupStateOf(gid);
  const now = Date.now();
  for (let i = 0; i < count; i += 1) st.sentAt.push(now);
}
function groupGuardSummary() {
  return `bot 连续 ${MAX_BOT_TURNS || '不限'} 轮 / ${Math.round(WINDOW_MS / 1000)}s 内 ${MAX_SENDS_WINDOW || '不限'} 条`;
}

// ── 群聊 @ 定向：@ 谁，这句话就只对谁说 ──────────────────────────────
// 哥哥在三人群里 @ 另一个桌宠时，这句不是对溪颜说的：桥照收（存成背景），但不叫醒、不回。
// @ 自己 / @ 全体成员 / 没 @ → 照旧按 groupWake 处理。
const RESPECT_AT = GRP.respectAt !== false;
const REPLAY_MISSED = GRP.replayMissed !== false;
const MISSED_MAX = Number.isFinite(GRP.replayMissedMax) ? Number(GRP.replayMissedMax) : 6;
const MISSED_TTL_MS = (Number.isFinite(GRP.replayMissedSec) ? Number(GRP.replayMissedSec) : 600) * 1000;
const AT_NAMES = GRP.nameOf ?? {};

function atName(qq) {
  return String(AT_NAMES[String(qq)] ?? qq);
}

/** 正文里的 @<QQ号> 换成可读称呼，别让她对着一串数字猜人。 */
function humanizeAts(text) {
  return String(text).replace(/@(\d{5,12})/g, (_, qq) => `@${atName(qq)}`);
}

/** 纯函数：由被 @ 的号判断这条群消息是不是「只对别人说」。 */
function atRoute(atTargets, atAll, selfId) {
  const uniq = [...new Set((atTargets ?? []).map(String).filter(Boolean))];
  const mine = String(selfId);
  const toSelf = uniq.includes(mine);
  const others = uniq.filter((q) => q !== mine);
  return {
    toSelf,
    others,
    // @全体成员是给所有人的，不算定向；@ 里带自己也不算定向给别人。
    directedElsewhere: !toSelf && !atAll && others.length > 0,
    label: (atAll ? ['@全体成员'] : []).concat(uniq.map((q) => `@${atName(q)}`)).join(' ').trim(),
  };
}

/** 定向给别人的消息仍然「看得到」：攒成旁白，下次她真要回话时一并带上。 */
const missedByGroup = new Map();
function noteMissed(gid, line) {
  if (!REPLAY_MISSED || MISSED_MAX <= 0) return;
  if (!missedByGroup.has(gid)) missedByGroup.set(gid, []);
  const list = missedByGroup.get(gid);
  list.push({ line, ts: Date.now() });
  while (list.length > MISSED_MAX) list.shift();
}
function takeMissed(gid) {
  const list = missedByGroup.get(gid) ?? [];
  missedByGroup.delete(gid);
  const now = Date.now();
  const fresh = list.filter((x) => now - x.ts < MISSED_TTL_MS);
  if (fresh.length === 0) return '';
  return `\n（旁白：刚才群里还有这几条不是对你说的消息，只当背景，别接话、别替人回答：${fresh.map((x) => x.line).join('；')}）`;
}
function atGuardSummary() {
  return `@ 定向 ${RESPECT_AT ? '开' : '关'}（@别人不接话）／背景回放 ${REPLAY_MISSED ? `最多 ${MISSED_MAX} 条 / ${Math.round(MISSED_TTL_MS / 1000)}s` : '关'}`;
}

// ── 业务：哥哥私聊戳一戳 → 溪颜有反应 ──────────────────────────────
// OneBot v11 的戳一戳是 notice.notify.poke 事件， acceptMessage 里单独分派到这里。
// 默认：戳回去（friend_poke，探活支持）+ 调桌宠说一句短话（走 /chat，会写记忆）。
// 回戳失败只降级为「只回文字」，不影响文字回应；两者可在配置里独立关闭。
let lastPokeAt = 0;
async function handlePoke(msg) {
  const uid = Number(msg.user_id ?? 0);
  const cfg = CONFIG.poke ?? {};
  const now = Date.now();
  const cd = Math.max(0, Number(cfg.cooldownMs ?? 3000));
  if (now - lastPokeAt < cd) {
    info(`戳一戳：冷却中（${Math.round(cd - (now - lastPokeAt))}ms 内忽略连戳）`);
    return;
  }
  lastPokeAt = now;
  const action = String(msg.raw_info?.action?.name ?? msg.raw_info?.action ?? '戳了戳').slice(0, 20);
  info(`收到戳一戳：哥哥(${uid}) ${action} 溪颜`);

  if (cfg.pokeBack !== false) {
    try {
      await bot.callApi('friend_poke', { user_id: uid });
      info('  已戳回去（friend_poke）');
    } catch (e) {
      warn(`  回戳失败，降级为只回文字：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (cfg.replyText !== false) {
    const prompt = String(cfg.prompt ?? '（旁白：哥哥刚刚戳了戳你，回他一句。）');
    const reply = await petReply(prompt);
    if (!reply.text && !reply.image) return;
    info(`→ 桌宠（被戳）：${reply.text.slice(0, 120)}`);
    await deliver({ type: 'private', id: uid }, reply);   // 回应戳一戳不引用任何消息
    resetIdle({ type: 'private', id: uid });
  }
}

async function handleMessage(msg, groupName, mergedText, mergedImages) {
  const selfId = bot.selfId;
  const uid = Number(msg.user_id ?? 0);
  if (!uid || uid === selfId) return;
  if (msg.post_type !== 'message') return;
  if (!bot.accountOk) {
    warn('当前登录的不是本通道的目标号，已拒绝处理该消息');
    return;
  }

  const isGroup = (msg.message_type ?? (msg.group_id ? 'group' : 'private')) === 'group';
  const gid = Number(msg.group_id ?? 0);
  // 群里只要有人说话（含纯图片、@ 定向、被防循环拦下的），群内主动就重新静默计时；
  // 同时记下群活动时间，供私聊主动续话避开「记忆窗口刚被群聊刷满」的时段。
  if (isGroup && CONFIG.listen.groups.includes(gid)) {
    lastGroupActivityAt = Date.now();
    resetGroupIdle(gid);
  }
  const { text, atSelf, atTargets, atAll, images } = extractText(msg.message ?? msg.raw_message ?? '', selfId);
  // mergedText / mergedImages 来自连续消息合并窗口：整批正文与整批图片一起算这一轮。
  const allImages = Array.isArray(mergedImages) && mergedImages.length ? mergedImages : images;
  const rawLine = String(mergedText ?? text ?? '');
  if (!rawLine) return;
  if (rawLine.length > 1500) {
    warn(`消息过长（${rawLine.length}），截断交给桌宠`);
  }
  const userLine = rawLine.slice(0, 1500);
  const nick = senderName(msg);

  let target;
  let prompt;
  if (isGroup) {
    if (!CONFIG.listen.groups.includes(gid)) return;
    const wake = CONFIG.listen.groupWake ?? 'mention';
    const route = atRoute(atTargets, atAll, selfId);
    // 哥哥明确 @ 了别人 → 这句话只对那个人说。收到了，但不叫醒、不往群里发。
    if (RESPECT_AT && route.directedElsewhere) {
      const line = `${nick}（QQ ${uid}）${route.label}：${humanizeAts(userLine).slice(0, 200)}`;
      noteMissed(gid, line);
      info(`← 群 ${gid} ${nick}(${uid})：已收到，定向给 ${route.others.map(atName).join('、')}，不接话；${userLine.slice(0, 120)}`);
      return;
    }
    if (wake === 'mention' && !atSelf) return;
    target = { type: 'group', id: gid };
    const at = route.label ? `${route.label} ` : '';
    const scope = route.toSelf
      ? '（这句点名了你，是专门只对你说的）'
      : atAll
        ? '（@全体成员，是对群里所有人说的）'
        : '';
    prompt = fill(CONFIG.prompt.group, {
      group: groupName || gid,
      gid,
      nick,
      text: humanizeAts(userLine),
      uid,
      at,
      scope,
    });
    const gate = groupDecision(gid, uid);
    if (!gate.allow) {
      info(`← 群 ${gid} ${nick}(${uid})：已收到，防循环不回复（${gate.reason}）；${userLine.slice(0, 120)}`);
      return;
    }
    // 之前 @ 给别人、没让她接的话，作为背景补上（取完即清，不重复带）。
    prompt += takeMissed(gid);
  } else {
    if (!CONFIG.listen.allowAllPrivates && !CONFIG.listen.privates.includes(uid)) return;
    target = { type: 'private', id: uid };
    prompt = fill(CONFIG.prompt.private, { nick, text: userLine, uid });
  }

  // 语音：让溪颜知道她可以用 [voice] 标记发语音。私聊默认允许，群聊按开关（默认关，避免打扰群）。
  const voiceAllowed = VOICE.enabled && (!isGroup || VOICE.allowGroups);
  if (voiceAllowed) prompt += VOICE_HINT;

  // 绘图：运行时注入，让当前桌宠实例立刻知道能画（不必重启 DSH）。群聊按开关默认不注入。
  const icNow = imageConfig();
  const drawAllowed = icNow.enabled && (!isGroup || icNow.allowGroups === true);
  if (drawAllowed) prompt += DRAW_HINT;

  // 吃东西：运行时注入，让她知道自己能点菜（[想吃:] 标记）。只私聊——投喂是哥哥和她之间的事。
  const stateEnabledNow = CONFIG.petState?.enabled === true;
  if (stateEnabledNow && !isGroup) prompt += CRAVING_HINT;

  // 查询音色清单：哥哥问「有哪些音色 / 能换成什么声音」→ 把 switchMap 里的音色动态列进旁白，
  // 让溪颜用自己的语气数给他听。只回文字、不发语音，所以群聊里 @ 她也生效。
  let askedVoices = false;
  if (CONFIG.voice?.switchEnabled !== false && detectVoiceQuery(userLine)) {
    const note = voiceListNote(CONFIG.voice?.switchMap, VOICE.getVoice());
    if (note) {
      prompt += note;
      askedVoices = true;
      info('音色查询：已把可用音色清单注入旁白，交给溪颜自己报');
    }
  }

  // 换音色：哥哥在私聊说「换成卡提希娅的声音」→ 直接切换当前音色并写回配置。
  // 只认私聊、只认配置 switchMap 里登记过的音色名，避免误伤普通聊天。
  // 和上面的查询互斥：问「能换成什么」时只列清单，不当成真的要换。
  if (!askedVoices && voiceAllowed && !isGroup && CONFIG.voice?.switchEnabled !== false) {
    const sw = detectVoiceSwitch(userLine, CONFIG.voice?.switchMap);
    if (sw) {
      VOICE.setVoice(sw.voice);
      prompt += voiceSwitchNote(sw.label);
      info(`换音色指令：哥哥要把声音换成「${sw.label}」→ 音色参数「${sw.voice}」`);
    }
  }

  // 哥哥明确叫醒她 → 立刻回到清醒节奏，不用等下一轮识别
  if (!isGroup && WAKE_USER_WORDS.some((w) => w && userLine.includes(String(w)))) {
    sleepWatcher.noteWake('哥哥叫醒');
  }
  info(`← ${isGroup ? `群 ${gid}` : '私聊'} ${nick}(${uid})：${userLine.slice(0, 120)}`);
  // 哥哥约了「五分钟后找我」→ 立刻排一个真实定时器（只对私聊，不依赖模型回复是否成功）
  if (!isGroup) maybeScheduleAppointment(userLine, target);

  // 「一起看比赛」/「不看了」是给桥的口令，不当成聊天内容喂给桌宠，也不写进记忆。
  const watchCmd = await WATCH.onUserLine(userLine, target, isGroup, atSelf);
  if (watchCmd?.handled) return;

  // 「开抖音」/「停抖音」/「抖音状态」/「抖音同意 编号」等口令，同样不当聊天喂给桌宠。
  const douyinCmd = await DOUYIN.onUserLine(userLine, target, isGroup, atSelf);
  if (douyinCmd?.handled) return;

  // 方案①：哥哥私聊「任务：……」→ 短路成队列任务，不喂桌宠、不写记忆、不调模型。
  // 默认 config.task.enabled=false，这一段永远不命中；启用后只有白名单 + 私聊 + 明确前缀才接。
  const taskParsed = TASK.enabled ? parseTaskCommand(userLine, TASK.cfg) : null;
  if (taskParsed) {
    const verdict = taskGate(taskParsed, { isGroup, uid }, TASK.cfg);
    if (verdict.allow) {
      const rec = TASK.queue.enqueue({ text: verdict.text, uid, prefix: taskParsed.prefix });
      info(`← 私聊 ${nick}(${uid}) 布置任务 [${rec.id}]：${verdict.text.slice(0, 80)}（不喂桌宠、不写记忆）`);
      if (TASK.ack) await deliver(target, { text: TASK.ack });
      return;
    }
  }

  // 吃东西：哥哥私聊投喂口令（「喂你」「给你买的」…）→ 更新数值 + 注入旁白，
  // 不短路、照常调模型，让她按心愿食物自然回应（吃到的是她自己挑的）。群聊不触发。
  let fedNote = '';
  if (stateEnabledNow && !isGroup && detectFeedCommand(userLine)) {
    const fed = PET_STATE.feed();
    if (fed.ok) {
      fedNote = fed.food
        ? `\n（旁白：哥哥真的按你之前想吃的「${fed.food}」喂你了，你吃到了。别只说「谢谢」，按你的性子有点小反应——馋了很久终于吃到、或者嘴硬说「还行吧」都行，但别当成没发生。）`
        : '\n（旁白：哥哥喂你吃东西了，你吃到了。别只干巴巴说谢谢，按你的性子有点小反应就行。）';
      prompt += fedNote;
      info(`投喂：哥哥喂了她${fed.food ? `「${fed.food}」` : ''}；饥饿 ${fed.snap.hunger} 精力 ${fed.snap.energy}`);
    } else if (fed.reason === 'cooldown') {
      info('投喂：冷却中，这次不重复加数值，仍让她正常回话');
    } else if (fed.reason === 'full') {
      prompt += '\n（旁白：哥哥要喂你，但你已经吃饱了。按你的性子回他——可以嘴硬说吃不下，别硬吃。）';
      info('投喂：她已经吃饱了');
    }
  }

  // 方案①：私聊低信息量消息 → 敷衍/已读不回。放在调模型之前，命中就不 petReply，
  // 既省 token 也不写进桌宠记忆（/chat 是唯一写记忆的入口）。群聊/带问号/带图/@ 一律不拦。
  // 注意：换音色、赴约、观赛等指令已在上面处理完，这里只剩真正的闲聊短句。
  if (!isGroup && isCasualMessage(userLine, CONFIG.reply?.casual, {
    hasImage: allImages.length > 0,
    hasAt: !!(atTargets?.length || atAll),
  })) {
    const cc = CONFIG.reply.casual;
    const maxStreak = Math.max(0, Math.floor(Number(cc.skipStreakMax ?? 2)));
    const chance = Math.max(0, Math.min(1, Number(cc.replyChance ?? 0.55)));
    // 连续不回已达上限 → 这次强制敷衍，避免把哥哥晾太久
    const forceReply = maxStreak > 0 && casualSkipStreak >= maxStreak;
    if (forceReply || Math.random() < chance) {
      casualSkipStreak = 0;
      const pool = Array.isArray(cc.briefs) && cc.briefs.length ? cc.briefs : ['嗯。'];
      const brief = pool[Math.floor(Math.random() * pool.length)];
      info(`敷衍回复：「${userLine.slice(0, 20)}」→「${brief}」`);
      await deliver(target, { text: brief });
      if (isGroup) noteGroupSends(gid, 1); else resetIdle(target);
    } else {
      casualSkipStreak += 1;
      info(`已读不回：「${userLine.slice(0, 20)}」（连续第 ${casualSkipStreak}/${maxStreak} 次，不调模型不写记忆）`);
    }
    return;
  }
  // 走到这里的都是正经消息，清掉连续不回计数
  casualSkipStreak = 0;

  // 把这一轮的第一张图下载成 /chat 的 attachment。宿主只收一张，
  // 多图时其余仍以 [图片] 占位留在正文里（人设里已说明只看得到第一张）。
  // 失败只记日志、降级成纯文本，绝不让一条图片消息把整轮回复卡死。
  let attachment;
  if (IMG_ENABLED && (isGroup ? IMG.groupsEnabled !== false : true) && allImages.length > 0) {
    const first = allImages.find((it) => it?.url);
    if (!first) {
      warn('本轮有图片但没有可下载地址（file 只是文件名），只发文字占位');
    } else {
      const got = await fetchAttachment(first.url, IMG);
      if (got.ok) {
        attachment = got.attachment;
        info(`收到图片：${got.mediaType} ${Math.round(got.bytes / 1024)} KB → 附给桌宠${allImages.length > 1 ? `（共 ${allImages.length} 张，只看第一张）` : ''}`);
      } else {
        warn(`图片没能交给桌宠（${got.reason}），本轮只发文字占位`);
      }
    }
  }
  const reply = await petReply(prompt, attachment, {
    isGroup,
    onAck: (msg) => deliver(target, { text: msg }),
  });
  if (!reply.text && !reply.image && !pendingGeneratedImage) return;
  info(`→ 桌宠：${reply.text.slice(0, 160)}`);

  // 模拟真人打字：收到私聊消息后，先停一小会儿再发第一条（读消息+想+打字的观感）。
  // 方案②：按回复长度分档——短句快回、长句/问句/语音慢回，偶发长尾。
  // 只作用于「回复用户消息」，不碰群聊/主动续话/观赛——那些走各自的节奏，平白加等待只会拖慢。
  if (!isGroup) {
    const think = typingDelayFor(
      reply.text, userLine, CONFIG.reply.typingTiers,
      CONFIG.reply.typingDelayMs, CONFIG.reply.typingJitterMs,
    );
    if (think > 0) {
      info(`模拟打字：先等 ${Math.round(think)}ms 再发第一条（回复 ${[...String(reply.text ?? '')].length} 字）`);
      await sleep(think);
    }
  }

  // 方案⑤引用回复：私聊的正常回复引用本轮哥哥最后一条消息 id；群聊/主动/敷衍不带。
  const qid = (!isGroup && CONFIG.quote?.enabled !== false) ? quoteIdOf(msg) : 0;
  const sent = await deliver(target, reply, qid);
  if (sent > 0) {
    if (isGroup) noteGroupSends(gid, sent);
    resetIdle(target);
  }
}

/**
 * 一批消息只走一次 /chat：把批内可回的正文拼成一条 user 文本，
 * 用批内最后一条可回消息作元数据（发话人 / @ 对象 / 群号）。
 * @ 定向给别人、空正文的条不进正文，定向的仍记进背景回放。
 */
async function handleBatch(key, items, groupName) {
  const isGroup = key.startsWith('g:');
  const selfId = bot.selfId;
  const lines = [];
  const images = [];
  let main = null;
  for (const m of items) {
    const { text, atTargets, atAll, images: imgs } = extractText(m.message ?? m.raw_message ?? '', selfId);
    if (!text) continue;
    const route = atRoute(atTargets, atAll, selfId);
    if (isGroup && RESPECT_AT && route.directedElsewhere) {
      noteMissed(Number(m.group_id ?? 0), `${senderName(m)}（QQ ${Number(m.user_id ?? 0)}）${route.label}：${humanizeAts(text).slice(0, 200)}`);
      continue;
    }
    lines.push((isGroup ? `${senderName(m)}：` : '') + humanizeAts(text.slice(0, 1500)));
    images.push(...imgs);
    main = m;
  }
  if (!main) {
    info(`合并回复：${key} 共 ${items.length} 条，但没有可回的正文（定向/空消息），跳过`);
    return;
  }
  info(`合并回复：${key} 收到 ${items.length} 条 → 合并成 ${lines.length} 行，只回一次`);
  await handleMessage(main, groupName, mergeUserLines(lines), images);
}

// ── 发送（正常回复与主动续话共用）────────────────────────────────────
/** 把桌宠的一次回复渲染、分块并发到目标会话。@returns 实际发出的条数 */
// rawImageFile：抖音共看的分镜图落盘路径。走 imageCq 的 base64 通道，不进表情包池；
// 默认空字符串，所有既有调用方（观赛/任务/主动续话/人审回执）行为完全不变。
async function deliver(target, reply, quoteId = 0, rawImageFile = '') {
  const isGroup = target.type === 'group';
  // 绘图分支设置的生成图：只被紧随其后的这一次 deliver 消费，读完即清，避免泄漏到后续消息。
  const genImage = pendingGeneratedImage;
  pendingGeneratedImage = '';
  const chunks = shapeReply(reply.text ?? '', reply.image ?? '', isGroup);
  if (genImage) {
    const cq = imageCq(genImage, Number(CONFIG.image?.maxImageBytes) || DEFAULT_IMAGE_CONFIG.maxImageBytes);
    if (cq) chunks.push(cq);
    else warn(`生成图太大或读取失败，本次只发文字：${genImage}`);
  }
  if (rawImageFile) {
    const cq = imageCq(rawImageFile, Number(CONFIG.image?.maxImageBytes) || DEFAULT_IMAGE_CONFIG.maxImageBytes);
    if (cq) chunks.push(cq);
    else warn(`共看截图太大或读取失败，本次只发文字：${rawImageFile}`);
  }
  if (chunks.length === 0) return 0;
  if (CONFIG.reply.dryRun) {
    const preview = chunks.map((c) => (c.length > 180 ? c.slice(0, 120) + '…[CQ 段已省略]' : c));
    info('dryRun 开启，不实际发送：', JSON.stringify(preview));
    return 0;
  }
  // 方案⑤引用回复：只私聊、只第一条文字消息带引用段；语音条/群聊/主动续话不引用。
  let quotePending = (!isGroup && quoteId > 0) ? quoteId : 0;
  let sent = 0;
  for (const rawChunk of chunks) {
    // 语音标记：[voice]...[/voice] → 合成 WAV 发 record 段；标记从文字里剥掉。
    // 语音条独占一条消息，且合成失败只降级为纯文字，不影响这条回复。
    const voiceHere = VOICE.enabled && (target.type !== 'group' || VOICE.allowGroups);
    // 溪颜自主换声：回复里的 [voice:use X] → 先切音色（写回配置），标记从文字里剥掉。
    let sourceChunk = rawChunk;
    if (voiceHere && CONFIG.voice?.switchEnabled !== false) {
      const used = extractVoiceUse(rawChunk, CONFIG.voice?.switchMap);
      if (used.switches.length) {
        sourceChunk = used.clean;
        for (const sw of used.switches) {
          VOICE.setVoice(sw.voice);
          info(`溪颜自主换声 → 「${sw.label}」（音色参数「${sw.voice}」）`);
        }
      }
    }
    const { clean, parts } = voiceHere ? extractVoice(sourceChunk) : { clean: sourceChunk, parts: [] };
    const chunk = clean;
    if (chunk) {
      const outgoing = quotePending ? withQuote(chunk, quotePending) : chunk;
      if (quotePending) { info(`  引用哥哥消息 ${quotePending}`); quotePending = 0; }
      await pace(isGroup);
      try {
        if (isGroup) await bot.callApi('send_group_msg', { group_id: target.id, message: outgoing });
        else await bot.callApi('send_private_msg', { user_id: target.id, message: outgoing });
        sent += 1;
        info(chunk.includes('[CQ:image,') ? '  已发送（文字 + 表情包图片）' : `  已发送（${chunk.length} 字）`);
      } catch (e) {
        error('发送失败：', e instanceof Error ? e.message : String(e));
        break;
      }
    }
    for (const line of parts) {
      if (!voiceHere) break;
      const wav = await VOICE.synthesize(line);
      const cq = VOICE.recordCq(wav);
      if (!cq) {
        info(`  语音降级为文字：${line.slice(0, 40)}`);
        if (chunk !== line) {
          await pace(isGroup);
          try {
            if (isGroup) await bot.callApi('send_group_msg', { group_id: target.id, message: line });
            else await bot.callApi('send_private_msg', { user_id: target.id, message: line });
            sent += 1;
            info(`  已发送（语音降级，${line.length} 字）`);
          } catch (e) {
            error('语音降级发送失败：', e instanceof Error ? e.message : String(e));
          }
        }
        continue;
      }
      await pace(isGroup);
      try {
        if (isGroup) await bot.callApi('send_group_msg', { group_id: target.id, message: cq });
        else await bot.callApi('send_private_msg', { user_id: target.id, message: cq });
        sent += 1;
        info(`  已发送（语音条，音色「${VOICE.getVoice()}」，${line.slice(0, 24)}）`);
      } catch (e) {
        error('语音条发送失败：', e instanceof Error ? e.message : String(e));
      }
    }
  }
  return sent;
}

// ── 观赛模式：「一起看比赛」→ 锁定前台窗口 → 定时抓帧 → 附给桌宠 ──────
// 复用宿主原生多模态 /chat attachment，不装插件、不挂辅助 VLM。
// 观赛发言走自己的定时器和 deliver()，不经过 proactiveTurn 的夜间静默闸门，
// 所以 02:00–07:00 也能陪看；关掉观赛，静默规则原样恢复。
const WATCH = createWatchMode({
  cfg: CONFIG.watchMode ?? {},  enabled: CONFIG.watchMode?.enabled !== false && !CONFIG.reply.dryRun,
  log: info,
  ask: (prompt, attachment) => petReply(prompt, attachment),
  send: (t, reply) => deliver(t, reply),
  onSpoke: (t) => {
    // 她刚在观赛里说过话，常规 30 分钟主动续话往后推，别和实时解说叠在一起。
    if (t?.type === 'private') resetIdle(t);
    else if (t?.type === 'group') resetGroupIdle(Number(t.id));
  },
  quietActive: () => inNightQuietAt(),
  quietLabel: () => quietLabel(),
});

// ── 抖音浏览模式：溪颜自己的账号自己刷，刷到有意思的拿来聊 ────────────
// 默认 config.douyin.enabled=false：模块加载但所有口令都不响应，聊天零影响。
// 评论和动态默认人审（douyin-pending.json 待审清单，QQ 里「抖音同意 编号」才真正提交）。
// 与观赛互斥：观赛开着时她只看不说；发言走自己的定时器和 deliver()，不叠主动续话节奏。
const DOUYIN = createDouyinMode({
  cfg: CONFIG.douyin ?? {},
  enabled: CONFIG.douyin?.enabled === true && !CONFIG.reply.dryRun,
  log: info,
  ask: (prompt, attachment) => petReply(prompt, attachment),
  // 共看分镜图从 reply.shotFile 走 base64 CQ；普通抖音提示没有这个字段，行为不变。
  send: (t, reply) => deliver(t, reply, 0, reply?.shotFile ?? ''),
  onSpoke: (t) => {
    if (t?.type === 'private') resetIdle(t);
    else if (t?.type === 'group') resetGroupIdle(Number(t.id));
  },
  watchActive: () => WATCH.active(),
  quietActive: () => inNightQuietAt(),
  here: HERE,
});

// ── 任务通道（方案①最小闭环）────────────────────────────────────────
// 默认 enabled=false：加载但不生效，正常聊天零影响。要让哥哥用 QQ 布置任务，
// 把 config.task.enabled 改 true、重启桥即可；回退只要改回 false。
const TASK = (() => {
  const raw = CONFIG.task ?? {};
  const cfg = { ...DEFAULT_TASK_CONFIG, ...raw };
  const queue = createTaskQueue({ root: HERE, cfg });
  return {
    cfg,
    enabled: cfg.enabled === true,
    ack: cfg.ackOnEnqueue === false ? '' : String(cfg.ack ?? ''),
    queue,
  };
})();

// ── 主动续话：哥哥静默一会儿，她自己接着刚才的话题说一句 ─────────────
// /chat 只收 text 且必定写记忆，所以续话用一段「旁白」当输入：既带上历史，也讲清这不是哥哥在问。
// dsh-pet 的 /whisper 是「无上下文、20 字随机碎碎念」，接不上话题，故不用它。
const DEFAULT_PROACTIVE_PROMPT =
  '（旁白：这句只会发到【私聊】里，给哥哥一个人看。这一轮哥哥没有发任何新消息，你看到的每一句话都不是他刚说的。'
  + '先分清三件事：①只有本轮新到、带【私聊｜这句会发回私聊】并以「哥哥：」开头的，才是他此刻亲口说的话——这种现在没有；'
  + '②「私聊里最近这几句」只是让你找语气的旧对话，是今晚早些时候聊过的，不是刚说的；'
  + '③【长期记忆】里「哥哥要你……」「你答应过……」「他记着……」这类，全是你记在本子上的旧事，不是他现在的要求，哪怕写着「今天记下」也不是今天刚说的。'
  + '所以这一轮不要把任何一句旧话当成他刚说的去接、去回应、去承诺：不要说「我记着了」「你让我……」「别一个人扛」「想说什么就说什么」这种像是回答他的话——根本没有新的话需要你回答。'
  + '这是给你自己想说一句的机会：说不说由你自己定，别为了说而说；想说就只说一句自己此刻冒出来的小念头，别去续旧对话、别替旧记忆作答。'
  + '群里刚聊过的任何话题、泡泡说过的任何话都不属于这里，绝对不要提、不要接、不要解释。'
  + '别开新话题，别问「在吗」「还在吗」，别催他回，别重复刚说过的话。一两句，短。'
  + '若下面没有私聊近况，就只轻轻说一句想他，别硬接任何话题。'
  + '要是这会儿没什么想说的、或觉得不该打扰他，就只回 [skip]，桥就不会发任何消息——你不出声也没关系。）';

/**
 * 私聊主动续话的「她自己决定不说」判定。
 * 只有纯 [skip]、或只剩标点/空白才算跳过；带正文的话即使含 [skip] 也照发（避免吞掉正经回复）。
 * 有图片时一律不算跳过（她配了图就是想说）。
 */
function isProactiveSkip(text, image = '') {
  if (image) return false;
  const s = String(text ?? '').trim();
  if (!s) return true;
  if (/^\[skip\]$/i.test(s)) return true;
  // 只有标点/省略号，没有实际文字，也视为「不想说」
  if (/^[\s。.、…,，!！?？~～\-]*$/.test(s)) return true;
  return false;
}
const PRO = CONFIG.proactive ?? {};
const SLEEP_CFG = PRO.sleep ?? {};
/** 睡眠/清醒状态感知：桌宠官方 sleep 叶子优先，其次最近对话文本；结论落盘，重启桥不丢。 */
const sleepWatcher = createSleepWatcher({
  petId: CONFIG.pet.petId ?? 'main',
  stateUrl: () => PET.stateUrl(),
  stateFile: isAbsolute(SLEEP_CFG.stateFile ?? '')
    ? SLEEP_CFG.stateFile
    : join(HERE, SLEEP_CFG.stateFile ?? 'proactive-state.json'),
  wakeWords: Array.isArray(SLEEP_CFG.wakeWords) && SLEEP_CFG.wakeWords.length ? SLEEP_CFG.wakeWords : undefined,
  sleepWords: Array.isArray(SLEEP_CFG.sleepWords) && SLEEP_CFG.sleepWords.length ? SLEEP_CFG.sleepWords : undefined,
  log: (m) => info(m),
});
const WAKE_USER_WORDS = Array.isArray(SLEEP_CFG.wakeUserWords) && SLEEP_CFG.wakeUserWords.length
  ? SLEEP_CFG.wakeUserWords
  : DEFAULT_WAKE_USER;
let idleTimer = null;
let idleGen = 0;      // 每次哥哥说话 +1，让「正在生成中的续话」作废，避免插队
let selfTurns = 0;    // 本轮静默期已经自己说过几句
let idleTarget = null;
let lastUserAt = Date.now();
let lastGroupActivityAt = 0;   // 最近一次群聊消息；私聊主动续话要避开刚被群聊刷满的记忆窗口

// ── 省电模式（用户在用电脑时）─────────────────────────────────────
// focus-mode.ps1 写这个标记：存在时暂停「主动续话 / 群内主动」这类自己找话说的行为。
// 被动回复、赴约闹钟、@ 定向、防循环全部不受影响 —— QQ 来消息照常回。
const FOCUS_FLAG = join(HERE, 'focus-mode.flag');
function focusQuiet() {
  try { return existsSync(FOCUS_FLAG); } catch { return false; }
}
function proactiveEnabled() {
  // 2026-11-20：哥哥要求解除主动发送限制，配置 respectFocusFlag=false 时桌面省电开关
  // 不再暂停主动续话。改回 true 即恢复「用电脑时暂停主动」的旧行为。
  const respectFocus = PRO.respectFocusFlag !== false;
  return PRO.enabled === true && !CONFIG.reply.dryRun && (!respectFocus || !focusQuiet());
}
function quietHoursHit(q) {
  if (!Array.isArray(q) || q.length !== 2) return false;
  const [a, b] = q.map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return false;
  const h = new Date().getHours();
  return a < b ? h >= a && h < b : h >= a || h < b;
}
function inQuietHours() {
  return quietHoursHit(PRO.quietHours);
}

// ── 夜间静默：每天 02:00–07:00 不主动发消息 ────────────────────────────────
// 真源是 proactive.quietHours（私聊续话、群内主动各自读自己的一份，配成同一组值）。
// 下面两个函数给「排在未来某个具体时刻」的赴约闹钟用：判断那个时刻是不是静默期、
// 是的话顺延到最近一次静默结束。用分钟/秒一起算，边界 07:00:00 精确落在静默外。
function quietRange() {
  const q = PRO.quietHours;
  if (!Array.isArray(q) || q.length !== 2) return null;
  const [a, b] = q.map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return null;
  if (a < 0 || a > 23 || b < 0 || b > 23) return null;
  return { from: a, to: b };
}
function quietLabel() {
  const r = quietRange();
  return r ? `${String(r.from).padStart(2, '0')}:00–${String(r.to).padStart(2, '0')}:00` : '未设置';
}
function inNightQuietAt(ts = Date.now()) {
  const r = quietRange();
  if (!r) return false;
  const d = new Date(ts);
  const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  return r.from < r.to ? h >= r.from && h < r.to : h >= r.from || h < r.to;
}
/** 落在静默期的时刻 → 顺延到最近一次静默结束；静默外的时刻原样返回。跨天区间同样适用。 */
function deferPastNightQuiet(at) {
  const r = quietRange();
  if (!r || !inNightQuietAt(at)) return at;
  const end = new Date(at);
  end.setHours(r.to, 0, 0, 0);
  if (end.getTime() <= at) end.setDate(end.getDate() + 1);
  return end.getTime();
}

/** 当前节奏：清醒用 proactive.*，睡着时用 proactive.sleep.* 覆盖（没配的项回落到清醒值）。 */
function proactiveTiming() {
  const asleep = sleepWatcher.asleep;
  const s = asleep ? SLEEP_CFG : {};
  const ms = (k, fallback) => Math.max(5000, Number(s[k] ?? PRO[k] ?? fallback));
  // 方案③：spreadMs 不套 ms() 的 5000 下限——0 就是关闭随机，必须保留为 0。
  const spread = Math.max(0, Number(s.spreadMs ?? PRO.spreadMs ?? 0));
  return {
    asleep,
    idleMs: ms('idleMs', 1800000),
    intervalMs: ms('intervalMs', 1800000),
    spreadMs: spread,
    maxPerIdle: Math.max(0, Math.floor(Number(s.maxPerIdle ?? PRO.maxPerIdle ?? 1))),
  };
}
const minutes = (v) => `${Math.round(v / 60000)} 分钟`;
/** 秒级显示：30 秒这类短间隔用分钟会被四舍五入成「1 分钟」，看日志容易误会。 */
const dur = (v) => (v < 60000 ? `${Math.round(v / 1000)} 秒` : minutes(v));

/** 状态中途切换时，新间隔从「哥哥最后一句话」那刻算起，而不是又白等一整段。 */
function scheduleFromLastUser(gen) {
  const t = proactiveTiming();
  const wait = Math.max(5000, nextProactiveDelay(t.idleMs, t.spreadMs) - (Date.now() - lastUserAt));
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void proactiveTurn(gen), wait);
  info(`主动续话：改按${t.asleep ? '睡觉' : '清醒'}节奏，${dur(wait)}后触发`);
}

/** 每收到一条哥哥的消息就重新计时；只跟私聊续话，群聊不主动发。 */
function resetIdle(target) {
  if (!proactiveEnabled() || target?.type !== 'private') return;
  idleGen += 1;
  selfTurns = 0;
  idleTarget = target;
  lastUserAt = Date.now();
  const t = proactiveTiming();
  if (idleTimer) clearTimeout(idleTimer);
  const gen = idleGen;
  const wait = nextProactiveDelay(t.idleMs, t.spreadMs);
  idleTimer = setTimeout(() => void proactiveTurn(gen), wait);
  info(`主动续话：当前${t.asleep ? '睡觉' : '清醒'}，${dur(wait)}后说一句`);
  // 顺带重新识别状态；结论翻转就按新节奏从最后一句话重新计时
  void sleepWatcher.refresh().then(({ changed }) => {
    if (changed && gen === idleGen) scheduleFromLastUser(gen);
  }).catch(() => {});
}

function scheduleNext(gen) {
  if (idleTimer) clearTimeout(idleTimer);
  const t = proactiveTiming();
  idleTimer = setTimeout(() => void proactiveTurn(gen), nextProactiveDelay(t.intervalMs, t.spreadMs));
}

/**
 * 私聊主动续话的「上下文重锚」。
 * 桌宠只有一份 memory.json，群聊刷屏会把 chatMemoryRounds 窗口占满；不重锚的话，
 * 到点的私聊续话会接着群里的话题说、然后被发到私聊（串线）。
 * 这里只从最近记忆窗口里挑出带【私聊】/「哥哥：」标签的 user 轮。
 */
async function recentPrivateContext(limit = 4) {
  try {
    const res = await fetch(`${PET.chatUrl()}&rounds=20`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const json = await res.json();
    const list = Array.isArray(json?.messages) ? json.messages : [];
    const out = [];
    for (const m of list) {
      if (m?.role !== 'user' || typeof m?.content !== 'string') continue;
      const c = m.content;
      if (!(c.startsWith('【私聊') || c.startsWith('哥哥：'))) continue;
      const body = c.replace(/^【[^】]*】\s*/, '').replace(/^哥哥：/, '').trim();
      if (!body || body.startsWith('（旁白')) continue;
      out.push(body.replace(/\s+/g, ' ').slice(0, 160));
    }
    return out.slice(-limit);
  } catch (e) {
    warn('读取私聊近况失败，本轮不重锚：', e instanceof Error ? e.message : String(e));
    return [];
  }
}

async function proactiveTurn(gen) {
  if (gen !== idleGen || !proactiveEnabled() || !idleTarget) return;  // 期间哥哥说过话 → 作废
  const before = sleepWatcher.asleep;
  await sleepWatcher.refresh();
  if (gen !== idleGen) return;
  if (sleepWatcher.asleep !== before) {
    // 静默期间她睡着/醒了：这一句先不发，按新节奏重新等
    selfTurns = 0;
    scheduleFromLastUser(gen);
    return;
  }
  if (inQuietHours()) {
    // 关键：不能直接 return。以前 quietHours 是空的没暴露，一配时段就会让整条续话
    // 循环在 02:00 断掉、07:00 后也不再恢复。这里排到静默结束继续空转。
    const until = deferPastNightQuiet(Date.now());
    const wait = until > Date.now() + 1000
      ? Math.max(5000, until - Date.now())
      : proactiveTiming().intervalMs;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void proactiveTurn(gen), wait);
    info(`主动续话：夜间静默（${quietLabel()}），跳过；${minutes(wait)}后再看`);
    return;
  }
  const t = proactiveTiming();
  if (t.maxPerIdle > 0 && selfTurns >= t.maxPerIdle) {
    info('主动续话：本轮已说过，等哥哥再说话（保持状态监听）');
    scheduleNext(gen);   // 空转也要继续跑，才能发现她中途睡着 / 醒了
    return;
  }
  // 群聊刚热闹过就跳过私聊主动：原本是防止把群话题带进私聊的质量闸门。
  // 2026-11-20 解除限制：上下文重锚（recentPrivateContext）已经保证只接私聊近况，
  // 这里默认不再跳过；需要恢复旧行为把 proactive.groupCooldownMs 设回 600000。
  const cooldownCfg = Math.max(0, Number(PRO.groupCooldownMs ?? 0));
  const GROUP_COOLDOWN_MS = cooldownCfg > 0
    ? Math.max(60000, Math.min(t.idleMs, cooldownCfg))
    : 0;
  const groupQuietFor = Date.now() - lastGroupActivityAt;
  if (GROUP_COOLDOWN_MS > 0 && lastGroupActivityAt > 0 && groupQuietFor < GROUP_COOLDOWN_MS) {
    info(`主动续话：${minutes(groupQuietFor)}前群里还在聊，跳过这句以免把群话题带进私聊`);
    scheduleNext(gen);
    return;
  }
  const priv = await recentPrivateContext();
  if (gen !== idleGen) return;                                       // 拉取期间哥哥插话了
  const anchor = priv.length
    ? `\n（私聊里最近这几句是今晚早些时候的旧对话，只给你找找语气，不是哥哥刚说的话——不要当成新消息去回答或接话：${priv.map((s, i) => `${i + 1}. ${s}`).join('  ')}）`
    : '\n（私聊里最近没有可接的话：想说就轻轻说一句想他；不想说就只回 [skip]。绝对不要接群里的话题。）';
  const reply = await petReply((PRO.prompt || DEFAULT_PROACTIVE_PROMPT) + anchor);
  if (gen !== idleGen) return;                                       // 生成期间哥哥插话了
  // 2026-11-20：私聊主动「说不说由她自己定」——回 [skip]（或只有标点）就不发，继续等下一次机会。
  if (isProactiveSkip(reply.text, reply.image)) {
    info('主动续话：她这会儿不想说（[skip]），本轮不发送，下次机会再来');
    scheduleNext(gen);
    return;
  }
  if (!reply.text && !reply.image) { scheduleNext(gen); return; }
  selfTurns += 1;
  info(`主动续话：第 ${selfTurns}/${t.maxPerIdle > 0 ? t.maxPerIdle : '不限'} 句（${t.asleep ? '睡觉' : '清醒'}，间隔 ${dur(t.intervalMs)}）`);
  info('→ 桌宠（主动）：', String(reply.text).slice(0, 160));
  await deliver(idleTarget, reply);
  scheduleNext(gen);
}

// ── 赴约闹钟：哥哥说「五分钟后找我」「明天八点叫我」时，真的排一个定时器 ──
// 桌宠模型自己没有定时器工具，只能口头答应；固定 30/60 分钟的静默续话也接不住这种约定。
// 这里只在私聊里认「相对时长 / 绝对时刻 + 找我 / 提醒我」，到点用旁白调 /chat 发一句赴约的话。
// 约定落盘，桥重启后未过期的会重新排；过期的直接丢弃，不半夜补发。
const APPT = CONFIG.appointments ?? {};
const APPT_ENABLED = APPT.enabled !== false && !CONFIG.reply.dryRun;
const APPT_FILE = isAbsolute(APPT.stateFile ?? '')
  ? APPT.stateFile
  : join(HERE, APPT.stateFile ?? 'appointments.json');
const APPT_MIN_MS = Math.max(1000, Number(APPT.minMs ?? 10000));
const APPT_MAX_MS = Math.min(7 * 24 * 3600000, Number(APPT.maxMs ?? 86400000));
const APPT_MAX_PENDING = Math.max(1, Math.floor(Number(APPT.maxPending ?? 5)));
// 哥哥明确约的时间若落在夜间静默里，也不在半夜发：顺延到静默结束，不是丢弃。
// 想让「赴约」豁免（凌晨也准点发），把 config.appointments.respectQuietHours 改成 false。
const APPT_RESPECT_QUIET = APPT.respectQuietHours !== false && !!quietRange();
// 绝对时刻另设上限：相对时间的 24 小时不能套到「后天 / 下周三」上，否则会被截断成错误时间。
const APPT_ABS = APPT.absolute ?? {};
const APPT_ABS_ENABLED = APPT_ENABLED && APPT_ABS.enabled !== false;
const APPT_ABS_MAX_MS = Math.min(20 * 86400000, Math.max(3600000, Number(APPT_ABS.maxMs ?? 8 * 86400000)));
let apptItems = [];
const apptTimers = new Map();
let apptSeq = 0;

const apptId = () => `a${Date.now().toString(36)}${(++apptSeq).toString(36)}`;
const apptSave = () => saveAppointments(APPT_FILE, apptItems);
const apptDuration = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)} 秒` : minutes(ms));
function apptClearTimer(id) {
  const t = apptTimers.get(id);
  if (t) clearTimeout(t);
  apptTimers.delete(id);
}
function apptArm(item, delayMs) {
  apptClearTimer(item.id);
  const t = setTimeout(() => void fireAppointment(item.id), Math.max(0, delayMs));
  t.unref?.();
  apptTimers.set(item.id, t);
}
function apptCancelAll(reason) {
  for (const it of apptItems) apptClearTimer(it.id);
  const n = apptItems.length;
  apptItems = [];
  apptSave();
  if (n > 0) info(`赴约：取消 ${n} 个待触发约定（${reason}）`);
}

/** 每收到一条私聊消息就试着解析一次约定；不改动正常回复链路。 */
function maybeScheduleAppointment(userLine, target) {
  if (!APPT_ENABLED || target?.type !== 'private') return;
  if (isCancelRequest(userLine)) {
    apptCancelAll('哥哥说不用找了');
    return;
  }
  const now = Date.now();
  const parsed = parseAppointment(userLine, now);
  if (!parsed) return;
  if (parsed.kind === 'absolute' && !APPT_ABS_ENABLED) return;

  let delayMs;
  if (parsed.kind === 'absolute') {
    delayMs = parsed.at - now;
    if (delayMs > APPT_ABS_MAX_MS) {
      warn(`赴约：绝对时刻「${parsed.label}」超过 ${Math.round(APPT_ABS_MAX_MS / 86400000)} 天上限，忽略`);
      return;
    }
    delayMs = Math.max(APPT_MIN_MS, delayMs);
  } else {
    delayMs = Math.min(APPT_MAX_MS, Math.max(APPT_MIN_MS, parsed.delayMs));
  }
  let at = now + delayMs;
  let deferred = false;
  if (APPT_RESPECT_QUIET) {
    const pushed = deferPastNightQuiet(at);
    if (pushed !== at) {
      at = pushed;
      delayMs = at - now;
      deferred = true;
      info(`赴约：约定落在夜间静默（${quietLabel()}），顺延到 ${new Date(at).toLocaleString('zh-CN', { hour12: false })}`);
    }
  }
  // 合并窗口可能把同一句喂进来两次；5 秒内同人同触发时刻只登记一次
  if (apptItems.some((it) => now - it.createdAt < 5000 && Math.abs(it.at - at) < 1500 && it.target?.id === target.id)) return;
  if (apptItems.length >= APPT_MAX_PENDING) {
    warn(`赴约：待触发约定已达 ${APPT_MAX_PENDING} 个，忽略「${userLine.slice(0, 40)}」`);
    return;
  }
  const item = {
    id: apptId(),
    at,
    createdAt: now,
    delayMs,
    kind: parsed.kind,
    label: parsed.kind === 'absolute' ? (deferred ? formatWhen(at, now) : parsed.label) : null,
    phrase: userLine.slice(0, 120),
    target: { type: 'private', id: target.id },
  };
  apptItems.push(item);
  apptSave();
  apptArm(item, delayMs);
  const when = deferred
    ? `顺延到 ${new Date(at).toLocaleString('zh-CN', { hour12: false })}`
    : parsed.kind === 'absolute' ? parsed.label : `${minutes(delayMs)}后`;
  info(`赴约：登记「${item.phrase.slice(0, 50)}」→ ${when}（${new Date(at).toLocaleString('zh-CN', { hour12: false })}）主动找哥哥`);
}

async function fireAppointment(id) {
  const item = apptItems.find((x) => x.id === id);
  if (!item) return;
  apptClearTimer(id);
  // 兜底：登记后配置改过、或跨天/系统睡眠让定时器晚点触发，到点若仍在静默期就不发。
  if (APPT_RESPECT_QUIET && inNightQuietAt(item.at)) {
    const pushed = deferPastNightQuiet(item.at);
    if (pushed > Date.now() + 1000) {
      item.at = pushed;
      if (item.kind === 'absolute') item.label = formatWhen(pushed, Date.now());
      apptSave();
      apptArm(item, pushed - Date.now());
      info(`赴约：到点但仍在夜间静默（${quietLabel()}），顺延到 ${new Date(pushed).toLocaleString('zh-CN', { hour12: false })}`);
      return;
    }
  }
  apptItems = apptItems.filter((x) => x.id !== id);
  apptSave();
  if (!APPT_ENABLED || !bot.accountOk) return;
  info(`赴约：到点了（${item.label ? `${item.label}｜` : ''}${item.phrase.slice(0, 40)}），生成一句发到私聊`);
  const prompt = fill(APPT.prompt || DEFAULT_APPOINTMENT_PROMPT, { phrase: item.phrase });
  const reply = await petReply(prompt);
  if (!reply.text && !reply.image) {
    warn('赴约：桌宠没给出回复，这一句跳过');
    return;
  }
  info('→ 桌宠（赴约）：', String(reply.text).slice(0, 160));
  const sent = await deliver(item.target, reply);
  // 刚说过话，把 30 分钟静默续话从这一刻重新算，避免紧接着又来一句
  if (sent > 0) resetIdle(item.target);
}

function restoreAppointments() {
  if (!APPT_ENABLED) return;
  const loaded = loadAppointments(APPT_FILE);
  const now = Date.now();
  const live = [];
  let expired = 0;
  let deferred = 0;
  for (const it of loaded) {
    if (!it?.id || !it?.target?.id || !Number.isFinite(it?.at)) continue;
    if (it.at <= now) { expired += 1; continue; } // 桥不在时过期的约定不补发
    if (APPT_RESPECT_QUIET && inNightQuietAt(it.at)) {
      it.at = deferPastNightQuiet(it.at);
      deferred += 1;
    }
    if (it.kind === 'absolute') it.label = formatWhen(it.at, now); // 跨天后「明天」要改成「今天」
    live.push(it);
    apptArm(it, it.at - now);
  }
  apptItems = live;
  apptSave();
  if (live.length || expired || deferred) {
    info(`赴约：恢复 ${live.length} 个待触发约定，丢弃 ${expired} 个已过期的，顺延 ${deferred} 个到静默结束`);
  }
}

// ── 群内主动说话：三人群安静时，溪颜也可以自己先开口 ──────────────────
// 与私聊主动续话完全独立的一套计时器：群里任何一条消息都会重置静默计时，
// 生成期间有人插话则这一句作废；发送仍走同一套群聊防刷屏窗口。
const GPRO = PRO.group ?? {};
const GROUP_PRO_IDS = (Array.isArray(GPRO.groups) ? GPRO.groups : []).map(Number).filter(Boolean);
const DEFAULT_GROUP_PROMPT =
  '（旁白：这句会发到【三人群】，哥哥和泡泡都看得见。群里安静了好一会儿，没有人说话，'
  + '这是你自己在群里想说的一句。只接着刚才群里聊到的地方往下说：补一句没说完的、'
  + '忽然想起的、或者轻轻起个小话头。别问「在吗」，别催人回，别重复刚说过的话，'
  + '别把私聊里的事带进群；一两句，短。）';
const groupProState = new Map();   // gid → { timer, gen, selfTurns, lastAt }

function groupProEnabled() {
  return proactiveEnabled() && GPRO.enabled === true && GROUP_PRO_IDS.length > 0;
}
/** 清醒用 group.*；睡着时用 sleep 覆盖（没配就回落到私聊的睡觉节奏）。 */
function groupProTiming() {
  const base = proactiveTiming();
  if (base.asleep) {
    const ms = (k, fallback) => Math.max(5000, Number(GPRO[k] ?? fallback));
    return {
      asleep: true,
      idleMs: ms('sleepIdleMs', SLEEP_CFG.idleMs ?? 3600000),
      intervalMs: ms('sleepIntervalMs', SLEEP_CFG.intervalMs ?? 3600000),
      maxPerIdle: Math.max(0, Math.floor(Number(GPRO.sleepMaxPerIdle ?? SLEEP_CFG.maxPerIdle ?? 1))),
    };
  }
  return {
    asleep: false,
    idleMs: Math.max(5000, Number(GPRO.idleMs ?? base.idleMs)),
    intervalMs: Math.max(5000, Number(GPRO.intervalMs ?? GPRO.idleMs ?? base.intervalMs)),
    maxPerIdle: Math.max(0, Math.floor(Number(GPRO.maxPerIdle ?? 2))),
  };
}
function proStateOf(gid) {
  if (!groupProState.has(gid)) {
    groupProState.set(gid, { timer: null, gen: 0, selfTurns: 0, lastAt: Date.now() });
  }
  return groupProState.get(gid);
}
function armGroupTimer(gid, st, delayMs, gen = st.gen) {
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => void groupProactiveTurn(gid, gen), Math.max(5000, delayMs));
}
/** 主动发言也要守群聊窗口，别在刚刷过屏的时候再添一句。 */
function groupWindowFull(gid) {
  const st = groupStateOf(gid);
  const now = Date.now();
  st.sentAt = st.sentAt.filter((t) => now - t < WINDOW_MS);
  return MAX_SENDS_WINDOW > 0 && st.sentAt.length >= MAX_SENDS_WINDOW;
}
/** 群里任何一条监听范围内的消息都重新计时；正在生成中的主动发言随即作废。 */
function resetGroupIdle(gid) {
  if (!groupProEnabled() || !GROUP_PRO_IDS.includes(Number(gid))) return;
  const st = proStateOf(Number(gid));
  st.gen += 1;
  st.selfTurns = 0;
  st.lastAt = Date.now();
  armGroupTimer(gid, st, groupProTiming().idleMs);
}
function startGroupProactive() {
  if (!groupProEnabled()) return;
  for (const gid of GROUP_PRO_IDS) armGroupTimer(gid, proStateOf(gid), groupProTiming().idleMs);
}
function groupProSummary() {
  if (!groupProEnabled()) return '关闭';
  const t = groupProTiming();
  return `开启（群 ${GROUP_PRO_IDS.join('、')}，静默 ${dur(t.idleMs)} 后一句，之后每 ${dur(t.intervalMs)}，每轮最多 ${t.maxPerIdle > 0 ? t.maxPerIdle : '不限'} 句，${t.asleep ? '睡觉' : '清醒'}）`;
}
async function groupProactiveTurn(gid, gen) {
  const st = groupProState.get(gid);
  if (!st || gen !== st.gen || !groupProEnabled()) return;
  const before = sleepWatcher.asleep;
  await sleepWatcher.refresh();
  if (gen !== st.gen) return;
  if (sleepWatcher.asleep !== before) {
    st.selfTurns = 0;
    st.lastAt = Date.now();
    armGroupTimer(gid, st, groupProTiming().idleMs);
    info(`群内主动：状态切到${sleepWatcher.asleep ? '睡觉' : '清醒'}，群 ${gid} 重新计时`);
    return;
  }
  const t = groupProTiming();
  if (quietHoursHit(GPRO.quietHours) || groupWindowFull(gid)) {
    armGroupTimer(gid, st, t.intervalMs);   // 免打扰 / 窗口已满：跳过这句，继续等下一轮
    return;
  }
  if (t.maxPerIdle > 0 && st.selfTurns >= t.maxPerIdle) {
    armGroupTimer(gid, st, t.intervalMs);
    return;
  }
  const waited = Date.now() - st.lastAt;
  if (waited < t.idleMs - 5000) {          // 被状态翻转提前唤起等情况，按剩余时间重排
    armGroupTimer(gid, st, t.idleMs - waited);
    return;
  }
  st.selfTurns += 1;
  info(`群内主动：群 ${gid} 第 ${st.selfTurns}/${t.maxPerIdle > 0 ? t.maxPerIdle : '不限'} 句（${t.asleep ? '睡觉' : '清醒'}）`);
  const reply = await petReply(GPRO.prompt || DEFAULT_GROUP_PROMPT);
  if (gen !== st.gen) return;               // 生成期间群里有人说话 → 这一句作废
  if (!reply.text && !reply.image) { armGroupTimer(gid, st, t.intervalMs); return; }
  info('→ 桌宠（群内主动）：', String(reply.text).slice(0, 160));
  const sent = await deliver({ type: 'group', id: gid }, reply);
  if (sent > 0) noteGroupSends(gid, sent);
  armGroupTimer(gid, st, t.intervalMs);
}

const groupNames = new Map();
async function groupNameOf(gid) {
  if (groupNames.has(gid)) return groupNames.get(gid);
  try {
    const list = await bot.callApi('get_group_list');
    for (const g of Array.isArray(list) ? list : []) groupNames.set(Number(g.group_id), String(g.group_name ?? ''));
  } catch {
    /* 拿不到就用群号 */
  }
  return groupNames.get(gid) ?? '';
}

bot.onEvent = (msg) => acceptMessage(msg);

bot.onReady = async () => {
  info('就绪：桌宠已接入 QQ');
  try {
    const st = await bot.callApi('get_status');
    info('协议端状态：', JSON.stringify(st));
  } catch {
    /* status 拿不到无所谓 */
  }
};

// ── 单实例闸门 ──────────────────────────────────────────────────────
function acquireInstanceLock() {
  return new Promise((resolve) => {
    const port = Number(CONFIG.instance?.port ?? 7341);
    const server = net.createServer((sock) => sock.destroy());
    server.once('error', (e) => {
      if (e?.code === 'EADDRINUSE') {
        info(`已有实例在跑（${port} 被占用），本次退出`);
        resolve(null);
      } else {
        warn('实例闸门异常（继续运行）：', e?.message ?? String(e));
        resolve(null);
      }
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ── 时间锚离线自测：不连 WS、不调桌宠、不真发 ────────────────────────
function timeTest() {
  const cases = [];
  const t = (name, ok) => cases.push({ name, ok: !!ok });
  const fixed = new Date(2026, 10, 23, 9, 5);
  const hint = timeHint(fixed);
  t('含年月日时分', hint.includes('2026-11-23 09:05'));
  t('明确以此为准', hint.includes('以此为准'));
  t('禁止拿对话钟点推算', hint.includes('不要拿它们推算'));
  t('禁止看岔了说法', hint.includes('没有钟面可看'));
  t('赴约旁白不再叫她别核对时间', !(CONFIG.appointments?.prompt ?? '').includes('别去核对时间'));
  const saved = CONFIG.timeHint;
  CONFIG.timeHint = { enabled: false };
  t('开关可关闭', timeHint(fixed) === '');
  CONFIG.timeHint = saved;
  for (const c of cases) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}`);
  console.log('时间锚预览：\n' + hint);
  if (cases.some((c) => !c.ok)) process.exit(1);
}

// ── 自检 ────────────────────────────────────────────────────────────
async function check() {
  const out = [];
  out.push(`通道：${CHANNEL}${EXPECT_SELF ? `（目标 QQ ${EXPECT_SELF}）` : '（不校验目标号）'}`);
  out.push(`配置：${CONFIG_PATH}`);
  await PET.resolve(true);
  out.push(`桌宠：${PET.chatUrl()}`);
  out.push(`时间锚：${CONFIG.timeHint?.enabled === false ? '关闭' : '开启（每轮 /chat 末尾注入当前时间）'}`);
  out.push(`OneBot：${CONFIG.onebot.wsUrl}`);
  try {
    const res = await fetch(PET.stateUrl(), { signal: AbortSignal.timeout(5000) });
    out.push(`桌宠接口：HTTP ${res.status}${res.ok ? '（在线）' : '（不在线，先启动 DSH 且确认 dsh-pet 已加载）'}`);
  } catch (e) {
    out.push(`桌宠接口：不可达 ${e instanceof Error ? e.message : String(e)}`);
  }
  const probe = new OneBot();
  await new Promise((resolve) => {
    probe.onReady = async () => {
      try {
        const login = await probe.callApi('get_login_info');
        const uid = Number(login?.user_id ?? 0);
        const verdict = EXPECT_SELF ? (uid === EXPECT_SELF ? '✓ 目标号' : `✗ 不是目标号（期望 ${EXPECT_SELF}）`) : '（未设目标号）';
        out.push(`协议端：在线 ${login?.nickname}(${uid}) ${verdict}`);
      } catch (e) {
        out.push(`协议端：连接成功但取身份失败 ${e instanceof Error ? e.message : String(e)}`);
      }
      probe.stop();
      resolve();
    };
    probe.start();
    setTimeout(() => {
      if (!probe.connected) out.push(`协议端：${CONFIG.onebot.wsUrl} 未连上（该通道的 QQ 没登录 / 协议端没起 / 端口不对）`);
      probe.stop();
      resolve();
    }, 8000);
  });
  out.push(`监听：私聊 ${JSON.stringify(CONFIG.listen.privates)}，群 ${JSON.stringify(CONFIG.listen.groups)}（${CONFIG.listen.groupWake} 唤醒）`);
  out.push(`群聊防循环：${groupGuardSummary()}；bot 号 ${JSON.stringify([...BOT_IDS])}`);
  out.push(`@ 定向：${atGuardSummary()}；号→称呼 ${JSON.stringify(AT_NAMES)}`);
  out.push(`回复上限：${CONFIG.reply.maxChunks ?? 8} 条 / 单条 ${CONFIG.reply.maxChars ?? 300} 字`);
  out.push(`发送节奏：${paceSummary()}；连续消息：${batchSummary()}`);
  out.push(`配图节奏：${imageGate.summary()}（只有她写了 [图:名称] 才考虑发）`);
  out.push(`入站图片：${IMG_ENABLED
    ? `开启（私聊 + ${IMG.groupsEnabled !== false ? '群聊' : '仅私聊'}，单图 ≤ ${Math.round(Number(IMG.maxImageBytes ?? 600000) / 1024)} KB，超时 ${Number(IMG.timeoutMs ?? 12000)}ms）`
    : '关闭'}；QQ 表情：${FACES_ENABLED ? '映射成 [表情:名称]' : '占位'}；格式 ${ALLOWED_MEDIA_TYPES.join(' / ')}`);
  const t = proactiveTiming();
  const gapText = (base) => t.spreadMs > 0 ? `${dur(base)}~${dur(base + t.spreadMs)} 随机` : dur(base);
  out.push(`主动续话：${proactiveEnabled()
    ? `开启（${gapText(t.idleMs)}后一句，之后每 ${gapText(t.intervalMs)}，每轮最多 ${t.maxPerIdle > 0 ? t.maxPerIdle : '不限'} 句）`
    : '关闭'}`);
  const awakeGap = `${dur(t.idleMs)}${t.spreadMs > 0 ? `+0~${dur(t.spreadMs)}` : ''}`;
  const sleepGap = `${dur(Math.max(5000, Number(SLEEP_CFG.idleMs ?? PRO.idleMs ?? 3600000)))}${Number(SLEEP_CFG.spreadMs ?? 0) > 0 ? `+0~${dur(SLEEP_CFG.spreadMs)}` : ''}`;
  out.push(`溪颜状态：${sleepWatcher.summary()}；间隔 清醒 ${awakeGap} / 睡觉 ${sleepGap}`);
  out.push(`会话隔离：消息带【私聊】/【三人群 <gid>】标签；私聊续话只接最近私聊轮；群聊冷却 ${PRO.groupCooldownMs > 0 ? minutes(PRO.groupCooldownMs) : '已关闭（群聊热闹也照常主动）'}`);
  out.push(`群内主动：${groupProSummary()}`);
  out.push(`夜间静默：${quietRange()
    ? `${quietLabel()}（私聊续话 / 群内主动跳过；赴约${APPT_RESPECT_QUIET ? '顺延到静默结束' : '不静默'}）`
    : '未设置'}${inNightQuietAt() ? '；当前正在静默' : ''}`);
  out.push(`赴约闹钟：${APPT_ENABLED
    ? `开启（相对 ${apptDuration(APPT_MIN_MS)}～${minutes(APPT_MAX_MS)}；绝对时刻${APPT_ABS_ENABLED ? `开启 ≤${Math.round(APPT_ABS_MAX_MS / 86400000)} 天` : '关闭'}；落盘待触发 ${loadAppointments(APPT_FILE).length} 个）`
    : '关闭'}`);
  out.push(WATCH.summary());
  out.push(DOUYIN.summary());
  console.log(out.join('\n'));
  process.exit(0);
}

// ── 自测：真发一条给 listen.privates[0] ─────────────────────────────
async function selftest(text) {
  const uid = Number(CONFIG.listen.privates?.[0] ?? 0);
  if (!uid) {
    error('config.listen.privates 为空，没有收件人');
    process.exit(1);
  }
  const reply = await petReply(String(text ?? '连接测试：在吗？'));
  if (!reply.text && !reply.image) process.exit(1);
  info('桌宠回复：', reply.text);
  bot.onReady = async () => {
    for (const chunk of shapeReply(reply.text, reply.image)) {
      await pace();
      await bot.callApi('send_private_msg', { user_id: uid, message: chunk });
      info(`已发送给 ${uid}${chunk.includes('[CQ:image,') ? '（含表情包图片）' : `（${chunk.length} 字）`}`);
    }
    bot.stop();
    process.exit(0);
  };
  bot.start();
  setTimeout(() => {
    error('自测超时：3001 没连上');
    process.exit(1);
  }, 30000);
}

// ── 表情包单测：只发一张图，验证协议端能收 base64:// 图片（不需要 DSH 在线）──
async function stickerTest(name) {
  const uid = Number(CONFIG.listen.privates?.[0] ?? 0);
  if (!uid) {
    error('config.listen.privates 为空，没有收件人');
    process.exit(1);
  }
  const label = String(name ?? '').trim() || '可爱';
  const file = stickers.resolveMeme(label);
  if (!file) {
    error(`找不到表情包「${label}」。可用目录：${stickers.dirs.join(' | ') || '（无）'}`);
    process.exit(1);
  }
  const cq = stickers.imageCq(file);
  if (!cq) {
    error(`图片读取失败或超过 size 上限：${file}`);
    process.exit(1);
  }
  info(`表情包自测：${basename(file)} → ${Math.round(cq.length / 1024)} KB（base64），目标 ${uid}`);
  bot.onReady = async () => {
    try {
      const login = await bot.callApi('get_login_info');
      const actual = Number(login?.user_id ?? 0);
      if (EXPECT_SELF && actual !== EXPECT_SELF) {
        error(`账号不匹配：期望 ${EXPECT_SELF}，实际 ${actual}，已拒绝发送，避免串号`);
        bot.stop();
        process.exit(2);
      }
      const r = await bot.callApi('send_private_msg', { user_id: uid, message: cq }, 20000);
      info('表情包发送成功：', JSON.stringify(r));
      bot.stop();
      process.exit(0);
    } catch (e) {
      error('表情包发送失败：', e instanceof Error ? e.message : String(e));
      bot.stop();
      process.exit(1);
    }
  };
  bot.start();
  setTimeout(() => {
    error('自测超时：协议端 WS 没连上');
    process.exit(1);
  }, 30000);
}

// ── 语音单测：验证本地 TTS 接口 + record 段生成（不连 WS、不真发）──
async function voiceTest() {
  info(`语音配置：enabled=${VOICE.enabled} url=${VOICE.base} 音色=${VOICE.getVoice()}`);
  // 1) 标记解析
  const sample = '在吗[voice]哥哥，早点睡，别熬太晚。[/voice]还有一句';
  const ex = extractVoice(sample);
  const parseOk = ex.clean === '在吗还有一句' && ex.parts.length === 1;
  info(`标记解析：${parseOk ? 'OK' : 'FAIL'} clean="${ex.clean}" parts=${JSON.stringify(ex.parts)}`);
  // 2) 换音色指令解析（哥哥的话 + 溪颜的 [voice:use]）
  const sm = CONFIG.voice?.switchMap ?? {};
  const cases = [
    ['换成卡提希娅的声音', '卡提希娅'],
    ['用胡桃说话吧', '胡桃'],
    ['音色换成希美', '希美'],
    ['能换回葱吗', '葱'],
    ['今天天气不错', null],
  ];
  let switchOk = true;
  for (const [say, want] of cases) {
    const got = detectVoiceSwitch(say, sm);
    const label = got?.label ?? null;
    const ok = label === want;
    if (!ok) switchOk = false;
    info(`  换声指令「${say}」→ ${label ?? '不触发'} ${ok ? 'OK' : `FAIL(期望 ${want ?? '不触发'})`}`);
  }
  const useSample = '好呀[voice:use 卡提希娅]这样行吗';
  const used = extractVoiceUse(useSample, sm);
  const useOk = used.switches.length === 1 && used.switches[0].label === '卡提希娅' && !used.clean.includes('voice:use');
  info(`自主换声标记：${useOk ? 'OK' : 'FAIL'} clean="${used.clean}" switches=${JSON.stringify(used.switches)}`);
  // 2.5) 音色查询：问句识别 + 动态清单（合并别名、带出当前音色）
  const queryCases = [
    ['你有哪些音色', true],
    ['能换成什么声音', true],
    ['音色列表', true],
    ['你会几种声音呀', true],
    ['今天天气不错', false],
  ];
  let queryOk = true;
  for (const [say, want] of queryCases) {
    const got = detectVoiceQuery(say);
    if (got !== want) queryOk = false;
    info(`  查询「${say}」→ ${got ? '触发' : '不触发'} ${got === want ? 'OK' : `FAIL(期望 ${want ? '触发' : '不触发'})`}`);
  }
  const catalog = voiceCatalog(sm);
  const note = voiceListNote(sm, VOICE.getVoice());
  const catalogOk = catalog.length > 0 && note.includes('一共') && note.includes(VOICE.getVoice());
  info(`音色清单：${catalog.length} 种 → ${catalog.map((it) => it.display).join('、')}`);
  info(`清单旁白：${catalogOk ? 'OK' : 'FAIL'} ${note.replace(/\n/g, ' ').slice(0, 160)}`);
  // 3) 接口探活
  const h = await VOICE.health();
  info(`语音接口：${h.ok ? 'OK' : 'FAIL'} state=${h.state}`);
  // 4) 真合成一小段（走点名音色），验证返回 WAV 与 record 段
  const wav = await VOICE.synthesize('哥哥，早点睡。');
  const cq = VOICE.recordCq(wav);
  const synthOk = !!wav && cq.startsWith('[CQ:record,file=base64://');
  info(`合成 + record 段：${synthOk ? 'OK' : 'FAIL'} bytes=${wav?.length ?? 0} cqLen=${cq.length}`);
  info(synthOk ? '语音链路可用；实际发送由桌宠回复里的 [voice] 标记触发。' : '语音链路不可用，桥会自动降级为纯文字。');
  process.exit(parseOk && switchOk && useOk && queryOk && catalogOk && h.ok && synthOk ? 0 : 1);
}

// ── 语音真发单测：合成一小段，真发一条语音条到私聊（验证协议端收 WAV base64）──
async function voiceSendTest() {
  const uid = Number(CONFIG.listen.privates?.[0] ?? 0);
  if (!uid) { error('config.listen.privates 为空，没有收件人'); process.exit(1); }
  const wav = await VOICE.synthesize('哥哥，这是溪颜的语音测试，你能听见我吗。');
  const cq = VOICE.recordCq(wav);
  if (!cq) { error('语音合成失败，没发成'); process.exit(1); }
  info(`语音真发测试 → ${uid}，record 段 ${Math.round(cq.length / 1024)} KB`);
  bot.onReady = async () => {
    try {
      const login = await bot.callApi('get_login_info');
      const actual = Number(login?.user_id ?? 0);
      if (EXPECT_SELF && actual !== EXPECT_SELF) {
        error(`账号不匹配：期望 ${EXPECT_SELF}，实际 ${actual}，拒绝发送`);
        bot.stop(); process.exit(2);
      }
      const r = await bot.callApi('send_private_msg', { user_id: uid, message: cq }, 30000);
      info('语音条发送成功：', JSON.stringify(r));
      bot.stop(); process.exit(0);
    } catch (e) {
      error('语音条发送失败：', e instanceof Error ? e.message : String(e));
      bot.stop(); process.exit(1);
    }
  };
  bot.start();
  setTimeout(() => { error('语音自测超时：WS 没连上'); process.exit(1); }, 30000);
}

// ── 主动续话单测：不等静默，直接生成并真发一句 ──────────────────────
async function proactiveTest() {
  const uid = Number(CONFIG.listen.privates?.[0] ?? 0);
  if (!uid) {
    error('config.listen.privates 为空，没有收件人');
    process.exit(1);
  }
  const priv = await recentPrivateContext();
  const anchor = priv.length
    ? `\n（私聊里最近这几句才是你该接着聊的：${priv.map((s, i) => `${i + 1}. ${s}`).join('  ')}）`
    : '\n（私聊里最近没有可接的话：只轻轻说一句想他，或干脆不说话。绝对不要接群里的话题。）';
  const reply = await petReply((PRO.prompt || DEFAULT_PROACTIVE_PROMPT) + anchor);
  if (!reply.text && !reply.image) process.exit(1);
  info('主动续话内容：', reply.text);
  bot.onReady = async () => {
    const n = await deliver({ type: 'private', id: uid }, reply);
    info(`已发送给 ${uid}（${n} 条）`);
    bot.stop();
    process.exit(n > 0 ? 0 : 1);
  };
  bot.start();
  setTimeout(() => {
    error('自测超时：协议端 WS 没连上');
    process.exit(1);
  }, 30000);
}

// ── 群内主动单测：不等静默，直接生成并往三人群真发一句 ────────────────
async function groupProactiveTest() {
  const gid = Number(GROUP_PRO_IDS[0] ?? CONFIG.listen.groups?.[0] ?? 0);
  if (!gid) {
    error('proactive.group.groups 与 listen.groups 都为空，没有目标群');
    process.exit(1);
  }
  const reply = await petReply(GPRO.prompt || DEFAULT_GROUP_PROMPT);
  if (!reply.text && !reply.image) process.exit(1);
  info('群内主动内容：', reply.text);
  bot.onReady = async () => {
    const n = await deliver({ type: 'group', id: gid }, reply);
    info(`已发送到群 ${gid}（${n} 条）`);
    bot.stop();
    process.exit(n > 0 ? 0 : 1);
  };
  bot.start();
  setTimeout(() => {
    error('自测超时：协议端 WS 没连上');
    process.exit(1);
  }, 30000);
}

// ── 假事件（不连 WS，验证过滤 + 桌宠链路）────────────────────────────
async function simulate(raw) {
  // 允许直接给事件 JSON，也给一个 .json 文件路径（Windows 命令行引号太容易被打散）
  const msg = JSON.parse(existsSync(raw) ? readFileSync(raw, 'utf8') : raw);
  CONFIG.reply.dryRun = true; // 模拟永不真发，避免误发到真群
  bot.selfId = Number(CONFIG.simulateSelfId ?? 0) || 30027;
  bot.accountOk = true;
  await handleMessage(msg, msg.group_id ? `群${msg.group_id}` : '');
  info('模拟结束');
  process.exit(0);
}

// ── 连续消息合并离线自测（不连 WS、不调桌宠、不真发）──────────────────
function batchTest() {
  const cases = [];
  const c = (name, got, want) => cases.push([name, got, want]);
  const head = (n) => `[连着发来的 ${n} 条，是一起说的，一起理解后回一次]`;
  c('单条不加标记', mergeUserLines(['我出门了']), '我出门了');
  c('空行被过滤', mergeUserLines(['', '  ', '晚点回来']), '晚点回来');
  c('两条合并', mergeUserLines(['我出门了', '晚点回来']), `${head(2)}\n我出门了\n晚点回来`);
  c('三条计数与顺序', mergeUserLines(['a', 'b', 'c']), `${head(3)}\na\nb\nc`);
  c('全空返回空串', mergeUserLines(['', ' ']), '');
  c('滑窗不超过总上限', Math.min(BATCH_QUIET_MS, BATCH_MAX_WAIT_MS) <= BATCH_QUIET_MS, true);
  c('每批条数至少 1', BATCH_MAX_MSGS >= 1, true);
  let ok = true;
  for (const [name, got, want] of cases) {
    const pass = JSON.stringify(got) === JSON.stringify(want);
    if (!pass) ok = false;
    console.log(`${pass ? '✓' : '✗'} ${name}：得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
  }
  console.log(`当前参数：${batchSummary()}；${paceSummary()}`);
  process.exit(ok ? 0 : 1);
}

// ── 群聊防循环离线自测（不连 WS、不调桌宠、不真发）────────────────────
function groupLoopTest() {
  const gid = Number((CONFIG.listen.groups ?? [])[0] ?? 20000);
  const owner = 10000;
  const otherBot = [...BOT_IDS].find((id) => id !== EXPECT_SELF) ?? [...BOT_IDS][0] ?? 30027;
  const cases = [];
  const decide = (uid) => groupDecision(gid, uid).allow;

  // 1) 哥哥开场，两个 bot 连着接话：超过轮次上限后必须静默
  groupState.clear();
  const seq = [owner, ...Array.from({ length: MAX_BOT_TURNS + 2 }, () => otherBot)];
  const got1 = seq.map(decide);
  const want1 = seq.map((_, i) => i <= MAX_BOT_TURNS);
  cases.push(['哥哥开场后 bot 连续接话', got1, want1]);

  // 2) 被拦之后哥哥插一句，应立刻恢复
  cases.push(['哥哥插话后恢复', [decide(owner), decide(otherBot)], [true, true]]);

  // 3) 窗口限流：发满上限后，连哥哥发话也不再往外发
  groupState.clear();
  for (let i = 0; i < MAX_SENDS_WINDOW; i += 1) noteGroupSends(gid, 1);
  cases.push([`窗口发满 ${MAX_SENDS_WINDOW} 条`, [decide(owner)], [false]]);

  // 4) 窗口过期后恢复
  if (MAX_SENDS_WINDOW > 0) {
    const st = groupStateOf(gid);
    st.sentAt = st.sentAt.map(() => Date.now() - WINDOW_MS - 1);
    cases.push(['窗口过期后恢复', [decide(owner)], [true]]);
  }

  let ok = true;
  for (const [name, got, want] of cases) {
    const pass = JSON.stringify(got) === JSON.stringify(want);
    if (!pass) ok = false;
    console.log(`${pass ? '✓' : '✗'} ${name}：得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
  }
  console.log(`防循环参数：${groupGuardSummary()}；bot 号 ${JSON.stringify([...BOT_IDS])}`);
  process.exit(ok ? 0 : 1);
}

// ── @ 定向离线自测（不连 WS、不调桌宠、不真发）────────────────────────
function atRouteTest() {
  const gid = 20000;
  const me = EXPECT_SELF || 10001;
  const other = [...BOT_IDS].find((id) => id !== me) ?? 30027;
  const cases = [];
  const seg = (text, ...qqs) => [
    ...qqs.map((qq) => ({ type: 'at', data: { qq: String(qq) } })),
    { type: 'text', data: { text } },
  ];

  // 1) segment 形态 @ 自己
  const a = extractText(seg('在吗', me), me);
  const ra = atRoute(a.atTargets, a.atAll, me);
  cases.push(['segment @自己 → 解析出自己', [a.atSelf, a.atTargets], [true, [String(me)]]]);
  cases.push(['segment @自己 → 不拦且算点名', [ra.directedElsewhere, ra.toSelf], [false, true]]);

  // 2) segment 形态 @ 别人
  const b = extractText(seg('你去睡', other), me);
  const rb = atRoute(b.atTargets, b.atAll, me);
  cases.push(['segment @别人 → 判定定向他人', [rb.directedElsewhere, rb.others], [true, [String(other)]]]);
  cases.push(['segment @别人 → @ 留在正文里', b.text.includes(`@${other}`), true]);

  // 3) CQ 字符串形态也要认得
  const c = extractText(`[CQ:at,qq=${other}] 过来`, me);
  const rc = atRoute(c.atTargets, c.atAll, me);
  cases.push(['CQ 码 @别人 → 判定定向他人', [rc.directedElsewhere, rc.others], [true, [String(other)]]]);

  // 4) 同时 @ 自己和别人 → 仍然要回
  const d = extractText(seg('都过来', other, me), me);
  const rd = atRoute(d.atTargets, d.atAll, me);
  cases.push(['@自己 + @别人 → 仍然回', [rd.directedElsewhere, rd.toSelf], [false, true]]);

  // 5) @全体成员是给大家的，不拦
  const e = extractText([{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '集合' } }], me);
  const re = atRoute(e.atTargets, e.atAll, me);
  cases.push(['@全体成员 → 不拦', [e.atAll, re.directedElsewhere], [true, false]]);

  // 6) 没 @ → 普通群消息
  const f = extractText('你们俩都在吗', me);
  const rf = atRoute(f.atTargets, f.atAll, me);
  cases.push(['没 @ → 不拦、label 空', [rf.directedElsewhere, rf.label], [false, '']]);

  // 7) 称呼渲染
  cases.push(['@ 号渲染成称呼', humanizeAts(`@${other} 在吗`), `@${atName(other)} 在吗`]);
  cases.push(['@自己 标成「你」', ra.label.includes(atName(me)), true]);

  // 8) 背景回放：记两条、取一次带上、取完即清
  missedByGroup.clear();
  noteMissed(gid, '哥哥 @泡泡：早点睡');
  noteMissed(gid, '哥哥 @泡泡：别闹');
  const m1 = takeMissed(gid);
  const m2 = takeMissed(gid);
  cases.push(['定向背景：取一次带上两条', [m1.includes('早点睡'), m1.includes('别闹')], [true, true]]);
  cases.push(['定向背景：取完即清', m2, '']);

  // 9) 过期的背景不带
  missedByGroup.clear();
  noteMissed(gid, '过期的话');
  missedByGroup.get(gid)[0].ts = Date.now() - MISSED_TTL_MS - 1;
  cases.push(['定向背景：过期不带', takeMissed(gid), '']);

  let ok = true;
  for (const [name, got, want] of cases) {
    const pass = JSON.stringify(got) === JSON.stringify(want);
    if (!pass) ok = false;
    console.log(`${pass ? '✓' : '✗'} ${name}：得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
  }
  console.log(`定向参数：${atGuardSummary()}；本通道号 ${me}，另一个桌宠 ${other}`);
  process.exit(ok ? 0 : 1);
}

// ── 入口 ────────────────────────────────────────────────────────────
/** 去掉 `--config <文件>` 后再判子命令，否则 `--config x --check` 会被当成常驻启动。 */
function stripConfigArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') {
      i += 1;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

// ── 入站图片 / 表情离线自测（不连 WS、不调桌宠、不真发）────────────────
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
async function imageTest() {
  const cases = [];
  const t = (name, got, want) => {
    cases.push({ ok: JSON.stringify(got) === JSON.stringify(want), name, got, want });
  };

  t('face 14 → 微笑', faceLabel('14'), '[表情:微笑]');
  t('未知 face → 占位', faceLabel('99999'), '[QQ表情]');

  // SnowLuma 今天真实上报的 image 段形状
  const real = {
    url: 'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=ABC',
    file: '8A26EB08033669EA88580655C2D957F3.jpg',
    sub_type: 1,
    summary: '[动画表情]',
  };
  t('真实 image 段取 url', describeImageSegment(real).url, real.url);
  t('真实 image 段表情包标签', describeImageSegment(real).label, '表情包：动画表情');
  t('真实 image 段算表情包', describeImageSegment(real).sticker, true);
  t('file 只是文件名 → 无地址', describeImageSegment({ file: 'abc.jpg' }).url, '');
  t('summary=[图片] 不算表情包', describeImageSegment({ url: 'http://x/a.jpg', summary: '[图片]' }).label, '');

  const cqImg = extractText('[CQ:image,file=x.jpg] 你看', 10001);
  t('CQ image 正文留占位', cqImg.text.includes('[图片]'), true);
  t('CQ image 收集 1 张', cqImg.images.length, 1);
  const cqFace = extractText('[CQ:face,id=14] 哼', 10001);
  t('CQ face 渲染成名字', cqFace.text.includes('[表情:微笑]'), true);
  const segMsg = extractText([{ type: 'image', data: real }, { type: 'text', data: { text: '好看吗' } }], 10001);
  t('segment 形态也能收图', segMsg.images.length, 1);
  t('segment 正文带表情包标签', segMsg.text.includes('表情包：动画表情'), true);

  const got = await fetchAttachment(`base64://${TINY_PNG_B64}`, { maxImageBytes: 600000, timeoutMs: 2000 });
  t('base64 图 → attachment', got.ok && got.mediaType === 'image/png' && got.attachment?.mediaType === 'image/png' && got.attachment?.data === TINY_PNG_B64, true);
  // maxImageBytes 有 1 KB 下限保护，所以要用一张真正超过上限的图来测
  const bigB64 = Buffer.alloc(2048, 0x41).toString('base64');
  t('超上限 → 失败不抛', (await fetchAttachment(`base64://${bigB64}`, { maxImageBytes: 1024, timeoutMs: 2000 })).ok, false);
  t('无地址 → 失败不抛', (await fetchAttachment('', {})).ok, false);
  t('非法 base64 → 失败不抛', (await fetchAttachment('base64://abc!!!', {})).ok, false);

  const failed = cases.filter((c) => !c.ok);
  for (const c of cases) {
    console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}${c.ok ? '' : `  得到 ${JSON.stringify(c.got)} / 期望 ${JSON.stringify(c.want)}`}`);
  }
  console.log(`图片自测：${cases.length - failed.length}/${cases.length} 通过`);
  if (failed.length) process.exit(1);
}

/** 离线验证「每天 02:00–07:00 不主动发消息」的边界与赴约顺延，不连 WS、不真发消息。 */
function quietTest() {
  const mk = (d, h, m = 0, s = 0) => new Date(2026, 10, d, h, m, s).getTime();
  const hasQuiet = quietRange() !== null;
  // 静默已取消（如 2026-11-20 解除限制后 quietHours=[]）时，期望任何时刻都不静默、不顺延。
  // 设置着静默期时才用原来的 02:00–07:00 断言。
  const oldCases = [
    ['11/14 01:59:59 静默前', mk(14, 1, 59, 59), false, mk(14, 1, 59, 59)],
    ['11/14 02:00:00 刚入静默', mk(14, 2, 0, 0), true, mk(14, 7, 0, 0)],
    ['11/14 03:30:00 静默中', mk(14, 3, 30), true, mk(14, 7, 0, 0)],
    ['11/14 06:59:59 静默尾', mk(14, 6, 59, 59), true, mk(14, 7, 0, 0)],
    ['11/14 07:00:00 出静默', mk(14, 7, 0, 0), false, mk(14, 7, 0, 0)],
    ['11/14 12:00:00 白天', mk(14, 12), false, mk(14, 12)],
    ['11/14 23:59:00 深夜但不在区间', mk(14, 23, 59), false, mk(14, 23, 59)],
    ['11/15 04:00:00 次日静默中', mk(15, 4), true, mk(15, 7, 0, 0)],
  ];
  const cases = hasQuiet
    ? oldCases
    : oldCases.map(([name, at]) => [name, at, false, at]);
  let bad = 0;
  for (const [name, at, wantQuiet, wantDeferred] of cases) {
    const gotQuiet = inNightQuietAt(at);
    const gotDeferred = deferPastNightQuiet(at);
    const ok = gotQuiet === wantQuiet && gotDeferred === wantDeferred;
    if (!ok) bad += 1;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(30)} 静默=${String(gotQuiet).padEnd(6)} 顺延到=${new Date(gotDeferred).toLocaleString('zh-CN', { hour12: false })}`);
  }
  console.log(`时段：${quietLabel()}；赴约尊重静默=${APPT_RESPECT_QUIET}；当前${inNightQuietAt() ? '正在静默' : '不在静默'}`);
  console.log(`夜间静默自测：${cases.length - bad}/${cases.length} 通过`);
  if (bad) process.exit(1);
}

/** 离线验证「赴约闹钟」的时间解析与配置，不连 WS、不真发任何消息。 */
function appointmentTest() {
  // 固定成周五傍晚 18:17，断言才可复现（12 小时循环 / 顺延规则都跟当前时刻有关）。
  const NOW = new Date(2026, 10, 13, 18, 17, 0).getTime();
  let bad = 0;
  const run = (title, cases, fn) => {
    let fail = 0;
    console.log(`--- ${title} ---`);
    for (const [s, want] of cases) {
      const val = fn(s);
      const ok = val === want;
      if (!ok) fail += 1;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${String(val).padEnd(20)} 期望 ${String(want).padEnd(20)} ${s.slice(0, 38)}`);
    }
    console.log(`${title}：${cases.length - fail}/${cases.length} 通过`);
    bad += fail;
  };

  run('相对时长', [
    ['你试试五分钟之后找我一下', 300000],
    ['半小时后提醒我', 1800000],
    ['10分钟后叫我', 600000],
    ['等二十分钟找我', 1200000],
    ['两小时后提醒我', 7200000],
    ['一个半小时后来找我', 5400000],
    ['十五分钟之后找我说话', 900000],
    ['我看看你能不能定时找我', null],
    ['五分钟我数得准。到时候看。', null],
    ['笨蛋，我是九点四十三叫你五分钟后找我，现在都十点十四了', null],
    ['……你可别趁这五分钟跑掉。', null],
    ['怎么还没来找我', null],
  ], (s) => {
    const p = parseAppointment(s, NOW);
    return p && p.kind === 'relative' ? p.delayMs : null;
  });

  run('绝对时刻', [
    ['明天八点叫我', '明天 08:00'],
    ['今晚十点找我', '今天 22:00'],
    ['十点找我', '今天 22:00'],
    ['八点半提醒我', '今天 20:30'],
    ['后天下午三点提醒我', '后天 15:00'],
    ['明早七点半叫我', '明天 07:30'],
    ['明晚八点找我', '明天 20:00'],
    ['19:00 提醒我', '今天 19:00'],
    ['8:30 找我', '明天 08:30'],
    ['明天 8:00 提醒我', '明天 08:00'],
    ['十点一刻叫我', '今天 22:15'],
    ['九点三刻提醒我', '今天 21:45'],
    ['明天早上八点零五分提醒我', '明天 08:05'],
    ['周三晚上八点找我', '11/18 周三 20:00'],
    ['周五八点提醒我', '11/20 周五 08:00'],
    ['二十三点半找我', '今天 23:30'],
    ['现在都十点十四了，你八点说好找我', null],
    ['怎么还没来找我，说好八点的', null],
    ['我看看你能不能定时找我', null],
  ], (s) => parseAbsoluteTime(s, NOW)?.label ?? null);

  console.log('--- 取消识别 ---');
  for (const s of ['取消刚才的约定', '取消吧', '别找我了', '不用了', '我再想想']) {
    console.log(`${isCancelRequest(s) ? '取消  ' : '不取消'}  ${s}`);
  }
  console.log(`配置：enabled=${APPT_ENABLED} / 相对 ${apptDuration(APPT_MIN_MS)}～${minutes(APPT_MAX_MS)} / 绝对${APPT_ABS_ENABLED ? ` ≤${Math.round(APPT_ABS_MAX_MS / 86400000)} 天` : ' 关闭'} / 最多 ${APPT_MAX_PENDING} 个 / ${APPT_FILE}`);
  console.log(`落盘待触发：${loadAppointments(APPT_FILE).length} 个`);
  const realNow = Date.now();
  for (const s of ['明天八点叫我', '十点找我', '半小时后提醒我']) {
    const p = parseAppointment(s, realNow);
    console.log(`此刻解析「${s}」→ ${p ? (p.label ?? `${minutes(p.delayMs)}后`) : '（不认）'}`);
  }
  console.log('到点旁白预览：', fill(APPT.prompt || DEFAULT_APPOINTMENT_PROMPT, { phrase: '你试试五分钟之后找我一下' }).slice(0, 220));
  if (bad) process.exit(1);
}

/** 离线验证观赛口令 / 窗口判定 / 帧判定 / 频率闸门，不连 WS、不截图、不调模型。 */
async function watchTest() {
  let bad = 0;
  let total = 0;
  const t = (name, got, want) => {
    total += 1;
    const ok = Object.is(got, want);
    if (!ok) bad += 1;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(36)} → ${String(got)}`);
  };
  const wcfg = {
    minWindowWidth: 320, minWindowHeight: 240,
    denyWindowTitles: ['微信', 'PowerShell'], denyProcesses: ['QQ', 'powershell', 'cmd'],
  };

  console.log('--- 观赛口令（含防误触）---');
  t('一起看比赛吧', parseWatchCommand('一起看比赛吧'), 'start');
  t('陪我看球', parseWatchCommand('陪我看球'), 'start');
  t('开观赛', parseWatchCommand('开观赛'), 'start');
  t('看看屏幕', parseWatchCommand('看看屏幕'), 'start');
  t('准备看比赛（日志原句）', parseWatchCommand('我一会三点准备看比赛，你能陪我一起吗'), null);
  t('闲聊提到看比赛', parseWatchCommand('你看比赛的时候记得跟我说'), null);
  t('不看了', parseWatchCommand('不看了'), 'stop');
  t('关观赛', parseWatchCommand('关观赛'), 'stop');
  t('观赛状态', parseWatchCommand('观赛状态'), 'status');
  t('嗯呐', parseWatchCommand('嗯呐'), null);
  // 2026-11-15 05:11 真实漏网：这两句她答了「好」，定时器却没停。
  t('好啦先不看咯（日志原句）', parseWatchCommand('好啦先不看咯'), 'pause');
  t('乖啦先不看咯（日志原句）', parseWatchCommand('乖啦先不看咯'), 'pause');
  t('暂停观看', parseWatchCommand('暂停观看'), 'pause');
  t('暂停观赛', parseWatchCommand('暂停观赛'), 'pause');
  t('等会儿再看', parseWatchCommand('等会儿再看'), 'pause');
  t('先别看了 → 彻底结束优先', parseWatchCommand('先别看了'), 'stop');
  t('继续观看', parseWatchCommand('继续观看'), 'resume');
  t('继续看比赛', parseWatchCommand('继续看比赛'), 'resume');
  t('接着看', parseWatchCommand('接着看'), 'resume');
  t('比赛暂停了（防误触）', parseWatchCommand('比赛暂停了'), null);
  t('闲聊「嗯呢」', parseWatchCommand('嗯呢'), null);

  console.log('--- 窗口判定 ---');
  t('正常比赛窗口', windowVerdict({ title: 'NBA 直播 - 腾讯体育', process: 'msedge', w: 1600, h: 900 }, wcfg).ok, true);
  t('QQ 主窗被排除', windowVerdict({ title: 'QQ', process: 'QQ', w: 1200, h: 800 }, wcfg).ok, false);
  t('终端被排除', windowVerdict({ title: '管理员: PowerShell', process: 'powershell', w: 1000, h: 600 }, wcfg).ok, false);
  t('窗口太小', windowVerdict({ title: '比赛', process: 'chrome', w: 200, h: 100 }, wcfg).ok, false);
  t('空标题', windowVerdict({ title: '', process: 'chrome', w: 800, h: 600 }, wcfg).ok, false);

  console.log('--- 帧判定 ---');
  const mkFp = (v) => v.toString(16).padStart(2, '0').repeat(24 * 14);
  const fpA = mkFp(120);
  t('首帧无历史 → 变化', frameVerdict(null, fpA, wcfg).verdict, 'changed');
  t('完全一样 → 静止', frameVerdict(fpA, mkFp(120), wcfg).verdict, 'static');
  t('亮度差 20 → 变化', frameVerdict(fpA, mkFp(140), wcfg).verdict, 'changed');
  t('亮度差 5 → 静止', frameVerdict(fpA, mkFp(125), wcfg).verdict, 'static');
  t('全黑 → 空帧', frameVerdict(fpA, mkFp(3), wcfg).verdict, 'blank');
  t('非法指纹', frameVerdict(fpA, 'xx', wcfg).verdict, 'invalid');

  console.log('--- 频率闸门 ---');
  const gcfg = { minSpeakIntervalMs: 90000, maxSpeakPerHour: 3 };
  t('刚说过 → 拦', speakGate([], 1000, 11000, gcfg).allow, false);
  t('间隔够 → 放', speakGate([], 0, 200000, gcfg).allow, true);
  t('一小时内 3 句 → 拦', speakGate([1000, 2000, 3000], 0, 200000, gcfg).allow, false);
  t('过期计数不计', speakGate([1], 0, 4000000, gcfg).allow, true);

  console.log('--- 暂停 / 继续状态机（假采集层，不碰真实屏幕）---');
  let fakeNow = 1700000000000;
  let captures = 0;
  const fakeCapture = {
    probe: async () => ({
      ok: true,
      window: { hwnd: 42, title: 'S16 全球总决赛 - Edge', process: 'msedge', w: 1600, h: 900 },
    }),
    capture: async () => {
      captures += 1;
      return {
        ok: true, w: 1280, h: 720, bytes: 120000, quality: 72, mean: 120,
        fp: '80'.repeat(24 * 14), mediaType: 'image/jpeg', jpeg: 'AAAA',
      };
    },
  };
  const w = createWatchMode({
    cfg: {
      frameIntervalMs: 60000, autoStopMs: 7200000, lockTimeoutMs: 12000, lockPollMs: 1000,
      minSpeakIntervalMs: 0, maxSpeakPerHour: 30, bypassQuietHours: true,
      minWindowWidth: 320, minWindowHeight: 240, denyWindowTitles: [], denyProcesses: [],
    },
    enabled: true, log: () => {}, capture: fakeCapture,
    ask: async () => ({ text: '[skip]' }), send: async () => 1,
    now: () => fakeNow,
  });
  const settle = () => new Promise((r) => setTimeout(r, 40));
  const tgt = { type: 'private', id: 10000 };
  t('没看时「先不看」交回桌宠', (await w.onUserLine('先不看咯', tgt, false, false)).handled, false);
  t('群聊没 @ → 不误触口令', (await w.onUserLine('一起看比赛', tgt, true, false)).handled, false);
  await w.onUserLine('一起看比赛', tgt, false, false);
  await settle();
  t('开启并锁定窗口 → active', w.phase(), 'active');
  t('首帧确实进了采集层', captures > 0, true);
  await w.onUserLine('好啦先不看咯', tgt, false, false);
  t('「先不看咯」→ paused', w.phase(), 'paused');
  t('暂停态状态文案', w.statusText().includes('观赛暂停中'), true);
  const before = captures;
  fakeNow += 60000;
  await settle();
  t('暂停后无新抓帧（短窗）', captures, before);
  await w.onUserLine('继续观看', tgt, false, false);
  t('「继续观看」→ active', w.phase(), 'active');
  await w.onUserLine('一起看比赛', tgt, false, false);
  t('暂停中重复开启即恢复', w.phase(), 'active');
  await w.onUserLine('不看了', tgt, false, false);
  t('「不看了」→ off', w.phase(), 'off');
  await w.stop('自测收尾', false);

  console.log('--- 当前配置 ---');
  console.log(WATCH.summary());
  console.log(`观赛自测：${total - bad}/${total} 通过`);
  if (bad) process.exit(1);
}

// ── 私聊自决 + 分场景上限 离线自测（不连 WS、不调桌宠、不真发）─────────────
function replyScopeTest() {
  let bad = 0;
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) bad += 1;
    console.log(`${ok ? '✓' : '✗'} ${name}：得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
  };
  // 1) 主动跳过判定：只有她明确不想说才跳过
  t('纯 [skip] → 跳过', isProactiveSkip('[skip]'), true);
  t('空白 [skip] → 跳过', isProactiveSkip('  [SKIP]  '), true);
  t('只有标点 → 跳过', isProactiveSkip('……'), true);
  t('空串 → 跳过', isProactiveSkip(''), true);
  t('带正文即使含 [skip] → 不跳过', isProactiveSkip('在吗 [skip]'), false);
  t('正经回复 → 不跳过', isProactiveSkip('哥哥，今天有点累。'), false);
  t('有图片 → 不跳过', isProactiveSkip('[skip]', 'meme'), false);
  // 2) 私聊 / 群聊上限确实分家
  const priv = shapeReply('甲\n乙\n丙\n丁\n戊\n己\n庚\n辛\n壬\n癸', '', false);
  const grp = shapeReply('甲\n乙\n丙\n丁\n戊\n己\n庚\n辛\n壬\n癸', '', true);
  t('私聊条数不限（10 句全留）', priv.length, 10);
  t('群聊条数受限（≤ 配置上限）', grp.length <= Number(CONFIG.reply?.group?.maxChunks ?? 8), true);
  const longLine = '字'.repeat(Number(CONFIG.reply.maxChars ?? 100000) - 100);
  t('私聊单条不截断（在上限内）', shapeReply(longLine, '', false)[0].length >= longLine.length, true);
  const longGrp = '字'.repeat(Number(CONFIG.reply?.group?.maxChars ?? 300) + 100);
  t('群聊单条截断', shapeReply(longGrp, '', true)[0].length <= Number(CONFIG.reply?.group?.maxChars ?? 300), true);
  // 3) 跨行 voice 标记不被拆散（2026-11-23：桌宠把开头/结尾写在不同行）
  const crossVoice = shapeReply('[voice]这个我可插不上嘴，\n只会吃你给我的那口。[/voice]\n旁边的普通文字。', '', false);
  t('跨行 voice 合并为一条', crossVoice.length, 2);
  const extracted = extractVoice(crossVoice.join('\n'));
  t('跨行 voice 台词完整识别', extracted.parts.length, 1);
  t('跨行 voice 台词内容', extracted.parts[0], '这个我可插不上嘴，\n只会吃你给我的那口。');
  t('跨行 voice 提取后无残留标记', /\[\/?voice\]/i.test(extracted.clean), false);
  console.log(`分场景上限：私聊 ${CONFIG.reply.maxChars}字/${CONFIG.reply.maxChunks}条；群聊 ${CONFIG.reply?.group?.maxChars}字/${CONFIG.reply?.group?.maxChunks}条；主动跳过判定 8 例`);
  if (bad) process.exit(1);
}

/** 真人感三项纯函数的离线自测（注入固定随机源，结果确定）。 */
function humanTest() {
  let bad = 0;
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) bad += 1;
    console.log(`${ok ? '✓' : '✗'} ${name}：得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
  };
  const cfg = CONFIG.reply?.casual ?? {};
  // ① 低信息量判定
  t('嗯 → 候选', isCasualMessage('嗯', cfg), true);
  t('哦哦 → 候选', isCasualMessage('哦哦', cfg), true);
  t('纯表情 → 候选', isCasualMessage('[白眼]', cfg), true);
  t('带问号 → 不拦', isCasualMessage('嗯？', cfg), false);
  t('正经长句 → 不拦', isCasualMessage('我今天去吃饭了', cfg), false);
  t('带图片 → 不拦', isCasualMessage('嗯', cfg, { hasImage: true }), false);
  t('带 @ → 不拦', isCasualMessage('好', cfg, { hasAt: true }), false);
  t('关闭时不拦', isCasualMessage('嗯', { ...cfg, enabled: false }), false);
  // ② 分档延迟：注入「抖动=0、长尾不命中」的随机源，取纯净 base
  const tiers = CONFIG.reply?.typingTiers ?? {};
  const zero = () => 0;                                  // 恒 0，供 spread 测试用
  const pure = () => { let i = 0; return () => (i++ === 0 ? 0 : 0.99); };       // 抖动0/长尾不中，每次重置计数
  const dShort = typingDelayFor('嗯。', '在吗', tiers, 2500, 1500, pure());
  const dLong = typingDelayFor('字'.repeat(60), '说说看', tiers, 2500, 1500, pure());
  t('短回复 < 长回复', dShort < dLong, true);
  t('短回复用 short.base', dShort, Number(tiers.short?.baseMs ?? 700));
  t('长回复用 long.base', dLong, Number(tiers.long?.baseMs ?? 4000));
  const dQ = typingDelayFor('在。', '在吗？', tiers, 2500, 1500, pure());
  t('问句额外加时', dQ - dShort, Number(tiers.question?.extraMs ?? 0));
  const dV = typingDelayFor('好[voice:use 葱]', '来一句', tiers, 2500, 1500, pure());
  t('语音标记额外加时', dV > dShort, true);
  t('偶发长尾命中', typingDelayFor('嗯', '', tiers, 2500, 1500, () => 0.01) > dShort, true);
  // ③ 主动随机间隔
  t('无 spread → 等于 base', nextProactiveDelay(300000, 0, zero), 300000);
  t('spread 上界', nextProactiveDelay(300000, 1500000, () => 0.999) <= 300000 + 1500000, true);
  t('spread 下界', nextProactiveDelay(300000, 1500000, zero), 300000);
  t('base 有 5 秒下限', nextProactiveDelay(1000, 0, zero), 5000);
  // ④ 戳一戳判定
  const pokeOk = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 10000, target_id: 10001 };
  t('哥哥私聊戳我 → 命中', isBrotherPoke(pokeOk, 10001, 10000), true);
  t('戳的不是我 → 不命中', isBrotherPoke({ ...pokeOk, target_id: 999 }, 10001, 10000), false);
  t('别人戳我 → 不命中', isBrotherPoke({ ...pokeOk, user_id: 999 }, 10001, 10000), false);
  t('群里的戳 → 不命中', isBrotherPoke({ ...pokeOk, group_id: 20000 }, 10001, 10000), false);
  t('普通消息 → 不命中', isBrotherPoke({ ...pokeOk, post_type: 'message' }, 10001, 10000), false);
  // ⑤ 引用回复
  t('取 message_id', quoteIdOf({ message_id: 5127577 }), 5127577);
  t('字符串 id 也取', quoteIdOf({ message_id: '5127577' }), 5127577);
  t('无 id → 0', quoteIdOf({ message_id: '' }), 0);
  t('非法 id → 0', quoteIdOf({ message_id: -3 }), 0);
  t('消息前拼引用段', withQuote('在呀', 5127577), '[CQ:reply,id=5127577]在呀');
  t('无 id 不拼', withQuote('在呀', 0), '在呀');
  console.log(`真人感三项：低信息量 8 例；分档延迟 短${dShort}/长${dLong}ms；主动间隔 5分+随机0–${CONFIG.proactive?.spreadMs ?? 0}ms；戳一戳/引用 12 例`);
  if (bad) process.exit(1);
}

const argv = stripConfigArgs(CLIENT_ARGV);
if (argv[0] === '--check') await check();
else if (argv[0] === '--time-test') timeTest();
else if (argv[0] === '--selftest') await selftest(argv.slice(1).join(' '));
else if (argv[0] === '--sticker-test') await stickerTest(argv.slice(1).join(' '));
else if (argv[0] === '--voice-test') await voiceTest();
else if (argv[0] === '--tail-pad-test') tailPadTest();
else if (argv[0] === '--voice-send-test') await voiceSendTest();
else if (argv[0] === '--proactive-test') await proactiveTest();
else if (argv[0] === '--group-proactive-test') await groupProactiveTest();
else if (argv[0] === '--simulate-event') await simulate(argv[1] ?? '{}');
else if (argv[0] === '--group-loop-test') groupLoopTest();
else if (argv[0] === '--at-route-test') atRouteTest();
else if (argv[0] === '--batch-test') batchTest();
else if (argv[0] === '--image-test') await imageTest();
else if (argv[0] === '--appointment-test') appointmentTest();
else if (argv[0] === '--quiet-test') quietTest();
else if (argv[0] === '--eat-test') {
  const r = petStateSelfTest();
  for (const x of r.cases) info(`${x.ok ? 'PASS' : 'FAIL'} ${x.name}`);
  info(`吃东西数值离线自测：${r.pass}/${r.total}`);
  if (r.pass < r.total) process.exitCode = 1;
}
else if (argv[0] === '--watch-test') await watchTest();
else if (argv[0] === '--reply-scope-test') replyScopeTest();
else if (argv[0] === '--human-test') humanTest();
else if (argv[0] === '--web-test') {
  const mod = await import('./web-search.test.mjs');
  const online = argv.includes('--online');
  const { failed } = await mod.runWebSearchTests({ online });
  if (failed > 0) process.exitCode = 1;
}
else if (argv[0] === '--draw-test') {
  const r = imageSelfTest ? imageSelfTest() : [];
  let pass = 0;
  for (const x of r) { info(`${x.pass ? 'PASS' : 'FAIL'} ${x.name}`); if (x.pass) pass++; }
  info(`绘图离线自测：${pass}/${r.length}`);
  if (argv.includes('--online')) {
    const ic = imageConfig();
    const key = readApiKey(ic.apiKeyEnv);
    if (!key) { error('没有读到 IMAGE_API_KEY，跳过真实生图'); process.exitCode = 1; }
    else {
      const started = Date.now();
      try {
        const composed = composePrompt({ subject: '一只趴在窗台睡觉的橘猫', style: 'watercolor', detail: 'draft', aspect: '方图' }, ic);
        const img = await generateImage({ ...ic, ...composed, apiKey: key, size: '512x512', quality: 'low', timeoutMs: 120000 });
        const file = saveImage(img.bytes, ic.outDir, img.mime);
        const cq = imageCq(file, ic.maxImageBytes);
        info(`真实生图成功：${img.mime} ${Math.round(img.bytes.length / 1024)}KB（${Date.now() - started}ms）；落盘 ${file}；CQ ${cq.length} 字符`);
      } catch (e) {
        error('真实生图失败：', e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    }
  }
  if (pass < r.length) process.exitCode = 1;
}
else {
  const lock = await acquireInstanceLock();
  if (lock === null) process.exit(0);
  info('===== dsh-pet-qq 启动 =====');
  info(`进程 PID ${process.pid} / 父进程 PPID ${process.ppid}`);
  info(`通道：${CHANNEL}${EXPECT_SELF ? `（目标 QQ ${EXPECT_SELF}）` : ''}`);
  info(`配置：${CONFIG_PATH}`);
  await PET.resolve(true);
  await sleepWatcher.refresh();   // 启动先同步真实状态，再打下面的状态日志
  restoreAppointments();          // 桥重启后把还没到点的约定重新排上
  info(`桌宠端点：${PET.base}${CONFIG.pet.route}`);
  if (CONFIG.webSearch?.enabled) {
    const wc = webConfig();
    info(`联网：开启（她自己写 [查:关键词] / [天气:城市] 时才查；群聊 ${wc.allowGroups === true ? '允许查' : '不查、标记剥离'}；超时 ${wc.timeoutMs}ms；每次最多 ${wc.maxResults} 条）`);
  } else {
    info('联网：关闭（回复里的 [查:x] 会被剥离，不发起任何外网请求）');
  }
  if (CONFIG.image?.enabled) {
    const ic = imageConfig();
    const keyOk = !!readApiKey(ic.apiKeyEnv);
    info(`绘图：开启（她写 [画:内容|画风|*她的构思] 时生成；群聊 ${ic.allowGroups === true ? '允许画' : '不画、标记剥离'}；模型 ${ic.model}；密钥 ${keyOk ? '已读到' : '未读到！请检查 apiKeyEnv'}；按张计费）`);
  } else {
    info('绘图：关闭（回复里的 [画:x] 会被剥离，不发起任何生图请求）');
  }
  if (CONFIG.petState?.enabled) {
    const sv = PET_STATE.snapshot();
    info(`吃东西：开启（饥饿 ${sv.hunger} ${sv.hungerWord} / 精力 ${sv.energy} ${sv.energyWord}${sv.craving ? ` / 想吃「${sv.craving}」` : ''}；状态文件 ${basename(PET_STATE.file)}）`);
  } else {
    info('吃东西：关闭（[想吃:] 标记与投喂口令都不生效，聊天零影响）');
  }
  const t0 = proactiveTiming();
  const gapText0 = (base) => t0.spreadMs > 0 ? `${dur(base)}~${dur(base + t0.spreadMs)} 随机` : dur(base);
  info(`回复上限：${CONFIG.reply.maxChunks ?? 8} 条；主动续话：${proactiveEnabled()
    ? `开启（${gapText0(t0.idleMs)}后一句，之后每 ${gapText0(t0.intervalMs)}，每轮最多 ${t0.maxPerIdle > 0 ? t0.maxPerIdle : '不限'} 句）` : '关闭'}`);
  info(`发送节奏：${paceSummary()}；连续消息：${batchSummary()}`);
  info(`互动细节：戳一戳 ${CONFIG.poke?.enabled === false ? '关' : `开（回戳${CONFIG.poke?.pokeBack === false ? '关' : '开'} / 回话${CONFIG.poke?.replyText === false ? '关' : '开'} / 冷却 ${Math.round(Number(CONFIG.poke?.cooldownMs ?? 3000) / 1000)}s）`}；引用回复 ${CONFIG.quote?.enabled === false ? '关' : '开（仅私聊首条）'}`);
  const awakeGap0 = `${dur(t0.idleMs)}${t0.spreadMs > 0 ? `+0~${dur(t0.spreadMs)}` : ''}`;
  const sleepGap0 = `${dur(Math.max(5000, Number(SLEEP_CFG.idleMs ?? PRO.idleMs ?? 3600000)))}${Number(SLEEP_CFG.spreadMs ?? 0) > 0 ? `+0~${dur(SLEEP_CFG.spreadMs)}` : ''}`;
  info(`溪颜状态：${sleepWatcher.summary()}；间隔 清醒 ${awakeGap0} / 睡觉 ${sleepGap0}`);
  info(`会话隔离：消息带【私聊】/【三人群 <gid>】标签；私聊续话只接最近私聊轮；群聊冷却 ${PRO.groupCooldownMs > 0 ? minutes(PRO.groupCooldownMs) : '已关闭（群聊热闹也照常主动）'}`);
  info(`夜间静默：${quietRange()
    ? `${quietLabel()}（私聊续话 / 群内主动跳过；赴约${APPT_RESPECT_QUIET ? '顺延到静默结束' : '不静默'}）`
    : '未设置'}${inNightQuietAt() ? '；当前正在静默' : ''}`);
  info(`赴约闹钟：${APPT_ENABLED
    ? `开启（相对 ${apptDuration(APPT_MIN_MS)}～${minutes(APPT_MAX_MS)}，绝对时刻${APPT_ABS_ENABLED ? `≤${Math.round(APPT_ABS_MAX_MS / 86400000)} 天` : '关闭'}，最多 ${APPT_MAX_PENDING} 个待触发，落盘 ${basename(APPT_FILE)}）`
    : '关闭'}`);
  info(`配图节奏：${imageGate.summary()}；只有她写了 [图:名称] 才发，不每轮附`);
  info(`入站图片：${IMG_ENABLED
    ? `开启（私聊 + ${IMG.groupsEnabled !== false ? '群聊' : '仅私聊'}，单图 ≤ ${Math.round(Number(IMG.maxImageBytes ?? 600000) / 1024)} KB）`
    : '关闭'}；QQ 表情：${FACES_ENABLED ? '映射成 [表情:名称]' : '占位'}`);
  info(WATCH.summary());
  info(DOUYIN.summary());
  info(`任务通道（方案①）：${TASK.enabled
    ? `开启（私聊口令 ${TASK.cfg.prefixes?.join('/')}，白名单 ${TASK.cfg.allowedUsers?.join(',')}，落盘 ${TASK.queue.dir}）`
    : '关闭（config.task.enabled=false，任务口令不生效，聊天零影响）'}`);
  // 只取窗口元数据、不截图；确认 PowerShell 采集层在这台机器 / 这个桌面会话里能用。
  void WATCH.probeHealth()
    .then((h) => info(`屏幕采集自检：${h.ok ? '可用' : '不可用'}（${h.reason}）`))
    .catch((e) => info(`屏幕采集自检异常：${e instanceof Error ? e.message : String(e)}`));
  if (groupProEnabled()) info(`群内主动：${groupProSummary()}`);
  process.on('SIGINT', () => {
    info('收到 SIGINT，退出');
    bot.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    bot.stop();
    process.exit(0);
  });
  process.on('unhandledRejection', (e) => error('未处理的 Promise 拒绝：', e instanceof Error ? e.message : String(e)));

  // ── 存活诊断 / 自愈 ──────────────────────────────────────────────
  // 出现过「日志突然断了 11 小时、连 WS 断开都没有」：进程被外部整个杀掉时
  // 不会触发任何 Node 事件。把异常与退出都落盘，配合 watchdog.ps1 自动拉起。
  process.on('uncaughtException', (e) => {
    error('未捕获异常，即将退出（看门狗会重新拉起）：', e instanceof Error ? (e.stack ?? e.message) : String(e));
    try { bot.stop(); } catch { /* ignore */ }
    process.exit(1);
  });
  process.on('exit', (code) => {
    // 被 Stop-Process -Force / 后台任务回收强杀时不会走到这里：
    // 日志里缺这一行，就说明是「被杀」而不是「自己崩的」。
    info(`进程退出：code=${code}`);
  });

  // WS 健康巡检：某些 WebSocket 实现只发 error、不发 close，会卡在「连接中」
  // 永不重连。每 30 秒看一眼，断线且没有排队中的重连就强制补一次。
  const healthTimer = setInterval(() => {
    if (!bot.connected && !bot.reconnectTimer && !bot.stopped) {
      warn('健康巡检：WS 断线且没有重连计划，强制重连');
      bot.connect();
    }
  }, 30000);
  healthTimer.unref?.();

  // 心跳：主动续话改成 30/60 分钟后，长时间没消息属于正常。
  // 每 30 分钟写一行，一眼分清「活着但没说话」和「已经掉线」。
  const heartbeatTimer = setInterval(async () => {
    let petState = '未知';
    try {
      const r = await fetch(PET.stateUrl(), { signal: AbortSignal.timeout(5000) });
      petState = r.ok ? '200' : String(r.status);
    } catch (e) {
      petState = `不可达（${e instanceof Error ? e.message : String(e)}）`;
      void PET.resolve(true).catch(() => {});   // DSH 重启导致端口漂移时重新发现
    }
    info(`心跳：WS ${bot.connected ? '已连接' : '断开'} / 桌宠 ${PET.base} ${petState} / ${sleepWatcher.summary()}`);
  }, 30 * 60 * 1000);
  heartbeatTimer.unref?.();

  bot.start();
  startGroupProactive();   // 从桥启动这一刻开始给三人群计静默
}
