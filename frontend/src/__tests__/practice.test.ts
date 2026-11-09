import { describe, expect, it } from "vitest";
import { describeTopics, isUntagged, matchQuestions, missingTopics, pickPreselect, type QuestionLite, type WeakTopic } from "../practice";

const NO_TOPIC: WeakTopic = { topic: "Uncategorized", untagged: true };
const SQL: WeakTopic = { topic: "SQL", untagged: false };
const SNOW: WeakTopic = { topic: "Snowflake", untagged: false };

describe("practicing weak topics", () => {
  it("treats 'Uncategorized' as questions with NO topic (the bug: it searched for a topic literally called that)", () => {
    const qs: QuestionLite[] = [{ id: 6, topic: null }, { id: 7, topic: "" }, { id: 8, topic: "  " }, { id: 9, topic: "SQL" }];
    expect(matchQuestions(qs, [NO_TOPIC])).toEqual([6, 7, 8]);
    expect(isUntagged(null) && isUntagged("") && isUntagged("Uncategorized") && !isUntagged("SQL")).toBe(true);
  });

  it("matches real topics ignoring case and spaces", () => {
    expect(matchQuestions([{ id: 1, topic: "sql " }, { id: 2, topic: "Spark" }], [SQL])).toEqual([1]);
  });

  it("combines several topics, including questions with no topic", () => {
    expect(matchQuestions([{ id: 1, topic: "SQL" }, { id: 2, topic: null }, { id: 3, topic: "Kafka" }], [SQL, NO_TOPIC])).toEqual([1, 2]);
  });

  it("describes what will be practiced in plain English", () => {
    expect(describeTopics([NO_TOPIC])).toBe("questions with no topic");
    expect(describeTopics([SQL])).toBe("“SQL”");
    expect(describeTopics([SQL, SNOW, NO_TOPIC])).toBe("“SQL”, “Snowflake” and questions with no topic");
    expect(describeTopics([])).toBe("");
  });

  it("picks the set with the most matching questions and labels the selection", () => {
    const sets = [{ setId: 1, questions: [{ id: 1, topic: "SQL" }] }, { setId: 2, questions: [{ id: 5, topic: "SQL" }, { id: 6, topic: "SQL" }, { id: 7, topic: "x" }] }];
    expect(pickPreselect(sets, [SQL])).toEqual({ setId: 2, ids: [5, 6], label: "“SQL”", skipped: [] });
    expect(pickPreselect(sets, [SNOW])).toBeNull();
    expect(pickPreselect([], [SQL])).toBeNull();
  });

  it("works for the real case: four questions with no topic", () => {
    const sets = [{ setId: 1, questions: [6, 7, 8, 9].map((id) => ({ id, topic: null })) }];
    expect(pickPreselect(sets, [NO_TOPIC])).toEqual({ setId: 1, ids: [6, 7, 8, 9], label: "questions with no topic", skipped: [] });
  });

  it("never claims a topic it has no questions for: the label lists only what matched, the rest is reported as skipped", () => {
    const sets = [{ setId: 1, questions: [{ id: 1, topic: "SQL" }, { id: 2, topic: null }] }];
    const pick = pickPreselect(sets, [SNOW, SQL, NO_TOPIC]);
    expect(pick?.ids).toEqual([1, 2]);
    expect(pick?.label).toBe("“SQL” and questions with no topic");
    expect(pick?.skipped.map((t) => t.topic)).toEqual(["Snowflake"]);
  });

  it("names exactly which topics have no questions, so the user knows what to add", () => {
    const sets = [{ questions: [{ id: 1, topic: "SQL" }] }];
    expect(missingTopics(sets, [SQL, SNOW, NO_TOPIC]).map((t) => t.topic)).toEqual(["Snowflake", "Uncategorized"]);
    expect(missingTopics([], [SQL]).map((t) => t.topic)).toEqual(["SQL"]);
  });
});
