// The logic that decides what is true and what may be written. Each check
// here was a real bug once, or would make the tool lie if it broke.

import { expect, test as it } from "@playwright/test";
import { dateLabel, parseDate, parseRange, rangeLabel } from "../src/dates.ts";
import { compared, compareField, exitCode, staleFields } from "../src/drift.ts";
import { Refused } from "../src/editor.ts";
import { fieldFor, planSkills } from "../src/fields.ts";
import { bootstrapText } from "../src/init.ts";
import type { Mirror } from "../src/mirror.ts";
import { overLimit } from "../src/record.ts";
import {
	assertFreshForCreate,
	DEFAULTS,
	deleteTarget,
	driftIds,
	skillsPlan,
} from "../src/write.ts";
import { mirror, record } from "./fixture.ts";

const fence = (head: string, body = "") =>
	`\`\`\`linkedin:${head}\n${body}\n\`\`\`\n`;
const verdicts = (text: string, m: Mirror = mirror()) =>
	Object.fromEntries(
		compared(record(text))
			.flatMap((f) => compareField(f, m))
			.map((r) => [r.id, r.verdict]),
	);

it.describe("dates", () => {
	it("parse what LinkedIn renders, refuse the rest", () => {
		expect(parseDate("Apr 2021")).toBe("2021-04");
		expect(parseDate("April 2021")).toBe("2021-04");
		expect(parseDate("Apr 1, 2021")).toBe("2021-04-01");
		expect(parseDate("2016")).toBe("2016");
		expect(parseDate("Junk 2015")).toBeNull(); // a prefix match once read this as June
		expect(parseDate("Feb 30, 2021")).toBeNull();
		expect(dateLabel("2021-04-01")).toBe("Apr 1, 2021");
	});
	it("ranges: Present, no end, and garbage throws", () => {
		expect(parseRange("Mar 2026 - Present")).toEqual({
			start: "2026-03",
			end: null,
		});
		expect(parseRange("Mar 2018")).toEqual({
			start: "2018-03",
			end: undefined,
		});
		expect(rangeLabel(parseRange("2010 – 2014"))).toBe("2010 - 2014");
		expect(() => parseRange("Mar 2016 - garbage")).toThrow(); // once read as "Mar 2016 - Present"
	});
});

it.describe("record", () => {
	it("reads attributes, escaped quotes included", () => {
		const b = record(
			fence(
				'project.w title="Say \\"hi\\"" dates="Mar 2024 - Present"',
				"A widget.",
			),
		).get("project.w");
		expect(b?.attrs).toEqual({
			title: 'Say "hi"',
			dates: "Mar 2024 - Present",
		});
		expect(b?.text).toBe("A widget.");
	});
	for (const [why, text] of [
		["an unknown type", fence("nonsense")],
		[
			"an unknown attribute (a typo manages nothing)",
			fence('project.w title="W" dats="2020"'),
		],
		["a missing identity", fence("project.w")],
		["malformed attributes", fence('project.w title="W')],
		["a duplicate id", fence("headline", "a") + fence("headline", "b")],
		["an unclosed block", "```linkedin:about\nnever closed\n"],
	] as const)
		it(`refuses ${why}`, () => expect(() => record(text)).toThrow());
	it("limits: text, a certification's empty body, skills", () => {
		const blocks = record(
			fence("headline", "x".repeat(221)) +
				fence('certification.c name="C"', "text"),
		);
		expect([...blocks.values()].flatMap(overLimit)).toHaveLength(2);
	});
});

it.describe("drift", () => {
	it("every verdict, including unreadable", () => {
		const v = verdicts(
			fence("headline", "Engineer of examples") +
				fence("about", "Something else.") +
				fence('project.n title="Not there"', "New.") +
				fence('honor.d title="Dean\'s List"'),
		);
		expect(v).toEqual({
			headline: "match",
			about: "drift",
			"project.n": "absent",
			"honor.d": "match",
		});
		const broken = mirror();
		delete broken.entities.honors;
		expect(
			verdicts(fence('honor.d title="Dean\'s List"'), broken)["honor.d"],
		).toBe("unreadable");
	});
	it("positions: role= picks one role at a company with several; without it, ambiguity is unreadable", () => {
		expect(
			verdicts(
				fence('position.g match="Globex" role="Engineer"', "Did things."),
			)["position.g"],
		).toBe("match");
		expect(
			verdicts(fence('position.g match="Globex"', "x"))["position.g"],
		).toBe("unreadable");
	});
	it("facets compare on their own line, as rendered", () => {
		const v = verdicts(
			fence(
				'project.w title="Widget" dates="Mar 2024 - Present"',
				"A widget.",
			) +
				fence(
					'volunteer.d match="Food Bank" role="Driver" cause="Poverty Alleviation" dates="Jan 2019 - Present"',
				),
		);
		expect(v).toMatchObject({
			"project.w.dates": "match",
			"volunteer.d.cause": "match",
			"volunteer.d.dates": "match",
		});
	});
	it("education match= prefers the entry it names exactly", () => {
		expect(
			verdicts(fence('education.b match="BSc" grade="" dates="2010 - 2014"')),
		).toMatchObject({
			"education.b": "match",
			"education.b.dates": "match",
			"education.b.grade": "match",
		});
	});
	it("skills: a case-only difference is a note, not drift", () => {
		const [r] = compareField(
			fieldFor(
				record(fence("skills", "Javascript\nPostgreSQL")).get(
					"skills",
				) as never,
			),
			mirror(),
		);
		expect(r?.verdict).toBe("match");
		expect(r?.skills?.recase).toEqual([
			{ record: "Javascript", live: "JavaScript" },
		]);
		expect(planSkills(["JavaScript"], ["javascript", "Rust"])).toEqual({
			add: ["Rust"],
			remove: [],
			recase: [{ record: "javascript", live: "JavaScript" }],
		});
	});
	it("a mirror too old, or of unknown age, is a broken instrument (exit 2)", () => {
		const fields = compared(record(fence("headline", "Engineer of examples")));
		const fresh = mirror();
		expect(
			exitCode(
				fields.flatMap((f) => compareField(f, fresh)),
				fresh,
			),
		).toBe(0);
		const old = mirror({ exportedAt: "2020-01-01T00:00:00.000Z" });
		expect(
			exitCode(
				fields.flatMap((f) => compareField(f, old)),
				old,
			),
		).toBe(2);
		expect(exitCode([], old, Number.NaN)).toBe(2); // a NaN limit must not switch the guard off
	});
});

it.describe("write safety", () => {
	const options = DEFAULTS;
	it("no create from an old mirror, or one older than the last write", () => {
		const old = mirror({ exportedAt: "2020-01-01T00:00:00.000Z" });
		expect(() => assertFreshForCreate(old, "x", undefined, 14)).toThrow(
			Refused,
		);
		const m = mirror();
		expect(() =>
			assertFreshForCreate(
				m,
				"x",
				{ at: new Date(Date.now() + 60_000).toISOString(), what: [] },
				14,
			),
		).toThrow(/predates/u);
		expect(() => assertFreshForCreate(m, "x", undefined, 14)).not.toThrow();
		expect(() => assertFreshForCreate(m, "x", undefined, 0)).toThrow(Refused); // --max-age-days honoured
	});
	it("a create is planned only when the mirror's collection was read", () => {
		const b = record(fence('honor.n title="New award"')).get("honor.n");
		const f = fieldFor(b as never);
		expect(f.editor?.(mirror()).creating).toBe(true);
		const partial = mirror();
		delete partial.entities.honors;
		expect(() => f.editor?.(partial)).toThrow(/missing/u);
	});
	it("skills: empty block and mass removal refused", () => {
		expect(() => skillsPlan(mirror(), "", false)).toThrow(/empty/u);
		const many = mirror();
		many.entities.skills = Array.from({ length: 40 }, (_, i) => ({
			id: String(i),
			name: `Skill ${i}`,
		}));
		expect(() => skillsPlan(many, "Skill 0", false)).toThrow(/more than/u);
		expect(skillsPlan(many, "Skill 0", true).remove).toHaveLength(39);
	});
	it("--all-drift refuses a mirror older than the last write, and lists stale blocks", () => {
		const fields = compared(
			record(
				fence("headline", "Changed") + fence("about", "I write examples."),
			),
		);
		expect(driftIds(fields, mirror(), undefined, options)).toEqual([
			"headline",
		]);
		expect(() =>
			driftIds(
				fields,
				mirror(),
				{ at: new Date(Date.now() + 60_000).toISOString(), what: [] },
				options,
			),
		).toThrow(/predates/u);
		expect(staleFields(fields, mirror()).stale).toEqual(["headline"]);
	});
	it("--delete finds one live entry, by identity words and key=value", () => {
		expect(
			deleteTarget("volunteer", ["Food", "Bank", "role=Driver"], mirror()).ed
				.path,
		).toBe("details/volunteer-experiences/edit/forms/50/");
		expect(deleteTarget("skill", ["PostgreSQL"], mirror()).ed.path).toBe(
			"details/skills/edit/forms/71/",
		);
		expect(() => deleteTarget("honor", ["Nope"], mirror())).toThrow(
			/no live honor/u,
		);
	});
	it("an editor checks it holds the right entry", () => {
		const ed = fieldFor(
			record(fence('position.a match="Acme" role="Engineer"', "New text.")).get(
				"position.a",
			) as never,
		).editor?.(mirror());
		expect(ed?.identity).toEqual([
			{ control: { label: /^Job title\*?$/iu, nth: 0 }, value: "Engineer" },
		]);
		expect(ed?.notify).toBe("required");
	});
});

it("init writes a record that matches the profile it came from", () => {
	const m = mirror();
	const results = compared(record(bootstrapText(m, "2026-01-01"))).flatMap(
		(f) => compareField(f, m),
	);
	expect(results.length).toBeGreaterThan(8);
	expect(results.filter((r) => r.verdict !== "match")).toEqual([]);
});
