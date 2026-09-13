// The Playwright MCP session every command drives: one pinned server, one
// Chrome, and the rule that an MCP tool failure is an error even though it
// arrives as a successful JSON-RPC reply.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Pinned. @latest renamed a tool once and the export failed silently for
// months, so bump deliberately and re-run to check the tool names.
export const MCP_PACKAGE = "@playwright/mcp@0.0.80";
export const PROFILE_DIR = join(process.env.HOME, "Library/Caches/ms-playwright/mcp-chrome-linkedin-export");
// The persistent CDP Chrome gets its own profile dir. A Chrome profile is
// single-instance-locked, so if the detached background instance shared
// PROFILE_DIR, a later non-CDP (headless or headed) launch would collide on
// the lock. Distinct dirs let both coexist.
export const CDP_PROFILE_DIR = join(process.env.HOME, "Library/Caches/ms-playwright/mcp-chrome-linkedin-cdp");

// MCP evaluate wraps return values in markdown: "### Result\n<value>\n"
export function extractEvalResult(result) {
  const text = result?.content?.[0]?.text || "";
  const match = text.match(/### Result\n([\s\S]*?)\n(?:###|$)/);
  return match ? match[1] : text;
}

// The tool drives one persistent Chrome over CDP: import the session once and
// every command attaches to it. That Chrome is visible by default so you can
// watch each write land; LINKEDIN_HEADLESS=1 makes it headless for unattended
// use. LINKEDIN_CDP_PORT overrides the debugging port.
export const CDP_PORT = Number(process.env.LINKEDIN_CDP_PORT || 9333);
async function cdpAlive() {
  try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return r.ok; } catch { return false; }
}
export async function ensureBackgroundChrome() {
  if (await cdpAlive()) return "already running";
  // A persistent Chrome, spawned from the binary and detached, that every
  // command attaches to over CDP (import the session once, reuse it).
  //
  // Visible by default so you can watch your profile change and review each
  // write as it happens; writing to a live profile is not something to do
  // behind a curtain. It shows a window and briefly takes focus when it opens;
  // set LINKEDIN_HEADLESS=1 to run it with no window (for automation). Visible
  // Chrome is also steadier than headless=new, which crashed intermittently on
  // navigation.
  //
  // --use-mock-keychain matches how Playwright launched the profile; without
  // it Chrome cannot decrypt the profile's cookies and deletes them (see the
  // second-chrome-destroys-cookies lesson in the origin repo).
  const { spawn } = await import("node:child_process");
  const headless = process.env.LINKEDIN_HEADLESS === "1";
  const bin = process.env.LINKEDIN_CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const child = spawn(bin, [
    ...(headless ? ["--headless=new"] : []),
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${CDP_PROFILE_DIR}`,
    "--use-mock-keychain", "--no-first-run", "--no-default-browser-check", "--window-size=1400,1000",
  ], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); if (await cdpAlive()) return `launched (${headless ? "headless" : "visible"}, detached)`; }
  throw new Error(`Chrome did not answer on CDP port ${CDP_PORT} within 20s`);
}

export function startMcp({ snapshots = false, clientName = "linkedin-tool" } = {}) {
  const outputDir = mkdtempSync(join(tmpdir(), "linkedin-mcp-"));
  const args = [MCP_PACKAGE, "--output-dir", outputDir];
  if (process.env.LINKEDIN_CDP === "1") args.push("--cdp-endpoint", `http://127.0.0.1:${CDP_PORT}`);
  else args.push("--user-data-dir", PROFILE_DIR);
  if (!snapshots) args.push("--snapshot-mode", "none");
  if (process.env.LINKEDIN_HEADLESS === "1" && process.env.LINKEDIN_CDP !== "1") args.push("--headless");
  const mcp = spawn("npx", args, { stdio: ["pipe", "pipe", "pipe"] });

  createInterface({ input: mcp.stderr }).on("line", (line) => {
    if (!line.includes("chrome-extension://")) console.error(line);
  });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    try { mcp.kill(); } catch {}
    try { rmSync(outputDir, { recursive: true, force: true }); } catch {}
  }
  process.on("exit", close);
  process.on("SIGINT", () => { close(); process.exit(130); });
  process.on("SIGTERM", () => { close(); process.exit(143); });

  let nextId = 0;
  const pending = new Map();
  createInterface({ input: mcp.stdout }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      console.error("JSON-RPC parse error:", e.message, "line:", line.substring(0, 200));
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
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
    // Attached over CDP the browser is shared and long-lived; closing it would
    // close the default context and with it the LinkedIn session (that is how
    // a fresh login evaporated on 2026-09-12). Disconnecting is enough.
    if (name === "browser_close" && process.env.LINKEDIN_CDP === "1") return { content: [{ type: "text", text: "detached; shared Chrome left running" }] };
    const result = await send("tools/call", { name, arguments: args || {} }, timeoutMs);
    if (result?.isError) {
      const text = result.content?.map((c) => c.text).filter(Boolean).join("\n") || "";
      throw new Error(`${name} failed: ${text.replace(/^### Error\n/, "").trim()}`);
    }
    return result;
  }

  async function init() {
    if (process.env.LINKEDIN_CDP === "1") console.error(`  background Chrome: ${await ensureBackgroundChrome()}`);
    await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0" },
    }, 10000);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  }

  /** Run Playwright code with a real `page`; returns the tool's text. */
  // The tool JSON-encodes a string return value, so a function that returns
  // JSON comes back as a JSON string of JSON. Unwrap exactly one layer.
  async function runCode(code, timeoutMs = 60000) {
    let text = extractEvalResult(await callTool("browser_run_code_unsafe", { code }, timeoutMs));
    if (text.startsWith('"')) { try { text = JSON.parse(text); } catch { console.error("  (tool result looked JSON-quoted but did not parse; passing it through as-is: " + text.slice(0, 120) + ")"); } }
    return text;
  }

  async function evaluate(fn) {
    let text = extractEvalResult(await callTool("browser_evaluate", { function: fn }));
    if (text.startsWith('"')) { try { text = JSON.parse(text); } catch { console.error("  (tool result looked JSON-quoted but did not parse; passing it through as-is: " + text.slice(0, 120) + ")"); } }
    return text;
  }

  // Auth gate. LinkedIn redirects to /authwall or /login when not
  // authenticated; li_at is httpOnly so document.cookie cannot see it, and the
  // pathname after navigating to a profile is the tell. This tool does NOT log
  // in: a scripted login walks into LinkedIn's app-approval checkpoint and then
  // "Too many attempts". Auth is by importing your already-logged-in Chrome
  // session; run src/session-import.mjs.
  async function onProfile() {
    for (let i = 0; i < 5; i++) {
      try { return (await evaluate("() => window.location.pathname")).includes("/in/"); }
      catch (err) { if (!/context was destroyed|navigation/i.test(err.message)) throw err; await new Promise((r) => setTimeout(r, 800)); }
    }
    return false;
  }

  // The vanity (publicIdentifier) of whoever this session is logged in as.
  // /voyager/api/me returns it, so no tool ever needs the vanity configured.
  async function getVanity() {
    await callTool("browser_navigate", { url: "https://www.linkedin.com/feed/" }, 60000);
    const raw = await runCode(`async (page) => {
      const csrf = (await page.context().cookies('https://www.linkedin.com')).find(c => c.name === 'JSESSIONID')?.value?.replace(/"/g, '');
      if (!csrf) return JSON.stringify({ error: 'no JSESSIONID' });
      const body = await page.evaluate(async (csrf) => {
        const r = await fetch('/voyager/api/me', { headers: { 'csrf-token': csrf, 'accept': 'application/vnd.linkedin.normalized+json+2.1', 'x-restli-protocol-version': '2.0.0' } });
        return { status: r.status, text: (await r.text()).slice(0, 4000) };
      }, csrf);
      const m = body.text.match(/"publicIdentifier":"([^"]+)"/);
      return JSON.stringify({ status: body.status, vanity: m ? m[1] : null });
    }`, 40000);
    const r = JSON.parse(raw);
    if (!r.vanity) throw new Error(`could not read your vanity name from the session (status ${r.status}). Import your Chrome session first: node src/session-import.mjs`);
    return r.vanity;
  }

  // Confirm the session is authenticated for `vanity`. Never logs in; on a miss
  // it points you at the session import.
  async function ensureLoggedIn(vanity) {
    await callTool("browser_navigate", { url: `https://www.linkedin.com/in/${vanity}/` }, 60000);
    if (await onProfile()) return;
    throw new Error("not logged in to LinkedIn. Import your Chrome session first:\n  LINKEDIN_CDP=1 node src/session-import.mjs\n(be signed into linkedin.com in your everyday Chrome)");
  }

    return { callTool, init, runCode, evaluate, ensureLoggedIn, getVanity, close };
}
