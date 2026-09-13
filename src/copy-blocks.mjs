#!/usr/bin/env node
// Reads the desired field values out of your source-of-truth file (linkedin.md).
//
// The copy file stays prose, because the reasoning around each block is worth
// as much as the block. Machine-readable anchors are fenced code blocks tagged
// `linkedin:<field-id>`:
//
//     ```linkedin:headline
//     Staff engineer. ...
//     ```
//
// Fences rather than blockquotes: a fence preserves the text byte for byte, so
// what the parser hands you is what you paste. Blockquotes need `> ` stripped
// on every line, cannot hold a literal leading `>`, and silently drop the
// distinction between a blank line and a `>` on its own.
//
// Usage:
//   ./copy-blocks.mjs                 list every block with its count
//   ./copy-blocks.mjs --copy about    put one block on the clipboard
//   ./copy-blocks.mjs --out DIR       write each block to DIR/<id>.txt

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { TYPE_LIMITS, typeOf, isCompared, normalize } from "./schema.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const COPY_PATH = process.env.LINKEDIN_COPY || join(process.cwd(), "linkedin.md");

// A fence carries an id and optional key="value" attributes:
//   ```linkedin:project.dispatch title="Dispatch" dates="Mar 2026 - Present"
// Attribute values are escape-aware: a literal " inside a value is written \"
// (init.mjs uses JSON.stringify), so the pattern matches \\. as one unit and
// parseAttrs unescapes. Without this, a quote in a title would end the value
// early, the fence line would not match, and the whole block would vanish.
const ATTR = String.raw`[a-z]+="(?:[^"\\]|\\.)*"`;
const FENCE = new RegExp(String.raw`^\x60\x60\x60linkedin:([A-Za-z0-9_.-]+)((?:[ \t]+${ATTR})*)[ \t]*$`);
const ATTR_ONE = /([a-z]+)="((?:[^"\\]|\\.)*)"/g;
const LINKEDIN_LINE = /^```linkedin:/;
function parseAttrs(raw) {
  const attrs = {};
  for (const m of (raw || "").matchAll(ATTR_ONE)) attrs[m[1]] = m[2].replace(/\\(["\\])/g, "$1");
  return attrs;
}

/**
 * Parse every `linkedin:<id>` fence out of the copy file.
 * Throws on a duplicate id, an unknown id, or an unterminated fence: all three
 * mean the copy file and the schema have diverged, and continuing would
 * compare the wrong things.
 */
export function parseBlocks(path = COPY_PATH) {
  const lines = readFileSync(path, "utf8").split("\n");
  const blocks = new Map();
  let id = null;
  let buf = [];
  let openedAt = 0;

  let attrs = {};
  lines.forEach((line, i) => {
    if (id === null) {
      const m = line.match(FENCE);
      if (m) { id = m[1]; attrs = parseAttrs(m[2]); buf = []; openedAt = i + 1; return; }
      // A linkedin: fence that does not fully match (an unescaped quote, a bad
      // attribute) must fail loudly, not be skipped into invisibility.
      if (LINKEDIN_LINE.test(line)) throw new Error(`${path}:${i + 1}: malformed linkedin fence: ${line.trim().slice(0, 80)}`);
      return;
    }
    if (line.trimEnd() === "```") {
      if (blocks.has(id)) throw new Error(`${path}:${openedAt}: duplicate block "${id}"`);
      if (!TYPE_LIMITS[typeOf(id)]) {
        throw new Error(`${path}:${openedAt}: block "${id}" has an unknown type "${typeOf(id)}" (known: ${Object.keys(TYPE_LIMITS).join(", ")})`);
      }
      blocks.set(id, { text: buf.join("\n").replace(/\s+$/, ""), attrs });
      id = null;
      return;
    }
    buf.push(line);
  });

  if (id !== null) throw new Error(`${path}:${openedAt}: block "${id}" is never closed`);
  return blocks;
}

/** Limit violations, as a list of human-readable problems. Empty means clean. */
export function overLimit(blocks) {
  const problems = [];
  for (const [id, b] of blocks) {
    const limit = TYPE_LIMITS[typeOf(id)];
    if (!limit) continue;
    const n = [...normalize(b.text)].length;
    if (n > limit) problems.push(`${id}: ${n} chars, limit ${limit} (over by ${n - limit})`);
  }
  return problems;
}

// Count in code points, not UTF-16 units: an emoji is one character to
// LinkedIn's counter and two to String.prototype.length.
export const countChars = (s) => [...normalize(s)].length;

// A parser that accepted everything would make the drift check compare the
// wrong things while looking healthy. Each fixture below must be refused.
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "linkedin-blocks-"));
  const cases = [
    ["duplicate id",      "```linkedin:headline\na\n```\n```linkedin:headline\nb\n```\n", /duplicate/],
    ["unknown type",      "```linkedin:nonsense\na\n```\n",                                /unknown type/],
    ["unterminated",      "```linkedin:headline\na\n",                                       /never closed/],
    ["over limit",        "```linkedin:headline\n" + "x".repeat(221) + "\n```\n",          /limit 220/],
    ["unescaped quote",   '```linkedin:project.x title="Zero"Trust"\na\n```\n',              /malformed/],
    ["escaped quote ok",  '```linkedin:project.x title="a \\"b\\" c"\nfine\n```\n',          null],
    ["clean",             "```linkedin:headline\nfine\n```\n",                              null],
  ];
  let failed = 0;
  for (const [name, text, want] of cases) {
    const path = join(dir, name.replace(/\s/g, "-") + ".md");
    writeFileSync(path, text);
    let got = null;
    try {
      const blocks = parseBlocks(path);
      const problems = overLimit(blocks);
      if (problems.length) got = problems.join("; ");
    } catch (e) { got = e.message; }
    const ok = want ? (got !== null && want.test(got)) : got === null;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(14)} ${want ? "refused: " + (got ?? "(accepted!)").slice(0, 70) : "accepted"}`);
  }
  console.log(failed ? `\n${failed} self-test failure(s)` : "\nself-test: parser refuses every malformed fixture");
  return failed ? 2 : 0;
}
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) process.exit(selfTest());
  const blocks = parseBlocks();

  const problems = overLimit(blocks);
  if (problems.length) {
    console.error("Over LinkedIn's limits:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  const copyIdx = args.indexOf("--copy");
  if (copyIdx !== -1) {
    const id = args[copyIdx + 1];
    if (!blocks.has(id)) {
      console.error(`No block "${id}". Have: ${[...blocks.keys()].join(", ")}`);
      process.exit(1);
    }
    const text = blocks.get(id).text;
    const r = spawnSync("pbcopy", { input: text });
    if (r.status !== 0) { console.error("pbcopy failed"); process.exit(1); }
    console.error(`Copied ${id} (${countChars(text)} chars) to the clipboard.`);
    return;
  }

  const outIdx = args.indexOf("--out");
  if (outIdx !== -1) {
    const dir = args[outIdx + 1];
    if (!dir) { console.error("--out needs a directory"); process.exit(1); }
    mkdirSync(dir, { recursive: true });
    for (const [id, b] of blocks) writeFileSync(join(dir, `${id}.txt`), b.text);
    console.error(`Wrote ${blocks.size} blocks to ${dir}/`);
    return;
  }

  for (const [id, b] of blocks) {
    const n = countChars(b.text);
    const limit = TYPE_LIMITS[typeOf(id)] ? `/${TYPE_LIMITS[typeOf(id)]}` : "";
    const note = isCompared(id, b.attrs) ? "" : "  (not compared)";
    console.log(`${id.padEnd(24)} ${String(n).padStart(5)}${limit}${note}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
