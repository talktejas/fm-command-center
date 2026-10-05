#!/usr/bin/env python3
# Behavioral regressions for Jev sorting (command-center.py's Sorter). The one
# network call, jev_post, is replaced by a stub in every test: nothing here
# reaches TypeSafe, and no real key is involved. Run with
# `python3 tests/command-center-sort.test.py`; it prints how many tests ran.
import importlib.util
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("command_center", os.path.join(ROOT, "command-center.py"))
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)

KEY = "ts-test-key-never-real"
TMP = tempfile.TemporaryDirectory(prefix="command-center-sort.")
ran = failures = 0


def test(fn):
    global ran, failures
    ran += 1
    try:
        fn()
    except Exception as exc:  # report and keep going, like the node test
        failures += 1
        sys.__stderr__.write(f"not ok - {fn.__name__}\n  {type(exc).__name__}: {exc}\n")


def home(name):
    path = os.path.join(TMP.name, name)
    os.makedirs(os.path.join(path, "data"))
    return path


def reply(choice, confidence):
    rest = (1 - confidence) / 2
    return {"answers": {"sort": {"choice": choice, "confidence": confidence, "probabilities": {
        c: confidence if c == choice else rest for c in cc.SORT_CHOICES}}}}


def odds(criteria, choice, confidence):
    rest = (1 - confidence) / (len(criteria) - 1)
    return {"choice": choice, "confidence": confidence, "probabilities": {
        c: confidence if c == choice else rest for c in criteria}}


REGISTRY = """# Projects
- koin [direct-PR] - Koin, a multi-currency expense tracker (repo talktejas/koin)
- b2becom [direct-PR] - KaratCraft B2B jewellery wholesale portal
- jt2627s [direct-PR] - JewelTrek inventory SaaS
- oldshop [direct-PR finished] - A shop that shipped and is done
"""


def registry(path, text=REGISTRY):
    with open(os.path.join(path, "data", "projects.md"), "w", encoding="utf-8") as fh:
        fh.write(text)


def about(sorter, project, confidence=0.9):
    """A scripted response: this message is about `project`."""
    return {"answers": {"project": odds(
        cc.project_choices(cc.offered_projects(sorter.home)), project, confidence)}}


class Jev:
    """Stands in for jev_post: answers by the message's own text, records what
    it was asked, and can be held shut to prove nothing waits on it."""

    def __init__(self, answers=None, fail=None):
        self.answers, self.fail = answers or {}, fail
        self.asked, self.keys, self.questions = [], [], []
        self.open = threading.Event()
        self.open.set()

    def __call__(self, key, payload):
        self.open.wait(10)
        self.keys.append(key)
        self.asked.append(payload["state"]["message"]["text"])
        if self.fail:
            raise self.fail
        self.questions.append(sorted(payload["questions"]))
        answers = dict(self.answers.get(self.asked[-1], {}).get("answers") or {})
        if answers.get("sort", 1) is None:  # a test's own malformed response
            return {"answers": answers}
        # Whatever a test did not script gets a valid, harmless answer.
        for name, question in payload["questions"].items():
            default = "message" if name == "sort" else cc.PROJECT_NONE
            answers.setdefault(name, odds(question["criteria"], default, 0.9))
        return {"answers": answers}


def sorter_with(jev, name, **kwargs):
    cc.jev_post = jev
    return cc.Sorter(home(name), **dict({"env_key": KEY}, **kwargs))


def settle(sorter):
    for _ in range(500):
        if not sorter.busy:
            return
        time.sleep(0.01)
    raise AssertionError("the sorting thread never finished")


def logged(fn):
    """Run fn, returning what it wrote to the service log."""
    sys.stderr = io.StringIO()
    try:
        fn()
        return sys.stderr.getvalue()
    finally:
        sys.stderr = sys.__stderr__


def rows(*texts, **extra):
    return [dict({"id": f"m{i}", "text": text}, **extra) for i, text in enumerate(texts)]


@test
def a_response_is_only_trusted_as_a_choice_over_exactly_the_three_tabs():
    assert cc.sort_answer(reply("info", 0.8)) == ("info", 0.8)
    good = reply("decision", 0.7)["answers"]["sort"]
    for bad in ({"choice": "archive"}, {"confidence": 1.2}, {"confidence": "0.7"},
                {"confidence": True},
                {"probabilities": {"decision": 0.7, "message": 0.3}},
                {"probabilities": dict(good["probabilities"], other=0.0)},
                {"probabilities": {"decision": 0.7, "message": 0.7, "info": 0.1}},
                {"probabilities": [0.7, 0.2, 0.1]}):
        assert cc.sort_answer({"answers": {"sort": dict(good, **bad)}}) is None, bad
    for junk in (None, [], {}, {"answers": None}, {"answers": {"sort": "info"}}, {"error": "x"}):
        assert cc.sort_answer(junk) is None, junk


@test
def the_request_is_one_fixed_choice_question_with_nothing_but_the_message():
    payload = cc.sort_request({"id": "m1", "title": "T", "text": "x" * 9000,
                               "project": "secret-project", "worktree": "/w"})
    assert payload["model"] == "jev-latest"
    assert set(payload["questions"]["sort"]["criteria"]) == {"decision", "message", "info"}
    assert payload["questions"]["sort"]["type"] == "choice"
    assert set(payload["state"]["message"]) == {"title", "text"}
    assert len(payload["state"]["message"]["text"]) < 9000, "a long message was sent whole"
    assert KEY not in json.dumps(payload)


@test
def a_poll_never_waits_on_jev_and_serves_todays_placement_until_the_answer_exists():
    jev = Jev({"routine": reply("info", 0.93)})
    jev.open.clear()
    sorter = sorter_with(jev, "nowait")
    started = time.monotonic()
    first = sorter.apply(rows("routine"))
    assert time.monotonic() - started < 1, "the poll waited on the call"
    assert first == rows("routine"), "a row was changed before Jev answered"
    jev.open.set()
    settle(sorter)
    assert sorter.apply(rows("routine"))[0]["sort"] == \
        {"tab": "info", "choice": "info", "confidence": 0.93}


@test
def each_message_is_sorted_once_and_the_answer_survives_a_restart():
    jev = Jev({"a": reply("info", 0.8)})
    sorter = sorter_with(jev, "once")
    for _ in range(3):
        sorter.apply(rows("a"))
        settle(sorter)
    assert jev.asked == ["a"], jev.asked
    with open(cc.sort_cache_path(sorter.home), encoding="utf-8") as fh:
        saved = fh.read()
    assert KEY not in saved, "the key was written to the cache"
    assert json.loads(saved)["m0"]["choice"] == "info"
    again = cc.Sorter(sorter.home, env_key=KEY)
    assert again.apply(rows("a"))[0]["sort"]["tab"] == "info"
    settle(again)
    assert jev.asked == ["a"], "a cached message was asked about again after a restart"
    assert not os.path.exists(os.path.join(sorter.home, "data", "captain-messages.jsonl")), \
        "sorting wrote firstmate's own record"


@test
def below_the_floor_any_answer_means_messages_and_only_a_sure_decision_waits_on_him():
    jev = Jev({"unsure ask": reply("decision", 0.59), "sure ask": reply("decision", 0.6),
               "unsure noise": reply("info", 0.4), "sure noise": reply("info", 0.85)})
    sorter = sorter_with(jev, "floor")
    served = rows("unsure ask", "sure ask", "unsure noise", "sure noise")
    sorter.apply(served)
    settle(sorter)
    tabs = [r["sort"]["tab"] for r in sorter.apply(served)]
    assert tabs == ["message", "decision", "message", "info"], tabs
    # The floor is a setting, applied to the cached answer, not baked into it.
    strict = cc.Sorter(sorter.home, floor=0.9, env_key=KEY)
    assert [r["sort"]["tab"] for r in strict.apply(served)] == ["message"] * 4
    assert strict.apply(served)[1]["sort"]["choice"] == "decision"


@test
def a_recorded_question_is_never_sent_to_jev_or_given_a_sort():
    jev = Jev()
    sorter = sorter_with(jev, "question")
    served = rows("pick A or B", question=True) + [{"id": "plain", "text": "plain"},
                                                    {"id": "ans", "text": "an answer", "answers": "n1"},
                                                    {"id": "arch", "text": "archived", "archived": True},
                                                    {"id": "held", "text": "held", "held": True}]
    sorter.apply(served)
    settle(sorter)
    assert jev.asked == ["plain"], jev.asked
    # Even an answer cached before it was flagged never moves a recorded question.
    sorter.cache["m0"] = {"choice": "info", "confidence": 0.99}
    assert "sort" not in sorter.apply(served)[0]


@test
def existing_rows_are_sorted_a_bounded_batch_per_refresh():
    jev = Jev()
    sorter = sorter_with(jev, "batch")
    served = rows(*[f"row {i}" for i in range(cc.SORT_BATCH * 3)])
    sorter.apply(served)
    settle(sorter)
    assert len(jev.asked) == cc.SORT_BATCH, len(jev.asked)
    jev.open.clear()
    sorter.apply(served)
    sorter.apply(served)  # a second poll while the batch is still out starts nothing
    jev.open.set()
    settle(sorter)
    assert len(jev.asked) == cc.SORT_BATCH * 2, len(jev.asked)
    assert len(set(jev.asked)) == len(jev.asked), "a message was asked about twice"


@test
def a_failed_call_falls_back_silently_with_one_log_line_and_no_key_in_it():
    for fail in (TimeoutError("timed out " + KEY), urllib.error.URLError("no route"),
                 urllib.error.HTTPError(cc.JEV_URL, 401, "Unauthorized", {}, None),
                 ValueError("Invalid header value b'Bearer " + KEY + "'")):
        jev = Jev(fail=fail)
        sorter = sorter_with(jev, "fail-" + type(fail).__name__)
        served = rows("a", "b", "c")
        out = []

        def polls():
            for _ in range(3):
                out.append(sorter.apply(served))
                settle(sorter)
        log = logged(polls)
        assert out == [served] * 3, "a failed call changed what was served"
        assert log.count("\n") == 1 and "jev sort failed" in log, log
        assert KEY not in log, "the key reached the service log"
        assert len(jev.asked) == 1, "kept calling a service that had just failed"
        assert not os.path.exists(cc.sort_cache_path(sorter.home))


@test
def a_malformed_response_is_a_failure_not_an_answer():
    jev = Jev({"a": {"answers": {"sort": None}}})
    sorter = sorter_with(jev, "malformed")
    log = logged(lambda: (sorter.apply(rows("a")), settle(sorter)))
    assert "the response is not a sort answer" in log, log
    assert sorter.apply(rows("a")) == rows("a")


@test
def no_key_means_no_call_and_one_log_line():
    jev = Jev()
    sorter = sorter_with(jev, "nokey", env_key="")
    served = rows("a")
    log = logged(lambda: [sorter.apply(served) for _ in range(4)])
    assert jev.asked == [] and sorter.apply(served) == served
    assert log.count("\n") == 1 and "jev sort is off" in log, log


@test
def the_key_comes_from_the_homes_env_file_and_the_environment_wins():
    jev = Jev()
    sorter = sorter_with(jev, "envfile", env_key="")
    with open(os.path.join(sorter.home, ".env"), "w", encoding="utf-8") as fh:
        fh.write("OTHER=1\nTYPESAFE_API_KEY=old\n  export TYPESAFE_API_KEY=\"from-file\"  \n")
    sorter.apply(rows("a"))
    settle(sorter)
    assert jev.keys == ["from-file"], "the key was not read from the home's .env"
    sorter.env_key = "from-env"
    sorter.apply(rows("a", "b"))
    settle(sorter)
    assert jev.keys[-1] == "from-env"


@test
def switched_off_serves_rows_untouched_whatever_is_cached():
    jev = Jev({"a": reply("info", 0.9)})
    sorter = sorter_with(jev, "off")
    sorter.apply(rows("a"))
    settle(sorter)
    off = cc.Sorter(sorter.home, enabled=False, env_key=KEY)
    assert off.apply(rows("a", "b")) == rows("a", "b")
    assert jev.asked == ["a"]


@test
def a_new_answer_busts_the_unchanged_poll():
    jev = Jev()
    sorter = sorter_with(jev, "etag")
    capture = {"present": True, "ok": True}
    before = cc.messages_etag(sorter.home, capture, sorter.tag())
    assert before == cc.messages_etag(sorter.home, capture, sorter.tag())
    sorter.apply(rows("a"))
    settle(sorter)
    assert before != cc.messages_etag(sorter.home, capture, sorter.tag()), \
        "a poll after Jev answered would still be told nothing changed"


@test
def the_server_serves_the_sort_and_never_the_key():
    # The whole path: a real server on a throwaway home, Jev stubbed.
    jev = Jev({"Still running.": reply("info", 0.91),
               "Pick the blue or the green build.": reply("decision", 0.88)})
    cc.jev_post = jev
    path = home("server")
    log_rows = [
        {"id": "m-info", "at": "2026-10-05T10:00:00Z", "title": "status", "text": "Still running."},
        {"id": "m-ask", "at": "2026-10-05T10:01:00Z", "title": "builds",
         "text": "Pick the blue or the green build."},
        {"id": "m-q", "at": "2026-10-05T10:02:00Z", "title": "recorded", "text": "A or B?",
         "question": True},
    ]
    with open(os.path.join(path, "data", "captain-messages.jsonl"), "w", encoding="utf-8") as fh:
        fh.writelines(json.dumps(r) + "\n" for r in log_rows)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    os.environ["TYPESAFE_API_KEY"] = KEY
    cc.Handler.log_message = lambda *args: None
    sys.stdout = io.StringIO()
    threading.Thread(target=cc.main, args=(["--port", str(port), "--home", path],),
                     daemon=True).start()

    def messages():
        for _ in range(100):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/messages", timeout=5) as r:
                    return r.read().decode()
            except OSError:
                time.sleep(0.1)
        raise AssertionError("the server never answered")
    try:
        body = messages()
        for _ in range(100):
            if '"sort"' in body and not cc.Handler.sorter.busy:
                break
            time.sleep(0.05)
            body = messages()
    finally:
        sys.stdout = sys.__stdout__
    assert "TYPESAFE_API_KEY" not in os.environ, "the key stayed in the environment child scripts inherit"
    assert KEY not in body, "the key was served to the page"
    by_id = {m["id"]: m for m in json.loads(body)["messages"]}
    assert by_id["m-info"]["sort"]["tab"] == "info", by_id["m-info"]
    assert by_id["m-ask"]["sort"] == {"tab": "decision", "choice": "decision", "confidence": 0.88}
    assert "sort" not in by_id["m-q"] and by_id["m-q"]["question"] is True
    assert "A or B?" not in jev.asked, "a recorded question was sent to Jev"
    assert jev.keys and set(jev.keys) == {KEY}


@test
def an_answer_given_under_an_older_wording_is_asked_again_as_its_row_is_served():
    jev = Jev({"app is up for you to check": reply("decision", 0.9)})
    sorter = sorter_with(jev, "wording")
    sorter.cache = {"m0": {"choice": "message", "confidence": 0.96, "at": "2026-10-05T14:34:23Z"},
                    "never-served": {"choice": "info", "confidence": 0.9}}
    served = rows("app is up for you to check")
    assert sorter.apply(served)[0]["sort"]["tab"] == "message", "the old answer was dropped unasked"
    settle(sorter)
    assert sorter.apply(served)[0]["sort"]["tab"] == "decision"
    settle(sorter)
    assert jev.asked == ["app is up for you to check"], jev.asked
    assert sorter.cache["m0"]["wording"] == cc.SORT_WORDING
    assert "wording" not in sorter.cache["never-served"], "history was re-sorted wholesale"
    act = cc.SORT_CHOICES["decision"]
    assert "check" in act and "merge" in act and "decide" in act, act


@test
def the_project_choices_are_the_registry_minus_finished_plus_two_fixed_ones():
    path = home("registry")
    assert cc.offered_projects(path) == {}, "projects were offered with no registry"
    registry(path)
    assert set(cc.offered_projects(path)) == {"koin", "b2becom", "jt2627s"}
    assert set(cc.project_choices(cc.offered_projects(path))) == \
        {"koin", "b2becom", "jt2627s", cc.PROJECT_SEVERAL, cc.PROJECT_NONE}
    registry(path, REGISTRY + "- newone [local-only] - Something new\n")
    assert "newone" in cc.offered_projects(path), "a project added to the registry was not offered"
    with open(os.path.join(ROOT, "command-center.py"), encoding="utf-8") as fh:
        source = fh.read().split("# --- sorting messages with Jev")[1].split("MESSAGE_WINDOW = ")[0]
    assert "koin" not in source.lower() and "b2becom" not in source, "a project name is hardcoded"


@test
def jevs_project_replaces_a_different_recorded_one_and_keeps_it_visible():
    jev = Jev()
    sorter = sorter_with(jev, "project")
    registry(sorter.home)
    jev.answers = {"koin wallet bug": about(sorter, "koin", 0.9),
                   "koin and jeweltrek items": about(sorter, cc.PROJECT_SEVERAL, 0.8),
                   "maybe koin": about(sorter, "koin", 0.4),
                   "the agent restarted": about(sorter, cc.PROJECT_NONE, 0.95),
                   "karatcraft order page": about(sorter, "b2becom", 0.9),
                   "unlabelled koin": about(sorter, "koin", 0.9)}
    served = rows("koin wallet bug", "koin and jeweltrek items", "maybe koin",
                  "the agent restarted", "karatcraft order page", project="b2becom")
    served.append({"id": "bare", "text": "unlabelled koin", "project": None})
    for _ in range(2):
        assert [r["project"] for r in sorter.apply(served[:5])] == ["b2becom"] * 5 \
            or not jev.open.is_set() or sorter.projects, "a label moved before Jev answered"
        sorter.apply(served)
        settle(sorter)
    out = sorter.apply(served)
    assert [r["project"] for r in out] == \
        ["koin", "several projects", "b2becom", "b2becom", "b2becom", "koin"], out
    assert out[0]["project_recorded"] == "b2becom" and out[0]["project_by"] == "jev"
    assert out[1]["project_recorded"] == "b2becom"
    assert out[5]["project_recorded"] is None and out[5]["project_by"] == "jev"
    for same in out[2:5]:
        assert "project_by" not in same and "project_recorded" not in same, same
    assert out[2]["project_jev"] == {"choice": "koin", "confidence": 0.4}
    # One call per row carried both questions, and the answers sit beside the sort cache.
    assert len(jev.asked) == 6 and jev.questions[0] == ["project", "sort"], jev.questions
    assert os.path.dirname(cc.project_cache_path(sorter.home)) == \
        os.path.dirname(cc.sort_cache_path(sorter.home))
    with open(cc.project_cache_path(sorter.home), encoding="utf-8") as fh:
        assert KEY not in fh.read()
    # The floor is applied to the cached answer; a restart asks nothing again.
    loose = cc.Sorter(sorter.home, floor=0.3, env_key=KEY)
    assert loose.apply(served)[2]["project"] == "koin"
    settle(loose)
    assert len(jev.asked) == 6


@test
def a_recorded_question_and_an_archived_row_still_get_a_project_but_never_a_sort():
    jev = Jev()
    sorter = sorter_with(jev, "project-question")
    registry(sorter.home)
    jev.answers = {"pick A or B": about(sorter, "koin")}
    served = rows("pick A or B", question=True, project="b2becom") + \
        [{"id": "arch", "text": "archived", "archived": True}]
    sorter.apply(served)
    settle(sorter)
    assert jev.questions == [["project"], ["project"]], jev.questions
    out = sorter.apply(served)
    assert out[0]["project"] == "koin" and "sort" not in out[0]


@test
def a_changed_project_list_re_asks_only_the_rows_served_in_the_same_batches():
    jev = Jev()
    sorter = sorter_with(jev, "relist")
    registry(sorter.home)
    served = rows(*[f"row {i}" for i in range(cc.SORT_BATCH + 2)])
    for _ in range(3):
        sorter.apply(served)
        settle(sorter)
    asked = len(jev.asked)
    assert asked == len(served), asked
    before = sorter.tag()
    registry(sorter.home, REGISTRY.replace("- koin [direct-PR]", "- koin [direct-PR finished]"))
    assert sorter.tag() != before, "a changed registry would not bust the unchanged poll"
    sorter.apply(served)
    settle(sorter)
    assert len(jev.asked) - asked == cc.SORT_BATCH, "the re-ask was not one bounded batch"
    assert jev.questions[-1] == ["project"], "a row already sorted was sorted again"
    untouched = [k for k, v in sorter.projects.items() if v["of"] != cc.projects_tag(
        cc.offered_projects(sorter.home))]
    assert len(untouched) == 2, "rows not yet re-served were reclassified"


@test
def a_failed_or_malformed_project_answer_leaves_the_recorded_label():
    for n, (fail, answers) in enumerate(((TimeoutError("timed out"), {}),
                          (None, {"a": {"answers": {"project": {"choice": "koin"}}}}),
                          (None, {"a": {"answers": {"project": odds(
                              {"koin": "", "not-a-project": ""}, "not-a-project", 0.9)}}}))):
        jev = Jev(answers, fail=fail)
        sorter = sorter_with(jev, f"project-fail-{n}")
        registry(sorter.home)
        served = rows("a", project="b2becom")
        log = logged(lambda: [(sorter.apply(served), settle(sorter)) for _ in range(2)])
        assert sorter.apply(served) == served, "a failed call changed the label"
        assert log.count("\n") == 1 and "jev sort failed" in log, log
        assert not os.path.exists(cc.project_cache_path(sorter.home))
    quiet = sorter_with(Jev(), "project-nokey", env_key="")
    registry(quiet.home)
    logged(lambda: quiet.apply(served))
    assert quiet.apply(served) == served


if not failures:
    print(ran)
sys.exit(1 if failures else 0)
