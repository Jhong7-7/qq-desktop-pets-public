#!/usr/bin/env node
/**
 * douyin-mode.test.mjs —— douyin-mode.mjs 离线自测（mock 浏览器 + mock /chat）。
 * 不连真实抖音、不用真实账号、不碰 .secret。运行：node douyin-mode.test.mjs
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDouyinCommand, parseDouyinReply, sanitizeContent, rateGate, coWatchGate,
  createDouyinMode, DEFAULT_BROWSE_PROMPT, COWATCH_PROMPT_ADDON,
} from './douyin-mode.mjs';

let pass = 0, fail = 0;
function t(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? `：${detail}` : ''}`); }
}

// ── 纯函数 ────────────────────────────────────────────────────────────
console.log('== 口令解析 ==');
t('开抖音', parseDouyinCommand('开抖音')?.kind === 'start');
t('刷抖音', parseDouyinCommand('帮我刷抖音')?.kind === 'start');
t('停抖音', parseDouyinCommand('停抖音')?.kind === 'stop');
t('抖音状态', parseDouyinCommand('抖音状态')?.kind === 'status');
t('抖音待审', parseDouyinCommand('抖音待审')?.kind === 'pending');
t('抖音同意 3', parseDouyinCommand('抖音同意 3')?.kind === 'approve' && parseDouyinCommand('抖音同意 3').id === 3);
t('抖音拒绝 5', parseDouyinCommand('抖音拒绝 5')?.kind === 'reject');
t('普通聊天不命中', parseDouyinCommand('今天天气不错') === null);
t('共看', parseDouyinCommand('共看')?.kind === 'cowatch-on');
t('不共看了（不能被「共看」抢先匹配）', parseDouyinCommand('不共看了')?.kind === 'cowatch-off');
t('你在看啥', parseDouyinCommand('你在看啥')?.kind === 'what-now');
t('抖音抬窗', parseDouyinCommand('抖音抬窗')?.kind === 'raise');
t('抖音收窗', parseDouyinCommand('抖音收窗')?.kind === 'park');
t('下一条', parseDouyinCommand('下一条')?.kind === 'next');

console.log('== 标记解析 ==');
{
  const r = parseDouyinReply('这个猫猫也太可爱了吧哈哈哈\n[赞]\n[评:我也想养一只]\n[发:今日份快乐源泉get]');
  t('保留聊天正文', r.talk.includes('猫猫'));
  t('[赞]', r.like === true);
  t('[评:]', r.comments.includes('我也想养一只'));
  t('[发:]', r.posts.includes('今日份快乐源泉get'));
  t('无 skip', r.skip === false);
}
{
  const r = parseDouyinReply('【私聊｜只有你和哥哥两个人】没啥好说的\n[skip]');
  t('[skip]', r.skip === true);
  t('旁白头被剥掉', !r.talk.includes('【私聊'));
  // [skip] 只表示不互动；她写的正文仍要保留，由 handleParsed 依据 skip 不发言。
  t('剩余正文保留', r.talk.trim() === '没啥好说的');
}
t('全角括号标记', parseDouyinReply('【赞】【评：不错】').like && parseDouyinReply('【评：不错】').comments.includes('不错'));
{
  const r = parseDouyinReply('快来看这个\n[评@:这个得给你看]');
  t('[评@:] 仍进 comments（向后兼容）', r.comments.includes('这个得给你看'));
  t('[评@:] 标进 mentionComments', r.mentionComments.includes('这个得给你看'));
  t('普通评论不算 @', parseDouyinReply('[评:普通]').mentionComments.length === 0);
}

console.log('== 敏感过滤 ==');
t('空内容拒绝', sanitizeContent('  ').ok === false);
t('敏感词拒绝', sanitizeContent('支持台独abc').ok === false);
t('手机号拒绝', sanitizeContent('加我 30030').ok === false);
t('身份证拒绝', sanitizeContent('11010119900101123X').ok === false);
t('正常内容通过', sanitizeContent('这个运镜好丝滑').ok === true);
t('超长拒绝', sanitizeContent('啊'.repeat(200)).ok === false);

console.log('== 频率上限 ==');
{
  const now = 1000000;
  const cfg = { maxCommentsPerHour: 2, maxPostsPerDay: 1, maxInteractionsPerSession: 4 };
  let c = { commentTimes: [], postTimes: [], interactions: 0 };
  // rateGate 是纯函数：每次放行后由调用方回填计数（每种互动都占 1 次会话互动），
  // 并记下对应时间点，闸门才知道已经用过几次。
  const commit = (kind) => {
    if (kind === 'comment') c.commentTimes.push(now);
    else if (kind === 'post') c.postTimes.push(now);
    c.interactions += 1;
  };
  let g = rateGate(c, 'comment', now, cfg); c = g.counters;
  t('第1条评论放行', g.allow);
  if (g.allow) commit('comment');
  g = rateGate(c, 'comment', now, cfg); c = g.counters;
  t('第2条评论放行', g.allow);
  if (g.allow) commit('comment');
  g = rateGate(c, 'comment', now, cfg);
  t('第3条评论拦截', !g.allow && g.reason.includes('评论'));
  g = rateGate(c, 'post', now, cfg); c = g.counters;
  t('第1条动态放行', g.allow);
  if (g.allow) commit('post');
  g = rateGate(c, 'post', now, cfg);
  t('第2条动态拦截', !g.allow && g.reason.includes('动态'));
  g = rateGate(c, 'like', now, cfg); c = g.counters;
  t('点赞放行但占互动数', g.allow);
  if (g.allow) commit('like');
  g = rateGate(c, 'comment', now, cfg);
  t('会话互动总数拦截', !g.allow && g.reason.includes('上限'));
  g = rateGate({ commentTimes: [now - 7200000], postTimes: [], interactions: 0 }, 'comment', now, cfg);
  t('一小时前的评论不计数', g.allow);
}

console.log('== 共看闸门 ==');
{
  const cfg = { enabled: true, coWatchIntervalMs: 20000, coWatchMaxPerHour: 2 };
  t('首次共看放行', coWatchGate([], 0, 1000000, cfg).allow);
  t('间隔没到拦下', !coWatchGate([], 1000000, 1000010, cfg).allow);
  t('间隔到了放行', coWatchGate([1000000], 1000000, 1020001, cfg).allow);
  t('每小时上限拦下', !coWatchGate([1000000, 1000010], 1000010, 1020001, cfg).allow);
  t('关共看全拦下', !coWatchGate([], 0, 1000000, { ...cfg, enabled: false }).allow);
  t('一小时的旧记录不计数', coWatchGate([1000000 - 3600000], 1000000 - 3600000, 1000021, cfg).allow);
}

// ── 状态机（mock 浏览器 + mock ask）───────────────────────────────────
console.log('== 状态机（mock）==');
// 每个用例一个独立目录：待审清单/审计日志互不污染（之前共用一个文件会串味）。
const allTmp = [];
function caseDir() {
  const d = mkdtempSync(join(tmpdir(), 'douyin-test-'));
  allTmp.push(d);
  return d;
}

function makeMockBrowser(state = {}) {
  return {
    ok: true,
    opened: 0, likes: 0, comments: [], posts: [], closed: 0,
    captures: 0, focusCalls: [], commentArgs: [],
    loggedIn: true,
    async open() { this.opened += 1; return { ok: true, needLogin: state.needLogin ?? false }; },
    async isLoggedIn() { return this.loggedIn; },
    async next() {},
    async capture() {
      this.captures += 1;
      return { ok: true, jpeg: 'bW9ja2pwZWc=', text: 'mock 文案：一只橘猫在打键盘', shotPath: '/fake/shot.jpg', kept: 3 };
    },
    async focus(on) { this.focusCalls.push(Boolean(on)); return { ok: true }; },
    windowOnScreen: () => false,
    async like() { this.likes += 1; return { ok: true }; },
    async comment(x, mention) { this.commentArgs.push({ text: x, mention: Boolean(mention) }); this.comments.push(x); return { ok: true, mention: Boolean(mention) }; },
    async post(x) { this.posts.push(x); return { ok: true }; },
    async close() { this.closed += 1; },
  };
}

const baseDeps = (browser, overrides = {}) => {
  const tmp = overrides.tmp ?? caseDir();
  return {
    cfg: {
      intervalMs: 999000, jitterMs: 0, autoStopMs: 3600000,
      statePath: join(tmp, 'state.json'),
      pendingFile: join(tmp, 'pending.json'),
      auditFile: join(tmp, 'audit.log'),
      maxCommentsPerHour: 5, maxPostsPerDay: 2, maxInteractionsPerSession: 20,
      coWatch: false, // 测试隔离：现有用例走老节奏，新用例显式开共看
      ...overrides.cfg,
    },
    enabled: true,
    log: () => {},
    ask: overrides.ask ?? (async () => ({ text: '' })),
    send: overrides.send ?? (async () => 1),
    onSpoke: () => {},
    watchActive: () => false,
    quietActive: () => false,
    now: () => Date.now(),
    here: tmp,
    browserFactory: async () => browser,
    ...overrides.deps,
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 轮询等待条件成立，最多 maxMs；比固定 sleep 稳，不会因机器慢而误判。 */
async function waitFor(fn, maxMs = 8000, step = 150) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

// a) enabled=false：口令全不响应
{
  const b = makeMockBrowser();
  const d = createDouyinMode(baseDeps(b, { deps: { enabled: false } }));
  const r = await d.onUserLine('开抖音', { type: 'private', id: 10001 }, false, false);
  t('enabled=false 口令不响应', r.handled === false && b.opened === 0);
}

// a) 口令开关 + c) 人审
{
  const b = makeMockBrowser();
  const sent = [];
  const deps = baseDeps(b, {
    ask: async () => ({ text: '这猫绝了\n[评:我也想养一只]' }),
    send: async (tg, reply) => { sent.push(reply.text); return 1; },
  });
  const d = createDouyinMode(deps);
  const tgt = { type: 'private', id: 10001 };
  let r = await d.onUserLine('开抖音', tgt, false, false);
  t('开抖音 → handled', r.handled === true);
  await waitFor(() => d.pendingSnapshot().length > 0, 8000); // 等首条 tick（3 秒）跑完
  t('mock 浏览器被打开', b.opened === 1);
  t('评论进待审、没真提交', b.comments.length === 0 && d.pendingSnapshot().some((x) => x.kind === 'comment' && x.content === '我也想养一只'));
  t('待审文件落盘', readFileSync(deps.cfg.pendingFile, 'utf8').includes('我也想养一只'));

  r = await d.onUserLine('抖音状态', tgt, false, false);
  t('抖音状态 → 在刷', r.handled === true && sent.some((s) => s.includes('正在刷抖音')));

  r = await d.onUserLine('抖音同意 1', tgt, false, false);
  t('人审通过才真提交', b.comments.length === 1 && b.comments[0] === '我也想养一只');
  t('待审清空', d.pendingSnapshot().length === 0);

  // 群里没点名 → 不响应
  r = await d.onUserLine('抖音同意 99', tgt, true, false);
  t('群聊没@不响应口令', r.handled === false);

  r = await d.onUserLine('停抖音', tgt, false, false);
  t('停抖音 → 关闭', r.handled === true && d.phase() === 'off' && b.closed === 1);
}

// c) 人审拒绝路径
{
  const b = makeMockBrowser();
  const sent = [];
  const d = createDouyinMode(baseDeps(b, {
    ask: async () => ({ text: '想去看看\n[发:今天也在努力摸鱼]' }),
    send: async (tg, reply) => { sent.push(reply.text); return 1; },
  }));
  const tgt = { type: 'private', id: 10001 };
  await d.onUserLine('开抖音', tgt, false, false);
  await waitFor(() => d.pendingSnapshot().some((x) => x.kind === 'post'), 8000);
  t('动态进待审', b.posts.length === 0 && d.pendingSnapshot().some((x) => x.kind === 'post'));

  await d.onUserLine('抖音拒绝 1', tgt, false, false);
  t('拒绝后不提交', b.posts.length === 0 && d.pendingSnapshot().length === 0);
  await d.onUserLine('停抖音', tgt, false, false);
}

// e) 登录态失效：下一轮 tick 检测到 → 明确提示，不静默
{
  const b = makeMockBrowser();
  const sent = [];
  // 间隔用模块下限 15000，才等得起第二轮 tick（999000ms 那种设置 16 秒根本等不到）。
  const d = createDouyinMode(baseDeps(b, {
    cfg: { intervalMs: 15000 },
    ask: async () => ({ text: '随便看看' }),
    send: async (tg, reply) => { sent.push(reply.text); return 1; },
  }));
  const tgt = { type: 'private', id: 10001 };
  await d.onUserLine('开抖音', tgt, false, false);
  await waitFor(() => d.phase() === 'active', 8000); // 首条 tick（3 秒）后进入 active
  b.loggedIn = false;
  await waitFor(() => d.phase() === 'off', 22000);   // 下一轮 tick（15 秒）检测到失效
  t('登录过期 → 停止并明确提示', d.phase() === 'off' && sent.some((s) => s.includes('抖音登录过期，需要重新扫码')));
  await d.onUserLine('抖音状态', tgt, false, false);
  t('状态里提示重新扫码', sent.filter((s) => s.includes('重新扫码') || s.includes('登录过期')).length >= 2);
}

// d) 频率上限在状态机里生效（入队也占额度）
{
  const b = makeMockBrowser();
  let n = 0;
  const deps = baseDeps(b, {
    cfg: { intervalMs: 15000, maxCommentsPerHour: 1 },
    ask: async () => ({ text: `[评:第${++n}条评论]` }),
  });
  const d = createDouyinMode(deps);
  const tgt = { type: 'private', id: 10001 };
  await d.onUserLine('开抖音', tgt, false, false);
  await waitFor(() => d.pendingSnapshot().length > 0, 8000); // 首条 tick → 待审 #1
  const snap1 = d.pendingSnapshot().length;
  await sleep(16000);         // 下一轮 tick（15 秒）→ 应被小时上限拦下
  const snap2 = d.pendingSnapshot().length;
  t('每小时评论上限生效（第2条不再进待审）', snap1 === 1 && snap2 === 1);
  await d.onUserLine('停抖音', tgt, false, false);
}

// 敏感词拦截在状态机里生效
{
  const b = makeMockBrowser();
  const deps = baseDeps(b, {
    ask: async () => ({ text: '嗯\n[评:支持台独的都该封号]' }),
  });
  const d = createDouyinMode(deps);
  await d.onUserLine('开抖音', { type: 'private', id: 10001 }, false, false);
  // 等审计日志出现 blocked，说明首条 tick 已经跑过闸门。
  await waitFor(() => existsSync(deps.cfg.auditFile) && readFileSync(deps.cfg.auditFile, 'utf8').includes('blocked'), 8000);
  t('敏感评论直接拦下、不进待审', b.comments.length === 0 && d.pendingSnapshot().length === 0);
  const audit = readFileSync(deps.cfg.auditFile, 'utf8');
  t('拦截写审计日志', audit.includes('blocked') && audit.includes('敏感'));
  t('审计不记登录态', !audit.toLowerCase().includes('sessionid') && !audit.includes('douyin-state'));
  await d.onUserLine('停抖音', { type: 'private', id: 10001 }, false, false);
}

// f) 共看播报：一条消息 = 分镜图 + 她一句话
{
  const b = makeMockBrowser();
  const sent = [];
  const deps = baseDeps(b, {
    cfg: { coWatch: true, coWatchIntervalMs: 15000 },
    ask: async () => ({ text: '一只猫在敲键盘' }),
    send: async (tg, reply) => { sent.push(reply); return 1; },
  });
  const d = createDouyinMode(deps);
  const tgt = { type: 'private', id: 10001 };
  await d.onUserLine('开抖音', tgt, false, false);
  // 「开抖音」自己也会发一条提示，不能拿 sent.length 当条件；等共看计数真正落下来。
  await waitFor(() => d.coWatchSnapshot().times.length > 0, 10000);
  const cwSent = sent.find((s) => s.text.includes('猫'));
  t('共看播报发出', Boolean(cwSent));
  t('共看播报带截图路径', cwSent?.shotFile === '/fake/shot.jpg');
  t('共看计数已记录', d.coWatchSnapshot().times.length === 1);
  await d.onUserLine('停抖音', tgt, false, false);
}

// g) 「你在看啥」立刻播报，绕开间隔
{
  const b = makeMockBrowser();
  const sent = [];
  const d = createDouyinMode(baseDeps(b, {
    ask: async () => ({ text: '这是现在的画面' }),
    send: async (tg, reply) => { sent.push(reply); return 1; },
  }));
  const tgt = { type: 'private', id: 10001 };
  await d.onUserLine('开抖音', tgt, false, false);
  await waitFor(() => b.captures > 0, 8000);
  const before = sent.length;
  await d.onUserLine('你在看啥', tgt, false, false);
  t('口令即时播报发出', sent.length > before && sent[sent.length - 1].text.includes('这是现在的画面'));
  t('即时播报带截图', sent[sent.length - 1]?.shotFile === '/fake/shot.jpg');
  await d.onUserLine('停抖音', tgt, false, false);
}

// h) 抬窗/收窗口令走 CDP focus
{
  const b = makeMockBrowser();
  const d = createDouyinMode(baseDeps(b));
  const tgt = { type: 'private', id: 10001 };
  await d.onUserLine('开抖音', tgt, false, false);
  await d.onUserLine('抖音抬窗', tgt, false, false);
  await d.onUserLine('抖音收窗', tgt, false, false);
  t('抬窗 focus(true)', b.focusCalls.includes(true));
  t('收窗 focus(false)', b.focusCalls.includes(false));
  await d.onUserLine('停抖音', tgt, false, false);
}

// i) 观赛开着不共看播报（互斥）
{
  const b = makeMockBrowser();
  const sent = [];
  const d = createDouyinMode(baseDeps(b, {
    cfg: { coWatch: true },
    ask: async () => ({ text: '猫猫' }),
    send: async (tg, reply) => { sent.push(reply); return 1; },
    deps: { watchActive: () => true },
  }));
  const tgt = { type: 'private', id: 10001 };
  await d.onUserLine('开抖音', tgt, false, false);
  await waitFor(() => b.captures > 0, 8000);
  await sleep(400);
  // 开抖音自己会发一条提示；只检查共看内容（她的话「猫猫」）没出现。
  t('观赛 active 时不播共看', !sent.some((s) => s.text.includes('猫猫')));
  await d.onUserLine('停抖音', tgt, false, false);
}

// j) [评@:内容] 进待审带标记，同意时把 mention 传给浏览器层
{
  const b = makeMockBrowser();
  const published = [];
  const deps = baseDeps(b, {
    ask: async () => ({ text: '快来看\n[评@:这个得给你看]' }),
    send: async (tg, reply) => { published.push(reply.text); return 1; },
  });
  const d = createDouyinMode(deps);
  const tgt = { type: 'private', id: 10001 };
  await d.onUserLine('开抖音', tgt, false, false);
  await waitFor(() => d.pendingSnapshot().length > 0, 8000);
  t('带@评论进待审且标注 mention', d.pendingSnapshot()[0].mention === true);
  await d.onUserLine('抖音待审', tgt, false, false);
  t('待审清单显示 [评@]', published.some((s) => s.includes('[评@]')));
  await d.onUserLine('抖音同意 1', tgt, false, false);
  t('同意时把 mention=true 传下去', b.commentArgs.some((a) => a.mention === true));
  await d.onUserLine('停抖音', tgt, false, false);
}

t('默认 prompt 存在且含标记说明', DEFAULT_BROWSE_PROMPT.includes('[评:') && DEFAULT_BROWSE_PROMPT.includes('[skip]'));
t('共看 prompt 追加段存在', COWATCH_PROMPT_ADDON.includes('共看时间'));

for (const d of allTmp) rmSync(d, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
