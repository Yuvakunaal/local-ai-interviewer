import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Feedback from "../components/Feedback";
import type { Evaluation } from "../types";

const base: Evaluation = {
  correct_points: ["Said it is relational"], missing_concepts: [], misconceptions: [],
  dimension_scores: { correctness: 6, completeness: 5, depth: 3, practical_application: 2, clarity: 5, production_awareness: 0 },
  production_relevant: false, suggested_improvements: [], ideal_answer: "", confidence: "high", uncertainty_note: "",
  needs_followup: false, followup_reason: "", score: 4.9, verdict: "Fair", followup_asked: false,
};

describe("Feedback", () => {
  it("tells a voice answerer what the grader actually read", () => {
    render(<Feedback ev={{ ...base, interpreted_answer: "MySQL is a relational database with DML and DDL." }} score={4.9} />);
    const note = screen.getByTestId("graded-as");
    expect(note).toHaveTextContent("You answered by voice");
    expect(note).toHaveTextContent("MySQL is a relational database with DML and DDL.");
    expect(note).toHaveTextContent("not held against you");
  });
  it("shows nothing extra for typed answers", () => {
    render(<Feedback ev={base} score={4.9} />);
    expect(screen.queryByTestId("graded-as")).toBeNull();
  });
  it("says which model graded the answer and where it ran", () => {
    const { rerender } = render(<Feedback ev={{ ...base, graded_by: { provider: "cloud", model: "gpt-oss:120b", fell_back_from: null } }} score={4.9} />);
    expect(screen.getByTestId("graded-by")).toHaveTextContent("Graded by gpt-oss:120b (Ollama cloud)");
    expect(screen.getByTestId("graded-by")).not.toHaveTextContent("unavailable");
    rerender(<Feedback ev={{ ...base, graded_by: { provider: "cloud", model: "deepseek-v4.1-flash", fell_back_from: "gpt-oss:120b" } }} score={4.9} />);
    expect(screen.getByTestId("graded-by")).toHaveTextContent("gpt-oss:120b was unavailable, so the fallback model graded this");
    rerender(<Feedback ev={{ ...base, graded_by: { provider: "local", model: "qwen3.5:4b", fell_back_from: "gpt-oss:120b", reason: "Ollama cloud had a problem" } }} score={4.9} />);
    expect(screen.getByTestId("graded-by")).toHaveTextContent("Graded on this computer by qwen3.5:4b");
    expect(screen.getByTestId("graded-by")).toHaveTextContent("the cloud was unavailable (Ollama cloud had a problem)");
  });
  it("shows nothing about the engine for old evaluations that have no record of it", () => {
    render(<Feedback ev={base} score={4.9} />);
    expect(screen.queryByTestId("graded-by")).toBeNull();
  });
  it("explains why a basic question weighs depth less", () => {
    render(<Feedback ev={{ ...base, question_level: "basic" }} score={4.9} />);
    expect(screen.getByText(/depth and real-world examples count less/)).toBeInTheDocument();
  });
});
