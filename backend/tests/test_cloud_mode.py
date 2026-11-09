"""A whole interview in cloud mode (mock cloud): which model does what, fallback rules, the budget guard, cost tracking."""
import json

import pytest

from conftest import act, add_questions, answer, enable_cloud, good_eval, start_interview, state

GRADER, FALLBACK, CONVO = "gpt-oss:120b", "deepseek-v4.1-flash", "gemma4:31b"


def setup(client, n=1, **cfg):
    sid = client.get("/api/sets").json()[0]["id"]
    add_questions(client, sid, n)
    enable_cloud(client, **cfg)
    return sid


def evaluation(client, iid):
    st = state(client, iid)
    for t in st["current"]["thread"]:
        if t.get("evaluation"):
            return t["evaluation"]
    return None


# ---------------------------------------------------------------- local mode never touches the cloud
def test_local_mode_makes_zero_cloud_requests_through_a_whole_interview(cloud_client, cloud_fake, fake):
    sid = cloud_client.get("/api/sets").json()[0]["id"]
    add_questions(cloud_client, sid, 2)
    st = start_interview(cloud_client, sid, max_followups=0)
    st = answer(cloud_client, st, "typed").json()
    st = act(cloud_client, state(cloud_client, st["id"]), "continue").json()
    fake.chat_replies = [{"text": "fixed", "unclear": []}, good_eval()]
    st = answer(cloud_client, state(cloud_client, st["id"]), "spoken", source="voice").json()
    act(cloud_client, state(cloud_client, st["id"]), "continue")
    cloud_client.post("/api/speech/synthesize", json={"text": "Hello there", "voice": "Harper"})
    cloud_client.post("/api/llm/warm")
    for path in ("/api/health", "/api/usage", "/api/ai", "/api/stats", "/api/voices"):
        cloud_client.get(path)
    assert cloud_fake.requests == []                                                    # not one request to the cloud
    assert len(fake.chat_calls) >= 3                                                    # the local model did the work
    assert {r["provider"] for r in cloud_client.app.state.c.usage.recent()} == {"local"}


def test_a_local_failure_never_falls_over_to_the_cloud(cloud_client, cloud_fake, fake):
    sid = cloud_client.get("/api/sets").json()[0]["id"]
    add_questions(cloud_client, sid, 1)
    cloud_client.put("/api/ai/key", json={"api_key": "k" * 20})                          # a key exists, but the user chose local
    fake.up = False
    st = start_interview(cloud_client, sid, max_followups=0)
    st = state(cloud_client, answer(cloud_client, st).json()["id"])
    assert st["phase"] == "evaluation_failed"
    assert cloud_fake.requests == []


# ---------------------------------------------------------------- who does what in cloud mode
def test_grading_goes_to_the_grader_and_the_result_says_so(cloud_client, cloud_fake):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=0)
    st = answer(cloud_client, st).json()
    assert cloud_fake.models_used() == [GRADER]
    ev = evaluation(cloud_client, st["id"])
    assert ev["graded_by"] == {"provider": "cloud", "model": GRADER, "fell_back_from": None}
    rec = cloud_client.app.state.c.usage.recent()[0]
    assert (rec["provider"], rec["model"], rec["purpose"], rec["label"]) == ("cloud", GRADER, "evaluation", "Q1") and rec["cost_usd"] == 0.000405


def test_voice_transcripts_are_cleaned_by_the_conversation_model_then_graded_by_the_grader(cloud_client, cloud_fake):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=0)
    answer(cloud_client, st, "My SQL is relational", source="voice")
    assert cloud_fake.models_used() == [CONVO, GRADER]


def test_the_report_summary_is_written_by_the_grader(cloud_client, cloud_fake):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=0)
    st = answer(cloud_client, st).json()
    act(cloud_client, state(cloud_client, st["id"]), "continue")
    assert cloud_fake.models_used() == [GRADER, GRADER]                                 # evaluation + summary


def test_follow_up_questions_are_written_by_the_conversation_model(cloud_client, cloud_fake):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=2)
    cloud_fake.replies = [good_eval(correctness=4, followup="Draft: how about keys?", missing=["Merge keys"])]
    st = answer(cloud_client, st, "partial answer").json()
    assert cloud_fake.models_used() == [GRADER, CONVO]
    st = state(cloud_client, st["id"])
    assert st["current"]["pending_followup"]["question"] == "Which key would you merge on, and why that one?"      # what the user will be asked
    assert evaluation(cloud_client, st["id"])["followup_asked"] is True
    body = cloud_fake.chats[1]["json"]
    assert "GAP TO PROBE: Merge keys" in body["messages"][1]["content"] and "Draft: how about keys?" in body["messages"][1]["content"]
    assert [r["purpose"] for r in cloud_client.app.state.c.usage.recent()][:2] == ["followup", "evaluation"]


@pytest.mark.parametrize("reason", ["no follow-up wanted", "limit is zero", "non-attempt", "no gap named"])
def test_no_extra_call_when_no_follow_up_will_be_asked(cloud_client, cloud_fake, reason):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=0 if reason == "limit is zero" else 2)
    if reason == "no follow-up wanted":
        cloud_fake.replies = [good_eval(correctness=9)]
        text = "a strong answer"
    elif reason == "limit is zero":
        cloud_fake.replies = [good_eval(correctness=4, followup="Why?", missing=["x"])]
        text = "partial"
    elif reason == "non-attempt":
        cloud_fake.replies = [good_eval(correctness=1, followup="Tell me more about keys?", missing=["x"])]
        text = "I don't know"
    else:
        cloud_fake.replies = [good_eval(correctness=4, followup="Which keys would you use?", missing=[])]
        text = "partial"
    answer(cloud_client, st, text)
    assert cloud_fake.models_used() == [GRADER]                                          # a follow-up writer was never called


def test_a_failing_follow_up_writer_keeps_the_graders_own_question_and_never_fails_the_evaluation(cloud_client, cloud_fake):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=2)
    draft = "Which merge key would you choose for late data?"
    cloud_fake.replies = [good_eval(correctness=4, followup=draft, missing=["Merge keys"]), 500]
    st = answer(cloud_client, st, "partial").json()
    st = state(cloud_client, st["id"])
    assert st["phase"] == "feedback" and st["current"]["pending_followup"]["question"] == draft
    assert cloud_fake.models_used() == [GRADER, CONVO]                                   # tried once, not retried


def test_a_follow_up_that_repeats_the_question_is_not_used(cloud_client, cloud_fake):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=2)
    draft = "Which merge key would you choose for late data?"
    cloud_fake.replies = [good_eval(correctness=4, followup=draft, missing=["Merge keys"]), {"question": "Question number 1?"}]
    answer(cloud_client, st, "partial")
    assert state(cloud_client, st["id"])["current"]["pending_followup"]["question"] == draft


# ---------------------------------------------------------------- fallback rules: help when a different model could help, never waste credits
def test_the_fallback_model_takes_over_when_the_grader_is_down(cloud_client, cloud_fake):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=0)
    cloud_fake.replies = [503]
    st = answer(cloud_client, st).json()
    assert cloud_fake.models_used() == [GRADER, FALLBACK]
    assert evaluation(cloud_client, st["id"])["graded_by"] == {"provider": "cloud", "model": FALLBACK, "fell_back_from": GRADER}
    assert state(cloud_client, st["id"])["phase"] == "feedback"


def test_an_unknown_grader_model_falls_back_to_the_other_one(cloud_client, cloud_fake):
    sid = setup(cloud_client, grader_model="not-a-real-model:1b")
    st = start_interview(cloud_client, sid, max_followups=0)
    cloud_fake.replies = [404]
    answer(cloud_client, st)
    assert cloud_fake.models_used() == ["not-a-real-model:1b", FALLBACK]


@pytest.mark.parametrize("status, code", [(401, "auth_failed"), (402, "no_credits"), (429, "rate_limited")])
def test_account_level_problems_are_not_retried_on_another_model(cloud_client, cloud_fake, status, code):
    """A different cloud model would hit the same wall, so a second paid attempt would only waste credits."""
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=0)
    cloud_fake.replies = [status]
    st = state(cloud_client, answer(cloud_client, st).json()["id"])
    assert cloud_fake.models_used() == [GRADER]
    assert st["phase"] == "evaluation_failed" and st["error"]
    assert "Retry" in st["error"] or "Settings" in st["error"] or "credits" in st["error"] or "key" in st["error"]


def test_retry_after_fixing_the_problem_works_and_costs_one_call(cloud_client, cloud_fake):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=0)
    cloud_fake.replies = [429]
    st = state(cloud_client, answer(cloud_client, st).json()["id"])
    assert st["phase"] == "evaluation_failed" and st["answer_saved"] if "answer_saved" in st else True
    r = cloud_client.post(f"/api/interviews/{st['id']}/retry", json={"turn_id": st["current_turn_id"]})
    assert r.status_code == 200 and state(cloud_client, st["id"])["phase"] == "feedback"
    assert cloud_fake.models_used() == [GRADER, GRADER]


def test_fallback_can_be_turned_off(cloud_client, cloud_fake):
    sid = setup(cloud_client, use_fallback=False)
    st = start_interview(cloud_client, sid, max_followups=0)
    cloud_fake.replies = [503]
    st = state(cloud_client, answer(cloud_client, st).json()["id"])
    assert cloud_fake.models_used() == [GRADER] and st["phase"] == "evaluation_failed"


def test_both_cloud_models_failing_ends_in_a_clear_error_with_the_answer_kept(cloud_client, cloud_fake):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=0)
    cloud_fake.replies = [503, 503]
    st = state(cloud_client, answer(cloud_client, st, "my precious answer").json()["id"])
    assert cloud_fake.models_used() == [GRADER, FALLBACK] and st["phase"] == "evaluation_failed"
    assert "Ollama cloud" in st["error"]
    assert "my precious answer" in json.dumps(st["current"]["thread"])


def test_the_local_model_helps_only_if_the_user_allowed_it(cloud_client, cloud_fake, fake):
    sid = setup(cloud_client, fallback_to_local=True)
    st = start_interview(cloud_client, sid, max_followups=0)
    cloud_fake.replies = [503, 503]
    st = answer(cloud_client, st).json()
    assert cloud_fake.models_used() == [GRADER, FALLBACK] and len(fake.chat_calls) == 1
    g = evaluation(cloud_client, st["id"])["graded_by"]
    assert g["provider"] == "local" and g["model"] == "qwen3.5:4b" and g["fell_back_from"] == GRADER and "Ollama cloud" in g["reason"]


def test_without_that_permission_a_cloud_failure_stays_a_failure(cloud_client, cloud_fake, fake):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=0)
    cloud_fake.replies = [503, 503]
    answer(cloud_client, st)
    assert fake.chat_calls == []


def test_a_failing_local_fallback_reports_both_problems(cloud_client, cloud_fake, fake):
    sid = setup(cloud_client, fallback_to_local=True)
    st = start_interview(cloud_client, sid, max_followups=0)
    cloud_fake.replies = [503, 503]
    fake.up = False
    st = state(cloud_client, answer(cloud_client, st).json()["id"])
    assert st["phase"] == "evaluation_failed" and "could not help either" in st["error"]


# ---------------------------------------------------------------- the budget guard
def test_the_daily_budget_stops_calls_before_they_are_made(cloud_client, cloud_fake):
    sid = setup(cloud_client, daily_budget_usd=0.0004)                                   # one grading costs 0.000405
    add_questions(cloud_client, sid, 1)
    st = start_interview(cloud_client, sid, max_followups=0)
    st = answer(cloud_client, st).json()
    assert state(cloud_client, st["id"])["phase"] == "feedback" and len(cloud_fake.chats) == 1
    st = act(cloud_client, state(cloud_client, st["id"]), "continue").json()           # next question
    before = len(cloud_fake.chats)
    st = state(cloud_client, answer(cloud_client, state(cloud_client, st["id"]), "second").json()["id"])
    assert len(cloud_fake.chats) == before                                               # NO request was made
    assert st["phase"] == "evaluation_failed" and "daily cloud budget is used up" in st["error"]


def test_the_total_budget_also_stops_calls(cloud_client, cloud_fake):
    sid = setup(cloud_client, daily_budget_usd=None, total_budget_usd=0.0001)
    cloud_client.app.state.c.usage.record({"model": GRADER, "purpose": "evaluation", "provider": "cloud", "prompt_tokens": 5000, "output_tokens": 5000, "total_ms": 1})
    st = start_interview(cloud_client, sid, max_followups=0)
    st = state(cloud_client, answer(cloud_client, st).json()["id"])
    assert cloud_fake.chats == [] and "total cloud budget is used up" in st["error"]


def test_with_the_budget_switched_off_calls_continue(cloud_client, cloud_fake):
    sid = setup(cloud_client, daily_budget_usd=0.000001, enforce_budget=False)
    st = start_interview(cloud_client, sid, max_followups=0)
    answer(cloud_client, st)
    assert len(cloud_fake.chats) == 1


def test_a_used_up_budget_can_hand_over_to_the_local_model_if_allowed(cloud_client, cloud_fake, fake):
    sid = setup(cloud_client, daily_budget_usd=0, fallback_to_local=True)
    st = start_interview(cloud_client, sid, max_followups=0)
    st = answer(cloud_client, st).json()
    assert cloud_fake.chats == [] and len(fake.chat_calls) == 1
    assert evaluation(cloud_client, st["id"])["graded_by"]["provider"] == "local"


def test_budget_status_reports_progress(cloud_client, cloud_fake):
    sid = setup(cloud_client, daily_budget_usd=0.001)
    st = start_interview(cloud_client, sid, max_followups=0)
    answer(cloud_client, st)
    b = cloud_client.get("/api/ai").json()["budget"]["today"]
    assert b["spent_usd"] == 0.000405 and b["limit_usd"] == 0.001 and b["percent"] == 40 and b["reached"] is False
    assert cloud_client.get("/api/health").json()["ai"]["budget"]["today"]["spent_usd"] == 0.000405


# ---------------------------------------------------------------- cost tracking
def test_costs_are_recorded_per_call_and_summarised(cloud_client, cloud_fake):
    sid = setup(cloud_client, n=2)
    st = start_interview(cloud_client, sid, max_followups=0)
    st = answer(cloud_client, st).json()
    st = act(cloud_client, state(cloud_client, st["id"]), "continue").json()
    answer(cloud_client, state(cloud_client, st["id"]), "second")
    u = cloud_client.get("/api/usage").json()
    ev = next(s for s in u["summary"] if s["purpose"] == "evaluation")
    assert ev["provider"] == "cloud" and ev["calls"] == 2 and ev["cost_usd"] == 0.00081 and ev["unpriced_calls"] == 0
    assert u["totals"]["all_time"]["cost_usd"] >= 0.00081 and u["totals"]["today"]["cloud_calls"] >= 2
    assert u["budget"]["today"]["spent_usd"] == u["totals"]["today"]["cost_usd"]


def test_a_model_with_no_price_is_unknown_not_free_and_does_not_count_toward_the_budget(cloud_client, cloud_fake):
    sid = setup(cloud_client, grader_model="acme-future-1")
    st = start_interview(cloud_client, sid, max_followups=0)
    answer(cloud_client, st)
    rec = cloud_client.app.state.c.usage.recent()[0]
    assert rec["model"] == "acme-future-1" and rec["cost_usd"] is None
    s = cloud_client.get("/api/usage").json()
    assert s["summary"][0]["unpriced_calls"] == 1 and s["totals"]["all_time"]["unpriced_calls"] == 1
    cloud_client.put("/api/ai", json={"prices": {"acme-future-1": {"input_per_m": 1.0, "output_per_m": 4.0}}})
    answer_text = "again"
    st2 = start_interview(cloud_client, sid, max_followups=0, replace=True)
    answer(cloud_client, st2, answer_text)
    assert cloud_client.app.state.c.usage.recent()[0]["cost_usd"] == round((900 * 1.0 + 450 * 4.0) / 1e6, 6)


def test_the_provider_filter_separates_local_and_cloud_numbers(cloud_client, cloud_fake, fake):
    sid = cloud_client.get("/api/sets").json()[0]["id"]
    add_questions(cloud_client, sid, 2)
    st = start_interview(cloud_client, sid, max_followups=0)
    answer(cloud_client, st)                                                             # local
    enable_cloud(cloud_client)
    st2 = start_interview(cloud_client, sid, max_followups=0, replace=True)
    answer(cloud_client, st2)                                                            # cloud
    for provider, expected in (("local", {"local"}), ("cloud", {"cloud"}), ("all", {"local", "cloud"})):
        d = cloud_client.get(f"/api/usage?provider={provider}").json()
        assert {s["provider"] for s in d["summary"]} == expected and {r["provider"] for r in d["recent"]} == expected


def test_the_report_shows_what_this_interview_cost(cloud_client, cloud_fake):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=0)
    st = answer(cloud_client, st).json()
    act(cloud_client, state(cloud_client, st["id"]), "continue")
    ai = cloud_client.get(f"/api/interviews/{st['id']}/report").json()["ai_usage"]
    assert ai["calls"] == 2 and ai["cost_usd"] > 0 and set(ai["by_provider"]) == {"cloud"}


# ---------------------------------------------------------------- housekeeping that must not touch anything
def test_warming_and_releasing_do_nothing_in_cloud_mode(cloud_client, cloud_fake, fake):
    setup(cloud_client)
    assert cloud_client.post("/api/llm/warm").json() == {"status": "cloud"}
    assert fake.generate_calls == [] and cloud_fake.requests == []


def test_reading_settings_health_and_usage_never_calls_the_cloud(cloud_client, cloud_fake):
    setup(cloud_client)
    for _ in range(3):
        for path in ("/api/ai", "/api/health", "/api/usage", "/api/stats"):
            assert cloud_client.get(path).status_code == 200
    assert cloud_fake.requests == []


def test_health_describes_the_engine_without_secrets(cloud_client):
    assert cloud_client.get("/api/health").json()["ai"]["mode"] == "local"
    setup(cloud_client)
    ai = cloud_client.get("/api/health").json()["ai"]
    assert ai["mode"] == "cloud" and ai["processing"] == "cloud" and ai["ready"] is True and ai["grader_model"] == GRADER and ai["key_set"] and ai["consented"]


# ---------------------------------------------------------------- optional polish never costs a second paid call
def test_a_failing_voice_cleanup_uses_the_raw_transcript_and_does_not_try_another_model(cloud_client, cloud_fake):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=0)
    cloud_fake.replies = [503]                                                            # the conversation model is down for the cleanup call
    st = answer(cloud_client, st, "My SQL is relational", source="voice").json()
    assert cloud_fake.models_used() == [CONVO, GRADER]                                    # no deepseek attempt for the cleanup
    assert state(cloud_client, st["id"])["phase"] == "feedback"
    assert "My SQL is relational" in cloud_fake.chats[1]["json"]["messages"][1]["content"]   # the raw words were graded


def test_the_local_model_is_not_loaded_just_to_polish_a_follow_up(cloud_client, cloud_fake, fake):
    sid = setup(cloud_client, fallback_to_local=True)
    st = start_interview(cloud_client, sid, max_followups=2)
    cloud_fake.replies = [good_eval(correctness=4, followup="Which merge key would you choose?", missing=["Merge keys"]), 503]
    answer(cloud_client, st, "partial")
    assert fake.chat_calls == [] and fake.generate_calls == []


def test_the_fallback_model_is_only_for_essential_work(cloud_client, cloud_fake):
    sid = setup(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=2)
    cloud_fake.replies = [good_eval(correctness=4, followup="Which merge key would you choose?", missing=["Merge keys"]), 503]
    answer(cloud_client, st, "partial")
    assert FALLBACK not in cloud_fake.models_used()
