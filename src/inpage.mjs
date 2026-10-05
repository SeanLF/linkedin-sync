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
		'input:not([type=hidden]), textarea, [contenteditable="true"], [role="textbox"]';
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
	if (isTextarea) {
		await box.fill(text); // exact, newline-preserving
	} else {
		await box.click();
		await page.keyboard.press("Meta+A");
		await page.keyboard.insertText(text);
	}
	if (dates && mode !== "noop") {
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
	if (dates && mode !== "noop") {
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
	await page.screenshot({ path: shot }).catch(() => {});
	const result = {
		mode,
		beforeLength: before.length,
		afterLength: after.length,
		matches,
		after: matches ? undefined : after.slice(0, 300),
		dates: datesBack,
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
