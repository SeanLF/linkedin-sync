// The one definition of LinkedIn's profile fields that read, write and drift
// detection all share. If these three disagree about where a field lives, the
// drift check silently passes while the profile is wrong; which is the exact
// failure that let LinkedIn sit nine months behind the site.
//
// Why .mjs and not .json: `read` has to reach into the export by *matching*
// (the independent role by its company, a project by its title), not by index.
// Index selectors break the first time LinkedIn reorders a section, and they
// break silently, returning a neighbour's text instead of nothing. A tiny path
// DSL would buy inspectability and cost correctness, so: functions.
//
// `read` contract: return the live string, or `undefined` if the field is not
// present. Throw if the *shape* is wrong (section missing entirely). The
// difference matters; see VERDICTS in linkedin-drift.mjs.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Find an experience entry (or a sub-role of one) whose company or title matches. */
function experienceByCompany(profile, rx) {
  const xp = profile?.sections?.Experience;
  if (!Array.isArray(xp)) throw new Error("sections.Experience missing or not a list");
  const hits = [];
  for (const e of xp) {
    const roles = e.roles?.length ? e.roles : [e];
    for (const r of roles) {
      if (rx.test(e.subtitle ?? "") || rx.test(e.title ?? "") || rx.test(r.title ?? "")) hits.push(r);
    }
  }
  if (hits.length > 1) throw new Error(`match ${rx} hits ${hits.length} experience entries; make the match= attribute more specific`);
  return hits[0];
}

/** Parse a "Mar 2026 - Present" style date range into ISO {start, end}. */
function parseDatesAttr(raw) {
  const one = (t) => { const m = /^([A-Za-z]{3,})\s+(\d{4})$/.exec(t.trim()); if (!m) return null; const i = MONTH_NAMES.findIndex((n) => n.slice(0, 3).toLowerCase() === m[1].slice(0, 3).toLowerCase()); return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, "0")}`; };
  const [a, b] = raw.split(/\s*[-\u2013]\s*/);
  const start = one(a || "");
  if (!start) return null;
  const end = /present/i.test(b || "") ? null : one(b || "");
  return { start, end: end === undefined ? null : end };
}

/**
 * LinkedIn renders a project's dates as its subtitle: "Mar 2026 - Present".
 * The record keeps them as ISO year-month so the writer can drive the
 * month/year selects and the drift check can compare the rendered string.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function ym(s) {
  const m = /^(\d{4})-(\d{2})$/.exec(s ?? "");
  if (!m) throw new Error(`dates must be "YYYY-MM", got ${JSON.stringify(s)}`);
  return { year: m[1], month: Number(m[2]) };
}
export function datesLabel({ start, end }) {
  const a = ym(start);
  const b = end === null ? "Present" : (({ year, month }) => `${MONTHS[month - 1]} ${year}`)(ym(end));
  return `${MONTHS[a.month - 1]} ${a.year} - ${b}`;
}

/** Locate a project by its exact LinkedIn title. */
function projectByTitle(profile, title) {
  const projects = profile?.sections?.Projects;
  if (!Array.isArray(projects)) throw new Error("sections.Projects missing or not a list");
  return projects.find((p) => p?.title === title);
}

// LinkedIn's published per-field character limits, keyed by field TYPE (the
// part of a block id before the first "."). Exceeding one is rejected at paste
// time, so desired copy is validated against these before a browser opens.
export const TYPE_LIMITS = { headline: 220, about: 2600, position: 2000, project: 2000 };
export const typeOf = (id) => id.split(".")[0];

// A block is compared against the live profile unless it opts out: an id ending
// in ".alt" (a human-choice alternate) or an explicit compare="false" attr.
export const isCompared = (id, attrs = {}) => attrs.compare !== "false" && !id.endsWith(".alt");

// Build a concrete field definition from a block's id and its fence attributes.
// The id's type picks the reader/writer; the attributes supply the per-instance
// specifics (which company, which project title, its dates). This is the seam
// that makes the machinery generic and the content the user's own.
//
// `read` contract: return the live string, or undefined if the field is absent.
// Throw if the section shape is wrong; drift turns that into UNREADABLE, a
// distinct outcome from "different".
export function fieldFromBlock(id, attrs = {}) {
  const type = typeOf(id);
  if (type === "headline") return { id, label: "Headline", limit: 220, read: (p) => p?.headline ?? undefined, write: { surface: "intro", control: "headline", multiline: false } };
  if (type === "about") return { id, label: "About", limit: 2600, read: (p) => p?.sections?.About ?? undefined, write: { surface: "about", control: "summary", multiline: true } };
  if (type === "position") {
    const match = attrs.match;
    if (!match) throw new Error(`block "${id}" needs a match="Company name" attribute`);
    const rx = new RegExp(escapeRe(match), "i");
    const f = { id, label: `Position (${match})`, limit: 2000, read: (p) => experienceByCompany(p, rx)?.description ?? undefined, write: { surface: "position", match: { subtitle: rx }, control: "description", multiline: true } };
    if (attrs.skills) { f.skills = attrs.skills.split(/\s*[,;|]\s*/).filter(Boolean); f.readSkills = (p) => experienceByCompany(p, rx)?.skills ?? []; }
    return f;
  }
  if (type === "project") {
    const title = attrs.title;
    if (!title) throw new Error(`block "${id}" needs a title="Exact LinkedIn project title" attribute`);
    const f = { id, label: `Project: ${title}`, linkedinTitle: title, limit: 2000, read: (p) => projectByTitle(p, title)?.description ?? undefined, write: { surface: "project", control: "description", multiline: true, createIfAbsent: true } };
    if (attrs.dates) { const d = parseDatesAttr(attrs.dates); if (d) { f.dates = d; f.readDates = (p) => projectByTitle(p, title)?.subtitle ?? undefined; } }
    return f;
  }
  throw new Error(`unknown field type "${type}" in block "${id}" (known: ${Object.keys(TYPE_LIMITS).join(", ")})`);
}

// Build every comparable field from the parsed copy blocks (id -> {text, attrs}).
export function fieldsFromBlocks(blocks) {
  const fields = [];
  for (const [id, b] of blocks) {
    if (!isCompared(id, b.attrs)) continue;
    fields.push(fieldFromBlock(id, b.attrs || {}));
  }
  return { fields, byId: new Map(fields.map((f) => [f.id, f])) };
}

/**
 * Make two strings comparable without hiding real drift.
 *
 * Deliberately NOT normalised: straight vs curly quotes, and letter case.
 * Those are differences you would want a red check for. Only transport-level
 * mangling is folded away here. Every rule below earns its place by being
 * something a paste into a browser textarea can change on its own.
 */
export function normalize(s) {
  if (typeof s !== "string") return s;
  return s
    .normalize("NFC")            // é as one code point, not e + combining acute
    .replace(/\r\n?/g, "\n")     // textarea round-trips can introduce CRLF
    .replace(/ /g, " ")     // LinkedIn emits NBSP where you typed a space
    .replace(/[ \t]+$/gm, "")    // trailing space on a line is invisible
    .replace(/\n{3,}/g, "\n\n")  // the editor collapses runs of blank lines
    .trim();
}
