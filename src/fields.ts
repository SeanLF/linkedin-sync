// The one map from a record block to LinkedIn: where its live value is read
// in the mirror, which other values (facets) it manages, and how its editor
// is filled. Drift and write both build from here, so they cannot disagree
// about where a field lives.
//
// Read contract: return the live string, undefined when the entry is absent,
// and throw when the mirror's shape is wrong (drift reports that as
// unreadable, never as a difference or a match).
//
// Editor labels come from read-only probes of each dialog (2026-09 and
// 2026-10). They are anchored regexes because getByLabel with a string is a
// substring match: "Role" would also hit "I am currently volunteering in
// this role".

import {
	dateLabel,
	type IsoDate,
	MONTH_NAMES,
	monthRange,
	parseDate,
	parseRange,
	type Range,
	rangeLabel,
	renderedRange,
	usDate,
} from "./dates.ts";
import {
	type Entity,
	type EntityKind,
	entities,
	type Item,
	type Mirror,
	section,
} from "./mirror.ts";
import { type Block, skillList, type Type } from "./record.ts";

/** What an attribute set to "" compares as: "must be empty", unlike leaving it out ("not managed"). */
const NONE = "(none)";
/** The main value of a block with no text: the entry's presence. */
export const PRESENT = "(present)";
const OK_MEDIA = "no stale media";

export type Control = { label: RegExp; nth?: number } | { css: string };
export type Step =
	| { kind: "text"; control: Control; value: string }
	| { kind: "select"; control: Control; option: string }
	| { kind: "check"; control: Control; value: boolean };

/** How to open and fill one editor; the writer runs it, generically. */
export interface Editor {
	/** Path under /in/<vanity>/. */
	path: string;
	creating: boolean;
	heading: RegExp;
	/** Controls that must already read these values: the editor is for the right entry. */
	identity: { control: Control; value: string }[];
	steps: Step[];
	/** "required": the editor must show a share-with-network switch, and it must be off. */
	notify: "required" | "if-present";
	deleteButton?: string;
}

export interface Facet {
	id: string;
	desired: string;
	read: (m: Mirror) => string | undefined;
	/** Not written by `write <id>` (a link is --add-link; media is LinkedIn's preview). */
	unwritten?: true;
	/** No line at all when there is nothing to read. */
	optional?: true;
}

export interface Field {
	id: string;
	type: Type;
	label: string;
	desired: string;
	read: (m: Mirror) => string | undefined;
	facets: Facet[];
	/** The editor that brings LinkedIn to the record; throws on a shape error. */
	editor?: (m: Mirror) => Editor;
	/** For deletes: the editor of the live entry, without changes. */
	project?: { title: string; link?: string; urls: (m: Mirror) => string[] };
}

const lc = (s: string | undefined) => (s ?? "").toLowerCase();
/** A string as a literal regex. */
export const escapeRe = (s: string): string =>
	s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const anyCase = (s: string) => new RegExp(escapeRe(s), "iu");
const orNone = (v: string | undefined) => (v ? v : NONE);
const label = (pattern: string, nth = 0): Control => ({
	label: new RegExp(pattern, "iu"),
	nth,
});
const text = (pattern: string, value: string): Step => ({
	kind: "text",
	control: label(pattern),
	value,
});
const select = (pattern: string, option: string, nth = 0): Step => ({
	kind: "select",
	control: label(pattern, nth),
	option,
});
const check = (pattern: string, value: boolean): Step => ({
	kind: "check",
	control: label(pattern),
	value,
});

function onlyOne<T>(hits: T[], what: string): T | undefined {
	if (hits.length > 1)
		throw new Error(
			`${what} hits ${hits.length} entries; make the block's attributes more specific`,
		);
	return hits[0];
}

/** Month and Year selects; a year-only date leaves Month blank, no date blanks both. */
const monthYear = (
	iso: IsoDate | undefined,
	nth: number,
	month = "^Month$",
	year = "^Year$",
): Step[] => {
	const [y, m] = iso ? iso.split("-") : [];
	return [
		select(month, m ? (MONTH_NAMES[Number(m) - 1] ?? "") : "", nth),
		select(year, y ?? "", nth),
	];
};

// --- Positions -----------------------------------------------------------------

/**
 * The rendered role a position block means. With role=, the company must
 * match and the title equal; without it, "Acme" may hit every role at Acme,
 * which throws rather than guess.
 */
function experienceByCompany(
	m: Mirror,
	rx: RegExp,
	role: string | undefined,
): Item | undefined {
	const xp = section(m, "Experience");
	const hits = xp.flatMap((e) => {
		const grouped = (e.roles?.length ?? 0) > 0;
		const company = (grouped ? e.title : e.subtitle) ?? "";
		return (grouped ? (e.roles ?? []) : [e]).filter((r) =>
			role
				? rx.test(company) && lc(r.title) === lc(role)
				: [e.subtitle, e.title, r.title].some((v) => rx.test(v ?? "")),
		);
	});
	if (hits.length > 1)
		throw new Error(
			`match ${rx}${role ? ` role="${role}"` : ""} hits ${hits.length} experience entries; make match= more specific${role ? "" : ', or add role="Exact role title"'}`,
		);
	if (hits.length === 0 && role) return byTypedCompany(m, xp, rx, role);
	return hits[0];
}

// The page groups roles under a linked company page's name, the API has the
// name typed on the role ("University" vs "Université Exemple", 2026-10-29).
// One typed role with this title at a matching company, and one rendered role
// with that title anywhere: the same role. Anything less certain is absent.
function byTypedCompany(
	m: Mirror,
	xp: Item[],
	rx: RegExp,
	role: string,
): Item | undefined {
	const typed = (m.entities.positions ?? []).filter(
		(p) => rx.test(p.company ?? "") && lc(p.title) === lc(role),
	);
	const shown = xp
		.flatMap((e) => ((e.roles?.length ?? 0) > 0 ? (e.roles ?? []) : [e]))
		.filter((r) => lc(r.title) === lc(role));
	return typed.length === 1 && shown.length === 1 ? shown[0] : undefined;
}

function positionField(b: Block): Field {
	const { match = "", role, dates, company } = b.attrs;
	const rx = anyCase(match);
	const what = `match ${rx}${role ? ` role="${role}"` : ""}`;
	const entity = (m: Mirror) =>
		onlyOne(
			entities(m, "positions").filter(
				(e) => rx.test(e.company ?? "") && (!role || lc(e.title) === lc(role)),
			),
			what,
		);
	const range =
		dates === undefined ? undefined : monthRange(dates, "a position's");
	const facets: Facet[] = [];
	if (range)
		facets.push({
			id: `${b.id}.dates`,
			desired: rangeLabel(range),
			// As rendered: the page is what people see.
			read: (m) => {
				const r = experienceByCompany(m, rx, role);
				return r ? (renderedRange(r.dates) ?? NONE) : undefined;
			},
		});
	if (company !== undefined)
		facets.push({
			id: `${b.id}.company`,
			desired: orNone(company),
			read: (m) => {
				const e = entity(m);
				return e ? orNone(e.company) : undefined;
			},
		});
	return {
		id: b.id,
		type: "position",
		label: `Position (${role ? `${role} at ` : ""}${match})`,
		// An empty block compares the role's presence: "both empty" must not hide a missing role.
		desired: b.text.trim() ? b.text : PRESENT,
		read: (m) => {
			const r = experienceByCompany(m, rx, role);
			if (!r) return;
			return b.text.trim() ? r.description : PRESENT;
		},
		facets,
		editor: (m) => {
			const e = entity(m);
			if (!e)
				throw new Error(
					`no role in entities.positions fits ${what}; positions are never created here`,
				);
			// An empty block manages presence and dates, never the description.
			const steps: Step[] = b.text.trim()
				? [
						{
							kind: "text",
							control: { css: '[contenteditable="true"]' },
							value: b.text,
						},
					]
				: [];
			if (company !== undefined)
				steps.push(text("^Company or organization", company));
			if (range) steps.push(...roleDates(range, "working", "Start", "End"));
			return {
				path: `details/experience/edit/forms/${e.id}/`,
				creating: false,
				heading: /^Edit role$/iu, // probe 2026-10-30
				identity: [{ control: label("^Job title\\*?$"), value: e.title ?? "" }],
				steps,
				notify: "required",
			};
		},
	};
}

/** The "currently" box first (it hides or shows the end), then start, then end. */
function roleDates(d: Range, verb: string, start: string, end: string): Step[] {
	return [
		check(`^I am currently ${verb} in this role$`, d.end === null),
		...monthYear(d.start, 0, `^${start} month$`, `^${start} year`),
		...(d.end ? monthYear(d.end, 0, `^${end} month$`, `^${end} year`) : []),
	];
}

// --- Projects -----------------------------------------------------------------

function projectField(b: Block): Field {
	const { title = "", dates, link } = b.attrs;
	// The page has no Projects section at all when there are none: that is
	// "none" only if the full collection read says so, else it is unreadable.
	const shown = (m: Mirror) =>
		section(m, "Projects").find((p) => p.title === title);
	const record = (m: Mirror) =>
		onlyOne(
			entities(m, "projects").filter((p) => p.title === title),
			`title="${title}"`,
		);
	const range =
		dates === undefined ? undefined : monthRange(dates, "a project's");
	// What a reader can click: external media links, plus the legacy "Project URL".
	const urls = (m: Mirror) => {
		const r = shown(m);
		const e = record(m);
		const out = (r?.media ?? []).flatMap((x) => (x.url ? [x.url] : []));
		if (e?.url) out.push(e.url);
		return out;
	};
	const facets: Facet[] = [];
	if (range)
		facets.push({
			id: `${b.id}.dates`,
			desired: rangeLabel(range),
			// The rendered subtitle: LinkedIn shows "... - Present" for projects
			// whose API range ends where it starts (2026-10-29).
			read: (m) => {
				const r = shown(m);
				return r ? (renderedRange(r.subtitle) ?? NONE) : undefined;
			},
		});
	if (link !== undefined)
		facets.push({
			id: `${b.id}.link`,
			desired: link,
			unwritten: true,
			read: (m) => {
				const r = shown(m);
				if (!r) return;
				const seen = urls(m);
				if (seen.includes(link)) return link;
				const hidden = (r.media ?? []).filter(
					(x) => x.kind === "LINK" && !x.url,
				).length;
				const listed = seen.length ? seen.join(" | ") : NONE;
				return hidden
					? `${listed} (+${hidden} link LinkedIn does not expose)`
					: listed;
			},
		});
	return {
		id: b.id,
		type: "project",
		label: `Project: ${title}`,
		// An empty block compares the project's presence, as a section entry's does.
		desired: b.text.trim() ? b.text : PRESENT,
		read: (m) => {
			const r = shown(m);
			if (!r) return;
			return b.text.trim() ? r.description : PRESENT;
		},
		facets,
		project: { title, urls, ...(link === undefined ? {} : { link }) },
		editor: (m) => {
			// Present in either read is present, even with no description: an edit, never a create.
			const e = record(m);
			const exists = Boolean(shown(m) || e);
			if (exists && !e)
				throw new Error(
					`"${title}" is on the page but not in entities.projects; re-export`,
				);
			const steps: Step[] = [];
			if (!e) steps.push(text("^Project name\\*?$", title));
			if (b.text.trim())
				steps.push({
					kind: "text",
					control: { css: "textarea" },
					value: b.text,
				});
			if (range)
				steps.push(
					...monthYear(range.start, 0),
					check("^I am currently working on this project$", range.end === null),
					...(range.end ? monthYear(range.end, 1) : []),
				);
			return {
				path: e
					? `details/projects/edit/forms/${e.id}/`
					: "edit/forms/project/new/",
				creating: !e,
				heading: /project/iu,
				identity: e
					? [{ control: label("^Project name\\*?$"), value: title }]
					: [],
				steps,
				notify: "if-present",
				deleteButton: "Delete project",
			};
		},
	};
}

/** Media health, for a project with media: links LinkedIn could not preview, and dead ones under --check-links. */
export function mediaFacet(
	f: Field,
	linkStatus: ReadonlyMap<string, number | string>,
): Facet | undefined {
	const p = f.project;
	if (!p) return undefined;
	return {
		id: `${f.id}.media`,
		desired: OK_MEDIA,
		unwritten: true,
		optional: true,
		read: (m) => {
			const r = section(m, "Projects").find((x) => x.title === p.title);
			const urls = p.urls(m);
			if (!(r && (urls.length || r.media?.length))) return;
			const problems = [
				...(r.media ?? [])
					.filter((x) => x.kind === "LINK" && !(x.url || x.thumbnail))
					.map(
						(x) => `"${x.title}": link with no preview and no visible target`,
					),
				...urls.flatMap((u) => {
					const status = linkStatus.get(u);
					if (
						status === undefined ||
						(typeof status === "number" && status >= 200 && status < 400)
					)
						return [];
					return [
						`${u}: ${typeof status === "number" ? `HTTP ${status}` : status}`,
					];
				}),
			];
			return problems.length ? problems.join("; ") : OK_MEDIA;
		},
	};
}

// --- Section entries (education, honours, publications, volunteering, certifications) ---

type Read<E> = (
	e: E,
	m: Mirror,
	raw: string,
) => string | readonly string[] | undefined;
interface FacetSpec<E> {
	read: Read<E>;
	/** The record's value: what it compares as, and the steps that set it ("" clears). */
	set: (raw: string) => { want: string; steps: Step[] };
	canon?: (s: string) => string;
	/** Steps to retype a stored value the block does not manage (see publication.date). */
	always?: (e: E) => Step[] | undefined;
}
interface FormSpec<K extends EntityKind> {
	kind: K;
	identity: string;
	heading: string;
	deleteButton: string;
	newPath: string;
	editPath: (id: string) => string;
	locate: (
		rows: Entity<K>[],
		attrs: Record<string, string>,
		m: Mirror,
	) => Entity<K> | undefined;
	expect: (e: Entity<K>) => { control: Control; value: string }[];
	create: (attrs: Record<string, string>) => Step[];
	required?: string[];
	facets: Record<string, FacetSpec<Entity<K>>>;
	description: string | null;
}

const textFacet = <E>(
	pattern: string,
	read: (e: E) => string | undefined,
): FacetSpec<E> => ({
	read,
	set: (raw) => ({ want: orNone(raw), steps: [text(pattern, raw)] }),
});
const rangeRead = (
	r: { start: string | null; end: string | null } | undefined,
) =>
	r?.start
		? rangeLabel({ start: r.start, end: r.end ?? undefined })
		: undefined;
const startEnd = (validate: (d: Range) => void) => (raw: string) => {
	if (!raw)
		return {
			want: NONE,
			steps: [...monthYear(undefined, 0), ...monthYear(undefined, 1)],
		};
	const d = parseRange(raw);
	validate(d);
	return {
		want: rangeLabel(d),
		steps: [...monthYear(d.start, 0), ...monthYear(d.end ?? undefined, 1)],
	};
};
// "SCIENCE_AND_TECHNOLOGY" -> "Science and Technology", the option's label.
const causeLabel = (v: string) =>
	v
		.toLowerCase()
		.split("_")
		.map((w, i) =>
			i > 0 && w === "and" ? w : `${w.charAt(0).toUpperCase()}${w.slice(1)}`,
		)
		.join(" ");
/** What an education's match= is tested against. */
export const educationKey = (e: Entity<"educations">): string =>
	[e.school, e.degree, e.field].filter(Boolean).join(" · ");
const editPath = (sectionSlug: string) => (id: string) =>
	`details/${sectionSlug}/edit/forms/${id}/`;
const titled = <E extends { title?: string | undefined }>(
	rows: E[],
	a: Record<string, string>,
) =>
	onlyOne(
		rows.filter((e) => e.title === a["title"]),
		`title="${a["title"]}"`,
	);

/** The labels the "Associated with" select could show for a linked entry. */
function associationLabels(
	m: Mirror,
	assoc: Entity<"honors">["associated"],
): string[] {
	if (!assoc) return [];
	if ("position" in assoc) {
		const e = entities(m, "positions").find((x) => x.id === assoc.position);
		return e ? [`${e.title} at ${e.company}`, e.title ?? ""] : [];
	}
	const e = entities(m, "educations").find((x) => x.id === assoc.education);
	return e
		? [
				`Student at ${[e.school, e.degree, e.field].filter(Boolean).join(", ")}`,
				e.school ?? "",
			]
		: [];
}

const FORMS = {
	education: {
		kind: "educations",
		identity: "match",
		heading: "education",
		deleteButton: "Delete education",
		newPath: "details/education/edit/forms/new/",
		editPath: editPath("education"),
		// match= is a substring of "school · degree · field". When it hits
		// several, one whose whole key, school or degree it equals wins ("Uni ·
		// BSc" is also inside "Uni · BSc · Physics").
		locate: (rows, a) => {
			const want = a["match"] ?? "";
			const hits = rows.filter((e) => anyCase(want).test(educationKey(e)));
			const exact = hits.filter((e) =>
				[educationKey(e), e.school, e.degree].some((v) => lc(v) === lc(want)),
			);
			return onlyOne(
				hits.length > 1 && exact.length === 1 ? exact : hits,
				`match="${want}"`,
			);
		},
		expect: (e) => [{ control: label("^School\\*?$"), value: e.school ?? "" }],
		create: () => [],
		required: ["school"],
		facets: {
			school: textFacet("^School\\*?$", (e) => e.school),
			degree: textFacet("^Degree$", (e) => e.degree),
			field: textFacet("^Field of study$", (e) => e.field),
			dates: {
				read: (e) => rangeRead(e.dates),
				set: startEnd((d) => {
					if (d.end === null)
						throw new Error(
							"an education has an end date (or expected), not Present",
						);
				}),
			},
			grade: textFacet("^Grade", (e) => e.grade),
			activities: textFacet("^Activities and societies", (e) => e.activities),
		},
		description: "^Description",
	} satisfies FormSpec<"educations">,
	honor: {
		kind: "honors",
		identity: "title",
		heading: "honors",
		deleteButton: "Delete honors & awards",
		newPath: "details/honors/edit/forms/new/",
		editPath: editPath("honors"),
		locate: titled,
		expect: (e) => [{ control: label("^Title\\*?$"), value: e.title ?? "" }],
		create: (a) => [text("^Title\\*?$", a["title"] ?? "")],
		facets: {
			issuer: textFacet("^Issuer$", (e) => e.issuer),
			date: {
				read: (e) => (e.date ? dateLabel(e.date.slice(0, 7)) : undefined),
				set: (raw) => {
					if (!raw) return { want: NONE, steps: monthYear(undefined, 0) };
					const d = parseDate(raw);
					// Month and Year selects; Month may stay blank.
					if (!d || d.length > 7)
						throw new Error(
							`an honour's date is "Mon YYYY" or "YYYY", got ${JSON.stringify(raw)}`,
						);
					return { want: dateLabel(d), steps: monthYear(d, 0) };
				},
			},
			// "Software Engineer at Acme": the select's option for the linked entry.
			associated: {
				read: (e, m) => associationLabels(m, e.associated),
				set: (raw) => ({
					want: orNone(raw),
					steps: [select("^Associated with$", raw)],
				}),
			},
		},
		description: "^Description$",
	} satisfies FormSpec<"honors">,
	publication: {
		kind: "publications",
		identity: "title",
		heading: "publication",
		deleteButton: "Delete publication",
		newPath: "edit/forms/publication/new/",
		editPath: editPath("publications"),
		locate: titled,
		expect: (e) => [{ control: label("^Title\\*?$"), value: e.title ?? "" }],
		create: (a) => [text("^Title\\*?$", a["title"] ?? "")],
		facets: {
			publisher: textFacet("^Publication/Publisher$", (e) => e.publisher),
			// One mm/dd/yyyy box that showed the day before for a date stored as
			// the 1st (2026-10-29), so saving it untouched would move it back a
			// day: the writer always types a date, the record's or the stored one.
			// Compared at the record's precision: "Sep 2021" matches 2021-09-01.
			date: {
				read: (e, _m, raw) => {
					if (!e.date) return;
					const want = raw ? parseDate(raw) : null;
					return dateLabel(e.date.slice(0, want?.length ?? 10));
				},
				set: (raw) => {
					if (!raw)
						return { want: NONE, steps: [text("^Publication date$", "")] };
					const d = parseDate(raw);
					if (!d || d.length < 7)
						throw new Error(
							`a publication date is "Mon YYYY" or "Mon D, YYYY" (the box takes a full date), got ${JSON.stringify(raw)}`,
						);
					return {
						want: dateLabel(d),
						steps: [text("^Publication date$", usDate(d))],
					};
				},
				always: (e) =>
					e.date && e.date.length >= 7
						? [text("^Publication date$", usDate(e.date))]
						: undefined,
			},
			url: textFacet("^Publication URL$", (e) => e.url),
		},
		description: "^Description$",
	} satisfies FormSpec<"publications">,
	volunteer: {
		kind: "volunteering",
		identity: "match",
		heading: "volunteer",
		deleteButton: "Delete volunteer experience",
		newPath: "details/volunteer-experiences/edit/forms/new/",
		editPath: editPath("volunteer-experiences"),
		locate: (rows, a) => {
			const rx = anyCase(a["match"] ?? "");
			return onlyOne(
				rows.filter(
					(e) =>
						rx.test(e.organization ?? "") &&
						(!a["role"] || e.role === a["role"]),
				),
				`match="${a["match"]}"${a["role"] ? ` role="${a["role"]}"` : ""}`,
			);
		},
		expect: (e) => [
			{ control: label("^Organization\\*?$"), value: e.organization ?? "" },
			{ control: label("^Role\\*?$"), value: e.role ?? "" },
		],
		create: (a) => [
			text("^Organization\\*?$", a["match"] ?? ""),
			text("^Role\\*?$", a["role"] ?? ""),
		],
		required: ["role"],
		facets: {
			cause: {
				read: (e) => (e.cause ? causeLabel(e.cause) : undefined),
				canon: (s) =>
					lc(s)
						.replace(/[^a-z]+/gu, " ")
						.trim(),
				set: (raw) => ({ want: orNone(raw), steps: [select("^Cause$", raw)] }),
			},
			// Rendered, like a position's: the same "currently" question applies.
			dates: {
				read: (e, m) => {
					const r = onlyOne(
						section(m, "Volunteering").filter(
							(x) => x.title === e.role && x.subtitle === e.organization,
						),
						`rendered volunteering "${e.role}" at ${e.organization}`,
					);
					if (!r)
						throw new Error(
							`"${e.role}" at ${e.organization} is in the API but not on the page`,
						);
					return renderedRange(r.dates) ?? NONE;
				},
				set: (raw) => {
					if (!raw)
						throw new Error(
							'a volunteer role needs a start date; dates="" cannot clear it',
						);
					const d = monthRange(raw, "volunteer");
					return {
						want: rangeLabel(d),
						steps: [
							check(
								"^I am currently volunteering in this role$",
								d.end === null,
							),
							...monthYear(d.start, 0),
							...(d.end ? monthYear(d.end, 1) : []),
						],
					};
				},
			},
		},
		description: "^Description",
	} satisfies FormSpec<"volunteering">,
	certification: {
		kind: "certifications",
		identity: "name",
		heading: "license or certification",
		deleteButton: "Delete license or certification",
		newPath: "details/certifications/edit/forms/new/",
		editPath: editPath("certifications"),
		locate: (rows, a) =>
			onlyOne(
				rows.filter((e) => e.name === a["name"]),
				`name="${a["name"]}"`,
			),
		expect: (e) => [{ control: label("^Name\\*?$"), value: e.name ?? "" }],
		create: (a) => [text("^Name\\*?$", a["name"] ?? "")],
		facets: {
			issuer: textFacet("^Issuing organization", (e) => e.issuer),
			// "Mar 2018" (no expiry) or "Mar 2018 - Mar 2021" (issued - expires).
			dates: {
				read: (e) => rangeRead(e.dates),
				set: startEnd((d) => {
					if (d.end === null)
						throw new Error("a certification expires on a date, not Present");
				}),
			},
			credential: textFacet("^Credential ID$", (e) => e.credentialId),
			url: textFacet("^Credential URL$", (e) => e.url),
		},
		description: null,
	} satisfies FormSpec<"certifications">,
} as const;
export type FormType = keyof typeof FORMS;
export const identityAttr = (t: FormType): string => FORMS[t].identity;

function formField<K extends EntityKind>(b: Block, spec: FormSpec<K>): Field {
	const key = b.attrs[spec.identity];
	if (!key)
		throw new Error(
			`block "${b.id}" needs ${spec.identity}="..." to find its entry`,
		);
	const locate = (m: Mirror) => spec.locate(entities(m, spec.kind), b.attrs, m);
	// With text, the description is the main value; without (or with no
	// description on this type), the entry's presence is.
	const describes = spec.description !== null && b.text.trim() !== "";
	const facets: Facet[] = [];
	const steps: Step[] = [];
	const managed = new Set<string>();
	for (const [name, fs] of Object.entries(spec.facets)) {
		const raw = b.attrs[name];
		if (raw === undefined) continue;
		managed.add(name);
		const { want, steps: set } = fs.set(raw);
		steps.push(...set);
		const canon = fs.canon ?? ((s: string) => s);
		facets.push({
			id: `${b.id}.${name}`,
			desired: want,
			read: (m) => {
				const e = locate(m);
				if (!e) return;
				const live = fs.read(e, m, raw);
				const one =
					typeof live === "string" || live === undefined
						? live
						: (live.find((l) => canon(l) === canon(want)) ?? live[0]);
				const shown = orNone(one);
				return canon(shown) === canon(want) ? want : shown;
			},
		});
	}
	return {
		id: b.id,
		type: b.type,
		label: `${b.type}: ${key}`,
		desired: describes ? b.text : PRESENT,
		read: (m) => {
			const e = locate(m);
			if (!e) return;
			return describes
				? ((e as { description?: string }).description ?? "")
				: PRESENT;
		},
		facets,
		editor: (m) => {
			const e = locate(m);
			const missing = (spec.required ?? []).filter(
				(r) => b.attrs[r] === undefined,
			);
			if (!e && missing.length)
				throw new Error(
					`${b.id} is not on LinkedIn yet; creating it needs ${missing.map((r) => `${r}="..."`).join(" ")}`,
				);
			const retype = e
				? Object.entries(spec.facets).flatMap(([name, fs]) =>
						managed.has(name) ? [] : (fs.always?.(e) ?? []),
					)
				: [];
			const all = [
				...(e ? [] : spec.create(b.attrs)),
				...steps,
				...retype,
				...(spec.description && describes
					? [text(spec.description, b.text)]
					: []),
			];
			return {
				path: e ? spec.editPath(e.id) : spec.newPath,
				creating: !e,
				heading: new RegExp(spec.heading, "iu"),
				identity: e ? spec.expect(e) : [],
				steps: all,
				notify: "if-present",
				deleteButton: spec.deleteButton,
			};
		},
	};
}

/** The editor that deletes one live entry of a section type, found as a block of that type would find it. */
export function deleteEditor(
	type: FormType | "project",
	attrs: Record<string, string>,
	m: Mirror,
): Editor {
	const f = fieldFor({ id: `${type}.delete`, type, attrs, text: "", line: 0 });
	const e = f.editor?.(m);
	if (!e || e.creating)
		throw new Error(`no live ${type} matches ${JSON.stringify(attrs)}`);
	return { ...e, steps: [] };
}

// --- Skills --------------------------------------------------------------------

/**
 * What it takes to bring the live skill names to the record's, compared
 * without case: LinkedIn spells a skill, so "Javascript" in the record and
 * "JavaScript" live are the same one. Those are `recase` (fix the record),
 * never a delete plus an add, which would remove the entity the add picked.
 */
export function planSkills(live: string[], want: string[]) {
	const liveBy = new Map(live.map((n) => [lc(n), n]));
	const wantBy = new Map(want.map((n) => [lc(n), n]));
	return {
		add: [...wantBy].filter(([k]) => !liveBy.has(k)).map(([, n]) => n),
		remove: [...liveBy].filter(([k]) => !wantBy.has(k)).map(([, n]) => n),
		recase: [...wantBy].flatMap(([k, n]) => {
			const l = liveBy.get(k);
			return l !== undefined && l !== n ? [{ record: n, live: l }] : [];
		}),
	};
}
const sorted = (xs: string[]) =>
	[...xs].sort((a, b) => a.localeCompare(b, "en")).join("\n");

// --- Build -----------------------------------------------------------------------

export function fieldFor(b: Block): Field {
	switch (b.type) {
		case "headline":
		case "about": {
			const headline = b.type === "headline";
			return {
				id: b.id,
				type: b.type,
				label: headline ? "Headline" : "About",
				desired: b.text,
				read: (m) => (headline ? m.headline : m.sections.About) || undefined,
				facets: [],
				// One contenteditable each; the headline's has no accessible name (probe 2026-09-11).
				editor: () => ({
					path: headline ? "edit/intro/" : "edit/forms/summary/new/",
					creating: false,
					heading: headline ? /intro/iu : /about/iu,
					identity: [],
					steps: [
						{
							kind: "text",
							control: { css: '[contenteditable="true"]' },
							value: b.text,
						},
					],
					notify: "if-present",
				}),
			};
		}
		case "position":
			return positionField(b);
		case "project":
			return projectField(b);
		case "skills":
			return {
				id: b.id,
				type: "skills",
				label: "Skills",
				// One name per line, sorted; drift compares them with planSkills.
				desired: sorted(skillList(b.text)),
				read: (m) => sorted(entities(m, "skills").map((s) => s.name)),
				facets: [],
			};
		default:
			return formField(b, FORMS[b.type] as FormSpec<EntityKind>);
	}
}
