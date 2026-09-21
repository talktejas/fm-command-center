# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## This repo

Standalone extraction of firstmate's command center (originally `bin/command-center.py` etc. in `talktejas/firstmate`). See [README.md](README.md) for running it and [docs/command-center.md](docs/command-center.md) for full behaviour.

- **Never copy or edit firstmate's own scripts.** This repo calls them by path from `--firstmate-root` / `$FM_FIRSTMATE_ROOT` (default `/home/tds/p/firstmate`): `fm-captain-hold.sh`, `fm-send.sh`, `fm-inbox.sh`, `fm-captain-message-sweep.py`, `fm-classify-lib.sh`, `fm-busy-lib.sh`, `fm-secondmate-registry-lib.sh` (sourced by `command-center-scan.sh`), `fm-bearings-snapshot.sh` (wrapped by `command-center-work.sh`). If firstmate's own interface changes, fix the call site here, not the other repo.
- Layout: `command-center.py`, `command-center-scan.sh` and `command-center-work.sh` at the root; the browser page in `web/`; tests in `tests/`, doc in `docs/command-center.md`.
- Reading halves are separate scripts by cadence, not one scan: `command-center-scan.sh` (`/api/items`, 3s poll, change-fingerprinted) reads firstmate's own hold/status records; `command-center-work.sh` (`/api/work`, 15s time-cached, no fingerprint) wraps `fm-bearings-snapshot.sh --json`, which does bounded remote-ledger reads too slow for a 3-second cadence. Never fold the slow one into the fast one's poll path.
- Tests (`tests/command-center.test.sh`, `tests/command-center-state.test.js`) run standalone against a throwaway firstmate home and a real (read-only) firstmate checkout for the scripts above — never against the primary firstmate checkout's live state, and never over a browser. Run with `bash tests/command-center.test.sh` and `node tests/command-center-state.test.js`.
- `test_the_click_returns_before_the_command_finishes` in `tests/command-center.test.sh` is flaky under load (times out waiting on `/api/answer`); confirm against an unmodified checkout before treating a failure there as a regression.
- When pulling a behavioural change from firstmate's copy of these files (e.g. a PR against `talktejas/firstmate`), port only the command-center-specific diff — firstmate's own script signatures may have drifted independently and should be left alone here.
- Every answer sent from **Waiting on you** goes through `deliver_certainly` (`command-center.py`): the guaranteed `fm-inbox.sh note` write always runs first, so the item never reads "not sent" once it lands; the item's own keyed decision route (`fm-captain-hold.sh answer` / `fm-send.sh`) then runs as a bonus behind it, and a bonus failure only degrades the item's detail text, never its outcome. See "Where your answer goes" in `docs/command-center.md`.
- A test that spins up a throwaway `--firstmate-root` (symlinking real `bin/*` in) must also symlink `.tasks.toml` from the real root, or `command-center-scan.sh` reports every backlog as unreadable.
- `command-center.py`'s `enrich_message*` functions (see the comment above `# --- message context enrichment`) fill a message's project/worktree/branch beyond what firstmate's own sweep/backfill recorded, at read time only, from the live scan, the backlog file, `data/projects.md` and (`transcript_task_ids`) the captured row's own `session`/`req` read straight from its Claude conversation transcript. The captain's own order of precedence, enforced in `message_context`: the worker/task the turn was actually handling is checked first and is the only source used once it names anything; only when it names nothing does the message's own words get checked, against every task id and a per-project alias table (`project_aliases`, `data/projects.md` plus `FIXED_PROJECT_ALIASES`). Nothing is ever invented - a row neither tier can place reads "Not recorded", same as an unfilled worktree/branch. See `docs/command-center.md`'s Messages section for the exact rule.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
