"""feedback_mode "at_end" (what the app uses): no scores or feedback while the interview runs; everything appears at the end."""
from conftest import act, add_questions, answer, good_eval, start_interview, state
from test_interview_flow import always_ask


def run(client, set_id, **cfg):
    return start_interview(client, set_id, feedback_mode="at_end", **cfg)


def test_no_feedback_screen_the_next_question_follows_the_answer(client, set_id):
    add_questions(client, set_id, 3)
    st = run(client, set_id, max_followups=0)
    st = answer(client, st, "My answer").json()
    assert st["phase"] == "awaiting_answer" and st["current"]["turn"]["question_text"] == "Question number 2?"
    assert st["next_action"] is None


def test_nothing_about_scores_or_feedback_is_visible_while_the_interview_runs(client, set_id):
    add_questions(client, set_id, 3)
    st = run(client, set_id, max_followups=0)
    st = answer(client, st, "First answer").json()
    st = state(client, st["id"])
    assert all(it["score"] is None for it in st["items"])
    assert st["items"][0]["status"] == "answered"
    thread = st["current"]["thread"]
    assert all("evaluation" not in t and "score" not in t for t in thread)
    assert '"score": 8' not in client.get(f"/api/interviews/{st['id']}").text.replace("\n", "")
    paused = client.post(f"/api/interviews/{st['id']}/pause").json()
    assert all(it["score"] is None for it in paused["items"])                                   # also while paused


def test_the_last_answer_finishes_the_interview_and_everything_is_revealed(client, set_id):
    add_questions(client, set_id, 2)
    st = run(client, set_id, max_followups=0)
    st = answer(client, st, "Answer one").json()
    st = answer(client, st, "Answer two").json()
    assert st["status"] == "completed" and st["phase"] == "done"
    assert all(it["score"] is not None for it in st["items"])
    rep = client.get(f"/api/interviews/{st['id']}/report").json()
    assert rep["summary"]["scored"] == 2 and rep["summary"]["average_score"] is not None
    assert all(q["turns"][0]["score"] is not None and q["turns"][0]["evaluation"] for q in rep["questions"])


def test_a_follow_up_comes_straight_after_the_answer_and_every_score_is_in_the_report(client, set_id, fake):
    add_questions(client, set_id, 1)
    always_ask(fake)
    st = run(client, set_id, max_followups=2)
    st = answer(client, st, "A partial answer").json()
    assert st["phase"] == "awaiting_answer" and st["current"]["turn"]["followup_reason"]                 # the follow-up is the current question
    assert all("score" not in t for t in st["current"]["thread"])
    st = answer(client, st, "Second try").json()
    st = answer(client, st, "Third try").json()
    assert st["status"] == "completed"
    q = client.get(f"/api/interviews/{st['id']}/report").json()["questions"][0]
    kinds = [t["kind"] for t in q["turns"]]
    assert kinds == ["main", "followup", "followup"] and all(t["score"] is not None for t in q["turns"])
    assert q["score"] is not None and q["followups_asked"] == 2


def test_skip_end_and_pause_work_without_a_feedback_screen(client, set_id):
    add_questions(client, set_id, 4)
    st = run(client, set_id, max_followups=0)
    st = answer(client, st, "One").json()
    st = client.post(f"/api/interviews/{st['id']}/skip", json={"turn_id": st["current_turn_id"]}).json()
    assert st["current"]["turn"]["question_text"] == "Question number 3?"
    st = client.post(f"/api/interviews/{st['id']}/pause").json()
    st = client.post(f"/api/interviews/{st['id']}/resume").json()
    st = answer(client, st, "Three").json()
    ended = client.post(f"/api/interviews/{st['id']}/end").json()
    assert ended["status"] == "ended" and ended["items"][0]["score"] is not None and ended["items"][1]["status"] == "skipped"
    rep = client.get(f"/api/interviews/{st['id']}/report").json()
    assert rep["summary"]["scored"] == 2 and rep["summary"]["skipped"] == 1 and rep["summary"]["unanswered"] == 1


def test_the_report_has_skill_averages_and_the_markdown_has_a_scorecard(client, set_id, fake):
    add_questions(client, set_id, 2)
    fake.chat_replies = [good_eval(correctness=9), good_eval(correctness=5)]
    st = run(client, set_id, max_followups=0)
    st = answer(client, st, "A").json()
    st = answer(client, st, "B").json()
    rep = client.get(f"/api/interviews/{st['id']}/report").json()
    skills = {k["key"]: k for k in rep["skills"]}
    assert skills["correctness"]["answers"] == 2 and skills["correctness"]["average"] == 7.0
    assert [k["key"] for k in rep["skills"]] == ["correctness", "completeness", "depth", "practical_application", "clarity", "production_awareness"]
    md = client.get(f"/api/interviews/{st['id']}/report/export?format=md").text
    assert "## Scorecard" in md and "**Final score**" in md and "## Skills" in md
    assert md.index("## Scorecard") < md.index("## Questions")


def test_the_old_modes_still_work(client, set_id):
    add_questions(client, set_id, 2)
    st = start_interview(client, set_id, max_followups=0)                               # default "immediate": feedback screen with the score
    st = answer(client, st, "An answer").json()
    assert st["phase"] == "feedback" and st["current"]["thread"][0]["score"] is not None
    st = act(client, state(client, st["id"]), "continue").json()
    assert st["phase"] == "awaiting_answer"


def test_a_failed_evaluation_keeps_the_answer_and_retry_carries_on_without_a_feedback_screen(client, set_id, fake):
    add_questions(client, set_id, 2)
    st = run(client, set_id, max_followups=0)
    fake.up = False
    answer(client, st, "important answer")
    s = state(client, st["id"])
    assert s["phase"] == "evaluation_failed" and s["current"]["turn"]["answer_text"] == "important answer"
    fake.up = True
    fake.chat_replies = [good_eval(correctness=9)]
    st = act(client, s, "retry").json()
    st = state(client, st["id"])
    assert st["phase"] == "awaiting_answer" and st["current"]["turn"]["question_text"] == "Question number 2?"
