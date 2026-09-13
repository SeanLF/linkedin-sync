#!/usr/bin/env node
// Exports your LinkedIn profile to a JSON mirror by replaying LinkedIn's own
// Voyager API from the logged-in page. The vanity name is optional: it is read
// from the session when omitted.
//
//   node export.mjs                 profile -> mirror.json
//   node export.mjs --connections   1st-degree connections -> ../connections.csv
//
// Run with LINKEDIN_CDP=1 (import your session first). Output path override: -o.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ensureBackgroundChrome, CDP_PORT } from "./mcp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Args ---

const USAGE = "Usage: export.mjs [vanity] [--connections] [-o output] [--force] [--script file.js]";
const args = process.argv.slice(2);
let vanity = "";
let output = "";
let mode = "profile";
let force = false;
let scriptOverride = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "-o") {
    if (!args[i + 1]) { console.error("Error: -o requires a filename"); process.exit(1); }
    output = args[++i];
  } else if (args[i] === "--script") {
    // Run another in-page script instead: for probing an endpoint or proving
    // the harness reports a thrown error. The script must build a string
    // `output` and pass it to `new Blob` (the result channel); the outer
    // `catch (err) { console.error('Export failed:', err); }` is optional
    // but without it a thrown error reads as "no result". Saved verbatim.
    if (!args[i + 1]) { console.error("Error: --script requires a filename"); process.exit(1); }
    scriptOverride = args[++i];
  } else if (args[i] === "--connections") {
    mode = "connections";
  } else if (args[i] === "--force") {
    force = true;
  } else if (args[i].startsWith("-")) {
    console.error(USAGE);
    process.exit(1);
  } else {
    vanity = args[i];
  }
}

// vanity is optional: when omitted, it is discovered from the logged-in
// session (/voyager/api/me) after the auth gate, so nobody configures it.

// Defaults are anchored to this file, not the cwd: a cwd-relative default once
// left a second, stale mirror.json at the repo root for six months.
const MODES = {
  profile: { script: "export-inpage.js", output: join(__dirname, "mirror.json") },
  connections: { script: "linkedin-connections.js", output: join(__dirname, "..", "connections.csv") },
};
if (!output) output = MODES[mode].output;

const scriptName = scriptOverride || MODES[mode].script;
const exportScript = readFileSync(scriptOverride || join(__dirname, scriptName), "utf8");
const profileDir = join(
  process.env.HOME, "Library/Caches/ms-playwright/mcp-chrome-linkedin-export"
);
const mcpOutput = mkdtempSync(join(tmpdir(), "linkedin-export-"));

// --- MCP server ---

// Pinned; @latest renamed a tool once and this script failed silently for
// months. Under LINKEDIN_CDP=1 the MCP attaches to the shared Chrome rather
// than launching its own, so a single imported session serves every command.
if (process.env.LINKEDIN_CDP === "1") console.error(`  background Chrome: ${await ensureBackgroundChrome()}`);
const mcp = spawn("npx", [
  "@playwright/mcp@0.0.80",
  ...(process.env.LINKEDIN_CDP === "1" ? ["--cdp-endpoint", `http://127.0.0.1:${CDP_PORT}`] : ["--user-data-dir", profileDir]),
  "--output-dir", mcpOutput,
  "--snapshot-mode", "none",
  ...(process.env.LINKEDIN_HEADLESS === "1" && process.env.LINKEDIN_CDP !== "1" ? ["--headless"] : []),
], { stdio: ["pipe", "pipe", "pipe"] });

// Forward MCP stderr, filtering Chrome extension noise
const stderrRl = createInterface({ input: mcp.stderr });
stderrRl.on("line", (line) => {
  if (!line.includes("chrome-extension://")) console.error(line);
});

function cleanup() {
  try { mcp.kill(); } catch {}
  try { rmSync(mcpOutput, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

// --- JSON-RPC client ---

const rl = createInterface({ input: mcp.stdout });
let nextId = 0;
const pending = new Map();

rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  } catch (e) {
    console.error("JSON-RPC parse error:", e.message, "line:", line.substring(0, 200));
  }
});

function send(method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
  });
}

// MCP reports tool failures (unknown tool, thrown code) as isError on a
// successful JSON-RPC reply, not as a JSON-RPC error. Fail loudly on both.
async function callTool(name, args, timeoutMs = 30000) {
  const result = await send("tools/call", { name, arguments: args || {} }, timeoutMs);
  if (result?.isError) {
    const text = result.content?.map((c) => c.text).filter(Boolean).join("\n") || "";
    throw new Error(`${name} failed: ${text.replace(/^### Error\n/, "").trim()}`);
  }
  return result;
}

function countCsvRows(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).length - 1; // minus header
  } catch {
    return 0;
  }
}

// MCP evaluate wraps return values in markdown: "### Result\n<value>\n"
function extractEvalResult(result) {
  const text = result?.content?.[0]?.text || "";
  const match = text.match(/### Result\n(.*)\n/);
  return match ? match[1] : text;
}

// --- Main ---

async function main() {
  // Initialize MCP
  console.log("Starting MCP server...");
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "linkedin-export", version: "1.0" },
  }, 10000);
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

  // Navigate to the profile if we know it, else the feed (still auth-gated).
  console.log("Navigating to LinkedIn...");
  await callTool("browser_navigate", {
    url: vanity ? `https://www.linkedin.com/in/${vanity}/` : "https://www.linkedin.com/feed/",
  }, 60000);

  // Auth gate: LinkedIn redirects to /authwall or /login when not authenticated.
  // li_at is httpOnly so document.cookie cannot see it; check URL instead.
  // Both /in/<vanity>/ and /feed/ mean authenticated; /authwall and /login do not.
  function isOnProfile(result) {
    const p = extractEvalResult(result);
    return p.includes("/in/") || p.includes("/feed");
  }

  // Read the logged-in member's own vanity from /voyager/api/me.
  async function discoverVanity() {
    const r = extractEvalResult(await callTool("browser_evaluate", {
      function: `async () => {
        const csrf = document.cookie.match(/JSESSIONID="?([^";]+)/)?.[1];
        const res = await fetch('/voyager/api/me', { headers: { 'csrf-token': csrf, 'accept': 'application/vnd.linkedin.normalized+json+2.1', 'x-restli-protocol-version': '2.0.0' } });
        return (await res.text()).match(/"publicIdentifier":"([^"]+)"/)?.[1] || '';
      }`,
    }, 40000));
    return r.replace(/^"|"$/g, "").trim();
  }

  let locationCheck = await callTool("browser_evaluate", {
    function: "() => window.location.pathname",
  });

  if (!isOnProfile(locationCheck)) {
    console.log("\nLog into LinkedIn in the browser window.");
    console.log("Waiting for login (up to 5 minutes)...\n");

    const deadline = Date.now() + 5 * 60 * 1000;
    let loggedIn = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const check = await callTool("browser_evaluate", {
          function: "() => window.location.pathname",
        });
        if (isOnProfile(check)) { loggedIn = true; break; }
      } catch {}
    }

    if (!loggedIn) {
      console.error("Login timed out.");
      process.exit(1);
    }

    console.log("Login detected.");
  }

  // Discover the vanity from the session if it was not given, then make sure
  // we are on that profile before the in-page export reads it from the URL.
  if (!vanity) {
    vanity = await discoverVanity();
    if (!vanity) { console.error("Could not read your vanity from the session. Import your Chrome session first: node src/session-import.mjs"); process.exit(1); }
    console.log(`Logged in as ${vanity}.`);
  }
  await callTool("browser_navigate", { url: `https://www.linkedin.com/in/${vanity}/` }, 60000);

  // Wait for page to settle
  await callTool("browser_wait_for", { time: 3 });

  // Run export script via browser_run_code_unsafe + page.evaluate(string).
  // page.evaluate(string) evaluates as expression via CDP Runtime.evaluate,
  // bypassing both Playwright's function serialization and LinkedIn's CSP.
  console.log("Running export...");
  // The page's console is invisible here, so the script's result and its
  // failure both have to come back through window globals. Two injection
  // points, both mandatory: the success path and the outer catch.
  const injections = [
    ["const blob = new Blob", "window.__exportResult = output; const blob = new Blob", true],
    // The scripts end by clicking an <a download> so a human pasting them into
    // the console gets a file. Under automation the result is already read
    // from window.__exportResult, and the click is fatal: Chrome 153 dies
    // with SIGSEGV in the MCP's download handling and the export reads as
    // "Target page, context or browser has been closed". Bisected 2026-09-11:
    // the same script minus the click exits 0. So the click never runs here.
    ["a.click();", "/* download click skipped under automation */", !scriptOverride],
    ["console.error('Export failed:', err);",
     "window.__exportError = String((err && err.stack) || err); console.error('Export failed:', err);",
     !scriptOverride],
  ];
  let modifiedScript = exportScript;
  for (const [needle, replacement, required] of injections) {
    if (!modifiedScript.includes(needle)) {
      if (required) {
        console.error(`Injection point not found in ${scriptName}: ${needle}`);
        process.exit(1);
      }
      console.warn(`Note: ${scriptName} has no '${needle}'; a thrown error will read as "no result".`);
      continue;
    }
    modifiedScript = modifiedScript.replace(needle, replacement);
  }
  const scriptLiteral = JSON.stringify(modifiedScript);
  const code = `async (page) => { await page.evaluate(${scriptLiteral}); }`;
  await callTool("browser_run_code_unsafe", { code }, 120000);

  // Check result length
  const lenResult = await callTool("browser_evaluate", {
    function: '() => (window.__exportResult || "").length',
  });
  const len = parseInt(extractEvalResult(lenResult)) || 0;
  if (len === 0) {
    const errResult = await callTool("browser_evaluate", {
      function: '() => window.__exportError || ""',
    });
    let cause = extractEvalResult(errResult);
    if (cause.startsWith('"')) cause = JSON.parse(cause);
    console.error(cause ? `Export failed in page:\n${cause}` : "Export failed; no result and no error captured.");
    process.exit(1);
  }
  console.log(`Export complete (${len} bytes). Reading...`);

  const chunkSize = 50000;
  const chunks = [];
  for (let start = 0; start < len; start += chunkSize) {
    const end = Math.min(start + chunkSize, len);
    const chunkResult = await callTool("browser_evaluate", {
      function: `() => window.__exportResult.substring(${start}, ${end})`,
    });
    // MCP evaluate returns string values JSON-encoded; unwrap
    let chunkText = extractEvalResult(chunkResult);
    if (chunkText.startsWith('"')) {
      chunkText = JSON.parse(chunkText);
    }
    chunks.push(chunkText);
  }
  const raw = chunks.join("");

  // Close browser
  try { await callTool("browser_close", {}, 5000); } catch {}
  mcp.kill();

  // Validate and save
  if (scriptOverride) {
    writeFileSync(output, raw);
    console.log(`\nSaved raw result (${raw.length} bytes): ${output}`);
    return;
  }
  const parsed = JSON.parse(raw);

  if (parsed.warnings?.length) {
    console.warn(`\n${parsed.warnings.length} API warning(s) from the page:`);
    for (const w of parsed.warnings) console.warn(`  ${w}`);
  }

  if (mode === "connections") {
    const rows = parsed.connections || [];
    // The endpoint reports no total, so a short page is also what a
    // rate-limited or truncated run looks like. Connections rarely shrink:
    // refuse to overwrite a file with a materially smaller one.
    const previous = countCsvRows(output);
    if (rows.length === 0) {
      console.error("Export returned zero connections. Refusing to overwrite; --force does not apply to an empty result.");
      process.exit(1);
    }
    if (previous > 0 && rows.length < previous * 0.95 && !force) {
      console.error(`Export returned ${rows.length} connections, file has ${previous}. Refusing to overwrite (--force to override).`);
      process.exit(1);
    }
    const columns = ["name", "headline", "url", "connected_on"];
    const csvCell = (v) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [columns.join(",")];
    for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
    writeFileSync(output, lines.join("\n") + "\n");
    console.log(`\nExport: ${rows.length} connections`);
    console.log(`Saved: ${output}`);
    return;
  }

  const sections = parsed.sections || {};

  console.log(`\nExport: ${Object.keys(sections).length} sections`);
  for (const [name, value] of Object.entries(sections)) {
    if (Array.isArray(value)) {
      console.log(`  ${name}: ${value.length} items`);
    } else if (typeof value === "string") {
      console.log(`  ${name}: ${value.length} chars`);
    } else {
      const detail = Object.entries(value)
        .map(([sub, items]) => `${sub}:${items.length}`)
        .join(", ");
      console.log(`  ${name}: ${detail}`);
    }
  }

  writeFileSync(output, raw);
  console.log(`\nSaved: ${output}`);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  cleanup();
  process.exit(1);
});
