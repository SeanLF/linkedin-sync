// The mirror: one JSON snapshot of the live profile, written by export and
// read by drift and write. Its shape is checked on every read; a mirror that
// does not match is a broken instrument, not an empty profile.
//
// `sections` is what the profile page renders (display strings); `entities`
// are the records the edit forms are built from, with the numeric ids the
// editor URLs take. A section or collection that could not be read in full is
// left out, never written empty: absent reads as unreadable, empty as "none".

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { z } from "zod";
import { ageDays } from "./dates.ts";

const ROOT = new URL("..", import.meta.url).pathname;
export const MIRROR_PATH =
	process.env["LINKEDIN_MIRROR"] ?? `${ROOT}mirror.json`;
export const LAST_WRITE_PATH = `${ROOT}last-write.json`;

// How old a mirror may be before a verdict drawn from it proves nothing.
export const MAX_AGE_DAYS = 14;

const Media = z.object({
	title: z.string(),
	kind: z.string(),
	url: z.string().nullable(),
	thumbnail: z.boolean(),
	description: z.string().optional(),
});
const Role = z.object({
	title: z.string().optional(),
	subtitle: z.string().optional(),
	dates: z.string().optional(),
	location: z.string().optional(),
	description: z.string().optional(),
	skills: z.array(z.string()).optional(),
	media: z.array(Media).optional(),
	company: z.string().optional(),
});
const Item = Role.extend({ roles: z.array(Role).optional() });
export type Item = z.infer<typeof Item>;
export type Role = z.infer<typeof Role>;

const Range = z.object({
	start: z.string().nullable(),
	end: z.string().nullable(),
});
const Occupation = z
	.object({ position: z.string() })
	.or(z.object({ education: z.string() }));
const id = z.string();
const s = z.string().optional();

export const ENTITIES = {
	positions: z.object({
		id,
		title: s,
		company: s,
		location: s,
		dates: Range.optional(),
		description: s,
	}),
	educations: z.object({
		id,
		school: s,
		degree: s,
		field: s,
		grade: s,
		activities: s,
		dates: Range.optional(),
		description: s,
	}),
	certifications: z.object({
		id,
		name: s,
		issuer: s,
		dates: Range.optional(),
		credentialId: s,
		url: s,
	}),
	honors: z.object({
		id,
		title: s,
		issuer: s,
		date: s,
		associated: Occupation.optional(),
		description: s,
	}),
	publications: z.object({
		id,
		title: s,
		publisher: s,
		date: s,
		url: s,
		description: s,
	}),
	volunteering: z.object({
		id,
		organization: s,
		role: s,
		cause: s,
		dates: Range.optional(),
		description: s,
	}),
	projects: z.object({
		id,
		title: s,
		url: s,
		dates: Range.optional(),
		associated: Occupation.optional(),
		description: s,
	}),
	skills: z.object({ id, name: z.string() }),
} as const;
export type EntityKind = keyof typeof ENTITIES;
export type Entity<K extends EntityKind> = z.infer<(typeof ENTITIES)[K]>;

export const SECTION_SLUGS = {
	Education: "education",
	Courses: "courses",
	"Honors & awards": "honors",
	Languages: "languages",
	Publications: "publications",
	Volunteering: "volunteering-experiences",
	Projects: "projects",
	"Licenses & certifications": "certifications",
	Featured: "featured",
} as const;
const list = z.array(Item).optional();

export const Mirror = z.object({
	name: z.string(),
	headline: z.string(),
	vanityName: z.string(),
	profileUrn: z.string(),
	exportedAt: z.iso.datetime(),
	sections: z.object({
		About: z.string().optional(),
		Causes: z.string().optional(),
		Experience: list,
		Skills: list,
		Recommendations: z.record(z.string(), z.array(Item)).optional(),
		...(Object.fromEntries(
			Object.keys(SECTION_SLUGS).map((k) => [k, list]),
		) as Record<keyof typeof SECTION_SLUGS, typeof list>),
	}),
	entities: z.object(
		Object.fromEntries(
			Object.entries(ENTITIES).map(([k, v]) => [k, z.array(v).optional()]),
		) as {
			[K in EntityKind]: z.ZodOptional<z.ZodArray<(typeof ENTITIES)[K]>>;
		},
	),
	warnings: z.array(z.string()).optional(),
});
export type Mirror = z.infer<typeof Mirror>;

export const readMirror = (path = MIRROR_PATH): Mirror =>
	Mirror.parse(JSON.parse(readFileSync(path, "utf8")));
export const writeMirror = (m: Mirror, path = MIRROR_PATH): void =>
	writeFileSync(path, `${JSON.stringify(Mirror.parse(m), null, 2)}\n`);

export const mirrorAge = (m: Mirror): number | null => ageDays(m.exportedAt);

/** One structured collection, or throw: a missing one is unreadable, not empty. */
export function entities<K extends EntityKind>(
	m: Mirror,
	kind: K,
): Entity<K>[] {
	const rows = m.entities[kind] as Entity<K>[] | undefined;
	if (!rows)
		throw new Error(
			`entities.${kind} missing from the mirror (the read failed; see its warnings). Re-export.`,
		);
	return rows;
}

/** One rendered section, or throw. */
export function section(
	m: Mirror,
	name: "Experience" | "Projects" | "Volunteering",
): Item[] {
	const rows = m.sections[name];
	if (!rows)
		throw new Error(`sections.${name} missing from the mirror. Re-export.`);
	return rows;
}

// When the last save started. A create refuses a mirror older than this: an
// entry created since reads as absent, and writing it again makes a duplicate.
const LastWrite = z.object({ at: z.iso.datetime(), what: z.array(z.string()) });
export type LastWrite = z.infer<typeof LastWrite>;

/** The last write, undefined when none was ever made; a garbled file throws (the guard must not vanish). */
export function readLastWrite(): LastWrite | undefined {
	let raw: string;
	try {
		raw = readFileSync(LAST_WRITE_PATH, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	return LastWrite.parse(JSON.parse(raw));
}
export const recordWrite = (what: string[]): void =>
	writeFileSync(
		LAST_WRITE_PATH,
		`${JSON.stringify({ at: new Date().toISOString(), what }, null, 2)}\n`,
	);
