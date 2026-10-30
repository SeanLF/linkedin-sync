// Onboarding: export the live profile, then write a record that matches it
// exactly, so drift is clean on day one and you edit down from there. An
// existing record is never touched.

import { existsSync, writeFileSync } from "node:fs";
import { connect } from "./browser.ts";
import { renderedRange } from "./dates.ts";
import { compare } from "./drift.ts";
import { exportProfile } from "./export.ts";
import { educationKey, fieldFor } from "./fields.ts";
import { type Entity, type Mirror, writeMirror } from "./mirror.ts";
import { type Block, isType, RECORD_PATH } from "./record.ts";

const quote = (v: string) => JSON.stringify(v);
const fence = (id: string, attrs: Record<string, string>, text = "") =>
	`\`\`\`linkedin:${id}${Object.entries(attrs)
		.map(([k, v]) => ` ${k}=${quote(v)}`)
		.join("")}\n${text.trim()}\n\`\`\`\n`;
const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-|-$/gu, "")
		.slice(0, 40);

/** Whether a block reads its own entry back as a match, through the same field drift uses. */
function proves(
	id: string,
	attrs: Record<string, string>,
	text: string,
	m: Mirror,
): boolean {
	const type = id.split(".")[0] ?? "";
	if (!isType(type)) return false;
	const b: Block = { id, type, attrs, text, line: 0 };
	try {
		return compare(fieldFor(b), m).verdict === "match";
	} catch {
		return false;
	}
}

/** The match= that finds this education and no other: its degree, its school, or more of it. */
function educationMatch(
	e: Entity<"educations">,
	m: Mirror,
): string | undefined {
	const candidates = [
		e.degree,
		e.school,
		[e.school, e.degree].filter(Boolean).join(" · "),
		educationKey(e),
	];
	return [...new Set(candidates)].find(
		(c) => c && proves("education.x", { match: c }, e.description ?? "", m),
	);
}

type Unique = (base: string) => string;

/** One block per role with a description; a grouped company's roles need role=. */
function positionBlocks(m: Mirror, unique: Unique): string[] {
	return (m.sections.Experience ?? []).flatMap((e) => {
		const grouped = (e.roles?.length ?? 0) > 0;
		const company =
			((grouped ? e.title : e.subtitle) ?? "").split("·")[0]?.trim() ?? "";
		return (grouped ? (e.roles ?? []) : [e]).flatMap((r) => {
			if (!(r.description && company)) return [];
			const attrs = r.title
				? { match: company, role: r.title }
				: { match: company };
			const id = unique(`position.${slug(`${company} ${r.title ?? ""}`)}`);
			return proves(id, attrs, r.description, m)
				? [
						`## Position: ${r.title ?? company}\n`,
						fence(id, attrs, r.description),
					]
				: [];
		});
	});
}

/** One block per project with a description, its dates when they are a range a block accepts. */
function projectBlocks(m: Mirror, unique: Unique): string[] {
	return (m.sections.Projects ?? []).flatMap((p) => {
		if (!(p.title && p.description)) return [];
		const dates = renderedRange(p.subtitle);
		const attrs: Record<string, string> = { title: p.title };
		if (dates && /^[A-Z][a-z]{2} \d{4} - /u.test(dates)) attrs["dates"] = dates;
		const id = unique(`project.${slug(p.title)}`);
		return proves(id, attrs, p.description, m)
			? [`## Project: ${p.title}\n`, fence(id, attrs, p.description)]
			: [];
	});
}

/** The record text for a mirror, block by block. */
export function bootstrapText(
	m: Mirror,
	today = Temporal.Now.plainDateISO().toString(),
): string {
	const out = [
		`# LinkedIn record for ${m.vanityName}`,
		"",
		`Bootstrapped from the live profile on ${today}. Each \`linkedin:<id>\` block is a value this tool compares and writes; the prose around them is yours. Edit a block, run drift, then write.`,
		"",
		"## Headline\n",
		fence("headline", {}, m.headline),
	];
	if (m.sections.About)
		out.push("## About\n", fence("about", {}, m.sections.About));
	const used = new Set<string>();
	const unique = (base: string) => {
		let id = base;
		for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
		used.add(id);
		return id;
	};
	out.push(...positionBlocks(m, unique), ...projectBlocks(m, unique));
	const section = <E>(
		heading: string,
		type: string,
		rows: E[] | undefined,
		make: (e: E) => [string, Record<string, string>, string] | undefined,
	) => {
		const blocks = (rows ?? []).flatMap((e) => {
			const made = make(e);
			if (!made) return [];
			const [name, attrs, text] = made;
			const id = unique(`${type}.${slug(name) || "entry"}`);
			return proves(id, attrs, text, m) ? [fence(id, attrs, text)] : [];
		});
		if (blocks.length) out.push(`## ${heading}\n`, ...blocks);
	};
	const E = m.entities;
	section("Education", "education", E.educations, (e) => {
		const match = educationMatch(e, m);
		return match
			? [e.degree ?? e.school ?? "", { match }, e.description ?? ""]
			: undefined;
	});
	section("Honors & awards", "honor", E.honors, (e) =>
		e.title ? [e.title, { title: e.title }, e.description ?? ""] : undefined,
	);
	section("Publications", "publication", E.publications, (e) =>
		e.title ? [e.title, { title: e.title }, e.description ?? ""] : undefined,
	);
	section("Volunteering", "volunteer", E.volunteering, (e) =>
		e.role && e.organization
			? [e.role, { match: e.organization, role: e.role }, e.description ?? ""]
			: undefined,
	);
	section(
		"Licenses & certifications",
		"certification",
		E.certifications,
		(e) => (e.name ? [e.name, { name: e.name }, ""] : undefined),
	);
	if (E.skills?.length)
		out.push(
			"## Skills\n",
			fence("skills", {}, E.skills.map((s) => s.name).join("\n")),
		);
	return `${out.join("\n")}`;
}

export async function bootstrap(path = RECORD_PATH): Promise<void> {
	const s = await connect();
	let m: Mirror;
	try {
		m = await exportProfile(s);
	} finally {
		await s.close();
	}
	writeMirror(m);
	if (existsSync(path)) {
		console.log(
			`A record already exists at ${path}; left untouched. Run drift to compare it.`,
		);
		return;
	}
	writeFileSync(path, bootstrapText(m), { flag: "wx" });
	console.log(
		`Wrote ${path} from your live profile (it matches today). Edit it, then: linkedin-sync drift`,
	);
}
