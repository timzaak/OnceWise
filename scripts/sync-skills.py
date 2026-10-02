#!/usr/bin/env python
"""Mirror repository skills into the local agent installation, never in reverse."""
import argparse
from pathlib import Path
import sys
import time


REPO_ROOT = Path(__file__).resolve().parents[1]


def reject_links(path: Path) -> None:
    for entry in (path, *path.parents):
        if entry.is_symlink() or (hasattr(entry, "is_junction") and entry.is_junction()):
            raise ValueError(f"Refusing linked path: {entry}")


def read_tree(root: Path) -> tuple[dict[Path, bytes], set[Path]]:
    reject_links(root)
    if not root.exists():
        return {}, set()
    if not root.is_dir():
        raise ValueError(f"Expected a directory: {root}")
    files = {}
    directories = set()
    for entry in root.rglob("*"):
        reject_links(entry)
        relative = entry.relative_to(root)
        if entry.is_dir():
            directories.add(relative)
        elif entry.is_file():
            files[relative] = entry.read_bytes()
        else:
            raise ValueError(f"Unsupported entry: {entry}")
    return files, directories


def sync_skills(source: Path, target: Path, *, check: bool = False) -> list[str]:
    reject_links(source)
    reject_links(target)
    source = source.resolve()
    target = target.resolve()
    if source == target or source in target.parents or target in source.parents:
        raise ValueError("Source and target must be separate directories")
    skills = sorted(entry for entry in source.iterdir() if (entry / "SKILL.md").is_file())
    if not skills:
        raise ValueError(f"No skills found in {source}; refusing to change the installation")

    # Plan every managed skill before writing. Other installed skills are left alone.
    changes = []
    for skill in skills:
        files, directories = read_tree(skill)
        destination = target / skill.name
        old_files, old_directories = read_tree(destination)
        for relative in sorted(old_files.keys() - files.keys()):
            changes.append(("delete", destination / relative, None))
        for relative in sorted(old_directories - directories, key=lambda p: len(p.parts), reverse=True):
            changes.append(("rmdir", destination / relative, None))
        if not destination.exists():
            changes.append(("mkdir", destination, None))
        for relative in sorted(directories - old_directories, key=lambda p: len(p.parts)):
            changes.append(("mkdir", destination / relative, None))
        for relative, content in sorted(files.items()):
            if old_files.get(relative) != content:
                changes.append(("write", destination / relative, content))

    if not check:
        for operation, path, content in changes:
            # Recheck containment and links before each mutation, including deletions.
            reject_links(path)
            if not path.resolve().is_relative_to(target):
                raise ValueError(f"Target escaped the installation: {path}")
            if operation == "delete":
                path.unlink()
            elif operation == "rmdir":
                path.rmdir()
            elif operation == "mkdir":
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.write_bytes(content)
    return [f"{operation}: {path.relative_to(target)}" for operation, path, _ in changes]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Report drift without writing; exit 1 on drift")
    mode.add_argument("--watch", action="store_true", help="Keep synchronizing once per second until Ctrl+C")
    args = parser.parse_args()
    source = REPO_ROOT / "skills"
    target = REPO_ROOT / ".agents" / "skills"
    try:
        first = True
        while True:
            changes = sync_skills(source, target, check=args.check)
            if changes:
                print("\n".join(changes), flush=True)
            if first or changes:
                status = "out of sync" if args.check and changes else "in sync"
                print(f"skills/ -> .agents/skills/: {status}", flush=True)
            if not args.watch:
                return 1 if args.check and changes else 0
            first = False
            time.sleep(1)
    except KeyboardInterrupt:
        return 0
    except (OSError, ValueError) as error:
        print(f"Skill sync failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
