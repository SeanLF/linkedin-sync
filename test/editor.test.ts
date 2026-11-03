// The editor runner against local copies of LinkedIn's edit dialogs: the
// shapes the probes recorded (labelled controls, a placeholder option, a
// "currently" box that reveals the end date a beat later, the share switch
// rendered twice, a Discard prompt, a separate delete confirmation).

import { readFileSync } from "node:fs";
import { expect, test as it, type Page } from "@playwright/test";
import {
	Refused,
	runAddLink,
	runAddSkill,
	runDelete,
	runEditor,
	runRemoveMedia,
	TIMEOUTS,
} from "../src/editor.ts";
import type { Editor } from "../src/fields.ts";

interface Shape {
	heading?: string;
	title?: string;
	shareOn?: boolean;
	noSwitch?: boolean;
	shouting?: boolean;
	invalid?: boolean;
	confirm?: boolean;
	/** After Save, LinkedIn's "Your experience is saved" dialog, as captured from a live save. */
	prompt?: boolean;
	/** Mount the prompt this many ms after the editor goes, as LinkedIn can. */
	promptDelayMs?: number;
	/** LinkedIn's docked Messaging conversation, a role=dialog of its own that stays open after the editor goes. */
	messaging?: boolean;
}

// Captured from a Playwright trace of a live position save (2026-11-21): hashed
// classes, icons and images stripped, the suggested people replaced by made-up
// ones; LinkedIn's structure, roles, labels and text are as served.
const savedPrompt = readFileSync(
	new URL("fixtures/post-save-connect-dialog.html", import.meta.url),
	"utf8",
);

// Captured from the Playwright traces of eight live saves (2026-11-21) that
// reported "left the dialog open" yet landed: the dialog still open was this
// docked conversation, not the editor. Trimmed to one message; the people and
// the message are made up.
const messagingOverlay = readFileSync(
	new URL("fixtures/messaging-overlay.html", import.meta.url),
	"utf8",
);

/** One edit dialog; window.saved holds what Save submitted, window.deleted whether the entry went, window.invited whether a Connect was pressed. */
function dialog(page: Page, shape: Shape = {}) {
	const {
		heading = "Edit role",
		title = "Engineer",
		shareOn = false,
		noSwitch = false,
	} = shape;
	const sw = (id: string) =>
		`<span role="switch" id="${id}" aria-checked="${shareOn}" aria-label="Turn on to notify your network"></span>`;
	return page.setContent(`<!doctype html><meta charset="utf-8">
<div role="dialog" id="ed"><h2>${heading}</h2>
	<button aria-label="Dismiss" id="dismiss">x</button>
	${noSwitch ? "" : sw("s1") + sw("s2")}
	<label for="t">Job title*</label><input id="t" value="${title}">
	<label for="c">Company or organization*</label><input id="c" value="Acme Corp">
	<input type="checkbox" id="cur" checked><label for="cur">I am currently working in this role</label>
	<label for="sm">Start month</label><select id="sm"><option>Month</option><option>January</option><option>March</option></select>
	<label for="sy">Start year*</label><select id="sy"><option>Year</option><option>2020</option><option>2021</option></select>
	<div id="end"></div>
	<div contenteditable="true" id="d">Old text.</div>
	<button id="del">Delete role</button><button id="save">Save</button>
</div>
${shape.messaging ? messagingOverlay : ""}
<template id="prompt">${shape.prompt ? savedPrompt : ""}</template>
<script>
	window.saved = null; window.deleted = false; window.invited = false; window.chatted = false;
	document.querySelector('[aria-label="Messaging"]')?.addEventListener("click", () => { window.chatted = true; });
	const ed = document.getElementById("ed");
	const end = document.getElementById("end");
	// Unticking "currently" renders the end selects 300ms later.
	document.getElementById("cur").onchange = (e) => setTimeout(() => {
		end.innerHTML = e.target.checked ? "" :
			'<label for="em">End month</label><select id="em"><option>Month</option><option>June</option></select>' +
			'<label for="ey">End year*</label><select id="ey"><option>Year</option><option>2023</option></select>';
	}, 300);
	${shape.shouting ? 'document.getElementById("c").oninput = (e) => { e.target.value = e.target.value.toUpperCase(); };' : ""}
	document.getElementById("save").onclick = () => {
		if (${Boolean(shape.invalid)}) return;
		window.saved = { title: t.value, company: c.value, current: cur.checked, description: d.innerText };
		ed.remove();
		const shown = document.getElementById("prompt").content.firstElementChild;
		if (!shown) return;
		setTimeout(() => {
			document.body.append(shown);
			shown.showModal();
			for (const b of shown.querySelectorAll("button"))
				b.onclick = /^Invite /.test(b.getAttribute("aria-label") ?? "")
					? () => { window.invited = true; }
					: () => shown.close();
		}, ${shape.promptDelayMs ?? 0});
	};
	document.getElementById("dismiss").onclick = () => {
		const p = document.createElement("div");
		p.setAttribute("role", "alertdialog");
		p.innerHTML = "<button>Discard</button>";
		p.querySelector("button").onclick = () => { p.remove(); ed.remove(); };
		document.body.append(p);
	};
	document.getElementById("del").onclick = () => {
		if (!${shape.confirm ?? true}) { window.deleted = true; ed.remove(); return; }
		const q = document.createElement("div");
		q.setAttribute("role", "dialog");
		q.innerHTML = "<h2>Delete role?</h2><button id=yes>Delete</button><button id=no>Cancel</button>";
		q.querySelector("#yes").onclick = () => { window.deleted = true; q.remove(); ed.remove(); };
		q.querySelector("#no").onclick = () => q.remove();
		document.body.append(q);
	};
</script>`);
}

// Local pages answer at once; a refusal should not wait out LinkedIn's patience.
Object.assign(TIMEOUTS, {
	open: 2000,
	heading: 1000,
	close: 1000,
	confirm: 1000,
});

const role = (over: Partial<Editor> = {}): Editor => ({
	path: "",
	creating: false,
	heading: /^Edit role$/iu,
	identity: [{ control: { label: /^Job title\*?$/iu }, value: "Engineer" }],
	steps: [
		{
			kind: "text",
			control: { label: /^Company or organization/iu },
			value: "Globex",
		},
		{
			kind: "text",
			control: { css: '[contenteditable="true"]' },
			value: "New text.",
		},
		{
			kind: "check",
			control: { label: /^I am currently working in this role$/iu },
			value: false,
		},
		{ kind: "select", control: { label: /^Start month$/iu }, option: "March" },
		{ kind: "select", control: { label: /^Start year/iu }, option: "2020" },
		{ kind: "select", control: { label: /^End month$/iu }, option: "June" },
		{ kind: "select", control: { label: /^End year/iu }, option: "2023" },
	],
	notify: "required",
	...over,
});
const saved = (page: Page) =>
	page.evaluate(() => (globalThis as unknown as { saved: unknown }).saved);
const deleted = (page: Page) =>
	page.evaluate(() => (globalThis as unknown as { deleted: boolean }).deleted);

it("fills, waits for the end date the box reveals, reads back, saves", async ({
	page,
}) => {
	await dialog(page);
	const out = await runEditor(page, role(), "save");
	expect(out.results.every((r) => r.ok)).toBe(true);
	expect(await saved(page)).toEqual({
		title: "Engineer",
		company: "Globex",
		current: false,
		description: "New text.",
	});
});

it('a save LinkedIn answers with its "experience is saved" dialog is a save: skipped, no Connect pressed', async ({
	page,
}) => {
	await dialog(page, { prompt: true });
	const out = await runEditor(page, role(), "save");
	expect(out.ok).toBe(true);
	expect(out.outcome).toMatch(/^saved; LinkedIn's "saved" prompt skipped;/u);
	expect(await saved(page)).toMatchObject({ company: "Globex" });
	expect(
		await page.evaluate(
			() => (globalThis as unknown as { invited: boolean }).invited,
		),
	).toBe(false);
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

it("a saved prompt that mounts after the editor has closed is still skipped", async ({
	page,
}) => {
	await dialog(page, { prompt: true, promptDelayMs: 500 });
	const out = await runEditor(page, role(), "save");
	expect(out.ok).toBe(true);
	expect(out.outcome).toMatch(/^saved; LinkedIn's "saved" prompt skipped;/u);
	expect(
		await page.evaluate(
			() => (globalThis as unknown as { invited: boolean }).invited,
		),
	).toBe(false);
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

it("a save that leaves LinkedIn's Messaging conversation open is a save: the conversation untouched", async ({
	page,
}) => {
	await dialog(page, { messaging: true });
	const out = await runEditor(page, role(), "save");
	expect(out.ok).toBe(true);
	expect(out.outcome).toMatch(/^saved; dialog closed;/u);
	expect(await saved(page)).toMatchObject({ company: "Globex" });
	expect(
		await page.evaluate(
			() => (globalThis as unknown as { chatted: boolean }).chatted,
		),
	).toBe(false);
	await expect(page.getByRole("heading", { name: /^Edit role$/u })).toHaveCount(
		0,
	);
	await expect(page.getByRole("dialog", { name: "Messaging" })).toBeVisible();
});

it("a dry run fills, answers the Discard prompt, and saves nothing", async ({
	page,
}) => {
	await dialog(page);
	const out = await runEditor(page, role(), "dry");
	expect(out.outcome).toMatch(/^discarded/u);
	expect(await saved(page)).toBeNull();
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

it("--noop re-saves what is there", async ({ page }) => {
	await dialog(page);
	await runEditor(page, role(), "noop");
	expect(await saved(page)).toMatchObject({
		company: "Acme Corp",
		description: "Old text.",
	});
});

for (const [why, shape, over, message] of [
	["another entry's editor", { title: "Manager" }, {}, /the wrong entry/u],
	[
		"another kind of dialog",
		{ heading: "Edit education" },
		{},
		/not \/\^Edit role\$/u,
	],
	["share-with-network on", { shareOn: true }, {}, /is ON/u],
	[
		"no share switch where one is required",
		{ noSwitch: true },
		{},
		/no "Share with your network" switch/u,
	],
	[
		"a control that reads back differently",
		{ shouting: true },
		{},
		/does not read back/u,
	],
	[
		"a control that is not there",
		{},
		{ steps: [{ kind: "text", control: { label: /^Nope$/u }, value: "x" }] },
		/no control/u,
	],
	[
		"an option the select does not offer",
		{},
		{
			steps: [
				{ kind: "select", control: { label: /^Start year/iu }, option: "1999" },
			],
		},
		/no option/u,
	],
	[
		"a Save that LinkedIn's validation keeps open",
		{ invalid: true },
		{},
		/left the dialog open/u,
	],
	[
		"a Save that validation keeps open, with the Messaging conversation open too",
		{ invalid: true, messaging: true },
		{},
		/left the dialog open \(LinkedIn's validation keeps it up\): Edit role/u,
	],
] as [string, Shape, Partial<Editor>, RegExp][])
	it(`refuses ${why}`, async ({ page }) => {
		await dialog(page, shape);
		const run = runEditor(page, role(over), "save");
		await expect(run).rejects.toThrow(message);
		await expect(run).rejects.toBeInstanceOf(Refused);
		expect(await saved(page)).toBeNull();
	});

it("delete: a dry run stops at the confirmation and cancels", async ({
	page,
}) => {
	await dialog(page);
	expect(await runDelete(page, role(), "Delete role", true)).toMatch(
		/cancelled/u,
	);
	expect(await deleted(page)).toBe(false);
});

it("delete: confirms, and the editor closes", async ({ page }) => {
	await dialog(page);
	expect(await runDelete(page, role(), "Delete role", false)).toBe("deleted");
	expect(await deleted(page)).toBe(true);
});

it("delete: no confirmation means stop, click nothing more", async ({
	page,
}) => {
	await dialog(page, { confirm: false });
	await expect(runDelete(page, role(), "Delete role", true)).rejects.toThrow(
		/no confirmation/u,
	);
});

it("delete: refuses another entry's editor before pressing anything", async ({
	page,
}) => {
	await dialog(page, { title: "Manager" });
	await expect(runDelete(page, role(), "Delete role", false)).rejects.toThrow(
		/the wrong entry/u,
	);
	expect(await deleted(page)).toBe(false);
});

it("adding a skill refuses to save with the share switch on", async ({
	page,
}) => {
	await page.setContent(`<!doctype html><meta charset="utf-8">
<div role="dialog" id="ed"><h2>Add skill</h2>
	<span role="switch" aria-checked="true" aria-label="Notify network"></span>
	<label for="k">Skill*</label><input id="k">
	<ul role="listbox" id="opts"></ul>
	<button aria-label="Dismiss" onclick="ed.remove()">x</button><button id="save">Save</button>
</div>
<script>
	window.saved = null;
	k.oninput = () => {
		opts.innerHTML = k.value === "Rust" ? '<li role="option" id="o">Rust</li>' : "";
		const o = document.getElementById("o");
		if (o) o.onclick = () => { k.value = "Rust"; };
	};
	save.onclick = () => { window.saved = k.value; ed.remove(); };
</script>`);
	await expect(runAddSkill(page, "Rust", false)).rejects.toThrow(/is ON/u);
	expect(await saved(page)).toBeNull();
	await expect(page.getByRole("dialog")).toHaveCount(0); // closed, not left in the next step's way
});

it("a dry run reports what the real run would refuse, with its read-back", async ({
	page,
}) => {
	await dialog(page, { shareOn: true });
	const out = await runEditor(page, role(), "dry");
	expect(out.ok).toBe(false); // the real run would refuse
	expect(out.outcome).toMatch(/would refuse: .*is ON/u);
	expect(out.results.every((r) => r.ok)).toBe(true); // and the read-back is still shown
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

it("removing media checks the project's share switch before any click", async ({
	page,
}) => {
	await page.setContent(`<!doctype html><meta charset="utf-8">
<div role="dialog" id="ed"><h2>Edit project</h2>
	<span role="switch" aria-checked="true" aria-label="Notify network"></span>
	<label for="n">Project name*</label><input id="n" value="Widget">
	<a href="#" id="m" onclick="window.clicked = true">Edit media, Repo</a>
	<button aria-label="Dismiss" onclick="ed.remove()">x</button><button>Save</button>
</div>
<script>window.clicked = false;</script>`);
	await expect(
		runRemoveMedia(
			page,
			"Widget",
			{ title: "Repo", nth: 0, of: 1, kind: "LINK" },
			false,
		),
	).rejects.toThrow(/is ON/u);
	expect(
		await page.evaluate(
			() => (globalThis as unknown as { clicked: boolean }).clicked,
		),
	).toBe(false);
});

interface Media {
	title: string;
	kind: "LINK" | "IMAGE";
	description?: string;
}

/**
 * LinkedIn's project editor with media, as probed 2026-11-03: one native
 * <dialog> whose project view lists each item as a link "Edit media, <title>";
 * clicking one turns the dialog into an "Edit media" view (Title, Description,
 * Delete, Back, and a Save of its own), and Delete asks "Delete this media?"
 * in a second native <dialog>. window.saved holds the items the project saved.
 */
function projectWithMedia(page: Page, media: Media[]) {
	return page.setContent(`<!doctype html><meta charset="utf-8">
<dialog id="ed"></dialog>
<script>
	const items = ${JSON.stringify(media)};
	window.saved = null;
	const ed = document.getElementById("ed");
	const esc = (s) => s.replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";");
	const thumb = (m) => m.kind === "LINK"
		? "https://media.example/dms/image/sync/v2/X/articleshare-shrink_480/0"
		: "https://media.example/dms/image/v2/Y/profile-treasury-image-shrink_480_480/0";
	const close = () => { ed.close(); ed.remove(); };
	function project() {
		ed.innerHTML = '<button aria-label="Dismiss" id="x">x</button><h2>Edit project</h2>' +
			'<label for="n">Project name*</label><input id="n" value="Widget">' +
			'<ul>' + items.map((m, i) => '<li><a href="#" data-i="' + i + '"><div>Edit media, ' + esc(m.title) +
				'</div><figure><img alt="" src="' + thumb(m) + '"></figure></a><p>' + esc(m.title) + '</p><p>' +
				esc(m.description ?? "") + '</p></li>').join("") + '</ul>' +
			'<button id="save">Save</button>';
		ed.querySelector("#x").onclick = close;
		ed.querySelector("#save").onclick = () => { window.saved = items.map((m) => m.kind + " " + m.title); close(); };
		ed.querySelectorAll("a[data-i]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); edit(Number(a.dataset.i)); }; });
	}
	function edit(i) {
		const m = items[i];
		ed.innerHTML = '<button aria-label="Dismiss" id="x">x</button><h2>Edit media</h2>' +
			'<label for="t">Title*</label><input id="t" value="' + esc(m.title) + '">' +
			'<label for="d">Description</label><textarea id="d">' + esc(m.description ?? "") + '</textarea>' +
			'<button id="del">Delete</button><button id="back">Back</button><button id="msave">Save</button>';
		ed.querySelector("#x").onclick = close;
		ed.querySelector("#back").onclick = project;
		ed.querySelector("#msave").onclick = project;
		ed.querySelector("#del").onclick = () => {
			const q = document.createElement("dialog");
			q.innerHTML = "<h2>Delete media</h2><p>Delete this media? This action cannot be undone.</p><button id=yes>Delete</button><button id=no>Cancel</button>";
			document.body.append(q);
			q.showModal();
			q.querySelector("#yes").onclick = () => { items.splice(i, 1); q.close(); q.remove(); setTimeout(project, 200); };
			q.querySelector("#no").onclick = () => { q.close(); q.remove(); };
		};
	}
	project();
	ed.showModal();
</script>`);
}
const digest: Media[] = [
	{ title: "Sean's Digest", kind: "LINK" },
	{ title: "Sean's Digest", kind: "IMAGE", description: "Old screenshot" },
	{ title: "fix: a · Pull Request #3018 · org/repo", kind: "LINK" },
];
const image = {
	title: "Sean's Digest",
	nth: 1,
	of: 2,
	kind: "IMAGE",
	description: "Old screenshot",
};

it("removing media: a dry run finds the IMAGE among two items with one quoted title, and touches nothing", async ({
	page,
}) => {
	await projectWithMedia(page, digest);
	const out = await runRemoveMedia(page, "Widget", image, true);
	expect(out).toMatch(
		/would delete IMAGE "Sean's Digest" \(item 2 of 2 .*upload thumbnail, description "Old screenshot"\)/u,
	);
	expect(await saved(page)).toBeNull();
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

it("removing media: a real run confirms LinkedIn's second dialog, then saves the project without the IMAGE", async ({
	page,
}) => {
	await projectWithMedia(page, digest);
	expect(await runRemoveMedia(page, "Widget", image, false)).toMatch(/^saved/u);
	expect(await saved(page)).toEqual([
		"LINK Sean's Digest",
		"LINK fix: a · Pull Request #3018 · org/repo",
	]);
});

it("removing media: a title with · and # is found", async ({ page }) => {
	await projectWithMedia(page, digest);
	const pr = {
		title: "fix: a · Pull Request #3018 · org/repo",
		nth: 0,
		of: 1,
		kind: "LINK",
	};
	expect(await runRemoveMedia(page, "Widget", pr, true)).toMatch(
		/would delete LINK "fix: a · Pull Request #3018/u,
	);
});

it("removing media: a thumbnail that disagrees with the kind is refused", async ({
	page,
}) => {
	await projectWithMedia(page, digest);
	await expect(
		runRemoveMedia(page, "Widget", { ...image, nth: 0 }, true),
	).rejects.toThrow(/has a LINK thumbnail, not a IMAGE's/u);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(await saved(page)).toBeNull();
});

it("removing media: an editor that lists a different count from the mirror is refused", async ({
	page,
}) => {
	await projectWithMedia(page, digest);
	await expect(
		runRemoveMedia(page, "Widget", { ...image, of: 3 }, true),
	).rejects.toThrow(/the editor shows 2 media items .* the mirror 3/u);
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

/** An older project: the legacy "Project URL" field, and Add media > Add a link > a paste box. */
function legacyProject(page: Page, url: string) {
	return page.setContent(`<!doctype html><meta charset="utf-8">
<div role="dialog" id="ed"><h2>Edit project</h2>
	<button aria-label="Dismiss" onclick="ed.remove(); window.closed = true">x</button>
	<label for="n">Project name*</label><input id="n" value="Widget">
	<label for="u">Project URL</label><input id="u" value="${url}">
	<button id="add">Add media</button><div id="menu"></div>
	<button>Save</button>
</div>
<script>
	add.onclick = () => {
		menu.innerHTML = '<div role="menuitem" id="mi">Add a link</div>';
		mi.onclick = () => {
			const p = document.createElement("div");
			p.setAttribute("role", "dialog");
			p.innerHTML = '<h2>Add a link</h2><label for="l">Paste or type a link</label><input id="l"><button>Add</button><button aria-label="Dismiss" onclick="this.parentElement.remove()">x</button>';
			document.body.append(p);
		};
	};
</script>`);
}

it("adding a link: a legacy Project URL holding it is refused unless moved, and another one always", async ({
	page,
}) => {
	const url = "https://git.example/w";
	await legacyProject(page, `${url}/`);
	await expect(
		runAddLink(page, "Widget", url, { dryRun: true }),
	).rejects.toThrow(
		/legacy "Project URL" field, not media; --move-legacy-url/u,
	);
	await legacyProject(page, url);
	expect(
		await runAddLink(page, "Widget", url, { dryRun: true, moveLegacy: true }),
	).toMatch(/^would clear the legacy "Project URL" and add/u);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await legacyProject(page, "https://other.example");
	await expect(
		runAddLink(page, "Widget", url, { dryRun: true, moveLegacy: true }),
	).rejects.toThrow(
		/holds https:\/\/other\.example; set that one link by hand/u,
	);
});
