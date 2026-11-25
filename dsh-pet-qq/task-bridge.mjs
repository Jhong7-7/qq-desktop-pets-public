/**
 * task-bridge.mjs —— 方案①「文件队列 + 最小闭环」的纯逻辑部分。
 *
 * 目标：哥哥在 QQ 私聊发「任务：……」→ 桥短路拦截（不喂桌宠、不写记忆、不调模型）
 *      → 落成 tasks/inbox/<id>.json → WorkBuddy 会话侧消费 → 结果写 tasks/out/<id>.json
 *      → 回报通道把结果用溪颜口吻/固定文案发回 QQ。
 *
 * 本模块只做：口令解析、白名单判定、队列落盘/列举/认领/完成、文案模板。
 * 不碰网络、不碰桌宠、不碰桥的主循环；所有函数接受显式 now/root，便于离线确定性测试。
 * 真正的 WS 发送由 bridge.mjs 注入的 send，或由独立的回报脚本完成。
 *
 * 安全边界（全部在 config.task 里，默认全关）：
 *   enabled=false       总开关，false 时 onUserLine 永远不命中 → 正常聊天零影响
 *   allowedUsers        只认这些 QQ 号（默认只有哥哥）
 *   privateOnly=true    只认私聊，群聊里说口令完全无效
 *   prefix              明确前缀，避免误拦普通聊天
 *   maxChars            单条任务文本上限
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

export const DEFAULT_TASK_CONFIG = Object.freeze({
  enabled: false,
  privateOnly: true,
  allowedUsers: [10000],
  prefixes: ['任务：', '任务:', '帮我做：', '帮我做:'],
  maxChars: 4000,
  ack: '收到啦，我去办，办好了回你。',
  dir: 'tasks',
});

/** 只解析「任务：xxx」这类明确口令，返回 {hit,text,prefix}；不满足前缀返回 hit:false。 */
export function parseTaskCommand(text, cfg = {}) {
  const s = String(text ?? '');
  const prefixes = Array.isArray(cfg.prefixes) && cfg.prefixes.length
    ? cfg.prefixes : DEFAULT_TASK_CONFIG.prefixes;
  for (const p of prefixes) {
    if (!p) continue;
    if (s.startsWith(String(p))) {
      const body = s.slice(String(p).length).trim();
      if (body) return { hit: true, text: body, prefix: String(p) };
    }
  }
  return { hit: false, text: '', prefix: '' };
}

/** 判定一条入站消息是否该被任务通道短路。纯函数，不产生副作用。 */
export function taskGate(parsed, { isGroup, uid }, cfg = {}) {
  if (cfg.enabled !== true) return { allow: false, reason: '任务通道未启用' };
  if (cfg.privateOnly !== false && isGroup) return { allow: false, reason: '群聊不接任务' };
  const allow = Array.isArray(cfg.allowedUsers) && cfg.allowedUsers.length
    ? cfg.allowedUsers.map(Number).includes(Number(uid))
    : false;
  if (!allow) return { allow: false, reason: '非白名单用户' };
  if (!parsed?.hit) return { allow: false, reason: '不是任务口令' };
  const cap = Math.max(1, Number(cfg.maxChars) || DEFAULT_TASK_CONFIG.maxChars);
  const text = String(parsed.text).slice(0, cap);
  return { allow: true, text, reason: '' };
}

/**
 * 创建队列实例。root 为 tasks 目录的父目录（通常是桥目录）。
 * 目录结构：inbox/（待消费）、out/（已完成）、.claim/（消费中，防重复）。
 */
export function createTaskQueue({ root, cfg = {}, now = () => Date.now() } = {}) {
  if (!root) throw new Error('createTaskQueue 需要 root');
  const dir = cfg.dir && !isAbsolute(String(cfg.dir))
    ? join(root, String(cfg.dir))
    : (isAbsolute(String(cfg.dir || '')) ? String(cfg.dir) : join(root, 'tasks'));
  const inbox = join(dir, 'inbox');
  const out = join(dir, 'out');
  const claim = join(dir, '.claim');
  for (const d of [inbox, out, claim]) mkdirSync(d, { recursive: true });

  const safeId = (s) => String(s).replace(/[^0-9A-Za-z_-]/g, '').slice(0, 80);
  const taskFile = (id) => join(inbox, `${safeId(id)}.json`);
  const outFile = (id) => join(out, `${safeId(id)}.json`);
  const claimFile = (id) => join(claim, `${safeId(id)}.json`);

  /** 落一条新任务到 inbox。返回任务记录。 */
  function enqueue({ text, uid, prefix = '' }) {
    const id = `t-${now()}-${Math.random().toString(36).slice(2, 7)}`;
    const rec = {
      id,
      text: String(text ?? ''),
      from: Number(uid),
      prefix,
      ts: now(),
      status: 'pending',
    };
    writeFileSync(taskFile(id), JSON.stringify(rec, null, 2), 'utf8');
    return rec;
  }

  /** 列出 inbox 里所有待办任务（按 ts 升序）。 */
  function list() {
    if (!existsSync(inbox)) return [];
    return readdirSync(inbox)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(readFileSync(join(inbox, f), 'utf8')); } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  /** 认领任务：inbox → .claim，防并发重复消费。返回认领到的记录，找不到返回 null。 */
  function take(id) {
    const f = taskFile(id);
    if (!existsSync(f)) return null;
    const rec = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(claimFile(id), JSON.stringify({ ...rec, claimedAt: now() }, null, 2), 'utf8');
    renameSync(f, join(dir, 'inbox', `.${safeId(id)}.taken`));
    return rec;
  }

  /** 完成任务：写 out/<id>.json，并把 inbox 的占位标记删除。 */
  function finish(id, { result, status = 'done', by = 'workbuddy' } = {}) {
    const rec = existsSync(claimFile(id))
      ? JSON.parse(readFileSync(claimFile(id), 'utf8'))
      : { id, from: 0, text: '' };
    const outRec = {
      id,
      from: rec.from,
      task: rec.text,
      result: String(result ?? ''),
      status,
      by,
      ts: now(),
      notified: false,
    };
    writeFileSync(outFile(id), JSON.stringify(outRec, null, 2), 'utf8');
    const placeholder = join(inbox, `.${safeId(id)}.taken`);
    if (existsSync(placeholder)) renameSync(placeholder, join(claim, `.${safeId(id)}.done`));
    return outRec;
  }

  /** 列出 out 里尚未回报的结果。 */
  function pendingReports() {
    if (!existsSync(out)) return [];
    return readdirSync(out)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(readFileSync(join(out, f), 'utf8')); } catch { return null; }
      })
      .filter((r) => r && r.notified === false)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  /** 标记某结果已回报，避免重复打扰。 */
  function markNotified(id) {
    const f = outFile(id);
    if (!existsSync(f)) return false;
    const rec = JSON.parse(readFileSync(f, 'utf8'));
    rec.notified = true;
    rec.notifiedAt = now();
    writeFileSync(f, JSON.stringify(rec, null, 2), 'utf8');
    return true;
  }

  return {
    dir, inbox, out, claim,
    enqueue, list, take, finish, pendingReports, markNotified,
    outPath: outFile,
  };
}

/** 回报文案模板：任务结果发回 QQ 时套这层，保持溪颜口吻、不暴露内部机制。 */
export function reportText(outRec, cfg = {}) {
  const head = cfg.reportHead ?? '（忙完了）';
  const result = String(outRec?.result ?? '').trim();
  return `${head}${result}`;
}

/** 离线自测：口令解析 / 白名单 / 队列闭环，全部在临时目录，不碰真实队列。 */
export function taskSelfTest({ mkdtempSync, rmSync } = {}) {
  const results = [];
  const ok = (name, cond, extra = '') => results.push({ name, pass: !!cond, extra });
  const cfg = { ...DEFAULT_TASK_CONFIG, enabled: true };
  const p = (s) => parseTaskCommand(s, cfg);
  ok('认任务前缀', p('任务：查一下日志').hit && p('任务：查一下日志').text === '查一下日志');
  ok('认英文冒号前缀', p('任务:  foo').hit && p('任务:  foo').text === 'foo');
  ok('普通聊天不命中', !p('在吗').hit && !p('任务我一下').hit);
  ok('空任务不命中', !p('任务：').hit);
  ok('未启用不短路', !taskGate(p('任务：x'), { isGroup: false, uid: 10000 }, { ...cfg, enabled: false }).allow);
  ok('群聊不短路', !taskGate(p('任务：x'), { isGroup: true, uid: 10000 }, cfg).allow);
  ok('非白名单不短路', !taskGate(p('任务：x'), { isGroup: false, uid: 999 }, cfg).allow);
  ok('合法口令放行', taskGate(p('任务：x'), { isGroup: false, uid: 10000 }, cfg).allow);
  ok('超长截断', taskGate(p('任务：' + 'x'.repeat(5000)), { isGroup: false, uid: 10000 }, cfg).text.length === cfg.maxChars);

  if (mkdtempSync && rmSync) {
    const os = globalThis.process?.getBuiltinModule?.('node:os') ?? null;
    // 调用方负责传入 os.tmpdir 的父目录；这里直接用 mkdtempSync 带前缀
    const dir = mkdtempSync('taskbridge-test-');
    try {
      const q = createTaskQueue({ root: dir, cfg: { dir: 'tasks' }, now: () => 1700000000000 });
      const rec = q.enqueue({ text: '跑个自测', uid: 10000, prefix: '任务：' });
      ok('落队列', q.list().length === 1 && q.list()[0].id === rec.id);
      const taken = q.take(rec.id);
      ok('认领', taken && taken.text === '跑个自测' && q.list().length === 0);
      const done = q.finish(rec.id, { result: '8/8 通过' });
      ok('完成写 out', done.status === 'done' && existsSync(q.outPath(rec.id)));
      ok('待回报可见', q.pendingReports().length === 1);
      q.markNotified(rec.id);
      ok('标记已回报', q.pendingReports().length === 0);
      ok('回报文案', reportText(done).includes('8/8 通过'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return results;
}
