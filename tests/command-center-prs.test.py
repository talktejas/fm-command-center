#!/usr/bin/env python3
# The PRs tab's reader (command-center.py's waiting_prs): one row per pull
# request a home's task records name and firstmate's poll has not seen merged.
# Throwaway homes only, no forge. Run with `python3 tests/command-center-prs.test.py`.
import importlib.util
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("command_center", os.path.join(ROOT, "command-center.py"))
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)

with tempfile.TemporaryDirectory(prefix="command-center-prs.") as tmp:
    home = os.path.join(tmp, "home")
    state = os.path.join(home, "state")
    os.makedirs(state)
    os.makedirs(os.path.join(home, "data"))
    cc.FIRSTMATE_ROOT = tmp   # no .tasks.toml here: the default backlog path is read
    wt = os.path.join(tmp, "wt")
    subprocess.run(["git", "init", "-q", "-b", "fm/dash", wt], check=True)

    def write(name, text):
        with open(os.path.join(state, name), "w", encoding="utf-8") as fh:
            fh.write(text)

    url = "https://github.com/o/r/pull/226"
    write("dash.meta", f"worktree={wt}\nproject=/x/projects/jt2627s\nbase=integration/diamond\npr={url}\n")
    write("dash.status", "working: [2026-09-28T05:00:00Z] setup\n"
                         f"done: [2026-09-28T05:14:01Z] PR {url}\n")
    write("merged.meta", "project=/x/projects/koin\npr=https://github.com/o/k/pull/6\n")
    write("merged.pr-poll-merge-notified", "fm-pr-poll-merge-notified-v1\n")
    write("nopr.meta", "project=/x/projects/koin\n")
    write("bare.meta", "pr=https://github.com/o/k/pull/9\n")
    with open(os.path.join(home, "data", "backlog.md"), "w", encoding="utf-8") as fh:
        fh.write("## In flight\n- [ ] dash - The Diamonds dashboard is a placeholder "
                 "(repo: jt2627s) (kind: ship) (since 2026-09-24)\n")

    rows = {r["id"]: r for r in cc.waiting_prs([{"id": "main", "path": home},
                                                {"id": "gone", "path": os.path.join(tmp, "nope")}])}
    assert sorted(rows) == ["bare", "dash"], sorted(rows)
    dash = rows["dash"]
    assert dash["url"] == url and dash["home"] == "main"
    assert dash["title"] == "The Diamonds dashboard is a placeholder", dash["title"]
    assert (dash["project"], dash["branch"], dash["base"]) == ("jt2627s", "fm/dash", "integration/diamond")
    assert dash["since_epoch"] == 1790572441, dash["since_epoch"]
    # A missing field never hides the row and is never guessed.
    bare = rows["bare"]
    assert (bare["title"], bare["project"], bare["branch"], bare["base"]) == (None, None, None, None)

print(1)
