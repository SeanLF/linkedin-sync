#!/usr/bin/env node
// Thin dispatcher: `linkedin-sync <command> [args]` runs the matching script.
// Every command needs a browser; default to the detached headless CDP Chrome
// unless the caller already chose a mode.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMANDS = {
  init: "init.mjs",
  import: "session-import.mjs",
  export: "export.mjs",
  drift: "drift.mjs",
  write: "write.mjs",
  blocks: "copy-blocks.mjs",
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "--help" || cmd === "-h" || !COMMANDS[cmd]) {
  const known = Object.keys(COMMANDS).join(", ");
  console.error(`Usage: linkedin-sync <${known}> [args]\n\n` +
    `  init     import your Chrome session, export your profile, bootstrap linkedin.md\n` +
    `  import   copy your live LinkedIn session from Chrome into the automation browser\n` +
    `  export   export your full profile to a JSON mirror (--connections for contacts)\n` +
    `  drift    compare linkedin.md against your live profile\n` +
    `  write    write one field to LinkedIn (--dry-run to rehearse)\n` +
    `  blocks   list the fields in linkedin.md with their character counts\n\n` +
    `Runs windowless by default. Be signed into linkedin.com in Chrome first.`);
  process.exit(cmd && !COMMANDS[cmd] ? 1 : 0);
}

// Always drive one persistent Chrome over CDP: import the session once, reuse
// it across commands. It is visible by default so you can watch each write
// land; LINKEDIN_HEADLESS=1 (passed straight through) makes that one browser
// headless for unattended use.
const env = { ...process.env, LINKEDIN_CDP: "1" };
const r = spawnSync("node", [join(__dirname, COMMANDS[cmd]), ...rest], { stdio: "inherit", env });
process.exit(r.status ?? 1);
