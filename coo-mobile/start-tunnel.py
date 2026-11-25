"""Keep a public HTTPS tunnel to the Coopanion pet service alive.

Design:
  * Cloudflare quick tunnel is the primary backend: no account, no install,
    no inbound port, and the assigned trycloudflare.com domain stays fixed for
    the whole lifetime of the process (localhost.run retires its free domains
    every ~15 minutes even while SSH is still connected).
  * localhost.run SSH reverse tunnels remain as fallbacks. A registered SSH
    key, once accepted by the service, also gives a stable domain.
  * Auto-reconnect when the backend drops.
  * Health watchdog: a tunnel can go dead without its process exiting. Poll
    the public URL and force a reconnect when it stops answering 200.
  * Every time the public URL changes, refresh tunnel-url.txt / wan-qr.png and
    push the new link to a private ntfy.sh topic so the phone always has it.
  * Single instance via a loopback port lock. Safe under pythonw.exe (no console).
  * Writes tunnel-heartbeat.json every 10s. tunnel-guard.py revives this
    process if it disappears, and this process revives the guard in return.

Normally started by tunnel-guard.py, which the logon shortcuts launch. Stopping
this manager alone no longer ends the tunnel: the guard starts a fresh one.
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / "mobile-config.json").read_text(encoding="utf-8"))
TCFG_PATH = HERE / "tunnel-config.json"
TCFG = json.loads(TCFG_PATH.read_text(encoding="utf-8")) if TCFG_PATH.exists() else {}
PORT = CFG["pet_port"]
TOKEN = CFG["token"]
URLFILE = HERE / "tunnel-url.txt"
QRFILE = HERE / "wan-qr.png"
KEYFILE = HERE / "keys" / "coopanion_tunnel"
CLOUDFLARED = HERE / "bin" / "cloudflared.exe"
NGROK = HERE / "bin" / "ngrok.exe"
NGROK_CFG_PATH = HERE / "ngrok-config.json"
try:
    NGROK_CFG = json.loads(NGROK_CFG_PATH.read_text(encoding="utf-8")) if NGROK_CFG_PATH.exists() else {}
except Exception:
    NGROK_CFG = {}
LOCK_PORT = 47891
# Set COO_TUNNEL_DRYRUN=1 to exercise the connection logic without touching
# tunnel-url.txt, the QR code, or phone notifications (used for verification).
DRYRUN = bool(os.environ.get("COO_TUNNEL_DRYRUN"))

# Liveness contract with tunnel-guard.py. The manager writes a heartbeat every
# 10s; if it goes stale the guard (started at logon, or revived by us) kills the
# leftovers and starts a fresh manager. We do the same for the guard, so either
# process can be killed and the pair still recovers.
HEARTBEAT = HERE / "tunnel-heartbeat.json"
GUARD_HEARTBEAT = HERE / "guard-heartbeat.json"
GUARD_SCRIPT = HERE / "tunnel-guard.py"
GUARD_STALE = 60              # guard writes every 15s; 4 missed ticks => revive
DETACHED_PROCESS = 0x00000008
CREATE_NO_WINDOW = 0x08000000
STARTED = False

# Shared with the watchdog thread.
CURRENT_PROC: subprocess.Popen | None = None
CURRENT_URL = ""

# pythonw.exe has no console; keep both a log file and (when present) the console.
# The redirection is installed only when run as a script, so importing this
# module for tests never hijacks the caller's stdout.
CONSOLE = sys.stdout
LOGFILE = None


def log(msg: str) -> None:
    line = time.strftime("[%Y-%m-%d %H:%M:%S] ") + msg
    if LOGFILE is not None:
        try:
            LOGFILE.write(line + "\n")
            LOGFILE.flush()
        except Exception:
            pass
    if CONSOLE is not None:
        try:
            CONSOLE.write(line + "\n")
            CONSOLE.flush()
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


def write_heartbeat(phase: str = "running") -> None:
    write_json_atomic(HEARTBEAT, {
        "pid": os.getpid(),
        "ts": time.time(),
        "url": CURRENT_URL,
        "phase": phase,
    })


def spawn_guard() -> None:
    """Revive the supervisor if it died; the guard does the same for us."""
    exe = Path(sys.executable)
    pythonw = exe if exe.name.lower() == "pythonw.exe" else exe.with_name("pythonw.exe")
    if not pythonw.exists():
        pythonw = exe
    try:
        subprocess.Popen(
            [str(pythonw), str(GUARD_SCRIPT)],
            cwd=str(HERE),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW,
        )
        log("guard heartbeat stale -> started a fresh guard")
    except Exception as exc:
        log(f"cannot start guard: {exc}")


def ensure_guard() -> None:
    hb = read_json(GUARD_HEARTBEAT)
    if hb and time.time() - float(hb.get("ts") or 0) < GUARD_STALE:
        return
    spawn_guard()


def notify(title: str, body: str) -> None:
    """Short, throttled-by-caller alert on the private phone topic."""
    topic = TCFG.get("ntfy_topic")
    if not topic:
        return
    try:
        req = urllib.request.Request(
            "https://ntfy.sh/" + topic,
            data=body.encode("utf-8"),
            headers={"Title": title, "Tags": "cat,warning", "Priority": "high"},
        )
        urllib.request.urlopen(req, timeout=10).close()
    except Exception as exc:
        log(f"alert failed: {exc}")


def origin_ok() -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{PORT}/pet?m={TOKEN}", timeout=5
        ) as resp:
            return resp.status == 200
    except Exception:
        return False


def publish(url: str) -> None:
    """Refresh both phone entries (pet + console) and push them to the phone."""
    if DRYRUN:
        log("[dryrun] would publish: " + url)
        return
    console_url = url.replace("/pet?m=", "/console?m=")
    # The Android installer is served by the pet server as a static file, so its
    # download link rides on the same public domain and needs the same refresh.
    apk_url = url.replace("/pet?m=", "/web/CooConsole.apk?m=")
    console_file = HERE / "console-url.txt"
    console_qr = HERE / "console-qr.png"
    apk_qr = HERE / "apk-download-qr.png"
    URLFILE.write_text(url + "\n", encoding="utf-8")
    console_file.write_text(console_url + "\n", encoding="utf-8")
    (HERE / "apk-download-url.txt").write_text(apk_url + "\n", encoding="utf-8")
    try:
        sys.path.insert(0, str(HERE / "_lib"))
        import segno
        for text, target in ((url, QRFILE), (console_url, console_qr), (apk_url, apk_qr)):
            segno.make(text, error="m").save(
                str(target), scale=8, border=3, dark="#1A1B1C", light="#FFFFFF"
            )
    except Exception as exc:
        log(f"QR refresh failed: {exc}")
    topic = TCFG.get("ntfy_topic")
    if topic:
        try:
            # ntfy linkifies URLs in the body and renders Action buttons, so the
            # phone can open either entry with one tap instead of copy/pasting.
            body = f"桌宠 {url}\n控制台 {console_url}"
            # Header values must be latin-1; labels stay ASCII. URLs contain no
            # comma/semicolon, so two actions fit in one semicolon-separated header.
            actions = (
                f"view, Open Pet, {url}; "
                f"view, Open Console, {console_url}; "
                f"view, Get APK, {apk_url}"
            )
            req = urllib.request.Request(
                "https://ntfy.sh/" + topic,
                data=body.encode("utf-8"),
                headers={
                    # HTTP headers must be latin-1: keep the title ASCII.
                    "Title": "Coopanion phone entries",
                    "Tags": "cat,link",
                    "Click": console_url,
                    "Action": actions,
                    "Priority": "high",
                },
            )
            urllib.request.urlopen(req, timeout=10).close()
            log("pushed pet + console URLs to phone notification topic")
        except Exception as exc:
            log(f"notification failed: {exc}")
    log("PHONE URL: " + url)
    log("CONSOLE URL: " + console_url)


def watchdog() -> None:
    """Heartbeat + guard revival + health policing of the live backend.

    Three deliberate safeguards:
      * a 10s heartbeat lets the external guard notice if THIS process is gone;
      * a dead local origin is reported but never triggers a reconnect (that
        would rotate the public domain repeatedly without fixing anything);
      * local DNS/proxy outages are tolerated, but 5 minutes of them forces one
        reconnect so a wedged cloudflared cannot stay dead forever.
    """
    global CURRENT_PROC
    bad = 0
    tick = 0
    origin_bad = 0
    last_origin_alert = 0.0
    net_fail_since = 0.0
    while True:
        tick += 1
        try:
            write_heartbeat()
            ensure_guard()
        except Exception as exc:
            log(f"heartbeat error: {exc}")
        time.sleep(10)
        url, proc = CURRENT_URL, CURRENT_PROC
        if not url or proc is None or proc.poll() is not None:
            bad = 0
            net_fail_since = 0.0
            continue
        if tick % 3:                    # public probe every 30s
            continue
        if not origin_ok():
            origin_bad += 1
            bad = 0
            log(f"local origin 7797 is down ({origin_bad}) - keeping the tunnel")
            if origin_bad >= 3 and time.time() - last_origin_alert > 1800:
                last_origin_alert = time.time()
                notify(
                    "Coo desktop service is down",
                    "电脑上的桌宠服务 7797 没有响应，手机会白屏；请在电脑上重启 Coopanion。"
                    "隧道保持不动，不会反复换域名。",
                )
            continue
        origin_bad = 0
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "coopanion-tunnel-health/1"}
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                code = resp.status
        except urllib.error.HTTPError as exc:
            net_fail_since = 0.0
            code = exc.code
        except Exception:
            if not net_fail_since:
                net_fail_since = time.time()
            if time.time() - net_fail_since > 300:
                log("network unreachable for 5 min while backend alive -> reconnect")
                net_fail_since = 0.0
                try:
                    proc.terminate()
                except Exception:
                    pass
            continue
        net_fail_since = 0.0
        if code == 200:
            bad = 0
            continue
        bad += 1
        log(f"health check: public URL returned {code} ({bad}/3)")
        if bad >= 3:
            log("public endpoint unhealthy while process is alive -> forcing reconnect")
            bad = 0
            try:
                proc.terminate()
            except Exception:
                pass


BASE_CMD = [
    "ssh",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=NUL",
    "-o", "BatchMode=yes",
    "-o", "ServerAliveInterval=60",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "LogLevel=ERROR",
    "-n", "-T",
    "-R", f"80:127.0.0.1:{PORT}",
]

# Only an actually assigned tunnel host counts. Both services also print
# documentation links (https://localhost.run, https://developers.cloudflare.com)
# which must never be mistaken for the phone entry.
URL_PATTERNS = (
    re.compile(r"https://([a-z0-9-]+\.(?:lhr\.life|localhost\.run))", re.I),
    re.compile(r"https://([a-z0-9-]+(?:\.[a-z0-9-]+)*\.trycloudflare\.com)", re.I),
    re.compile(r"https://([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ngrok-free\.app|ngrok\.app))", re.I),
)


def modes() -> list[tuple[str, list[str]]]:
    """Return (name, full argv) in priority order."""
    out: list[tuple[str, list[str]]] = []
    # Optional: a registered ngrok account gets one free static domain, so the
    # phone's home-screen icon keeps working across restarts. Only enabled when
    # ngrok-config.json is filled in; otherwise behaviour is unchanged.
    domain = str(NGROK_CFG.get("domain", "")).strip().rstrip("/")
    authtoken = str(NGROK_CFG.get("authtoken", "")).strip()
    if NGROK.exists() and domain and authtoken:
        if domain.startswith("http://") or domain.startswith("https://"):
            domain = domain.split("://", 1)[1]
        out.append(("ngrok-fixed", [
            str(NGROK), "http", str(PORT),
            "--authtoken", authtoken,
            "--url", "https://" + domain,
            "--log", "stdout", "--log-format", "term",
        ]))
    if CLOUDFLARED.exists():
        out.append(("cloudflared", [
            str(CLOUDFLARED), "tunnel",
            "--url", f"http://127.0.0.1:{PORT}",
            "--no-autoupdate", "--protocol", "http2",
            "--metrics", "127.0.0.1:0",
        ]))
    if KEYFILE.exists() and TCFG.get("use_key_when_available", True):
        # Registered key -> stable domain across reconnects. `plan` also works
        # for accounts on a custom-domain plan.
        out.append(("key/localhost.run", BASE_CMD + ["-i", str(KEYFILE), "localhost.run"]))
        out.append(("key/plan", BASE_CMD + ["-i", str(KEYFILE), "plan@localhost.run"]))
    out.append(("nokey", BASE_CMD + ["nokey@localhost.run"]))
    return out


def run_mode(name: str, cmd: list[str], last_url: str) -> tuple[str | None, str]:
    """Run one tunnel backend until it ends. Return (final_url, last_url)."""
    global CURRENT_PROC, CURRENT_URL
    try:
        # cloudflared.exe / ssh.exe are console programs. This manager runs as
        # pythonw.exe (no console), so without CREATE_NO_WINDOW Windows creates
        # a brand new terminal window for every backend - and another one on
        # every reconnect. Output is still captured through the pipe below.
        win_flags = {"creationflags": CREATE_NO_WINDOW} if os.name == "nt" else {}
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            **win_flags,
        )
        CURRENT_PROC = proc
    except Exception as exc:
        log(f"[{name}] cannot start backend: {exc}")
        return None, last_url

    got = None
    try:
        for raw in proc.stdout:
            line = raw.strip()
            match = None
            for pattern in URL_PATTERNS:
                match = pattern.search(line)
                if match:
                    break
            if match:
                url = "https://" + match.group(1) + f"/pet?m={TOKEN}"
                if got is None:
                    got = url
                    CURRENT_URL = url
                    log(f"[{name}] tunnel up")
                    if url != last_url:
                        publish(url)
                        last_url = url
            elif line and any(
                w in line.lower()
                for w in ("permission denied", "error", "refused", "failed", "closed", "no hostkey")
            ):
                log(f"[{name}] {line[:180]}")
    except Exception as exc:
        log(f"[{name}] reader error: {exc}")
    finally:
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        CURRENT_PROC = None
        CURRENT_URL = ""
    log(f"[{name}] connection ended (exit {proc.returncode})")
    return got, last_url


def acquire_lock():
    """Bind the single-instance port, tolerating a stale holder.

    A manager killed without cleanup used to leave the port bound just long
    enough for a replacement to give up forever. Now we check the heartbeat:
    a fresh one means a real peer, a stale one means the guard is cleaning up
    and we simply wait for it.
    """
    for attempt in range(5):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind(("127.0.0.1", LOCK_PORT))
            sock.listen(1)
            return sock
        except OSError:
            sock.close()
            hb = read_json(HEARTBEAT)
            fresh = bool(hb) and time.time() - float(hb.get("ts") or 0) < 75
            if fresh and hb.get("phase") != "stopped":
                log("another tunnel manager is already running - exiting")
                return None
            log(f"lock held by a stale manager, waiting for guard ({attempt + 1}/5)")
            time.sleep(3)
    log("could not acquire the single-instance lock - guard will retry")
    return None


def main() -> None:
    global STARTED
    lock = acquire_lock()
    if lock is None:
        return
    STARTED = True
    write_heartbeat()
    threading.Thread(target=watchdog, name="health-watchdog", daemon=True).start()
    candidates = modes()
    log("=== tunnel manager started (backends: %s) ===" % ", ".join(n for n, _ in candidates))
    if CLOUDFLARED.exists():
        log("cloudflared available - its domain stays fixed while the process lives")
    if KEYFILE.exists():
        log(f"using SSH key {KEYFILE.name} (stable domain once registered)")

    index = 0
    last_url = ""
    # If we had to fall back to a lower-priority backend, periodically retry
    # the preferred one: a key may be registered later, or a transient
    # cloudflared outage may have cleared. No manual restart needed.
    probe_due = 0.0
    while True:
        if index > 0 and time.time() >= probe_due:
            probe_due = time.time() + 900
            log("re-probing preferred backend")
            index = 0
        name, cmd = candidates[index % len(candidates)]
        got, last_url = run_mode(name, cmd, last_url)
        if got:
            # A working backend: retry the same one after a drop before degrading.
            index = next(i for i, (n, _) in enumerate(candidates) if n == name)
        else:
            index += 1
        time.sleep(4)


if __name__ == "__main__":
    LOGFILE = open(HERE / "tunnel.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = LOGFILE
    try:
        main()
    except KeyboardInterrupt:
        log("tunnel manager stopped by user")
    finally:
        if STARTED:
            try:
                write_heartbeat("stopped")
            except Exception:
                pass
