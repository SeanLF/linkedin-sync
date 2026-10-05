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

import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBlocks } from "./copy-blocks.mjs";
import {
	addSkill,
	countDialogs,
	deleteProject,
	describeDialog,
	fillDialog,
	findProjectEditor,
	openPosition,
	traceEditor,
} from "./inpage.mjs";
import { startMcp } from "./mcp.mjs";
import { fieldsFromBlocks, MONTH_NAMES } from "./schema.mjs";

// Fields are whatever the source-of-truth file declares (id -> field def).
const { byId: BY_ID } = fieldsFromBlocks(parseBlocks());

// Resolved from the logged-in session (or LINKEDIN_VANITY) once per run,
// before any surface URL below is read. The URLs are getters so they pick it
// up lazily.
let VANITY = process.env.LINKEDIN_VANITY || "";
async function resolveVanity(mcp) {
	if (!VANITY) VANITY = await mcp.getVanity();
	return VANITY;
}

// Where each edit surface lives. Deep links open the dialog directly; if
// LinkedIn stops honouring one, the probe reports "no dialog" and this table
// is what to fix.
const SURFACES = {
	// The intro dialog has one contenteditable and it is the headline; the
	// probe found no accessible name on it, so the count assertion in the fill
	// code is what keeps this honest if LinkedIn adds a second one.
	intro: {
		get url() {
			return `https://www.linkedin.com/in/${VANITY}/edit/intro/`;
		},
		control: '[contenteditable="true"]',
	},
	about: {
		get url() {
			return `https://www.linkedin.com/in/${VANITY}/edit/forms/summary/new/`;
		},
		control: '[contenteditable="true"]',
	},
	// No deep link for an existing position without its URN, so open the
	// experience list and click the edit control on the row for this company.
	position: {
		// No per-user deep link: a position editor URL carries a numeric id we
		// cannot know for someone else's profile. So "url" is the experience list
		// and open() finds the row by company match every time.
		get url() {
			return `https://www.linkedin.com/in/${VANITY}/details/experience/`;
		},
		get fallbackUrl() {
			return `https://www.linkedin.com/in/${VANITY}/details/experience/`;
		},
		control: '[contenteditable="true"]',
		// This editor carries "Share with your network" (probe 2026-09-11: Off).
		// A save with it on tells every connection about an edit; refuse.
		notifySwitch: true,
		open: openPosition,
	},
	project: {
		get url() {
			return `https://www.linkedin.com/in/${VANITY}/edit/forms/project/new/`;
		},
		control: "textarea", // Description is a plain textarea here, not a contenteditable
		titleLabel: "Project name", // getByLabel; the visible label is "Project name*"
		// An existing project has no stable deep link we know before opening the
		// list: its editor URL carries a numeric id (probe 2026-09-12:
		// /details/projects/edit/forms/<id>/). So open the list, let it lazy-load,
		// and click the edit link LinkedIn labels "Edit project <title>".
		get listUrl() {
			return `https://www.linkedin.com/in/${VANITY}/details/projects/`;
		},
		openExisting: findProjectEditor,
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
	if (!field?.skills) {
		console.error(`no skills list on ${addSkillsField}`);
		process.exit(1);
	}
	const surface = SURFACES[field.write.surface];
	const { readFileSync } = await import("node:fs");
	const mirror = JSON.parse(
		readFileSync(new URL("./mirror.json", import.meta.url), "utf8"),
	);
	const have = new Set(
		(field.readSkills?.(mirror) ?? []).map((s) => s.toLowerCase()),
	);
	const want = field.skills.filter((s) => !have.has(s.toLowerCase()));
	if (!want.length) {
		console.log(
			`all ${field.skills.length} desired skills already present; nothing to add`,
		);
		process.exit(0);
	}
	console.log(
		`adding ${want.length} of ${field.skills.length} skills (missing): ${want.join(", ")}`,
	);
	const mcp = startMcp({ clientName: "linkedin-write" });
	const shot = join(tmpdir(), "linkedin-addskills.png");
	try {
		await mcp.init();
		await resolveVanity(mcp);
		await mcp.ensureLoggedIn(VANITY);
		// One skill per fresh editor open + Save. A single browser call that does
		// the whole loop crashes the headless CDP Chrome partway (2026-09-12); the
		// writes that hold all day are each one dialog and one Save, so match that.
		const added = [],
			skipped = [];
		for (const skill of want) {
			await mcp.callTool("browser_navigate", { url: surface.url }, 60000);
			const raw = await mcp.runFn(addSkill, { skill, dryRun }, 90000);
			let r;
			try {
				r = JSON.parse(raw);
			} catch {
				r = { skill, state: "non-json", raw: raw.slice(0, 200) };
			}
			if (
				/^(added|already-present|clicked-unconfirmed|would-add|would-add-unconfirmed)$/.test(
					r.state,
				)
			)
				added.push(r);
			else skipped.push(r);
			console.log(`  ${skill}: ${r.state}`);
		}
		const out = { added, skipped };
		console.log(
			`\n  added/present: ${out.added.map((a) => a.skill).join(", ") || "none"}`,
		);
		if (out.skipped.length)
			console.log(
				`  needs a look: ${out.skipped.map((r) => `${r.skill} (${r.state})`).join(", ")}`,
			);
		console.log(
			"\nNow prove it: LINKEDIN_CDP=1 node export.mjs && node drift.mjs",
		);
		process.exit(out.skipped.length ? 1 : 0);
	} catch (err) {
		console.error(`\nFailed: ${err.message}\n  screenshot, if any: ${shot}`);
		process.exit(2);
	} finally {
		try {
			await mcp.callTool("browser_close", {}, 5000);
		} catch {}
		mcp.close();
	}
}

const deleteIdx = args.indexOf("--delete-project");
const deleteTitle = deleteIdx === -1 ? null : args[deleteIdx + 1];
const fieldId = deleteTitle ? null : args.find((a) => !a.startsWith("--"));
if (!fieldId && !deleteTitle) {
	console.error(
		'Usage: linkedin-write.mjs [--probe|--dry-run|--noop] <field-id>  |  linkedin-write.mjs [--dry-run] --delete-project "<title>"',
	);
	process.exit(1);
}
if (deleteTitle) {
	const mcp = startMcp({ clientName: "linkedin-write" });
	const shot = join(tmpdir(), `linkedin-${dryRun ? "dry" : "save"}-delete.png`);
	try {
		await mcp.init();
		await resolveVanity(mcp);
		await mcp.ensureLoggedIn(VANITY);
		const surface = SURFACES.project;
		console.log(
			`Opening ${surface.listUrl} to find the editor for "${deleteTitle}"`,
		);
		await mcp.callTool("browser_navigate", { url: surface.listUrl }, 60000);
		const found = JSON.parse(
			await mcp.runFn(
				surface.openExisting,
				{ title: deleteTitle, shot },
				60000,
			),
		);
		console.log(`  ${found.label} -> ${found.href}`);
		await mcp.callTool("browser_navigate", { url: found.href }, 60000);
		const raw = await mcp.runFn(
			deleteProject,
			{ title: deleteTitle, dryRun, shot },
			120000,
		);
		let out;
		try {
			out = JSON.parse(raw);
		} catch {
			throw new Error(`delete returned non-JSON:\n${raw.slice(0, 400)}`);
		}
		if (out.error) {
			console.error(`\n${out.error}\n  see: ${shot}`);
			process.exit(2);
		}
		console.log(JSON.stringify(out, null, 2));
		if (!dryRun)
			console.log(
				"\nNow prove it: LINKEDIN_CDP=1 node export.mjs && node drift.mjs",
			);
		process.exit(0);
	} catch (err) {
		console.error(`\nFailed: ${err.message}\n  screenshot, if any: ${shot}`);
		process.exit(2);
	} finally {
		try {
			await mcp.callTool("browser_close", {}, 5000);
		} catch {}
		mcp.close();
	}
}

const field = BY_ID.get(fieldId);
if (!field) {
	console.error(
		`Unknown field "${fieldId}". Known: ${[...BY_ID.keys()].join(", ")}`,
	);
	process.exit(1);
}
const surface = SURFACES[field.write.surface];
if (!surface) {
	console.error(`No surface "${field.write.surface}" for ${fieldId} yet`);
	process.exit(1);
}

const SHOT = join(
	tmpdir(),
	`linkedin-${probe ? "probe" : dryRun ? "dry" : noop ? "noop" : "save"}-${field.write.surface}.png`,
);

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
			const mirror = JSON.parse(
				readFileSync(new URL("./mirror.json", import.meta.url), "utf8"),
			);
			// No catch: a shape error here (Projects section missing from the mirror)
			// must stop the run. Swallowed, it reads as "absent" and the tool adds a
			// duplicate project on the live profile (review finding, 2026-09-12).
			existing = field.read(mirror);
		}
		if (existing !== undefined && surface.openExisting) {
			console.log(
				`Opening ${surface.listUrl} to find the editor for "${field.linkedinTitle}" (present in the mirror)`,
			);
			await mcp.callTool("browser_navigate", { url: surface.listUrl }, 60000);
			const found = JSON.parse(
				await mcp.runFn(
					surface.openExisting,
					{ title: field.linkedinTitle, shot: SHOT },
					60000,
				),
			);
			console.log(`  ${found.label} -> ${found.href}`);
			await mcp.callTool("browser_navigate", { url: found.href }, 60000);
			if (process.env.LINKEDIN_TRACE)
				console.log(
					"  trace after editor navigate:",
					await mcp.runFn(traceEditor, {}, 30000),
				);
		} else {
			console.log(`Opening ${surface.url}`);
			await mcp.callTool("browser_navigate", { url: surface.url }, 60000);
		}
		if (surface.open) {
			const dialogsRaw = (await mcp.runFn(countDialogs, {}, 20000)).trim();
			if (!/^\d+$/.test(dialogsRaw))
				throw new Error(
					`dialog-count probe returned non-numeric output: ${dialogsRaw.slice(0, 200)}`,
				);
			const dialogs = Number(dialogsRaw);
			if (dialogs === 0) {
				console.log(
					"Deep link opened no editor; falling back to the list and its edit control.",
				);
				await mcp.callTool(
					"browser_navigate",
					{ url: surface.fallbackUrl },
					60000,
				);
				const match = field.write.company;
				if (!match)
					throw new Error(
						`${fieldId} has no match="Company" to find its position row`,
					);
				const role = field.write.role;
				console.log(
					`Opening the editor for ${role ? `"${role}" at ` : "the row matching "}${JSON.stringify(match)}: ${await mcp.runFn(surface.open, { match, shot: SHOT, role: role ?? null }, 60000)}`,
				);
			}
		}

		const described = await mcp.runFn(describeDialog, { shot: SHOT }, 90000);
		let dialog;
		try {
			dialog = JSON.parse(described);
		} catch {
			throw new Error(`Dialog probe returned non-JSON:\n${described}`);
		}
		if (typeof dialog !== "object" || dialog === null)
			throw new Error(
				`Dialog probe returned ${typeof dialog}:\n${described.slice(0, 400)}`,
			);
		if (dialog.error) {
			console.error(
				`\n${dialog.error}\n  url:     ${dialog.url}\n  title:   ${dialog.title}\n  dialogs: ${dialog.dialogs}\n  see:     ${dialog.screenshot}`,
			);
			process.exit(2);
		}

		console.log("\nDialog:", dialog.heading ?? "(no heading)");
		console.log("URL:   ", dialog.url);
		console.log("\nControls:");
		for (const c of dialog.controls) {
			const kind =
				c.editable === "true"
					? `${c.tag}[ce]`
					: c.role
						? `${c.tag}[${c.role}]`
						: c.tag;
			console.log(
				`  ${kind.padEnd(14)} ${(c.label || c.ariaLabel || c.name || c.id || "?").slice(0, 34).padEnd(36)} max=${c.maxlength ?? "-"}  len=${String(c.valueLength).padStart(4)}  ${JSON.stringify(c.valueHead)}`,
			);
			if (c.checked !== null)
				console.log(
					`                 checked=${c.checked}  near: ${JSON.stringify(c.context)}`,
				);
		}
		console.log("\nButtons:", dialog.buttons.filter(Boolean).join(" | "));

		if (probe) {
			console.log("\n--probe: nothing changed.");
			process.exit(0);
		}

		const desired = noop ? null : parseBlocks().get(fieldId)?.text;
		if (!noop && !desired)
			throw new Error(
				`your source-of-truth file has no block for "${fieldId}"`,
			);
		const mode = dryRun ? "dry" : noop ? "noop" : "save";
		console.log(
			`\n${{ dry: "--dry-run: filling, not saving", noop: "--noop: re-saving current text", save: "Writing" }[mode]} ${fieldId}${desired ? ` (${[...desired].length} chars)` : ""}.`,
		);

		if (
			existing !== undefined &&
			dialog.heading &&
			!/edit/i.test(dialog.heading)
		) {
			throw new Error(
				`${fieldId} exists on LinkedIn but the open dialog is "${dialog.heading}", not an editor; not saving`,
			);
		}
		if (field.write.match?.subtitle) {
			// The position editor must be the one for this company, whichever path opened it.
			const re = field.write.match.subtitle;
			if (
				!dialog.controls.some(
					(c) => re.test(c.valueHead ?? "") || re.test(c.label ?? ""),
				)
			) {
				throw new Error(
					`the open position editor shows no control matching ${re}; not saving`,
				);
			}
		}
		const raw = await mcp.runFn(
			fillDialog,
			{
				control: surface.control,
				text: desired ?? "",
				mode,
				shot: SHOT,
				title: surface.titleLabel ? field.linkedinTitle : null,
				titleLabel: surface.titleLabel,
				notifySwitch: surface.notifySwitch,
				dates: field.dates,
				editing: existing !== undefined,
				monthNames: MONTH_NAMES,
			},
			120000,
		);
		let out;
		try {
			out = JSON.parse(raw);
		} catch {
			throw new Error(`fill returned non-JSON:\n${raw.slice(0, 400)}`);
		}
		if (out.error) {
			console.error(
				`\n${out.error}${out.after ? `\n  field now reads: ${JSON.stringify(out.after)}` : ""}\n  see: ${SHOT}`,
			);
			process.exit(2);
		}
		console.log(
			`  before: ${out.beforeLength} chars  after: ${out.afterLength} chars  matches desired: ${out.matches}`,
		);
		if (out.dates)
			console.log(`  dates read back: ${JSON.stringify(out.dates)}`);
		if (!out.matches && out.after)
			console.log(`  field reads: ${JSON.stringify(out.after)}`);
		console.log(
			`  ${mode === "dry" ? "discarded" : "saved"}; dialog ${out.dialogGone ? "closed" : "STILL OPEN"}${out.notifyNetwork ? `; share-with-network was ${out.notifyNetwork}` : ""}${out.pageClosedAfterSave ? "; page closed after Save (headless does this; the export decides)" : ""}; see ${SHOT}`,
		);
		if (mode !== "dry")
			console.log(
				"\nNow prove it: LINKEDIN_CDP=1 node export.mjs && node drift.mjs",
			);
		process.exit(out.matches ? 0 : 1);
	} catch (err) {
		console.error(`\nFailed: ${err.message}\n  screenshot, if any: ${SHOT}`);
		process.exitCode = 2;
	}
} finally {
	try {
		await mcp.callTool("browser_close", {}, 5000);
	} catch {}
	mcp.close();
}
