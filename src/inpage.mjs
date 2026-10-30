// Functions that run inside the browser automation, with a live Playwright
// `page`. They are not called from Node: mcp.runFn sends each one's source
// text and its arguments as JSON, and the MCP server runs it.
//
// So each function must be self-contained. Its source is all that travels:
// a reference to anything outside its own body (an import, a constant in
// this file, another function here) is undefined on the other side. This file
// imports nothing for that reason, Biome's noUndeclaredVariables guards the
// rest, and `node src/inpage.mjs --self-test` checks that no function names
// another. The MCP sandbox has no URL global either (probe 2026-09-12).

// Open the experience editor for one position. With a role, the edit
// control's aria-label ("Edit <role> at <company>", seen 2026-10-05) is the
// only selector: rows of a grouped company nest, so the row fallback would
// see the company once for every role. The prefix match keeps "Software
// Engineer" from hitting "Senior Software Engineer".
export const openPosition = async (page, { match, shot, role }) => {
	page.setDefaultTimeout(8000);
	await page
		.waitForLoadState("networkidle", { timeout: 15000 })
		.catch(() => {});
	try {
		// 1. the edit control names the role and company in its aria-label
		let edit = role
			? page.locator(
					["a", "button"]
						.map(
							(t) =>
								`${t}[aria-label^=${JSON.stringify(`Edit ${role} at `)} i][aria-label*=${JSON.stringify(match)} i]`,
						)
						.join(", "),
				)
			: page.locator(
					["a", "button"]
						.map(
							(t) =>
								`${t}[aria-label*="Edit" i][aria-label*=${JSON.stringify(match)} i]`,
						)
						.join(", "),
				);
		if (role)
			await edit
				.first()
				.waitFor({ state: "attached", timeout: 15000 })
				.catch(() => {});
		if (!(await edit.count()) && role)
			throw new Error(`no edit control labelled "Edit ${role} at ${match}"`);
		if (!(await edit.count())) {
			// 2. the row that mentions the company, then its edit control
			const rows = page.locator("li").filter({ hasText: match });
			await rows.first().waitFor({ state: "visible", timeout: 15000 });
			if ((await rows.count()) !== 1)
				throw new Error(
					`${await rows.count()} rows mention ${match}; refusing to guess which position to edit`,
				);
			edit = rows
				.first()
				.locator('a[aria-label*="Edit" i], button[aria-label*="Edit" i]');
		}
		if ((await edit.count()) !== 1)
			throw new Error(
				`${await edit.count()} edit controls match ${match}; refusing to guess`,
			);
		edit = edit.first();
		const label = await edit.getAttribute("aria-label");
		await edit.click();
		return JSON.stringify({ clicked: label });
	} catch (e) {
		await page.screenshot({ path: shot }).catch(() => {});
		const lis = await page
			.locator("li")
			.count()
			.catch(() => -1);
		throw new Error(
			`could not open the position editor: ${e.message.split("\n")[0]} | url=${page.url()} | li count=${lis} | see ${shot}`,
		);
	}
};

// Find an existing project's editor URL on the projects list. Returns the URL
// rather than clicking: a click-triggered navigation took the browser down
// under headless automation (2026-09-12, same class as the download click in
// docs/lessons), a plain navigate did not.
export const findProjectEditor = async (page, { title, shot }) => {
	page.setDefaultTimeout(8000);
	await page
		.waitForLoadState("networkidle", { timeout: 15000 })
		.catch(() => {});
	const label = `Edit project ${title}`;
	const edit = page.locator(
		`a[aria-label=${JSON.stringify(label)}], button[aria-label=${JSON.stringify(label)}]`,
	);
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
			await all
				.last()
				.scrollIntoViewIfNeeded()
				.catch(() => {});
			await page.mouse.wheel(0, 4000);
			await page.waitForTimeout(1200);
		}
		const nEdit = await edit.count();
		if (nEdit === 0)
			throw new Error(`no control labelled ${JSON.stringify(label)}`);
		if (nEdit > 1) {
			const hrefs = await edit.evaluateAll((els) =>
				els.map((e) => e.getAttribute("href")),
			);
			throw new Error(
				`${nEdit} controls labelled ${JSON.stringify(label)}; two projects share this title, disambiguate by hand: ${JSON.stringify(hrefs)}`,
			);
		}
		const href = await edit.first().getAttribute("href");
		if (!href)
			throw new Error(`edit control for ${JSON.stringify(label)} has no href`);
		// LinkedIn's hrefs here are absolute (probe 2026-09-12)
		return JSON.stringify({
			label,
			href: href.startsWith("http") ? href : `https://www.linkedin.com${href}`,
		});
	} catch (e) {
		await page.screenshot({ path: shot }).catch(() => {});
		const labels = await page
			.locator('a[aria-label^="Edit project"]')
			.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
		throw new Error(
			`could not open the project editor: ${e.message.split("\n")[0]} | url=${page.url()} | edit links seen: ${JSON.stringify(labels)} | see ${shot}`,
		);
	}
};

// Add one skill to the open role editor through its typeahead, then save (or
// discard, for a dry run). One skill per editor open: a single call that
// looped over every skill crashed the headless CDP Chrome (2026-09-12).
export const addSkill = async (page, { skill, dryRun }) => {
	page.setDefaultTimeout(12000);
	await page.waitForTimeout(1200);
	const dialog = page.getByRole("dialog").first();
	await dialog.waitFor({ state: "visible", timeout: 15000 });
	// Already a chip? Then it is present; nothing to do.
	const present = await dialog.locator("button, span").evaluateAll(
		(els, skill) =>
			els.some((e) => {
				const t = (e.getAttribute("aria-label") || e.textContent)
					.replace(/\s+/g, " ")
					.trim();
				const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				return new RegExp(`^${escaped}\\s*(✓|checkmark)?$`, "i").test(t);
			}),
		skill,
	);
	if (present) return JSON.stringify({ skill, state: "already-present" });
	await dialog
		.getByRole("button", { name: /^add skill$/i })
		.first()
		.click();
	await page.waitForTimeout(1200);
	const box = dialog.locator('input[placeholder^="Skill"]').first();
	if (!(await box.count())) return JSON.stringify({ skill, state: "no-input" });
	await box.click();
	await box.pressSequentially(skill, { delay: 70 });
	await page.waitForTimeout(2500);
	// The "Additional skills" heading precedes new (not-yet-added) results; the
	// typeahead renders each result as a clickable chip/button carrying the text.
	const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const result = dialog
		.locator('button, [role="option"]')
		.filter({ hasText: new RegExp(`^\\s*${escaped}\\s*\\+?\\s*$`, "i") })
		.first();
	if (!(await result.count()))
		return JSON.stringify({ skill, state: "no-result" });
	await result.click();
	await page.waitForTimeout(1200);
	// Confirm it is now a chip with a check.
	const nowChip = await dialog.locator("button, span").evaluateAll(
		(els, skill) =>
			els.some((e) => {
				const t = (e.getAttribute("aria-label") || e.textContent)
					.replace(/\s+/g, " ")
					.trim();
				const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				return (
					new RegExp(`^${escaped}\\s*(✓|checkmark)`, "i").test(t) ||
					t.toLowerCase() === skill.toLowerCase()
				);
			}),
		skill,
	);
	// --dry-run: the skill is selected and confirmed, but discard instead of Save.
	if (dryRun) {
		await dialog
			.getByRole("button", { name: /^dismiss$/i })
			.first()
			.click()
			.catch(() => {});
		await page.waitForTimeout(500);
		await page
			.getByRole("button", { name: /discard/i })
			.first()
			.click()
			.catch(() => {});
		return JSON.stringify({
			skill,
			state: nowChip ? "would-add" : "would-add-unconfirmed",
			dryRun: true,
		});
	}
	// Refuse to save if "Share with your network" is on.
	const sw = dialog.getByRole("switch");
	for (let i = 0; i < (await sw.count()); i++) {
		const on = await sw
			.nth(i)
			.evaluate(
				(e) => e.checked === true || e.getAttribute("aria-checked") === "true",
			);
		if (on) return JSON.stringify({ skill, state: "notify-on" });
	}
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	const gone = await dialog.waitFor({ state: "hidden", timeout: 20000 }).then(
		() => true,
		() => false,
	);
	await page.waitForTimeout(1000);
	return JSON.stringify({
		skill,
		state: nowChip ? "added" : "clicked-unconfirmed",
		savedDialogGone: gone,
	});
};

// Delete the project whose editor is open, after checking it is the one
// asked for. A dry run stops at the confirmation, reports it, and cancels.
export const deleteProject = async (page, { title: wanted, dryRun, shot }) => {
	page.setDefaultTimeout(5000);
	await page.waitForTimeout(1000);
	const editor = page.getByRole("dialog").first();
	await editor.waitFor({ state: "visible", timeout: 15000 });
	const title = await editor
		.getByLabel("Project name")
		.first()
		.inputValue()
		.catch(() => null);
	if (title !== wanted)
		return JSON.stringify({
			error: `editor is for ${JSON.stringify(title)}, not the requested project; not deleting`,
		});
	const del = editor.getByRole("button", { name: /^delete project$/i });
	if ((await del.count()) !== 1)
		return JSON.stringify({
			error: `expected one "Delete project" button, found ${await del.count()}`,
		});
	await del.click();
	await page.waitForTimeout(1200);
	const confirm = page.getByRole("dialog").last();
	// No confirmation dialog of its own means the press may
	// have deleted outright, so nothing more is clicked.
	const confirmShown =
		(await confirm.isVisible().catch(() => false)) &&
		!(await confirm
			.getByRole("button", { name: /^delete project$/i })
			.count()
			.catch(() => 0));
	if (!confirmShown) {
		await page.screenshot({ path: shot }).catch(() => {});
		return JSON.stringify({
			error:
				'no confirmation dialog appeared after "Delete project"; the press may have deleted outright, so nothing more was clicked. Re-export before anything else.',
		});
	}
	const buttons = [];
	for (const b of await confirm.getByRole("button").all())
		buttons.push(
			(
				(await b.textContent()) ||
				(await b.getAttribute("aria-label")) ||
				""
			).trim(),
		);
	const text = (await confirm.textContent().catch(() => ""))
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
	// LinkedIn doubles controls (a visible button and a wrapper carrying the
	// same name), so pick the visible "Delete" rather than demanding one match.
	const yesAll = confirm.getByRole("button", { name: /^delete$/i });
	const nYes = await yesAll.count();
	let yes = null;
	for (let i = 0; i < nYes; i++)
		if (
			await yesAll
				.nth(i)
				.isVisible()
				.catch(() => false)
		) {
			yes = yesAll.nth(i);
			break;
		}
	if (dryRun) {
		const no = confirm
			.getByRole("button", { name: /^(no thanks|cancel|dismiss)$/i })
			.first();
		if (await no.count()) await no.click();
		return JSON.stringify({
			mode: "dry",
			title,
			confirmText: text,
			confirmButtons: buttons,
			deleteButtons: nYes,
			wouldClick: yes ? "Delete" : null,
		});
	}
	if (!yes)
		return JSON.stringify({
			error: `no visible "Delete" confirm button (${nYes} matched); buttons: ${JSON.stringify(buttons)}`,
		});
	await yes.click();
	const gone = await editor.waitFor({ state: "hidden", timeout: 20000 }).then(
		() => true,
		() => false,
	);
	let after = null;
	try {
		await page.waitForTimeout(1500);
		await page.screenshot({ path: shot });
		after = page.url();
	} catch {
		after =
			"page closed after confirm (headless does this; the export decides)";
	}
	return JSON.stringify({
		mode: "delete",
		title,
		confirmText: text,
		editorGone: gone,
		after,
	});
};

// Describe every text control in the open dialog: the probe's whole output,
// and the writer's pre-flight.
export const describeDialog = async (page, { shot }) => {
	page.setDefaultTimeout(4000);
	const diag = async (error) =>
		JSON.stringify(
			{
				error,
				url: page.url(),
				title: await page.title().catch(() => null),
				dialogs: await page
					.getByRole("dialog")
					.count()
					.catch(() => -1),
				screenshot: shot,
			},
			null,
			2,
		);
	// Not waitForLoadState('networkidle'): under headless that wait took the
	// page down with "Target page, context or browser has been closed"
	// (bisected 2026-09-12; the same page answered a count() a moment earlier).
	// The dialog wait below is the readiness check that matters.
	await page.waitForTimeout(1000);
	const dialog = page.getByRole("dialog").first();
	try {
		await dialog.waitFor({ state: "visible", timeout: 15000 });
	} catch (e) {
		await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
		return diag(`no dialog: ${e.message.split("\n")[0]}`);
	}
	const heading = await dialog
		.getByRole("heading")
		.first()
		.textContent()
		.catch(() => null);
	await dialog
		.evaluate((d) => {
			for (const el of [d, ...d.querySelectorAll("*")])
				if (el.scrollHeight > el.clientHeight + 20)
					el.scrollTop = el.scrollHeight;
		})
		.catch(() => {});
	await page.waitForTimeout(300);
	await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
	const controls = [];
	const SEL =
		'input:not([type=hidden]), textarea, select, [contenteditable="true"], [role="textbox"]';
	const text = (loc) =>
		loc
			.first()
			.textContent({ timeout: 800 })
			.catch(() => null);
	for (const loc of await dialog.locator(SEL).all()) {
		const id = await loc.getAttribute("id");
		let label = id ? await text(page.locator(`label[for="${id}"]`)) : null;
		const labelledBy = await loc.getAttribute("aria-labelledby");
		if (!label && labelledBy) {
			const parts = [];
			for (const lid of labelledBy.split(/\s+/))
				parts.push((await text(page.locator(`[id="${lid}"]`))) ?? "");
			label = parts.join(" ");
		}
		if (!label) {
			// switches and checkboxes are usually wrapped by their label, or sit beside it
			label =
				(await text(loc.locator("xpath=ancestor::label[1]"))) ||
				(await text(loc.locator("xpath=following-sibling::label[1]"))) ||
				(await text(loc.locator("xpath=..")));
		}
		const tag = await loc.evaluate((e) => e.tagName.toLowerCase());
		const editable = await loc.getAttribute("contenteditable");
		const value =
			editable === "true"
				? await loc.textContent().catch(() => "")
				: await loc.inputValue().catch(() => "");
		const role = await loc.getAttribute("role");
		const type = await loc.getAttribute("type");
		let context = null;
		let checked = null;
		if (role === "switch" || type === "checkbox") {
			checked = await loc.evaluate(
				(e) => e.checked ?? e.getAttribute("aria-checked"),
			);
			// walk outward until some ancestor carries words; a bare switch sits in a div of divs
			for (const depth of [1, 2, 3, 4, 5]) {
				const t = await text(loc.locator(`xpath=ancestor::*[${depth}]`));
				const words = t?.replace(/\s+/g, " ").trim();
				if (words && words.length > 3) {
					context = words.slice(0, 120);
					break;
				}
			}
		}
		controls.push({
			tag,
			role,
			editable,
			id,
			checked,
			context,
			name: await loc.getAttribute("name"),
			label: label?.replace(/\s+/g, " ").trim(),
			ariaLabel: await loc.getAttribute("aria-label"),
			maxlength: await loc.getAttribute("maxlength"),
			valueLength: (value || "").length,
			valueHead: (value || "").slice(0, 40),
		});
	}
	const buttons = [];
	for (const b of await dialog.getByRole("button").all())
		buttons.push(
			(
				(await b.textContent()) ||
				(await b.getAttribute("aria-label")) ||
				""
			).trim(),
		);
	return JSON.stringify(
		{
			url: page.url(),
			heading: heading?.trim(),
			controls,
			buttons,
			screenshot: shot,
		},
		null,
		2,
	);
};

// Fill the open dialog's field (and a project's dates), check it reads back,
// then save, discard (dry run) or re-save the current text (noop).
// Select-all then insertText, which is what a paste does from the editor's
// point of view: one input event carrying the whole string, so LinkedIn's
// own handler decides how a newline becomes a paragraph. keyboard.type would
// fire a keystroke per character and the editor's autocomplete gets a vote.
export const fillDialog = async (
	page,
	{
		control,
		text: desired,
		mode,
		shot,
		title,
		titleLabel,
		notifySwitch,
		dates,
		dateLabels,
		extra,
		editing,
		monthNames,
	},
) => {
	page.setDefaultTimeout(5000);
	const dialog = page.getByRole("dialog").first();
	await dialog.waitFor({ state: "visible", timeout: 15000 });
	const box = dialog.locator(control);
	const n = await box.count();
	if (n !== 1)
		return JSON.stringify({
			error: `expected exactly 1 control matching ${control}, found ${n}`,
		});
	const isTextarea = (await box.evaluate((e) => e.tagName)) === "TEXTAREA";
	const read = () => (isTextarea ? box.inputValue() : box.innerText());
	const before = await read();
	const text = mode === "noop" ? before : desired;
	if (title != null) {
		const titleBox = dialog.getByLabel(titleLabel ?? "").first();
		if (editing) {
			// Editing: the title identifies the project; verify it, never overwrite it.
			const current = await titleBox.inputValue();
			if (current !== title)
				return JSON.stringify({
					error: `open editor is for ${JSON.stringify(current)}, not ${title}; not saving`,
				});
		} else {
			await titleBox.fill(title);
		}
	}
	// Other text inputs on the same editor (a role's company), each found by an
	// anchored label and required to be exactly one control.
	for (const x of mode === "noop" ? [] : (extra ?? [])) {
		const loc = dialog.getByLabel(new RegExp(x.pattern, "i"));
		const nx = await loc.count();
		if (nx !== 1)
			return JSON.stringify({
				error: `expected one control labelled /${x.pattern}/, found ${nx}; not saving`,
			});
		await loc.fill(x.value);
	}
	if (isTextarea) {
		await box.fill(text); // exact, newline-preserving
	} else {
		await box.click();
		await page.keyboard.press("Meta+A");
		await page.keyboard.insertText(text);
	}
	let datesWanted = null;
	if (dates && mode !== "noop" && dateLabels) {
		// A labelled date block (the role editor, probe 2026-10-29): "Start
		// month", "Start year*", "End month", "End year*" and the "currently
		// working" checkbox, each found by an anchored label and required to be
		// exactly one control.
		const one = async (src) => {
			const l = dialog.getByLabel(new RegExp(src, "i"));
			const n = await l.count();
			if (n !== 1) throw new Error(`${n} controls labelled /${src}/`);
			return l.first();
		};
		try {
			const current = await one(dateLabels.current);
			const wantCurrent = dates.end === null;
			if ((await current.isChecked()) !== wantCurrent)
				await current
					.click({ force: true, timeout: 3000 })
					.catch(() => current.dispatchEvent("click"));
			if ((await current.isChecked()) !== wantCurrent)
				return JSON.stringify({
					error: `could not switch "currently working" ${wantCurrent ? "on" : "off"}; not saving`,
				});
			const [sy, sm] = dates.start.split("-");
			await (await one(dateLabels.startMonth)).selectOption({
				label: monthNames[Number(sm) - 1],
			});
			await (await one(dateLabels.startYear)).selectOption({ label: sy });
			if (dates.end) {
				const [ey, em] = dates.end.split("-");
				await (await one(dateLabels.endMonth)).selectOption({
					label: monthNames[Number(em) - 1],
				});
				await (await one(dateLabels.endYear)).selectOption({ label: ey });
			}
			datesWanted = {
				start: `${monthNames[Number(sm) - 1]} ${sy}`,
				current: wantCurrent,
				end: dates.end
					? `${monthNames[Number(dates.end.split("-")[1]) - 1]} ${dates.end.split("-")[0]}`
					: undefined,
			};
		} catch (e) {
			return JSON.stringify({
				error: `the editor's date controls are not the expected shape (${e.message.split("\n")[0]}); not saving`,
			});
		}
		await page.waitForTimeout(200);
	} else if (dates && mode !== "noop") {
		// Probe 2026-09-12: two Month/Year select pairs (start, then end) and one
		// checkbox, "I am currently working on this project", which hides the end
		// pair when checked. Labels are exact, so getByLabel finds only these.
		const months = dialog.getByLabel("Month", { exact: true });
		const years = dialog.getByLabel("Year", { exact: true });
		if ((await months.count()) < 1 || (await years.count()) < 1)
			return JSON.stringify({
				error:
					"no Month/Year selects in this dialog; the editor changed shape, not saving",
			});
		const [sy, sm] = dates.start.split("-");
		await months.nth(0).selectOption({ label: monthNames[Number(sm) - 1] });
		await years.nth(0).selectOption({ label: sy });
		// LinkedIn renders the one "currently working" control as two checkbox
		// elements (an input and its wrapper), as it does the network switch, so
		// act on the visible one and read state from the first.
		const boxes = dialog.getByRole("checkbox");
		const nBoxes = await boxes.count();
		if (nBoxes === 0)
			return JSON.stringify({
				error:
					'no "currently working" checkbox in this dialog; the editor changed shape, not saving',
			});
		let current = boxes.first();
		for (let i = 0; i < nBoxes; i++)
			if (
				await boxes
					.nth(i)
					.isVisible()
					.catch(() => false)
			) {
				current = boxes.nth(i);
				break;
			}
		const isOn = () => boxes.first().isChecked();
		if (dates.end === null) {
			if (!(await isOn())) await current.click({ force: true });
			if (!(await isOn()))
				return JSON.stringify({
					error: 'could not switch "currently working" on; not saving',
				});
		} else {
			if (await isOn()) await current.click({ force: true });
			if (await isOn())
				return JSON.stringify({
					error: 'could not switch "currently working" off; not saving',
				});
			const [ey, em] = dates.end.split("-");
			await months.nth(1).selectOption({ label: monthNames[Number(em) - 1] });
			await years.nth(1).selectOption({ label: ey });
		}
		await page.waitForTimeout(200);
	}
	await page.waitForTimeout(400);
	const after = await read();
	let datesBack = null;
	if (datesWanted) {
		const opt = async (src) =>
			dialog
				.getByLabel(new RegExp(src, "i"))
				.first()
				.evaluate((e) => e.options[e.selectedIndex]?.text ?? "");
		datesBack = {
			start: `${await opt(dateLabels.startMonth)} ${await opt(dateLabels.startYear)}`,
			current: await dialog
				.getByLabel(new RegExp(dateLabels.current, "i"))
				.first()
				.isChecked(),
		};
		if (!datesBack.current)
			datesBack.end = `${await opt(dateLabels.endMonth)} ${await opt(dateLabels.endYear)}`;
	} else if (dates && mode !== "noop") {
		const months = dialog.getByLabel("Month", { exact: true });
		const years = dialog.getByLabel("Year", { exact: true });
		const opt = async (sel) =>
			sel.evaluate((e) => e.options[e.selectedIndex]?.text ?? "");
		datesBack = {
			start: `${await opt(months.nth(0))} ${await opt(years.nth(0))}`,
			current: await dialog.getByRole("checkbox").first().isChecked(),
		};
		if ((await months.count()) > 1)
			datesBack.end = `${await opt(months.nth(1))} ${await opt(years.nth(1))}`;
	}
	// innerText renders each editor block with its own newline count, so a
	// paragraph break can read back as three or five newlines. The gate here
	// checks that the words landed; whether LinkedIn stored the breaks the way
	// the record has them is what the re-export and drift check are for.
	const norm = (s) =>
		s
			.replace(/\r/g, "")
			.replace(/\u00a0/g, " ")
			.replace(/[ \t]+$/gm, "")
			.replace(/\n+/g, "\n")
			.trim();
	const matches = norm(after) === norm(text);
	const extraBack = [];
	for (const x of mode === "noop" ? [] : (extra ?? []))
		extraBack.push({
			pattern: x.pattern,
			want: x.value,
			got: await dialog
				.getByLabel(new RegExp(x.pattern, "i"))
				.inputValue()
				.catch(() => null),
		});
	await page.screenshot({ path: shot }).catch(() => {});
	const result = {
		mode,
		beforeLength: before.length,
		afterLength: after.length,
		matches,
		after: matches ? undefined : after.slice(0, 300),
		dates: datesBack,
		datesWanted,
		extra: extraBack.length ? extraBack : undefined,
		extraMatch: extraBack.every((x) => x.got === x.want),
		// JSON drops the undefined end of a current role, as datesBack never has one.
		datesMatch: datesWanted
			? JSON.stringify(datesBack) === JSON.stringify(datesWanted)
			: undefined,
	};
	if (mode === "dry") {
		await dialog
			.getByRole("button", { name: /^(Dismiss|Close)$/ })
			.first()
			.click();
		const discard = page.getByRole("button", { name: /discard/i }).first();
		if (await discard.isVisible({ timeout: 2500 }).catch(() => false))
			await discard.click();
		result.dialogGone = await dialog
			.waitFor({ state: "hidden", timeout: 10000 })
			.then(
				() => true,
				() => false,
			);
		return JSON.stringify(result);
	}
	if (!matches)
		return JSON.stringify({
			error: "field does not read back as the desired text; not saving",
			after: after.slice(0, 300),
		});
	if (!result.extraMatch)
		return JSON.stringify({
			error: `fields read back wrong: ${JSON.stringify(extraBack)}; not saving`,
		});
	if (datesWanted && !result.datesMatch)
		return JSON.stringify({
			error: `dates read back as ${JSON.stringify(datesBack)}, not ${JSON.stringify(datesWanted)}; not saving`,
		});
	if (notifySwitch) {
		// LinkedIn renders the one control as two role=switch elements (an input
		// and its wrapper), so require that every switch is off, not that there is one.
		const sw = dialog.getByRole("switch");
		const n = await sw.count();
		if (n === 0)
			return JSON.stringify({
				error:
					'no "Share with your network" switch found; the editor changed shape, not saving',
			});
		for (let i = 0; i < n; i++) {
			const on = await sw
				.nth(i)
				.evaluate(
					(e) =>
						e.checked === true || e.getAttribute("aria-checked") === "true",
				);
			if (on)
				return JSON.stringify({
					error:
						'"Share with your network" is ON in this editor; not saving. Turn it off by hand first.',
				});
		}
		result.notifyNetwork = `off (${n} switch elements checked)`;
	}
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	// isHidden answers immediately; waitFor is the one that waits. Under
	// headless the page can report itself closed right after Save while the
	// write has landed (2026-09-12: headline "failed" this way and the export
	// showed it saved), so nothing after the click may throw. The re-export
	// is the proof either way.
	result.dialogGone = await dialog
		.waitFor({ state: "hidden", timeout: 20000 })
		.then(
			() => true,
			() => false,
		);
	try {
		await page.waitForTimeout(1500);
		await page.screenshot({ path: shot });
		result.url = page.url();
	} catch (e) {
		result.pageClosedAfterSave = e.message.split("\n")[0];
	}
	return JSON.stringify(result);
};

// How many dialogs are open after a navigation settles.
export const countDialogs = async (page) => {
	await page.waitForTimeout(2500);
	return String(await page.getByRole("dialog").count());
};

// LINKEDIN_TRACE: where an editor navigation landed.
export const traceEditor = async (page) => {
	await page.waitForTimeout(1500);
	return JSON.stringify({
		url: page.url(),
		dialogs: await page.getByRole("dialog").count(),
	});
};

// The logged-in member's vanity name, from /voyager/api/me with the session's
// CSRF token (the JSESSIONID cookie, echoed).
export const readVanity = async (page) => {
	const csrf = (await page.context().cookies("https://www.linkedin.com"))
		.find((c) => c.name === "JSESSIONID")
		?.value?.replace(/"/g, "");
	if (!csrf) return JSON.stringify({ error: "no JSESSIONID" });
	const body = await page.evaluate(async (csrf) => {
		const r = await fetch("/voyager/api/me", {
			headers: {
				"csrf-token": csrf,
				accept: "application/vnd.linkedin.normalized+json+2.1",
				"x-restli-protocol-version": "2.0.0",
			},
		});
		return { status: r.status, text: (await r.text()).slice(0, 4000) };
	}, csrf);
	const m = body.text.match(/"publicIdentifier":"([^"]+)"/);
	return JSON.stringify({ status: body.status, vanity: m ? m[1] : null });
};

// Fill an open editor from a list of steps (built in schema.mjs), read every
// control back, then save, or discard for a dry run. One writer for every
// section whose editor is a plain form: education, honours, publications,
// volunteering, certifications.
//
// A step is {kind: "text"|"select"|"checkbox", pattern, nth?, value|option}.
// `pattern` is an anchored label regex: getByLabel with a plain string is a
// case-insensitive substring match, and "Role" also hits "I am currently
// volunteering in this role". `expect` lists identity controls that must
// already read a given value (editing the wrong entry is refused). Typeahead
// fields (school, organization, issuer) are typed, not picked from the
// suggestion list; LinkedIn keeps typed text, unlinked to a company page.
export const fillForm = async (
	page,
	{ steps, expect, heading, mode, shot },
) => {
	page.setDefaultTimeout(6000);
	const dialog = page.getByRole("dialog").first();
	try {
		await dialog.waitFor({ state: "visible", timeout: 15000 });
	} catch {
		await page.screenshot({ path: shot }).catch(() => {});
		return JSON.stringify({ error: `no editor opened at ${page.url()}` });
	}
	await page.waitForTimeout(800);
	const head = (
		(await dialog
			.getByRole("heading")
			.first()
			.textContent()
			.catch(() => "")) || ""
	).trim();
	if (heading && !new RegExp(heading, "i").test(head))
		return JSON.stringify({
			error: `the open dialog is "${head}", not a ${heading} editor; not touching it`,
		});
	const norm = (v) =>
		String(v ?? "")
			.replace(/\r/g, "")
			.replace(/ /g, " ")
			.replace(/[ \t]+$/gm, "")
			.replace(/\n+/g, "\n")
			.trim();
	const all = (st) => dialog.getByLabel(new RegExp(st.pattern, "i"));
	const at = (st) => all(st).nth(st.nth ?? 0);
	const name = (st) => `/${st.pattern}/${st.nth ? ` #${st.nth + 1}` : ""}`;
	const readStep = async (st) => {
		const loc = at(st);
		if (st.kind === "select")
			return loc.evaluate((e) => ({
				index: e.selectedIndex,
				text: (e.options[e.selectedIndex]?.text ?? "").trim(),
			}));
		if (st.kind === "checkbox") return loc.isChecked();
		return (await loc.getAttribute("contenteditable")) === "true"
			? loc.innerText()
			: loc.inputValue();
	};
	for (const ex of expect ?? []) {
		if (!(await all(ex).count()))
			return JSON.stringify({
				error: `no control ${name(ex)} to check which entry this is; not touching it`,
			});
		const v = await readStep({ ...ex, kind: "text" });
		if (norm(v) !== norm(ex.value))
			return JSON.stringify({
				error: `this editor's ${name(ex)} reads ${JSON.stringify(v)}, not ${JSON.stringify(ex.value)}: the wrong entry; not touching it`,
			});
	}
	for (const st of steps) {
		const n = await all(st).count();
		if (n <= (st.nth ?? 0)) {
			await page.screenshot({ path: shot }).catch(() => {});
			return JSON.stringify({
				error: `no control ${name(st)} in this editor (found ${n}); it changed shape, not saving`,
			});
		}
		const loc = at(st);
		if (st.kind === "select") {
			if (st.option === "") await loc.selectOption({ index: 0 });
			else {
				const options = await loc.evaluate((e) =>
					[...e.options].map((o) => o.text.trim()),
				);
				if (!options.includes(st.option))
					return JSON.stringify({
						error: `${name(st)} has no option ${JSON.stringify(st.option)}; it offers ${JSON.stringify(options.slice(0, 40))}`,
					});
				await loc.selectOption({ label: st.option });
			}
		} else if (st.kind === "checkbox") {
			// The volunteer editor's checkbox is a visually hidden input that sits
			// outside the viewport, so even a forced click is refused (2026-10-29);
			// a dispatched click toggles it the way a click on its label would.
			if ((await loc.isChecked()) !== st.value)
				await loc
					.click({ force: true, timeout: 3000 })
					.catch(() => loc.dispatchEvent("click"));
		} else if ((await loc.getAttribute("contenteditable")) === "true") {
			await loc.click();
			await page.keyboard.press("Meta+A");
			await page.keyboard.insertText(st.value);
		} else {
			await loc.fill(st.value);
		}
		await page.waitForTimeout(250);
	}
	await page.waitForTimeout(600);
	const results = [];
	for (const st of steps) {
		let got;
		try {
			got = await readStep(st);
		} catch (e) {
			got = `unreadable: ${e.message.split("\n")[0]}`;
		}
		let ok;
		let shown = got;
		if (st.kind === "select") {
			shown = got?.text;
			ok = st.option === "" ? got?.index === 0 : got?.text === st.option;
		} else if (st.kind === "checkbox") ok = got === st.value;
		else ok = norm(got) === norm(st.value);
		results.push({
			control: name(st),
			want:
				st.kind === "select"
					? st.option || "(blank)"
					: String(st.value).slice(0, 80),
			got: String(shown).slice(0, 80),
			ok,
		});
	}
	await page.screenshot({ path: shot }).catch(() => {});
	const out = {
		mode,
		heading: head,
		results,
		ok: results.every((r) => r.ok),
	};
	// Save is refused while any "notify your network" switch is on; LinkedIn
	// renders one control as two role=switch elements, so every one must be off.
	const switches = dialog.getByRole("switch");
	let notifyOn = false;
	for (let i = 0; i < (await switches.count()); i++)
		if (
			await switches
				.nth(i)
				.evaluate(
					(e) =>
						e.checked === true || e.getAttribute("aria-checked") === "true",
				)
		)
			notifyOn = true;
	out.notifyNetwork = notifyOn ? "ON" : "off";
	if (mode === "dry") {
		await dialog
			.getByRole("button", { name: /^(Dismiss|Close)$/ })
			.first()
			.click();
		const discard = page.getByRole("button", { name: /discard/i }).first();
		if (await discard.isVisible({ timeout: 2500 }).catch(() => false))
			await discard.click();
		out.dialogGone = await dialog
			.waitFor({ state: "hidden", timeout: 10000 })
			.then(
				() => true,
				() => false,
			);
		return JSON.stringify(out);
	}
	if (!out.ok)
		return JSON.stringify({
			...out,
			error: "the editor does not read back as the record; not saving",
		});
	if (notifyOn)
		return JSON.stringify({
			...out,
			error:
				'"Notify network" is ON in this editor; not saving. Turn it off by hand first.',
		});
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	// As in the field writer: under headless the page can report itself closed
	// right after Save while the write landed, so nothing here may throw.
	out.dialogGone = await dialog
		.waitFor({ state: "hidden", timeout: 20000 })
		.then(
			() => true,
			() => false,
		);
	try {
		await page.waitForTimeout(1500);
		await page.screenshot({ path: shot });
		out.url = page.url();
		if (!out.dialogGone)
			out.stillOpen = (await dialog.innerText().catch(() => ""))
				.replace(/\s+/g, " ")
				.slice(0, 300);
	} catch (e) {
		out.pageClosedAfterSave = e.message.split("\n")[0];
	}
	return JSON.stringify(out);
};

// Delete the entry whose editor is open, after checking it is the one asked
// for (heading and identity controls). A dry run stops at the confirmation,
// reports it, and cancels.
export const deleteEntry = async (
	page,
	{ heading, expect, button, dryRun, shot },
) => {
	page.setDefaultTimeout(6000);
	const editor = page.getByRole("dialog").first();
	try {
		await editor.waitFor({ state: "visible", timeout: 15000 });
	} catch {
		await page.screenshot({ path: shot }).catch(() => {});
		return JSON.stringify({ error: `no editor opened at ${page.url()}` });
	}
	await page.waitForTimeout(800);
	const head = (
		(await editor
			.getByRole("heading")
			.first()
			.textContent()
			.catch(() => "")) || ""
	).trim();
	if (heading && !new RegExp(heading, "i").test(head))
		return JSON.stringify({
			error: `the open dialog is "${head}", not /${heading}/; not deleting`,
		});
	for (const ex of expect ?? []) {
		const loc = editor.getByLabel(new RegExp(ex.pattern, "i")).first();
		const v = await loc.inputValue().catch(() => null);
		if ((v ?? "").trim() !== (ex.value ?? "").trim())
			return JSON.stringify({
				error: `this editor's /${ex.pattern}/ reads ${JSON.stringify(v)}, not ${JSON.stringify(ex.value)}; not deleting`,
			});
	}
	const del = editor.getByRole("button", { name: button, exact: true });
	if ((await del.count()) !== 1)
		return JSON.stringify({
			error: `expected one "${button}" button, found ${await del.count()}`,
		});
	await del.click();
	await page.waitForTimeout(1200);
	const confirm = page.getByRole("dialog").last();
	// The confirmation is a dialog of its own: the last one, and not the editor
	// (which still carries the entry's delete button). Without one, the press
	// may have deleted outright, so nothing more is clicked in either mode.
	const confirmShown =
		(await confirm.isVisible().catch(() => false)) &&
		!(await confirm
			.getByRole("button", { name: button, exact: true })
			.count()
			.catch(() => 0));
	if (!confirmShown) {
		await page.screenshot({ path: shot }).catch(() => {});
		return JSON.stringify({
			error: `no confirmation dialog appeared after "${button}"; the press may have deleted outright, so nothing more was clicked. Re-export before anything else.`,
		});
	}
	const text = (await confirm.textContent().catch(() => ""))
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
	const buttons = [];
	for (const b of await confirm.getByRole("button").all())
		buttons.push(
			(
				(await b.textContent()) ||
				(await b.getAttribute("aria-label")) ||
				""
			).trim(),
		);
	// LinkedIn doubles controls, so pick the visible "Delete".
	const yesAll = confirm.getByRole("button", { name: /^delete$/i });
	let yes = null;
	for (let i = 0; i < (await yesAll.count()); i++)
		if (
			await yesAll
				.nth(i)
				.isVisible()
				.catch(() => false)
		) {
			yes = yesAll.nth(i);
			break;
		}
	if (dryRun) {
		const no = confirm
			.getByRole("button", { name: /^(no thanks|cancel|dismiss)$/i })
			.first();
		if (!(await no.count()))
			return JSON.stringify({
				error: `the confirmation offers no Cancel; left open. Buttons: ${JSON.stringify(buttons)}`,
			});
		await no.click();
		return JSON.stringify({
			mode: "dry",
			heading: head,
			confirmText: text,
			confirmButtons: buttons,
			wouldClick: yes ? "Delete" : null,
		});
	}
	if (!yes)
		return JSON.stringify({
			error: `no visible "Delete" confirm button; buttons: ${JSON.stringify(buttons)}`,
		});
	await yes.click();
	const gone = await editor.waitFor({ state: "hidden", timeout: 20000 }).then(
		() => true,
		() => false,
	);
	let after = null;
	try {
		await page.waitForTimeout(1500);
		await page.screenshot({ path: shot });
		after = page.url();
	} catch {
		after =
			"page closed after confirm (headless does this; the export decides)";
	}
	return JSON.stringify({
		mode: "delete",
		heading: head,
		editorGone: gone,
		after,
	});
};

// Add one skill to the profile from the standalone "Add skill" form
// (/skills/edit/forms/new/, probe 2026-10-29: one "Skill*" typeahead). The
// typed name must come back as an exact (case-insensitive) suggestion to be
// picked: a skill is a LinkedIn entity, not free text.
export const addProfileSkill = async (page, { skill, dryRun, shot }) => {
	page.setDefaultTimeout(10000);
	const dialog = page.getByRole("dialog").first();
	await dialog.waitFor({ state: "visible", timeout: 15000 });
	await page.waitForTimeout(800);
	const box = dialog.getByLabel(/^Skill\*?$/i).first();
	if (!(await box.count())) return JSON.stringify({ skill, state: "no-input" });
	await box.click();
	// Typed key by key, this typeahead drops keystrokes while it re-renders:
	// "Machine Learning" arrived as "Mae Learning" (2026-10-29). So fill all
	// but the last character, type that one to fire the search, and check the
	// box holds the whole name before reading any suggestion.
	await box.fill(skill.slice(0, -1));
	await box.pressSequentially(skill.slice(-1), { delay: 100 });
	await page.waitForTimeout(2500);
	const typed = await box.inputValue().catch(() => "");
	if (typed !== skill) {
		await page.screenshot({ path: shot }).catch(() => {});
		return JSON.stringify({ skill, state: "typed-wrong", typed });
	}
	const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const exact = new RegExp(`^\\s*${escaped}\\s*$`, "i");
	const result = page
		.locator('[role="option"]')
		.filter({ hasText: exact })
		.first();
	if (!(await result.count())) {
		const seen = await page
			.locator('[role="option"]')
			.evaluateAll((els) => els.map((e) => e.textContent.trim()).slice(0, 10));
		await page.screenshot({ path: shot }).catch(() => {});
		const close = dialog.getByRole("button", { name: /^(Dismiss|Close)$/ });
		await close
			.first()
			.click()
			.catch(() => {});
		const discard = page.getByRole("button", { name: /discard/i }).first();
		if (await discard.isVisible({ timeout: 2500 }).catch(() => false))
			await discard.click();
		return JSON.stringify({ skill, state: "no-exact-suggestion", seen });
	}
	await result.click();
	await page.waitForTimeout(1000);
	const value = await box.inputValue().catch(() => "");
	const picked = value.trim().toLowerCase() === skill.toLowerCase();
	if (dryRun || !picked) {
		await dialog
			.getByRole("button", { name: /^(Dismiss|Close)$/ })
			.first()
			.click()
			.catch(() => {});
		const discard = page.getByRole("button", { name: /discard/i }).first();
		if (await discard.isVisible({ timeout: 2500 }).catch(() => false))
			await discard.click();
		return JSON.stringify({
			skill,
			state: picked ? "would-add" : "picked-something-else",
			value,
		});
	}
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	const gone = await dialog.waitFor({ state: "hidden", timeout: 20000 }).then(
		() => true,
		() => false,
	);
	await page.waitForTimeout(1000).catch(() => {});
	// value: the name LinkedIn picked, which may differ from the record in case.
	return JSON.stringify({
		skill,
		state: gone ? "added" : "save-unconfirmed",
		value,
	});
};

// Attach a link to the open project editor: Add media, Add a link, paste the
// URL (probe 2026-10-29: a menu with "Add a link" and "Add a document", then
// one input, "Paste or type a link to an article, file or video.", and Add /
// Back / Save). Past "Add" the flow is unprobed: LinkedIn fetches a preview
// and shows its own title/description form. So a real run requires that form
// to offer exactly one visible Save (or Apply), clicks it, then saves the
// project; anything else stops without saving. A dry run stops before "Add".
export const addProjectLink = async (page, { url, title, dryRun, shot }) => {
	page.setDefaultTimeout(8000);
	const editor = page.getByRole("dialog").first();
	await editor.waitFor({ state: "visible", timeout: 15000 });
	await page.waitForTimeout(800);
	const name = await editor
		.getByLabel(/^Project name\*?$/i)
		.first()
		.inputValue()
		.catch(() => null);
	if (name !== title)
		return JSON.stringify({
			error: `editor is for ${JSON.stringify(name)}, not ${JSON.stringify(title)}; not touching it`,
		});
	const discardAll = async () => {
		for (let i = 0; i < 3; i++) {
			const d = page.getByRole("dialog").last();
			if (!(await d.count())) break;
			await d
				.getByRole("button", { name: /^(Dismiss|Close)$/ })
				.first()
				.click()
				.catch(() => {});
			await page.waitForTimeout(600);
			const discard = page.getByRole("button", { name: /discard/i }).first();
			if (await discard.isVisible({ timeout: 1500 }).catch(() => false))
				await discard.click();
			await page.waitForTimeout(600);
		}
	};
	if (await editor.getByLabel(/^Project URL$/i).count()) {
		await discardAll();
		return JSON.stringify({
			error:
				'this project still has the legacy "Project URL" field; LinkedIn shows that one link instead of media here, so set it by hand',
		});
	}
	const add = editor.getByRole("button", { name: /^add media$/i }).first();
	await add.scrollIntoViewIfNeeded();
	await add.click();
	await page.waitForTimeout(1500);
	const item = page.getByRole("menuitem", { name: /add a link/i }).first();
	if (!(await item.count())) {
		await discardAll();
		return JSON.stringify({ error: 'no "Add a link" in the Add media menu' });
	}
	await item.click();
	await page.waitForTimeout(1500);
	const panel = page.getByRole("dialog").last();
	const box = panel.getByLabel(/paste or type a link/i).first();
	if (!(await box.count())) {
		await discardAll();
		return JSON.stringify({ error: "no link box after Add a link" });
	}
	await box.fill(url);
	const typed = await box.inputValue();
	await page.screenshot({ path: shot }).catch(() => {});
	if (dryRun || typed !== url) {
		await discardAll();
		return JSON.stringify({
			mode: "dry",
			typed,
			ok: typed === url,
			stoppedBefore: "Add (LinkedIn fetches the preview there)",
		});
	}
	await panel.getByRole("button", { name: /^add$/i }).first().click();
	await page.waitForTimeout(5000);
	const form = page.getByRole("dialog").last();
	const controls = await form
		.locator("input:not([type=hidden]), textarea")
		.evaluateAll((els) =>
			els.map((e) => `${e.getAttribute("aria-label") || e.id}=${e.value}`),
		);
	const saves = form.getByRole("button", { name: /^(save|apply)$/i });
	let save = null;
	let visible = 0;
	for (let i = 0; i < (await saves.count()); i++)
		if (
			await saves
				.nth(i)
				.isVisible()
				.catch(() => false)
		) {
			visible++;
			save = saves.nth(i);
		}
	if (visible !== 1) {
		await page.screenshot({ path: shot }).catch(() => {});
		await discardAll();
		return JSON.stringify({
			error: `after Add, the media form shows ${visible} Save/Apply buttons (expected one); discarded`,
			controls,
		});
	}
	await save.click();
	await page.waitForTimeout(2500);
	const back = page.getByRole("dialog").first();
	const projectSave = back.getByRole("button", { name: "Save", exact: true });
	if ((await projectSave.count()) !== 1) {
		await discardAll();
		return JSON.stringify({
			error:
				"the project editor did not come back with one Save; the media Save may itself have saved the project, so re-export before retrying",
			controls,
		});
	}
	await projectSave.click();
	const gone = await back.waitFor({ state: "hidden", timeout: 20000 }).then(
		() => true,
		() => false,
	);
	return JSON.stringify({ mode: "save", controls, dialogGone: gone });
};
