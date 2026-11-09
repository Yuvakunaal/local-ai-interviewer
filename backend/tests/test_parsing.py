from app.parsing import normalize_for_dedupe, preview_json, preview_text, split_questions

EXAMPLE = """What is the difference between a data lake and a data warehouse?
--
How would you handle duplicate records in a production pipeline?
--
Explain incremental data loading and idempotency.
--
How would you investigate a failed Snowflake pipeline?"""


def test_splits_on_standalone_separator_lines():
    parts = split_questions(EXAMPLE)
    assert len(parts) == 4
    assert parts[0].endswith("data warehouse?")
    assert parts[3] == "How would you investigate a failed Snowflake pipeline?"


def test_hyphens_never_split():
    text = "Explain ETL - ELT trade-offs -- briefly.\nUse a well-known example (e.g. Kimball-style).\n---\n- bullet one\n- bullet two"
    parts = split_questions(text)
    assert parts == [text]


def test_multiline_question_and_punctuation_preserved():
    text = "Given:\n  SELECT *\n  FROM t\nWhat happens with NULL's?\n--\nSecond?"
    assert split_questions(text)[0] == "Given:\n  SELECT *\n  FROM t\nWhat happens with NULL's?"


def test_whitespace_and_empty_sections_ignored_and_crlf():
    text = "\n\n  A?  \r\n--\r\n\r\n--\r\n   \r\n--  \r\nB?\r\n  --\r\n"
    assert split_questions(text) == ["A?", "B?"]


def test_empty_input_gives_clear_error():
    p = preview_text("  \n ", [])
    assert p.count == 0 and "empty" in p.errors[0].lower()
    p2 = preview_text("--\n--", [])
    assert p2.count == 0 and "No questions detected" in p2.errors[0]


def test_inline_double_dash_warning_keeps_one_question():
    p = preview_text("What is X -- and why?", [])
    assert p.count == 1 and p.warnings


def test_duplicate_detection_existing_and_batch():
    p = preview_text("What is  a CTE?\n--\nwhat is a cte\n--\nNew one?", ["What is a CTE"])
    flags = [i.duplicate for i in p.items]
    assert flags == ["existing", "existing", None]
    p = preview_text("A?\n--\na\n--\nB", [])
    assert [i.duplicate for i in p.items] == [None, "batch", None]
    assert normalize_for_dedupe("  Hello   World?! ") == "hello world"


def test_too_long_question_is_flagged():
    p = preview_text("x" * 4100, [])
    assert p.errors and p.items[0].error


def test_json_import_variants_and_errors():
    ok = preview_json('{"name":"S","questions":[{"text":"Q1?","rubric":"r","topic":"SQL","difficulty":"Hard"},"Q2?"]}', [])
    assert ok.count == 2 and ok.items[0].difficulty == "hard" and ok.set_name == "S"
    assert preview_json("[{bad", []).errors[0].startswith("Invalid JSON")
    assert "Expected" in preview_json('{"foo": 1}', []).errors[0]
    bad = preview_json('[{"text":"ok?"},{"text":""},{"text":"x","difficulty":"extreme"},5]', [])
    assert bad.count == 1 and len(bad.errors) == 3
    assert preview_json("", []).errors
