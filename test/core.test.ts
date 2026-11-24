// The logic that decides what is true and what may be written. Each check
// here was a real bug once, or would make the tool lie if it broke.

import { expect, test as it } from "@playwright/test";
import { dateLabel, parseDate, parseRange, rangeLabel } from "../src/dates.ts";
import { compared, compareField, exitCode, staleFields } from "../src/drift.ts";
import { Refused } from "../src/editor.ts";
import { mergeRecent, parseCsv, readExperience } from "../src/export.ts";
import { escapeRe, fieldFor, planSkills } from "../src/fields.ts";
import { bootstrapText } from "../src/init.ts";
import type { Mirror } from "../src/mirror.ts";
import { overLimit } from "../src/record.ts";
import {
	assertFreshForCreate,
	DEFAULTS,
	deleteTarget,
	driftIds,
	linkPlace,
	pickMedia,
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

it.describe("review findings", () => {
	it("an empty project or position block whose entry is missing is absent, not a match", () => {
		expect(verdicts(fence('project.n title="Not there"'))["project.n"]).toBe(
			"absent",
		);
		expect(verdicts(fence('project.w title="Widget"'))["project.w"]).toBe(
			"match",
		);
		expect(
			verdicts(fence('position.x match="Nowhere Inc"'))["position.x"],
		).toBe("absent");
	});
	it("an empty position or project block never writes a description", () => {
		const m = mirror();
		const pos = fieldFor(
			record(
				fence(
					'position.a match="Acme" role="Engineer" dates="Mar 2020 - Present"',
				),
			).get("position.a") as never,
		);
		const proj = fieldFor(
			record(fence('project.w title="Widget"')).get("project.w") as never,
		);
		const css = (steps: { control: object }[] | undefined) =>
			(steps ?? []).filter((s) => "css" in s.control);
		expect(css(pos.editor?.(m).steps)).toEqual([]);
		expect(css(proj.editor?.(m).steps)).toEqual([]);
	});
	it("no Experience section is 'none' when the positions read is empty", () => {
		const none = mirror();
		delete none.sections.Experience;
		none.entities.positions = [];
		expect(
			verdicts(fence('position.x match="Acme"', "Text."), none)["position.x"],
		).toBe("absent");
	});
	it("no Projects section is 'none' when the full collection read is empty, so the first one can be created", () => {
		const none = mirror();
		delete none.sections.Projects;
		none.entities.projects = [];
		const f = fieldFor(
			record(fence('project.n title="First"', "Text.")).get(
				"project.n",
			) as never,
		);
		expect(compareField(f, none)[0]?.verdict).toBe("absent");
		expect(f.editor?.(none).creating).toBe(true);
		delete none.entities.projects; // and not when the collection could not be read
		expect(compareField(f, none)[0]?.verdict).toBe("unreadable");
	});
});

it.describe("project media", () => {
	// Two items with one title, as LinkedIn left "Sean's Daily News Digest": a
	// link preview, then an old upload with a description.
	const withMedia = () => {
		const m = mirror();
		const p = m.sections.Projects?.[0];
		if (p)
			p.media = [
				{
					title: "It's live",
					kind: "LINK",
					url: "https://x.example/",
					thumbnail: true,
				},
				{
					title: "It's live",
					kind: "IMAGE",
					url: null,
					thumbnail: true,
					description: "Old screenshot",
				},
				{
					title: "Repo",
					kind: "LINK",
					url: "https://git.example/w",
					thumbnail: true,
				},
			];
		return m;
	};
	const project = (attrs: string) =>
		fieldFor(
			record(fence(`project.w title="Widget" ${attrs}`, "A widget.")).get(
				"project.w",
			) as never,
		);

	it("a title shared by two items needs --kind, and --kind picks its place among them", () => {
		const media = withMedia().sections.Projects?.[0]?.media ?? [];
		expect(() => pickMedia(media, "It's live")).toThrow(
			/2 media items .*LINK, IMAGE.*--kind/u,
		);
		expect(pickMedia(media, "It's live", "image")).toEqual({
			title: "It's live",
			nth: 1,
			of: 2,
			kind: "IMAGE",
			description: "Old screenshot",
		});
		expect(pickMedia(media, "Repo")).toMatchObject({
			nth: 0,
			of: 1,
			kind: "LINK",
		});
		expect(() => pickMedia(media, "It's live", "DOCUMENT")).toThrow(
			/0 media items/u,
		);
		expect(() => pickMedia(media, "Gone")).toThrow(
			/no media item titled "Gone".*"Repo"/u,
		);
	});
	it("a link differing by a trailing slash is the same link", () => {
		expect(
			verdicts(
				fence('project.w title="Widget" link="https://x.example"', "A widget."),
				withMedia(),
			)["project.w.link"],
		).toBe("match");
		expect(
			verdicts(
				fence(
					'project.w title="Widget" link="https://git.example/w/"',
					"A widget.",
				),
				withMedia(),
			)["project.w.link"],
		).toBe("match");
	});
	it("--add-link counts media only: a legacy Project URL is not 'already on'", () => {
		const m = withMedia();
		const f = project('link="https://legacy.example"');
		expect(linkPlace(f.project as never, "https://x.example", m)).toBe("media");
		expect(linkPlace(f.project as never, "https://legacy.example", m)).toBe(
			"absent",
		);
		const e = m.entities.projects?.[0];
		if (e) e.url = "https://legacy.example/";
		expect(linkPlace(f.project as never, "https://legacy.example", m)).toBe(
			"legacy",
		);
		// drift still counts it: a reader can click it
		expect(
			verdicts(
				fence(
					'project.w title="Widget" link="https://legacy.example"',
					"A widget.",
				),
				m,
			)["project.w.link"],
		).toBe("match");
	});
	it("escapeRe keeps quotes out of Playwright's selector string", () => {
		const re = new RegExp(
			`^${escapeRe(`Sean's "Digest" · #3018 (a/b)`)}$`,
			"u",
		);
		expect(re.test(`Sean's "Digest" · #3018 (a/b)`)).toBe(true);
		expect(re.source).not.toMatch(/['"]/u);
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

it("--recent puts new connections on top and leaves existing rows alone", () => {
	const head = ["name", "headline", "url", "connected_on"];
	const row = (n: string, d: string) => [
		n,
		'says "hi", ok',
		`https://www.linkedin.com/in/${n}/`,
		d,
	];
	const file = [head, row("b", "2026-11-01"), ["'=x", "", "u-old", ""]];
	const text = `${file.map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(",")).join("\n")}\n`;
	expect(parseCsv(text)).toEqual(file);
	const read = [
		head,
		row("d", "2026-11-20"),
		row("c", "2026-11-10"),
		row("b", "2026-11-01"),
	];
	const merged = mergeRecent(parseCsv(text), read);
	expect(merged).toEqual([
		head,
		row("d", "2026-11-20"),
		row("c", "2026-11-10"),
		...file.slice(1),
	]);
	expect(mergeRecent(merged, read)).toEqual(merged);
});

// 2026-11-11: LinkedIn left the Hivebrite group's own list out of one response, so its three
// roles read absent and drift matched another company's role text. A group the main list
// links must come back with its roles, or the read fails; a retry that brings it back is fine.
it.describe("readExperience", () => {
	const P = "ACoAAtest";
	const groupUrn = (h: string) =>
		`urn:li:fsd_profilePagedListComponent:(${P},EXPERIENCE_VIEW_DETAILS,urn:li:fsd_profilePositionGroup:(${P},${h}),NONE,en_US)`;
	const el = (title: string, extra: Record<string, unknown> = {}) => ({
		components: {
			entityComponent: { titleV2: { text: { text: title } }, ...extra },
		},
	});
	const plc = (deco: string, urn: string, els: unknown[]) => {
		const components = { elements: els, paging: { total: els.length } };
		return {
			decorationType: deco,
			entityUrn: urn,
			components,
			raw: { components },
		};
	};
	const main = plc(
		"LINE_SEPARATED",
		`urn:li:fsd_profilePagedListComponent:(${P},EXPERIENCE_VIEW_DETAILS,urn:li:fsd_profile:${P},NONE,en_US)`,
		[
			el("Acme", { "*pagedListComponent": groupUrn("aa11") }),
			el("Solo Corp role"),
		],
	);
	const group = plc("NONE", groupUrn("aa11"), [el("Senior"), el("Junior")]);
	const run = (responses: unknown[][]) => {
		let i = 0;
		// a test double for the Plcs reader: each call returns the next response
		const plcs = (async () =>
			responses[Math.min(i++, responses.length - 1)]) as unknown as Parameters<
			typeof readExperience
		>[0];
		return readExperience(plcs, []);
	};

	it("attaches a group's roles to its company", async () => {
		const out = await run([[main, group]]);
		expect(out[0]?.roles?.map((r) => r.title)).toEqual(["Senior", "Junior"]);
	});
	it("retries once when a linked group's roles are missing", async () => {
		const out = await run([[main], [main, group]]);
		expect(out[0]?.roles?.map((r) => r.title)).toEqual(["Senior", "Junior"]);
	});
	it("fails rather than read a company with no roles", async () => {
		await expect(run([[main], [main]])).rejects.toThrow(
			/listed without its roles/u,
		);
	});
});
