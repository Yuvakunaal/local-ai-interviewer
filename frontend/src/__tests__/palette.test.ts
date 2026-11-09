import { describe, expect, it } from "vitest";
import { grouped, rank, type PaletteItem } from "../palette";

const item = (id: string, group: PaletteItem["group"], label: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({ id, group, label, icon: "home", run: () => {}, ...extra });
const ITEMS = [
  item("start", "Actions", "Start a new interview", { keywords: "begin practice" }),
  item("add", "Actions", "Add a question", { keywords: "new create" }),
  item("theme", "Actions", "Theme: Dark", { keywords: "appearance colour" }),
  item("settings", "Go to", "Settings"),
  item("q1", "Questions", "How do you make an Airflow task idempotent?", { hint: "Airflow" }),
  item("q2", "Questions", "Explain micro-partitions in Snowflake", { hint: "Snowflake" }),
];
const ids = (xs: PaletteItem[]) => xs.map((x) => x.id);

describe("palette ranking", () => {
  it("with no query shows actions and pages but not the (many) questions", () => {
    expect(ids(rank(ITEMS, ""))).toEqual(["start", "add", "theme", "settings"]);
    expect(ids(rank(ITEMS, "   "))).toEqual(["start", "add", "theme", "settings"]);
  });
  it("requires every word to match and ignores case", () => {
    expect(ids(rank(ITEMS, "NEW INTER"))).toEqual(["start"]);          // 'new' is in the label; 'inter' starts a label word
    expect(ids(rank(ITEMS, "zzz"))).toEqual([]);
    expect(ids(rank(ITEMS, "airflow idempotent"))).toEqual(["q1"]);
  });
  it("ranks label-start matches above word-start, middle-of-word and keyword matches", () => {
    const items = [item("kw", "Actions", "Something else", { keywords: "settings" }), item("mid", "Actions", "Offsettings"), item("word", "Actions", "My settings"), item("start", "Actions", "Settings")];
    expect(ids(rank(items, "settings"))).toEqual(["start", "word", "mid", "kw"]);
  });
  it("finds items through their keywords and hints", () => {
    expect(ids(rank(ITEMS, "appearance"))).toEqual(["theme"]);
    expect(ids(rank(ITEMS, "snowflake"))).toEqual(["q2"]);
  });
  it("caps the number of question results", () => {
    const many = Array.from({ length: 30 }, (_, i) => item(`q${i}`, "Questions", `Question about joins ${i}`));
    expect(rank(many, "joins")).toHaveLength(8);
  });
  it("groups results Actions, Go to, Questions while keeping order inside a group", () => {
    const shuffled = [ITEMS[4], ITEMS[3], ITEMS[1], ITEMS[0]];
    expect(ids(grouped(shuffled))).toEqual(["add", "start", "settings", "q1"]);
  });
});
