#!/usr/bin/env node
// One-shot onboarding: import your Chrome session, export your live profile,
// and bootstrap a copy-of-record from it. No configuration and no blank
// template. Your source of truth starts as a faithful copy of what LinkedIn
// already shows, and you edit down from there.
//
//   LINKEDIN_CDP=1 node src/init.mjs
//
// Writes the copy-of-record to $LINKEDIN_COPY or ./linkedin.md (never
// overwrites an existing one). Reruns are safe: it re-exports the mirror and
// leaves an existing copy file alone.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COPY_PATH = process.env.LINKEDIN_COPY || join(process.cwd(), "linkedin.md");
const MIRROR = join(__dirname, "mirror.json");
const run = (script, args = []) => spawnSync("node", [join(__dirname, script), ...args], { stdio: "inherit", env: process.env });

// 1. Import the session (proves login, discovers who you are).
console.log("== importing your Chrome session ==");
if (run("session-import.mjs").status !== 0) {
  console.error("\nSession import failed. Be signed into linkedin.com in your everyday Chrome, then rerun.");
  process.exit(1);
}

// 2. Export the live profile to the mirror.
console.log("\n== exporting your live profile ==");
if (run("export.mjs").status !== 0) { console.error("\nExport failed."); process.exit(1); }

// 3. Bootstrap the copy-of-record from the mirror, unless one already exists.
if (existsSync(COPY_PATH)) {
  console.log(`\nA copy-of-record already exists at ${COPY_PATH}; leaving it untouched.`);
  console.log("Run drift to compare it against your live profile.");
  process.exit(0);
}

const m = JSON.parse(readFileSync(MIRROR, "utf8"));
const fence = (id, attrs, text) => {
  const a = Object.entries(attrs).map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join("");
  return "```linkedin:" + id + a + "\n" + (text ?? "").trim() + "\n```\n";
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

const out = [];
out.push(`# LinkedIn copy of record for ${m.vanityName || m.name}`);
out.push(`\nBootstrapped from your live profile on ${new Date().toISOString().slice(0, 10)}. Each fenced \`linkedin:<field>\` block is a value this tool can compare and write; the prose around a block is yours, for notes. Edit the blocks to make this your source of truth, then run drift to see where LinkedIn has diverged. Right now it matches, because it was copied from the live profile.\n`);

out.push(`\n## Headline\n`);
out.push(fence("headline", {}, m.headline));

if (m.sections?.About) { out.push(`\n## About\n`); out.push(fence("about", {}, m.sections.About)); }

// One position block per company: its most recent role with a description
// (the mirror is newest-first). A company appears once, so the `match`
// attribute the writer uses is unambiguous and drift stays clean on day one.
// Multiple sub-roles at the same company collapse to one block; edit or add
// more by hand if you want to write to an older role.
const seenCompany = new Set();
for (const e of (m.sections?.Experience || [])) {
  const roles = e.roles?.length ? e.roles : [e];
  for (const r of roles) {
    if (!r.description) continue;
    const company = (e.subtitle || e.title || "").split("·")[0].trim();
    const key = slug(company);
    if (!key || seenCompany.has(key)) continue;
    seenCompany.add(key);
    out.push(`\n## Position: ${r.title || company}\n`);
    out.push(fence("position." + key, { match: company }, r.description));
  }
}

// One project block per project that has a description, keyed by its exact
// title. Dedupe by slug: two titles that normalise the same (or share a long
// prefix, since slug truncates) would otherwise emit a duplicate block id and
// break the file the moment it is parsed.
const seenProject = new Set();
for (const p of (m.sections?.Projects || [])) {
  if (!p.description) continue;
  const key = slug(p.title);
  if (!key || seenProject.has(key)) { if (key) console.error(`  (skipped a project whose id collides: "${p.title}")`); continue; }
  seenProject.add(key);
  out.push(`\n## Project: ${p.title}\n`);
  const attrs = { title: p.title };
  if (p.subtitle) attrs.dates = p.subtitle; // e.g. "Jul 2026 - Present"
  out.push(fence("project." + key, attrs, p.description));
}

writeFileSync(COPY_PATH, out.join("\n"), { flag: "wx" });
console.log(`\nBootstrapped your copy-of-record at ${COPY_PATH}`);
console.log("Edit it, then: LINKEDIN_CDP=1 node src/drift.mjs");
