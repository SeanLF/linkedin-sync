// Drive one LinkedIn edit dialog with Playwright: check it is the right
// entry's editor, fill it, read every control back, and save or discard.
// Writes go through the dialog, never a replayed request: LinkedIn's write
// path changes every deploy, and the dialog runs its own validation and has
// the "share with your network" switch a replayed write would not.
//
// Every refusal here happens before Save. After Save, the only proof is a
// re-export and drift; a dialog that closed is not the proof.

import { expect, type Locator, type Page } from "@playwright/test";
import {
	type Control,
	type Editor,
	escapeRe,
	type Step,
	sameLink,
} from "./fields.ts";

export type Mode = "save" | "dry" | "noop" | "probe";

/** How long each wait may take on LinkedIn; the dialog tests shorten them. */
export const TIMEOUTS = {
	open: 15_000,
	heading: 5000,
	control: 3000,
	settle: 2500,
	close: 20_000,
	confirm: 6000,
	/** How long after the editor closes LinkedIn may still mount its "saved" prompt. */
	latePrompt: 2000,
};

/** A refusal: nothing was saved. */
export class Refused extends Error {}

/** What an editor can change on its own: CRs, NBSPs, trailing spaces, and how many newlines a break reads as. */
const norm = (v: string) =>
	v
		.replaceAll("\r", "")
		.replaceAll(" ", " ")
		.replace(/[ \t]+$/gmu, "")
		.replace(/\n+/gu, "\n")
		.trim();
const name = (c: Control) =>
	"css" in c ? c.css : `/${c.label.source}/${c.nth ? ` #${c.nth + 1}` : ""}`;

async function control(dialog: Locator, c: Control): Promise<Locator> {
	if (!("css" in c)) {
		const loc = dialog.getByLabel(c.label).nth(c.nth ?? 0);
		await loc
			.waitFor({ state: "attached", timeout: 3000 })
			.catch(() => undefined);
		if (!(await loc.count()))
			throw new Refused(
				`no control ${name(c)} in this editor; it changed shape, not saving`,
			);
		return loc;
	}
	const loc = dialog.locator(c.css);
	await loc
		.first()
		.waitFor({ state: "attached", timeout: 3000 })
		.catch(() => undefined);
	const n = await loc.count();
	if (n !== 1)
		throw new Refused(
			`expected one ${c.css} in this editor, found ${n}; not saving`,
		);
	return loc;
}

async function read(
	loc: Locator,
	kind: Step["kind"],
): Promise<string | boolean> {
	if (kind === "check") return loc.isChecked();
	// Index 0 is the blank placeholder ("Month", "Year"): it reads as "". Typed structurally: no DOM lib here.
	if (kind === "select")
		return loc.evaluate(
			(e: { options: ArrayLike<{ text: string }>; selectedIndex: number }) =>
				e.selectedIndex > 0
					? (e.options[e.selectedIndex]?.text.trim() ?? "")
					: "",
		);
	return (await loc.getAttribute("contenteditable")) === "true"
		? loc.innerText()
		: loc.inputValue();
}

function wanted(st: Step): string | boolean {
	if (st.kind === "text") return norm(st.value);
	return st.kind === "select" ? st.option : st.value;
}
const matches = (st: Step, got: string | boolean) =>
	typeof got === "string" && st.kind === "text"
		? norm(got) === wanted(st)
		: got === wanted(st);

async function fill(page: Page, loc: Locator, st: Step): Promise<void> {
	if (st.kind === "check") {
		// A visually hidden input refuses even a forced click (2026-10-29); a
		// dispatched click toggles it as a click on its label would.
		if ((await loc.isChecked()) !== st.value)
			await loc
				.click({ force: true, timeout: 3000 })
				.catch(() => loc.dispatchEvent("click"));
		return;
	}
	if (st.kind === "select") {
		if (st.option === "") {
			await loc.selectOption({ index: 0 });
			return;
		}
		const options = (await loc.locator("option").allTextContents()).map((o) =>
			o.trim(),
		);
		if (!options.includes(st.option))
			throw new Refused(
				`${name(st.control)} has no option ${JSON.stringify(st.option)}; it offers ${JSON.stringify(options.slice(0, 40))}`,
			);
		await loc.selectOption({ label: st.option });
		return;
	}
	if ((await loc.getAttribute("contenteditable")) === "true") {
		await loc.click();
		await page.keyboard.press("Meta+A");
		await page.keyboard.insertText(st.value);
	} else await loc.fill(st.value);
}

/** Close an editor without saving, answering a "Discard" prompt if one comes. */
async function discard(page: Page, dialog: Locator): Promise<void> {
	await dialog
		.getByRole("button", { name: /^(Dismiss|Close)$/u })
		.first()
		.click();
	const prompt = page.getByRole("button", { name: /discard/iu }).first();
	const asks = await Promise.race([
		prompt.waitFor({ state: "visible", timeout: 2500 }).then(() => true),
		dialog.waitFor({ state: "hidden", timeout: 2500 }).then(() => false),
	]).catch(() => false);
	if (asks) await prompt.click();
	await dialog.waitFor({ state: "hidden", timeout: 10_000 });
}

/** The open editor, after checking its heading and identity controls. */
async function openDialog(
	page: Page,
	ed: Editor,
	checkIdentity = true,
): Promise<Locator> {
	const dialog = page.getByRole("dialog").first();
	await dialog
		.waitFor({ state: "visible", timeout: TIMEOUTS.open })
		.catch(() => {
			throw new Refused(`no editor opened at ${page.url()}`);
		});
	const heading = dialog
		.getByRole("heading")
		.filter({ hasText: ed.heading })
		.first();
	const found = await heading
		.waitFor({ state: "attached", timeout: TIMEOUTS.heading })
		.then(
			() => true,
			() => false,
		);
	if (!found) {
		const shown = await dialog
			.getByRole("heading")
			.first()
			.textContent()
			.catch(() => "");
		throw new Refused(
			`the open dialog is "${shown?.trim()}", not ${ed.heading}; not touching it`,
		);
	}
	for (const id of checkIdentity ? ed.identity : []) {
		const loc = await control(dialog, id.control);
		// An editor can show its controls a beat before their values.
		await expect
			.poll(async () => norm(String(await read(loc, "text"))), {
				timeout: 3000,
			})
			.toBe(norm(id.value))
			.catch(async () => {
				throw new Refused(
					`this editor's ${name(id.control)} reads ${JSON.stringify(await read(loc, "text"))}, not ${JSON.stringify(id.value)}: the wrong entry; not touching it`,
				);
			});
	}
	return dialog;
}

type Notify = Editor["notify"];
/** The share switch's state, or why it refuses: LinkedIn renders one switch as two elements, and every one must be off. */
async function quietness(
	dialog: Locator,
	notify: Notify,
): Promise<{ ok: boolean; says: string }> {
	const switches = await dialog.getByRole("switch").all();
	if (!switches.length && notify === "required")
		return {
			ok: false,
			says: 'no "Share with your network" switch in this editor; it changed shape, not saving',
		};
	for (const sw of switches)
		if (await sw.isChecked())
			return {
				ok: false,
				says: '"Share with your network" is ON in this editor; not saving. Turn it off by hand first.',
			};
	return {
		ok: true,
		says: switches.length ? "share-with-network off" : "no share switch",
	};
}

/** The one share-switch guard: every Save, and every click that can save, goes through it. */
async function assertQuiet(
	page: Page,
	dialog: Locator,
	notify: Notify,
): Promise<{ ok: boolean; says: string }> {
	const quiet = await quietness(dialog, notify);
	if (!quiet.ok) await refuse(page, dialog, quiet.says);
	return quiet;
}

/** Close the editor unsaved, then refuse: a half-filled dialog must not be left in the next step's way. */
async function refuse(
	page: Page,
	dialog: Locator,
	says: string,
): Promise<never> {
	const closed = await discard(page, dialog).then(
		() => "",
		(e: Error) =>
			`; the editor could not be closed either (${e.message.split("\n")[0]})`,
	);
	throw new Refused(`${says}${closed}`);
}

/**
 * The dialog LinkedIn opens once an edit is saved: "Your experience is saved",
 * then "Next, connect with people you may know from <company>" (2026-11). It
 * takes the editor's place as the page's first dialog, so it says the save
 * went through, not that validation kept the editor open.
 */
const savedPrompt = (page: Page) =>
	page
		.getByRole("dialog")
		.filter({ has: page.getByText(/^Your [\w ]+ is saved$/u) })
		.first();

/** Close the saved prompt by its Skip (or Dismiss) control; never a Connect button. */
async function skipSavedPrompt(prompt: Locator): Promise<string> {
	const skipped = await prompt
		.getByRole("button", { name: /^(Skip|Dismiss)$/u })
		.first()
		.click({ timeout: TIMEOUTS.control })
		.then(() => prompt.waitFor({ state: "hidden", timeout: TIMEOUTS.close }))
		.then(
			() => true,
			() => false,
		);
	return skipped
		? `LinkedIn's "saved" prompt skipped`
		: `LinkedIn's "saved" prompt left open`;
}

/**
 * The editor itself, pinned by its heading. "The page's first dialog" stops
 * meaning the editor once it closes: LinkedIn's docked Messaging conversation
 * is a dialog too and stays open, so waiting for "first dialog hidden" timed
 * out on eight saves that had landed (2026-11-21).
 */
async function pinEditor(page: Page, dialog: Locator): Promise<Locator> {
	const heading = (
		await dialog
			.getByRole("heading")
			.first()
			.textContent({ timeout: TIMEOUTS.control })
			.catch(() => null)
	)?.trim();
	if (!heading) return dialog;
	return page
		.getByRole("dialog")
		.filter({
			has: page.getByRole("heading").filter({
				hasText: new RegExp(`^\\s*${escapeRe(heading)}\\s*$`, "u"),
			}),
		})
		.first();
}

/** Click Save and wait for the editor to close. Under headless the page can close on Save while the write lands; the export decides. */
async function save(
	page: Page,
	opened: Locator,
	notify: Notify = "if-present",
): Promise<string> {
	// Every Save goes through here, and none with the share switch on.
	const quiet = await assertQuiet(page, opened, notify);
	const dialog = await pinEditor(page, opened);
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	const prompt = savedPrompt(page);
	try {
		const prompted = await Promise.race([
			dialog
				.waitFor({ state: "hidden", timeout: TIMEOUTS.close })
				.then(() => false),
			prompt
				.waitFor({ state: "visible", timeout: TIMEOUTS.close })
				.then(() => true),
		]);
		if (prompted)
			return `saved; ${await skipSavedPrompt(prompt)}; ${quiet.says}`;
		// LinkedIn can mount the prompt a beat after the editor goes: catch it, or the next field opens onto it
		const late = await prompt
			.waitFor({ state: "visible", timeout: TIMEOUTS.latePrompt })
			.then(
				() => true,
				() => false,
			);
		if (late) return `saved; ${await skipSavedPrompt(prompt)}; ${quiet.says}`;
		return `saved; dialog closed; ${quiet.says}`;
	} catch (err) {
		if (page.isClosed())
			return "saved; the page closed after Save (the export decides)";
		const says = (await dialog.innerText().catch(() => ""))
			.replace(/\s+/gu, " ")
			.slice(0, 300);
		throw new Refused(
			`Save left the dialog open (LinkedIn's validation keeps it up): ${says || (err as Error).message}`,
			{
				cause: err,
			},
		);
	}
}

export interface Filled {
	results: { control: string; want: string; got: string; ok: boolean }[];
	outcome: string;
	/** Whether a save would go (or went) through: every control as the record, and the share switch off. */
	ok: boolean;
}

/** Fill an open editor from its plan, read it back, then save, discard, or (probe) describe it. */
export async function runEditor(
	page: Page,
	ed: Editor,
	mode: Mode,
): Promise<Filled> {
	// A probe only reads the dialog, so it also describes one whose identity check fails.
	const dialog = await openDialog(page, ed, mode !== "probe");
	if (mode === "probe") {
		const snapshot = await dialog.ariaSnapshot();
		await discard(page, dialog);
		return { results: [], ok: true, outcome: snapshot };
	}
	const steps = mode === "noop" ? [] : ed.steps;
	const located: [Step, Locator][] = [];
	for (const st of steps) {
		// Located one at a time: a control an earlier step reveals (an end date
		// under an unticked "currently" box) is waited for when its turn comes.
		const loc = await control(dialog, st.control);
		await fill(page, loc, st);
		located.push([st, loc]);
	}
	const readAll = () =>
		Promise.all(
			located.map(async ([st, loc]) => {
				const got = await read(loc, st.kind).catch(
					(e: Error) => `unreadable: ${e.message.split("\n")[0]}`,
				);
				return {
					control: name(st.control),
					want: String(wanted(st)),
					got: String(got).slice(0, 80),
					ok: matches(st, got),
				};
			}),
		);
	// The editor applies input on its own schedule: wait until it all reads back, or 2.5s.
	await expect
		.poll(async () => (await readAll()).every((r) => r.ok), { timeout: 2500 })
		.toBe(true)
		.catch(() => undefined);
	const results = await readAll();
	// A dry run reports what the real run would refuse, with its read-back, then discards.
	if (mode === "dry") {
		const quiet = await quietness(dialog, ed.notify);
		const readBack = results.every((r) => r.ok);
		const why = [
			readBack ? "" : "the editor does not read back as the record",
			quiet.ok ? "" : quiet.says,
		].filter(Boolean);
		const closed = await discard(page, dialog).then(
			() => "discarded",
			(e: Error) => `could not be closed (${e.message.split("\n")[0]})`,
		);
		return {
			results,
			ok: !why.length,
			outcome: `${closed} (${why.length ? `a real run would refuse: ${why.join("; ")}` : quiet.says})`,
		};
	}
	if (!results.every((r) => r.ok))
		await refuse(
			page,
			dialog,
			"the editor does not read back as the record; not saving",
		);
	return { results, ok: true, outcome: await save(page, dialog, ed.notify) };
}

/** Delete the open editor's entry. A dry run stops at the confirmation and cancels it. */
export async function runDelete(
	page: Page,
	ed: Editor,
	button: string,
	dryRun: boolean,
): Promise<string> {
	const editor = await openDialog(page, ed);
	const del = editor.getByRole("button", { name: button, exact: true });
	if ((await del.count()) !== 1)
		throw new Refused(
			`expected one "${button}" button, found ${await del.count()}`,
		);
	await del.click();
	// The confirmation is a dialog of its own, without the entry's delete button.
	const confirm = page
		.getByRole("dialog")
		.filter({ hasNot: page.getByRole("button", { name: button, exact: true }) })
		.last();
	const yes = confirm
		.getByRole("button", { name: /^delete$/iu })
		.filter({ visible: true })
		.first();
	await yes
		.waitFor({ state: "visible", timeout: TIMEOUTS.confirm })
		.catch(() => {
			throw new Refused(
				`no confirmation appeared after "${button}"; the press may have deleted outright, so nothing more was clicked. Re-export before anything else.`,
			);
		});
	if (dryRun) {
		const cancel = confirm
			.getByRole("button", { name: /^(no thanks|cancel|dismiss)$/iu })
			.first();
		if (!(await cancel.count()))
			throw new Refused("the confirmation offers no Cancel; left open");
		await cancel.click();
		return "would delete (confirmation offers Delete); cancelled";
	}
	await yes.click();
	await editor.waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {
		throw new Refused(
			"the editor stayed open after confirming; re-export to see what happened",
		);
	});
	return "deleted";
}

/**
 * Add one skill from the standalone "Add skill" form. The typed name must
 * come back as an exact (case-insensitive) suggestion: a skill is a LinkedIn
 * entity, not free text. Returns the name LinkedIn picked.
 */
export async function runAddSkill(
	page: Page,
	skill: string,
	dryRun: boolean,
): Promise<string> {
	const dialog = page.getByRole("dialog").first();
	await dialog.waitFor({ state: "visible", timeout: 15_000 });
	const box = dialog.getByLabel(/^Skill\*?$/iu).first();
	// Typed key by key, this typeahead drops keystrokes while it re-renders
	// ("Mae Learning", 2026-10-29): fill all but the last character, type that one.
	await box.fill(skill.slice(0, -1));
	await box.pressSequentially(skill.slice(-1), { delay: 100 });
	if ((await box.inputValue()) !== skill) {
		await discard(page, dialog);
		throw new Refused(
			`the box reads ${JSON.stringify(await box.inputValue())}, not ${JSON.stringify(skill)}`,
		);
	}
	const option = page
		.getByRole("option")
		.filter({ hasText: new RegExp(`^\\s*${escapeRe(skill)}\\s*$`, "iu") })
		.first();
	if (
		!(await option.waitFor({ state: "visible", timeout: 4000 }).then(
			() => true,
			() => false,
		))
	) {
		const seen = (await page.getByRole("option").allTextContents())
			.map((t) => t.trim())
			.slice(0, 10);
		await discard(page, dialog);
		throw new Refused(
			`no exact suggestion for ${JSON.stringify(skill)} (offered ${JSON.stringify(seen)})`,
		);
	}
	await option.click();
	const picked = await expect
		.poll(async () => (await box.inputValue()).trim(), { timeout: 2000 })
		.toMatch(new RegExp(`^${escapeRe(skill)}$`, "iu"))
		.then(
			() => box.inputValue(),
			() => undefined,
		);
	if (picked === undefined)
		await refuse(
			page,
			dialog,
			`picking ${JSON.stringify(skill)} put something else in the box`,
		);
	if (dryRun) {
		// As the real add would: with the switch on, it refuses.
		await assertQuiet(page, dialog, "if-present");
		await discard(page, dialog);
		return (picked ?? "").trim();
	}
	await save(page, dialog);
	return (picked ?? "").trim();
}

/** The open project editor, checked by its name. */
function projectEditor(page: Page, title: string): Promise<Locator> {
	return openDialog(page, {
		path: "",
		creating: false,
		heading: /project/iu,
		identity: [{ control: { label: /^Project name\*?$/iu }, value: title }],
		steps: [],
		notify: "if-present",
	});
}

/** The media flows can save the project before its own Save: check its share switch before any click. */
async function assertProjectQuiet(page: Page, editor: Locator): Promise<void> {
	await assertQuiet(page, editor, "if-present");
}

/** Close every open dialog unsaved. */
async function discardAll(page: Page): Promise<void> {
	for (let i = 0; i < 3 && (await page.getByRole("dialog").count()); i++)
		await discard(page, page.getByRole("dialog").last()).catch(() => undefined);
}

/** Clear the legacy "Project URL" field if it holds this link and moveLegacy says so; refuse if it holds anything else. */
async function clearLegacyUrl(
	page: Page,
	editor: Locator,
	url: string,
	moveLegacy: boolean,
): Promise<string> {
	const legacy = editor.getByLabel(/^Project URL$/iu).first();
	const held = (await legacy.count()) ? (await legacy.inputValue()).trim() : "";
	if (!held) return "";
	if (!(moveLegacy && sameLink(held, url))) {
		await discardAll(page);
		throw new Refused(
			sameLink(held, url)
				? `${url} is in the legacy "Project URL" field, not media; --move-legacy-url clears that field and adds it as media`
				: `the legacy "Project URL" field holds ${held}; set that one link by hand`,
		);
	}
	await legacy.fill("");
	if ((await legacy.inputValue()) !== "") {
		await discardAll(page);
		throw new Refused('the legacy "Project URL" field would not clear');
	}
	return 'clear the legacy "Project URL" and ';
}

/**
 * Attach a link to the open project as media: Add media, Add a link, paste.
 * Past "Add" LinkedIn fetches a preview and shows its own form, so a real run
 * goes on only if that form has exactly one visible Save or Apply; anything
 * else is discarded. A dry run stops before "Add".
 *
 * An older project can still have the legacy "Project URL" field, which is
 * not media. With moveLegacy, a field holding this same link is cleared in
 * the same save, so the link moves to media instead of showing twice; a field
 * holding another link is refused either way.
 */
export async function runAddLink(
	page: Page,
	title: string,
	url: string,
	opts: { dryRun: boolean; moveLegacy?: boolean },
): Promise<string> {
	const { dryRun, moveLegacy = false } = opts;
	const editor = await projectEditor(page, title);
	await assertProjectQuiet(page, editor);
	const moved = await clearLegacyUrl(page, editor, url, moveLegacy);
	await editor
		.getByRole("button", { name: /^add media$/iu })
		.first()
		.click();
	await page
		.getByRole("menuitem", { name: /add a link/iu })
		.first()
		.click();
	const panel = page.getByRole("dialog").last();
	const box = panel.getByLabel(/paste or type a link/iu).first();
	await box.fill(url);
	if (dryRun || (await box.inputValue()) !== url) {
		const typed = await box.inputValue();
		await discardAll(page);
		if (typed !== url)
			throw new Refused(`the link box reads ${JSON.stringify(typed)}`);
		return `would ${moved}add (stopped before Add, where LinkedIn fetches the preview); discarded`;
	}
	await panel.getByRole("button", { name: /^add$/iu }).first().click();
	const form = page.getByRole("dialog").last();
	const confirm = form
		.getByRole("button", { name: /^(save|apply)$/iu })
		.filter({ visible: true });
	await confirm
		.first()
		.waitFor({ state: "visible", timeout: 10_000 })
		.catch(() => undefined);
	if ((await confirm.count()) !== 1) {
		await discardAll(page);
		throw new Refused(
			`after Add, the media form shows ${await confirm.count()} Save/Apply buttons (expected one); discarded`,
		);
	}
	const formQuiet = await quietness(form, "if-present");
	if (!formQuiet.ok) {
		await discardAll(page);
		const left = await page.getByRole("dialog").count();
		throw new Refused(
			`${formQuiet.says}${left ? `; ${left} dialog(s) could not be closed` : ""}`,
		);
	}
	await confirm.click();
	const projectSave = page
		.getByRole("dialog")
		.first()
		.getByRole("button", { name: "Save", exact: true });
	await projectSave
		.waitFor({ state: "visible", timeout: 10_000 })
		.catch(async () => {
			await discardAll(page);
			throw new Refused(
				"the project editor did not come back with one Save; the media Save may have saved it, so re-export before retrying",
			);
		});
	return save(page, page.getByRole("dialog").first());
}

/** The media item a removal means, as the mirror lists it (see pickMedia). */
export interface MediaTarget {
	title: string;
	/** Its place among the items with this title, in the editor's order. */
	nth: number;
	/** How many items have this title. */
	of: number;
	kind: string;
	description?: string | undefined;
}

const MEDIA_PREFIX = "Edit media, ";

/** A link preview's thumbnail is LinkedIn's "articleshare" image; an upload's is not. */
function thumbKind(src: string | null | undefined): string {
	if (!src) return "no thumbnail";
	return src.includes("/articleshare-") ? "LINK" : "upload";
}

/** Whether a condition comes true within the timeout. */
async function until(
	cond: () => Promise<boolean>,
	timeout: number,
): Promise<boolean> {
	const end = Date.now() + timeout;
	for (;;) {
		if (await cond().catch(() => false)) return true;
		if (Date.now() > end) return false;
		await new Promise((r) => setTimeout(r, 200));
	}
}

/** Whether a check passes within its timeout, without throwing. */
const passes = (check: Promise<unknown>) =>
	check.then(
		() => true,
		() => false,
	);

/** The project editor's media items: each is a link whose text is "Edit media, <title>". */
function mediaItems(dialog: Locator) {
	const items = dialog.locator("a").filter({ hasText: /^\s*Edit media, /u });
	const titles = () =>
		items.evaluateAll((as) =>
			as.map((a) => ({
				text: (a.textContent ?? "").replace(/\s+/gu, " ").trim(),
				src: a.querySelector("img")?.getAttribute("src") ?? null,
			})),
		);
	return { items, titles };
}

/** Which of the editor's items is the target: its place among those with its title, checked by thumbnail where titles collide. */
async function findMedia(
	project: Locator,
	target: MediaTarget,
): Promise<{ at: number; thumb: string } | string> {
	const { items, titles } = mediaItems(project);
	await items
		.first()
		.waitFor({ state: "attached", timeout: 8000 })
		.catch(() => undefined);
	const listed = await titles();
	const want = `${MEDIA_PREFIX}${target.title}`;
	const same = listed.flatMap((x, i) => (x.text === want ? [i] : []));
	if (same.length !== target.of)
		return `the editor shows ${same.length} media items titled ${JSON.stringify(target.title)}, the mirror ${target.of} (of ${listed.length} items); re-export`;
	const at = same[target.nth];
	if (at === undefined) return "no such media item";
	const thumb = thumbKind(listed[at]?.src);
	// One item of that title: the title is the proof. Several: the thumbnail must agree too.
	const expected = target.kind === "LINK" ? "LINK" : "upload";
	if (target.of > 1 && thumb !== expected)
		return `item ${target.nth + 1} of ${target.of} titled ${JSON.stringify(target.title)} has a ${thumb} thumbnail, not a ${target.kind}'s`;
	return { at, thumb };
}

/** How a dry run names the item it would delete. */
function describeMedia(t: MediaTarget, thumb: string): string {
	const base = `${t.kind} ${JSON.stringify(t.title)}`;
	if (t.of < 2) return base;
	const desc = t.description
		? `, description ${JSON.stringify(t.description)}`
		: "";
	return `${base} (item ${t.nth + 1} of ${t.of} with that title, ${thumb} thumbnail${desc})`;
}

/**
 * Remove one media item from the open project. Each item is a link
 * "Edit media, <title>" that turns the dialog into an "Edit media" view with
 * Delete. Titles are matched here, not in a selector: a quote in a title
 * broke Playwright's text selector (it found 0 of 2 items). Where titles
 * collide, the item is the target's place among them, checked against its
 * thumbnail (a link preview or an upload) and its description. Delete asks
 * "Delete this media?" in a second dialog; a real run confirms it, waits for
 * the project view to come back one item shorter, and saves it. Anything else
 * is discarded.
 */
export async function runRemoveMedia(
	page: Page,
	title: string,
	target: MediaTarget,
	dryRun: boolean,
): Promise<string> {
	const project = await projectEditor(page, title);
	await assertProjectQuiet(page, project);
	const fail = async (says: string): Promise<never> => {
		await discardAll(page);
		throw new Refused(`${says}; discarded`);
	};
	const found = await findMedia(project, target);
	if (typeof found === "string") return fail(found);
	await mediaItems(project).items.nth(found.at).click();
	const view = page
		.getByRole("dialog")
		.filter({ has: page.getByRole("heading", { name: /^Edit media$/u }) });
	if (!(await passes(view.waitFor({ timeout: TIMEOUTS.open }))))
		return fail("no Edit media view opened");
	const holds = (label: RegExp, value: string) =>
		passes(
			expect(view.getByRole("textbox", { name: label }).first()).toHaveValue(
				value,
				{ timeout: TIMEOUTS.control },
			),
		);
	if (!(await holds(/^Title\*?$/u, target.title)))
		return fail(`the media editor is not for ${JSON.stringify(target.title)}`);
	if (
		target.of > 1 &&
		!(await holds(/^Description$/u, target.description ?? ""))
	)
		return fail(
			`the media editor's description is not ${JSON.stringify(target.description ?? "")}: the wrong item`,
		);
	const del = view
		.getByRole("button", { name: /^delete$/iu })
		.filter({ visible: true });
	const n = await del.count();
	if (n !== 1)
		return fail(`the media editor shows ${n} Delete buttons (expected one)`);
	if (dryRun) {
		await discardAll(page);
		return `would delete ${describeMedia(target, found.thumb)}; discarded`;
	}
	await del.click();
	await confirmMediaDelete(page, view, fail);
	const left = () =>
		mediaItems(project)
			.titles()
			.then(
				(xs) =>
					xs.filter((x) => x.text === `${MEDIA_PREFIX}${target.title}`).length,
			);
	if (
		!(await until(async () => (await left()) === target.of - 1, TIMEOUTS.close))
	)
		return fail(
			"the item is still on the project after Delete. Delete may have saved it: re-export before retrying",
		);
	return save(page, project);
}

/**
 * After Delete: LinkedIn asks "Delete this media?" in a second, native
 * <dialog> (no role attribute: the old [role=dialog] match missed it, took the
 * Edit media view's Save for the project's, and timed out on a Save the
 * confirmation covered). The confirmation is the dialog with a Delete and no
 * text box, which the Edit media view and the project both have. Confirm it,
 * then wait for the project view to be back with nothing on top.
 */
async function confirmMediaDelete(
	page: Page,
	view: Locator,
	fail: (says: string) => Promise<never>,
): Promise<void> {
	const confirm = page
		.getByRole("dialog")
		.or(page.getByRole("alertdialog"))
		.filter({ hasNot: page.getByRole("textbox") })
		.getByRole("button", { name: /^delete$/iu })
		.filter({ visible: true });
	const back = page
		.getByRole("dialog")
		.filter({ has: page.getByLabel(/^Project name\*?$/iu) });
	if (
		!(await passes(
			confirm.or(back).first().waitFor({ timeout: TIMEOUTS.close }),
		))
	)
		await fail("after Delete, neither a confirmation nor the project came up");
	const asks = await confirm.count();
	if (asks > 1) await fail(`the confirmation shows ${asks} Delete buttons`);
	if (asks === 1) await confirm.click();
	const alone = async () =>
		(await back.isVisible()) &&
		(await view.count()) === 0 &&
		(await confirm.count()) === 0;
	if (!(await until(alone, TIMEOUTS.close)))
		await fail(
			"the project editor did not come back alone after Delete. Delete may have saved it: re-export before retrying",
		);
}
