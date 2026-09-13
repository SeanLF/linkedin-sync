#!/usr/bin/env node
// Does LinkedIn still say what your source-of-truth file says it should?
//
// Reads the desired copy from your linkedin.md and the live values from the
// export mirror (tools/mirror.json), compares field by field through
// the shared schema, and exits non-zero when they disagree.
//
// The point of this file is the verdict taxonomy. A two-state checker (same /
// different) reports "same" when the schema selector has stopped finding the
// field at all, which is how a profile drifts nine months behind a site while
// a green check sits next to it. So "I could not read this" is a distinct,
// louder outcome than "these differ", and the mirror's own age is checked
// before anything is compared; a fresh diff against a stale mirror is a
// broken instrument exiting 0.
//
// Usage:
//   ./linkedin-drift.mjs                    compare, print a report
//   ./linkedin-drift.mjs --max-age-days 30  how stale the mirror may be
//   ./linkedin-drift.mjs --self-test        prove the comparator can fail

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fieldsFromBlocks, normalize, datesLabel } from "./schema.mjs";
import { parseBlocks, countChars } from "./copy-blocks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIRROR = join(__dirname, "mirror.json");

export const VERDICTS = {
  MATCH: "match",            // live and desired agree
  DRIFT: "drift",            // both present, different text
  ABSENT: "absent",          // desired exists; LinkedIn has no such field yet
  NO_DESIRED: "no-desired",  // LinkedIn has a value; the record does not
  UNREADABLE: "unreadable",  // the selector threw: the export shape changed
};

// UNREADABLE means the tool is broken and every other verdict this run is
// suspect, so it outranks a mere content difference.
const EXIT = { clean: 0, stale: 1, broken: 2 };

/** Compare one schema field. Never throws; shape errors become UNREADABLE. */
export function compareField(field, profile, desired) {
  let live;
  try {
    live = field.read(profile);
  } catch (err) {
    return { id: field.id, verdict: VERDICTS.UNREADABLE, detail: err.message };
  }

  const hasLive = typeof live === "string" && live.trim() !== "";
  const hasDesired = typeof desired === "string" && desired.trim() !== "";

  if (!hasDesired && !hasLive) return { id: field.id, verdict: VERDICTS.MATCH, detail: "both empty" };
  if (!hasDesired) return { id: field.id, verdict: VERDICTS.NO_DESIRED, live };
  if (!hasLive) return { id: field.id, verdict: VERDICTS.ABSENT, desired };

  const a = normalize(live);
  const b = normalize(desired);
  if (a === b) return { id: field.id, verdict: VERDICTS.MATCH, detail: `${countChars(b)} chars` };
  return { id: field.id, verdict: VERDICTS.DRIFT, live: a, desired: b, at: firstDifference(a, b) };
}

/** Index of the first differing character, for a readable report. */
function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

function excerpt(s, at, span = 60) {
  const start = Math.max(0, at - span);
  const head = start > 0 ? "..." : "";
  const tail = at + span < s.length ? "..." : "";
  return (head + s.slice(start, at + span) + tail).replace(/\n/g, "\\n");
}

function mirrorAgeDays(profile) {
  const t = Date.parse(profile?.exportedAt ?? "");
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86_400_000;
}

// --- self-test -------------------------------------------------------------
// A comparator that returned MATCH unconditionally would pass a normal run on
// a profile that happens to be in sync. These fixtures make it produce every
// verdict, so the harness is proven able to fail before its pass means
// anything.
function selfTest() {
  const cases = [
    ["identical text",       { read: () => "abc" },                    "abc",  VERDICTS.MATCH],
    ["nbsp and CRLF only",   { read: () => "a b\r\nc" },          "a b\nc", VERDICTS.MATCH],
    ["real difference",      { read: () => "abc" },                    "abd",  VERDICTS.DRIFT],
    ["case is real drift",   { read: () => "Abc" },                    "abc",  VERDICTS.DRIFT],
    ["curly quote is drift", { read: () => "it’s" },              "it's", VERDICTS.DRIFT],
    ["missing on LinkedIn",  { read: () => undefined },                "abc",  VERDICTS.ABSENT],
    ["missing in record",    { read: () => "abc" },                    "",     VERDICTS.NO_DESIRED],
    ["shape changed",        { read: () => { throw new Error("Projects missing"); } }, "abc", VERDICTS.UNREADABLE],
  ];

  let failed = 0;
  // The age guard is the other half of the instrument: no exportedAt must
  // read as unknown, never as fresh.
  const ageCases = [["no exportedAt", {}, null], ["unparseable exportedAt", { exportedAt: "yesterday" }, null], ["fresh exportedAt", { exportedAt: new Date().toISOString() }, 0]];
  for (const [name, profile, want] of ageCases) {
    const got = mirrorAgeDays(profile);
    const ok = want === null ? got === null : (typeof got === "number" && got < 1);
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(22)} expected ${want === null ? "unknown" : "fresh"}, got ${got === null ? "unknown" : got.toFixed(3) + " days"}`);
  }
  for (const [name, field, desired, want] of cases) {
    const got = compareField({ id: name, ...field }, {}, desired).verdict;
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(22)} expected ${want}, got ${got}`);
  }
  console.log(failed ? `\n${failed} self-test failure(s)` : "\nself-test: comparator produces every verdict");
  return failed ? EXIT.broken : EXIT.clean;
}

// --- main ------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) process.exit(selfTest());

  const maxAgeIdx = args.indexOf("--max-age-days");
  const maxAgeDays = maxAgeIdx === -1 ? 14 : Number(args[maxAgeIdx + 1]);

  let profile;
  try {
    profile = JSON.parse(readFileSync(MIRROR, "utf8"));
  } catch (err) {
    console.error(`Cannot read the mirror at ${MIRROR}: ${err.message}`);
    console.error("Run: LINKEDIN_CDP=1 node src/export.mjs");
    process.exit(EXIT.broken);
  }

  const blocks = parseBlocks();
  const { fields } = fieldsFromBlocks(blocks);
  const age = mirrorAgeDays(profile);

  console.log(`mirror   ${profile.exportedAt ?? "(no exportedAt)"}`);
  if (age === null) {
    console.log("         WARNING: no exportedAt; cannot tell how stale this is");
  } else {
    console.log(`         ${age.toFixed(1)} days old`);
  }
  console.log(`record   ${blocks.size} blocks\n`);

  // A project's dates are a second field behind the same title: LinkedIn
  // sorts undated projects last, so a matching description on a project with
  // no dates is still a stale profile.
  const results = fields.flatMap((f) => [
    compareField(f, profile, blocks.get(f.id).text),
    ...(f.dates ? [compareField({ id: `${f.id}.dates`, read: f.readDates }, profile, datesLabel(f.dates))] : []),
  ]);

  const width = Math.max(...results.map((r) => r.id.length));
  for (const r of results) {
    const mark = { match: "ok  ", drift: "DRIFT", absent: "ABSENT", "no-desired": "no-rec", unreadable: "BROKEN" }[r.verdict];
    console.log(`${mark.padEnd(7)} ${r.id.padEnd(width)}  ${r.detail ?? ""}`);
    if (r.verdict === VERDICTS.DRIFT) {
      console.log(`        live    ${excerpt(r.live, r.at)}`);
      console.log(`        record  ${excerpt(r.desired, r.at)}`);
    }
    if (r.verdict === VERDICTS.ABSENT) {
      console.log(`        not on LinkedIn yet (${countChars(r.desired)} chars in the record)`);
    }
    if (r.verdict === VERDICTS.UNREADABLE) {
      console.log(`        the export no longer has the shape this selector expects`);
    }
  }

  const unread = results.filter((r) => r.verdict === VERDICTS.UNREADABLE).length;
  const stale = results.filter((r) => r.verdict === VERDICTS.DRIFT || r.verdict === VERDICTS.ABSENT).length;
  const norec = results.filter((r) => r.verdict === VERDICTS.NO_DESIRED).length;

  console.log(`\n${results.length} fields: ${results.length - unread - stale - norec} match, ${stale} stale, ${norec} not in the record, ${unread} unreadable`);

  if (unread) {
    console.error("\nThe schema and the export disagree. A read selector stopped finding its field; fix schema.mjs before trusting any verdict above.");
    process.exit(EXIT.broken);
  }
  if (age === null) {
    console.error("\nThe mirror has no readable exportedAt, so its freshness is unknown. A comparison against a mirror of unknown age proves nothing.");
    console.error("Re-run: LINKEDIN_CDP=1 node export.mjs, then this again.")
    process.exit(EXIT.broken);
  }
  if (age > maxAgeDays) {
    console.error(`\nThe mirror is ${age.toFixed(1)} days old (limit ${maxAgeDays}). A comparison against a stale mirror proves nothing.`);
    console.error("Re-run: LINKEDIN_CDP=1 node export.mjs, then this again.")
    process.exit(EXIT.broken);
  }
  process.exit(stale ? EXIT.stale : EXIT.clean);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
