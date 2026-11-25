"""Re-apply the Coopanion phone patch after an automatic update.

The installer rewrites resources/app on every update, which erases the edited
files. Run this script after any Coopanion update, then restart with
start-mobile.cmd. Golden copies live next to this script in ./patch/.

What is restored:
  * src/server.ts            token-gated phone access, /api/m/* Core proxy,
  *                          /api/m/chat/{send,events} and
                             the /console route (only this one needs a restart).
  * web/pet-app.js           socket follows the page's ws/wss protocol, and
  *                          forwards say/ask text to the Android native bubble.
  * web/body-host.js         figure iframe carries the token for public HTTPS tunnels.
  * web/mobile-console.html  phone console UI + PWA meta.
  * web/mobile-console.js    phone console logic + token self-heal.
  * web/pet.html             PWA meta + phone-only "back to console" button.
  * web/manifest*.json       installable-app manifests (console and pet).
  * web/icon-*.png           app icons, including a maskable variant.
  * web/CooConsole.apk       signed Android installer served at /web/CooConsole.apk.
Front-end files are read from disk on every request, so they take effect
immediately; only server.ts needs a Core hot restart.
"""
from pathlib import Path
import shutil
import sys

APP = Path(r"D:\coopanion\resources\app\node_modules\cortico-world-desktop-pet")
WEB = APP / "web"
HERE = Path(__file__).resolve().parent
PATCH = HERE / "patch"

# (golden file in ./patch, destination under APP, marker that must be present)
PNG = b"\x89PNG\r\n\x1a\n"
TARGETS = (
    ("server.ts.golden", APP / "src" / "server.ts", b"CONSOLE_APIS"),
    ("server.ts.golden", APP / "src" / "server.ts", b"/api/m/chat/send"),
    ("pet-app.js.golden", WEB / "pet-app.js", b"location.protocol === 'https:'"),
    ("pet-app.js.golden", WEB / "pet-app.js", b"COO_NATIVE_BUBBLE_BRIDGE"),
    ("body-host.js.golden", WEB / "body-host.js", b"COO_MOBILE_FRAME_TOKEN"),
    ("mobile-console.html.golden", WEB / "mobile-console.html", b"manifest.json"),
    ("mobile-console.js.golden", WEB / "mobile-console.js", b"/api/m/worlds"),
    ("pet.html.golden", WEB / "pet.html", b"cooConsoleBtn"),
    ("manifest.json.golden", WEB / "manifest.json", b'"id": "/console"'),
    ("manifest-pet.json.golden", WEB / "manifest-pet.json", b'"id": "/pet"'),
    ("icon-192.png.golden", WEB / "icon-192.png", PNG),
    ("icon-512.png.golden", WEB / "icon-512.png", PNG),
    ("icon-maskable-512.png.golden", WEB / "icon-maskable-512.png", PNG),
    ("CooConsole.apk.golden", WEB / "CooConsole.apk", b"PK\x03\x04"),
)


def main() -> int:
    if not APP.is_dir():
        print(f"Install directory not found: {APP}", file=sys.stderr)
        return 1
    changed = False
    for name, dest, marker in TARGETS:
        golden = PATCH / name
        if not golden.is_file():
            print(f"Golden copy missing: {golden}", file=sys.stderr)
            return 1
        data = golden.read_bytes()
        if marker not in data:
            print(f"Golden copy looks wrong (marker missing): {name}", file=sys.stderr)
            return 1
        if not dest.parent.is_dir():
            print(f"Target directory missing (update changed layout?): {dest.parent}", file=sys.stderr)
            return 1
        if dest.exists() and dest.read_bytes() == data:
            print(f"already patched  {dest.name}")
            continue
        if dest.exists():
            backup = dest.with_name(dest.name + ".bak-before-mobile")
            if not backup.exists():
                shutil.copy2(dest, backup)
                print(f"backed up       {backup.name}")
        shutil.copy2(golden, dest)
        print(f"patched         {dest.name}")
        changed = True
    print()
    if changed:
        print("Patch applied.")
        print("Front-end / icon / manifest changes are live immediately (reload the page).")
        print("If server.ts changed, hot-restart Core with POST /api/run/restart,")
        print("or quit Coopanion from the tray and run start-mobile.cmd.")
        print("The tunnel manager may also need a restart; it will push a new link.")
    else:
        print("Nothing to do. The install still has the full phone patch.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
