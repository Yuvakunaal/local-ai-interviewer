"""Grading fairness: basic questions, spoken answers and speech-recognition garble (the "MySQL" complaint)."""
import json

import pytest

from app.schemas import DimensionScores, LLMEvaluation, RubricSettings
from app.services.evaluator import (EvalContext, Evaluator, compute_score, drop_unclear, question_level)
from app.services.prompts import VOICE_NOTE, eval_system_prompt, eval_user_prompt
from conftest import act, add_questions, answer, good_eval, make_client_for, start_interview, state

W = RubricSettings()
# a correct, clear, complete answer to a *definition* question: little depth, no real-world example
DEFINITION_ANSWER = DimensionScores(correctness=9, completeness=8, depth=3, practical_application=1, clarity=9, production_awareness=0)


# ---------------------------------------------------------------- scoring by question level
def test_basic_questions_are_not_capped_by_depth_and_examples():
    standard = compute_score(DEFINITION_ANSWER, False, W, "standard")
    basic = compute_score(DEFINITION_ANSWER, False, W, "basic")
    assert basic > standard + 1.0                      # the same answer is worth clearly more on a basic question
    assert basic >= 7.0                                # and a correct, clear, complete definition now reads as good
    assert compute_score(DEFINITION_ANSWER, False, W) == standard   # level defaults to "standard": old behaviour unchanged


def test_basic_level_cannot_rescue_a_wrong_answer():
    wrong = DimensionScores(correctness=1, completeness=1, depth=0, practical_application=0, clarity=3, production_awareness=0)
    assert compute_score(wrong, False, W, "basic") <= 2.0


def test_user_set_difficulty_overrides_the_models_guess():
    assert question_level("advanced", "easy") == "basic"
    assert question_level("basic", "hard") == "advanced"
    assert question_level("basic", "medium") == "standard"
    assert question_level("basic", None) == "basic" and question_level("", "") == "standard"


def test_unknown_model_level_falls_back_to_standard():
    assert LLMEvaluation.model_validate({**good_eval(), "question_level": "PhD-level"}).question_level == "standard"
    assert LLMEvaluation.model_validate({**good_eval(), "question_level": " Basic "}).question_level == "basic"
    assert LLMEvaluation.model_validate(good_eval()).question_level == "standard"


# ---------------------------------------------------------------- dropping phrases the model could not understand
def test_drop_unclear_removes_only_the_flagged_phrase_and_tidies_punctuation():
    text = "MySQL is a relational database, and inside the table squaring, like DML and DDL operations."
    assert drop_unclear(text, ["inside the table squaring"]) == "MySQL is a relational database, and like DML and DDL operations."
    assert drop_unclear(text, ["INSIDE THE TABLE SQUARING"]).startswith("MySQL is a relational database")   # case-insensitive


def test_drop_unclear_ignores_phrases_that_are_not_there_or_too_long_and_never_gutters_an_answer():
    text = "MySQL is a relational database that stores data in tables."
    assert drop_unclear(text, ["something never said"]) == text
    assert drop_unclear(text, ["one two three four five six seven eight nine"]) == text      # > 8 words: ignored
    assert drop_unclear(text, ["MySQL is a relational database that stores"]) == text        # would remove most of it: refuse
    assert drop_unclear(text, []) == text and drop_unclear(text, [""]) == text


# ---------------------------------------------------------------- prompts
def test_system_prompt_scopes_gaps_to_the_question_and_calibrates():
    p = eval_system_prompt("technical", "balanced", RubricSettings())
    assert "AS ASKED" in p and "licensing" in p                       # no licensing/history trivia as "gaps"
    assert "basic" in p and "CALIBRATION" in p and "primary key" in p
    assert "not misconceptions" in p.lower() or "NOT misconceptions" in p


def test_voice_note_is_only_sent_for_spoken_answers():
    kw = dict(question="What is MySQL?", rubric=None, topic=None, difficulty=None, thread=[], current_question="What is MySQL?",
              current_kind="main", answer="My SQL is a relational database", followups_remaining=1)
    assert VOICE_NOTE in eval_user_prompt(**kw, answer_source="voice")
    assert VOICE_NOTE not in eval_user_prompt(**kw, answer_source="typed")
    assert VOICE_NOTE not in eval_user_prompt(**kw)
    assert "nonsensical" in VOICE_NOTE and "Never penalise" in VOICE_NOTE


# ---------------------------------------------------------------- transcript repair
def evaluator(settings, fake) -> Evaluator:
    return Evaluator(make_client_for(settings, fake))


def test_repair_returns_the_repaired_text_and_drops_unclear_phrases(settings, fake):
    fake.chat_replies = [{"text": "MySQL is a relational database. It does squaring things like DML and DDL.", "unclear": ["squaring things"]}]
    out = evaluator(settings, fake).interpret_transcript("What is MySQL?", "My SQL is a relational database it does squaring things like DML-DDR")
    assert out == "MySQL is a relational database. It does like DML and DDL."
    sent = json.dumps(fake.chat_calls[0]["messages"])
    assert "speech-recognition" in sent and "TRANSCRIPT" in sent                                  # repair prompt, transcript fenced as data


@pytest.mark.parametrize("reply", ["not json at all", {"text": ""}, {"nothing": 1}, ["a list"], {"text": "x" * 900, "unclear": []}])
def test_repair_falls_back_to_the_original_transcript_on_any_problem(settings, fake, reply):
    fake.chat_replies = [reply]
    original = "My SQL is a relational database"
    assert evaluator(settings, fake).interpret_transcript("What is MySQL?", original) == original


def test_repair_falls_back_when_the_model_is_unavailable(settings, fake):
    fake.up = False
    original = "My SQL is a relational database"
    assert evaluator(settings, fake).interpret_transcript("What is MySQL?", original) == original


# ---------------------------------------------------------------- end to end through the API
def test_spoken_answer_is_repaired_then_graded_and_the_ui_can_show_what_was_graded(client, set_id, fake):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    fake.chat_replies = [{"text": "MySQL is a relational database with DML and DDL operations.", "unclear": []},
                         {**good_eval(correctness=7), "question_level": "basic"}]
    st = answer(client, st, "My SQL is a relational database with DML-DDR operations", source="voice").json()
    st = state(client, st["id"])
    assert len(fake.chat_calls) == 2                                                    # repair + grading
    graded_prompt = fake.chat_calls[1]["messages"][1]["content"]
    candidate = graded_prompt.split("<<<CANDIDATE_ANSWER", 1)[1]                        # (the voice note itself mentions "DML-DDR" as an example)
    assert "DML and DDL operations" in candidate and "DML-DDR" not in candidate         # the grader never sees the garble
    assert VOICE_NOTE in graded_prompt
    ev = st["current"]["turn"]["evaluation"] if st["current"]["turn"] else st["current"]["thread"][0]["evaluation"]
    assert ev["interpreted_answer"] == "MySQL is a relational database with DML and DDL operations."
    assert ev["question_level"] == "basic"
    # the original words are still what is stored and shown as the user's answer
    assert "DML-DDR" in json.dumps(st["current"]["thread"])


def test_typed_answers_skip_the_repair_step_and_the_note(client, set_id, fake):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    st = state(client, answer(client, st, "A typed answer about DML and DDL").json()["id"])
    assert len(fake.chat_calls) == 1
    assert VOICE_NOTE not in fake.chat_calls[0]["messages"][1]["content"]
    ev = st["current"]["thread"][0]["evaluation"]
    assert ev["interpreted_answer"] is None


def test_unchanged_spoken_answer_is_not_reported_as_repaired(client, set_id, fake):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    text = "MySQL is a relational database"
    fake.chat_replies = [{"text": text, "unclear": []}, good_eval()]
    st = state(client, answer(client, st, text, source="voice").json()["id"])
    assert st["current"]["thread"][0]["evaluation"]["interpreted_answer"] is None


def test_difficulty_set_on_the_question_overrides_the_models_level(client, set_id, fake):
    add_questions(client, set_id, 1, difficulty="easy")
    st = start_interview(client, set_id, max_followups=0)
    fake.chat_replies = [{**good_eval(correctness=9), "question_level": "advanced"}]
    st = state(client, answer(client, st, "An answer").json()["id"])
    assert st["current"]["thread"][0]["evaluation"]["question_level"] == "basic"


# ---------------------------------------------------------------- the speech recogniser is primed with technical words from many fields
def test_whisper_vocabulary_covers_many_technical_fields_not_one():
    from app.services.stt import VOCAB_PROMPT

    for word in ("idempotency", "Kubernetes", "OAuth", "GraphQL", "TypeScript", "MySQL", "InnoDB", "GROUP BY", "ACID", "PostgreSQL", "MERGE", "overfitting", "Terraform"):
        assert word in VOCAB_PROMPT
    assert "data engineering" not in VOCAB_PROMPT.lower()


def test_whisper_vocabulary_stays_within_whispers_prompt_window():
    """Whisper keeps only the last 223 prompt tokens; a longer list silently drops the START (this once broke "idempotency")."""
    from app.services.stt import VOCAB_PROMPT

    assert len(VOCAB_PROMPT) <= 700, "keep the vocabulary short (about 4 characters per token; the limit is 223 tokens)"


def test_whisper_vocabulary_token_count_with_the_real_tokenizer():
    from app.config import Settings

    try:
        import os
        os.environ["HF_HUB_OFFLINE"] = "1"
        from faster_whisper import WhisperModel
        tokenizer = WhisperModel(Settings().stt_model, device="cpu", compute_type="int8").hf_tokenizer
    except Exception:
        pytest.skip("the local Whisper model is not installed")
    from app.services.stt import VOCAB_PROMPT

    assert len(tokenizer.encode(" " + VOCAB_PROMPT.strip()).ids) <= 200
