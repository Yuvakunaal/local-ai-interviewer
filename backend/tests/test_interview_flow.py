import json

import pytest
from fastapi.testclient import TestClient

from app.deps import build_container
from app.main import create_app
from conftest import (InlineExecutor, act, add_questions, answer, good_eval, make_client_for, make_settings, start_interview,
                      state)

FOLLOWUPS = [
    "Why would a MERGE statement fail under late arriving data volumes?",
    "How does a watermark decide when a streaming window can close?",
    "What would you monitor to detect partition skew before jobs time out?",
    "Which checkpoint strategy lets a restarted consumer avoid reprocessing?",
    "Explain how compaction changes read latency for small files.",
    "When should retries use exponential backoff with jitter?",
    "How do surrogate keys survive a full backfill of a dimension?",
]


def always_ask(fake, n=20):
    fake.chat_replies = [good_eval(correctness=5, followup=FOLLOWUPS[i % len(FOLLOWUPS)], missing=["Idempotency"]) for i in range(n)]


def test_start_shows_first_question_and_awaits_answer(client, set_id):
    add_questions(client, set_id, 3)
    st = start_interview(client, set_id)
    assert st["status"] == "in_progress" and st["phase"] == "awaiting_answer"
    assert st["current"]["turn"]["question_text"] == "Question number 1?"
    assert st["progress"]["total"] == 3 and st["progress"]["position"] == 1


def test_no_questions_cannot_start(client, set_id):
    r = client.post("/api/interviews", json={"set_id": set_id, "config": {}})
    assert r.status_code == 400 and r.json()["error"]["code"] == "no_questions"


def test_selection_and_shuffle(client, set_id):
    qs = add_questions(client, set_id, 5)
    st = start_interview(client, set_id)
    assert [i["text"] for i in st["items"]] == [q["text"] for q in qs]
    chosen = [qs[3]["id"], qs[1]["id"]]
    st = start_interview(client, set_id, question_ids=chosen, replace=True)
    assert [i["text"] for i in st["items"]] == [qs[1]["text"], qs[3]["text"]]  # queue order, not click order
    orders = {tuple(i["text"] for i in start_interview(client, set_id, order="shuffled", replace=True)["items"]) for _ in range(12)}
    assert len(orders) > 1 and all(len(o) == 5 for o in orders)
    assert client.post("/api/interviews", json={"set_id": set_id, "config": {"question_ids": [9999]}}).status_code == 400


@pytest.mark.parametrize("limit", [0, 1, 2, 3])
def test_followup_limit_zero_to_three_even_if_model_always_asks(client, set_id, fake, limit):
    add_questions(client, set_id, 1)
    always_ask(fake)
    st = start_interview(client, set_id, max_followups=limit)
    asked = 0
    for _ in range(10):
        st = answer(client, st, "An answer").json()
        assert st["phase"] == "feedback"
        if st["next_action"] == "followup":
            asked += 1
            st = act(client, st, "continue").json()
            assert st["current"]["turn"]["kind"] == "followup"
        else:
            break
    assert asked == limit
    assert state(client, st["id"])["current"]["item"]["followup_count"] == limit
    assert st["next_action"] == "finish"


def test_zero_followups_tells_model_not_to_ask(client, set_id, fake):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    answer(client, st)
    assert "Follow-ups still allowed for this question: 0" in fake.chat_calls[0]["messages"][1]["content"]


def test_followup_counter_survives_restart(tmp_path, fake):
    settings = make_settings(tmp_path)

    def boot():
        c = build_container(settings, ollama=make_client_for(settings, fake), executor=InlineExecutor())
        return TestClient(create_app(settings, c), base_url="http://127.0.0.1:3000")

    c1 = boot()
    sid = c1.get("/api/sets").json()[0]["id"]
    add_questions(c1, sid, 1)
    always_ask(fake)
    st = start_interview(c1, sid, max_followups=1)
    st = answer(c1, st).json()
    st = act(c1, st, "continue").json()          # follow-up #1 now active
    assert st["current"]["item"]["followup_count"] == 1
    c2 = boot()                                   # "restart the app / refresh"
    st2 = state(c2, st["id"])
    assert st2["current"]["item"]["followup_count"] == 1 and st2["current"]["turn"]["kind"] == "followup"
    st2 = answer(c2, st2).json()
    assert st2["next_action"] == "finish"         # limit of 1 still enforced after restart
    assert len(c2.get("/api/interviews").json()) == 1 and len(state(c2, st["id"])["current"]["thread"]) == 2


def test_duplicate_submission_runs_one_inference(client, set_id, fake):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id)
    first = answer(client, st, "once")
    second = answer(client, st, "twice")
    assert first.status_code == 200 and second.status_code == 409
    assert len(fake.chat_calls) == 1
    t = state(client, st["id"])["current"]["thread"][0]
    assert t["answer_text"] == "once"


def test_stale_turn_and_wrong_phase_rejected(client, set_id):
    add_questions(client, set_id, 2)
    st = start_interview(client, set_id)
    r = client.post(f"/api/interviews/{st['id']}/answer", json={"turn_id": st["current_turn_id"] + 99, "text": "x"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "stale_turn"
    assert act(client, st, "continue").status_code == 409  # nothing to continue yet
    assert client.post(f"/api/interviews/{st['id']}/answer", json={"turn_id": st["current_turn_id"], "text": "  "}).status_code == 400


def test_full_flow_and_report(client, set_id, fake):
    add_questions(client, set_id, 3)
    fake.chat_replies = [good_eval(correctness=8), good_eval(correctness=4, missing=["Shuffle cost"]), good_eval(correctness=6)]
    st = start_interview(client, set_id, max_followups=0)
    for _ in range(3):
        st = answer(client, st).json()
        assert st["phase"] == "feedback" and st["current"]["thread"][-1]["evaluation"]["verdict"]
        st = act(client, st, "continue").json()
    assert st["status"] == "completed" and st["phase"] == "done"
    rep = client.get(f"/api/interviews/{st['id']}/report").json()
    assert rep["summary"]["average_score"] == 6.0 and rep["summary"]["answered"] == 3
    assert rep["questions"][0]["score"] == 8.0
    topics = {t["topic"]: t["average_score"] for t in rep["topics"]}
    assert topics == {"SQL": 7.0, "Spark": 4.0}  # SQL: (8+6)/2
    assert rep["insights_source"] in {"rules", "model"} and rep["narrative_status"] in {"ready", "pending"}


def test_skip_is_not_scored_and_excluded_from_average(client, set_id, fake):
    add_questions(client, set_id, 3)
    fake.chat_replies = [good_eval(correctness=10), good_eval(correctness=6)]
    st = start_interview(client, set_id, max_followups=0)
    st = answer(client, st).json(); st = act(client, st, "continue").json()
    st = act(client, st, "skip").json()
    assert st["progress"]["skipped"] == 1 and st["current"]["turn"]["question_text"] == "Question number 3?"
    st = answer(client, st).json(); st = act(client, st, "continue").json()
    rep = client.get(f"/api/interviews/{st['id']}/report").json()
    s = rep["summary"]
    assert (s["answered"], s["skipped"], s["unanswered"], s["scored"], s["average_score"]) == (2, 1, 0, 2, 8.0)
    skipped = rep["questions"][1]
    assert skipped["status"] == "skipped" and skipped["score"] is None and skipped["verdict"] is None


def test_end_early_marks_rest_unanswered(client, set_id, fake):
    add_questions(client, set_id, 4)
    st = start_interview(client, set_id, max_followups=0)
    st = answer(client, st).json(); st = act(client, st, "continue").json()
    st = client.post(f"/api/interviews/{st['id']}/end").json()
    assert st["status"] == "ended" and st["progress"]["unanswered"] == 3
    s = client.get(f"/api/interviews/{st['id']}/report").json()["summary"]
    assert (s["answered"], s["unanswered"], s["skipped"], s["average_score"]) == (1, 3, 0, 8.0)
    assert client.post(f"/api/interviews/{st['id']}/end").status_code == 409
    assert answer(client, {**st, "current_turn_id": 1}).status_code == 409


def test_end_with_nothing_answered_has_no_average(client, set_id):
    add_questions(client, set_id, 2)
    st = start_interview(client, set_id)
    client.post(f"/api/interviews/{st['id']}/end")
    s = client.get(f"/api/interviews/{st['id']}/report").json()["summary"]
    assert s["average_score"] is None and s["unanswered"] == 2 and s["scored"] == 0


def test_skip_followup_keeps_item_answered(client, set_id, fake):
    add_questions(client, set_id, 2)
    always_ask(fake)
    st = start_interview(client, set_id, max_followups=2)
    st = answer(client, st).json(); st = act(client, st, "continue").json()
    assert st["current"]["turn"]["kind"] == "followup"
    st = act(client, st, "skip").json()           # skips only the follow-up
    assert st["current"]["turn"]["question_text"] == "Question number 2?"
    assert st["items"][0]["status"] == "answered" and st["items"][0]["score"] == 5.0


def test_pause_blocks_actions_and_resume_restores(client, set_id):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id)
    p = client.post(f"/api/interviews/{st['id']}/pause").json()
    assert p["status"] == "paused" and p["current"]["turn"]["id"] == st["current_turn_id"]
    r = answer(client, st)
    assert r.status_code == 409 and r.json()["error"]["code"] == "paused"
    assert client.post(f"/api/interviews/{st['id']}/pause").status_code == 409
    assert client.post(f"/api/interviews/{st['id']}/resume").json()["status"] == "in_progress"
    assert answer(client, st).status_code == 200


def test_ollama_down_keeps_answer_and_retry_works(client, set_id, fake):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    fake.up = False
    st2 = answer(client, st, "important long answer").json()
    st2 = state(client, st["id"])
    assert st2["phase"] == "evaluation_failed" and "not reachable" in st2["error"]
    assert st2["current"]["turn"]["answer_text"] == "important long answer"
    assert answer(client, st).status_code == 409           # can't re-answer; must retry the saved one
    fake.up = True
    fake.chat_replies = [good_eval(correctness=9)]
    st3 = act(client, st2, "retry").json()
    assert st3["phase"] == "feedback" and st3["current"]["thread"][0]["score"] == 9.0
    assert len(fake.chat_calls) == 1 and st3["current"]["thread"][0]["eval_attempts"] == 2


def test_model_missing_message(client, set_id, fake):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id)
    fake.chat_error = (404, "model 'qwen3.5:4b' not found")
    answer(client, st)
    assert "setup-models" in state(client, st["id"])["error"]


def test_bad_model_output_fails_safely(client, set_id, fake):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id)
    fake.chat_replies = ["garbage", "more garbage"]
    answer(client, st, "keep me")
    s = state(client, st["id"])
    assert s["phase"] == "evaluation_failed" and s["current"]["turn"]["answer_text"] == "keep me"


def test_skip_from_failed_evaluation_is_skip_not_correct(client, set_id, fake):
    add_questions(client, set_id, 2)
    st = start_interview(client, set_id)
    fake.up = False
    answer(client, st)
    s = state(client, st["id"])
    s = act(client, s, "skip").json()
    assert s["items"][0]["status"] == "skipped" and s["items"][0]["score"] is None


def test_restart_recovers_stuck_evaluating(tmp_path, fake):
    settings = make_settings(tmp_path)
    c = build_container(settings, ollama=make_client_for(settings, fake), executor=type("NoRun", (), {"submit": lambda *a, **k: None})())
    cl = TestClient(create_app(settings, c), base_url="http://127.0.0.1:3000")
    sid = cl.get("/api/sets").json()[0]["id"]
    add_questions(cl, sid, 1)
    st = start_interview(cl, sid)
    assert answer(cl, st).json()["phase"] == "evaluating"   # worker never ran -> simulates a crash mid-evaluation
    c2 = build_container(settings, ollama=make_client_for(settings, fake), executor=InlineExecutor())
    cl2 = TestClient(create_app(settings, c2), base_url="http://127.0.0.1:3000")
    s = state(cl2, st["id"])
    assert s["phase"] == "evaluation_failed" and s["current"]["turn"]["answer_text"] == "My answer"


def test_deferred_feedback_hides_evaluation_until_item_done(client, set_id, fake):
    add_questions(client, set_id, 2)
    fake.chat_replies = [good_eval(correctness=5, followup=FOLLOWUPS[0]), good_eval(correctness=9)]
    st = start_interview(client, set_id, max_followups=1, feedback_mode="after_followups")
    st = answer(client, st).json()
    assert st["phase"] == "awaiting_answer" and st["current"]["turn"]["kind"] == "followup"   # straight to follow-up
    assert all("evaluation" not in t for t in st["current"]["thread"])
    st = answer(client, st).json()
    assert st["phase"] == "feedback" and all("evaluation" in t for t in st["current"]["thread"])
    assert st["items"][0]["score"] == 6.3  # (5*2 + 9*1)/3


def test_immediate_feedback_shows_pending_followup_but_asks_it_only_on_continue(client, set_id, fake):
    add_questions(client, set_id, 1)
    fake.chat_replies = [good_eval(correctness=5, followup=FOLLOWUPS[0], reason="Missing idempotency")]
    st = answer(client, start_interview(client, set_id, max_followups=1)).json()
    assert st["phase"] == "feedback" and st["next_action"] == "followup"
    assert st["current"]["turn"] is None and len(st["current"]["thread"]) == 1      # not yet "asked": no turn to answer
    assert st["current"]["pending_followup"] == {"question": FOLLOWUPS[0], "reason": "Missing idempotency"}
    assert answer(client, st).status_code == 409                                    # cannot answer it before Continue
    st = act(client, st, "continue").json()
    assert st["current"]["turn"]["question_text"] == FOLLOWUPS[0] and st["current"]["pending_followup"] is None


def test_deferred_mode_does_not_leak_in_progress_score_in_item_list(client, set_id, fake):
    add_questions(client, set_id, 2)
    fake.chat_replies = [good_eval(correctness=5, followup=FOLLOWUPS[0]), good_eval(correctness=9)]
    st = answer(client, start_interview(client, set_id, max_followups=1, feedback_mode="after_followups")).json()
    assert st["phase"] == "awaiting_answer" and st["items"][0]["score"] is None and st["items"][0]["status"] == "active"
    st = answer(client, st).json()
    assert st["items"][0]["status"] == "answered" and st["items"][0]["score"] == 6.3


def test_followup_prompt_contains_thread_context(client, set_id, fake):
    add_questions(client, set_id, 1)
    fake.chat_replies = [good_eval(correctness=5, followup=FOLLOWUPS[0], missing=["Idempotency"]), good_eval()]
    st = answer(client, start_interview(client, set_id), "first answer text").json()
    st = act(client, st, "continue").json()
    answer(client, st, "second answer text")
    prompt = fake.chat_calls[1]["messages"][1]["content"]
    assert "first answer text" in prompt and "Idempotency" in prompt and FOLLOWUPS[0] in prompt and "ORIGINAL QUESTION: Question number 1?" in prompt


def test_rubric_is_passed_to_model(client, set_id, fake):
    client.post(f"/api/sets/{set_id}/questions", json={"text": "Q?", "rubric": "Must mention watermarks", "topic": "Spark", "difficulty": "hard"})
    answer(client, start_interview(client, set_id))
    p = fake.chat_calls[0]["messages"][1]["content"]
    assert "Must mention watermarks" in p and "difficulty: hard" in p


def test_history_delete_and_clear(client, set_id):
    add_questions(client, set_id, 1)
    a = start_interview(client, set_id); b = start_interview(client, set_id, replace=True)
    assert len(client.get("/api/interviews").json()) == 2
    assert client.delete(f"/api/interviews/{a['id']}").status_code == 200
    assert client.delete("/api/interviews").status_code == 400          # needs confirm
    assert client.delete("/api/interviews?confirm=true").json() == {"deleted": 1}
    assert state(client, b["id"]) if False else client.get(f"/api/interviews/{b['id']}").status_code == 404
    assert len(client.get(f"/api/sets/{set_id}/questions").json()) == 1  # question library untouched


def test_editing_library_does_not_change_running_interview(client, set_id):
    qs = add_questions(client, set_id, 1)
    st = start_interview(client, set_id)
    client.put(f"/api/questions/{qs[0]['id']}", json={"text": "Changed!"})
    client.delete(f"/api/questions/{qs[0]['id']}")
    assert state(client, st["id"])["current"]["turn"]["question_text"] == "Question number 1?"


def test_report_exports(client, set_id, fake):
    add_questions(client, set_id, 2)
    fake.chat_replies = [good_eval(correctness=7, missing=["Partitioning"], misconceptions=["Joins always shuffle"]), good_eval(correctness=8)]
    st = start_interview(client, set_id, max_followups=0)
    for _ in range(2):
        st = act(client, answer(client, st).json(), "continue").json()
    md = client.get(f"/api/interviews/{st['id']}/report/export?format=md")
    assert md.status_code == 200 and "attachment" in md.headers["content-disposition"]
    assert "# Interview report" in md.text and "Joins always shuffle" in md.text and "Scoring rules" in md.text
    js = client.get(f"/api/interviews/{st['id']}/report/export?format=json").json()
    assert js["summary"]["average_score"] == 7.5
    assert client.get(f"/api/interviews/{st['id']}/report/export?format=docx").status_code == 422
    assert client.get(f"/api/interviews/{st['id']}/report/export?format=pdf").status_code == 200


def test_narrative_from_model_replaces_rule_based_and_failure_falls_back(client, set_id, fake):
    add_questions(client, set_id, 1)
    narrative = {"overall_summary": "Solid.", "strengths": ["SQL basics"], "knowledge_gaps": ["Spark skew"],
                 "repeated_misconceptions": [], "topics_to_revise": ["Spark"], "recommendations": ["Practice skew joins"]}
    fake.chat_replies = [good_eval(), narrative]
    st = act(client, answer(client, start_interview(client, set_id, max_followups=0)).json(), "continue").json()
    rep = client.get(f"/api/interviews/{st['id']}/report").json()
    assert rep["narrative_status"] == "ready" and rep["insights_source"] == "model" and rep["insights"]["strengths"] == ["SQL basics"]
    fake.chat_replies = ["bad", "worse"]
    rep = client.post(f"/api/interviews/{st['id']}/report/regenerate").json()
    assert rep["narrative_status"] == "failed" and rep["insights"]["strengths"] == ["SQL basics"]  # previous kept


def test_report_survives_restart(tmp_path, fake):
    settings = make_settings(tmp_path)
    c = build_container(settings, ollama=make_client_for(settings, fake), executor=InlineExecutor())
    cl = TestClient(create_app(settings, c), base_url="http://127.0.0.1:3000")
    sid = cl.get("/api/sets").json()[0]["id"]
    add_questions(cl, sid, 1)
    st = act(cl, answer(cl, start_interview(cl, sid, max_followups=0)).json(), "continue").json()
    c2 = build_container(settings, ollama=make_client_for(settings, fake), executor=InlineExecutor())
    cl2 = TestClient(create_app(settings, c2), base_url="http://127.0.0.1:3000")
    assert cl2.get(f"/api/interviews/{st['id']}/report").json()["summary"]["average_score"] == 8.0
    assert cl2.get("/api/interviews").json()[0]["average_score"] == 8.0


# ---------------------------------------------------------------- one active interview at a time
def test_a_second_interview_cannot_start_while_one_is_active(client, set_id):
    add_questions(client, set_id, 2)
    first = start_interview(client, set_id, title="First")
    r = client.post("/api/interviews", json={"set_id": set_id, "config": {"title": "Second"}})
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "interview_active" and err["interview_id"] == first["id"] and "First" in err["message"]
    assert len(client.get("/api/interviews").json()) == 1                       # nothing was created


def test_a_paused_interview_still_blocks_a_new_one(client, set_id):
    add_questions(client, set_id, 2)
    first = start_interview(client, set_id)
    assert client.post(f"/api/interviews/{first['id']}/pause").status_code == 200
    assert client.post("/api/interviews", json={"set_id": set_id, "config": {}}).status_code == 409


def test_ending_or_finishing_the_active_interview_allows_the_next(client, set_id):
    add_questions(client, set_id, 1)
    first = start_interview(client, set_id, max_followups=0)
    assert client.post(f"/api/interviews/{first['id']}/end").status_code == 200
    second = start_interview(client, set_id, max_followups=0)                  # allowed after ending
    st = answer(client, second).json()
    st = act(client, state(client, second["id"]), "continue").json()
    assert st["status"] == "completed"
    assert start_interview(client, set_id)["status"] == "in_progress"          # allowed after finishing


def test_deleting_the_active_interview_frees_the_slot(client, set_id):
    add_questions(client, set_id, 1)
    first = start_interview(client, set_id)
    assert client.delete(f"/api/interviews/{first['id']}").status_code == 200
    assert start_interview(client, set_id)["status"] == "in_progress"
