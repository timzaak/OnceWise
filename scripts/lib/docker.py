"""Minimal docker CLI helpers (ported from the rmqtt-things test tooling pattern)."""

import subprocess
import sys

from .cli import require_executable, run_cmd


def _run(args: list[str]) -> subprocess.CompletedProcess[str]:
    # run_cmd fixes utf-8/replace decoding (docker CLI output is not locale-trustworthy on
    # localized Windows, same lesson as proc.py / demo_session's taskkill handling).
    return run_cmd([require_executable("docker"), *args], capture=True)


def _log_error(subcmd: str, stderr: str) -> None:
    print(f"docker {subcmd} failed: {stderr.strip()}", file=sys.stderr)


def run_detached(args: list[str]) -> bool:
    result = _run(["run", "-d", *args])
    if result.returncode != 0:
        _log_error("run", result.stderr)
    return result.returncode == 0


def rm_force_container(name: str) -> None:
    _run(["rm", "-f", name])


def exec_check(container: str, args: list[str]) -> tuple[int, str]:
    result = _run(["exec", container, *args])
    output = result.stdout.strip() if result.returncode == 0 else result.stderr.strip()
    return result.returncode, output
