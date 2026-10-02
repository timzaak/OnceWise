"""Manual demo session management.

Startup: build the extension -> optionally start the oncewise-ai-sync backend (fixed port +
persistent PostgreSQL database) -> start the host test pages (extension/test-pages) -> launch a
browser with the extension loaded (persistent profile). All ports are fixed and the
session state is written to disk so demo-stop.py can clean up precisely. This differs
from the test harness (demo/e2e/extension/): tests use a random port plus a throwaway
profile/database per case, while the manual demo deliberately persists them so grants,
space keys and similar hand gestures survive restarts.
"""

import json
import hashlib
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING

from .cli import require_executable, run_cmd
from .logger import LogLevel
from .net import is_port_open, wait_for_http_ok, wait_for_tcp
from .paths import LOG_DIR, REPO_ROOT, ensure_dir
from .proc import is_running, kill_process_by_port, spawn_background

if TYPE_CHECKING:
    from .logger import Logger

DEFAULT_BACKEND_PORT = 8080
DEFAULT_HOST_PORT = 8899
DEFAULT_DEBUG_PORT = 9222

# The demo backend's PostgreSQL: nothing listens on 127.0.0.1:5432 -> start the local
# docker container (postgres:18-alpine is expected to be present locally, no pull).
# demo-stop.py stops the container: the named container keeps its data, and the next
# demo-start revives it via `docker start` (see stop_demo_postgres).
DEMO_PG_CONTAINER = "oncewise-demo-pg"
DEMO_PG_PORT = 5432
DEMO_DATABASE_URL_DEFAULT = "postgres://postgres:postgres@127.0.0.1:5432/oncewise_demo_manual"

EXTENSION_DIR = REPO_ROOT / "extension"
EXTENSION_BUILD = EXTENSION_DIR / ".output" / "chrome-mv3"
TEST_PAGES_DIR = EXTENSION_DIR / "test-pages"
SYNC_BINARY_NAME = f"oncewise-ai-sync{'.exe' if os.name == 'nt' else ''}"

# Persistent manual-demo state lives under log/ (gitignored): browser profile,
# session PIDs. Backend data lives in the local PostgreSQL database instead.
DEMO_PROFILE_DIR = LOG_DIR / "demo-profile"
STATE_FILE = LOG_DIR / "demo-state.json"


def build_extension(logger: "Logger") -> None:
    """Build the MV3 production bundle; runs npm install first when node_modules is missing."""
    npm = require_executable("npm", windows_fallback="npm.cmd")
    if not (EXTENSION_DIR / "node_modules").is_dir():
        logger.info("extension/node_modules missing; running npm install ...")
        result = run_cmd([npm, "install"], cwd=EXTENSION_DIR)
        if result.returncode != 0:
            raise RuntimeError(f"npm install failed:\n{result.stdout}\n{result.stderr}")
    logger.info("Building extension (npm run build) ...")
    result = run_cmd([npm, "run", "build"], cwd=EXTENSION_DIR)
    if result.returncode != 0:
        raise RuntimeError(f"npm run build failed:\n{result.stdout}\n{result.stderr}")
    if not (EXTENSION_BUILD / "manifest.json").is_file():
        raise RuntimeError(f"Build did not produce {EXTENSION_BUILD / 'manifest.json'}")


def resolve_sync_binary(logger: "Logger") -> Path:
    """Same resolution order as demo/e2e/extension/sync-server.ts: ONCEWISE_AI_SYNC_BIN -> release -> debug -> cargo build."""
    env_bin = os.environ.get("ONCEWISE_AI_SYNC_BIN")
    if env_bin:
        candidate = Path(env_bin)
        if not candidate.is_absolute():
            candidate = REPO_ROOT / candidate
        if not candidate.is_file():
            raise RuntimeError(f"ONCEWISE_AI_SYNC_BIN points to a missing binary: {candidate}")
        return candidate
    for profile in ("release", "debug"):
        candidate = REPO_ROOT / "backend" / "target" / profile / SYNC_BINARY_NAME
        if candidate.is_file():
            return candidate
    logger.info("No prebuilt binary found; running cargo build --release --bin oncewise-ai-sync ...")
    cargo = require_executable("cargo")
    result = run_cmd([cargo, "build", "--release", "--bin", "oncewise-ai-sync"], cwd=REPO_ROOT / "backend")
    if result.returncode != 0:
        raise RuntimeError(f"cargo build failed:\n{result.stdout}\n{result.stderr}")
    built = REPO_ROOT / "backend" / "target" / "release" / SYNC_BINARY_NAME
    if not built.is_file():
        raise RuntimeError("cargo build did not produce the oncewise-ai-sync binary")
    return built


def _demo_database_url() -> str:
    return os.environ.get("DEMO_DATABASE_URL", DEMO_DATABASE_URL_DEFAULT)


def ensure_demo_postgres(logger: "Logger") -> None:
    """Make sure the demo backend has a PostgreSQL to talk to.

    Only manages the default local instance: when nothing listens on 127.0.0.1:5432, start
    (or reuse the stopped) oncewise-demo-pg container from the locally available
    postgres:18-alpine image. A custom DEMO_DATABASE_URL is the user's own responsibility.
    """
    if is_port_open("127.0.0.1", DEMO_PG_PORT):
        return
    docker = shutil.which("docker")
    if docker is None:
        raise RuntimeError(
            "oncewise-ai-sync needs PostgreSQL and nothing listens on 127.0.0.1:5432; "
            "start one yourself or point DEMO_DATABASE_URL at your instance"
        )
    # A stopped container from an earlier session: docker run would fail on the name conflict
    start = run_cmd([docker, "start", DEMO_PG_CONTAINER])
    if start.returncode != 0:
        result = run_cmd([
            docker, "run", "-d", "--name", DEMO_PG_CONTAINER,
            "-e", "POSTGRES_PASSWORD=postgres",
            "-p", f"127.0.0.1:{DEMO_PG_PORT}:5432",
            "postgres:18-alpine",
        ])
        if result.returncode != 0:
            raise RuntimeError(f"failed to start the {DEMO_PG_CONTAINER} container:\n{result.stdout}\n{result.stderr}")
    if not wait_for_tcp("127.0.0.1", DEMO_PG_PORT, 30, logger=logger):
        raise RuntimeError(f"PostgreSQL did not become ready on 127.0.0.1:{DEMO_PG_PORT}")
    # The port can open before logins are accepted (startup recovery); pg_isready is the gate
    for _ in range(30):
        if run_cmd([docker, "exec", DEMO_PG_CONTAINER, "pg_isready", "-U", "postgres"]).returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError(f"PostgreSQL on 127.0.0.1:{DEMO_PG_PORT} never accepted logins")


def stop_demo_postgres(logger: "Logger") -> bool:
    """Stop the demo PostgreSQL container when it is running.

    Only touches the demo-owned oncewise-demo-pg container — a custom DEMO_DATABASE_URL
    is the user's own responsibility, mirroring ensure_demo_postgres. Data survives the
    stop: the named container keeps its volume and the next demo-start revives it with
    `docker start`. Note the sync story tests share this container, so stopping it while
    they run breaks them.
    """
    docker = shutil.which("docker")
    if docker is None:
        return False
    running = run_cmd(
        [docker, "container", "inspect", "-f", "{{.State.Running}}", DEMO_PG_CONTAINER],
        capture=True,
    )
    if running.returncode != 0 or running.stdout.strip() != "true":
        return False
    stopped = run_cmd([docker, "stop", DEMO_PG_CONTAINER], capture=True)
    if stopped.returncode != 0:
        logger.warning(f"failed to stop the {DEMO_PG_CONTAINER} container: {stopped.stdout}{stopped.stderr}")
        return False
    return True


def start_sync_backend(logger: "Logger", binary: Path, port: int) -> int:
    ensure_demo_postgres(logger)
    env = dict(os.environ)
    env.update({
        "BIND_ADDR": f"127.0.0.1:{port}",
        # Persistent manual-demo database: created on first run, survives restarts.
        "DATABASE_URL": _demo_database_url(),
        "CREATE_DB_IF_MISSING": "1",
        "RUST_LOG": "info",
    })
    pid = spawn_background(
        command=[str(binary)],
        cwd=REPO_ROOT / "backend",
        stdout_path=LOG_DIR / "backend-demo.log.out",
        stderr_path=LOG_DIR / "backend-demo.log.err",
        env=env,
    )
    # Readiness uses the same endpoint as the extension's connection probe and
    # sync-server.ts: /api/health returning 200
    if not wait_for_http_ok(f"http://127.0.0.1:{port}/api/health", 30, logger=logger):
        raise RuntimeError(
            f"oncewise-ai-sync health check timed out (http://127.0.0.1:{port}/api/health), "
            f"see {LOG_DIR / 'backend-demo.log.err'}"
        )
    return pid


def start_host_pages(logger: "Logger", port: int) -> int:
    pid = spawn_background(
        command=[
            sys.executable, "-m", "http.server", str(port),
            "--bind", "127.0.0.1", "--directory", str(TEST_PAGES_DIR),
        ],
        cwd=REPO_ROOT,
        stdout_path=LOG_DIR / "host-pages-demo.log.out",
        stderr_path=LOG_DIR / "host-pages-demo.log.err",
    )
    if not wait_for_tcp("127.0.0.1", port, 15, logger=logger):
        raise RuntimeError(f"Host pages server did not become ready on 127.0.0.1:{port}")
    return pid


def _playwright_chromium() -> Path | None:
    """Locate the Playwright-bundled Chromium (same source as the demo fixtures; branded Chrome 137+ disables --load-extension)."""
    if os.name == "nt":
        base = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", Path.home() / "AppData" / "Local" / "ms-playwright"))
    else:
        base = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", Path.home() / ".cache" / "ms-playwright"))
    if not base.is_dir():
        return None
    if os.name == "nt":
        # Newer Playwright uses chrome-win64, older revisions use chrome-win
        exe_rels = [("chrome-win64", "chrome.exe"), ("chrome-win", "chrome.exe")]
    elif sys.platform == "darwin":
        exe_rels = [("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")]
    else:
        exe_rels = [("chrome-linux", "chrome")]
    best: tuple[int, Path] | None = None
    for dir_name in base.iterdir():
        # chromium_headless_shell-* cannot host a headful manual session; match full
        # chromium-<revision> builds only
        if not dir_name.is_dir() or not dir_name.name.startswith("chromium-"):
            continue
        try:
            revision = int(dir_name.name.removeprefix("chromium-"))
        except ValueError:
            continue
        for exe_rel in exe_rels:
            exe = dir_name.joinpath(*exe_rel)
            if exe.is_file() and (best is None or revision > best[0]):
                best = (revision, exe)
    return best[1] if best else None


def _system_chrome() -> Path | None:
    found = shutil.which("chrome") or shutil.which("chrome.exe")
    if found:
        return Path(found)
    if os.name == "nt":
        for candidate in (
            Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google" / "Chrome" / "Application" / "chrome.exe",
            Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google" / "Chrome" / "Application" / "chrome.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
        ):
            if candidate.is_file():
                return candidate
    return None


def launch_browser(logger: "Logger", urls: list[str], debug_port: int | None = DEFAULT_DEBUG_PORT) -> int | None:
    """Launch a browser with the extension loaded using the persistent profile; with
    debug_port, also open Chromium's CDP endpoint on 127.0.0.1:<debug_port> (the dedicated
    profile is a non-default --user-data-dir, so Chrome 136+'s default-profile restriction
    on --remote-debugging-port does not apply). Returns None when no usable browser exists
    (services stay up)."""
    if debug_port is not None and is_port_open("127.0.0.1", debug_port):
        # Chromium silently falls back to an IPv6-only listener when the IPv4 port is
        # taken, and an http://127.0.0.1 attach would then hit the port's real owner
        # instead of the demo browser — refuse instead of misleading.
        raise RuntimeError(
            f"Debug port 127.0.0.1:{debug_port} is already in use by another process. "
            "Free the port, pick another --debug-port, or pass --no-remote-debugging."
        )
    exe = _playwright_chromium()
    if exe:
        logger.info(f"Using Playwright Chromium: {exe}")
    else:
        exe = _system_chrome()
        if not exe:
            logger.warning("No usable browser found. Services are up; open Chrome manually and load "
                           f"the extension per README: {EXTENSION_BUILD}")
            return None
        logger.warning(
            "Playwright Chromium not found; falling back to system Chrome. Note: branded Chrome 137+ "
            f"may ignore --load-extension; if the OnceWise AI toolbar icon is missing, load {EXTENSION_BUILD} "
            "manually per README"
        )
    command = [
        str(exe),
        f"--user-data-dir={ensure_dir(DEMO_PROFILE_DIR)}",
        f"--disable-extensions-except={EXTENSION_BUILD}",
        f"--load-extension={EXTENSION_BUILD}",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if debug_port is not None:
        command.append(f"--remote-debugging-port={debug_port}")
    command += urls
    pid = spawn_background(
        command=command,
        cwd=REPO_ROOT,
        stdout_path=LOG_DIR / "browser-demo.log.out",
        stderr_path=LOG_DIR / "browser-demo.log.err",
    )
    if debug_port is not None and not wait_for_tcp("127.0.0.1", debug_port, 15, logger=logger):
        logger.warning(
            f"Remote debugging did not come up on 127.0.0.1:{debug_port}; an older demo browser "
            "without the debug flag may still hold the profile. Run demo-stop and retry, or pick "
            "another --debug-port."
        )
    return pid


def extension_import_url(build_dir: Path = EXTENSION_BUILD) -> str | None:
    """Derive the unpacked extension's import page URL.

    Chromium generates the --load-extension ID as "SHA-256 of the install path bytes,
    first 32 hex chars mapped to a-p" (UTF-16LE on Windows, UTF-8 on posix; verified
    against the actually loaded ID on this machine). The ID changes whenever the path
    changes, so it is derived from the exact string passed to --load-extension;
    returns None when derivation fails.
    """
    path = str(build_dir)
    raw = path.encode("utf-16-le") if os.name == "nt" else path.encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()
    ext_id = "".join(chr(97 + int(c, 16)) for c in digest[:32])
    if not re.fullmatch(r"[a-p]{32}", ext_id):
        return None
    return f"chrome-extension://{ext_id}/import.html"


def _read_state() -> dict | None:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_state(state: dict) -> None:
    ensure_dir(LOG_DIR)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _kill_pid(pid: int) -> bool:
    if pid <= 0 or not is_running(pid):
        return False
    if os.name == "nt":
        try:
            # taskkill emits GBK on localized Windows; decode leniently like proc.py
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/F", "/T"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                check=False, timeout=10,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            return False
    else:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            return False
    return True


def stop_demo_session(logger: "Logger", *, stop_pg: bool = True) -> bool:
    """Stop by recorded PIDs first, falling back to port-based cleanup (covers leftovers
    with no state file), then the demo PostgreSQL container. demo-start calls this with
    stop_pg=False so its initial cleanup never bounces a perfectly good database.
    Returns True when anything was stopped."""
    state = _read_state()
    if state is None:
        logger.info("No session state file; falling back to default-port cleanup ...")
    backend_port = int(state.get("backend_port", DEFAULT_BACKEND_PORT)) if state else DEFAULT_BACKEND_PORT
    host_port = int(state.get("host_port", DEFAULT_HOST_PORT)) if state else DEFAULT_HOST_PORT

    killed = False
    if state:
        for key, label in (("browser_pid", "browser"), ("backend_pid", "oncewise-ai-sync"), ("host_pid", "host pages")):
            if _kill_pid(int(state.get(key) or 0)):
                logger.info(f"Stopped {label} (pid={state.get(key)})")
                killed = True
    # Recorded PIDs can go stale (crashed processes, leftovers from runs with no state
    # file), so fall back to the ports
    for port, label in ((backend_port, "oncewise-ai-sync port"), (host_port, "host pages port")):
        if is_port_open("127.0.0.1", port):
            if kill_process_by_port(port):
                logger.info(f"Released {label} {port}")
                killed = True

    if stop_pg and stop_demo_postgres(logger):
        logger.info(f"Stopped {DEMO_PG_CONTAINER} container (data persists; next demo-start revives it)")
        killed = True

    STATE_FILE.unlink(missing_ok=True)
    return killed


def start_demo_session(
    logger: "Logger",
    *,
    backend_port: int = DEFAULT_BACKEND_PORT,
    host_port: int = DEFAULT_HOST_PORT,
    debug_port: int | None = DEFAULT_DEBUG_PORT,
    build: bool = True,
    sync: bool = True,
    browser: bool = True,
) -> bool:
    """Start the manual demo environment and print follow-up instructions."""
    ensure_dir(LOG_DIR)
    backend_pid: int | None = None
    host_pid: int | None = None
    browser_pid: int | None = None
    try:
        total_steps = 1 + (1 if build else 0) + (1 if sync else 0) + (1 if browser else 0) + 1
        current = 0

        current += 1
        with logger.step(current, total_steps, "Clean up previous session"):
            stop_demo_session(logger, stop_pg=False)

        if build:
            current += 1
            with logger.step(current, total_steps, "Build extension"):
                build_extension(logger)
        elif not (EXTENSION_BUILD / "manifest.json").is_file():
            raise RuntimeError(f"Extension build missing but --no-build given: {EXTENSION_BUILD}")

        if sync:
            current += 1
            with logger.step(current, total_steps, f"Start oncewise-ai-sync (127.0.0.1:{backend_port})"):
                binary = resolve_sync_binary(logger)
                logger.verbose_info(f"Binary: {binary}")
                backend_pid = start_sync_backend(logger, binary, backend_port)

        current += 1
        with logger.step(current, total_steps, f"Start host test pages (127.0.0.1:{host_port})"):
            host_pid = start_host_pages(logger, host_port)

        if browser:
            current += 1
            with logger.step(current, total_steps, "Launch extension-loaded browser"):
                browser_pid = launch_browser(logger, [
                    f"http://127.0.0.1:{host_port}/form-page.html",
                    f"http://127.0.0.1:{host_port}/packing-page.html?scenario=ok&groups=2&biz=B-0001",
                ], debug_port=debug_port)
    except Exception:
        # Record already-spawned children so demo-stop.py can clean them up; no orphans
        if backend_pid or host_pid or browser_pid:
            _write_state(_collect_state(backend_pid, host_pid, browser_pid, backend_port, host_port))
        raise

    _write_state(_collect_state(backend_pid, host_pid, browser_pid, backend_port, host_port))
    _print_summary(logger, backend_port=backend_port, host_port=host_port, debug_port=debug_port, sync=sync, browser=browser)
    return True


def _collect_state(
    backend_pid: int | None,
    host_pid: int | None,
    browser_pid: int | None,
    backend_port: int,
    host_port: int,
) -> dict:
    return {
        "backend_pid": backend_pid,
        "host_pid": host_pid,
        "browser_pid": browser_pid,
        "backend_port": backend_port,
        "host_port": host_port,
    }


def _print_summary(
    logger: "Logger",
    *,
    backend_port: int,
    host_port: int,
    debug_port: int | None,
    sync: bool,
    browser: bool,
) -> None:
    if logger.level < LogLevel.NORMAL:
        return
    lines = [
        "",
        "Demo environment is ready:",
        f"  Host test pages  http://127.0.0.1:{host_port}/form-page.html",
        f"                   http://127.0.0.1:{host_port}/packing-page.html?scenario=ok&groups=2&biz=B-0001",
    ]
    if sync:
        lines += [
            f"  oncewise-ai-sync       http://127.0.0.1:{backend_port}  (persistent data in log/demo-data)",
        ]
    if browser:
        lines += [
            "  Browser          dedicated profile with the extension (log/demo-profile; grants and settings persist across restarts)",
        ]
        if debug_port is not None:
            lines += [
                f"  Remote debugging http://127.0.0.1:{debug_port}  (CDP; loopback only, closes with demo-stop)",
            ]
        import_url = extension_import_url()
        if import_url:
            lines += [f"  Extension import page  {import_url}"]
    next_steps = [
        "Click the OnceWise AI toolbar icon to open the flow workbench (the extension is loaded in the browser just launched)",
    ]
    if sync:
        next_steps.append(
            f"To use sync, set Server to http://127.0.0.1:{backend_port} in the extension's \"Sync\" tab, then register/create a space"
        )
    if browser and debug_port is not None:
        next_steps.append(
            f"To drive this demo browser with Chrome DevTools MCP: npx chrome-devtools-mcp --browserUrl http://127.0.0.1:{debug_port} "
            "--categoryExtensions=true (extension tools over remote connections need Chrome 149+; see "
            "skills/oncewise-setup/references/mcp-setup.md)"
        )
    else:
        next_steps.append(
            "For Chrome DevTools MCP, follow the official path in skills/oncewise-setup (user confirmation gate)"
        )
    next_steps.append("Stop the environment: uv run scripts/demo-stop.py")
    lines += ["", "Next steps:"]
    lines += [f"  {i}. {text}" for i, text in enumerate(next_steps, start=1)]
    lines += [""]
    for line in lines:
        logger.info(line)
