// Drive one LinkedIn edit dialog with Playwright: check it is the right
// entry's editor, fill it, read every control back, and save or discard.
// Writes go through the dialog, never a replayed request: LinkedIn's write
// path changes every deploy, and the dialog runs its own validation and has
// the "share with your network" switch a replayed write would not.
//
// Every refusal here happens before Save. After Save, the only proof is a
// re-export and drift; a dialog that closed is not the proof.

import { expect, type Locator, type Page } from "@playwright/test";
import { type Control, type Editor, escapeRe, type Step } from "./fields.ts";

export type Mode = "save" | "dry" | "noop" | "probe";

/** How long each wait may take on LinkedIn; the dialog tests shorten them. */
export const TIMEOUTS = {
	open: 15_000,
	heading: 5000,
	control: 3000,
	settle: 2500,
	close: 20_000,
	confirm: 6000,
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

/** Refuse while "Share with your network" is on. LinkedIn renders one switch as two elements; every one must be off. */
async function assertQuiet(dialog: Locator, ed: Editor): Promise<string> {
	const switches = await dialog.getByRole("switch").all();
	if (!switches.length && ed.notify === "required")
		throw new Refused(
			'no "Share with your network" switch in this editor; it changed shape, not saving',
		);
	for (const sw of switches)
		if (await sw.isChecked())
			throw new Refused(
				'"Share with your network" is ON in this editor; not saving. Turn it off by hand first.',
			);
	return switches.length ? "share-with-network off" : "no share switch";
}

/** Click Save and wait for the editor to close. Under headless the page can close on Save while the write lands; the export decides. */
async function save(page: Page, dialog: Locator): Promise<string> {
	// Every Save, whichever flow led here: never with the share switch on.
	for (const sw of await dialog.getByRole("switch").all())
		if (await sw.isChecked())
			throw new Refused(
				'"Share with your network" is ON in this editor; not saving. Turn it off by hand first.',
			);
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	try {
		await dialog.waitFor({ state: "hidden", timeout: TIMEOUTS.close });
		return "saved; dialog closed";
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
		return { results: [], outcome: snapshot };
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
	if (mode === "dry") {
		const quiet = await assertQuiet(dialog, ed).catch((e: Error) => e.message);
		await discard(page, dialog);
		return { results, outcome: `discarded (${quiet})` };
	}
	if (!results.every((r) => r.ok))
		throw new Refused(
			"the editor does not read back as the record; not saving",
		);
	const quiet = await assertQuiet(dialog, ed);
	return { results, outcome: `${await save(page, dialog)}; ${quiet}` };
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
	if (dryRun || picked === undefined) {
		await discard(page, dialog);
		if (picked === undefined)
			throw new Refused(
				`picking ${JSON.stringify(skill)} put something else in the box`,
			);
		return picked.trim();
	}
	await save(page, dialog);
	return picked.trim();
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

/** Close every open dialog unsaved. */
async function discardAll(page: Page): Promise<void> {
	for (let i = 0; i < 3 && (await page.getByRole("dialog").count()); i++)
		await discard(page, page.getByRole("dialog").last()).catch(() => undefined);
}

/**
 * Attach a link to the open project as media: Add media, Add a link, paste.
 * Past "Add" LinkedIn fetches a preview and shows its own form, so a real run
 * goes on only if that form has exactly one visible Save or Apply; anything
 * else is discarded. A dry run stops before "Add".
 */
export async function runAddLink(
	page: Page,
	title: string,
	url: string,
	dryRun: boolean,
): Promise<string> {
	const editor = await projectEditor(page, title);
	if (await editor.getByLabel(/^Project URL$/iu).count()) {
		await discardAll(page);
		throw new Refused(
			'this project still has the legacy "Project URL" field; set that one link by hand',
		);
	}
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
		return "would add (stopped before Add, where LinkedIn fetches the preview); discarded";
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

/**
 * Remove one media item, by title, from the open project. Each item is a link
 * "Edit media, <title>" that opens an "Edit media" dialog with Delete. A real
 * run accepts an optional confirmation with one Delete, then the project
 * editor back without the item, and saves it; anything else is discarded.
 */
export async function runRemoveMedia(
	page: Page,
	title: string,
	media: string,
	dryRun: boolean,
): Promise<string> {
	await projectEditor(page, title);
	const item = page
		.getByRole("dialog")
		.locator("a")
		.filter({
			hasText: new RegExp(`^\\s*Edit media, ${escapeRe(media)}\\s*$`, "u"),
		});
	await item
		.first()
		.waitFor({ state: "attached", timeout: 8000 })
		.catch(() => undefined);
	if ((await item.count()) !== 1) {
		await discardAll(page);
		throw new Refused(
			`${await item.count()} media items titled ${JSON.stringify(media)} on this project (expected one)`,
		);
	}
	await item.click();
	const mediaDialog = page
		.getByRole("dialog")
		.filter({ has: page.getByRole("heading", { name: /^Edit media$/u }) });
	const del = mediaDialog
		.getByRole("button", { name: /^delete$/iu })
		.filter({ visible: true });
	await expect(
		mediaDialog.locator("input:not([type=hidden]), textarea").first(),
	)
		.toHaveValue(media, { timeout: 3000 })
		.catch(async () => {
			await discardAll(page);
			throw new Refused(
				`the media editor is not for ${JSON.stringify(media)}; discarded`,
			);
		});
	if ((await del.count()) !== 1 || dryRun) {
		const n = await del.count();
		await discardAll(page);
		if (n !== 1)
			throw new Refused(
				`the media editor shows ${n} Delete buttons (expected one); discarded`,
			);
		return "would delete the media item; discarded";
	}
	await del.click();
	// Either a confirmation with its own Delete, or straight back to the project.
	const confirm = page
		.locator('[role="dialog"], [role="alertdialog"]')
		.filter({ hasNot: page.getByRole("heading", { name: /^Edit media$/u }) })
		.getByRole("button", { name: /^delete$/iu })
		.filter({ visible: true });
	await confirm
		.or(
			page
				.getByRole("dialog")
				.first()
				.getByRole("button", { name: "Save", exact: true }),
		)
		.first()
		.waitFor({ timeout: 10_000 });
	if ((await confirm.count()) === 1) await confirm.click();
	await expect(item)
		.toHaveCount(0, { timeout: 10_000 })
		.catch(async () => {
			await discardAll(page);
			throw new Refused(
				"the item is still on the project after Delete; discarded unsaved. Delete may have saved it: re-export before retrying",
			);
		});
	return save(page, page.getByRole("dialog").first());
}
