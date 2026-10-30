// The editor runner against local copies of LinkedIn's edit dialogs: the
// shapes the probes recorded (labelled controls, a placeholder option, a
// "currently" box that reveals the end date a beat later, the share switch
// rendered twice, a Discard prompt, a separate delete confirmation).

import { expect, test as it, type Page } from "@playwright/test";
import {
	Refused,
	runAddSkill,
	runDelete,
	runEditor,
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
}

/** One edit dialog; window.saved holds what Save submitted, window.deleted whether the entry went. */
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
<script>
	window.saved = null; window.deleted = false;
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
