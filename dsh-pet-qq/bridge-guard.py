#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bridge-guard.py —— dsh-pet-qq 的轻量看门狗，只守 7341（桥）。

为什么不沿用 watchdog.ps1：
  2026-11-23 18:05 计划任务拉起 watchdog.ps1，日志停在 18:07，任务结果
  0xC000013A（被 Ctrl+C / 关控制台终止）。Win11 默认终端是 Windows Terminal，
  会无视 -WindowStyle Hidden 弹出黑窗；窗口一关，PowerShell 守护跟着死。
  之后 18:48 桥掉线，直到 19:55 才被手动拉起——67 分钟无人接。

本脚本的设计：
  · 由 pythonw.exe 启动：天生没有控制台，没有窗口可关，也不会被 Ctrl+C。
  · 只守 7341，不碰 SnowLuma / QQ 客户端 / DSH（保持「轻度」，符合 11-18 的意愿）。
  · 连续 2 次（约 30s）探不到端口才动手，避免桥正在启动时误判。
  · 拉起用 node + CREATE_NO_WINDOW / DETACHED_PROCESS，仍在用户会话 1，
    观赛模式的「截前台窗口」不受影响。
  · 1 小时内最多拉 6 次，超过退避 10 分钟，避免代码坏了无限重启。
  · 单实例：命名 Mutex 'Local\\dsh-pet-qq-bridge-guard'。
  · 维护开关：本目录放一个 bridge-guard.pause 文件即暂停拉起（手动停桥改代码时用），
    删掉自动恢复；暂停/恢复各记一条日志，不会刷屏。
  · 日志：logs\\bridge-guard.log（超 1MB 轮转）；子进程输出 logs\\bridge-guard-child.log。

用法：
  pythonw.exe bridge-guard.py           常驻（计划任务用这个）
  python.exe  bridge-guard.py --status   打印一次状态（调试）
  python.exe  bridge-guard.py --once     做一次检查就退出（测试用）
"""

from __future__ import annotations

import ctypes
import datetime
import os
import shutil
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(ROOT, "bridge.mjs")
LOG = os.path.join(ROOT, "logs", "bridge-guard.log")
CHILD_LOG = os.path.join(ROOT, "logs", "bridge-guard-child.log")
PAUSE_FLAG = os.path.join(ROOT, "bridge-guard.pause")

# 优先用 SnowLuma 自带的 node（与 start-hidden.vbs 的退路一致，避免 PATH 差异）
PRIMARY_NODE = r"C:\Users\86189\SnowLuma\runtime\node-v24.22.1-win-x64\node.exe"

PORT = 7341
INTERVAL_SEC = 15
CONSECUTIVE_FAILS = 2
COOLDOWN_SEC = 25
MAX_STARTS_PER_HOUR = 6
BACKOFF_SEC = 600
OBSERVE_SEC = 30
MUTEX_NAME = "Local\\dsh-pet-qq-bridge-guard"

CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008
ERROR_ALREADY_EXISTS = 183


def log(msg: str) -> None:
    """追加一行 UTF-8 日志；任何异常都吞掉，守护本身不能因为写日志而挂。"""
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        try:
            if os.path.getsize(LOG) > 1048576:
                os.replace(LOG, LOG + ".1")
        except OSError:
            pass
        line = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S") + " " + msg + "\n"
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass


def port_open(port: int = PORT, timeout: float = 0.7) -> bool:
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        try:
            s.close()
        except OSError:
            pass


def wait_port(seconds: int) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if port_open():
            return True
        time.sleep(2)
    return False


def acquire_single_instance():
    """命名 Mutex 单实例；成功返回句柄（需持有到进程退出），已有实例返回 None。"""
    try:
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
        if not handle:
            return None
        if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            kernel32.CloseHandle(handle)
            return None
        return handle
    except Exception as exc:
        log("单实例锁失败：%s" % exc)
        return None


def node_exe() -> str:
    if os.path.isfile(PRIMARY_NODE):
        return PRIMARY_NODE
    return shutil.which("node") or "node"


def start_bridge() -> int:
    """无窗口拉起桥；返回 node 的 PID，失败返回 0。"""
    node = node_exe()
    path = os.path.join(ROOT, "logs")
    os.makedirs(path, exist_ok=True)
    flags = CREATE_NO_WINDOW | DETACHED_PROCESS
    try:
        with open(CHILD_LOG, "ab", buffering=0) as out:
            proc = subprocess.Popen(
                [node, BRIDGE],
                cwd=ROOT,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.STDOUT,
                creationflags=flags,
                close_fds=True,
            )
        return proc.pid
    except Exception as exc:
        log("拉起桥失败：%s" % exc)
        return 0


def status_text() -> str:
    lines = [
        "bridge-guard 状态",
        "  端口 7341 : %s" % ("OPEN" if port_open() else "CLOSED"),
        "  暂停开关  : %s" % ("存在（已暂停）" if os.path.isfile(PAUSE_FLAG) else "无"),
        "  node      : %s" % node_exe(),
        "  桥脚本    : %s%s" % (BRIDGE, "" if os.path.isfile(BRIDGE) else "（不存在！）"),
        "  日志      : %s" % LOG,
        "  子进程日志: %s" % CHILD_LOG,
        "  本进程 PID: %d" % os.getpid(),
    ]
    return "\n".join(lines)


def run_loop() -> int:
    handle = acquire_single_instance()
    if handle is None:
        log("已有 bridge-guard 在运行，本实例退出")
        return 0
    if not os.path.isfile(BRIDGE):
        log("找不到 %s，守护退出" % BRIDGE)
        return 1

    log("bridge-guard 启动 PID=%d 间隔=%ds 守护端口=%d node=%s"
        % (os.getpid(), INTERVAL_SEC, PORT, node_exe()))

    fails = 0
    last_start = 0.0
    history: list[float] = []
    paused = False

    while True:
        try:
            if os.path.isfile(PAUSE_FLAG):
                if not paused:
                    log("已暂停（检测到 bridge-guard.pause），不再自动拉起")
                    paused = True
                    fails = 0
            else:
                if paused:
                    log("已恢复（bridge-guard.pause 已删除），继续守护")
                    paused = False
                if port_open():
                    if fails:
                        log("桥已恢复在线（7341 OK），本段累计拉起 %d 次" % fails)
                        fails = 0
                else:
                    fails += 1
                    now = time.time()
                    if fails >= CONSECUTIVE_FAILS and now - last_start >= COOLDOWN_SEC:
                        history = [t for t in history if now - t < 3600]
                        if len(history) >= MAX_STARTS_PER_HOUR:
                            log("1 小时内已拉起 %d 次，退避 %d 秒再试"
                                % (len(history), BACKOFF_SEC))
                            time.sleep(BACKOFF_SEC)
                            last_start = time.time()
                            fails = 0
                            continue
                        log("桥未监听 7341（连续 %d 次）→ 拉起 bridge.mjs" % fails)
                        pid = start_bridge()
                        last_start = time.time()
                        history.append(last_start)
                        if pid:
                            log("已启动 node PID=%d，等待端口就绪" % pid)
                            ok = wait_port(OBSERVE_SEC)
                            log("拉起结果：%s"
                                % ("7341 OK" if ok else "%d 秒内未就绪，稍后重试" % OBSERVE_SEC))
                            if ok:
                                fails = 0
        except Exception as exc:  # 守护绝不因单次异常退出
            log("循环异常：%s" % exc)
        time.sleep(INTERVAL_SEC)


def main() -> int:
    args = sys.argv[1:]
    if "--status" in args:
        print(status_text())
        return 0
    if "--once" in args:
        up = port_open()
        log("单次检查：7341 %s" % ("OPEN" if up else "CLOSED"))
        print("7341:", "OPEN" if up else "CLOSED")
        return 0 if up else 1
    return run_loop()


if __name__ == "__main__":
    sys.exit(main())
