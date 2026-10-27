#!/usr/bin/env python3
"""Build a game for the web and put it where it can be played (see the unity-webgl-deploy skill).

The build and deploy logic lives in a separate build repo at ~/gamedev/unity/builds, not here. This file
finds that repo's scripts and runs them, and adds the one thing they do not have: a local preview server
that serves a Unity WebGL build with the headers it needs.

  python tools/gamedev-deploy.py guide                       print the skill (the full instructions)
  python tools/gamedev-deploy.py build <project> [output]    Unity project -> WebGL build
  python tools/gamedev-deploy.py list                        what is built, and what is deployed
  python tools/gamedev-deploy.py deploy <build-dir>          asks where to put it: local, web or itch
  python tools/gamedev-deploy.py local <build-dir> [--port N] [--lan]  serve it from this PC
  python tools/gamedev-deploy.py web <slug> <build-dir>      S3 + CloudFront
  python tools/gamedev-deploy.py itch <build-dir> [target]   itch.io, via butler
  python tools/gamedev-deploy.py delete <slug>               remove from S3

Where things are published comes from ~/.buw/deploy.json (BUW_DEPLOY_CONFIG moves that file), not from this file:

  { "cardApi": { "domain": "api.workspaces.example.net", "region": "us-east-1", "stack": "buw-card-api",
                 "origins": ["https://workspaces.example.net", "http://localhost:3009"] },
    "web":  { "publicUrl": "https://games.example.net" },
    "itch": { "url": "https://<user>.itch.io" },
    "lanIp": "192.0.2.107" }

"cardApi" is read by site/card-api/deploy.sh. Here: web and delete need web.publicUrl (or BUW_WEB_PUBLIC_URL),
local --lan needs lanIp (or BUW_PC_LAN_IP), itch uses itch.url (or BUW_ITCH_URL) and otherwise the user in its
target argument. guide, list and build need no file.
"""
import os
import shutil
import json
import subprocess
import sys
import urllib.request
from functools import partial
from pathlib import Path

BUILDS = Path(os.environ.get("BUW_UNITY_BUILDS", Path.home() / "gamedev" / "unity" / "builds"))
SCRIPTS = BUILDS / "scripts"
SKILL = Path(__file__).resolve().parent.parent / ".agents" / "skills" / "unity-webgl-deploy" / "SKILL.md"
DEPLOY_CONFIG = Path(os.environ.get("BUW_DEPLOY_CONFIG", Path.home() / ".buw" / "deploy.json"))


def setting(env_name, *keys):
    """A deploy setting: the environment variable, else the keys in ~/.buw/deploy.json, else ''.

    Nothing is read until a command asks, so a missing file only stops the command that needs a value.
    """
    if env_name and os.environ.get(env_name):
        return os.environ[env_name].rstrip("/")
    try:
        value = json.loads(DEPLOY_CONFIG.read_text(encoding="utf-8"))
        for key in keys:
            value = value[key]
        return str(value).rstrip("/")
    except (OSError, ValueError, KeyError, TypeError):
        return ""


def require(env_name, *keys):
    """Like setting(), but stops with the key to set when it is missing."""
    value = setting(env_name, *keys)
    if not value:
        die(f'No value for "{".".join(keys)}": add it to {DEPLOY_CONFIG}'
            + (f" or set {env_name}." if env_name else "."))
    return value


def public_url():
    return require("BUW_WEB_PUBLIC_URL", "web", "publicUrl")


def targets():
    """The three places a build can go, described. Built when asked, because two of them need settings."""
    web = setting("BUW_WEB_PUBLIC_URL", "web", "publicUrl") or "<web.publicUrl>"
    itch = setting("BUW_ITCH_URL", "itch", "url") or "itch.io"
    return {
        "local": "Preview on this PC (the machine with the Unity CLI) — nothing is published",
        "web":   f"Public web: {web}/<slug>/ (S3 + CloudFront, behind basic auth)",
        "itch":  f"itch.io ({itch}), via butler — PUBLIC once pushed",
    }


REPO = Path(__file__).resolve().parent.parent
SECRETS = Path(os.environ.get("BUW_SECRETS_DIR", Path.home() / ".buw" / "secrets"))


def post_deploy_event(title, url):
    """Tell the Hub (and Discord, when a webhook is saved) that something was deployed.

    Called after a successful web or itch deploy. Never raises and never changes the exit code: the
    deploy has happened either way. Skips quietly when this PC has no `deploy` token.
    """
    try:
        token_file = SECRETS / "card-token-deploy"
        if token_file.is_file():
            env = {k: v for k, v in os.environ.items() if k != "BUW_CARDS_PASSWORD"}
            env["BUW_CARDS_PASSWORD_FILE"] = str(token_file)
            cmd = ["node", str(REPO / "site" / "card-api" / "cards.mjs"), "event", "deployed",
                   "--title", title, "--url", url, "--source", "gamedev-deploy", "--via", "api"]
            if os.environ.get("BUW_HUB_PROJECT"):
                cmd += ["--project", os.environ["BUW_HUB_PROJECT"]]
            done = subprocess.run(cmd, env=env, timeout=15, capture_output=True, text=True)
            if done.returncode != 0:
                lines = (done.stderr or done.stdout or "").strip().splitlines()
                print(f"[gamedev-deploy] (hub event skipped: {lines[-1] if lines else 'exit ' + str(done.returncode)})")
    except Exception as exc:  # noqa: BLE001 - a deploy must never fail because of a notification
        print(f"[gamedev-deploy] (hub event skipped: {type(exc).__name__}: {exc})")
    try:
        hook = SECRETS / "discord-webhook-deploys"
        if hook.is_file():
            body = json.dumps({"content": f"{title}\n{url}", "allowed_mentions": {"parse": []}}).encode()
            request = urllib.request.Request(hook.read_text().strip(), data=body, method="POST",
                                             headers={"content-type": "application/json", "user-agent": "gamedev-deploy"})
            urllib.request.urlopen(request, timeout=5).close()
    except Exception:  # noqa: BLE001 - Discord is best effort
        pass


def die(msg):
    sys.exit(f"[gamedev-deploy] {msg}")


def find_bash():
    """Prefer Git for Windows' wrapper bash.

    `shutil.which("bash")` tends to resolve Git\\usr\\bin\\bash.exe (the internal one) or WSL's
    bash, and neither opens a C:/... path handed to it from Windows. Git\\bin\\bash.exe does.
    """
    if os.environ.get("BUW_BASH"):
        return os.environ["BUW_BASH"]
    for candidate in (r"C:\Program Files\Git\bin\bash.exe",
                      r"C:\Program Files (x86)\Git\bin\bash.exe"):
        if Path(candidate).is_file():
            return candidate
    found = shutil.which("bash")
    if not found:
        die("No bash found. Install Git for Windows, or set BUW_BASH to a bash that can open C:/ paths.")
    return found


def run_build_script(name, args):
    """Run one of the build repo's own scripts. Never reimplement them here."""
    script = SCRIPTS / name
    if not script.is_file():
        die(f"The build repo's {name} is missing ({script}).\n"
            f"Tell the user; do not write a replacement script.")
    # bash treats a backslash as an escape, so a Windows path arrives mangled.
    # as_posix() gives C:/Users/... which git-bash and the scripts both handle.
    return subprocess.call([find_bash(), script.as_posix(), *args], cwd=str(BUILDS))


def choose_target():
    """No target given. Ask — never guess, because two of the three publish."""
    print("Where should this build go?\n")
    for key, desc in targets().items():
        print(f"  {key:<6} {desc}")
    print()
    # isatty() is not reliable here (git-bash, piped agent shells), so let the read decide.
    try:
        choice = input("local, web or itch? ").strip().lower()
    except EOFError:
        die("No target given, and nothing here to prompt with.\n"
            "Ask the user which of local / web / itch they want, then re-run with that target.")
    if choice not in targets():
        die(f"'{choice}' is not one of: {', '.join(targets())}")
    return choice


def serve_local(build_dir, port, host):
    """Serve a Unity WebGL build locally.

    Unity compresses .data/.wasm/.framework.js to .gz (or .br). A plain static server hands those
    back as opaque files and the loader fails with a blank canvas, so set Content-Encoding and the
    Content-Type of the *inner* file, exactly as sync-game.sh does when uploading to S3.
    """
    from http.server import HTTPServer, SimpleHTTPRequestHandler

    inner_types = {".wasm": "application/wasm", ".js": "application/javascript",
                   ".data": "application/octet-stream", ".symbols": "application/octet-stream"}

    class Handler(SimpleHTTPRequestHandler):
        def end_headers(self):
            path = self.path.split("?")[0]
            if path.endswith(".gz"):
                self.send_header("Content-Encoding", "gzip")
            elif path.endswith(".br"):
                self.send_header("Content-Encoding", "br")
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def guess_type(self, path):
            base = path[:-3] if path.endswith((".gz", ".br")) else path
            for ext, mime in inner_types.items():
                if base.endswith(ext):
                    return mime
            return super().guess_type(path)

        def log_message(self, fmt, *args):
            pass  # a build loads hundreds of files; the access log drowns everything else

    if not (build_dir / "index.html").is_file():
        die(f"{build_dir} has no index.html — is it a WebGL build directory?")

    httpd = HTTPServer(("127.0.0.1", port), partial(Handler, directory=str(build_dir)))
    print(f"Serving {build_dir}\n  http://127.0.0.1:{port}/\n\nCtrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help", "help"):
        sys.exit(__doc__)
    cmd, rest = argv[0], argv[1:]

    if cmd == "guide":
        if not SKILL.is_file():
            die(f"Skill not found at {SKILL}")
        sys.stdout.reconfigure(encoding="utf-8")
        print(SKILL.read_text(encoding="utf-8"))
        return 0

    if not BUILDS.is_dir():
        die(f"The build repo is not at {BUILDS}.\n"
            f"Set BUW_UNITY_BUILDS to its path. Do not create a new build pipeline.")

    if cmd == "build":
        if len(rest) < 1:
            die("Usage: build <project-dir> [output-dir]")
        project = rest[0]
        output = rest[1] if len(rest) > 1 else f"web/{Path(project).name}_web"
        print(f"Building {project} -> {output}\nThis takes a while, and the project must not be "
              f"open in the Unity editor.")
        return run_build_script("build_for_web.sh", [project, output])

    if cmd == "list":
        return run_build_script("sync-game.sh", ["list"])

    if cmd == "deploy":
        if not rest:
            die("Usage: deploy <build-dir>")
        target = choose_target()
        return main_dispatch(target, rest)

    if cmd in ("local", "web", "itch"):
        return main_dispatch(cmd, rest)

    if cmd == "delete":
        if not rest:
            die("Usage: delete <slug>")
        slug = rest[0]
        site = public_url()
        try:
            if input(f"Delete '{slug}' from {site}? [y/N] ").strip().lower() != "y":
                die("Cancelled.")
        except EOFError:
            die(f"Refusing to delete '{slug}' unprompted. Confirm with the user first.")
        return run_build_script("sync-game.sh", ["delete", slug])

    die(f"Unknown command '{cmd}'. Run with --help.")


def main_dispatch(target, rest):
    if target == "local":
        if not rest:
            die("Usage: local <build-dir> [--port N]")
        build_dir = Path(rest[0])
        if not build_dir.is_absolute():
            build_dir = (BUILDS / build_dir) if not build_dir.exists() else build_dir.resolve()
        port = 8080
        if "--port" in rest:
            port = int(rest[rest.index("--port") + 1])
        # Loopback by default. --lan binds all interfaces so a phone on the LAN can play it.
        host = "0.0.0.0" if "--lan" in rest else "127.0.0.1"
        if "--lan" in rest:
            print(f"On the LAN: http://{require('BUW_PC_LAN_IP', 'lanIp')}:{port}/")
        return serve_local(build_dir, port, host)

    if target == "web":
        if len(rest) < 2:
            die(f"Usage: web <slug> <build-dir>\n"
                f"Use the slug already in {SCRIPTS / '.deploy-map'} when updating an existing game, "
                f"or it deploys to a second URL.")
        slug, build_dir = rest[0], rest[1]
        site = public_url()
        rc = run_build_script("sync-game.sh", [slug, build_dir])
        if rc == 0:
            print(f"\n{site}/{slug}/\n"
                  f"CloudFront is invalidated on deploy, so a change can take a minute to show.")
            post_deploy_event(f"Deployed {slug} to the web", f"{site}/{slug}/")
        return rc

    if target == "itch":
        if not rest:
            die("Usage: itch <build-dir> [user/game:channel]")
        print("[gamedev-deploy] itch.io builds are PUBLIC once pushed.")
        rc = run_build_script("sync-game.sh", ["itch", *rest])
        if rc == 0:
            # An optional target "user/game:channel" gives the page; else the account's page.
            page = setting("BUW_ITCH_URL", "itch", "url")
            if len(rest) > 1 and "/" in rest[1]:
                user, game = rest[1].split(":")[0].split("/", 1)
                page = f"https://{user}.itch.io/{game}"
            page = page or "https://itch.io"
            post_deploy_event(f"Pushed {Path(rest[0]).name} to itch.io", page)
        return rc

    die(f"Unknown target '{target}'")


if __name__ == "__main__":
    sys.exit(main() or 0)
