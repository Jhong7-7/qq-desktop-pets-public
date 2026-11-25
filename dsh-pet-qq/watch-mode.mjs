#!/usr/bin/env node
/**
 * watch-mode.mjs —— 「一起看比赛」观赛模式状态机。
 *
 * 为什么不需要新插件 / 新模型：dsh-pet 的 /chat 原生收 attachment，
 * 宿主自己会把图片追加到 user content，模型直接看见画面（见 image-input.mjs）。
 * 这里只负责：口令开关 → 锁定前台窗口 → 定时抓帧 → 变化检测 →
 * 频率闸门 → 用带会话标签的旁白调 /chat → 把她说的话发回原会话。
 *
 * 隐私：
 *   · 默认关闭，只有明确口令才开启；
 *   · 只截锁定的那个窗口矩形，且该窗口必须仍在前台，否则这一帧直接跳过；
 *   · 图片只在内存里过一遍，不落盘、不写日志；
 *   · 两小时自动结束，窗口关掉立即结束；
 *   · 「暂停观看」/「先不看」立刻停抓帧、停解说，只留窗口信息，暂停态不截屏，
 *     只有明确的「继续观看」才恢复；暂停时长不占两小时额度；
 *   · 重启桥后状态归零，不会偷偷恢复截屏。
 *
 * 夜间静默：观赛发言走自己的定时器和 deliver()，不经过 proactiveTurn /
 * fireAppointment 的静默闸门，所以 02:00–07:00 也能陪看（bypassQuietHours）。
 * 关掉观赛，两条鱼立刻回到原来的静默规则。
 */
import { createScreenCapture, fpDistance, fpMean } from './screen-capture.mjs';

/** 只认明确的命令式短语。「准备看比赛」「你看比赛的时候」不算开启，避免闲聊误触。 */
export const START_WORDS = Object.freeze([
  '一起看比赛', '陪我看比赛', '一起看球', '陪我看球',
  '一起看直播', '陪我看直播',
  '开观赛', '开启观赛', '开始观赛', '打开观赛',
  '看屏幕', '看看屏幕', '看下屏幕', '看一下屏幕', '能看到屏幕',
]);
export const STOP_WORDS = Object.freeze([
  '不看了', '别看了', '不用看了', '不看屏幕', '别看屏幕',
  '关观赛', '关闭观赛', '结束观赛', '停止观赛', '退出观赛',
  '看完了', '比赛看完了',
]);
/** 暂停：停抓帧、停解说，但记住锁定的窗口，说一声就能接着看，不用重新切窗口。 */
export const PAUSE_WORDS = Object.freeze([
  '暂停观看', '暂停观赛', '暂停看', '暂停一下', '暂停解说', '先暂停',
  '先不看', '先别看', '先停一下', '先停',
  '等会儿再看', '待会儿再看', '待会再看', '一会再看', '一会儿再看',
  '歇会儿', '歇一会', '歇一下',
]);
export const RESUME_WORDS = Object.freeze([
  '继续观看', '继续观赛', '继续看', '继续解说', '接着看', '恢复观赛', '开回来',
]);
export const STATUS_WORDS = Object.freeze([
  '观赛状态', '在看屏幕吗', '还看着吗', '在看比赛吗', '观赛开了吗',
]);

export function parseWatchCommand(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  // 顺序有讲究：「不看了」是彻底结束，优先于「先不看」这类暂停；
  // 暂停 / 继续类词要排在 start 前面，免得含糊的半句话被当成重新开启。
  if (STOP_WORDS.some((w) => s.includes(w))) return 'stop';
  if (RESUME_WORDS.some((w) => s.includes(w))) return 'resume';
  if (PAUSE_WORDS.some((w) => s.includes(w))) return 'pause';
  if (STATUS_WORDS.some((w) => s.includes(w))) return 'status';
  if (START_WORDS.some((w) => s.includes(w))) return 'start';
  return null;
}

/** 前台窗口能不能当「比赛窗口」：够大、有标题、不是聊天窗 / 终端。 */
export function windowVerdict(info, cfg = {}) {
  if (!info || typeof info !== 'object') return { ok: false, reason: '没有前台窗口' };
  const title = String(info.title ?? '').trim();
  const proc = String(info.process ?? '').toLowerCase();
  const w = Number(info.w ?? 0);
  const h = Number(info.h ?? 0);
  if (!title) return { ok: false, reason: '窗口没有标题' };
  if (w < Number(cfg.minWindowWidth ?? 320) || h < Number(cfg.minWindowHeight ?? 240)) {
    return { ok: false, reason: `窗口太小（${w}×${h}）` };
  }
  const denyTitles = Array.isArray(cfg.denyWindowTitles) ? cfg.denyWindowTitles : [];
  if (denyTitles.some((x) => title.includes(String(x)))) {
    return { ok: false, reason: `标题命中排除名单（${title.slice(0, 30)}）` };
  }
  const denyProcs = (Array.isArray(cfg.denyProcesses) ? cfg.denyProcesses : []).map((x) => String(x).toLowerCase());
  if (proc && denyProcs.some((d) => proc === d || proc.startsWith(`${d}.`))) {
    return { ok: false, reason: `进程命中排除名单（${proc}）` };
  }
  return { ok: true, reason: '' };
}

/** 这一帧值不值得送模型：黑屏 / 白屏 / 和上一帧几乎一样都直接丢。 */
export function frameVerdict(prevFp, fp, cfg = {}) {
  const mean = fpMean(fp);
  if (mean < 0) return { verdict: 'invalid', mean: -1, delta: -1 };
  if (mean < Number(cfg.blackMeanBelow ?? 10) || mean > Number(cfg.whiteMeanAbove ?? 246)) {
    return { verdict: 'blank', mean, delta: -1 };
  }
  if (!prevFp) return { verdict: 'changed', mean, delta: 255 };
  const delta = fpDistance(prevFp, fp);
  return {
    verdict: delta >= Number(cfg.changeThreshold ?? 10) ? 'changed' : 'static',
    mean,
    delta,
  };
}

/** 频率闸门：两句话之间至少隔一会儿，一小时有硬上限。 */
export function speakGate(speakTimes, lastSpeakAt, now, cfg = {}) {
  const minGap = Number(cfg.minSpeakIntervalMs ?? 90000);
  if (now - lastSpeakAt < minGap) return { allow: false, reason: '距上一句太近' };
  const windowMs = 3600000;
  const recent = (Array.isArray(speakTimes) ? speakTimes : []).filter((t) => now - t < windowMs);
  const cap = Math.max(1, Math.floor(Number(cfg.maxSpeakPerHour ?? 30)));
  if (recent.length >= cap) return { allow: false, reason: `一小时内已说 ${recent.length} 句（上限 ${cap}）`, recent };
  return { allow: true, reason: '', recent };
}

const DEFAULT_PRIVATE_PROMPT =
  '【私聊｜只有你和哥哥两个人｜这句会发回私聊】\n' +
  '（旁白：这是刚刚从哥哥屏幕上截到的一帧比赛画面，图就在下面，你自己能看见。哥哥这会儿没说话，是你看着画面想说的一句。' +
  '只说你在这帧里真正看见的东西：场上动作、比分牌、特写、镜头变化，一两句，短，像看球时随口一说。' +
  '看不清就说看不清，绝对不要编比分、队名、球员名，也不要说「我看到了图片」「收到截图」这类话。' +
  '别问「在吗」，别催他回，别把群里的事、泡泡说过的话带进来。' +
  '如果这一帧实在没什么值得说的，只回 [skip]，桥就不会发消息。）';

const DEFAULT_GROUP_PROMPT =
  '【三人群 {gid}｜看下面的 QQ 号认说话人｜这句会发回这个群】\n' +
  '（旁白：这是刚刚从屏幕上截到的一帧比赛画面，图就在下面，你自己能看见。群里这会儿没人说话，是你看着画面想在群里说的一句。' +
  '只说你在这帧里真正看见的东西，一两句，短，像看球时顺口发的一句。' +
  '看不清就说看不清，绝对不要编比分、队名、球员名，也不要说「我看到了图片」。' +
  '别开新话题，别问「在吗」，别把私聊里的事、称呼和亲昵话带进群。' +
  '如果这一帧实在没什么值得说的，只回 [skip]。）';

/**
 * @param {object} deps
 * @param {object} deps.cfg          config.json 的 watchMode 段
 * @param {boolean} deps.enabled     总开关
 * @param {(msg:string)=>void} deps.log
 * @param {(prompt:string, attachment:object)=>Promise<{text:string,image?:string}>} deps.ask
 * @param {(target:object, reply:object)=>Promise<number>} deps.send
 * @param {(target:object)=>void} deps.onSpoke  让桥把常规主动续话往后推
 * @param {()=>boolean} deps.quietActive
 * @param {()=>number} deps.now
 * @param {()=>string} deps.quietLabel
 */
export function createWatchMode(deps) {
  const {
    cfg = {}, enabled = true, log = () => {}, ask, send, onSpoke = () => {},
    quietActive = () => false, now = () => Date.now(), quietLabel = () => '',
    capture: injectedCapture,
  } = deps;
  // 允许离线自测注入假采集层，不碰真实屏幕。
  const capture = injectedCapture ?? createScreenCapture(cfg, log);

  const frameIntervalMs = Math.max(5000, Number(cfg.frameIntervalMs ?? 60000));
  const autoStopMs = Math.max(60000, Number(cfg.autoStopMs ?? 7200000));
  const lockTimeoutMs = Math.max(3000, Number(cfg.lockTimeoutMs ?? 12000));
  const lockPollMs = Math.max(500, Number(cfg.lockPollMs ?? 2000));
  const bypassQuiet = cfg.bypassQuietHours !== false;

  let phase = 'off';                 // off | arming | active | paused
  let target = null;
  let lockedWindow = null;           // { hwnd, title, process }
  let frameTimer = null;
  let lockTimer = null;
  let pauseTimer = null;
  let busy = false;
  let lastFp = null;
  let lastSpeakAt = 0;
  let speakTimes = [];
  let startedAt = 0;
  let pausedAt = 0;
  let lockDeadline = 0;
  let frames = 0, skipped = 0, speaks = 0;
  let lastSkipReason = '';

  const isGroup = () => target?.type === 'group';
  const shortTitle = () => String(lockedWindow?.title ?? '').slice(0, 40);

  async function say(text) {
    if (!target) return;
    try {
      await send(target, { text, image: '' });
    } catch (e) {
      log(`观赛：提示没发出去（${e instanceof Error ? e.message : String(e)}）`);
    }
  }

  function clearTimers() {
    if (frameTimer) clearInterval(frameTimer);
    if (lockTimer) clearInterval(lockTimer);
    if (pauseTimer) clearTimeout(pauseTimer);
    frameTimer = null;
    lockTimer = null;
    pauseTimer = null;
  }

  function reset() {
    clearTimers();
    phase = 'off';
    target = null;
    lockedWindow = null;
    busy = false;
    lastFp = null;
    lastSpeakAt = 0;
    speakTimes = [];
    startedAt = 0;
    pausedAt = 0;
    lockDeadline = 0;
    frames = 0;
    skipped = 0;
    speaks = 0;
    lastSkipReason = '';
  }

  async function stop(reason, notify = true) {
    if (phase === 'off') return;
    const t = target;
    log(`观赛结束：${reason}（共抓 ${frames} 帧 / 说 ${speaks} 句 / 跳过 ${skipped} 帧）`);
    reset();
    if (notify && t) {
      try { await send(t, { text: '好，那我不看啦。', image: '' }); } catch { /* ignore */ }
    }
  }

  /**
   * 暂停 ≠ 结束：立刻停定时器、不再抓帧也不再说话，但记住锁定的窗口和统计。
   * 恢复时不用再切一次窗口；暂停时长也不算进两小时自动结束的额度。
   * 暂停态本身不截屏，只有明确的「继续观看」才会恢复。
   */
  async function pause(reason, notify = true) {
    if (phase !== 'active') return false;
    clearTimers();
    phase = 'paused';
    pausedAt = now();
    log(`观赛暂停：${reason}（窗口「${shortTitle()}」仍记着，已抓 ${frames} 帧 / 说 ${speaks} 句）`);
    pauseTimer = setTimeout(() => {
      if (phase === 'paused') void stop('暂停太久，自动结束');
    }, autoStopMs);
    pauseTimer.unref?.();
    if (notify) await say('好，我先不看了。想接着就说「继续观看」，不用重新切窗口。');
    return true;
  }

  async function resume(notify = true) {
    if (phase !== 'paused') return false;
    const pausedMs = Math.max(0, now() - pausedAt);
    startedAt += pausedMs;
    pausedAt = 0;
    if (pauseTimer) clearTimeout(pauseTimer);
    pauseTimer = null;
    phase = 'active';
    frameTimer = setInterval(() => void tick(), frameIntervalMs);
    frameTimer.unref?.();
    log(`观赛：继续观看（暂停 ${Math.round(pausedMs / 60000)} 分钟，窗口「${shortTitle()}」）`);
    if (notify) await say('好，接着看～');
    return true;
  }

  async function pollLock() {
    if (phase !== 'arming' || busy) return;
    if (now() >= lockDeadline) {
      const why = lastSkipReason ? `（${lastSkipReason}）` : '';
      reset();
      await say(`没等到比赛窗口${why}。切好之后再说一声「一起看比赛」就行。`);
      log('观赛：锁定窗口超时，回到关闭状态');
      return;
    }
    busy = true;
    let justLocked = false;
    try {
      const r = await capture.probe();
      if (phase !== 'arming') return;
      if (!r.ok) {
        lastSkipReason = String(r.reason ?? '取不到前台窗口');
        return;
      }
      const verdict = windowVerdict(r.window, cfg);
      if (!verdict.ok) {
        lastSkipReason = verdict.reason;
        return;
      }
      const info = r.window;
      lockedWindow = { hwnd: Number(info.hwnd), title: String(info.title ?? ''), process: String(info.process ?? '') };
      phase = 'active';
      justLocked = true;
      startedAt = now();
      clearTimers();
      frameTimer = setInterval(() => void tick(), frameIntervalMs);
      frameTimer.unref?.();
      log(`观赛：已锁定「${lockedWindow.title}」（${lockedWindow.process}, hwnd=${lockedWindow.hwnd}），每 ${Math.round(frameIntervalMs / 1000)} 秒看一帧`);
      await say(`看到了，是「${shortTitle()}」。我陪你看，有动静就说一句。`);
    } finally {
      busy = false;
      // busy 归位之后再抓首帧：以前放在 try 里会被 tick() 开头的 busy 守卫挡掉，
      // 结果「立刻看一眼」变成要等满一个 frameInterval（60 秒）才有第一句。
      if (justLocked) void tick();
    }
  }

  function buildPrompt() {
    const tpl = isGroup()
      ? (cfg.prompt?.group ?? DEFAULT_GROUP_PROMPT)
      : (cfg.prompt?.private ?? DEFAULT_PRIVATE_PROMPT);
    return String(tpl).replaceAll('{gid}', String(target?.id ?? ''));
  }

  async function tick() {
    if (phase !== 'active' || busy) return;
    if (now() - startedAt > autoStopMs) {
      await stop('两小时后自动结束');
      await say('看了两个钟头啦，我先歇会儿，想继续就再喊我一声。');
      return;
    }
    busy = true;
    try {
      const r = await capture.capture(lockedWindow?.hwnd);
      if (phase !== 'active') return;
      frames += 1;
      if (!r.ok) {
        skipped += 1;
        if (r.reason === 'window-gone') {
          await stop('比赛窗口关了');
          return;
        }
        if (r.reason !== lastSkipReason) {
          log(`观赛：这一帧跳过（${r.reason}${r.detail ? `：${String(r.detail).slice(0, 80)}` : ''}）`);
          lastSkipReason = r.reason;
        }
        return;
      }
      if (frames === 1) {
        log(`观赛：首帧采集成功（${r.w}×${r.h}，${Math.round(Number(r.bytes ?? 0) / 1024)} KB，质量 ${r.quality}，亮度 ${r.mean}）`);
      }
      const verdict = frameVerdict(lastFp, r.fp, cfg);
      lastFp = r.fp;
      if (verdict.verdict !== 'changed') {
        skipped += 1;
        return;
      }
      // 静默豁免只作用于观赛发言；关掉观赛，静默规则原样恢复。
      if (!bypassQuiet && quietActive()) {
        skipped += 1;
        return;
      }
      const t = now();
      const gate = speakGate(speakTimes, lastSpeakAt, t, cfg);
      if (!gate.allow) {
        skipped += 1;
        return;
      }
      speakTimes = gate.recent;
      const data = String(r.jpeg ?? '');
      if (!data || data.length > 900000) {
        log(`观赛：帧大小不合格（base64 ${data.length} 字符），跳过`);
        skipped += 1;
        return;
      }
      const reply = await ask(buildPrompt(), { mediaType: r.mediaType || 'image/jpeg', data });
      const said = String(reply?.text ?? '').trim();
      if (!said || said.includes('[skip]') || /^\s*[。.、…]+\s*$/.test(said)) {
        skipped += 1;
        return;
      }
      const sent = await send(target, { text: said, image: reply?.image ?? '' });
      if (sent > 0) {
        lastSpeakAt = t;
        speakTimes.push(t);
        speaks += 1;
        try { onSpoke(target); } catch { /* ignore */ }
        log(`观赛：第 ${frames} 帧有变化（Δ${verdict.delta.toFixed(1)}）→ 说了一句：${said.slice(0, 60)}`);
      }
    } catch (e) {
      log(`观赛：这一帧出错，已跳过（${e instanceof Error ? e.message : String(e)}）`);
      skipped += 1;
    } finally {
      busy = false;
    }
  }

  /** 返回 {handled}：true 表示这条消息是观赛口令，桥不要再当普通聊天处理。 */
  async function onUserLine(text, incomingTarget, group, atSelf) {
    if (!enabled) return { handled: false };
    const cmd = parseWatchCommand(text);
    if (!cmd) return { handled: false };
    // 群里没点名她，不响应口令：泡泡说「一起看比赛」不该把溪颜的观赛打开。
    if (group && !atSelf && cmd !== 'status') return { handled: false };
    if (cmd === 'stop' && phase === 'off') return { handled: false };
    // 没在看的时候，「先不看」「继续观看」只是普通闲聊，交回桌宠正常回一句。
    if ((cmd === 'pause' || cmd === 'resume') && phase === 'off') return { handled: false };

    if (cmd === 'status') {
      if (!target) target = { type: incomingTarget?.type ?? 'private', id: incomingTarget?.id };
      await say(statusText());
      return { handled: true };
    }
    if (cmd === 'stop') {
      await stop('哥哥说不看了');
      return { handled: true };
    }
    if (cmd === 'pause') {
      if (phase === 'arming') {
        await stop('哥哥说先不看了');
        return { handled: true };
      }
      if (phase === 'paused') {
        await say('已经暂停着呢，说「继续观看」我就接着看。');
        return { handled: true };
      }
      await pause('哥哥说先不看');
      return { handled: true };
    }
    if (cmd === 'resume') {
      if (phase === 'paused') await resume();
      else if (phase === 'arming') await say('还在等你把比赛窗口切到前面呢～');
      else await say('本来就看着呢～');
      return { handled: true };
    }
    // start：暂停中再说一次「一起看比赛」就是接着看，不必另记口令。
    if (phase === 'paused') {
      await resume();
      return { handled: true };
    }
    if (phase !== 'off') {
      if (!target) target = { type: incomingTarget?.type ?? 'private', id: incomingTarget?.id };
      await say(phase === 'arming'
        ? '还在等你把比赛窗口切到前面呢，别急～'
        : `已经在看着「${shortTitle()}」啦。`);
      return { handled: true };
    }
    target = { type: incomingTarget?.type ?? 'private', id: incomingTarget?.id };
    phase = 'arming';
    lockDeadline = now() + lockTimeoutMs;
    lastSkipReason = '';
    clearTimers();
    lockTimer = setInterval(() => void pollLock(), lockPollMs);
    lockTimer.unref?.();
    log(`观赛：收到开启口令，等待 ${Math.round(lockTimeoutMs / 1000)} 秒锁定前台窗口`);
    await say('好呀～ 你把比赛窗口切到最前面，我数到十就盯住那儿看。');
    void pollLock();
    return { handled: true };
  }

  function statusText() {
    if (phase === 'off') return '现在没在看屏幕。说「一起看比赛」我就开始。';
    if (phase === 'arming') return '正在等你把比赛窗口切到前面呢～';
    if (phase === 'paused') {
      const mins = Math.max(0, Math.round((pausedAt - startedAt) / 60000));
      return `观赛暂停中（看的是「${shortTitle()}」，之前看了 ${mins} 分钟、说 ${speaks} 句）。说「继续观看」接着看，说「不看了」就结束。`;
    }
    const mins = Math.max(0, Math.round((now() - startedAt) / 60000));
    const quiet = quietActive() ? `${quietLabel()} 当前静默期内，观赛临时豁免` : '不在夜间静默';
    return `正在看「${shortTitle()}」，开了 ${mins} 分钟，抓了 ${frames} 帧，说了 ${speaks} 句。${quiet}。说「不看了」就停。`;
  }

  /**
   * 启动时只取一次前台窗口元数据，确认 PowerShell / Win32 采集层能编译。
   * 不截图、不把窗口标题写进日志，纯健康检查。
   */
  async function probeHealth() {
    try {
      const r = await capture.probe();
      if (!r.ok) return { ok: false, reason: String(r.reason ?? 'unknown') };
      const v = windowVerdict(r.window, cfg);
      return { ok: true, reason: v.ok ? '采集层可用' : '当前前台窗口暂不符合锁定条件，等口令时再锁定' };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  function summary() {
    const base = `观赛模式：${enabled ? '开启' : '关闭'}（口令「一起看比赛」/「不看了」；每 ${Math.round(frameIntervalMs / 1000)} 秒一帧，画面几乎不变就跳过；最多 ${Math.round(autoStopMs / 60000)} 分钟自动停）`;
    const quiet = bypassQuiet ? `；${quietLabel()} 观赛期间临时豁免静默` : '；遵守夜间静默';
    return base + quiet + (phase === 'off' ? '' : `；当前 ${statusText()}`);
  }

  return {
    onUserLine, stop, pause, resume, statusText, summary, probeHealth,
    active: () => phase !== 'off', phase: () => phase,
  };
}
