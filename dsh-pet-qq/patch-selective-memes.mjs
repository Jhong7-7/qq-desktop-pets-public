#!/usr/bin/env node
/**
 * patch-selective-memes.mjs —— 让 dsh-pet 的对话配图从「每轮必挑」变成「值得才发」。
 *
 * 背景：dsh-pet 在每条对话消息末尾追加 imageInstruction(pool)，措辞是「从下列清单里挑
 * 最贴合当前语境的」，模型会把它当成每轮的必答题；加上历史回放把过去每次的 [图:名称]
 * 都回填，配图率能到 90% 以上。本脚本只改那一句中文指令（不动任何逻辑），把默认行为
 * 翻转为「不配图」，让模型自己判断这一句值不值得发。
 *
 * 覆盖 src 源码 + lib 三份编译产物；DSH 桌面端跑 lib/index.js，独立模式跑 standalone，
 * app.js 是客户端 bundle，一起改保持一致。
 * 幂等：已打过补丁的文件跳过；每份文件首次改动前留 .bak-selective-memes 备份。
 * dsh-pet 升级后重新跑一次即可。改完需要重启 DSH 才会加载（Node 模块已缓存在内存里）。
 *
 * 用法：
 *   node patch-selective-memes.mjs            # 打补丁
 *   node patch-selective-memes.mjs --check   # 只看状态，不改文件
 *   node patch-selective-memes.mjs --dir <dsh-pet 包目录>
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const OLD_A = '回复结尾可选附一张表情包给用户看，从下列清单里挑最贴合当前语境的：';
const NEW_A = '默认不配图。绝大多数回复都只写字，直接回就好；只有这一句真的值得——情绪绷不住、梗正正好对上、或纯文字接不住——才从下面清单里挑一张最贴合的：';
const OLD_B = '挑中就在回复最后另起一行写 [图:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。';
const NEW_B = '真要发才在回复最后另起一行写 [图:名称]（名称原样照抄）。最近几轮已经发过表情包、或这一句只是普通接话、撒娇、追问，就完全不要写这个标记；宁可不发，也别为了配而配。一轮最多一张。';

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
  if (src.includes(NEW_A) && src.includes(NEW_B)) {
    console.log(`已是新版      ${rel}`);
    continue;
  }
  if (!src.includes(OLD_A) || !src.includes(OLD_B)) {
    console.log(`未找到旧文案  ${rel}（dsh-pet 版本可能变了，需要人工核对）`);
    failed++;
    continue;
  }
  if (checkOnly) {
    console.log(`待打补丁      ${rel}`);
    continue;
  }
  const bak = file + '.bak-selective-memes';
  if (!existsSync(bak)) copyFileSync(file, bak);
  writeFileSync(file, src.replace(OLD_A, NEW_A).replace(OLD_B, NEW_B), 'utf8');
  changed++;
  console.log(`已打补丁      ${rel}`);
}

console.log(checkOnly
  ? `检查完成，未改动文件。包目录：${petDir}`
  : `完成：${changed} 个文件已更新${failed ? `，${failed} 个未匹配` : ''}。重启 DSH 后新指令生效。`);
if (failed) process.exitCode = 1;
