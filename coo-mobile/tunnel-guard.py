"""Always-on supervisor for the Coopanion public tunnel.

Why this exists
---------------
start-tunnel.py is only able to keep its OWN cloudflared/SSH child alive. If the
manager process itself is killed (agent session reclaimed, user logs off, system
resets, or an unhandled crash) there is nobody left to restart it, and the phone
keeps hitting a dead domain. The Startup shortcut only runs at logon, so a sleep
-> wake cycle or a long-lived session never brings it back.

This guard is deliberately tiny and has no third-party dependencies. It is
started by the Startup shortcut (or by the manager itself), runs under
pythonw.exe with no window, and does three things every 15 seconds:

  * writes its own heartbeat, so the manager can revive the guard if IT dies;
  * reads the manager heartbeat; if it is missing/stale, kills stale children
    and starts a fresh start-tunnel.py in a detached process;
  * checks the local 7797 origin and raises a throttled ntfy alert when the
    desktop app itself is down (a healthy tunnel is useless without an origin).

If another instance already owns the guard lock, this one no longer exits: it
stays alive as a HOT SPARE. A guard launched inside an agent session is reaped
with that session's Job Object (and takes the manager + cloudflared with it),
but a guard launched from Explorer - Startup folder or one double click on
start-guard.vbs - lives outside that Job. The spare picks up the lock within
one check interval after the primary dies, so a double click performs a
zero-downtime handover instead of being ignored as a duplicate.

All process termination uses the Win32 API via ctypes - no taskkill.exe, no
scheduled tasks, no administrator rights, no dependency on any agent session.
"""
from __future__ import annotations

import ctypes
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from ctypes import wintypes
from pathlib import Path

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / "mobile-config.json").read_text(encoding="utf-8"))
TCFG = json.loads((HERE / "tunnel-config.json").read_text(encoding="utf-8"))
PORT = CFG["pet_port"]
TOKEN = CFG["token"]

MANAGER = HERE / "start-tunnel.py"
MANAGER_HB = HERE / "tunnel-heartbeat.json"
GUARD_HB = HERE / "guard-heartbeat.json"
URLFILE = HERE / "tunnel-url.txt"
LOGFILE = HERE / "guard.log"

LOCK_PORT = 47892              # separate from the manager's 47891
CHECK_EVERY = 15
MANAGER_STALE = 75            # seconds without a heartbeat => manager is gone
ORIGIN_BAD_LIMIT = 3
ALERT_COOLDOWN = 1800         # do not spam the phone

DETACHED_PROCESS = 0x00000008
CREATE_NO_WINDOW = 0x08000000

# ------------------------------------------------------------------ Win32

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.OpenProcess.restype = wintypes.HANDLE
k32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
k32.TerminateProcess.restype = wintypes.BOOL
k32.CloseHandle.argtypes = [wintypes.HANDLE]
k32.CloseHandle.restype = wintypes.BOOL


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", ctypes.c_char * 260),
    ]


k32.Process32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
k32.Process32First.restype = wintypes.BOOL
k32.Process32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
k32.Process32Next.restype = wintypes.BOOL


def processes_named(name: str) -> list[int]:
    """Snapshot the process table and return PIDs whose exe matches name."""
    snap = k32.CreateToolhelp32Snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
    if not snap or snap == ctypes.c_void_p(-1).value:
        return []
    out: list[int] = []
    entry = PROCESSENTRY32()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
    try:
        ok = k32.Process32First(snap, ctypes.byref(entry))
        while ok:
            exe = entry.szExeFile.split(b"\x00", 1)[0].decode("ascii", "ignore")
            if exe.lower() == name.lower():
                out.append(int(entry.th32ProcessID))
            ok = k32.Process32Next(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return out


def kill_pid(pid: int) -> bool:
    if not pid or pid == os.getpid():
        return False
    handle = k32.OpenProcess(0x0001, False, pid)  # PROCESS_TERMINATE
    if not handle:
        return False
    try:
        return bool(k32.TerminateProcess(handle, 1))
    finally:
        k32.CloseHandle(handle)


# ------------------------------------------------------------------ helpers

def log(msg: str) -> None:
    line = time.strftime("[%Y-%m-%d %H:%M:%S] ") + msg
    try:
        with LOGFILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def write_json_atomic(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def origin_ok() -> bool:
    """Is the desktop pet service answering locally?"""
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{PORT}/pet?m={TOKEN}", timeout=5
        ) as resp:
            return resp.status == 200
    except Exception:
        return False


def notify(title: str, body: str) -> None:
    topic = TCFG.get("ntfy_topic")
    if not topic:
        return
    try:
        req = urllib.request.Request(
            "https://ntfy.sh/" + topic,
            data=body.encode("utf-8"),
            headers={
                "Title": title,          # HTTP headers must be latin-1
                "Tags": "cat,warning",
                "Priority": "high",
            },
        )
        urllib.request.urlopen(req, timeout=10).close()
    except Exception as exc:
        log(f"alert failed: {exc}")


def pythonw() -> str:
    """Prefer the windowless interpreter; fall back to whatever runs us."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe":
        return str(exe)
    candidate = exe.with_name("pythonw.exe")
    return str(candidate) if candidate.exists() else str(exe)


def start_manager() -> None:
    subprocess.Popen(
        [pythonw(), str(MANAGER)],
        cwd=str(HERE),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW,
    )


def revive_manager() -> None:
    """Clean up a dead manager's leftovers and start a fresh one."""
    old = read_json(MANAGER_HB)
    pid = int(old.get("pid") or 0)
    if pid:
        log(f"terminating stale manager pid {pid}: {kill_pid(pid)}")
    # A killed manager leaves cloudflared orphaned and still holding the old
    # quick tunnel. Remove it before a new one claims a new domain.
    orphans = processes_named("cloudflared.exe")
    if orphans:
        log("terminating orphan cloudflared: " + ", ".join(str(p) for p in orphans))
        for p in orphans:
            kill_pid(p)
    time.sleep(2)
    # Clear the stale heartbeat so wait_for_manager() cannot see the old one.
    try:
        MANAGER_HB.unlink()
    except Exception:
        pass
    start_manager()
    log("started a fresh tunnel manager (detached)")


def wait_for_manager(timeout: int = 60) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        hb = read_json(MANAGER_HB)
        if hb and time.time() - float(hb.get("ts") or 0) < MANAGER_STALE:
            return True
        time.sleep(2)
    return False


def run_active(lock: socket.socket) -> None:
    """Own the guard lock and supervise the tunnel manager forever."""
    log("=== tunnel guard active (pid %d) ===" % os.getpid())
    restart_failures = 0
    origin_bad = 0
    last_alert = 0.0
    last_origin_alert = 0.0

    while True:
        try:
            write_json_atomic(GUARD_HB, {"pid": os.getpid(), "ts": time.time()})
        except Exception as exc:
            log(f"cannot write guard heartbeat: {exc}")

        hb = read_json(MANAGER_HB)
        fresh = bool(hb) and (time.time() - float(hb.get("ts") or 0) < MANAGER_STALE)

        if not fresh:
            log("manager heartbeat missing/stale -> reviving")
            try:
                revive_manager()
                if wait_for_manager():
                    log("manager recovered on its own")
                    restart_failures = 0
                else:
                    restart_failures += 1
                    log(f"manager did not come back ({restart_failures} consecutive)")
                    if restart_failures >= 2 and time.time() - last_alert > ALERT_COOLDOWN:
                        last_alert = time.time()
                        notify(
                            "Coo tunnel cannot restart",
                            "隧道守护连续两次没能拉起管理器，请检查电脑上的 Coopanion 与 Python 是否还在运行。",
                        )
            except Exception as exc:
                log(f"revive failed: {exc}")
                restart_failures += 1
        else:
            restart_failures = 0

        # A healthy tunnel cannot help when the desktop app itself is down.
        if origin_ok():
            origin_bad = 0
        else:
            origin_bad += 1
            if origin_bad >= ORIGIN_BAD_LIMIT and time.time() - last_origin_alert > ALERT_COOLDOWN:
                last_origin_alert = time.time()
                log("local origin 7797 is down - alerting phone")
                notify(
                    "Coo desktop service is down",
                    "隧道还在，但电脑上的桌宠服务 7797 没有响应，手机会一直白屏。"
                    "请在电脑上重新启动 Coopanion。",
                )

        time.sleep(CHECK_EVERY)


def standby() -> None:
    """Wait for the current guard to disappear, then take over its lock.

    We never touch the running service while the primary is healthy: the only
    thing we do every CHECK_EVERY seconds is try to bind the lock port, which
    succeeds only after the owning process has exited. Once we own it, the
    normal supervision loop takes over and revives the manager if needed.
    """
    log("=== guard standby: another guard owns the lock (pid %d) ===" % os.getpid())
    while True:
        time.sleep(CHECK_EVERY)
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind(("127.0.0.1", LOCK_PORT))
            probe.listen(1)
        except OSError:
            try:
                probe.close()
            except Exception:
                pass
            continue
        log("standby acquired the guard lock - taking over as active")
        run_active(probe)                  # never returns
        return


def main() -> None:
    lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        lock.bind(("127.0.0.1", LOCK_PORT))
        lock.listen(1)
    except OSError:
        try:
            lock.close()
        except Exception:
            pass
        standby()
        return
    run_active(lock)


if __name__ == "__main__":
    while True:
        try:
            main()
            break
        except KeyboardInterrupt:
            log("guard stopped by user")
            break
        except Exception as exc:
            log(f"guard crashed ({exc}) - restarting loop in 20s")
            time.sleep(20)
