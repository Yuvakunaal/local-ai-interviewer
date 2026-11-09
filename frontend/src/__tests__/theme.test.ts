import { beforeEach, describe, expect, it } from "vitest";
import { nextPref, readPref, resolveTheme, setThemePref } from "../theme";

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme"); });

describe("theme", () => {
  it("defaults to the light look (the approved design)", () => {
    expect(readPref()).toBe("light");
    localStorage.setItem("lai.theme", "garbage");
    expect(readPref()).toBe("light");
  });
  it("resolves 'system' from the operating system and leaves explicit choices alone", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
  it("cycles light -> dark -> system -> light", () => {
    expect(["light", "dark", "system"].map((p) => nextPref(p as "light"))).toEqual(["dark", "system", "light"]);
  });
  it("applies and persists the choice", () => {
    setThemePref("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("lai.theme")).toBe("dark");
    expect(readPref()).toBe("dark");
    setThemePref("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
