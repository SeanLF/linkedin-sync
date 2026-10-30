#!/usr/bin/env node
// Does LinkedIn still say what your source-of-truth file says it should?
//
// Reads the desired copy from your linkedin.md and the live values from the
// export mirror (tools/mirror.json), compares field by field through
// the shared schema, and exits non-zero when they disagree.
//
// The point of this file is the verdict taxonomy. A two-state checker (same /
// different) reports "same" when the schema selector has stopped finding the
// field at all, which is how a profile drifts nine months behind a site while
// a green check sits next to it. So "I could not read this" is a distinct,
// louder outcome than "these differ", and the mirror's own age is checked
// before anything is compared; a fresh diff against a stale mirror is a
// broken instrument exiting 0.
//
// Usage:
//   ./linkedin-drift.mjs                    compare, print a report
//   ./linkedin-drift.mjs --max-age-days 30  how stale the mirror may be
//   ./linkedin-drift.mjs --self-test        prove the comparator can fail
//   ./linkedin-drift.mjs --check-links      also fetch every project link and
//                                           report the ones that no longer resolve

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countChars, parseBlocks } from "./copy-blocks.mjs";
import {
	experienceByCompany,
	fieldFromBlock,
	fieldsFromBlocks,
	MIRROR_MAX_AGE_DAYS,
	mirrorAgeDays,
	NONE,
	normalize,
	PRESENT,
	parseDate,
	parseRange,
	planSkills,
} from "./schema.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIRROR = join(__dirname, "mirror.json");

export const VERDICTS = {
	MATCH: "match", // live and desired agree
	DRIFT: "drift", // both present, different text
	ABSENT: "absent", // desired exists; LinkedIn has no such field yet
	NO_DESIRED: "no-desired", // LinkedIn has a value; the record does not
	UNREADABLE: "unreadable", // the selector threw: the export shape changed
};

// UNREADABLE means the tool is broken and every other verdict this run is
// suspect, so it outranks a mere content difference.
const EXIT = { clean: 0, stale: 1, broken: 2 };

/** Compare one schema field. Never throws; shape errors become UNREADABLE. */
export function compareField(field, profile, desired) {
	let live;
	try {
		live = field.read(profile);
	} catch (err) {
		return { id: field.id, verdict: VERDICTS.UNREADABLE, detail: err.message };
	}

	const hasLive = typeof live === "string" && live.trim() !== "";
	const hasDesired = typeof desired === "string" && desired.trim() !== "";

	if (!hasDesired && !hasLive)
		return { id: field.id, verdict: VERDICTS.MATCH, detail: "both empty" };
	if (!hasDesired) return { id: field.id, verdict: VERDICTS.NO_DESIRED, live };
	if (!hasLive) return { id: field.id, verdict: VERDICTS.ABSENT, desired };

	const a = normalize(live);
	const b = normalize(desired);
	if (a === b)
		return {
			id: field.id,
			verdict: VERDICTS.MATCH,
			detail: b === PRESENT ? "on LinkedIn" : `${countChars(b)} chars`,
		};
	return {
		id: field.id,
		verdict: VERDICTS.DRIFT,
		live: a,
		desired: b,
		at: firstDifference(a, b),
	};
}

/**
 * Every comparison one block makes: its main value, then each facet (a date
 * range, a grade, a link) on its own line. Facets are the reason a block can be
 * right in its text and wrong on the page: LinkedIn sorts undated projects
 * last, and a role that ends a month late reads as a month longer.
 */
export function compareAll(f, profile, blocks) {
	const text = blocks.get(f.id).text;
	const desired = f.canonDesired ? f.canonDesired(text) : text;
	const main = compareField(f, profile, desired);
	if (main.verdict === VERDICTS.DRIFT && f.diff)
		main.diff = f.diff(main.live, main.desired);
	const facets = (f.facets ?? [])
		.map((x) => ({ x, r: compareField(x, profile, x.desired) }))
		// An optional facet (media health) with nothing to read is no line.
		.filter(({ x, r }) => !(x.optional && r.verdict === VERDICTS.ABSENT))
		.map(({ r }) => r);
	return [main, ...facets];
}

// Facets `write <id>` does not write: a project's link goes on with
// `write --add-link`, and media health is LinkedIn's preview, not a value.
export const UNWRITTEN_FACETS = new Set(["link", "media"]);

/**
 * What `write --all-drift` writes: every block whose main value or a facet
 * `write <id>` handles is stale (drift or absent). `unwritten` names the stale
 * facets it leaves to another command; `unreadable` the blocks whose read
 * threw, which make the whole list suspect (the caller refuses on any).
 */
export function staleFields(fields, profile, blocks) {
	const stale = [];
	const unwritten = [];
	const unreadable = [];
	for (const f of fields) {
		const results = compareAll(f, profile, blocks);
		if (results.some((r) => r.verdict === VERDICTS.UNREADABLE)) {
			unreadable.push(f.id);
			continue;
		}
		const off = results.filter(
			(r) => r.verdict === VERDICTS.DRIFT || r.verdict === VERDICTS.ABSENT,
		);
		const writable = (r) =>
			r.id === f.id || !UNWRITTEN_FACETS.has(r.id.slice(f.id.length + 1));
		if (off.some(writable)) stale.push(f.id);
		for (const r of off) if (!writable(r)) unwritten.push(r.id);
	}
	return { stale, unwritten, unreadable };
}

/**
 * url -> HTTP status (or an error string) for every link on a compared
 * project. HEAD first; some hosts refuse HEAD, so a 403/405 is retried as GET.
 */
async function checkLinks(fields, profile) {
	const urls = new Set();
	for (const f of fields) {
		try {
			for (const u of f.urls?.(profile) ?? []) urls.add(u);
		} catch {} // a shape error is reported by the comparison itself
	}
	const status = new Map();
	await Promise.all(
		[...urls].map(async (u) => {
			const hit = (method) =>
				fetch(u, {
					method,
					redirect: "follow",
					signal: AbortSignal.timeout(15000),
					headers: { "user-agent": "linkedin-sync link check" },
				});
			try {
				let r = await hit("HEAD");
				if (r.status === 403 || r.status === 405) r = await hit("GET");
				status.set(u, r.status);
			} catch (err) {
				status.set(u, `unreachable (${err.cause?.code ?? err.message})`);
			}
		}),
	);
	console.log(`links    ${status.size} checked\n`);
	return status;
}

/** Index of the first differing character, for a readable report. */
function firstDifference(a, b) {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
	return n;
}

function excerpt(s, at, span = 60) {
	const start = Math.max(0, at - span);
	const head = start > 0 ? "..." : "";
	const tail = at + span < s.length ? "..." : "";
	return (head + s.slice(start, at + span) + tail).replace(/\n/g, "\\n");
}

// --- self-test -------------------------------------------------------------
// A comparator that returned MATCH unconditionally would pass a normal run on
// a profile that happens to be in sync. These fixtures make it produce every
// verdict, so the harness is proven able to fail before its pass means
// anything.
function selfTest() {
	const cases = [
		["identical text", { read: () => "abc" }, "abc", VERDICTS.MATCH],
		[
			"nbsp and CRLF only",
			{ read: () => "a b\r\nc" },
			"a b\nc",
			VERDICTS.MATCH,
		],
		["real difference", { read: () => "abc" }, "abd", VERDICTS.DRIFT],
		["case is real drift", { read: () => "Abc" }, "abc", VERDICTS.DRIFT],
		["curly quote is drift", { read: () => "it’s" }, "it's", VERDICTS.DRIFT],
		["missing on LinkedIn", { read: () => undefined }, "abc", VERDICTS.ABSENT],
		["missing in record", { read: () => "abc" }, "", VERDICTS.NO_DESIRED],
		[
			"shape changed",
			{
				read: () => {
					throw new Error("Projects missing");
				},
			},
			"abc",
			VERDICTS.UNREADABLE,
		],
	];

	let failed = 0;
	// The age guard is the other half of the instrument: no exportedAt must
	// read as unknown, never as fresh.
	const ageCases = [
		["no exportedAt", {}, null],
		["unparseable exportedAt", { exportedAt: "yesterday" }, null],
		["fresh exportedAt", { exportedAt: new Date().toISOString() }, 0],
	];
	for (const [name, profile, want] of ageCases) {
		const got = mirrorAgeDays(profile);
		const ok =
			want === null ? got === null : typeof got === "number" && got < 1;
		if (!ok) failed++;
		console.log(
			`${ok ? "ok  " : "FAIL"}  ${name.padEnd(22)} expected ${want === null ? "unknown" : "fresh"}, got ${got === null ? "unknown" : `${got.toFixed(3)} days`}`,
		);
	}
	for (const [name, field, desired, want] of cases) {
		const got = compareField({ id: name, ...field }, {}, desired).verdict;
		const ok = got === want;
		if (!ok) failed++;
		console.log(
			`${ok ? "ok  " : "FAIL"}  ${name.padEnd(22)} expected ${want}, got ${got}`,
		);
	}
	// Position reads must pick exactly one role or refuse. Fixture shaped like the
	// export: a grouped company (title = company, roles[]) and a single entry
	// (subtitle = company) sharing a role title with it.
	const xp = {
		sections: {
			Experience: [
				{
					title: "Hivebrite",
					subtitle: "Permanent · 3 yrs",
					roles: [
						{ title: "Senior Software Engineer", description: "H-senior" },
						{ title: "Software Engineer", description: "H-swe" },
					],
				},
				{
					title: "Senior Software Engineer",
					subtitle: "OmbuLabs.ai · Freelance",
					description: "O-senior",
				},
			],
		},
	};
	const rx = (m) => new RegExp(m, "i");
	const pick = (m, role) => {
		try {
			return experienceByCompany(xp, rx(m), role)?.description ?? "absent";
		} catch {
			return "refused";
		}
	};
	const roleCases = [
		[
			"role in grouped company",
			["Hivebrite", "Senior Software Engineer"],
			"H-senior",
		],
		[
			"role is exact, not substring",
			["Hivebrite", "Software Engineer"],
			"H-swe",
		],
		[
			"role in single entry",
			["OmbuLabs", "Senior Software Engineer"],
			"O-senior",
		],
		["grouped company, no role", ["Hivebrite", undefined], "refused"],
		[
			"title at two companies",
			["Senior Software Engineer", undefined],
			"refused",
		],
		["role not at that company", ["OmbuLabs", "Software Engineer"], "absent"],
	];
	for (const [name, [m, role], want] of roleCases) {
		const got = pick(m, role);
		const ok = got === want;
		if (!ok) failed++;
		console.log(
			`${ok ? "ok  " : "FAIL"}  ${name.padEnd(28)} expected ${want}, got ${got}`,
		);
	}
	failed += sectionSelfTest();
	failed += staleSelfTest();
	console.log(
		failed
			? `\n${failed} self-test failure(s)`
			: "\nself-test: comparator produces every verdict, position reads pick one role or refuse, and every section type reads unreadable when its data is missing",
	);
	return failed ? EXIT.broken : EXIT.clean;
}

// What `write --all-drift` picks: stale main values and the facets the field
// writer handles; not a link or media facet, and never a block it cannot read.
function staleSelfTest() {
	const same = () => "same";
	const fields = [
		{ id: "headline", read: (p) => p.headline },
		{ id: "about", read: same },
		{
			id: "project.link-only",
			read: same,
			facets: [
				{ id: "project.link-only.link", read: () => "a", desired: "b" },
				{
					id: "project.link-only.media",
					read: () => "bad",
					desired: "ok",
					optional: true,
				},
			],
		},
		{
			id: "project.dates",
			read: same,
			facets: [{ id: "project.dates.dates", read: () => "x", desired: "y" }],
		},
		{
			id: "education.broken",
			read: () => {
				throw new Error("Education missing");
			},
		},
		{ id: "education.new", read: () => undefined },
	];
	const blocks = new Map(
		fields.map((f) => [
			f.id,
			{
				text:
					f.id === "headline" ? "new" : f.id === "education.new" ? "x" : "same",
			},
		]),
	);
	const got = staleFields(fields, { headline: "old" }, blocks);
	const want = {
		stale: ["headline", "project.dates", "education.new"],
		unwritten: ["project.link-only.link", "project.link-only.media"],
		unreadable: ["education.broken"],
	};
	let failed = 0;
	for (const k of Object.keys(want)) {
		const ok = JSON.stringify(got[k]) === JSON.stringify(want[k]);
		if (!ok) failed++;
		console.log(
			`${ok ? "ok  " : "FAIL"}  --all-drift ${k.padEnd(16)} expected ${JSON.stringify(want[k])}, got ${JSON.stringify(got[k])}`,
		);
	}
	return failed;
}

// The section types read through the schema against a fixture shaped like a
// real export (2026-10-29). Each case is one block and the verdict its main
// value or one facet must produce. The UNREADABLE rows are the point: a type
// whose data is missing from the mirror must say so, never match.
function sectionSelfTest() {
	const live = {
		sections: {
			Experience: [
				{
					title: "Acme Corp",
					subtitle: "Permanent · 3 yrs",
					roles: [
						{
							title: "Senior Software Engineer",
							dates: "Feb 2019 - Feb 2021 · 2 yrs 1 mo",
							description: "H",
						},
					],
				},
				{
					title: "Université Exemple",
					subtitle: "Part-time",
					roles: [{ title: "Grader", description: "C" }],
				},
			],
			Projects: [
				{
					title: "Weather Bot",
					subtitle: "Apr 2024 - Present",
					description: "D",
					media: [
						{
							title: "Site",
							kind: "LINK",
							url: "https://a.example",
							thumbnail: true,
						},
						{ title: "Repo", kind: "LINK", url: null, thumbnail: false },
					],
				},
			],
			Volunteering: [
				{
					title: "Developer",
					subtitle: "Food Bank",
					dates: "Mar 2016 - Present · 10 yrs",
				},
			],
		},
		entities: {
			positions: [{ id: "1", title: "Grader", company: "University" }],
			// The API holds this project as ending the month it started; the page
			// says Present. Dates must read the page.
			projects: [
				{
					id: "9",
					title: "Weather Bot",
					dates: { start: "2024-04", end: "2024-04" },
				},
			],
			educations: [
				{
					id: "2",
					school: "Example University",
					degree: "BSc",
					field: "Computer Science",
					grade: "First Class Honours",
					dates: { start: "2010", end: "2014" },
				},
				{ id: "3", school: "Example University", degree: "MSc" },
			],
			certifications: [
				{
					id: "4",
					name: "Food Safety",
					credentialId: "X-0000",
					dates: { start: "2018-03" },
				},
				{ id: "5", name: "Diver" },
			],
			honors: [],
			publications: [
				{
					id: "6",
					title: "Paper",
					publisher: "Example Press",
					date: "2021-09-01",
				},
			],
			volunteering: [
				{
					id: "7",
					organization: "Food Bank",
					role: "Developer",
					cause: "SCIENCE_AND_TECHNOLOGY",
				},
			],
			skills: [{ name: "SQL" }, { name: "Cartographie" }],
		},
	};
	const bare = { sections: live.sections }; // an export from before entities
	const cases = [
		// [name, block id, attrs, text, comparison id ("" = main), profile, verdict]
		[
			"position end date drift",
			"position.h",
			{
				match: "Acme",
				role: "Senior Software Engineer",
				dates: "Feb 2019 - Jan 2021",
			},
			"H",
			"dates",
			live,
			VERDICTS.DRIFT,
		],
		[
			"position dates as rendered",
			"position.h",
			{
				match: "Acme",
				role: "Senior Software Engineer",
				dates: "Feb 2019 - Feb 2021",
			},
			"H",
			"dates",
			live,
			VERDICTS.MATCH,
		],
		[
			"role under the page's company name",
			"position.c",
			{ match: "University", role: "Grader" },
			"C",
			"",
			live,
			VERDICTS.MATCH,
		],
		[
			"role at no such typed company",
			"position.c",
			{ match: "Nowhere", role: "Grader" },
			"C",
			"",
			live,
			VERDICTS.ABSENT,
		],
		[
			"position company rename",
			"position.c",
			{
				match: "University",
				role: "Grader",
				company: "Example University",
			},
			"",
			"company",
			live,
			VERDICTS.DRIFT,
		],
		[
			"position company, no entities",
			"position.c",
			{
				match: "University",
				role: "Grader",
				company: "Example University",
			},
			"",
			"company",
			bare,
			VERDICTS.UNREADABLE,
		],
		[
			"project Present from page",
			"project.d",
			{ title: "Weather Bot", dates: "Apr 2024 - Present" },
			"D",
			"dates",
			live,
			VERDICTS.MATCH,
		],
		[
			"project link present",
			"project.d",
			{ title: "Weather Bot", link: "https://a.example" },
			"D",
			"link",
			live,
			VERDICTS.MATCH,
		],
		[
			"project link missing",
			"project.d",
			{ title: "Weather Bot", link: "https://b.example" },
			"D",
			"link",
			live,
			VERDICTS.DRIFT,
		],
		[
			"project stale media",
			"project.d",
			{ title: "Weather Bot" },
			"D",
			"media",
			live,
			VERDICTS.DRIFT,
		],
		[
			"education grade match",
			"education.b",
			{ match: "BSc", grade: "First Class Honours" },
			"",
			"grade",
			live,
			VERDICTS.MATCH,
		],
		[
			"education grade drift",
			"education.b",
			{ match: "BSc", grade: "First Class Honours (4.0)" },
			"",
			"grade",
			live,
			VERDICTS.DRIFT,
		],
		[
			"education year-only dates",
			"education.b",
			{ match: "BSc", dates: "2010 - 2014" },
			"",
			"dates",
			live,
			VERDICTS.MATCH,
		],
		[
			"education ambiguous match",
			"education.u",
			{ match: "Example", grade: "A" },
			"",
			"",
			live,
			VERDICTS.UNREADABLE,
		],
		[
			"education, no entities",
			"education.b",
			{ match: "BSc", grade: "A" },
			"",
			"",
			bare,
			VERDICTS.UNREADABLE,
		],
		[
			"education facet, no entities",
			"education.b",
			{ match: "BSc", grade: "A" },
			"",
			"grade",
			bare,
			VERDICTS.UNREADABLE,
		],
		[
			"education not on LinkedIn",
			"education.p",
			{ match: "PhD" },
			"",
			"",
			live,
			VERDICTS.ABSENT,
		],
		[
			"empty honor block, none live",
			"honor.n",
			{ title: "Research Award" },
			"",
			"",
			live,
			VERDICTS.ABSENT,
		],
		[
			"honor, no entities",
			"honor.n",
			{ title: "Research Award" },
			"",
			"",
			bare,
			VERDICTS.UNREADABLE,
		],
		[
			"credential must clear",
			"certification.s",
			{ name: "Food Safety", credential: "" },
			"",
			"credential",
			live,
			VERDICTS.DRIFT,
		],
		[
			"credential already clear",
			"certification.d",
			{ name: "Diver", credential: "" },
			"",
			"credential",
			live,
			VERDICTS.MATCH,
		],
		[
			"certification present",
			"certification.d",
			{ name: "Diver" },
			"",
			"",
			live,
			VERDICTS.MATCH,
		],
		[
			"cert issue date",
			"certification.s",
			{ name: "Food Safety", dates: "Mar 2018" },
			"",
			"dates",
			live,
			VERDICTS.MATCH,
		],
		[
			"publication date at record precision",
			"publication.p",
			{ title: "Paper", date: "Sep 2021" },
			"",
			"date",
			live,
			VERDICTS.MATCH,
		],
		[
			"publisher typo",
			"publication.p",
			{ title: "Paper", publisher: "Exmaple Press" },
			"",
			"publisher",
			live,
			VERDICTS.DRIFT,
		],
		[
			"volunteer cause by label",
			"volunteer.j",
			{
				match: "Food Bank",
				role: "Developer",
				cause: "Science and Technology",
			},
			"",
			"cause",
			live,
			VERDICTS.MATCH,
		],
		[
			"volunteer end date",
			"volunteer.j",
			{ match: "Food Bank", role: "Developer", dates: "Mar 2016 - 2023" },
			"",
			"dates",
			live,
			VERDICTS.DRIFT,
		],
		[
			"volunteer dates, no page",
			"volunteer.j",
			{ match: "Food Bank", role: "Developer", dates: "Mar 2016 - 2023" },
			"",
			"dates",
			{ entities: live.entities, sections: {} },
			VERDICTS.UNREADABLE,
		],
		[
			"skills in another order",
			"skills",
			{},
			"Cartographie\nSQL",
			"",
			live,
			VERDICTS.MATCH,
		],
		[
			"skills rename",
			"skills",
			{},
			"SQL\nMachine Learning",
			"",
			live,
			VERDICTS.DRIFT,
		],
		["skills, no entities", "skills", {}, "SQL", "", bare, VERDICTS.UNREADABLE],
	];
	let failed = 0;
	for (const [name, id, attrs, text, which, profile, want] of cases) {
		const f = fieldFromBlock(id, attrs, { text });
		const blocks = new Map([[id, { text, attrs }]]);
		const all = compareAll(f, profile, blocks);
		const r = all.find((x) => x.id === (which ? `${id}.${which}` : id));
		const got = r?.verdict ?? "(no such comparison)";
		const ok = got === want;
		if (!ok) failed++;
		console.log(
			`${ok ? "ok  " : "FAIL"}  ${name.padEnd(36)} expected ${want}, got ${got}${ok ? "" : ` ${JSON.stringify(r)}`}`,
		);
	}
	// The renamed skill must come back as one add and one remove.
	const sk = compareAll(
		fieldFromBlock("skills", {}, {}),
		live,
		new Map([["skills", { text: "SQL\nMachine Learning", attrs: {} }]]),
	)[0];
	const diffOk =
		JSON.stringify(sk.diff) ===
		JSON.stringify({
			add: ["Machine Learning"],
			remove: ["Cartographie"],
			recase: [],
		});
	if (!diffOk) failed++;
	console.log(
		`${diffOk ? "ok  " : "FAIL"}  skills rename is one add, one remove      ${JSON.stringify(sk.diff)}`,
	);
	// A skill whose name differs only in case is the same LinkedIn skill: never
	// an add plus a delete (the add would pick the live entity, the delete
	// would then remove it), only a note to fix the record.
	const cased = planSkills(["JavaScript", "SQL"], ["javascript", "SQL"]);
	const casedOk =
		JSON.stringify(cased) ===
		JSON.stringify({
			add: [],
			remove: [],
			recase: [{ record: "javascript", live: "JavaScript" }],
		});
	if (!casedOk) failed++;
	console.log(
		`${casedOk ? "ok  " : "FAIL"}  skills differing in case are recase only   ${JSON.stringify(cased)}`,
	);
	// Dates refuse what they cannot read; the old parser read this as Present,
	// and the first-three-letters month match read "Junk" as June.
	const refusals = [
		"Mar 2016 - garbage",
		"Smarch 2015",
		"2015 - 2016 - 2017",
		"Junk 2015",
		"Marchy 2015",
		"Feb 30, 2021",
		"Jun 0, 2020",
		"Apr 31, 2020",
	];
	for (const raw of refusals) {
		let threw = false;
		try {
			parseRange(raw);
		} catch {
			threw = true;
		}
		if (!threw) failed++;
		console.log(
			`${threw ? "ok  " : "FAIL"}  dates ${JSON.stringify(raw).padEnd(30)} refused`,
		);
	}
	const accepted = [
		["June 2019", "2019-06"],
		["Sept. 2019", null],
		["Feb 29, 2024", "2024-02-29"],
		["Sep 2021", "2021-09"],
	];
	for (const [raw, want] of accepted) {
		const got = parseDate(raw);
		const ok = got === want;
		if (!ok) failed++;
		console.log(
			`${ok ? "ok  " : "FAIL"}  date ${JSON.stringify(raw).padEnd(31)} reads ${got}`,
		);
	}
	// A publication stored at year precision has no day for the editor to
	// shift, so building its steps must neither throw nor retype it.
	let pubSteps;
	try {
		pubSteps = fieldFromBlock("publication.y", { title: "Old" }, { text: "" })
			.form.steps({ creating: false, entry: { id: "8", date: "2015" } })
			.map((x) => x.pattern);
	} catch (e) {
		pubSteps = `threw: ${e.message}`;
	}
	const pubOk = Array.isArray(pubSteps) && pubSteps.length === 0;
	if (!pubOk) failed++;
	console.log(
		`${pubOk ? "ok  " : "FAIL"}  year-only stored publication date untouched ${JSON.stringify(pubSteps)}`,
	);
	if (NONE !== "(none)") failed++;
	return failed;
}

// --- main ------------------------------------------------------------------
async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--self-test")) process.exit(selfTest());

	const maxAgeIdx = args.indexOf("--max-age-days");
	const maxAgeDays =
		maxAgeIdx === -1 ? MIRROR_MAX_AGE_DAYS : Number(args[maxAgeIdx + 1]);

	let profile;
	try {
		profile = JSON.parse(readFileSync(MIRROR, "utf8"));
	} catch (err) {
		console.error(`Cannot read the mirror at ${MIRROR}: ${err.message}`);
		console.error("Run: LINKEDIN_CDP=1 node src/export.mjs");
		process.exit(EXIT.broken);
	}

	const blocks = parseBlocks();
	const linkStatus = args.includes("--check-links")
		? await checkLinks(fieldsFromBlocks(blocks).fields, profile)
		: undefined;
	const { fields } = fieldsFromBlocks(blocks, { linkStatus });
	const age = mirrorAgeDays(profile);

	console.log(`mirror   ${profile.exportedAt ?? "(no exportedAt)"}`);
	if (age === null) {
		console.log(
			"         WARNING: no exportedAt; cannot tell how stale this is",
		);
	} else {
		console.log(`         ${age.toFixed(1)} days old`);
	}
	console.log(`record   ${blocks.size} blocks\n`);

	const results = fields.flatMap((f) => compareAll(f, profile, blocks));

	const width = Math.max(...results.map((r) => r.id.length));
	for (const r of results) {
		const mark = {
			match: "ok  ",
			drift: "DRIFT",
			absent: "ABSENT",
			"no-desired": "no-rec",
			unreadable: "BROKEN",
		}[r.verdict];
		console.log(`${mark.padEnd(7)} ${r.id.padEnd(width)}  ${r.detail ?? ""}`);
		if (r.verdict === VERDICTS.DRIFT && r.diff) {
			if (r.diff.add.length)
				console.log(`        add     ${r.diff.add.join(", ")}`);
			if (r.diff.remove.length)
				console.log(`        remove  ${r.diff.remove.join(", ")}`);
			for (const c of r.diff.recase ?? [])
				console.log(
					`        case    record ${JSON.stringify(c.record)}, LinkedIn ${JSON.stringify(c.live)} (fix the record; write leaves it)`,
				);
		} else if (r.verdict === VERDICTS.DRIFT) {
			console.log(`        live    ${excerpt(r.live, r.at)}`);
			console.log(`        record  ${excerpt(r.desired, r.at)}`);
		}
		if (r.verdict === VERDICTS.ABSENT) {
			console.log(
				r.desired === PRESENT
					? "        not on LinkedIn yet"
					: `        not on LinkedIn yet (${countChars(r.desired)} chars in the record)`,
			);
		}
		if (r.verdict === VERDICTS.UNREADABLE) {
			console.log(
				`        the export no longer has the shape this selector expects`,
			);
		}
	}

	const unread = results.filter(
		(r) => r.verdict === VERDICTS.UNREADABLE,
	).length;
	const stale = results.filter(
		(r) => r.verdict === VERDICTS.DRIFT || r.verdict === VERDICTS.ABSENT,
	).length;
	const norec = results.filter((r) => r.verdict === VERDICTS.NO_DESIRED).length;

	console.log(
		`\n${results.length} fields: ${results.length - unread - stale - norec} match, ${stale} stale, ${norec} not in the record, ${unread} unreadable`,
	);

	if (unread) {
		console.error(
			"\nThe schema and the export disagree. A read selector stopped finding its field; fix schema.mjs before trusting any verdict above.",
		);
		process.exit(EXIT.broken);
	}
	if (age === null) {
		console.error(
			"\nThe mirror has no readable exportedAt, so its freshness is unknown. A comparison against a mirror of unknown age proves nothing.",
		);
		console.error("Re-run: LINKEDIN_CDP=1 node export.mjs, then this again.");
		process.exit(EXIT.broken);
	}
	if (age > maxAgeDays) {
		console.error(
			`\nThe mirror is ${age.toFixed(1)} days old (limit ${maxAgeDays}). A comparison against a stale mirror proves nothing.`,
		);
		console.error("Re-run: LINKEDIN_CDP=1 node export.mjs, then this again.");
		process.exit(EXIT.broken);
	}
	process.exit(stale ? EXIT.stale : EXIT.clean);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
