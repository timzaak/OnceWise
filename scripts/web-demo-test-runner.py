#!/usr/bin/env python
"""
Demo test runner.

Only invokes Playwright to run extension demo cases and persist logs; the
environment is self-managed by fixtures/cases (see demo/e2e/extension/), and
this script starts no services.
"""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

from lib.cli import require_executable
from lib.paths import REPO_ROOT


def escape_regex_pattern(pattern: str) -> str:
    """Escape special regex characters so the pattern matches literally."""
    result = re.escape(pattern)
    # Keep Playwright's test-title hierarchy separator readable in --grep.
    return result.replace("\\>", ">")


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line argument parser."""
    parser = argparse.ArgumentParser(
        description="Demo test runner (extension fixtures manage their own environment; this script starts no services)"
    )
    parser.add_argument("test_file", nargs="?", default="", help="Test file or directory")
    parser.add_argument(
        "--mode",
        default="fast",
        choices=["fast", "full"],
        help="Test mode (default: fast)",
    )
    parser.add_argument(
        "--log-level", default="", help="Log level: verbose, mini (default: mini)"
    )
    parser.add_argument("--run-id", default="", help="Run ID for logging")
    parser.add_argument("--grep", default="", help="Filter tests by pattern")
    parser.add_argument("--no-dedup", action="store_true", help="Disable log deduplication")
    parser.add_argument("--no-aggregate", action="store_true", help="Disable log aggregation")
    parser.add_argument("--no-filter", action="store_true", help="Disable log filtering")
    parser.add_argument("--verbose-log", action="store_true", help="Verbose log output")
    parser.add_argument("--quiet-mode", action="store_true", help="Quiet mode (minimal output)")
    parser.add_argument("--list-tests", action="store_true", help="List tests without running")
    parser.add_argument("--compact", action="store_true", help="Compact log format")
    return parser


def prepare_run_log_dir(demo_dir: Path, run_id: str) -> Path:
    """Clean stale Playwright artifacts and create the isolated run log directory."""
    for relative in ("test-results/artifacts", "playwright-report"):
        path = demo_dir / relative
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)

    log_dir = demo_dir / "test-results" / "runs" / run_id
    if log_dir.exists():
        shutil.rmtree(log_dir, ignore_errors=True)
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir


def run_tests(
    test_file: str,
    mode: str,
    log_level: str,
    run_id: str | None,
    grep: str,
    no_dedup: bool,
    no_aggregate: bool,
    no_filter: bool,
    verbose_log: bool,
    quiet_mode: bool,
    list_tests: bool,
    compact: bool,
) -> int:
    """Run Playwright tests.

    Args:
        test_file: test file path
        mode: test mode
        log_level: log level
        run_id: run ID
        grep: test filter pattern
        no_dedup: disable log deduplication
        no_aggregate: disable log aggregation
        no_filter: disable log filtering
        verbose_log: verbose logging
        quiet_mode: quiet output
        list_tests: list tests only
        compact: compact log format

    Returns:
        Exit code (0 means success)
    """
    demo_dir = REPO_ROOT / "demo"
    if not demo_dir.exists():
        print(f"Error: demo directory not found at: {demo_dir}")
        return 1

    if not test_file:
        print("Usage: uv run scripts/web-demo-test-runner.py [test-file] [options]")
        return 1

    # Playwright testDir is './e2e', so we need path relative to that
    # Input can be: 'demo/e2e/<group>/<scenario>.e2e.ts' or 'e2e/<group>/<scenario>.e2e.ts'
    # Output is relative to demo/e2e/.
    original_test_file = test_file
    test_file = test_file.replace("\\", "/")

    if test_file.startswith("demo/"):
        test_file = test_file[5:]
    if test_file.startswith("e2e/"):
        test_file = test_file[4:]

    if verbose_log:
        print(f"[DEBUG] Original test file path: {original_test_file}")
        print(f"[DEBUG] Normalized test file path: {test_file}")
        print(f"[DEBUG] Current working directory: {os.getcwd()}")

    test_file_full = demo_dir / "e2e" / test_file
    if not test_file_full.exists():
        print(f"Error: Test file not found at: {test_file_full}")
        print(f"Original input: {original_test_file}")
        print(f"Transformed to: {test_file}")
        print(f"Expected location: {test_file_full}")
        return 1

    if verbose_log:
        log_level = "verbose"
    elif quiet_mode:
        log_level = "mini"
    if not log_level:
        log_level = "mini"

    os.chdir(demo_dir)

    # runs/ is the evidence source for diagnostics and batch reports; only the current
    # run_id is overwritten.
    run_id = run_id or f"run-{time.strftime('%Y%m%d-%H%M%S')}"
    log_dir = prepare_run_log_dir(demo_dir, run_id).relative_to(demo_dir)
    playwright_log = log_dir / "playwright-output.log"

    abs_playwright_log = playwright_log.resolve()
    env = dict(os.environ)
    env["DEMO_LOG_LEVEL"] = log_level
    env["DEMO_LOG_DEDUP"] = "false" if no_dedup else "true"
    env["DEMO_LOG_AGGREGATE"] = "false" if no_aggregate else "true"
    env["DEMO_LOG_FILTER"] = "false" if no_filter else "true"
    env["DEMO_RUN_ID"] = run_id
    env["DEMO_LOG_COMPACT"] = "true" if compact else "false"
    env["DEBUG"] = env.get("DEBUG", "pw:api")

    npx = require_executable("npx", windows_fallback="npx.cmd")
    cmd = [npx, "playwright", "test", test_file, "--project=demo-fast"]
    if grep:
        escaped_grep = escape_regex_pattern(grep)
        cmd.append(f"--grep={escaped_grep}")
        if verbose_log:
            print(f"[DEBUG] Original grep pattern: {grep}")
            print(f"[DEBUG] Escaped grep pattern: {escaped_grep}")
    if list_tests:
        cmd.append("--list")
        print(f"Listing tests in: {test_file}")
    else:
        cmd.append("--quiet")

    if verbose_log:
        print(f"[DEBUG] Working directory: {os.getcwd()}")
        print(f"[DEBUG] Playwright command: {' '.join(shlex.quote(arg) for arg in cmd)}")

    start = time.time()
    exit_code = -1
    with playwright_log.open("w", encoding="utf-8") as log_fp:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            log_fp.write(line)
            if list_tests:
                # Windows console encoding-safe output handling
                try:
                    print(line, end="")
                except UnicodeEncodeError:
                    print(
                        line.encode("ascii", errors="replace").decode("ascii"), end=""
                    )
        exit_code = proc.wait()
    duration = round(time.time() - start, 1)

    all_skipped = False
    if not list_tests and exit_code == 0:
        log_content = playwright_log.read_text(encoding="utf-8", errors="replace")
        has_passed = bool(re.search(r"\d+ passed", log_content))
        has_failed = bool(re.search(r"\d+ failed", log_content))
        has_skipped = bool(re.search(r"\d+ skipped", log_content))
        if has_skipped and not has_passed and not has_failed:
            all_skipped = True
            exit_code = 2

    summary = {
        "success": "true" if exit_code == 0 else "false",
        "fixed": "false",
        "logs": str(log_dir).replace("\\", "/"),
        "exitCode": exit_code,
        "testFile": test_file,
        "mode": mode,
        "logLevel": log_level,
        "duration": duration,
        "runId": run_id,
        "grep": grep,
    }
    if all_skipped:
        summary["error"] = "All tests skipped"

    if not list_tests and exit_code != 0:
        if all_skipped:
            print("[!] All tests were skipped; no tests actually executed")
        try:
            print(f"✗ Failed ({exit_code})")
        except UnicodeEncodeError:
            print(f"[X] Failed ({exit_code})")
        unified_logs_dir = (demo_dir / "test-results" / "unified-logs").resolve()
        service_log_dir = (REPO_ROOT / "log").resolve()
        print(f"  Playwright: {abs_playwright_log}")
        print(f"  Unified: {unified_logs_dir}/{run_id}-*")
        print(f"  Backend: {service_log_dir}/backend-demo.log.*")
    print(f"Result: {json.dumps(summary, ensure_ascii=False, separators=(',', ':'))}")

    return exit_code


def main() -> int:
    args = build_parser().parse_args()

    exit_code = run_tests(
        test_file=args.test_file,
        mode=args.mode,
        log_level=args.log_level,
        run_id=args.run_id,
        grep=args.grep,
        no_dedup=args.no_dedup,
        no_aggregate=args.no_aggregate,
        no_filter=args.no_filter,
        verbose_log=args.verbose_log,
        quiet_mode=args.quiet_mode,
        list_tests=args.list_tests,
        compact=args.compact,
    )

    return exit_code


if __name__ == "__main__":
    sys.exit(main())


