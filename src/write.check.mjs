#!/usr/bin/env node

// The writers' decisions, run against a fake browser: what they would click,
// and what they must refuse to. Nothing here opens a browser or reads your
// mirror; each case hands the writer a fixture mirror and a fake MCP that
// records every call and answers each in-page function with a canned result.
//
//   node src/write.check.mjs    exits 1 on any failure

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
	addProfileSkill,
	addProjectLink,
	deleteEntry,
	describeDialog,
	fillForm,
} from "./inpage.mjs";
import { fieldFromBlock } from "./schema.mjs";
import {
	addLink,
	assertFreshForCreate,
	conflictingFlags,
	deleteSectionEntry,
	fieldIds,
	MODE_FLAGS,
	maxAgeDays,
	projectPresent,
	unknownFlags,
	writeFormField,
	writeSkills,
} from "./write-sections.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
};

// A fake MCP: `answers` maps an in-page function to its result (an object, or
// a function of the call's args). Every call is recorded.
function fakeMcp(answers) {
	const calls = [];
	return {
		calls,
		ran: (fn) => calls.filter((c) => c.fn === fn),
		callTool: async (name, args) => {
			calls.push({ tool: name, args });
			return {};
		},
		runFn: async (fn, args) => {
			calls.push({ fn, args });
			const a = answers.get(fn);
			if (a === undefined) throw new Error(`unexpected in-page call ${fn}`);
			return JSON.stringify(typeof a === "function" ? a(args) : a);
		},
	};
}
// The writers log their plan; the checks below read results, not logs.
async function quietly(fn) {
	const { log, error } = console;
	console.log = () => {};
	console.error = () => {};
	try {
		return await fn();
	} finally {
		console.log = log;
		console.error = error;
	}
}
const fresh = () => new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const skillsMirror = (names) => ({
	exportedAt: fresh(),
	entities: { skills: names.map((name, i) => ({ id: String(i + 1), name })) },
});
const skills = fieldFromBlock("skills", {}, {});
// lastWrite: null, so a real last-write.json on this machine cannot leak in.
const ctx = (mcp, mirror, lastWrite = null) => ({
	mcp,
	vanity: "someone",
	shot: "/dev/null",
	mirror,
	lastWrite,
});
// write.mjs, end to end, with the copy path pointing nowhere: a refusal must
// come before parseBlocks, so even a regression never reaches a browser.
const runWrite = (...argv) =>
	spawnSync(
		process.execPath,
		[new URL("./write.mjs", import.meta.url).pathname, ...argv],
		{
			env: { ...process.env, LINKEDIN_COPY: "/nonexistent/linkedin.md" },
			encoding: "utf8",
		},
	);
const throws = (fn) => {
	try {
		fn();
		return null;
	} catch (e) {
		return e.message;
	}
};

// --- Flags -----------------------------------------------------------------
check(
	"a mistyped --dryrun is an unknown flag",
	JSON.stringify(unknownFlags(["--dryrun", "skills"])) === '["--dryrun"]',
);
check(
	"every real flag is known",
	unknownFlags([
		"--probe",
		"--dry-run",
		"--noop",
		"--allow-mass-remove",
		"--delete",
		"skill",
		'role="x"',
	]).length === 0,
);
// End to end, the refusal must come before anything else runs.
{
	const r = runWrite("--dryrun", "headline");
	check(
		"write.mjs --dryrun exits 1 before reading anything",
		r.status === 1 && /Unknown option --dryrun/.test(r.stderr),
		`status ${r.status}: ${r.stderr.slice(0, 200)}`,
	);
}

// --probe and --noop have no meaning for the mode commands; ignored, the
// command would run and save for real.
for (const mode of MODE_FLAGS)
	for (const ro of ["--probe", "--noop"]) {
		const argv = [ro, mode, "x", "y"];
		check(`${ro} with ${mode} is refused`, conflictingFlags(argv) !== null);
		const r = runWrite(...argv);
		check(
			`write.mjs ${ro} ${mode} exits 1 before reading anything`,
			r.status === 1 && /cannot go with/.test(r.stderr),
			`status ${r.status}: ${r.stderr.slice(0, 200)}`,
		);
	}
check(
	"--dry-run with a mode flag is allowed",
	conflictingFlags(["--dry-run", "--delete-project", "x"]) === null,
);
check(
	"a field named twice is written once",
	JSON.stringify(fieldIds(["headline", "about", "headline", "--dry-run"])) ===
		'["headline","about"]',
	JSON.stringify(fieldIds(["headline", "about", "headline"])),
);
check(
	"--max-age-days's value is not a field id",
	JSON.stringify(fieldIds(["--max-age-days", "3", "headline"])) ===
		'["headline"]',
);
check("--max-age-days 3 reads 3", maxAgeDays(["--max-age-days", "3"]) === 3);
for (const [name, argv] of [
	["with no value", ["--all-drift", "--max-age-days"]],
	["with a flag for a value", ["--max-age-days", "--all-drift"]],
	["with a word for a value", ["--max-age-days", "seven"]],
]) {
	check(
		`--max-age-days ${name} throws`,
		throws(() => maxAgeDays(argv)) !== null,
	);
	const r = runWrite(...argv);
	check(
		`write.mjs --max-age-days ${name} exits 1`,
		r.status === 1 && /--max-age-days takes a number/.test(r.stderr),
		`status ${r.status}: ${r.stderr.slice(0, 200)}`,
	);
}

// --- Creates after a save the mirror has not seen ---------------------------
// A run that crashed after its create landed, rerun on the old mirror, must
// not create again: every create path refuses a mirror older than last-write.
{
	const mirror = { exportedAt: daysAgo(0.5), entities: {} };
	const after = { at: fresh() };
	const before = { at: daysAgo(1) };
	check(
		"assertFreshForCreate refuses a mirror older than the last write",
		/Re-export first/.test(
			throws(() => assertFreshForCreate(mirror, "x", after)) ?? "",
		),
	);
	check(
		"assertFreshForCreate allows a mirror newer than the last write",
		throws(() => assertFreshForCreate(mirror, "x", before)) === null,
	);
}

// --- Skills ----------------------------------------------------------------
{
	// A rename whose add fails must not delete the old name.
	const mcp = fakeMcp(
		new Map([
			[addProfileSkill, { state: "no-exact-suggestion", seen: [] }],
			[deleteEntry, { mode: "delete", editorGone: true }],
		]),
	);
	const code = await quietly(() =>
		writeSkills(ctx(mcp, skillsMirror(["SQL", "Old Name"])), skills, {
			dryRun: false,
			desiredText: "SQL\nNew Name",
		}),
	);
	check(
		"a failed add cancels every delete",
		code === 1 && mcp.ran(deleteEntry).length === 0,
		`exit ${code}, ${mcp.ran(deleteEntry).length} delete(s)`,
	);
}
{
	const mcp = fakeMcp(new Map());
	const code = await quietly(() =>
		writeSkills(ctx(mcp, skillsMirror(["JavaScript", "SQL"])), skills, {
			dryRun: false,
			desiredText: "javascript\nSQL",
		}),
	);
	check(
		"a case-only difference adds and deletes nothing",
		code === 0 && mcp.calls.length === 0,
		`exit ${code}, ${mcp.calls.length} call(s)`,
	);
}
{
	const mcp = fakeMcp(new Map());
	const code = await quietly(() =>
		writeSkills(ctx(mcp, skillsMirror(["SQL"])), skills, {
			dryRun: false,
			desiredText: "\n",
			allowMassRemove: true,
		}),
	);
	check(
		"an empty skills block is refused, even with --allow-mass-remove",
		code === 1 && mcp.calls.length === 0,
		`exit ${code}, ${mcp.calls.length} call(s)`,
	);
}
{
	const mcp = fakeMcp(
		new Map([
			[addProfileSkill, { state: "added", value: "New Name" }],
			[deleteEntry, { mode: "delete", editorGone: true }],
		]),
	);
	const code = await quietly(() =>
		writeSkills(ctx(mcp, skillsMirror(["SQL", "Old Name"])), skills, {
			dryRun: false,
			desiredText: "SQL\nNew Name",
		}),
	);
	const del = mcp.ran(deleteEntry);
	check(
		"a rename whose add lands deletes the old name",
		code === 0 && del.length === 1 && del[0].args.heading === "^Edit Old Name$",
		`exit ${code}, ${JSON.stringify(del.map((d) => d.args.heading))}`,
	);
}
{
	const mcp = fakeMcp(
		new Map([[deleteEntry, { mode: "delete", editorGone: false }]]),
	);
	const code = await quietly(() =>
		writeSkills(ctx(mcp, skillsMirror(["SQL", "Old Name"])), skills, {
			dryRun: false,
			desiredText: "SQL",
		}),
	);
	check(
		"a delete that left the editor open exits 1",
		code === 1,
		`exit ${code}`,
	);
}

{
	const mcp = fakeMcp(new Map([[addProfileSkill, { state: "added" }]]));
	let threw = null;
	try {
		await quietly(() =>
			writeSkills(
				ctx(mcp, skillsMirror(["SQL"]), { at: daysAgo(-0.01) }),
				skills,
				{ dryRun: false, desiredText: "SQL\nNew" },
			),
		);
	} catch (e) {
		threw = e.message;
	}
	check(
		"no skill add after a save the mirror has not seen",
		threw !== null && mcp.calls.length === 0,
		`threw ${threw}, ${mcp.calls.length} call(s)`,
	);
}

// --- Form sections ---------------------------------------------------------
const honor = fieldFromBlock(
	"honor.a",
	{ title: "Award", issuer: "Board" },
	{ text: "" },
);
const honors = (exportedAt, list = []) => ({
	exportedAt,
	entities: { honors: list },
});
const fillOk = (dialogGone) => ({
	mode: "save",
	results: [],
	ok: true,
	dialogGone,
	notifyNetwork: "off",
});
for (const [name, mirror, lastWrite] of [
	["a stale mirror", honors(daysAgo(30))],
	["a mirror of unknown age", { entities: { honors: [] } }],
	["a mirror without the collection", { exportedAt: fresh(), entities: {} }],
	[
		"a mirror older than the last write",
		honors(daysAgo(1)),
		{ at: daysAgo(0.5) },
	],
]) {
	const mcp = fakeMcp(new Map([[fillForm, fillOk(true)]]));
	let threw = null;
	try {
		await quietly(() =>
			writeFormField(ctx(mcp, mirror, lastWrite), honor, {
				mode: "save",
				description: "",
			}),
		);
	} catch (e) {
		threw = e.message;
	}
	check(
		`no create from ${name}`,
		threw !== null && mcp.calls.length === 0,
		`threw ${threw}, ${mcp.calls.length} call(s)`,
	);
}
{
	const mcp = fakeMcp(new Map([[fillForm, fillOk(true)]]));
	const code = await quietly(() =>
		writeFormField(ctx(mcp, honors(fresh())), honor, {
			mode: "save",
			description: "",
		}),
	);
	const nav = mcp.calls.find((c) => c.tool === "browser_navigate");
	check(
		"a fresh mirror creates through the new form",
		code === 0 && /\/details\/honors\/edit\/forms\/new\/$/.test(nav?.args.url),
		`exit ${code}, ${nav?.args.url}`,
	);
}
{
	const mirror = honors(daysAgo(30), [{ id: "5", title: "Award" }]);
	const mcp = fakeMcp(new Map([[fillForm, fillOk(true)]]));
	const code = await quietly(() =>
		writeFormField(ctx(mcp, mirror), honor, {
			mode: "save",
			description: "",
		}),
	);
	check("a stale mirror may still edit an existing entry", code === 0);
}
{
	const mirror = honors(fresh(), [{ id: "5", title: "Award" }]);
	const mcp = fakeMcp(new Map([[fillForm, fillOk(false)]]));
	const code = await quietly(() =>
		writeFormField(ctx(mcp, mirror), honor, {
			mode: "save",
			description: "",
		}),
	);
	check("a save that left the dialog open exits 1", code === 1, `exit ${code}`);
}
{
	const mirror = honors(fresh(), [{ id: "5", title: "Award" }]);
	for (const [name, answer, want] of [
		["a delete that left the editor open", { editorGone: false }, 1],
		["a dry delete that found no Delete", { mode: "dry", wouldClick: null }, 1],
		["a delete with no confirmation", { error: "no confirmation" }, 2],
		["a delete that closed the editor", { editorGone: true }, 0],
	]) {
		const mcp = fakeMcp(new Map([[deleteEntry, answer]]));
		const code = await quietly(() =>
			deleteSectionEntry(ctx(mcp, mirror), "honor", ["Award"], {
				dryRun: answer.mode === "dry",
			}),
		);
		check(`${name} exits ${want}`, code === want, `exit ${code}`);
	}
}
// The probe path must never be confused with a write: it reads only.
{
	const mcp = fakeMcp(
		new Map([[describeDialog, { heading: "Add", controls: [], buttons: [] }]]),
	);
	await quietly(() =>
		writeFormField(ctx(mcp, honors(daysAgo(30))), honor, {
			mode: "save",
			probe: true,
		}),
	);
	check("--probe runs no fill", mcp.ran(fillForm).length === 0);
}

// --- Projects --------------------------------------------------------------
// The project writer creates when a title is absent, so absent must be proven:
// both reads present and complete, neither carrying the title, the mirror
// fresh and newer than the last write.
{
	const T = "Thing";
	const m = (sections, entities, exportedAt = fresh()) => ({
		exportedAt,
		sections: sections === undefined ? {} : { Projects: sections },
		entities: entities === undefined ? {} : { projects: entities },
	});
	for (const [name, mirror, opts, want] of [
		["absent from both, fresh", m([], []), {}, false],
		["shown with no description", m([{ title: T }], []), {}, true],
		["only in entities.projects", m([], [{ id: "1", title: T }]), {}, true],
		["entities.projects missing", m([], undefined), {}, "throws"],
		["sections.Projects missing", m(undefined, []), {}, "throws"],
		["a stale mirror", m([], [], daysAgo(30)), {}, "throws"],
		[
			"a mirror older than the last write",
			m([], [], daysAgo(1)),
			{ lastWrite: { at: daysAgo(0.5) } },
			"throws",
		],
		[
			"entities.projects missing, under --probe",
			m([], undefined),
			{ probe: true },
			false,
		],
	]) {
		let got;
		try {
			got = projectPresent(mirror, T, { lastWrite: null, ...opts });
		} catch {
			got = "throws";
		}
		check(
			`project ${name}: ${want === "throws" ? "refused" : want ? "present (edit)" : "absent (create)"}`,
			got === want,
			`got ${got}`,
		);
	}
}
{
	const field = fieldFromBlock(
		"project.x",
		{ title: "Thing", link: "https://example.com" },
		{ text: "" },
	);
	const mirror = {
		exportedAt: daysAgo(1),
		sections: { Projects: [{ title: "Thing", media: [] }] },
		entities: { projects: [{ id: "1", title: "Thing" }] },
	};
	const mcp = fakeMcp(
		new Map([[addProjectLink, { ok: true, dialogGone: true }]]),
	);
	let threw = null;
	try {
		await quietly(() =>
			addLink(ctx(mcp, mirror, { at: daysAgo(0.5) }), field, { dryRun: false }),
		);
	} catch (e) {
		threw = e.message;
	}
	check(
		"no link added after a save the mirror has not seen",
		threw !== null && mcp.calls.length === 0,
		`threw ${threw}, ${mcp.calls.length} call(s)`,
	);
	const ok = fakeMcp(
		new Map([[addProjectLink, { ok: true, dialogGone: true }]]),
	);
	const code = await quietly(() =>
		addLink(ctx(ok, mirror, { at: daysAgo(2) }), field, { dryRun: false }),
	);
	check(
		"a link is added from a mirror newer than the last write",
		code === 0,
		`exit ${code}`,
	);
}

// --- The export's structured reads ----------------------------------------
// collectEntities is a top-level function of the in-page export script, which
// cannot be imported (it runs on load), so its source is lifted out and built.
{
	const src = readFileSync(
		new URL("./export-inpage.js", import.meta.url),
		"utf8",
	);
	const body = /^const collectEntities = (async [\s\S]*?\n^});$/m.exec(
		src,
	)?.[1];
	check("collectEntities is in the export script", Boolean(body));
	const collect = body ? new Function(`return (${body})`)() : null;
	const T = "com.linkedin.voyager.dash.identity.profile.Honor";
	const pageOf = (urns, total, missing = []) => ({
		data: {
			"*elements": urns,
			...(total === undefined ? {} : { paging: { total } }),
		},
		included: urns
			.filter((u) => !missing.includes(u))
			.map((u) => ({ $type: T, entityUrn: u, title: u })),
	});
	const run = async (pages) => {
		let i = 0;
		try {
			return await collect(
				async () => pages[i++] ?? { data: { "*elements": [] }, included: [] },
				"Honor",
				(u, e) => ({ id: u, title: e.title }),
			);
		} catch (e) {
			return `threw: ${e.message}`;
		}
	};
	const cases = [
		["one complete page", [pageOf(["a", "b"], 2)], 2],
		["two pages to the total", [pageOf(["a"], 2), pageOf(["b"], 2)], 2],
		["no total, a short page", [pageOf(["a", "b"])], 2],
		["short of the total", [pageOf(["a"], 3), pageOf([], 3)], null],
		["an element with no record", [pageOf(["a", "b"], 2, ["b"])], null],
		["no *elements", [{ data: {}, included: [] }], null],
		["a failed page", [{ failed: true, data: {}, included: [] }], null],
	];
	for (const [name, pages, want] of cases) {
		const got = collect ? await run(pages) : "no function";
		const n = Array.isArray(got) ? got.length : null;
		check(
			`entities: ${name} reads ${want === null ? "unreadable" : `${want} rows`}`,
			want === null ? !Array.isArray(got) : n === want,
			JSON.stringify(got),
		);
	}
}

// --- The export's rendered sections -----------------------------------------
// paginatePlc reads Projects for the project writer; a partial list must throw
// (export leaves the section out, so it reads as unreadable), never pass.
{
	const src = readFileSync(
		new URL("./export-inpage.js", import.meta.url),
		"utf8",
	);
	const body = /^const paginatePlc = (async [\s\S]*?\n^});$/m.exec(src)?.[1];
	check("paginatePlc is in the export script", Boolean(body));
	const paginate = body ? new Function(`return (${body})`)() : null;
	const el = (t) => ({ t });
	const parse = (els) => els.map((e) => ({ title: e.t }));
	const plc = (els, total, urn = "urn:plc") => ({
		entityUrn: urn,
		components: { elements: els.map(el), paging: { total } },
	});
	const page = (els) => ({
		data: {
			data: {
				identityDashProfileComponentsByPagedListComponent: {
					elements: els.map(el),
				},
			},
		},
	});
	const run = async (p, pages, seen) => {
		let i = 0;
		try {
			const r = await paginate(
				p,
				async () => pages[i++] ?? page([]),
				parse,
				seen,
			);
			return r.items.length;
		} catch (e) {
			return `threw: ${e.message}`;
		}
	};
	for (const [name, p, pages, want, seen] of [
		["one complete page", plc(["a", "b"], 2), [], 2],
		["a follow-up page to the total", plc(["a"], 2), [page(["b"])], 2],
		["a failed follow-up page", plc(["a"], 2), [{ failed: true }], null],
		[
			"an empty follow-up page short of the total",
			plc(["a"], 3),
			[page(["b"])],
			null,
		],
		["short of the total with no list urn", plc(["a"], 2, null), [], null],
		[
			"a skill already seen in another category",
			plc(["a", "b"], 2),
			[],
			1,
			new Set(["a|"]),
		],
	]) {
		const got = paginate ? await run(p, pages, seen) : "no function";
		check(
			`sections: ${name} reads ${want === null ? "unreadable" : `${want} rows`}`,
			want === null
				? typeof got === "string" && got.startsWith("threw")
				: got === want,
			String(got),
		);
	}
}

console.log(
	failed
		? `\n${failed} writer check failure(s)`
		: "\nwriter checks: flags, skills, creates, saves, deletes and entity reads refuse what they must",
);
process.exit(failed ? 1 : 0);
