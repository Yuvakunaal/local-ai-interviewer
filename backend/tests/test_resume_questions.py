"""Questions about the candidate's resume: claims, allocation, what the code enforces, and how they run through interviews and reports."""
from __future__ import annotations

import json
import re

import pytest

from app.schemas import ResumeProfile
from app.services.resume_profile import coerce_profile
from app.services.resume_questions import (Claim, DraftBatch, QuestionWriter, Slot, acceptable_text, allocate, build_claims, parse_when,
                                           references_claim)
from conftest import act, add_questions, answer, enable_cloud, good_eval, start_interview
from resume_fixtures import profile_reply, text_pdf, two_column_pdf
from test_resumes import upload

ANGLES = {"project_deep_dive": "Walk me through how you built", "tech_depth": "How does your experience with", "metric_challenge": "How did you measure",
          "ownership_behavioural": "Tell me about a moment you owned", "decision_tradeoff": "Which trade-offs did you weigh in", "failure_learning": "What went wrong in",
          "gap_transition": "What led to the change in"}


def claims_in(prompt: str) -> list[tuple[str, str, list[str]]]:
    out = []
    for m in re.finditer(r"CLAIM (C\d+) - [^:]+: (.+)\nRequested kinds: (.+)", prompt):
        kinds = [k.split(" (")[0].strip() for k in re.findall(r"(\w+) \(", m.group(3))]
        out.append((m.group(1), m.group(2), kinds))
    return out


def writer_reply(extra=None, drop=0):
    """A well-behaved question writer: one specific question per requested kind, naming the claim."""
    def reply(body):
        user = body["messages"][1]["content"]
        if "<<<CLAIM" not in user:
            return good_eval()
        qs = []
        for ref, label, kinds in claims_in(user):
            for k in kinds:
                qs.append({"claim_ref": ref, "kind": k, "text": f"{ANGLES[k]} {label}, and what was your own part in it?",
                           "rubric": "Names their own role, a concrete decision and how the result was measured.", "topic": "Backend", "difficulty": "medium"})
        qs = qs[: len(qs) - drop] if drop else qs
        return {"questions": qs + (extra or [])}
    return reply


@pytest.fixture
def ready(client, fake):
    fake.chat_replies = [profile_reply()]
    return upload(client, text_pdf()).json()


def generate(client, ids, **kw):
    body = {"resume_ids": ids, "count": 8, "focus": ["experience", "projects", "skills", "achievements"], **kw}
    return client.post("/api/resumes/questions/generate", json=body)


# ---------------------------------------------------------------- claims and allocation (pure)
def profile() -> ResumeProfile:
    return coerce_profile(profile_reply())


def test_claims_cover_roles_metrics_projects_skills_education_and_transitions():
    claims = build_claims(7, "Resume 1", profile())
    sections = {c.section for c in claims}
    assert {"Experience", "Projects", "Skills", "Education", "Career"} <= sections
    metric = [c for c in claims if "achievements" in c.focus]
    assert any("40%" in c.excerpt for c in metric) and any("2M events" in c.excerpt for c in metric)
    gap = next(c for c in claims if c.section == "Career")
    assert gap.label.startswith("Gap between Globex and Acme Corp") and "9 months" in gap.excerpt
    assert all(len(c.excerpt) <= 400 and c.resume_id == 7 for c in claims)
    assert parse_when("Mar 2021") .month == 3 and parse_when("06/2020").month == 6 and parse_when("present") is None


def test_allocation_is_round_robin_over_focus_and_resumes_and_respects_depth():
    a = build_claims(1, "Resume 1", profile())
    b = build_claims(2, "Resume 2", coerce_profile(profile_reply(experience=[{"company": "Initech", "title": "Data Engineer", "bullets": ["Designed CDC ingestion"]}], projects=[])))
    slots = allocate([a, b], ["experience", "skills"], 6, "overview")
    assert len(slots) == 6
    assert [s.focus for s in slots[:4]] == ["experience", "experience", "skills", "skills"]
    assert [s.claim.resume_id for s in slots[:4]] == [1, 2, 1, 2]
    assert len({s.claim.ref for s in slots}) == 6                       # overview: one question per claim
    deep = allocate([a], ["projects"], 6, "deep")
    assert len(deep) == 3 and len({s.claim.ref for s in deep}) == 1 and len({s.kind for s in deep}) == 3      # one project, 3 angles
    std = allocate([a], ["projects"], 6, "standard")
    assert len(std) == 2 and std[0].kind != std[1].kind                  # standard allows a second, different question per claim
    assert allocate([a], ["education"], 3, "overview")[0].claim.section == "Education"


def test_question_checks_in_code():
    c = Claim("r1:x", 1, "Resume 1", "Experience", "Senior Backend Engineer at Acme Corp", "Cut p95 API latency by 40% by moving hot reads to Redis", {"experience"})
    assert references_claim("How did you measure the 40% latency improvement?", c)
    assert references_claim("Why Redis for the hot reads?", c)
    assert not references_claim("What is your greatest weakness?", c)
    assert acceptable_text("Did you lead the whole migration yourself?") == "yes/no" and acceptable_text("Did you lead it?") == "length"
    assert acceptable_text("Why?") and acceptable_text("Why?") == "length" and acceptable_text("x" * 401) == "length"
    assert acceptable_text("Walk me through the Redis change at Acme Corp.") is None


def test_writer_enforces_count_cap_dedupe_and_references():
    c1 = Claim("r1:a", 1, "R", "Experience", "Platform at Acme Corp", "Led the migration of 30 services to Kubernetes", {"experience"})
    slots = [Slot(c1, "project_deep_dive", "experience"), Slot(c1, "decision_tradeoff", "experience")]
    batches = [
        DraftBatch(questions=[
            {"claim_ref": "C1", "kind": "project_deep_dive", "text": "Walk me through the Kubernetes migration at Acme Corp and your part in it."},
            {"claim_ref": "C1", "kind": "decision_tradeoff", "text": "Walk me through the Kubernetes migration at Acme Corp, and your part in it?"},   # near-duplicate
            {"claim_ref": "C1", "kind": "decision_tradeoff", "text": "What is your favourite colour and why do you like it so much?"},        # not about the claim
            {"claim_ref": "C9", "kind": "tech_depth", "text": "How did the Kubernetes services get split up at Acme Corp?"},                 # unknown claim
            {"claim_ref": "C1", "kind": "tech_depth", "text": "Did you migrate all 30 services yourself?"}]),                                 # yes/no
        DraftBatch(questions=[{"claim_ref": "C1", "kind": "decision_tradeoff", "text": "Which trade-offs made you move the 30 services to Kubernetes rather than VMs?",
                               "difficulty": "nonsense", "topic": ""}]),
    ]
    calls = []
    w = QuestionWriter(lambda m: (calls.append(m), batches.pop(0))[1], style="skeptic", difficulty="hard")
    res = w.run(slots, exclude=[], per_claim_cap=2)
    assert [q["kind"] for q in res.questions] == ["project_deep_dive", "decision_tradeoff"] and len(calls) == 2       # one top-up request
    assert all(q["difficulty"] == "hard" for q in res.questions) and res.questions[1]["topic"] == "Experience" and not res.warnings
    assert "sceptical senior engineer" in calls[0][0]["content"] and "<<<CLAIM" in calls[0][1]["content"]
    assert "Walk me through the Kubernetes migration" in calls[1][1]["content"]           # the top-up is told what already exists


# ---------------------------------------------------------------- the API
def test_generate_returns_exactly_the_requested_count_with_claim_chips(client, fake, ready):
    fake.chat_replies = [writer_reply(extra=[{"claim_ref": "C1", "kind": "tech_depth", "text": "An extra one nobody asked for about Acme Corp?"}])] * 10
    job = generate(client, [ready["id"]], count=5).json()
    assert job["state"] == "done" and len(job["questions"]) == 5 and job["warnings"] == []
    q = job["questions"][0]
    assert q["resume_id"] == ready["id"] and q["resume_name"] == "Resume 1" and q["claim"]["section"] and len(q["claim"]["excerpt"]) <= 400
    assert {"text", "rubric", "topic", "difficulty", "kind"} <= set(q)
    calls = [c for c in fake.chat_calls if "<<<CLAIM" in c["messages"][1]["content"]]
    assert calls and all(len(claims_in(c["messages"][1]["content"])) <= 4 for c in calls)        # at most 4 claims per request
    assert client.get(f"/api/resumes/questions/jobs/{job['id']}").json()["state"] == "done"
    rows = client.app.state.c.usage.recent()
    assert rows[0]["purpose"] == "resume_questions" and rows[0]["label"] == "Resume questions"


def test_focus_areas_decide_what_is_asked(client, fake, ready):
    fake.chat_replies = [writer_reply()] * 10
    job = generate(client, [ready["id"]], count=3, focus=["skills"], depth="overview").json()
    assert {q["claim"]["section"] for q in job["questions"]} <= {"Skills", "Projects"}
    assert all(q["kind"] in ("tech_depth", "decision_tradeoff", "failure_learning") for q in job["questions"])


def test_under_delivery_tops_up_then_warns_and_never_invents(client, fake, ready):
    fake.chat_replies = [writer_reply(drop=1)] + [{"questions": []}] * 20
    job = generate(client, [ready["id"]], count=4, focus=["experience", "skills", "projects"], depth="overview").json()
    assert job["state"] == "done" and len(job["questions"]) == 3
    assert job["warnings"] and "Only 3 of 4" in job["warnings"][0]


def test_regenerate_one_differs_from_the_existing_questions(client, fake, ready):
    fake.chat_replies = [writer_reply()] * 5
    q = generate(client, [ready["id"]], count=3, depth="overview").json()["questions"][0]
    def other(body):
        ref, label, kinds = claims_in(body["messages"][1]["content"])[0]
        assert q["text"][:60] in body["messages"][1]["content"]                 # the model is told not to repeat it
        return {"questions": [{"claim_ref": ref, "kind": kinds[0], "text": q["text"]},                      # same again -> rejected
                              {"claim_ref": ref, "kind": kinds[0], "text": f"Looking back at {label}, what would you do differently today?"}]}
    fake.chat_replies = [other]
    new = client.post("/api/resumes/questions/generate-one", json={"resume_id": ready["id"], "claim": q["claim"], "kind": q["kind"], "existing_texts": [q["text"]]})
    assert new.status_code == 200 and new.json()["text"] != q["text"] and "differently" in new.json()["text"]
    fake.chat_replies = [{"questions": []}] * 4
    none = client.post("/api/resumes/questions/generate-one", json={"resume_id": ready["id"], "claim": q["claim"], "existing_texts": [q["text"]]})
    assert none.status_code == 422 and none.json()["error"]["code"] == "no_question"


def test_generation_needs_ready_resumes_material_and_cloud_consent(client, cloud_client, fake, cloud_fake):
    assert generate(client, [999]).status_code == 404
    fake.chat_replies = ["garbage"] * 2
    failed = upload(client, two_column_pdf()).json()
    assert generate(client, [failed["id"]]).json()["error"]["code"] == "resume_not_ready"
    fake.chat_replies = [profile_reply(experience=[], projects=[], skills=[], education=[], achievements=[], certifications=[], summary="")]
    thin = upload(client, text_pdf()).json()
    thin = client.patch(f"/api/resumes/{thin['id']}", json={"revision": thin["revision"], "profile": {"contact": {"name": "Jane"}}}).json()
    assert generate(client, [thin["id"]]).status_code == 422
    enable_cloud(cloud_client)
    r = upload(cloud_client, text_pdf()).json()
    cloud_fake.replies = [profile_reply()]
    cloud_client.post(f"/api/resumes/{r['id']}/consent", json={"accept": True})
    r2 = upload(cloud_client, two_column_pdf(), allow_duplicate="true").json()           # not yet allowed to go to the cloud
    res = generate(cloud_client, [r["id"], r2["id"]])
    assert res.status_code == 409 and res.json()["error"]["code"] == "resume_not_ready"
    # the consented one alone works
    cloud_fake.default = writer_reply()
    ok = generate(cloud_client, [r["id"]], count=3)
    assert ok.status_code == 200 and len(ok.json()["questions"]) == 3


def test_cloud_generation_requires_per_resume_consent(cloud_client, cloud_fake, fake):
    fake.chat_replies = [profile_reply()]
    r = upload(cloud_client, text_pdf())          # local mode: read and organised locally by the fake local model
    rid = r.json()["id"]
    enable_cloud(cloud_client)
    res = generate(cloud_client, [rid])
    assert res.status_code == 409 and res.json()["error"]["code"] == "cloud_consent_required" and res.json()["error"]["resume_ids"] == [rid]
    assert cloud_fake.chats == []


def test_save_to_bank_creates_a_from_set_and_skips_duplicates(client, fake, ready):
    fake.chat_replies = [writer_reply()] * 5
    qs = generate(client, [ready["id"]], count=3, depth="overview").json()["questions"]
    body = {"questions": [{k: q[k] for k in ("text", "rubric", "topic", "difficulty", "resume_id", "resume_name", "claim")} for q in qs]}
    first = client.post("/api/resumes/questions/save-to-bank", json=body).json()
    assert first["added"] == 3 and first["sets"][0]["name"] == "From Resume 1"
    again = client.post("/api/resumes/questions/save-to-bank", json=body).json()
    assert again == {"added": 0, "skipped": 3, "sets": first["sets"]}


# ---------------------------------------------------------------- interviews with resume questions
def rq(text, rid, label="Senior Backend Engineer at Acme Corp", section="Experience", topic="Backend"):
    return {"text": text, "rubric": "Their own role and a measured result.", "topic": topic, "difficulty": "medium", "kind": "project_deep_dive",
            "resume_id": rid, "resume_name": "something the browser sent", "claim": {"section": section, "label": label, "excerpt": ("Cut p95 API latency by 40%. " * 30)[:400]}}


def create(client, set_id=None, resume_questions=(), **cfg):
    return client.post("/api/interviews", json={"set_id": set_id, "config": {"title": "R", "max_followups": 0, "feedback_mode": "at_end", **cfg}, "resume_questions": list(resume_questions)})


def test_resume_only_interview_has_no_set_and_snapshots_the_resume_name(client, fake, ready):
    r = create(client, None, [rq("How did you cut the API latency at Acme Corp?", ready["id"])], include_bank=False)
    assert r.status_code == 201, r.text
    st = r.json()
    assert st["items"][0]["source"] == "resume" and st["items"][0]["resume_name"] == "Resume 1"      # the server's name, not the browser's
    assert st["current"]["item"]["source"] == "resume"
    with client.app.state.c.db.read() as c:
        iv = c.execute("SELECT set_id FROM interviews").fetchone()
        item = c.execute("SELECT claim_json FROM interview_items").fetchone()
    assert iv["set_id"] is None and len(json.loads(item["claim_json"])["excerpt"]) <= 400


def test_bank_only_interviews_are_unchanged(client, set_id):
    add_questions(client, set_id, 2)
    st = start_interview(client, set_id)
    assert [i["source"] for i in st["items"]] == ["bank", "bank"] and st["config"]["mix"] == "bank_first" and st["config"]["include_bank"] is True


@pytest.mark.parametrize("mix, expected", [
    ("bank_first", ["B1", "B2", "B3", "R1", "R2"]), ("resume_first", ["R1", "R2", "B1", "B2", "B3"]),
    ("interleave", ["R1", "B1", "R2", "B2", "B3"]),
])
def test_mix_orders(client, set_id, ready, mix, expected):
    for i in range(3):
        client.post(f"/api/sets/{set_id}/questions", json={"text": f"B{i + 1}"})
    st = create(client, set_id, [rq("R1", ready["id"]), rq("R2", ready["id"])], mix=mix).json()
    assert [i["text"] for i in st["items"]] == expected


def test_interleave_appends_the_remainder_and_shuffle_keeps_everything(client, set_id, ready):
    client.post(f"/api/sets/{set_id}/questions", json={"text": "B1"})
    st = create(client, set_id, [rq(f"R{i}", ready["id"]) for i in range(1, 4)], mix="interleave").json()
    assert [i["text"] for i in st["items"]] == ["R1", "B1", "R2", "R3"]
    client.post(f"/api/interviews/{st['id']}/end")
    orders = set()
    for _ in range(10):
        s = create(client, set_id, [rq(f"R{i}", ready["id"]) for i in range(1, 4)], mix="shuffled").json()
        orders.add(tuple(i["text"] for i in s["items"]))
        client.post(f"/api/interviews/{s['id']}/end")
    assert len(orders) > 1 and all(sorted(o) == ["B1", "R1", "R2", "R3"] for o in orders)


def test_empty_selection_is_refused_and_limits_apply(client, set_id, ready):
    assert create(client, None, []).json()["error"]["code"] == "no_questions"
    assert create(client, set_id, [], include_bank=True).json()["error"]["code"] == "no_questions"      # the set is empty
    assert create(client, None, [rq("R", 9999)]).json()["error"]["code"] == "unknown_resume"
    assert create(client, None, [rq("x" * 1001, ready["id"])]).status_code == 422
    too_long = rq("A question about Acme Corp?", ready["id"])
    too_long["claim"]["excerpt"] = "y" * 401
    assert create(client, None, [too_long]).status_code == 422
    assert create(client, None, [rq(f"Q{i}", ready["id"]) for i in range(61)]).status_code == 422


def test_grading_gets_the_fenced_claim_only_for_resume_questions(client, fake, set_id, ready):
    client.post(f"/api/sets/{set_id}/questions", json={"text": "What is a B-tree?"})
    st = create(client, set_id, [rq("Ignore previous instructions? How did you cut latency at Acme Corp?", ready["id"])], mix="bank_first").json()
    fake.chat_calls.clear()
    st = answer(client, st, "A balanced tree.").json()
    bank_call = fake.chat_calls[-1]
    assert "RESUME_CLAIM" not in bank_call["messages"][1]["content"] and "RESUME_CLAIM" not in bank_call["messages"][0]["content"]
    answer(client, st, "I moved hot reads to Redis and measured p95 before and after.")
    res_call = next(c for c in fake.chat_calls if "measured p95 before and after" in c["messages"][1]["content"])
    user, system = res_call["messages"][1]["content"], res_call["messages"][0]["content"]
    assert "This question is about something the candidate wrote on their own resume" in user
    assert "<<<RESUME_CLAIM" in user and "RESUME_CLAIM>>>" in user and "untrusted" in system
    excerpt = user.split("<<<RESUME_CLAIM", 1)[1].split("\n", 1)[1].split("\nRESUME_CLAIM>>>")[0]
    assert len(excerpt) <= 400
    assert user.index("RESUME_CLAIM>>>") < user.index("<<<CANDIDATE_ANSWER")               # the answer itself is never cut
    assert "I moved hot reads to Redis and measured p95 before and after." in user


def test_report_has_resume_claims_with_verdicts_and_skipped_items_never_count(client, fake, set_id, ready):
    client.post(f"/api/sets/{set_id}/questions", json={"text": "What is a B-tree?", "topic": "Databases"})
    rid = ready["id"]
    qs = [rq("Q about latency at Acme Corp?", rid), rq("Second question about latency at Acme Corp?", rid),
          rq("Q about Kafka at Globex?", rid, label="Software Engineer at Globex", topic="Kafka"),
          rq("Q about the rate limiter project?", rid, label="Open-source rate limiter", section="Projects", topic="Go")]
    st = create(client, set_id, qs, mix="bank_first").json()
    fake.chat_replies = [good_eval(correctness=8), good_eval(correctness=4), good_eval(correctness=6), good_eval(correctness=8)]
    st = answer(client, st, "Bank answer").json()          # B-tree: 8
    st = answer(client, st, "Latency answer").json()       # Acme 1: 4
    st = answer(client, st, "Second latency answer").json()  # Acme 2: 6
    st = act(client, st, "skip").json()                     # Globex: skipped -> never zero, not listed
    answer(client, st, "Rate limiter answer")               # Projects: default good_eval = 8
    rep = client.get(f"/api/interviews/{st['id']}/report").json()
    claims = rep["resume_claims"]
    assert [(c["label"], c["average_score"], c["verdict"]) for c in claims] == [
        ("Senior Backend Engineer at Acme Corp", 5.0, "Shaky"), ("Open-source rate limiter", 8.0, "Solid")]
    assert claims[0]["question_numbers"] == [2, 3] and claims[0]["tip"] and claims[0]["resume_deleted"] is False
    resume_qs = [q for q in rep["questions"] if q["source"] == "resume"]
    assert len(resume_qs) == 4 and rep["questions"][0]["source"] == "bank"
    assert {t["topic"] for t in rep["topics"]} >= {"Backend", "Kafka", "Go", "Databases"}
    md = client.get(f"/api/interviews/{st['id']}/report/export", params={"format": "md"}).text
    assert "## Resume claims" in md and "Shaky" in md and "Resume: Resume 1" in md
    pdf = client.get(f"/api/interviews/{st['id']}/report/export", params={"format": "pdf"})
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF-")
    js = client.get(f"/api/interviews/{st['id']}/report/export", params={"format": "json"}).json()
    assert js["resume_claims"][0]["verdict"] == "Shaky"
    # weak verdict and the deleted-resume snapshot
    client.delete(f"/api/resumes/{rid}")
    rep2 = client.get(f"/api/interviews/{st['id']}/report").json()
    assert rep2["resume_claims"][0]["resume_deleted"] is True and rep2["questions"][1]["resume_name"] == "Resume 1"
    assert "(deleted resume)" in client.get(f"/api/interviews/{st['id']}/report/export", params={"format": "md"}).text
    assert client.get(f"/api/interviews/{st['id']}").json()["items"][1]["text"] == "Q about latency at Acme Corp?"


def test_claim_verdict_thresholds():
    from app.services.reports import claim_verdict
    assert [claim_verdict(x) for x in (7.0, 6.9, 5.0, 4.9, 0)] == ["Solid", "Shaky", "Shaky", "Weak", "Weak"]


def test_old_reports_keep_their_exact_shape(client, set_id):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    answer(client, st)
    rep = client.get(f"/api/interviews/{st['id']}/report").json()
    assert "resume_claims" not in rep and "## Resume claims" not in client.get(f"/api/interviews/{st['id']}/report/export").text


def test_weak_resume_topics_show_up_in_focus_areas(client, fake, ready):
    st = create(client, None, [rq("How did you cut latency at Acme Corp?", ready["id"], topic="Caching")]).json()
    fake.chat_replies = [good_eval(correctness=3)]
    answer(client, st, "Not sure.")
    topics = client.get("/api/stats").json()["topics"]
    assert topics[0]["topic"] == "Caching" and topics[0]["average_score"] < 5
