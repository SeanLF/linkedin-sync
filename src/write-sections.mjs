// The writers for the sections added after positions and projects: the form
// sections (education, honours, publications, volunteering, certifications),
// the skills list, deletes, and a project's link. write.mjs dispatches here.
//
// Same rules as the field writer: drive the edit UI, never the RSC actions;
// read the mirror first and stop on a shape error rather than guess; a dry
// run fills (or reaches the confirmation) and discards; the proof of any save
// is a re-export and drift, never the "saved" line.
//
// Every editor is opened by deep link. The structured export carries each
// entry's numeric id, and LinkedIn's editor URLs are built from it
// (/details/education/edit/forms/<id>/, probe 2026-10-29), so nothing here
// scrolls a list looking for an edit button.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addProfileSkill,
	addProjectLink,
	deleteEntry,
	describeDialog,
	fillForm,
	removeProjectMedia,
	takeScreenshot,
} from "./inpage.mjs";
import { startMcp } from "./mcp.mjs";
import {
	fieldFromBlock,
	identityAttr,
	MIRROR_MAX_AGE_DAYS,
	mirrorAgeDays,
	planSkills,
} from "./schema.mjs";

export const readMirror = () =>
	JSON.parse(readFileSync(new URL("./mirror.json", import.meta.url), "utf8"));

// Every flag write.mjs takes. Anything else starting with "--" is refused
// before a browser opens: a mistyped --dryrun would otherwise be ignored and
// the run would save.
export const WRITE_FLAGS = [
	"--probe",
	"--dry-run",
	"--noop",
	"--add-skills",
	"--delete-project",
	"--delete",
	"--add-link",
	"--allow-mass-remove",
	"--all-drift",
	"--max-age-days",
	"--remove-media",
	"--screenshots",
	"--json",
	"--no-verify",
];
/** The arguments that look like flags and are not ones write.mjs knows. */
export const unknownFlags = (args) =>
	args.filter((a) => a.startsWith("--") && !WRITE_FLAGS.includes(a));

// The flags that pick a command other than "write these fields". None of them
// has a read-only mode for --probe or a re-save for --noop, so either with one
// of them is refused: ignored, the command would run and save for real.
export const MODE_FLAGS = [
	"--delete",
	"--add-skills",
	"--add-link",
	"--remove-media",
	"--delete-project",
];
/** Why these arguments are refused before anything runs, or null. */
export function conflictingFlags(args) {
	const modes = MODE_FLAGS.filter((f) => args.includes(f));
	const readOnly = ["--probe", "--noop"].filter((f) => args.includes(f));
	if (modes.length && readOnly.length)
		return `${readOnly.join(" and ")} cannot go with ${modes.join(", ")} (it would run for real); use --dry-run`;
	return null;
}

/**
 * --max-age-days N, or the default when it is absent. A missing or
 * non-numeric N throws: Number(undefined) is NaN, and `age > NaN` is false,
 * so a bad value would have switched the age guard off.
 */
export function maxAgeDays(args) {
	const i = args.indexOf("--max-age-days");
	if (i === -1) return MIRROR_MAX_AGE_DAYS;
	const v = args[i + 1];
	if (v === undefined || !/^\d+(\.\d+)?$/.test(v))
		throw new Error(
			`--max-age-days takes a number of days; got ${v === undefined ? "nothing" : JSON.stringify(v)}`,
		);
	return Number(v);
}

/**
 * The field ids in the arguments: every bare one that is not a flag's value,
 * each once. A field named twice in one batch would be written twice, and a
 * create twice is a duplicate entry.
 */
export function fieldIds(args) {
	const valued = new Set(["--max-age-days"]);
	return [
		...new Set(
			args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1])),
		),
	];
}

// When the last save started (write.mjs records it before any save runs).
export const LAST_WRITE = new URL("./last-write.json", import.meta.url);
/** The last recorded write, or null when there is none. */
export function readLastWrite() {
	try {
		return JSON.parse(readFileSync(LAST_WRITE, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Throw unless the mirror is fresh enough to say an entry is absent. Creating
 * is the one write a stale or partial mirror turns into damage: an entry added
 * by hand since the export reads as missing, and the writer adds it again.
 * The same holds for a save this tool made after the export: a run that
 * crashed after its create landed, rerun on the old mirror, creates it twice.
 * `lastWrite` is the write recorded before this run started; write.mjs passes
 * it in, since its own run records a new one before the first save.
 */
export function assertFreshForCreate(
	mirror,
	what,
	lastWrite = readLastWrite(),
) {
	const age = mirrorAgeDays(mirror);
	if (age === null || age > MIRROR_MAX_AGE_DAYS)
		throw new Error(
			`${what} is not in the mirror, but the mirror is ${age === null ? "of unknown age" : `${age.toFixed(1)} days old`} (limit ${MIRROR_MAX_AGE_DAYS}); not creating it from a stale read. Re-export first.`,
		);
	const last = Date.parse(lastWrite?.at ?? "");
	if (last > Date.parse(mirror.exportedAt))
		throw new Error(
			`${what} is not in the mirror, but the mirror (${mirror.exportedAt}) predates the last write (${lastWrite.at}); it may have landed since. Not creating it twice. Re-export first.`,
		);
}

/**
 * Whether a project is on LinkedIn, for the writer that edits it or adds it.
 * Present in either read (the rendered list or the structured one) is present,
 * whatever its description says. Absent is only said by both reads in full and
 * a fresh mirror; anything less throws rather than add a duplicate.
 */
export function projectPresent(
	mirror,
	title,
	{ probe = false, lastWrite } = {},
) {
	const shown = mirror?.sections?.Projects;
	const rows = mirror?.entities?.projects;
	if (!Array.isArray(shown))
		throw new Error(
			"sections.Projects missing from the mirror (the export could not read all of it; see its warnings). Re-export.",
		);
	if (shown.some((p) => p?.title === title)) return true;
	if (Array.isArray(rows) && rows.some((p) => p?.title === title)) return true;
	if (probe) return false;
	if (!Array.isArray(rows))
		throw new Error(
			`"${title}" is not in sections.Projects, but entities.projects is missing from the mirror, so absence is unproven. Not creating it. Re-export.`,
		);
	assertFreshForCreate(mirror, `Project: ${title}`, lastWrite);
	return false;
}

// A save is done when its dialog closed. Headless can report the page closed
// right after Save while the write landed; the export decides that one.
const saveClosed = (out) => out.dialogGone || Boolean(out.pageClosedAfterSave);
const parseOut = (raw, what) => {
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(`${what} returned non-JSON:\n${raw.slice(0, 400)}`);
	}
};
const at = (vanity, path) => `https://www.linkedin.com/in/${vanity}/${path}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const shotPath = (label) => join(tmpdir(), `linkedin-${label}.png`);

/**
 * One browser session for any number of steps: start the MCP server, read who
 * is logged in, check the session once, run, always detach. `fn` gets the
 * session (`mcp`, `vanity`, `screenshots`) and may replace `ctx.mcp` (a batch
 * reconnecting after a crash); the one it leaves is the one closed. Returns
 * an exit code.
 */
export async function withBrowser(fn, { screenshots = false } = {}) {
	const ctx = { mcp: startMcp({ clientName: "linkedin-write" }), screenshots };
	try {
		await ctx.mcp.init();
		ctx.vanity = process.env.LINKEDIN_VANITY || (await ctx.mcp.getVanity());
		await ctx.mcp.ensureLoggedIn(ctx.vanity);
		return (await fn(ctx)) ?? 0;
	} catch (err) {
		console.error(`\nFailed: ${err.message}`);
		return 2;
	} finally {
		try {
			await ctx.mcp.callTool("browser_close", {}, 5000);
		} catch {}
		ctx.mcp.close();
	}
}

/**
 * One write inside a session. `shot` is where a screenshot of this step goes;
 * `pageShot` is the same path when --screenshots asked for them and null
 * otherwise, and is what the in-page functions get, so a passing step takes
 * none. A failing one (non-zero, or thrown) gets one here, of the page as the
 * failure left it.
 */
export async function step(ctx, label, fn) {
	const sub = { ...ctx, shot: shotPath(label) };
	sub.pageShot = ctx.screenshots ? sub.shot : null;
	let code;
	try {
		code = (await fn(sub)) ?? 0;
	} catch (err) {
		console.error(`\nFailed: ${err.message}\n  screenshot: ${sub.shot}`);
		code = 2;
	}
	if (code) await failureShot(sub);
	return code;
}

export async function failureShot({ mcp, shot }) {
	try {
		await mcp.runFn(takeScreenshot, { shot }, 15000);
	} catch {}
}

function printResults(out) {
	for (const r of out.results ?? [])
		console.log(
			`  ${r.ok ? "ok  " : "BAD "} ${r.control.padEnd(34)} want ${JSON.stringify(r.want)}${r.ok ? "" : `  got ${JSON.stringify(r.got)}`}`,
		);
}

/** Write one education / honour / publication / volunteer / certification block. */
export async function writeFormField(
	{ mcp, vanity, shot, pageShot, mirror = readMirror(), lastWrite },
	field,
	{ mode, probe, description },
) {
	// No catch: a shape error (the collection missing from the mirror) must stop
	// the run. Swallowed, it reads as "absent" and the writer creates a
	// duplicate entry on the live profile.
	const entry = field.form.locate(mirror);
	const creating = entry === undefined;
	if (creating && !probe) assertFreshForCreate(mirror, field.label, lastWrite);
	const target = at(
		vanity,
		creating ? field.form.newPath : field.form.editorPath(entry.id),
	);
	console.log(
		`${creating ? "Not in the mirror, so creating" : "Editing"} ${field.label}\nOpening ${target}`,
	);
	await mcp.callTool("browser_navigate", { url: target }, 60000);
	if (probe) {
		const d = parseOut(
			await mcp.runFn(describeDialog, { shot: pageShot }, 90000),
			"probe",
		);
		if (d.error) {
			console.error(`\n${d.error}\n  see: ${shot}`);
			return 2;
		}
		console.log(`\nDialog: ${d.heading}`);
		for (const c of d.controls)
			console.log(
				`  ${(c.role ? `${c.tag}[${c.role}]` : c.tag).padEnd(16)} ${(c.label || c.ariaLabel || "?").slice(0, 40).padEnd(42)} ${JSON.stringify(c.valueHead)}`,
			);
		console.log(`\nButtons: ${d.buttons.filter(Boolean).join(" | ")}`);
		console.log("\n--probe: nothing changed.");
		return 0;
	}
	const steps = field.form.steps({ creating, entry, description });
	if (!steps.length) {
		console.log("The block sets nothing this editor holds; nothing to write.");
		return 0;
	}
	console.log(
		`\n${mode === "dry" ? "--dry-run: filling, not saving" : "Writing"} ${steps.length} control(s).`,
	);
	const out = parseOut(
		await mcp.runFn(
			fillForm,
			{
				steps,
				expect: creating ? [] : field.form.expect(entry),
				heading: field.form.heading,
				mode,
				shot: pageShot,
			},
			180000,
		),
		"fill",
	);
	printResults(out);
	if (out.error) {
		console.error(`\n${out.error}\n  see: ${shot}`);
		return 2;
	}
	console.log(
		`\n  ${mode === "dry" ? "discarded" : "saved"}; dialog ${out.dialogGone ? "closed" : "STILL OPEN"}; notify network ${out.notifyNetwork}${out.stillOpen ? `\n  dialog says: ${out.stillOpen}` : ""}${out.pageClosedAfterSave ? "\n  page closed after Save (headless does this; the export decides)" : ""}${pageShot ? `\n  see ${shot}` : ""}`,
	);
	if (!out.dialogGone) {
		await failureShot({ mcp, shot });
		console.log(`  screenshot: ${shot}`);
	}
	return out.ok && (mode === "dry" || saveClosed(out)) ? 0 : 1;
}

/**
 * Bring the profile's skills to the record's list: add what is missing, then
 * delete what is extra. Names compare without case (a skill is a LinkedIn
 * entity; see planSkills). Adds go first, and any add that fails cancels
 * every delete: a rename whose add failed would otherwise lose the skill
 * outright. A list that would delete more than a quarter of the profile is
 * refused without --allow-mass-remove (that is what a truncated block looks
 * like), and an empty one always is.
 */
export async function writeSkills(
	{ mcp, vanity, pageShot, mirror = readMirror(), lastWrite },
	field,
	{ dryRun, desiredText, allowMassRemove },
) {
	const live = field.liveSkills(mirror); // throws on a missing collection
	const want = field.skillList(desiredText);
	if (!want.length) {
		console.error(
			"The skills block is empty; refusing to delete every skill. Delete them one by one with --delete skill if that is really the intent.",
		);
		return 1;
	}
	const plan = planSkills(
		live.map((s) => s.name),
		want,
	);
	const removeSet = new Set(plan.remove);
	const remove = live.filter((s) => removeSet.has(s.name));
	console.log(
		`skills: ${live.length} live, ${want.length} in the record; add ${plan.add.length}, remove ${remove.length}`,
	);
	for (const s of plan.add) console.log(`  + ${s}`);
	for (const s of remove) console.log(`  - ${s.name}`);
	for (const c of plan.recase)
		console.log(
			`  = ${c.record}: LinkedIn spells it ${JSON.stringify(c.live)}; fix the record (no write for case)`,
		);
	if (!plan.add.length && !remove.length) return 0;
	const cap = Math.max(5, Math.floor(live.length / 4));
	if (remove.length > cap && !allowMassRemove) {
		console.error(
			`\nRefusing to delete ${remove.length} skills (more than ${cap}). If the list is right, rerun with --allow-mass-remove.`,
		);
		return 1;
	}
	// An add is a create: a rerun on a mirror older than the last save adds again.
	if (plan.add.length)
		assertFreshForCreate(mirror, `skills ${plan.add.join(", ")}`, lastWrite);
	const bad = [];
	for (const skill of plan.add) {
		await mcp.callTool(
			"browser_navigate",
			{ url: at(vanity, "skills/edit/forms/new/") },
			60000,
		);
		const r = parseOut(
			await mcp.runFn(
				addProfileSkill,
				{ skill, dryRun, shot: pageShot },
				90000,
			),
			"add skill",
		);
		console.log(
			`  add ${skill}: ${r.state}${r.seen ? ` (suggestions: ${JSON.stringify(r.seen)})` : ""}`,
		);
		if (!/^(added|would-add)$/.test(r.state)) bad.push(`${skill} (${r.state})`);
		else if (r.value && r.value.trim() !== skill)
			console.log(
				`    LinkedIn spells it ${JSON.stringify(r.value.trim())}; fix the record`,
			);
	}
	if (bad.length && remove.length) {
		console.error(
			`\n${bad.length} add(s) did not go through, so none of the ${remove.length} delete(s) ran: a rename whose add failed would lose the skill.`,
		);
		console.log(`\n  needs a look: ${bad.join(", ")}`);
		return 1;
	}
	for (const s of remove) {
		await mcp.callTool(
			"browser_navigate",
			{ url: at(vanity, `details/skills/edit/forms/${s.id}/`) },
			60000,
		);
		const r = parseOut(
			await mcp.runFn(
				deleteEntry,
				{
					// The skill editor's heading is "Edit <skill>": that is the identity check.
					heading: `^Edit ${escapeRe(s.name)}$`,
					expect: [],
					button: "Delete skill",
					dryRun,
					shot: pageShot,
				},
				90000,
			),
			"delete skill",
		);
		console.log(
			`  remove ${s.name}: ${r.error ?? (r.mode === "dry" ? `would delete (confirm offers ${JSON.stringify(r.confirmButtons)})` : `deleted, editor ${r.editorGone ? "closed" : "STILL OPEN"}`)}`,
		);
		if (r.error || (r.mode === "dry" ? !r.wouldClick : !r.editorGone))
			bad.push(s.name);
	}
	if (bad.length) console.log(`\n  needs a look: ${bad.join(", ")}`);
	return bad.length ? 1 : 0;
}

/**
 * Delete one entry the record no longer carries:
 *   --delete honor "Dean's List"
 *   --delete volunteer match="City Food Bank" role="Driver"
 *   --delete skill "HTML 5"
 * A bare value is the type's identity attribute (title, name, match).
 */
export async function deleteSectionEntry(
	{ mcp, vanity, shot, pageShot, mirror = readMirror() },
	type,
	words,
	{ dryRun },
) {
	let target;
	let heading;
	let expect = [];
	let button;
	if (type === "skill") {
		const name = words.join(" ");
		const s = (mirror?.entities?.skills ?? null)?.filter(
			(x) => x.name === name,
		);
		if (!s)
			throw new Error("entities.skills missing from the mirror; re-export");
		if (s.length !== 1)
			throw new Error(
				`${s.length} live skills are named ${JSON.stringify(name)}`,
			);
		target = `details/skills/edit/forms/${s[0].id}/`;
		heading = `^Edit ${escapeRe(name)}$`;
		button = "Delete skill";
	} else {
		const key = identityAttr(type);
		if (!key)
			throw new Error(
				`--delete takes education, honor, publication, volunteer, certification or skill; not ${JSON.stringify(type)}`,
			);
		const attrs = {};
		for (const w of words) {
			const m = /^([a-z]+)=(.*)$/s.exec(w);
			if (m) attrs[m[1]] = m[2];
			else attrs[key] = attrs[key] ? `${attrs[key]} ${w}` : w;
		}
		const field = fieldFromBlock(`${type}.delete`, attrs, { text: "" });
		const entry = field.form.locate(mirror);
		if (!entry)
			throw new Error(`no live ${type} matches ${JSON.stringify(attrs)}`);
		target = field.form.editorPath(entry.id);
		heading = field.form.heading;
		expect = field.form.expect(entry);
		button = field.form.deleteButton;
	}
	console.log(`Opening ${at(vanity, target)}`);
	await mcp.callTool("browser_navigate", { url: at(vanity, target) }, 60000);
	const out = parseOut(
		await mcp.runFn(
			deleteEntry,
			{ heading, expect, button, dryRun, shot: pageShot },
			120000,
		),
		"delete",
	);
	if (out.error) {
		console.error(`\n${out.error}\n  see: ${shot}`);
		return 2;
	}
	console.log(JSON.stringify(out, null, 2));
	return (dryRun ? out.wouldClick : out.editorGone) ? 0 : 1;
}

/** Attach the block's link= to its project as a link media item. */
export async function addLink(
	{ mcp, vanity, shot, pageShot, mirror = readMirror(), lastWrite },
	field,
	{ dryRun },
) {
	if (!field.link) throw new Error(`${field.id} has no link="..." attribute`);
	if (field.urls(mirror).includes(field.link)) {
		console.log(
			`${field.link} is already on "${field.linkedinTitle}"; nothing to add`,
		);
		return 0;
	}
	const p = (mirror?.entities?.projects ?? null)?.find(
		(x) => x.title === field.linkedinTitle,
	);
	if (!mirror?.entities?.projects)
		throw new Error("entities.projects missing from the mirror; re-export");
	if (!p)
		throw new Error(
			`"${field.linkedinTitle}" is not on LinkedIn yet; write the project first`,
		);
	// Adding a media item is a create: a rerun after a crash adds it twice.
	assertFreshForCreate(
		mirror,
		`${field.link} on "${field.linkedinTitle}"`,
		lastWrite,
	);
	const target = at(vanity, `details/projects/edit/forms/${p.id}/`);
	console.log(`Opening ${target}`);
	await mcp.callTool("browser_navigate", { url: target }, 60000);
	const out = parseOut(
		await mcp.runFn(
			addProjectLink,
			{ url: field.link, title: field.linkedinTitle, dryRun, shot: pageShot },
			180000,
		),
		"add link",
	);
	if (out.error) {
		console.error(
			`\n${out.error}${out.controls ? `\n  media form: ${JSON.stringify(out.controls)}` : ""}\n  see: ${shot}`,
		);
		return 2;
	}
	console.log(JSON.stringify(out, null, 2));
	if (out.ok === false) return 1;
	return dryRun || out.dialogGone ? 0 : 1;
}

/**
 * Remove one media item, by its title, from a block's project:
 *   --remove-media project.digest "GitHub repository"
 * The mirror must show exactly one item with that title on the project.
 */
export async function removeMedia(
	{ mcp, vanity, shot, pageShot, mirror = readMirror() },
	field,
	media,
	{ dryRun },
) {
	if (!Array.isArray(mirror?.sections?.Projects) || !mirror?.entities?.projects)
		throw new Error("projects missing from the mirror; re-export");
	const shown = mirror.sections.Projects.find(
		(x) => x.title === field.linkedinTitle,
	);
	const p = mirror.entities.projects.find(
		(x) => x.title === field.linkedinTitle,
	);
	if (!shown || !p)
		throw new Error(`"${field.linkedinTitle}" is not on LinkedIn`);
	const hits = (shown.media ?? []).filter((m) => m.title === media);
	if (hits.length !== 1)
		throw new Error(
			`${hits.length} media items titled ${JSON.stringify(media)} on "${field.linkedinTitle}" in the mirror; it has ${JSON.stringify((shown.media ?? []).map((m) => m.title))}`,
		);
	const target = at(vanity, `details/projects/edit/forms/${p.id}/`);
	console.log(`Opening ${target}`);
	await mcp.callTool("browser_navigate", { url: target }, 60000);
	const out = parseOut(
		await mcp.runFn(
			removeProjectMedia,
			{ title: field.linkedinTitle, media, dryRun, shot: pageShot },
			120000,
		),
		"remove media",
	);
	if (out.error) {
		console.error(`\n${out.error}\n  see: ${shot}`);
		return 2;
	}
	console.log(JSON.stringify(out, null, 2));
	return dryRun ? (out.wouldClick ? 0 : 1) : out.dialogGone ? 0 : 1;
}
