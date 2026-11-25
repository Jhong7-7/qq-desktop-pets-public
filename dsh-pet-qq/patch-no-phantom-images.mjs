#!/usr/bin/env node
/**
 * patch-no-phantom-images.mjs —— 给 dsh-pet 的配图清单补一句「这不是用户消息」的来源声明。
 *
 * 根因（2026-11-09 实测）：chat.ts 的 generateWith() 把 imageInstruction(pool) 直接拼在
 * userText 后面，作为**同一条 user 消息**发给模型。那段是一整张「- 名字：说明」的候选
 * 表情包目录（chatImageLimit=20），名字里还有「先养着吧」「厉害了我的鲸」这种像一句话的
 * 中文；再叠加 historyMarkersOf() 把历次 [图:名称] 回填进 assistant 历史，模型就分不清
 * 「系统给的候选图名」和「对方真的发来了图片 / 真的说了这句话」，于是凭空冒出
 * 「又冒出来一张图」「你发这个干嘛」「对上那张图」这类回应，甚至顺着图名接话。
 *
 * 本补丁只在清单最前面加一句来源声明，**不动任何逻辑**；配合 main-config.jsonc 人设里的
 * 【关于「图片」的误会】段一起用。宿主每轮 /chat 都会 readAllConfig() 重新读盘，所以
 * **人设改动即时生效、不需要重启**；本补丁改的是编译产物，要重开 DSH 才加载。
 *
 * 幂等：已打过补丁的文件跳过；首次改动前留 .bak-no-phantom-images 备份。
 * dsh-pet 升级后重新跑一次即可。
 *
 * 用法：
 *   node patch-no-phantom-images.mjs            # 打补丁
 *   node patch-no-phantom-images.mjs --check   # 只看状态，不改文件
 *   node patch-no-phantom-images.mjs --dir <dsh-pet 包目录>
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// 2026-11-11：桥现在会把 QQ 真图作为 /chat 的 attachment 一起交给模型。
// 旧文案里「这一轮他只有上面那一行文字」在有真图的轮次会自相矛盾，改成条件化表述。
const OLD_MARK = '【后台说明：下面这段是候选表情包目录，不是用户发来的消息，也不代表他发了图片；这一轮他只有上面那一行文字。清单里的名字只是图片文件名，不是谁说的话，别当成他说的去接。】';
const MARK = '【后台说明：下面这段是候选表情包目录，不是用户发来的消息，也不代表他发了图片；他说的话只有上面那段文字，如果他另外真发了图片，会作为单独的图片附件给你，跟下面这份目录无关。清单里的名字只是图片文件名，不是谁说的话，别当成他说的去接。】';
const FROM = '[配图] ';
const TO = FROM + MARK;

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const dirIdx = argv.indexOf('--dir');
const petDir = dirIdx >= 0 && argv[dirIdx + 1]
  ? resolve(argv[dirIdx + 1])
  : join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-pet');

const files = ['src/host/chat.ts', 'lib/index.js', 'lib/app.js', 'lib/standalone.js'];
let changed = 0;
let failed = 0;

for (const rel of files) {
  const file = join(petDir, rel);
  if (!existsSync(file)) {
    console.log(`跳过（文件不存在） ${rel}`);
    continue;
  }
  const src = readFileSync(file, 'utf8');
  if (src.includes(MARK)) {
    console.log(`已是新版      ${rel}`);
    continue;
  }
  // 旧版声明 → 升级成条件化表述（幂等，可反复跑）
  if (src.includes(OLD_MARK)) {
    if (checkOnly) {
      console.log(`待升级声明    ${rel}`);
      continue;
    }
    const bak = file + '.bak-no-phantom-images';
    if (!existsSync(bak)) copyFileSync(file, bak);
    writeFileSync(file, src.replace(OLD_MARK, MARK), 'utf8');
    changed++;
    console.log(`已升级声明    ${rel}`);
    continue;
  }
  const hits = src.split(FROM).length - 1;
  if (hits !== 1) {
    console.log(`未匹配        ${rel}（[配图] 出现 ${hits} 次，需人工核对）`);
    failed++;
    continue;
  }
  if (checkOnly) {
    console.log(`待打补丁      ${rel}`);
    continue;
  }
  const bak = file + '.bak-no-phantom-images';
  if (!existsSync(bak)) copyFileSync(file, bak);
  writeFileSync(file, src.replace(FROM, TO), 'utf8');
  changed++;
  console.log(`已打补丁      ${rel}`);
}

console.log(checkOnly
  ? `检查完成，未改动文件。包目录：${petDir}`
  : `完成：${changed} 个文件已更新${failed ? `，${failed} 个未匹配` : ''}。重开 DSH 后新指令生效；人设侧的规则已经即时生效。`);
if (failed) process.exitCode = 1;
