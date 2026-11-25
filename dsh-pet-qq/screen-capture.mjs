#!/usr/bin/env node
/**
 * screen-capture.mjs —— capture-window.ps1 的 Node 包装。
 *
 * 只截「锁定的那个前台窗口」的矩形，绝不截整个虚拟桌面；图片不落盘，
 * PowerShell 把 JPEG base64 打到 stdout，这里直接变成 /chat 的 attachment。
 * 同时带一份 24×14 灰度指纹，用来判断画面有没有真的变了、是不是黑屏。
 *
 * 宿主约束（image-input.mjs）：mediaType ∈ png/jpeg/webp/gif，
 * base64 ≤ 900000 字符，请求体 ≤ 1 MiB，因此默认压到 600000 字节以内。
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'capture-window.ps1');

export const FP_W = 24;
export const FP_H = 14;
export const FP_PIXELS = FP_W * FP_H;
export const FP_HEX_LEN = FP_PIXELS * 2;

/** 两张指纹的平均绝对亮度差（0–255）。长度不对按「完全不同」处理。 */
export function fpDistance(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== FP_HEX_LEN || b.length !== FP_HEX_LEN) return 255;
  let sum = 0;
  for (let i = 0; i < FP_HEX_LEN; i += 2) {
    const x = parseInt(a.slice(i, i + 2), 16);
    const y = parseInt(b.slice(i, i + 2), 16);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 255;
    sum += Math.abs(x - y);
  }
  return sum / FP_PIXELS;
}

/** 指纹平均亮度，用来识别锁屏 / 全黑 / 纯白帧。 */
export function fpMean(fp) {
  if (typeof fp !== 'string' || fp.length !== FP_HEX_LEN) return -1;
  let sum = 0;
  for (let i = 0; i < FP_HEX_LEN; i += 2) {
    const v = parseInt(fp.slice(i, i + 2), 16);
    if (!Number.isFinite(v)) return -1;
    sum += v;
  }
  return sum / FP_PIXELS;
}

const num = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

/**
 * @param {object} cfg   config.json 的 watchMode 段
 * @param {(msg:string)=>void} log
 */
export function createScreenCapture(cfg = {}, log = () => {}) {
  const settings = {
    maxEdge: num(cfg.maxEdge, 1280, 320, 2560),
    jpegQuality: num(cfg.jpegQuality, 72, 20, 95),
    maxImageBytes: num(cfg.maxImageBytes, 600000, 50000, 900000),
    minWindowWidth: num(cfg.minWindowWidth, 320, 100, 1920),
    minWindowHeight: num(cfg.minWindowHeight, 240, 100, 1080),
    captureTimeoutMs: num(cfg.captureTimeoutMs, 15000, 3000, 60000),
  };

  function run(mode, extra = {}) {
    if (process.platform !== 'win32') {
      return Promise.resolve({ ok: false, reason: 'platform-unsupported' });
    }
    const args = [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT,
      '-Mode', mode,
      '-MaxEdge', String(settings.maxEdge),
      '-Quality', String(settings.jpegQuality),
      '-MaxBytes', String(settings.maxImageBytes),
      '-MinWidth', String(settings.minWindowWidth),
      '-MinHeight', String(settings.minWindowHeight),
    ];
    if (Number(extra.expectHwnd) > 0) args.push('-ExpectHwnd', String(Math.trunc(Number(extra.expectHwnd))));

    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        args,
        { timeout: settings.captureTimeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          const raw = String(stdout ?? '').trim();
          const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          const last = lines.at(-1) ?? '';
          if (!last) {
            resolve({
              ok: false,
              reason: err ? 'capture-process-failed' : 'empty-output',
              detail: String(err?.message ?? stderr ?? '').slice(0, 200),
            });
            return;
          }
          try {
            resolve(JSON.parse(last));
          } catch {
            resolve({ ok: false, reason: 'bad-json', detail: last.slice(0, 200) });
          }
        },
      );
    });
  }

  return {
    settings,
    scriptPath: SCRIPT,
    /** 看一眼当前前台窗口（锁定阶段用），不截图。 */
    probe: () => run('probe'),
    /** 只有 hwnd 仍是前台窗口时才截图，否则返回 foreground-mismatch。 */
    capture: (hwnd) => run('capture', { expectHwnd: hwnd }),
    log,
  };
}
