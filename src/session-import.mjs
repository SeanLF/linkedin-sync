#!/usr/bin/env node
// Copy the live LinkedIn session from the everyday Google Chrome into the
// automation's Chrome, so the tools are logged in without a fresh sign-in.
//
// Why this exists: a headless login walks into LinkedIn's app-approval
// checkpoint and, after a few tries, "Too many attempts" (bisected 2026-09-12).
// The reliable path is not to log in at all: read the cookies Chrome already
// holds and inject them. Chrome encrypts cookies with a key in the login
// keychain ("Chrome Safe Storage"), so this prompts for Touch ID once.
//
//   LINKEDIN_CDP=1 ./tools/linkedin-import-session.mjs
//
// It targets the CDP Chrome by default (the shared background instance). With
// LINKEDIN_HEADLESS=1 instead, it injects into a one-off headless launch,
// which is pointless on its own (the launch exits); CDP is the useful target.
//
// Reads, never writes, the everyday profile. Cookie values are held in memory
// and passed to the automation over the MCP; nothing is written to disk and
// nothing is logged.

import { execFileSync } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startMcp } from "./mcp.mjs";

const CHROME = join(process.env.HOME, "Library/Application Support/Google/Chrome");

// The AES key: PBKDF2-SHA1 of the keychain password with LinkedIn's fixed salt
// and iteration count (Chromium's oscrypt constants on macOS).
function chromeKey() {
  const pw = execFileSync("security", ["find-generic-password", "-s", "Chrome Safe Storage", "-w"], { encoding: "utf8" }).trim();
  return pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
}

function decrypt(blob, key) {
  if (!blob || blob.subarray(0, 3).toString() !== "v10") return null;
  const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  let out = Buffer.concat([d.update(blob.subarray(3)), d.final()]);
  // Chrome 130+ prefixes the plaintext with a 32-byte SHA-256 of the host key.
  if (out.length > 32 && out.subarray(0, 32).some((b) => b < 32 || b > 126)) out = out.subarray(32);
  return out.toString("utf8");
}

// Read from a copy: Chrome holds a lock on the live Cookies DB. Queried with
// the macOS `sqlite3` binary rather than a built-in, so there is no runtime
// version floor and it runs the same under Node or Bun. The encrypted BLOB
// comes back as hex; expires_utc as text (it can exceed a safe integer).
function readLinkedInCookies(profile = "Default") {
  const key = chromeKey();
  // Copy just the jar, never its journal sidecar: copying a stale (even
  // zero-byte) Cookies-journal makes SQLite roll the copy back and it reads as
  // empty. Without the journal, the copied jar reads its committed rows.
  const tmp = join(tmpdir(), `li-cookies-${process.pid}.db`);
  copyFileSync(join(CHROME, profile, "Cookies"), tmp);
  try {
    const sql = "SELECT host_key, name, hex(encrypted_value) AS enc, path, " +
      "CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly " +
      "FROM cookies WHERE host_key LIKE '%linkedin.com';";
    const out = execFileSync("sqlite3", ["-json", tmp, sql], { encoding: "utf8" }).trim();
    const rows = out ? JSON.parse(out) : [];
    const cookies = [];
    for (const r of rows) {
      const value = decrypt(Buffer.from(r.enc, "hex"), key);
      if (value == null) continue;
      const c = { name: r.name, value, domain: r.host_key, path: r.path, secure: !!r.is_secure, httpOnly: !!r.is_httponly };
      if (r.expires_utc && r.expires_utc !== "0") c.expires = Math.floor(Number(BigInt(r.expires_utc) / 1000000n) - 11644473600);
      cookies.push(c);
    }
    return cookies;
  } finally {
    for (const ext of ["", "-journal", "-wal", "-shm"]) rmSync(tmp + ext, { force: true });
  }
}

const cookies = readLinkedInCookies();
if (!cookies.some((c) => c.name === "li_at")) {
  console.error(`No li_at cookie in the everyday Chrome for linkedin.com; sign in there first (${cookies.length} linkedin cookies seen).`);
  process.exit(1);
}
console.error(`  read ${cookies.length} LinkedIn cookies from the everyday Chrome (li_at present)`);

const mcp = startMcp({ clientName: "linkedin-import-session" });
try {
  await mcp.init();
  await mcp.callTool("browser_navigate", { url: "https://www.linkedin.com/" }, 60000);
  await mcp.runCode(`
async (page) => {
  const ctx = page.context();
  await ctx.clearCookies({ domain: /linkedin\\.com$/ }).catch(() => {});
  await ctx.addCookies(${JSON.stringify(cookies)});
  return "ok";
}`, 60000);
  // Who did we just become? getVanity reads /voyager/api/me, which both proves
  // the session works and tells us the account, so nothing is configured.
  const vanity = await mcp.getVanity();
  console.log(`Session imported: logged in as ${vanity} (linkedin.com/in/${vanity}).`);
  process.exit(0);
} catch (e) {
  console.error(`Injected cookies but the session did not authenticate: ${e.message.split("\n")[0]}`);
  process.exit(2);
} finally {
  try { await mcp.callTool("browser_close", {}, 5000); } catch {}
  mcp.close();
}
