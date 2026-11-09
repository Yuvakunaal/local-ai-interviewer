// Seeds an ISOLATED test database (never your real data) with a believable practice history, using the app's own
// report builder, so the dashboard, lists and Report page can be checked visually in both themes.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, VENV_PYTHON } from "./lib.mjs";

const PY = `
import json, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, sys.argv[2])
from app.db import Database
from app.services.reports import store_report

QUESTIONS = {
  "SQL": ["What is the difference between a window function and a GROUP BY aggregate?", "How do you remove duplicate rows while keeping the latest one?", "Explain a slowly changing dimension type 2 merge."],
  "Spark": ["Why does data skew slow down a Spark join and how do you fix it?", "What is the difference between repartition and coalesce?"],
  "Kafka": ["How do consumer groups provide scalability and fault tolerance?"],
  "Modeling": ["When would you choose a star schema over a data vault?"],
  "Airflow": ["How do you make an Airflow task idempotent?", "What does catchup do in a DAG?"],
  "Snowflake": ["How do micro-partitions affect query pruning?"],
}
RUNS = [  # days ago, [(topic, score)]
  (12, [("SQL", 4.5), ("SQL", 4.0), ("Spark", 6.0), ("Modeling", 5.0)]), (9, [("SQL", 6.0), ("SQL", 6.5), ("Kafka", 5.5)]),
  (6, [("SQL", 7.0), ("Spark", 6.5), ("Spark", 6.0), ("Airflow", 7.0)]), (3, [("Spark", 7.5), ("Modeling", 7.0), ("Kafka", 8.0), ("Spark", 7.0)]),
  (1, [("SQL", 8.5), ("Airflow", 7.0), ("Airflow", 7.5), ("Snowflake", 4.0)]), (0, [("SQL", 9.0), ("SQL", 8.0), ("Spark", 8.5), ("Spark", 7.5)]),
]
def evaluation(score):
    good = score >= 7
    return {"correct_points": ["Explained the core idea clearly", "Gave a concrete example"] if good else ["Identified the general area"],
            "missing_concepts": [] if score >= 8.5 else ["Trade-offs and failure modes", "How this behaves at production scale"],
            "misconceptions": [] if score >= 5 else ["Confused the shuffle with a broadcast"],
            "dimension_scores": {"correctness": score, "completeness": score - .5, "depth": score - 1, "practical_application": score, "clarity": score + .5, "production_awareness": score - 1},
            "production_relevant": True, "suggested_improvements": ["Mention a real production example", "State the trade-offs explicitly"],
            "verdict_summary": "Solid answer with room to add depth." if good else "Needs more depth and accuracy.",
            "ideal_answer": "A concise reference answer that names the concept, explains why it matters, and notes the main trade-off.",
            "confidence": "high", "uncertainty_note": "", "needs_followup": False, "followup_reason": "", "score": score,
            "verdict": "Strong" if score >= 8 else "Good" if score >= 7 else "Fair" if score >= 5 else "Weak", "followup_asked": False}
MODE = sys.argv[3] if len(sys.argv) > 3 else "default"
if MODE == "untagged":   # the real situation: questions with NO topic (reports call them "Uncategorized"), plus a weak topic nobody has questions for
    RUNS = [(1, [(None, 5.2), (None, 4.4), (None, 5.0), (None, 5.0)]), (0, [("Kafka", 3.0), ("Kafka", 3.5)])]
db = Database(sys.argv[1])
used = {}
for n, (days, qs) in enumerate(RUNS, 1):
    ts = (datetime.now(timezone.utc) - timedelta(days=days, hours=1)).isoformat(timespec="seconds")
    with db.tx() as c:
        iid = c.execute("INSERT INTO interviews(title, interview_type, status, phase, config_json, created_at, completed_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                        (f"Practice Interview - {n}", "technical", "completed", "done",
                         json.dumps({"title": "x", "voice": "default", "max_followups": 2, "speech_speed": 1.0, "strictness": "balanced", "question_audio": "auto"}), ts, ts, ts)).lastrowid
        for pos, (topic, score) in enumerate(qs):
            k = used.get(topic, 0); used[topic] = k + 1
            text = QUESTIONS[topic][k % len(QUESTIONS[topic])] if topic else f"Question without a topic number {pos + 1}?"
            item = c.execute("INSERT INTO interview_items(interview_id, position, text, topic, difficulty, status, created_at) VALUES (?,?,?,?,?, 'answered', ?)",
                             (iid, pos, text, topic, ["easy", "medium", "hard"][pos % 3], ts)).lastrowid
            c.execute("INSERT INTO turns(interview_id, item_id, seq, kind, question_text, status, answer_text, answer_source, evaluation_json, score, asked_at, submitted_at, evaluated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (iid, item, 0, "main", text, "evaluated", "My answer covers the main idea, with an example and the trade-offs.", "typed", json.dumps(evaluation(score)), score, ts, ts, ts))
        store_report(c, iid)
from app.services.usage import UsageRecorder
u = UsageRecorder(db)
M = "qwen3.5:4b"
for kw in [  # one cold model load (15 s), then warm grading calls; plus repair, summary, warm-up and speech
  dict(model=M, purpose="warm", load_ms=5600, total_ms=5700),
  dict(model=M, purpose="evaluation", prompt_tokens=1210, output_tokens=520, load_ms=15200, prompt_ms=900, output_ms=26000, total_ms=42500, interview_id=iid, label="Q1"),
  dict(model=M, purpose="repair", prompt_tokens=380, output_tokens=64, prompt_ms=300, output_ms=3100, total_ms=3500, interview_id=iid, label="Q2"),
  dict(model=M, purpose="evaluation", prompt_tokens=1290, output_tokens=498, prompt_ms=250, output_ms=24900, total_ms=25400, interview_id=iid, label="Q2"),
  dict(model=M, purpose="evaluation", prompt_tokens=1240, output_tokens=560, prompt_ms=240, output_ms=28000, total_ms=28500, interview_id=iid, label="Q3"),
  dict(model=M, purpose="summary", prompt_tokens=900, output_tokens=310, prompt_ms=200, output_ms=15500, total_ms=15900, interview_id=iid, label="Report summary"),
  dict(model="phonon", purpose="speech", total_ms=2300, detail="58 characters, 3.4 s of audio"),
  dict(model="phonon", purpose="speech", total_ms=3100, detail="112 characters, 6.2 s of audio"),
]:
    u.record(kw)
print("seeded", len(RUNS), "interviews and", len(u.recent(100)), "model-usage rows")
`;
export function seedHistory(dataDir, mode = "default") {
  execFileSync(VENV_PYTHON, ["-c", PY, join(dataDir, "interviewer.sqlite3"), join(ROOT, "backend"), mode], { stdio: "inherit" });
}
