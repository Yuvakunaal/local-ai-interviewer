// Accessibility / structure checks run inside the page (shared by qa-sweep.mjs and cloud.mjs). Returns a list of problems.
export const SWEEP = () => {
  const out = [];
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const label = (el) => (el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby"))?.textContent) || el.textContent || el.getAttribute("title") || "").trim();
  const desc = (el) => `<${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""}>`;
  for (const el of document.querySelectorAll("button, [role=button], [role=tab], [role=radio], a[href]")) if (visible(el) && !label(el)) out.push(`no accessible name: ${desc(el)}`);
  for (const el of document.querySelectorAll("input:not([type=hidden]), select, textarea")) {
    if (!visible(el) && el.type !== "checkbox") continue;
    if (!(el.labels && el.labels.length) && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")) out.push(`unlabelled field: ${desc(el)} placeholder="${el.placeholder || ""}"`);
  }
  const ids = {}; document.querySelectorAll("[id]").forEach((e) => { ids[e.id] = (ids[e.id] || 0) + 1; });
  Object.entries(ids).filter(([, n]) => n > 1).forEach(([id, n]) => out.push(`duplicate id "${id}" x${n}`));
  const ROUTES = /^#\/(home|questions|resumes|resumes\/\d+|setup|history|reports|usage|settings|welcome|interview\/\d+|report\/\d+)$/;
  document.querySelectorAll('a[href^="#"]').forEach((a) => { if (!ROUTES.test(a.getAttribute("href"))) out.push(`dead link: ${a.getAttribute("href")} ("${label(a).slice(0, 30)}")`); });
  document.querySelectorAll('a[target="_blank"]').forEach((a) => { if (!/noopener/.test(a.rel)) out.push(`target=_blank without rel=noopener: ${a.href}`); });
  document.querySelectorAll("img").forEach((i) => { if (!i.hasAttribute("alt")) out.push("image without alt"); });
  document.querySelectorAll('svg[role="img"]').forEach((s) => { if (!s.getAttribute("aria-label") && !s.querySelector("title")) out.push("svg role=img without a name"); });
  document.querySelectorAll("[tabindex]").forEach((e) => { if (Number(e.getAttribute("tabindex")) > 0) out.push("positive tabindex"); });
  const h1 = [...document.querySelectorAll("h1")].filter(visible);
  if (h1.length !== 1 && !document.querySelector(".fs")) out.push(`expected one visible <h1>, found ${h1.length}`);
  if (!document.querySelector("main")) out.push("no <main> landmark");
  if (!document.title.trim()) out.push("empty page title");
  if (!document.documentElement.lang) out.push("<html> has no lang");
  return out;
};
