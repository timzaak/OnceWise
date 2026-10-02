> [项目简述：请在此处填写项目的一句话描述]

These rules apply to every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

## Rule 1 — Think Before Coding
State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what's unclear.

## Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

## Rule 3 — Surgical Changes
Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting.
Don't refactor what isn't broken. Match existing style.

## Rule 4 — Surface conflicts, don't average them
If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

## Rule 5 — Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT they do.
A test that can't fail when business logic changes is wrong.
Before running tests, read `scripts/index.md` from the project root.

## Rule 6 — Checkpoint after every significant step
Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

## Project skills — One-way local sync
`skills/` is the source of truth. `.agents/skills/` contains local installed copies; never edit those copies or copy their changes back into `skills/`.
Before using a project skill, run `python scripts/sync-skills.py --check`. If it reports drift, run `python scripts/sync-skills.py` before loading the skill.
After changing any file under `skills/`, run the sync command and then `--check`. If permissions prevent syncing, report that the installed copies remain stale; do not claim the sync succeeded.
