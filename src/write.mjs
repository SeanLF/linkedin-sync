#!/usr/bin/env node

// Writes fields of your source-of-truth file (linkedin.md) to LinkedIn
// through its own edit UI. A field is whatever the file declares.
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
//   node write.mjs headline about project.x   several fields, one browser session
//   node write.mjs --all-drift          every field drift reports stale
//   node write.mjs --add-skills <pos>   add a position's missing skills
//   node write.mjs --delete-project "<title>"
//   node write.mjs education.msc        an education / honor / publication /
//                                       volunteer / certification block
//   node write.mjs skills               add missing skills, delete extra ones
//   node write.mjs --delete honor "<title>"   (or education, publication,
//                                       volunteer, certification, skill)
//   node write.mjs --add-link project.x attach the block's link= as media
//   node write.mjs --remove-media project.x "<media title>"   remove one item
//   --json                              a JSON line per field and per batch on
//                                       stdout; the human log goes to stderr
//   --screenshots (or LINKEDIN_SCREENSHOTS=1)  a screenshot at every step;
//                                       without it, only a failing field gets one
//
// Run with LINKEDIN_CDP=1. After any save, prove it landed:
//   node export.mjs && node drift.mjs   (the "saved" line is never the proof)
// write does that itself after any real write: it re-exports, compares every
// field, lists what is still stale or unreadable and exits non-zero if
// anything is (--no-verify skips it).
//
// Several fields share one MCP server, one Chrome attach, one login check and
// one tab; each still opens its own editor by a fresh navigation, is filled,
// read back and saved (or discarded) on its own, and fails on its own. A
// failing field does not stop the batch; the exit code is the worst field's.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { overLimit, parseBlocks } from "./copy-blocks.mjs";
import {
	compareAll,
	staleFields,
	UNWRITTEN_FACETS,
	VERDICTS,
} from "./drift.mjs";
import {
	addSkill,
	deleteProject,
	describeDialog,
	fillDialog,
	findProjectEditor,
	openPosition,
	traceEditor,
} from "./inpage.mjs";
import { startMcp } from "./mcp.mjs";
import {
	fieldsFromBlocks,
	MIRROR_MAX_AGE_DAYS,
	MONTH_NAMES,
	mirrorAgeDays,
} from "./schema.mjs";
import {
	addLink,
	assertFreshForCreate,
	deleteSectionEntry,
	failureShot,
	removeMedia,
	shotPath,
	step,
	unknownFlags,
	WRITE_FLAGS,
	withBrowser,
	writeFormField,
	writeSkills,
} from "./write-sections.mjs";

const MIRROR = new URL("./mirror.json", import.meta.url);
// When the last save started. --all-drift refuses a mirror older than this:
// an entry created since the export still reads as absent, and writing it
// again would add a duplicate.
const LAST_WRITE = new URL("./last-write.json", import.meta.url);
const readMirror = () => JSON.parse(readFileSync(MIRROR, "utf8"));
const at = (vanity, path) => `https://www.linkedin.com/in/${vanity}/${path}`;

const args = process.argv.slice(2);
const unknown = unknownFlags(args);
if (unknown.length) {
	console.error(
		`Unknown option${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; nothing written. Known: ${WRITE_FLAGS.join(" ")}`,
	);
	process.exit(1);
}

// Fields are whatever the source-of-truth file declares (id -> field def).
const BLOCKS = parseBlocks();
const { fields: FIELDS, byId: BY_ID } = fieldsFromBlocks(BLOCKS);

// LinkedIn's limits are checked before a browser opens, on the blocks about
// to be written: over-long text, an attribute past its counter, a skills list
// past 100 or a skill past 80 characters. True when it refused.
function overLimitRefused(ids) {
	const problems = overLimit(
		new Map(
			ids.filter((id) => BLOCKS.has(id)).map((id) => [id, BLOCKS.get(id)]),
		),
	);
	if (!problems.length) return false;
	console.error(`Over LinkedIn's limits; nothing written:`);
	for (const p of problems) console.error(`  ${p}`);
	return true;
}

// Where each edit surface lives. Deep links open the dialog directly; if
// LinkedIn stops honouring one, the probe reports "no dialog" and this table
// is what to fix.
const SURFACES = {
	// The intro dialog has one contenteditable and it is the headline; the
	// probe found no accessible name on it, so the count assertion in the fill
	// code is what keeps this honest if LinkedIn adds a second one.
	intro: {
		url: (v) => at(v, "edit/intro/"),
		control: '[contenteditable="true"]',
	},
	about: {
		url: (v) => at(v, "edit/forms/summary/new/"),
		control: '[contenteditable="true"]',
	},
	// A role the structured export pins down opens by deep link
	// (details/experience/edit/forms/<id>/). Otherwise, open the experience
	// list and click the edit control on the row for this company.
	position: {
		listUrl: (v) => at(v, "details/experience/"),
		control: '[contenteditable="true"]',
		// This editor carries "Share with your network" (probe 2026-09-11: Off).
		// A save with it on tells every connection about an edit; refuse.
		notifySwitch: true,
		open: openPosition,
	},
	project: {
		url: (v) => at(v, "edit/forms/project/new/"),
		control: "textarea", // Description is a plain textarea here, not a contenteditable
		titleLabel: "Project name", // getByLabel; the visible label is "Project name*"
		// An existing project opens by deep link from its id in the structured
		// export (details/projects/edit/forms/<id>/, as --add-link does). Without
		// one, open the list, let it lazy-load, and take the edit link LinkedIn
		// labels "Edit project <title>" (probe 2026-09-12).
		listUrl: (v) => at(v, "details/projects/"),
		openExisting: findProjectEditor,
	},
};

const probe = args.includes("--probe");
const dryRun = args.includes("--dry-run");
const noop = args.includes("--noop"); // save the field's current text back: proves Save without changing anything visible
const screenshots =
	args.includes("--screenshots") || process.env.LINKEDIN_SCREENSHOTS === "1";
const saving = !dryRun && !probe;
// --json: one JSON object per line on stdout for each field and one for the
// batch, for an agent to read; everything a person reads moves to stderr.
const json = args.includes("--json");
const emit = json
	? (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
	: () => {};
if (json) console.log = (...a) => console.error(...a);
const sectionMode = dryRun ? "dry" : "save";
const session = (fn) => withBrowser(fn, { screenshots });

let wrote = false;
function markWrite(what) {
	wrote = true;
	try {
		writeFileSync(
			LAST_WRITE,
			`${JSON.stringify({ at: new Date().toISOString(), what }, null, 2)}\n`,
		);
	} catch (err) {
		console.error(
			`  (could not record the write in ${LAST_WRITE.pathname}: ${err.message})`,
		);
	}
}

/** The role's editor deep link from the mirror, if the export pins it to one id. */
function positionDeepLink(field, vanity) {
	if (!field.positionId) return null;
	let id;
	try {
		id = field.positionId(readMirror());
	} catch {}
	return id ? at(vanity, `details/experience/edit/forms/${id}/`) : null;
}

/** An existing project's editor deep link, when exactly one exported project has the title. */
function projectDeepLink(mirror, title, vanity) {
	const rows = (mirror?.entities?.projects ?? []).filter(
		(p) => p.title === title && p.id,
	);
	return rows.length === 1
		? at(vanity, `details/projects/edit/forms/${rows[0].id}/`)
		: null;
}

/** Open a project's editor from the projects list (the no-deep-link path). */
async function openProjectFromList(mcp, vanity, title, pageShot) {
	const listUrl = SURFACES.project.listUrl(vanity);
	console.log(`Opening ${listUrl} to find the editor for "${title}"`);
	await mcp.callTool("browser_navigate", { url: listUrl }, 60000);
	const found = JSON.parse(
		await mcp.runFn(findProjectEditor, { title, shot: pageShot }, 60000),
	);
	console.log(`  ${found.label} -> ${found.href}`);
	await mcp.callTool("browser_navigate", { url: found.href }, 60000);
}

/** Open a role's editor from the experience list (the no-deep-link path). */
async function openPositionFromList(mcp, vanity, field, pageShot) {
	const match = field.write.company;
	if (!match)
		throw new Error(
			`${field.id} has no match="Company" to find its position row`,
		);
	const role = field.write.role;
	await mcp.callTool(
		"browser_navigate",
		{ url: SURFACES.position.listUrl(vanity) },
		60000,
	);
	console.log(
		`Opening the editor for ${role ? `"${role}" at ` : "the row matching "}${JSON.stringify(match)}: ${await mcp.runFn(openPosition, { match, shot: pageShot, role: role ?? null }, 60000)}`,
	);
}

/** Headline, About, a position or a project: one dialog, one text control. */
async function writeTextField({ mcp, vanity, shot, pageShot }, field) {
	const fieldId = field.id;
	const surface = SURFACES[field.write.surface];
	if (!surface) {
		console.error(`No surface "${field.write.surface}" for ${fieldId} yet`);
		return 1;
	}

	// A project that already exists on LinkedIn (per the mirror) is edited in
	// place; one that does not is added through the "new" form. Both paths end
	// in the same dialog, so everything after this is shared.
	let existing;
	let mirror;
	if (field.write.createIfAbsent) {
		mirror = readMirror();
		// No catch: a shape error here (Projects section missing from the mirror)
		// must stop the run. Swallowed, it reads as "absent" and the tool adds a
		// duplicate project on the live profile (review finding, 2026-09-12).
		existing = field.read(mirror);
		if (existing === undefined && !probe)
			assertFreshForCreate(mirror, field.label);
	}
	const editingProject = existing !== undefined && surface.openExisting;

	// Each path opens the editor; a deep link that opens none falls back to the
	// list once, after the dialog probe (which waits for a dialog) says so.
	let fallback = null;
	if (editingProject) {
		const deep = projectDeepLink(mirror, field.linkedinTitle, vanity);
		const fromList = () =>
			openProjectFromList(mcp, vanity, field.linkedinTitle, pageShot);
		if (deep) {
			console.log(
				`Opening ${deep} (the editor for "${field.linkedinTitle}", present in the mirror)`,
			);
			await mcp.callTool("browser_navigate", { url: deep }, 60000);
			fallback = fromList;
		} else await fromList();
	} else if (surface.open) {
		// The edit control's click is a navigation, and under headless that took
		// the browser down (2026-10-29), as the project list's click did: so the
		// deep link first, the list only when there is none or it fails.
		const deep = positionDeepLink(field, vanity);
		const fromList = () => openPositionFromList(mcp, vanity, field, pageShot);
		if (deep) {
			console.log(`Opening ${deep}`);
			await mcp.callTool("browser_navigate", { url: deep }, 60000);
			fallback = fromList;
		} else await fromList();
	} else {
		const url = surface.url(vanity);
		console.log(`Opening ${url}`);
		await mcp.callTool("browser_navigate", { url }, 60000);
	}
	if (process.env.LINKEDIN_TRACE)
		console.log(
			"  trace after editor navigate:",
			await mcp.runFn(traceEditor, {}, 30000),
		);

	const describe = async () => {
		const described = await mcp.runFn(
			describeDialog,
			{ shot: pageShot },
			90000,
		);
		let d;
		try {
			d = JSON.parse(described);
		} catch {
			throw new Error(`Dialog probe returned non-JSON:\n${described}`);
		}
		if (typeof d !== "object" || d === null)
			throw new Error(
				`Dialog probe returned ${typeof d}:\n${described.slice(0, 400)}`,
			);
		return d;
	};
	let dialog = await describe();
	if (fallback && dialog.error && /^no dialog/.test(dialog.error)) {
		console.log(
			"Deep link opened no editor; falling back to the list and its edit control.",
		);
		await fallback();
		dialog = await describe();
	}
	if (dialog.error) {
		console.error(
			`\n${dialog.error}\n  url:     ${dialog.url}\n  title:   ${dialog.title}\n  dialogs: ${dialog.dialogs}\n  see:     ${shot}`,
		);
		return 2;
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
		return 0;
	}

	const desired = noop ? null : BLOCKS.get(fieldId)?.text;
	if (!noop && !desired)
		throw new Error(`your source-of-truth file has no block for "${fieldId}"`);
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
			shot: pageShot,
			title: surface.titleLabel ? field.linkedinTitle : null,
			titleLabel: surface.titleLabel,
			notifySwitch: surface.notifySwitch,
			dates: field.dates,
			dateLabels: field.write.dateLabels ?? null,
			// A role's company, when the block carries company="..."
			extra: field.write.companyTo
				? [
						{
							pattern: "^Company or organization",
							value: field.write.companyTo,
						},
					]
				: null,
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
			`\n${out.error}${out.after ? `\n  field now reads: ${JSON.stringify(out.after)}` : ""}\n  see: ${shot}`,
		);
		return 2;
	}
	console.log(
		`  before: ${out.beforeLength} chars  after: ${out.afterLength} chars  matches desired: ${out.matches}`,
	);
	if (out.dates)
		console.log(
			`  dates read back: ${JSON.stringify(out.dates)}${out.datesWanted ? (out.datesMatch ? " (as the record)" : `  WANTED ${JSON.stringify(out.datesWanted)}`) : ""}`,
		);
	if (out.extra)
		for (const x of out.extra)
			console.log(
				`  /${x.pattern}/ reads ${JSON.stringify(x.got)}${x.got === x.want ? "" : `  WANTED ${JSON.stringify(x.want)}`}`,
			);
	if (!out.matches && out.after)
		console.log(`  field reads: ${JSON.stringify(out.after)}`);
	console.log(
		`  ${mode === "dry" ? "discarded" : "saved"}; dialog ${out.dialogGone ? "closed" : "STILL OPEN"}${out.notifyNetwork ? `; share-with-network was ${out.notifyNetwork}` : ""}${out.pageClosedAfterSave ? "; page closed after Save (headless does this; the export decides)" : ""}${pageShot ? `; see ${shot}` : ""}`,
	);
	if (!out.dialogGone) {
		await failureShot({ mcp, shot });
		console.log(`  screenshot: ${shot}`);
	}
	// A save that left the dialog open did not save (LinkedIn's validation
	// keeps it up), unless headless closed the page, where the export decides.
	const closed =
		mode === "dry" || out.dialogGone || Boolean(out.pageClosedAfterSave);
	return out.matches &&
		out.datesMatch !== false &&
		out.extraMatch !== false &&
		closed
		? 0
		: 1;
}

/** One field, whichever writer its type needs. */
function writeField(ctx, id) {
	const field = BY_ID.get(id);
	if (field.form)
		return writeFormField(ctx, field, {
			mode: sectionMode,
			probe,
			description: BLOCKS.get(id).text,
		});
	if (field.liveSkills)
		return writeSkills(ctx, field, {
			dryRun,
			desiredText: BLOCKS.get(id).text,
			allowMassRemove: args.includes("--allow-mass-remove"),
		});
	return writeTextField(ctx, field);
}

/** The ids `--all-drift` adds, or an exit code when the mirror cannot say. */
function driftIds() {
	let mirror;
	try {
		mirror = readMirror();
	} catch (err) {
		console.error(
			`--all-drift needs the mirror (${MIRROR.pathname}): ${err.message}\nRun: LINKEDIN_CDP=1 node src/export.mjs`,
		);
		return 2;
	}
	const age = mirrorAgeDays(mirror);
	const maxIdx = args.indexOf("--max-age-days");
	const maxAge = maxIdx === -1 ? MIRROR_MAX_AGE_DAYS : Number(args[maxIdx + 1]);
	if (age === null || age > maxAge) {
		console.error(
			`--all-drift: the mirror is ${age === null ? "of unknown age" : `${age.toFixed(1)} days old (limit ${maxAge})`}; re-export first: LINKEDIN_CDP=1 node src/export.mjs`,
		);
		return 2;
	}
	let last = null;
	try {
		last = JSON.parse(readFileSync(LAST_WRITE, "utf8"));
	} catch {}
	if (last && Date.parse(last.at) > Date.parse(mirror.exportedAt)) {
		console.error(
			`--all-drift: the mirror (${mirror.exportedAt}) predates the last write (${last.at}). An entry created since reads as absent and would be created twice. Re-export first: LINKEDIN_CDP=1 node src/export.mjs`,
		);
		return 2;
	}
	const { stale, unwritten, unreadable } = staleFields(FIELDS, mirror, BLOCKS);
	if (unreadable.length) {
		console.error(
			`--all-drift: drift cannot read ${unreadable.join(", ")}; run drift and fix that first`,
		);
		return 2;
	}
	if (unwritten.length)
		console.log(
			`--all-drift leaves ${unwritten.join(", ")} (a link is --add-link; media is LinkedIn's preview)`,
		);
	console.log(
		`--all-drift: ${stale.length} stale field(s)${stale.length ? `: ${stale.join(", ")}` : ""}`,
	);
	return stale;
}

/** Write every id in one session; a summary when there is more than one. */
async function writeFields(ids) {
	const label = probe ? "probe" : dryRun ? "dry" : noop ? "noop" : "save";
	if (saving) markWrite(ids);
	return session(async (ctx) => {
		const results = [];
		for (const [i, id] of ids.entries()) {
			if (ids.length > 1) {
				// Progress, with an ETA from the fields done so far.
				const done = results.reduce((t, r) => t + r.secs, 0);
				const eta = i
					? ` | ETA ${Math.round((done / i) * (ids.length - i))}s`
					: "";
				const bad = results.filter((r) => r.code).length;
				console.log(
					`\n=== [${i + 1}/${ids.length}] ${id} | ${i - bad} ok, ${bad} failed${eta}`,
				);
			}
			const t0 = performance.now();
			const code = await step(ctx, `${label}-${id}`, (sub) =>
				writeField(sub, id),
			);
			const secs = (performance.now() - t0) / 1000;
			results.push({ id, code, secs });
			console.log(
				`  ${id}: ${code ? `FAILED (${code})` : "ok"} in ${secs.toFixed(1)}s`,
			);
			emit({
				event: "field",
				id,
				mode: label,
				ok: code === 0,
				code,
				secs: Number(secs.toFixed(2)),
				n: i + 1,
				total: ids.length,
				...(code ? { screenshot: shotPath(`${label}-${id}`) } : {}),
			});
			// A crashed browser fails every field after it; reconnect (relaunching
			// Chrome if it is gone) rather than report the rest as failures too.
			// The failed field is never retried: a create that half-landed would
			// be created twice.
			if (code === 2 && i < ids.length - 1 && !(await ctx.mcp.alive())) {
				console.error(
					"  the browser stopped answering; reconnecting for the rest",
				);
				ctx.mcp.close();
				ctx.mcp = startMcp({ clientName: "linkedin-write" });
				await ctx.mcp.init();
				if (!process.env.LINKEDIN_VANITY) await ctx.mcp.getVanity();
				await ctx.mcp.ensureLoggedIn(ctx.vanity);
			}
		}
		if (ids.length > 1) {
			const total = results.reduce((t, r) => t + r.secs, 0);
			console.log(
				`\n${results.length} fields in ${total.toFixed(1)}s (${(total / results.length).toFixed(1)}s each):`,
			);
			for (const r of results)
				console.log(
					`  ${(r.code === 0 ? "ok" : `FAIL(${r.code})`).padEnd(7)} ${r.id.padEnd(40)} ${r.secs.toFixed(1)}s`,
				);
		}
		const worst = Math.max(0, ...results.map((r) => r.code));
		emit({
			event: "batch",
			mode: label,
			code: worst,
			ok: results.filter((r) => !r.code).map((r) => r.id),
			failed: results.filter((r) => r.code).map((r) => r.id),
			secs: Number(results.reduce((t, r) => t + r.secs, 0).toFixed(2)),
		});
		return worst;
	});
}

// --- --add-skills <field-id> ---
// Add the schema's desired skills for a role that are not already on it (per
// the mirror), through the role editor's skill typeahead. Idempotent. Proof is
// export + a presence check, like every write.
async function addPositionSkills(fieldId) {
	const field = BY_ID.get(fieldId);
	if (!field?.skills) {
		console.error(`no skills list on ${fieldId}`);
		return 1;
	}
	if (overLimitRefused([fieldId])) return 1;
	const have = new Set(
		(field.readSkills?.(readMirror()) ?? []).map((s) => s.toLowerCase()),
	);
	const want = field.skills.filter((s) => !have.has(s.toLowerCase()));
	if (!want.length) {
		console.log(
			`all ${field.skills.length} desired skills already present; nothing to add`,
		);
		return 0;
	}
	console.log(
		`adding ${want.length} of ${field.skills.length} skills (missing): ${want.join(", ")}`,
	);
	if (!dryRun) markWrite([`--add-skills ${fieldId}`]);
	return session((ctx) =>
		step(ctx, "addskills", async ({ mcp, vanity, pageShot }) => {
			// One skill per fresh editor open + Save. A single browser call that
			// does the whole loop crashes the headless CDP Chrome partway
			// (2026-09-12); the writes that hold all day are each one dialog and
			// one Save, so match that.
			const added = [];
			const skipped = [];
			const deep = positionDeepLink(field, vanity);
			for (const skill of want) {
				if (deep) await mcp.callTool("browser_navigate", { url: deep }, 60000);
				else await openPositionFromList(mcp, vanity, field, pageShot);
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
			console.log(
				`\n  added/present: ${added.map((a) => a.skill).join(", ") || "none"}`,
			);
			if (skipped.length)
				console.log(
					`  needs a look: ${skipped.map((r) => `${r.skill} (${r.state})`).join(", ")}`,
				);
			return skipped.length ? 1 : 0;
		}),
	);
}

// --- --delete-project "<exact LinkedIn title>" ---
// Open that project's editor, press "Delete project", and confirm. Not a
// schema field: the projects worth deleting are the ones the record never
// carried. --dry-run stops at the confirmation and reports its buttons, which
// is also how the dialog was probed.
async function deleteProjectByTitle(title) {
	if (!dryRun) markWrite([`--delete-project ${title}`]);
	return session((ctx) =>
		step(
			ctx,
			`${dryRun ? "dry" : "save"}-delete`,
			async ({ mcp, vanity, shot, pageShot }) => {
				let mirror = null;
				try {
					mirror = readMirror();
				} catch {}
				const deep = projectDeepLink(mirror, title, vanity);
				if (deep) {
					console.log(`Opening ${deep}`);
					await mcp.callTool("browser_navigate", { url: deep }, 60000);
				} else await openProjectFromList(mcp, vanity, title, pageShot);
				const raw = await mcp.runFn(
					deleteProject,
					{ title, dryRun, shot: pageShot },
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
					return 2;
				}
				console.log(JSON.stringify(out, null, 2));
				// A dry run that reached no Delete, or a delete that left the
				// editor open, is not done.
				return (dryRun ? out.wouldClick : out.editorGone) ? 0 : 1;
			},
		),
	);
}

const USAGE =
	'Usage: write.mjs [--probe|--dry-run|--noop] [--screenshots] [--json] <field-id>... | --all-drift  |  [--dry-run] --delete-project "<title>"  |  [--dry-run] --delete <type> "<title, name or match>"  |  [--dry-run] --add-link <project-id>  |  [--dry-run] --remove-media <project-id> "<media title>"  |  [--dry-run] --add-skills <position-id>';

async function main() {
	const addSkillsIdx = args.indexOf("--add-skills");
	if (addSkillsIdx !== -1) return addPositionSkills(args[addSkillsIdx + 1]);

	const delIdx = args.indexOf("--delete");
	if (delIdx !== -1) {
		const type = args[delIdx + 1];
		const words = args.slice(delIdx + 2).filter((a) => !a.startsWith("--"));
		if (!type || !words.length) {
			console.error(
				'Usage: write.mjs [--dry-run] --delete <education|honor|publication|volunteer|certification|skill> "<title, name or match>" [role="..."]',
			);
			return 1;
		}
		if (!dryRun) markWrite([`--delete ${type} ${words.join(" ")}`]);
		return session((ctx) =>
			step(ctx, `${sectionMode}-delete`, (sub) =>
				deleteSectionEntry(sub, type, words, { dryRun }),
			),
		);
	}

	const linkIdx = args.indexOf("--add-link");
	if (linkIdx !== -1) {
		const field = BY_ID.get(args[linkIdx + 1]);
		if (!field?.linkedinTitle) {
			console.error(
				`--add-link takes a project block id; got ${args[linkIdx + 1]}`,
			);
			return 1;
		}
		if (overLimitRefused([field.id])) return 1;
		if (!dryRun) markWrite([`--add-link ${field.id}`]);
		return session((ctx) =>
			step(ctx, `${sectionMode}-link`, (sub) =>
				addLink(sub, field, { dryRun }),
			),
		);
	}

	const mediaIdx = args.indexOf("--remove-media");
	if (mediaIdx !== -1) {
		const field = BY_ID.get(args[mediaIdx + 1]);
		const media = args[mediaIdx + 2];
		if (!field?.linkedinTitle || !media || media.startsWith("--")) {
			console.error(
				'Usage: write.mjs [--dry-run] --remove-media <project-id> "<media title>"',
			);
			return 1;
		}
		if (!dryRun) markWrite([`--remove-media ${field.id} ${media}`]);
		return session((ctx) =>
			step(ctx, `${sectionMode}-media`, (sub) =>
				removeMedia(sub, field, media, { dryRun }),
			),
		);
	}

	const deleteIdx = args.indexOf("--delete-project");
	if (deleteIdx !== -1) {
		const title = args[deleteIdx + 1];
		if (!title) {
			console.error(USAGE);
			return 1;
		}
		return deleteProjectByTitle(title);
	}

	// Fields: every bare argument (not a flag's value), then --all-drift's.
	const valued = new Set(["--max-age-days"]);
	const ids = args.filter(
		(a, i) => !a.startsWith("--") && !valued.has(args[i - 1]),
	);
	if (args.includes("--all-drift")) {
		const more = driftIds();
		if (typeof more === "number") return more;
		for (const id of more) if (!ids.includes(id)) ids.push(id);
		if (!ids.length) {
			console.log("Nothing stale; nothing to write.");
			return 0;
		}
	}
	if (!ids.length) {
		console.error(USAGE);
		return 1;
	}
	const unknown = ids.filter((id) => !BY_ID.has(id));
	if (unknown.length) {
		console.error(
			`Unknown field(s) ${unknown.map((u) => `"${u}"`).join(", ")}. Known: ${[...BY_ID.keys()].join(", ")}`,
		);
		return 1;
	}
	const sections = ids.filter(
		(id) => BY_ID.get(id).form || BY_ID.get(id).liveSkills,
	);
	if (noop && sections.length) {
		console.error(
			`--noop is for the text fields (headline, about, a position, a project), not ${sections.join(", ")}`,
		);
		return 1;
	}
	// The skills writer has no read-only mode: --probe there would have saved.
	const skills = ids.filter((id) => BY_ID.get(id).liveSkills);
	if (probe && skills.length) {
		console.error(
			`--probe opens a dialog and reports it; ${skills.join(", ")} has none. Use --dry-run.`,
		);
		return 1;
	}
	if (overLimitRefused(ids)) return 1;
	return writeFields(ids);
}

/**
 * After a real write: re-export and compare every field, so a field that did
 * not land, or that the batch left out, is raised here rather than by whoever
 * next remembers to run drift. Exit 1 if anything is stale, 2 if the export
 * failed or a field is unreadable.
 */
function verify() {
	console.log(
		"\nVerifying: re-exporting the profile and comparing every field (--no-verify skips this)",
	);
	const r = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("./export.mjs", import.meta.url))],
		{ stdio: ["ignore", 2, 2], env: process.env },
	);
	if (r.status !== 0) {
		console.error(
			`\nVerify: the export failed (exit ${r.status}); nothing is proven.`,
		);
		emit({ event: "verify", ok: false, code: 2, error: "export failed" });
		return 2;
	}
	const mirror = readMirror();
	const off = FIELDS.flatMap((f) => compareAll(f, mirror, BLOCKS)).filter(
		(x) =>
			x.verdict === VERDICTS.DRIFT ||
			x.verdict === VERDICTS.ABSENT ||
			x.verdict === VERDICTS.UNREADABLE,
	);
	const unreadable = off.filter((x) => x.verdict === VERDICTS.UNREADABLE);
	const stale = off.filter((x) => x.verdict !== VERDICTS.UNREADABLE);
	const facet = (id) => id.split(".").slice(2).join(".");
	console.log(
		`\nVerify (mirror ${mirror.exportedAt}): ${FIELDS.length} blocks, ${stale.length} stale, ${unreadable.length} unreadable`,
	);
	for (const x of off)
		console.log(
			`  ${x.verdict === VERDICTS.UNREADABLE ? "BROKEN" : x.verdict === VERDICTS.ABSENT ? "ABSENT" : "DRIFT "}  ${x.id}${UNWRITTEN_FACETS.has(facet(x.id)) ? "  (not written by write <id>)" : ""}`,
		);
	const code = unreadable.length ? 2 : stale.length ? 1 : 0;
	emit({
		event: "verify",
		ok: code === 0,
		code,
		mirror: mirror.exportedAt,
		stale: stale.map((x) => x.id),
		unreadable: unreadable.map((x) => x.id),
	});
	return code;
}

let code = await main();
if (wrote && !args.includes("--no-verify")) code = Math.max(code, verify());
else if (wrote)
	console.log(
		"\n--no-verify: prove it yourself: LINKEDIN_CDP=1 node src/export.mjs && node src/drift.mjs",
	);
process.exit(code);
