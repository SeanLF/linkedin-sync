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
	deleteEntry,
	describeDialog,
	fillForm,
} from "./inpage.mjs";
import { fieldFromBlock } from "./schema.mjs";
import {
	deleteSectionEntry,
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
const ctx = (mcp, mirror) => ({
	mcp,
	vanity: "someone",
	shot: "/dev/null",
	mirror,
});

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
// End to end, the refusal must come before anything else runs. The copy path
// points nowhere, so even a regression stops at parseBlocks, never a browser.
{
	const r = spawnSync(
		process.execPath,
		[new URL("./write.mjs", import.meta.url).pathname, "--dryrun", "headline"],
		{
			env: { ...process.env, LINKEDIN_COPY: "/nonexistent/linkedin.md" },
			encoding: "utf8",
		},
	);
	check(
		"write.mjs --dryrun exits 1 before reading anything",
		r.status === 1 && /Unknown option --dryrun/.test(r.stderr),
		`status ${r.status}: ${r.stderr.slice(0, 200)}`,
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
for (const [name, mirror] of [
	["a stale mirror", honors(daysAgo(30))],
	["a mirror of unknown age", { entities: { honors: [] } }],
	["a mirror without the collection", { exportedAt: fresh(), entities: {} }],
]) {
	const mcp = fakeMcp(new Map([[fillForm, fillOk(true)]]));
	let threw = null;
	try {
		await quietly(() =>
			writeFormField(ctx(mcp, mirror), honor, {
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

console.log(
	failed
		? `\n${failed} writer check failure(s)`
		: "\nwriter checks: flags, skills, creates, saves, deletes and entity reads refuse what they must",
);
process.exit(failed ? 1 : 0);
