#!/usr/bin/env python
"""OnceWise AI 版本发布：更新产品版本文件，验证后创建 release commit 和 vX.Y.Z 标签。

版本载体是 extension/package.json（连同 package-lock.json 的根版本）和
.claude-plugin/marketplace.json 的 oncewise 插件条目。backend/ 与 demo/ 各自维护
版本，不随本脚本变动。注意：每个 vX.Y.Z 标签都会触发 .github/workflows/cd.yml
的 GitHub Release；后端镜像仅当 backend/ 或 docker/Dockerfile 相对上一版本有
改动时才重新构建，否则跳过构建、直接将上一版镜像别名到新版本 tag。仓库变量
CWS_UPLOAD_ENABLED=true 时，同一 CD 还会把剥 key 的商店包上传为控制台新版本
草稿（仅草稿不提审，一次性配置见 docs/store-listing/README.md 步骤 5）。
"""

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from lib.cli import require_executable, run_cmd
from lib.paths import REPO_ROOT


SEMVER_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")

PLUGIN_NAME = "oncewise"
RELEASE_PATHS = [
    "extension/package.json",
    "extension/package-lock.json",
    ".claude-plugin/marketplace.json",
]


@dataclass(frozen=True)
class Semver:
    major: int
    minor: int
    patch: int

    @classmethod
    def parse(cls, text: str) -> "Semver":
        match = SEMVER_RE.fullmatch(text.strip())
        if not match:
            raise ValueError(f"Invalid version '{text}'. Use X.Y.Z or vX.Y.Z.")
        return cls(*(int(part) for part in match.groups()))

    def bump_patch(self) -> "Semver":
        return Semver(self.major, self.minor, self.patch + 1)

    def __str__(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}"


@dataclass(frozen=True)
class FileChange:
    path: Path
    before: str | None
    after: str


def git(*args: str, capture: bool = False):
    git_bin = require_executable("git")
    return run_cmd([git_bin, *args], cwd=REPO_ROOT, capture=capture)


def ensure_success(result, message: str) -> None:
    if result.returncode != 0:
        raise RuntimeError(message)


def ensure_on_main() -> None:
    result = git("branch", "--show-current", capture=True)
    ensure_success(result, "Unable to determine current git branch.")
    branch = result.stdout.strip()
    if branch != "main":
        raise RuntimeError(f"Release must run on main, current branch is '{branch}'.")


def ensure_clean_worktree() -> None:
    result = git("status", "--porcelain", capture=True)
    ensure_success(result, "Unable to inspect git status.")
    if result.stdout.strip():
        raise RuntimeError("Working tree is not clean. Commit or stash changes before release.")


def ensure_remote_access() -> None:
    result = git("ls-remote", "--exit-code", "origin", capture=True)
    ensure_success(result, "Remote 'origin' is not accessible.")


def list_tags() -> list[str]:
    result = git("tag", "--list", capture=True)
    ensure_success(result, "Unable to list git tags.")
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def latest_semver_tag(tags: list[str]) -> Semver | None:
    versions: list[Semver] = []
    for tag in tags:
        try:
            versions.append(Semver.parse(tag))
        except ValueError:
            continue
    if not versions:
        return None
    return max(versions, key=lambda item: (item.major, item.minor, item.patch))


def ensure_tag_available(version: str, tags: list[str]) -> None:
    conflicts = [tag for tag in (version, f"v{version}") if tag in tags]
    if conflicts:
        raise RuntimeError(f"Tag conflict: {', '.join(conflicts)} already exists.")

    remote = git("ls-remote", "--tags", "origin", version, f"v{version}", capture=True)
    ensure_success(remote, "Unable to inspect remote tags.")
    remote_conflicts = []
    for line in remote.stdout.splitlines():
        if "refs/tags/" in line:
            remote_conflicts.append(line.rsplit("refs/tags/", 1)[1].removesuffix("^{}"))
    if remote_conflicts:
        unique = sorted(set(remote_conflicts))
        raise RuntimeError(f"Remote tag conflict: {', '.join(unique)} already exists.")


def update_package_json(path: Path, version: str) -> FileChange | None:
    if not path.is_file():
        return None

    data = json.loads(path.read_text(encoding="utf-8"))
    before = data.get("version")
    data["version"] = version
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return FileChange(path, before, version)


def update_package_lock(path: Path, version: str) -> FileChange | None:
    if not path.is_file():
        return None

    data = json.loads(path.read_text(encoding="utf-8"))
    before = data.get("version")
    data["version"] = version
    root_entry = data.get("packages", {}).get("")
    if root_entry is not None:
        root_entry["version"] = version
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return FileChange(path, before, version)


def update_marketplace_version(path: Path, version: str) -> FileChange | None:
    if not path.is_file():
        return None

    data = json.loads(path.read_text(encoding="utf-8"))
    entry = next((p for p in data.get("plugins", []) if p.get("name") == PLUGIN_NAME), None)
    if entry is None:
        raise RuntimeError(f"No '{PLUGIN_NAME}' plugin entry in {path}.")
    before = entry.get("version")
    entry["version"] = version
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return FileChange(path, before, version)


def update_version_files(version: str) -> list[FileChange]:
    extension_dir = REPO_ROOT / "extension"
    candidates = (
        update_package_json(extension_dir / "package.json", version),
        update_package_lock(extension_dir / "package-lock.json", version),
        update_marketplace_version(REPO_ROOT / ".claude-plugin" / "marketplace.json", version),
    )
    changes = [change for change in candidates if change]
    if not changes:
        raise RuntimeError("No supported version files found.")
    return changes


def run_validation() -> None:
    npm = require_executable("npm", "npm.cmd")
    extension_dir = REPO_ROOT / "extension"
    for script_name in ("compile", "test:run"):
        cmd = [npm, "run", script_name]
        print(f"Running: {' '.join(cmd)} (cwd: {extension_dir.relative_to(REPO_ROOT)})", flush=True)
        result = run_cmd(cmd, cwd=extension_dir)
        if result.returncode != 0:
            raise RuntimeError(f"Validation failed: {' '.join(cmd)}")


def commit_tag_and_push(version: str, push: bool) -> str:
    release_tag = f"v{version}"
    existing_paths = [path for path in RELEASE_PATHS if (REPO_ROOT / path).exists()]
    add = git("add", *existing_paths)
    ensure_success(add, "Unable to stage release files.")

    staged = git("diff", "--cached", "--quiet")
    if staged.returncode == 0:
        raise RuntimeError(f"No version file changes detected for {version}.")

    commit = git("commit", "-m", f"chore: bump version to {version}")
    ensure_success(commit, "Unable to create release commit.")

    tag = git("tag", release_tag)
    ensure_success(tag, f"Unable to create tag {release_tag}.")

    rev = git("rev-parse", "--short", "HEAD", capture=True)
    ensure_success(rev, "Unable to resolve release commit hash.")
    commit_hash = rev.stdout.strip()

    if push:
        push_commit = git("push")
        if push_commit.returncode != 0:
            raise RuntimeError(f"Push failed. Commit {commit_hash} and tag {release_tag} remain local.")

        push_tag = git("push", "origin", release_tag)
        if push_tag.returncode != 0:
            raise RuntimeError(f"Tag push failed. Commit {commit_hash} and tag {release_tag} remain local.")

    return commit_hash


def resolve_target_version(raw_version: str | None, assume_yes: bool, tags: list[str]) -> str:
    if raw_version:
        version = str(Semver.parse(raw_version))
        if raw_version.startswith("v"):
            print(f"Normalized input version {raw_version} -> {version}; release tag will be v{version}.")
        return version

    latest = latest_semver_tag(tags)
    recommendation = str(latest.bump_patch() if latest else Semver(0, 1, 0))
    if not assume_yes:
        latest_text = str(latest) if latest else "none"
        raise RuntimeError(
            f"Recommended version is {recommendation} based on latest semver tag {latest_text}. "
            "Re-run with this version or pass --yes to accept the recommendation."
        )
    return recommendation


def main() -> int:
    parser = argparse.ArgumentParser(description="Release project version with v-prefixed git tags.")
    parser.add_argument("version", nargs="?", help="Target version, X.Y.Z or vX.Y.Z. Final tag is always vX.Y.Z.")
    parser.add_argument("--yes", action="store_true", help="Accept the auto-recommended version when version is omitted.")
    parser.add_argument("--no-push", action="store_true", help="Create the release commit and tag locally without pushing.")
    parser.add_argument("--dry-run", action="store_true", help="Run preflight checks and print the resolved version without editing files.")
    args = parser.parse_args()

    try:
        ensure_on_main()
        ensure_clean_worktree()
        ensure_remote_access()
        tags = list_tags()
        version = resolve_target_version(args.version, args.yes, tags)
        ensure_tag_available(version, tags)

        print(f"Release version: {version}")
        release_tag = f"v{version}"
        print(f"Release tag: {release_tag}")
        if args.dry_run:
            return 0

        changes = update_version_files(version)
        for change in changes:
            rel_path = change.path.relative_to(REPO_ROOT)
            before = change.before if change.before is not None else "<missing>"
            print(f"Updated {rel_path}: {before} -> {change.after}")

        run_validation()
        commit_hash = commit_tag_and_push(version, push=not args.no_push)
        push_text = "pushed" if not args.no_push else "created locally"
        print(f"Release {version} {push_text}: commit {commit_hash}, tag {release_tag}")
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
