"""Check the phone entry after Coopanion has been started with start-mobile.cmd.

Run this from the desktop once Coopanion is running. It reports whether the
pet service is bound to all interfaces, whether the token gate works, and
whether Core's 17788 stayed on loopback. It also refreshes the QR code for the
current LAN address.
"""
from pathlib import Path
import json
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / "mobile-config.json").read_text(encoding="utf-8"))
TOKEN = CFG["token"]
PORT = CFG["pet_port"]
COOKIE = f"coopanion_pet_mobile={TOKEN}"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def lan_ips() -> list[str]:
    found = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and not ip.startswith("169.254."):
                found.append(ip)
    except OSError:
        pass
    return sorted(set(found))


def status(url: str, headers: dict[str, str] | None = None) -> int:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with opener.open(req, timeout=4) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def main() -> int:
    ips = lan_ips()
    ip = ips[0] if ips else CFG.get("lan_ip_at_creation", "127.0.0.1")
    url = f"http://{ip}:{PORT}/pet?m={TOKEN}"

    print("Coopanion phone entry check")
    print("-" * 58)
    try:
        raw = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"], capture_output=True, timeout=10
        ).stdout
        netstat = raw.decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  netstat failed: {e}")
        netstat = ""
    lines = [l.strip() for l in netstat.splitlines()
             if re.search(rf":{PORT}\s", l) and "LISTENING" in l.upper()]

    bound_all = any(re.search(r"0\.0\.0\.0:\d+", l) for l in lines)
    for l in lines:
        print(f"  pet service listening: {l}")
    if not lines:
        print("  pet service NOT listening - Coopanion is not running yet")
        print("  Quit Coopanion, then double-click start-mobile.cmd and run this again.")
        return 1
    print(f"  bound to all interfaces: {'YES' if bound_all else 'NO'}")
    if not bound_all:
        print("  -> still loopback only. Start Coopanion with start-mobile.cmd.")

    print()
    checks = [
        ("loopback /pet (desktop window)", f"http://127.0.0.1:{PORT}/pet", None, 200),
        ("lan /pet without token", f"http://{ip}:{PORT}/pet", None, 421),
        ("lan /pet with token", url, None, 200),
        ("lan static asset with cookie", f"http://{ip}:{PORT}/web/pet-app.js", {"Cookie": COOKIE}, 200),
    ]
    ok = True
    for label, u, headers, expected in checks:
        code = status(u, headers)
        mark = "ok" if code == expected else "CHECK"
        if code != expected:
            ok = False
        print(f"  [{mark:5s}] {label:34s} {code} (want {expected})")

    core = status(f"http://{ip}:17788/")
    print(f"  [{'ok' if core == 0 else 'CHECK':5s}] Core 17788 from LAN          {core} (want 0 = unreachable)")
    if core != 0:
        ok = False

    print()
    print(f"  Phone URL: {url}")
    if ips:
        print(f"  All LAN IPs on this machine: {', '.join(ips)}")
    try:
        sys.path.insert(0, str(HERE / "_lib"))
        import segno
        segno.make(url, error="m").save(str(HERE / "mobile-qr.png"), scale=8, border=3,
                                       dark="#1A1B1C", light="#FFFFFF")
        print("  QR code refreshed: mobile-qr.png")
    except Exception as e:
        print(f"  QR code not refreshed ({e}); use the URL above")
    print()
    print("  If the phone cannot reach this address, the Wi-Fi may isolate clients.")
    print("  Try a phone hotspot: connect the PC to it, then run this script again.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
