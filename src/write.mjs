#!/usr/bin/env node
// Writes one field of your source-of-truth file (linkedin.md) to LinkedIn
// through its own edit UI. The field is whatever the file declares.
//
// Drives the page, not the API. LinkedIn exposes no profile-write endpoint,
// and replaying the web app's private mutation would mean re-reversing its
// payload every time it moved. The edit dialog is the contract LinkedIn keeps:
// its validation rejects a bad paste in front of you, a missing control fails
// loudly instead of returning 200-with-no-effect, and the "notify network"
// switch is a real checkbox rather than a flag to guess at.
//
//   node write.mjs --probe headline     open the dialog, report its controls, save nothing
//   node write.mjs --dry-run headline   fill the control, report, do not save
//   node write.mjs headline             fill and save
//   node write.mjs --add-skills <pos>   add a position's missing skills
//   node write.mjs --delete-project "<title>"
//
// Run with LINKEDIN_CDP=1. After any save, prove it landed:
//   node export.mjs && node drift.mjs   (the "saved" line is never the proof)

import { startMcp } from "./mcp.mjs";
import { fieldsFromBlocks, MONTH_NAMES } from "./schema.mjs";
import { parseBlocks } from "./copy-blocks.mjs";

// Fields are whatever the source-of-truth file declares (id -> field def).
const { byId: BY_ID } = fieldsFromBlocks(parseBlocks());

// Resolved from the logged-in session (or LINKEDIN_VANITY) once per run,
// before any surface URL below is read. The URLs are getters so they pick it
// up lazily.
let VANITY = process.env.LINKEDIN_VANITY || "";
async function resolveVanity(mcp) { if (!VANITY) VANITY = await mcp.getVanity(); return VANITY; }

// Where each edit surface lives. Deep links open the dialog directly; if
// LinkedIn stops honouring one, the probe reports "no dialog" and this table
// is what to fix.
const SURFACES = {
  // The intro dialog has one contenteditable and it is the headline; the
  // probe found no accessible name on it, so the count assertion in the fill
  // code is what keeps this honest if LinkedIn adds a second one.
  intro: { get url() { return `https://www.linkedin.com/in/${VANITY}/edit/intro/`; }, control: '[contenteditable="true"]' },
  about: { get url() { return `https://www.linkedin.com/in/${VANITY}/edit/forms/summary/new/`; }, control: '[contenteditable="true"]' },
  // No deep link for an existing position without its URN, so open the
  // experience list and click the edit control on the row for this company.
  position: {
    // No per-user deep link: a position editor URL carries a numeric id we
    // cannot know for someone else's profile. So "url" is the experience list
    // and open() finds the row by company match every time.
    get url() { return `https://www.linkedin.com/in/${VANITY}/details/experience/`; },
    get fallbackUrl() { return `https://www.linkedin.com/in/${VANITY}/details/experience/`; },
    control: '[contenteditable="true"]',
    // This editor carries "Share with your network" (probe 2026-09-11: Off).
    // A save with it on tells every connection about an edit; refuse.
    notifySwitch: true,
    open: (match, shot) => `
async (page) => {
  page.setDefaultTimeout(8000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  try {
    // 1. the edit control names the role and company in its aria-label
    let edit = page.locator('a[aria-label*="Edit" i][aria-label*=${JSON.stringify(match)} i], button[aria-label*="Edit" i][aria-label*=${JSON.stringify(match)} i]');
    if (!(await edit.count())) {
      // 2. the row that mentions the company, then its edit control
      const rows = page.locator('li').filter({ hasText: ${JSON.stringify(match)} });
      await rows.first().waitFor({ state: 'visible', timeout: 15000 });
      if ((await rows.count()) !== 1) throw new Error((await rows.count()) + ' rows mention ' + ${JSON.stringify(match)} + '; refusing to guess which position to edit');
      edit = rows.first().locator('a[aria-label*="Edit" i], button[aria-label*="Edit" i]');
    }
    if ((await edit.count()) !== 1) throw new Error((await edit.count()) + ' edit controls match ' + ${JSON.stringify(match)} + '; refusing to guess');
    edit = edit.first();
    const label = await edit.getAttribute('aria-label');
    await edit.click();
    return JSON.stringify({ clicked: label });
  } catch (e) {
    await page.screenshot({ path: ${JSON.stringify(shot)} }).catch(() => {});
    const lis = await page.locator('li').count().catch(() => -1);
    throw new Error('could not open the position editor: ' + e.message.split('\\n')[0] + ' | url=' + page.url() + ' | li count=' + lis + ' | see ' + ${JSON.stringify(shot)});
  }
}`,
  },
  project: {
    get url() { return `https://www.linkedin.com/in/${VANITY}/edit/forms/project/new/`; },
    control: 'textarea',                 // Description is a plain textarea here, not a contenteditable
    titleLabel: 'Project name',          // getByLabel; the visible label is "Project name*"
    // An existing project has no stable deep link we know before opening the
    // list: its editor URL carries a numeric id (probe 2026-09-12:
    // /details/projects/edit/forms/<id>/). So open the list, let it lazy-load,
    // and click the edit link LinkedIn labels "Edit project <title>".
    get listUrl() { return `https://www.linkedin.com/in/${VANITY}/details/projects/`; },
    openExisting: (title, shot) => `
async (page) => {
  page.setDefaultTimeout(8000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const label = 'Edit project ' + ${JSON.stringify(title)};
  const edit = page.locator('a[aria-label=' + JSON.stringify(label) + '], button[aria-label=' + JSON.stringify(label) + ']');
  try {
    // The list shows ten and lazy-loads the rest when the last row scrolls
    // into view inside <main>, which is the scroller; window.scrollTo does
    // nothing here (probe 2026-09-12). Scroll the last edit link, then wheel.
    const all = page.locator('a[aria-label^="Edit project"]');
    let seen = -1;
    for (let i = 0; i < 12 && !(await edit.count()); i++) {
      const n = await all.count();
      if (n === seen) break;
      seen = n;
      await all.last().scrollIntoViewIfNeeded().catch(() => {});
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(1200);
    }
    const nEdit = await edit.count();
    if (nEdit === 0) throw new Error('no control labelled ' + JSON.stringify(label));
    if (nEdit > 1) {
      const hrefs = await edit.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
      throw new Error(nEdit + ' controls labelled ' + JSON.stringify(label) + '; two projects share this title, disambiguate by hand: ' + JSON.stringify(hrefs));
    }
    // Return the editor URL rather than clicking: a click-triggered navigation
    // took the browser down under headless automation (2026-09-12, same class
    // as the download click in docs/lessons), a plain navigate did not.
    const href = await edit.first().getAttribute('href');
    if (!href) throw new Error('edit control for ' + JSON.stringify(label) + ' has no href');
    // the run_code sandbox has no URL global; LinkedIn's hrefs here are absolute (probe 2026-09-12)
    return JSON.stringify({ label, href: href.startsWith('http') ? href : 'https://www.linkedin.com' + href });
  } catch (e) {
    await page.screenshot({ path: ${JSON.stringify(shot)} }).catch(() => {});
    const labels = await page.locator('a[aria-label^="Edit project"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    throw new Error('could not open the project editor: ' + e.message.split('\\n')[0] + ' | url=' + page.url() + ' | edit links seen: ' + JSON.stringify(labels) + ' | see ' + ${JSON.stringify(shot)});
  }
}`,
  },
};

const args = process.argv.slice(2);
const probe = args.includes("--probe");
const dryRun = args.includes("--dry-run");
const noop = args.includes("--noop"); // save the field's current text back: proves Save without changing anything visible
// --delete-project "<exact LinkedIn title>": open that project's editor, press
// "Delete project", and confirm. Not a schema field: the projects worth
// deleting are the ones the record never carried. --dry-run stops at the
// confirmation and reports its buttons, which is also how the dialog was probed.
// --add-skills <field-id>: add the schema's desired skills for a role that are
// not already on it (per the mirror), through the role editor's skill
// typeahead. Idempotent. Proof is export + a presence check, like every write.
const addSkillsIdx = args.indexOf("--add-skills");
const addSkillsField = addSkillsIdx === -1 ? null : args[addSkillsIdx + 1];
if (addSkillsField) {
  const field = BY_ID.get(addSkillsField);
  if (!field?.skills) { console.error(`no skills list on ${addSkillsField}`); process.exit(1); }
  const surface = SURFACES[field.write.surface];
  const { readFileSync } = await import("node:fs");
  const mirror = JSON.parse(readFileSync(new URL("./mirror.json", import.meta.url), "utf8"));
  const have = new Set((field.readSkills?.(mirror) ?? []).map((s) => s.toLowerCase()));
  const want = field.skills.filter((s) => !have.has(s.toLowerCase()));
  if (!want.length) { console.log(`all ${field.skills.length} desired skills already present; nothing to add`); process.exit(0); }
  console.log(`adding ${want.length} of ${field.skills.length} skills (missing): ${want.join(", ")}`);
  const mcp = startMcp({ clientName: "linkedin-write" });
  const shot = `/tmp/claude-501/linkedin-addskills.png`;
  try {
    await mcp.init();
    await resolveVanity(mcp);
    await mcp.ensureLoggedIn(VANITY);
    // One skill per fresh editor open + Save. A single browser call that does
    // the whole loop crashes the headless CDP Chrome partway (2026-09-12); the
    // writes that hold all day are each one dialog and one Save, so match that.
    const added = [], skipped = [];
    for (const skill of want) {
      await mcp.callTool("browser_navigate", { url: surface.url }, 60000);
      const raw = await mcp.runCode(`
async (page) => {
  page.setDefaultTimeout(12000);
  await page.waitForTimeout(1200);
  const dialog = page.getByRole('dialog').first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  const skill = ${JSON.stringify(skill)};
  const DRY = ${JSON.stringify(dryRun)};
  // Already a chip? Then it is present; nothing to do.
  const present = await dialog.locator('button, span').evaluateAll((els, skill) => els.some((e) => { const t = (e.getAttribute('aria-label') || e.textContent).replace(/\\s+/g, ' ').trim(); return new RegExp('^' + skill.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '\\\\s*(✓|checkmark)?$', 'i').test(t); }), skill);
  if (present) return JSON.stringify({ skill, state: 'already-present' });
  await dialog.getByRole('button', { name: /^add skill$/i }).first().click();
  await page.waitForTimeout(1200);
  const box = dialog.locator('input[placeholder^="Skill"]').first();
  if (!(await box.count())) return JSON.stringify({ skill, state: 'no-input' });
  await box.click();
  await box.pressSequentially(skill, { delay: 70 });
  await page.waitForTimeout(2500);
  // The "Additional skills" heading precedes new (not-yet-added) results; the
  // typeahead renders each result as a clickable chip/button carrying the text.
  const result = dialog.locator('button, [role="option"]').filter({ hasText: new RegExp('^\\\\s*' + skill.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '\\\\s*\\\\+?\\\\s*$', 'i') }).first();
  if (!(await result.count())) return JSON.stringify({ skill, state: 'no-result' });
  await result.click();
  await page.waitForTimeout(1200);
  // Confirm it is now a chip with a check.
  const nowChip = await dialog.locator('button, span').evaluateAll((els, skill) => els.some((e) => { const t = (e.getAttribute('aria-label') || e.textContent).replace(/\\s+/g, ' ').trim(); return new RegExp('^' + skill.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '\\\\s*(✓|checkmark)', 'i').test(t) || (t.toLowerCase() === skill.toLowerCase()); }), skill);
  // --dry-run: the skill is selected and confirmed, but discard instead of Save.
  if (DRY) {
    await dialog.getByRole('button', { name: /^dismiss$/i }).first().click().catch(() => {});
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /discard/i }).first().click().catch(() => {});
    return JSON.stringify({ skill, state: nowChip ? 'would-add' : 'would-add-unconfirmed', dryRun: true });
  }
  // Refuse to save if "Share with your network" is on.
  const sw = dialog.getByRole('switch');
  for (let i = 0; i < await sw.count(); i++) { const on = await sw.nth(i).evaluate((e) => e.checked === true || e.getAttribute('aria-checked') === 'true'); if (on) return JSON.stringify({ skill, state: 'notify-on' }); }
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const gone = await dialog.waitFor({ state: 'hidden', timeout: 20000 }).then(() => true, () => false);
  await page.waitForTimeout(1000);
  return JSON.stringify({ skill, state: nowChip ? 'added' : 'clicked-unconfirmed', savedDialogGone: gone });
}`, 90000);
      let r; try { r = JSON.parse(raw); } catch { r = { skill, state: 'non-json', raw: raw.slice(0, 200) }; }
      if (/^(added|already-present|clicked-unconfirmed|would-add|would-add-unconfirmed)$/.test(r.state)) added.push(r);
      else skipped.push(r);
      console.log(`  ${skill}: ${r.state}`);
    }
    const out = { added, skipped };
    {
          console.log(`\n  added/present: ${out.added.map((a) => a.skill).join(", ") || "none"}`);
      if (out.skipped.length) console.log(`  needs a look: ${out.skipped.map((r) => `${r.skill} (${r.state})`).join(", ")}`);
      console.log("\nNow prove it: LINKEDIN_CDP=1 node export.mjs && node drift.mjs");
      process.exit(out.skipped.length ? 1 : 0);
    }
  } catch (err) {
    console.error(`\nFailed: ${err.message}\n  screenshot, if any: ${shot}`);
    process.exit(2);
  } finally {
    try { await mcp.callTool("browser_close", {}, 5000); } catch {}
    mcp.close();
  }
}

const deleteIdx = args.indexOf("--delete-project");
const deleteTitle = deleteIdx === -1 ? null : args[deleteIdx + 1];
const fieldId = deleteTitle ? null : args.find((a) => !a.startsWith("--"));
if (!fieldId && !deleteTitle) { console.error("Usage: linkedin-write.mjs [--probe|--dry-run|--noop] <field-id>  |  linkedin-write.mjs [--dry-run] --delete-project \"<title>\""); process.exit(1); }
if (deleteTitle) {
  const mcp = startMcp({ clientName: "linkedin-write" });
  const shot = `/tmp/claude-501/linkedin-${dryRun ? "dry" : "save"}-delete.png`;
  try {
    await mcp.init();
    await resolveVanity(mcp);
    await mcp.ensureLoggedIn(VANITY);
    const surface = SURFACES.project;
    console.log(`Opening ${surface.listUrl} to find the editor for "${deleteTitle}"`);
    await mcp.callTool("browser_navigate", { url: surface.listUrl }, 60000);
    const found = JSON.parse(await mcp.runCode(surface.openExisting(deleteTitle, shot), 60000));
    console.log(`  ${found.label} -> ${found.href}`);
    await mcp.callTool("browser_navigate", { url: found.href }, 60000);
    const raw = await mcp.runCode(`
async (page) => {
  page.setDefaultTimeout(5000);
  await page.waitForTimeout(1000);
  const editor = page.getByRole('dialog').first();
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  const title = await editor.getByLabel('Project name').first().inputValue().catch(() => null);
  if (title !== ${JSON.stringify(deleteTitle)}) return JSON.stringify({ error: 'editor is for ' + JSON.stringify(title) + ', not the requested project; not deleting' });
  const del = editor.getByRole('button', { name: /^delete project$/i });
  if ((await del.count()) !== 1) return JSON.stringify({ error: 'expected one "Delete project" button, found ' + (await del.count()) });
  await del.click();
  await page.waitForTimeout(1200);
  const confirm = page.getByRole('dialog').last();
  const buttons = [];
  for (const b of await confirm.getByRole('button').all()) buttons.push(((await b.textContent()) || (await b.getAttribute('aria-label')) || '').trim());
  const text = (await confirm.textContent().catch(() => '')).replace(/\\s+/g, ' ').trim().slice(0, 240);
  // LinkedIn doubles controls (a visible button and a wrapper carrying the
  // same name), so pick the visible "Delete" rather than demanding one match.
  const yesAll = confirm.getByRole('button', { name: /^delete$/i });
  const nYes = await yesAll.count();
  let yes = null;
  for (let i = 0; i < nYes; i++) if (await yesAll.nth(i).isVisible().catch(() => false)) { yes = yesAll.nth(i); break; }
  if (${JSON.stringify(dryRun)}) {
    const no = confirm.getByRole('button', { name: /^(no thanks|cancel|dismiss)$/i }).first();
    if (await no.count()) await no.click();
    return JSON.stringify({ mode: 'dry', title, confirmText: text, confirmButtons: buttons, deleteButtons: nYes, wouldClick: yes ? 'Delete' : null });
  }
  if (!yes) return JSON.stringify({ error: 'no visible "Delete" confirm button (' + nYes + ' matched); buttons: ' + JSON.stringify(buttons) });
  await yes.click();
  const gone = await editor.waitFor({ state: 'hidden', timeout: 20000 }).then(() => true, () => false);
  let after = null; try { await page.waitForTimeout(1500); await page.screenshot({ path: ${JSON.stringify(shot)} }); after = page.url(); } catch (e) { after = 'page closed after confirm (headless does this; the export decides)'; }
  return JSON.stringify({ mode: 'delete', title, confirmText: text, editorGone: gone, after });
}`, 120000);
    let out; try { out = JSON.parse(raw); } catch { throw new Error(`delete returned non-JSON:\n${raw.slice(0, 400)}`); }
    if (out.error) { console.error(`\n${out.error}\n  see: ${shot}`); process.exit(2); }
    console.log(JSON.stringify(out, null, 2));
    if (!dryRun) console.log("\nNow prove it: LINKEDIN_CDP=1 node export.mjs && node drift.mjs");
    process.exit(0);
  } catch (err) {
    console.error(`\nFailed: ${err.message}\n  screenshot, if any: ${shot}`);
    process.exit(2);
  } finally {
    try { await mcp.callTool("browser_close", {}, 5000); } catch {}
    mcp.close();
  }
}

const field = BY_ID.get(fieldId);
if (!field) { console.error(`Unknown field "${fieldId}". Known: ${[...BY_ID.keys()].join(", ")}`); process.exit(1); }
const surface = SURFACES[field.write.surface];
if (!surface) { console.error(`No surface "${field.write.surface}" for ${fieldId} yet`); process.exit(1); }

// Playwright code that runs inside the MCP server with a live `page`.
// Returns JSON describing every text control in the open dialog: the probe's
// whole output, and the writer's pre-flight.
const SHOT = `/tmp/claude-501/linkedin-${probe ? "probe" : dryRun ? "dry" : noop ? "noop" : "save"}-${field.write.surface}.png`;
const DESCRIBE_DIALOG = `
async (page) => {
  page.setDefaultTimeout(4000);
  const shot = ${JSON.stringify(SHOT)};
  const diag = async (error) => JSON.stringify({
    error, url: page.url(), title: await page.title().catch(() => null),
    dialogs: await page.getByRole('dialog').count().catch(() => -1), screenshot: shot,
  }, null, 2);
  // Not waitForLoadState('networkidle'): under headless that wait took the
  // page down with "Target page, context or browser has been closed"
  // (bisected 2026-09-12; the same page answered a count() a moment earlier).
  // The dialog wait below is the readiness check that matters.
  await page.waitForTimeout(1000);
  const dialog = page.getByRole('dialog').first();
  try { await dialog.waitFor({ state: 'visible', timeout: 15000 }); }
  catch (e) { await page.screenshot({ path: shot, fullPage: false }).catch(() => {}); return diag('no dialog: ' + e.message.split('\\n')[0]); }
  const heading = await dialog.getByRole('heading').first().textContent().catch(() => null);
  await dialog.evaluate((d) => { for (const el of [d, ...d.querySelectorAll('*')]) if (el.scrollHeight > el.clientHeight + 20) el.scrollTop = el.scrollHeight; }).catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  const controls = [];
  const SEL = 'input:not([type=hidden]), textarea, [contenteditable="true"], [role="textbox"]';
  for (const loc of await dialog.locator(SEL).all()) {
    const id = await loc.getAttribute('id');
    let label = id
      ? await page.locator('label[for="' + id + '"]').first().textContent({ timeout: 800 }).catch(() => null)
      : null;
    const labelledBy = await loc.getAttribute('aria-labelledby');
    if (!label && labelledBy) {
      const parts = [];
      for (const lid of labelledBy.split(/\\s+/)) {
        parts.push(await page.locator('[id="' + lid + '"]').first().textContent({ timeout: 800 }).catch(() => ''));
      }
      label = parts.join(' ');
    }
    if (!label) {
      // switches and checkboxes are usually wrapped by their label, or sit beside it
      label = await loc.locator('xpath=ancestor::label[1]').first().textContent({ timeout: 800 }).catch(() => null)
           || await loc.locator('xpath=following-sibling::label[1]').first().textContent({ timeout: 800 }).catch(() => null)
           || await loc.locator('xpath=..').first().textContent({ timeout: 800 }).catch(() => null);
    }
    const tag = await loc.evaluate((e) => e.tagName.toLowerCase());
    const editable = await loc.getAttribute('contenteditable');
    const value = editable === 'true'
      ? await loc.textContent().catch(() => '')
      : await loc.inputValue().catch(() => '');
    const role = await loc.getAttribute('role');
    const type = await loc.getAttribute('type');
    let context = null, checked = null;
    if (role === 'switch' || type === 'checkbox') {
      checked = await loc.evaluate((e) => e.checked ?? e.getAttribute('aria-checked'));
      // walk outward until some ancestor carries words; a bare switch sits in a div of divs
      for (const depth of [1, 2, 3, 4, 5]) {
        const t = await loc.locator('xpath=ancestor::*[' + depth + ']').first().textContent({ timeout: 800 }).catch(() => null);
        const words = t && t.replace(/\\s+/g, ' ').trim();
        if (words && words.length > 3) { context = words.slice(0, 120); break; }
      }
    }
    controls.push({
      tag, role, editable, id, checked, context,
      name: await loc.getAttribute('name'),
      label: label && label.replace(/\\s+/g, ' ').trim(),
      ariaLabel: await loc.getAttribute('aria-label'),
      maxlength: await loc.getAttribute('maxlength'),
      valueLength: (value || '').length,
      valueHead: (value || '').slice(0, 40),
    });
  }
  const buttons = [];
  for (const b of await dialog.getByRole('button').all()) {
    buttons.push(((await b.textContent()) || (await b.getAttribute('aria-label')) || '').trim());
  }
  return JSON.stringify({ url: page.url(), heading: heading && heading.trim(), controls, buttons, screenshot: shot }, null, 2);
}`;

// Select-all then insertText, which is what a paste does from the editor's
// point of view: one input event carrying the whole string, so LinkedIn's
// own handler decides how a newline becomes a paragraph. keyboard.type would
// fire a keystroke per character and the editor's autocomplete gets a vote.
function fillCode({ control, text, mode, shot, title, titleLabel, notifySwitch, dates, editing }) {
  return `
async (page) => {
  page.setDefaultTimeout(5000);
  const MODE = ${JSON.stringify(mode)};
  const SHOT = ${JSON.stringify(shot)};
  const DATES = ${JSON.stringify(dates ?? null)};
  const MONTH_NAMES = ${JSON.stringify(MONTH_NAMES)};
  const dialog = page.getByRole('dialog').first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  const box = dialog.locator(${JSON.stringify(control)});
  const n = await box.count();
  if (n !== 1) return JSON.stringify({ error: 'expected exactly 1 control matching ' + ${JSON.stringify(control)} + ', found ' + n });
  const isTextarea = (await box.evaluate((e) => e.tagName)) === 'TEXTAREA';
  const read = () => isTextarea ? box.inputValue() : box.innerText();
  const before = await read();
  const text = MODE === 'noop' ? before : ${JSON.stringify(text)};
  if (${JSON.stringify(title ?? null)} !== null) {
    const titleBox = dialog.getByLabel(${JSON.stringify(titleLabel ?? "")}).first();
    if (${JSON.stringify(Boolean(editing))}) {
      // Editing: the title identifies the project; verify it, never overwrite it.
      const current = await titleBox.inputValue();
      if (current !== ${JSON.stringify(title ?? "")}) return JSON.stringify({ error: 'open editor is for ' + JSON.stringify(current) + ', not ' + ${JSON.stringify(title ?? "")} + '; not saving' });
    } else {
      await titleBox.fill(${JSON.stringify(title ?? "")});
    }
  }
  if (isTextarea) {
    await box.fill(text);                 // exact, newline-preserving
  } else {
    await box.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.insertText(text);
  }
  if (DATES && MODE !== 'noop') {
    // Probe 2026-09-12: two Month/Year select pairs (start, then end) and one
    // checkbox, "I am currently working on this project", which hides the end
    // pair when checked. Labels are exact, so getByLabel finds only these.
    const months = dialog.getByLabel('Month', { exact: true });
    const years = dialog.getByLabel('Year', { exact: true });
    if ((await months.count()) < 1 || (await years.count()) < 1) return JSON.stringify({ error: 'no Month/Year selects in this dialog; the editor changed shape, not saving' });
    const [sy, sm] = DATES.start.split('-');
    await months.nth(0).selectOption({ label: MONTH_NAMES[Number(sm) - 1] });
    await years.nth(0).selectOption({ label: sy });
    // LinkedIn renders the one "currently working" control as two checkbox
    // elements (an input and its wrapper), as it does the network switch, so
    // act on the visible one and read state from the first.
    const boxes = dialog.getByRole('checkbox');
    const nBoxes = await boxes.count();
    if (nBoxes === 0) return JSON.stringify({ error: 'no "currently working" checkbox in this dialog; the editor changed shape, not saving' });
    let current = boxes.first();
    for (let i = 0; i < nBoxes; i++) if (await boxes.nth(i).isVisible().catch(() => false)) { current = boxes.nth(i); break; }
    const isOn = () => boxes.first().isChecked();
    if (DATES.end === null) {
      if (!(await isOn())) await current.click({ force: true });
      if (!(await isOn())) return JSON.stringify({ error: 'could not switch "currently working" on; not saving' });
    } else {
      if (await isOn()) await current.click({ force: true });
      if (await isOn()) return JSON.stringify({ error: 'could not switch "currently working" off; not saving' });
      const [ey, em] = DATES.end.split('-');
      await months.nth(1).selectOption({ label: MONTH_NAMES[Number(em) - 1] });
      await years.nth(1).selectOption({ label: ey });
    }
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(400);
  const after = await read();
  let datesBack = null;
  if (DATES && MODE !== 'noop') {
    const months = dialog.getByLabel('Month', { exact: true });
    const years = dialog.getByLabel('Year', { exact: true });
    const opt = async (sel) => sel.evaluate((e) => e.options[e.selectedIndex]?.text ?? '');
    datesBack = { start: (await opt(months.nth(0))) + ' ' + (await opt(years.nth(0))), current: await dialog.getByRole('checkbox').first().isChecked() };
    if ((await months.count()) > 1) datesBack.end = (await opt(months.nth(1))) + ' ' + (await opt(years.nth(1)));
  }
  // innerText renders each editor block with its own newline count, so a
  // paragraph break can read back as three or five newlines. The gate here
  // checks that the words landed; whether LinkedIn stored the breaks the way
  // the record has them is what the re-export and drift check are for.
  const norm = (s) => s.replace(/\\r/g, '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+$/gm, '').replace(/\\n+/g, '\\n').trim();
  const matches = norm(after) === norm(text);
  await page.screenshot({ path: SHOT }).catch(() => {});
  const result = { mode: MODE, beforeLength: before.length, afterLength: after.length, matches, after: matches ? undefined : after.slice(0, 300), dates: datesBack };
  if (MODE === 'dry') {
    await dialog.getByRole('button', { name: /^(Dismiss|Close)$/ }).first().click();
    const discard = page.getByRole('button', { name: /discard/i }).first();
    if (await discard.isVisible({ timeout: 2500 }).catch(() => false)) await discard.click();
    result.dialogGone = await dialog.waitFor({ state: 'hidden', timeout: 10000 }).then(() => true, () => false);
    return JSON.stringify(result);
  }
  if (!matches) return JSON.stringify({ error: 'field does not read back as the desired text; not saving', after: after.slice(0, 300) });
  if (${JSON.stringify(Boolean(notifySwitch))}) {
    // LinkedIn renders the one control as two role=switch elements (an input
    // and its wrapper), so require that every switch is off, not that there is one.
    const sw = dialog.getByRole('switch');
    const n = await sw.count();
    if (n === 0) return JSON.stringify({ error: 'no "Share with your network" switch found; the editor changed shape, not saving' });
    for (let i = 0; i < n; i++) {
      const on = await sw.nth(i).evaluate((e) => e.checked === true || e.getAttribute('aria-checked') === 'true');
      if (on) return JSON.stringify({ error: '"Share with your network" is ON in this editor; not saving. Turn it off by hand first.' });
    }
    result.notifyNetwork = 'off (' + n + ' switch elements checked)';
  }
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  // isHidden answers immediately; waitFor is the one that waits. Under
  // headless the page can report itself closed right after Save while the
  // write has landed (2026-09-12: headline "failed" this way and the export
  // showed it saved), so nothing after the click may throw. The re-export
  // is the proof either way.
  result.dialogGone = await dialog.waitFor({ state: 'hidden', timeout: 20000 }).then(() => true, () => false);
  try { await page.waitForTimeout(1500); await page.screenshot({ path: SHOT }); result.url = page.url(); }
  catch (e) { result.pageClosedAfterSave = e.message.split('\\n')[0]; }
  return JSON.stringify(result);
}`;
}

const mcp = startMcp({ clientName: "linkedin-write" });

try {
 try {
  await mcp.init();
  await resolveVanity(mcp);
  await mcp.ensureLoggedIn(VANITY);

  // A project that already exists on LinkedIn (per the mirror) is edited in
  // place; one that does not is added through the "new" form. Both paths end
  // in the same dialog, so everything after this is shared.
  let existing;
  if (field.write.createIfAbsent) {
    const { readFileSync } = await import("node:fs");
    const mirror = JSON.parse(readFileSync(new URL("./mirror.json", import.meta.url), "utf8"));
    // No catch: a shape error here (Projects section missing from the mirror)
    // must stop the run. Swallowed, it reads as "absent" and the tool adds a
    // duplicate project on the live profile (review finding, 2026-09-12).
    existing = field.read(mirror);
  }
  if (existing !== undefined && surface.openExisting) {
    console.log(`Opening ${surface.listUrl} to find the editor for "${field.linkedinTitle}" (present in the mirror)`);
    await mcp.callTool("browser_navigate", { url: surface.listUrl }, 60000);
    const found = JSON.parse(await mcp.runCode(surface.openExisting(field.linkedinTitle, SHOT), 60000));
    console.log(`  ${found.label} -> ${found.href}`);
    await mcp.callTool("browser_navigate", { url: found.href }, 60000);
    if (process.env.LINKEDIN_TRACE) console.log("  trace after editor navigate:", await mcp.runCode(`async (page) => { await page.waitForTimeout(1500); return JSON.stringify({ url: page.url(), dialogs: await page.getByRole('dialog').count() }); }`, 30000));
  } else {
    console.log(`Opening ${surface.url}`);
    await mcp.callTool("browser_navigate", { url: surface.url }, 60000);
  }
  if (surface.open) {
    const dialogsRaw = (await mcp.runCode(`async (page) => { await page.waitForTimeout(2500); return String(await page.getByRole('dialog').count()); }`, 20000)).trim();
    if (!/^\d+$/.test(dialogsRaw)) throw new Error(`dialog-count probe returned non-numeric output: ${dialogsRaw.slice(0, 200)}`);
    const dialogs = Number(dialogsRaw);
    if (dialogs === 0) {
      console.log("Deep link opened no editor; falling back to the list and its edit control.");
      await mcp.callTool("browser_navigate", { url: surface.fallbackUrl }, 60000);
      const match = field.write.match?.subtitle?.source?.replace(/\\\\/g, "");
      if (!match) throw new Error(`${fieldId} has no match="Company" to find its position row`);
      console.log(`Opening the editor for the row matching ${JSON.stringify(match)}: ${await mcp.runCode(surface.open(match, SHOT), 60000)}`);
    }
  }

  const described = await mcp.runCode(DESCRIBE_DIALOG, 90000);
  let dialog;
  try { dialog = JSON.parse(described); } catch { throw new Error(`Dialog probe returned non-JSON:\n${described}`); }
  if (typeof dialog !== "object" || dialog === null) throw new Error(`Dialog probe returned ${typeof dialog}:\n${described.slice(0, 400)}`);
  if (dialog.error) {
    console.error(`\n${dialog.error}\n  url:     ${dialog.url}\n  title:   ${dialog.title}\n  dialogs: ${dialog.dialogs}\n  see:     ${dialog.screenshot}`);
    process.exit(2);
  }

  console.log("\nDialog:", dialog.heading ?? "(no heading)");
  console.log("URL:   ", dialog.url);
  console.log("\nControls:");
  for (const c of dialog.controls) {
    const kind = c.editable === "true" ? `${c.tag}[ce]` : c.role ? `${c.tag}[${c.role}]` : c.tag;
    console.log(`  ${kind.padEnd(14)} ${(c.label || c.ariaLabel || c.name || c.id || "?").slice(0, 34).padEnd(36)} max=${c.maxlength ?? "-"}  len=${String(c.valueLength).padStart(4)}  ${JSON.stringify(c.valueHead)}`);
    if (c.checked !== null) console.log(`                 checked=${c.checked}  near: ${JSON.stringify(c.context)}`);
  }
  console.log("\nButtons:", dialog.buttons.filter(Boolean).join(" | "));

  if (probe) {
    console.log("\n--probe: nothing changed.");
    process.exit(0);
  }

  const desired = noop ? null : parseBlocks().get(fieldId)?.text;
  if (!noop && !desired) throw new Error(`your source-of-truth file has no block for "${fieldId}"`);
  const mode = dryRun ? "dry" : noop ? "noop" : "save";
  console.log(`\n${{ dry: "--dry-run: filling, not saving", noop: "--noop: re-saving current text", save: "Writing" }[mode]} ${fieldId}${desired ? ` (${[...desired].length} chars)` : ""}.`);

  if (existing !== undefined && dialog.heading && !/edit/i.test(dialog.heading)) {
    throw new Error(`${fieldId} exists on LinkedIn but the open dialog is "${dialog.heading}", not an editor; not saving`);
  }
  if (field.write.match?.subtitle) {
    // The position editor must be the one for this company, whichever path opened it.
    const re = field.write.match.subtitle;
    if (!dialog.controls.some((c) => re.test(c.valueHead ?? "") || re.test(c.label ?? ""))) {
      throw new Error(`the open position editor shows no control matching ${re}; not saving`);
    }
  }
  const raw = await mcp.runCode(fillCode({
    control: surface.control, text: desired ?? "", mode, shot: SHOT,
    title: surface.titleLabel ? field.linkedinTitle : undefined, titleLabel: surface.titleLabel,
    notifySwitch: surface.notifySwitch, dates: field.dates, editing: existing !== undefined,
  }), 120000);
  let out;
  try { out = JSON.parse(raw); } catch { throw new Error(`fill returned non-JSON:\n${raw.slice(0, 400)}`); }
  if (out.error) {
    console.error(`\n${out.error}${out.after ? `\n  field now reads: ${JSON.stringify(out.after)}` : ""}\n  see: ${SHOT}`);
    process.exit(2);
  }
  console.log(`  before: ${out.beforeLength} chars  after: ${out.afterLength} chars  matches desired: ${out.matches}`);
  if (out.dates) console.log(`  dates read back: ${JSON.stringify(out.dates)}`);
  if (!out.matches && out.after) console.log(`  field reads: ${JSON.stringify(out.after)}`);
  console.log(`  ${mode === "dry" ? "discarded" : "saved"}; dialog ${out.dialogGone ? "closed" : "STILL OPEN"}${out.notifyNetwork ? `; share-with-network was ${out.notifyNetwork}` : ""}${out.pageClosedAfterSave ? "; page closed after Save (headless does this; the export decides)" : ""}; see ${SHOT}`);
  if (mode !== "dry") console.log("\nNow prove it: LINKEDIN_CDP=1 node export.mjs && node drift.mjs");
  process.exit(out.matches ? 0 : 1);
 } catch (err) {
  console.error(`\nFailed: ${err.message}\n  screenshot, if any: ${SHOT}`);
  process.exitCode = 2;
 }
} finally {
  try { await mcp.callTool("browser_close", {}, 5000); } catch {}
  mcp.close();
}
