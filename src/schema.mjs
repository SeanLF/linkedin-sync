// The one definition of LinkedIn's profile fields that read, write and drift
// detection all share. If these three disagree about where a field lives, the
// drift check silently passes while the profile is wrong; which is the exact
// failure that let LinkedIn sit nine months behind the site.
//
// Why .mjs and not .json: `read` has to reach into the export by *matching*
// (the independent role by its company, a project by its title), not by index.
// Index selectors break the first time LinkedIn reorders a section, and they
// break silently, returning a neighbour's text instead of nothing. A tiny path
// DSL would buy inspectability and cost correctness, so: functions.
//
// `read` contract: return the live string, or `undefined` if the field is not
// present. Throw if the *shape* is wrong (section missing entirely). The
// difference matters; see VERDICTS in linkedin-drift.mjs.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find an experience entry (or a sub-role of one) whose company or title matches.
 *
 * With `role`, match the company only (a grouped entry's company is its title,
 * a single entry's is its subtitle) and then the role title exactly. Without
 * it, "Hivebrite" hits every role under Hivebrite and "Senior Software
 * Engineer" hits that title at every company, and either throws below.
 */
export function experienceByCompany(profile, rx, role) {
	const xp = profile?.sections?.Experience;
	if (!Array.isArray(xp))
		throw new Error("sections.Experience missing or not a list");
	const hits = [];
	for (const e of xp) {
		const grouped = e.roles?.length > 0;
		const roles = grouped ? e.roles : [e];
		for (const r of roles) {
			if (role) {
				const company = grouped ? e.title : e.subtitle;
				if (
					rx.test(company ?? "") &&
					(r.title ?? "").toLowerCase() === role.toLowerCase()
				)
					hits.push(r);
			} else if (
				rx.test(e.subtitle ?? "") ||
				rx.test(e.title ?? "") ||
				rx.test(r.title ?? "")
			)
				hits.push(r);
		}
	}
	if (hits.length > 1)
		throw new Error(
			`match ${rx}${role ? ` role="${role}"` : ""} hits ${hits.length} experience entries; make the match= attribute more specific${role ? "" : ', or add role="Exact role title"'}`,
		);
	if (hits.length === 0 && role && Array.isArray(profile?.entities?.positions))
		return byTypedCompany(xp, profile.entities.positions, rx, role);
	return hits[0];
}

// The page groups roles under the linked company page's name; the edit
// control and the API carry the name typed on the role. A role typed
// "University" can render under the linked page's "Université Exemple"
// (seen 2026-10-29), so a match that the writer can use finds nothing on the
// page. When the API has
// exactly one role with this title at a company the match fits, and the page
// has exactly one role with that title anywhere, they are the same role.
// Anything less certain stays absent rather than guessed.
function byTypedCompany(xp, positions, rx, role) {
	const typed = positions.filter(
		(p) =>
			rx.test(p.company ?? "") &&
			(p.title ?? "").toLowerCase() === role.toLowerCase(),
	);
	if (typed.length !== 1) return undefined;
	const rendered = xp
		.flatMap((e) => (e.roles?.length > 0 ? e.roles : [e]))
		.filter((r) => (r.title ?? "").toLowerCase() === role.toLowerCase());
	return rendered.length === 1 ? rendered[0] : undefined;
}

// --- Dates ------------------------------------------------------------------
// The record writes dates the way LinkedIn renders them ("Apr 2021", "2016",
// "Apr 1, 2021", ranges "Mar 2026 - Present"); internally they are ISO at the
// precision given ("2021-04", "2016", "2021-04-01"). A date that does not parse
// throws: the old reader returned null and the field quietly lost its dates,
// and "Mar 2016 - garbage" read as "Mar 2016 - Present".

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
export const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
// A month is its three-letter abbreviation or its full name, nothing between:
// matching on the first three letters read "Junk 2015" as June.
const monthIndex = (name) => {
	const n = name.toLowerCase();
	return MONTH_NAMES.findIndex(
		(full, i) => n === full.toLowerCase() || n === MONTHS[i].toLowerCase(),
	);
};
const pad = (n) => String(n).padStart(2, "0");
const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** "Apr 2021" -> "2021-04", "2016" -> "2016", "Apr 1, 2021" -> "2021-04-01"; null if unparseable. */
export function parseDate(text) {
	const t = (text ?? "").trim();
	let m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(t);
	if (m) {
		const mi = monthIndex(m[1]);
		const day = Number(m[2]);
		if (mi < 0 || day < 1 || day > daysIn(Number(m[3]), mi + 1)) return null;
		return `${m[3]}-${pad(mi + 1)}-${pad(day)}`;
	}
	m = /^([A-Za-z]{3,})\.?\s+(\d{4})$/.exec(t);
	if (m) {
		const mi = monthIndex(m[1]);
		return mi < 0 ? null : `${m[2]}-${pad(mi + 1)}`;
	}
	if (/^\d{4}$/.test(t)) return t;
	return null;
}

/** ISO at any precision back to LinkedIn's rendering. */
export function dateLabel(iso) {
	const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(iso ?? "");
	if (!m) throw new Error(`not an ISO date: ${JSON.stringify(iso)}`);
	if (!m[2]) return m[1];
	const mon = MONTHS[Number(m[2]) - 1];
	return m[3] ? `${mon} ${Number(m[3])}, ${m[1]}` : `${mon} ${m[1]}`;
}

/**
 * Parse "Mar 2026 - Present", "2010 - 2014" or a lone "Mar 2018" into
 * {start, end}: end null is Present, end undefined is no end at all (a
 * certification that does not expire). Throws on anything else.
 */
export function parseRange(raw) {
	const [a, b, ...rest] = String(raw).split(/\s+[-–]\s+|\s*–\s*/);
	const start = parseDate(a);
	if (!start || rest.length)
		throw new Error(`cannot read dates ${JSON.stringify(raw)}`);
	if (b === undefined) return { start, end: undefined };
	if (/^present$/i.test(b.trim())) return { start, end: null };
	const end = parseDate(b);
	if (!end) throw new Error(`cannot read dates ${JSON.stringify(raw)}`);
	return { start, end };
}

export function datesLabel({ start, end }) {
	if (end === undefined) return dateLabel(start);
	return `${dateLabel(start)} - ${end === null ? "Present" : dateLabel(end)}`;
}

// A rendered range carries a duration: "Jan 2025 - Nov 2025 · 11 mos".
// Canonicalised through the parser so "April 2021" and "Apr 2021" agree; a
// string that does not parse is returned as is, so drift shows it.
function renderedRange(s) {
	const head = (s ?? "").split(" · ")[0].trim();
	if (!head) return NONE;
	try {
		return datesLabel(parseRange(head));
	} catch {
		return head;
	}
}

// --- Shared helpers ------------------------------------------------------------

// How old the mirror may be before a verdict drawn from it proves nothing.
// Drift refuses past it; the writers refuse to create an entry past it,
// because "not in the mirror" is how a duplicate gets made.
export const MIRROR_MAX_AGE_DAYS = 14;
/** The mirror's age in days, or null when it carries no readable exportedAt. */
export function mirrorAgeDays(profile) {
	const t = Date.parse(profile?.exportedAt ?? "");
	if (Number.isNaN(t)) return null;
	return (Date.now() - t) / 86_400_000;
}

// What an attribute set to "" compares as: the record says "this must be
// empty" (clear a credential ID), which is different from leaving the
// attribute out (this tool does not manage that value).
export const NONE = "(none)";
const orNone = (v) => (v === undefined || v === null || v === "" ? NONE : v);

/** One structured collection from the mirror, or throw: a missing one is unreadable, not empty. */
function entityList(profile, kind) {
	const list = profile?.entities?.[kind];
	if (!Array.isArray(list))
		throw new Error(
			`entities.${kind} missing from the mirror (exported before structured reads, or the fetch failed; see its warnings). Re-export.`,
		);
	return list;
}
function onlyOne(hits, what) {
	if (hits.length > 1)
		throw new Error(
			`${what} hits ${hits.length} entries; make the block's attributes more specific`,
		);
	return hits[0];
}
const lc = (s) => (s ?? "").toLowerCase();

/** Locate a project by its exact LinkedIn title. */
function projectByTitle(profile, title) {
	const projects = profile?.sections?.Projects;
	if (!Array.isArray(projects))
		throw new Error("sections.Projects missing or not a list");
	return projects.find((p) => p?.title === title);
}

// LinkedIn's per-field character limits for the block text, keyed by field
// TYPE (the part of a block id before the first "."). Seen as counters in the
// edit dialogs on 2026-10-29 unless noted; exceeding one is refused before a
// browser opens. null means the block is not free text (skills is a list).
export const TYPE_LIMITS = {
	headline: 220,
	about: 2600,
	position: 2000,
	project: 2000,
	education: 1000, // "Description, maximum 1,000 characters"
	honor: 2000, // LinkedIn's published limit; the dialog shows no counter
	publication: 2000,
	volunteer: 2000,
	certification: 0, // the editor has no description: the block stays empty
	skills: null,
};
export const typeOf = (id) => id.split(".")[0];
export const isKnownType = (type) => Object.hasOwn(TYPE_LIMITS, type);

// Attribute limits, from the dialogs' counters and maxlength (2026-10-29).
const ATTR_LIMITS = {
	project: { title: 255 },
	education: { grade: 80, activities: 500 },
	honor: { title: 255, issuer: 255 },
	publication: { title: 255, publisher: 255 },
	certification: { credential: 80 },
	skills: {},
};
// LinkedIn caps a profile at 100 skills, 80 characters each.
const MAX_SKILLS = 100;
const SKILL_LIMIT = 80;

/** Attribute and list problems for one block, as human-readable strings. */
export function attrProblems(id, attrs = {}, text = "") {
	const type = typeOf(id);
	const problems = [];
	for (const [k, limit] of Object.entries(ATTR_LIMITS[type] ?? {})) {
		const n = [...(attrs[k] ?? "")].length;
		if (n > limit) problems.push(`${id}: ${k}= is ${n} chars, limit ${limit}`);
	}
	if (type === "skills") {
		const list = skillList(text);
		if (list.length > MAX_SKILLS)
			problems.push(`${id}: ${list.length} skills, limit ${MAX_SKILLS}`);
		for (const s of list)
			if ([...s].length > SKILL_LIMIT)
				problems.push(`${id}: skill "${s}" is over ${SKILL_LIMIT} chars`);
	}
	return problems;
}

/** A skills block: one skill per line; blank lines and "- " bullets ignored. */
export function skillList(text) {
	return (text ?? "")
		.split("\n")
		.map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
		.filter(Boolean);
}

// A block is compared against the live profile unless it opts out: an id ending
// in ".alt" (a human-choice alternate) or an explicit compare="false" attr.
export const isCompared = (id, attrs = {}) =>
	attrs.compare !== "false" && !id.endsWith(".alt");

// --- Form steps ------------------------------------------------------------------
// The writer for the newer types fills a dialog from a list of steps, built
// here and run by inpage.fillForm. Labels are anchored regexes because
// getByLabel's plain-string match is a case-insensitive substring: "Role"
// also hits "I am currently volunteering in this role".

const text = (pattern, value) => ({ kind: "text", pattern, value });
const select = (pattern, option, nth = 0) => ({
	kind: "select",
	pattern,
	option,
	nth,
});
const check = (pattern, value) => ({ kind: "checkbox", pattern, value });
/** The Month/Year select pair at position nth; a year-only date leaves Month blank. */
function datePair(iso, nth) {
	const [y, m] = iso ? iso.split("-") : [];
	return [
		select("^Month$", m ? MONTH_NAMES[Number(m) - 1] : "", nth),
		select("^Year$", y ?? "", nth),
	];
}
const editorPath = (section) => (id) => `details/${section}/edit/forms/${id}/`;

// "SCIENCE_AND_TECHNOLOGY" -> "Science and Technology", the option label.
const causeLabel = (enumValue) =>
	(enumValue ?? "")
		.toLowerCase()
		.split("_")
		.map((w, i) =>
			i > 0 && w === "and" ? w : w[0]?.toUpperCase() + w.slice(1),
		)
		.join(" ");
const causeKey = (s) =>
	lc(s)
		.replace(/[^a-z]+/g, " ")
		.trim();

// Build a concrete field definition from a block's id and its fence attributes.
// The id's type picks the reader/writer; the attributes supply the per-instance
// specifics (which company, which project title, its dates). This is the seam
// that makes the machinery generic and the content the user's own.
//
// `read` contract: return the live string, or undefined if the field is absent.
// Throw if the section shape is wrong; drift turns that into UNREADABLE, a
// distinct outcome from "different".
//
// `facets` are the other values a block carries as attributes (a date range, a
// grade, a credential ID): each is compared on its own line in drift, as
// `<id>.<facet>`, against `desired`. A facet exists only when its attribute is
// present, so leaving one out means "not managed here".
//
// `opts.linkStatus`: url -> HTTP status, from `drift --check-links`.
export function fieldFromBlock(id, attrs = {}, opts = {}) {
	const type = typeOf(id);
	for (const p of attrProblems(id, attrs, opts.text ?? "")) throw new Error(p);
	if (type === "headline")
		return {
			id,
			label: "Headline",
			limit: 220,
			read: (p) => p?.headline ?? undefined,
			write: { surface: "intro", control: "headline", multiline: false },
		};
	if (type === "about")
		return {
			id,
			label: "About",
			limit: 2600,
			read: (p) => p?.sections?.About ?? undefined,
			write: { surface: "about", control: "summary", multiline: true },
		};
	if (type === "position") return positionField(id, attrs);
	if (type === "project") return projectField(id, attrs, opts);
	if (FORM_TYPES[type]) return formField(id, type, attrs, opts.text ?? "");
	if (type === "skills") return skillsField(id);
	throw new Error(
		`unknown field type "${type}" in block "${id}" (known: ${Object.keys(TYPE_LIMITS).join(", ")})`,
	);
}

/** A facet: one more compared value behind the same block. */
const facet = (id, name, read, desired) => ({
	id: `${id}.${name}`,
	read,
	desired,
});

function positionField(id, attrs) {
	const match = attrs.match;
	if (!match)
		throw new Error(`block "${id}" needs a match="Company name" attribute`);
	const rx = new RegExp(escapeRe(match), "i");
	const role = attrs.role;
	const f = {
		id,
		label: `Position (${role ? `${role} at ` : ""}${match})`,
		limit: 2000,
		read: (p) => experienceByCompany(p, rx, role)?.description ?? undefined,
		write: {
			surface: "position",
			match: { subtitle: rx },
			company: match,
			role,
			control: "description",
			multiline: true,
		},
		facets: [],
	};
	// The role's id in the structured export, for the editor's deep link; only
	// when exactly one role fits, else the writer finds it on the list.
	f.positionId = (p) => {
		const rows = (p?.entities?.positions ?? []).filter(
			(e) => rx.test(e.company ?? "") && (!role || lc(e.title) === lc(role)),
		);
		return rows.length === 1 ? rows[0].id : undefined;
	};
	if (attrs.skills) {
		f.skills = attrs.skills.split(/\s*[,;|]\s*/).filter(Boolean);
		f.readSkills = (p) => experienceByCompany(p, rx, role)?.skills ?? [];
	}
	if (attrs.dates !== undefined) {
		const d = parseRange(attrs.dates);
		if (
			d.end === undefined ||
			!/-/.test(d.start) ||
			(d.end && !/-/.test(d.end))
		)
			throw new Error(
				`block "${id}": a position's dates are "Mon YYYY - Mon YYYY" or "Mon YYYY - Present", got ${JSON.stringify(attrs.dates)}`,
			);
		f.dates = d;
		// Read as rendered. The page is what people see; for projects the API's
		// dateRange disagrees with it (see projectField), so ranges are compared
		// as LinkedIn draws them.
		f.facets.push(
			facet(
				id,
				"dates",
				(p) => {
					const r = experienceByCompany(p, rx, role);
					return r ? renderedRange(r.dates) : undefined;
				},
				datesLabel(d),
			),
		);
		// Probe 2026-10-29 of the role editor: labelled Start/End selects (not the
		// project dialog's bare Month/Year) and a "currently working" checkbox.
		f.write.dateLabels = {
			startMonth: "^Start month$",
			startYear: "^Start year",
			endMonth: "^End month$",
			endYear: "^End year",
			current: "^I am currently working in this role$",
		};
	}
	if (attrs.company !== undefined) {
		// The company as typed on the role (structured), e.g. "University" ->
		// "Example University". The editor's field is a typeahead; the writer
		// types the name and does not pick a suggestion, so LinkedIn may or may
		// not link it to a company page.
		const read = (p) => {
			const rows = entityList(p, "positions").filter(
				(e) => rx.test(e.company ?? "") && (!role || lc(e.title) === lc(role)),
			);
			const e = onlyOne(rows, `match ${rx}${role ? ` role="${role}"` : ""}`);
			return e ? orNone(e.company) : undefined;
		};
		f.facets.push(facet(id, "company", read, orNone(attrs.company)));
		f.write.companyTo = attrs.company;
	}
	return f;
}

function projectField(id, attrs, opts) {
	const title = attrs.title;
	if (!title)
		throw new Error(
			`block "${id}" needs a title="Exact LinkedIn project title" attribute`,
		);
	const f = {
		id,
		label: `Project: ${title}`,
		linkedinTitle: title,
		limit: 2000,
		read: (p) => projectByTitle(p, title)?.description ?? undefined,
		write: {
			surface: "project",
			control: "description",
			multiline: true,
			createIfAbsent: true,
		},
		facets: [],
	};
	if (attrs.dates !== undefined) {
		const d = parseRange(attrs.dates);
		if (
			d.end === undefined ||
			!/-/.test(d.start) ||
			(d.end && !/-/.test(d.end))
		)
			throw new Error(
				`block "${id}": a project's dates are "Mon YYYY - Mon YYYY" or "Mon YYYY - Present", got ${JSON.stringify(attrs.dates)}`,
			);
		f.dates = d;
		// The rendered subtitle, not entities.projects[].dates: three projects
		// LinkedIn shows as "... - Present" carry end == start in the API
		// (2026-10-29), so the API would report drift that is not there.
		f.readDates = (p) => {
			const r = projectByTitle(p, title);
			return r ? renderedRange(r.subtitle) : undefined;
		};
		f.facets.push(facet(id, "dates", f.readDates, datesLabel(d)));
	}
	// What a reader can click: the external links among the project's media,
	// plus the legacy "Project URL" field (shown only on projects that have one).
	const links = (p) => {
		const r = projectByTitle(p, title);
		if (!r) return undefined;
		const e = entityList(p, "projects").find((x) => x.title === title);
		const urls = (r.media ?? []).map((m) => m.url).filter(Boolean);
		if (e?.url) urls.push(e.url);
		return { r, urls };
	};
	if (attrs.link !== undefined) {
		f.link = attrs.link;
		f.facets.push(
			facet(
				id,
				"link",
				(p) => {
					const l = links(p);
					if (!l) return undefined;
					if (l.urls.includes(attrs.link)) return attrs.link;
					const hidden = (l.r.media ?? []).filter(
						(m) => m.kind === "LINK" && !m.url,
					).length;
					const seen = l.urls.length ? l.urls.join(" | ") : NONE;
					return hidden
						? `${seen} (+${hidden} link LinkedIn does not expose)`
						: seen;
				},
				attrs.link,
			),
		);
	}
	// Media health, reported for any compared project that has media or a URL:
	// a link LinkedIn could not unfurl (no thumbnail, viewer-only target, probe
	// 2026-10-29: its viewer page reads "This page doesn't exist"), and, with
	// --check-links, a URL that no longer resolves.
	f.facets.push({
		...facet(
			id,
			"media",
			(p) => {
				const l = links(p);
				if (!l) return undefined;
				// Nothing attached: no line at all (an optional facet that reads
				// undefined is dropped, not reported absent).
				if (!l.urls.length && !(l.r.media ?? []).length) return undefined;
				const problems = [];
				for (const m of l.r.media ?? [])
					if (m.kind === "LINK" && !m.url && !m.thumbnail)
						problems.push(
							`"${m.title}": link with no preview and no visible target`,
						);
				for (const u of l.urls) {
					const s = opts.linkStatus?.get(u);
					if (s !== undefined && !(s >= 200 && s < 400))
						problems.push(`${u}: ${typeof s === "number" ? `HTTP ${s}` : s}`);
				}
				return problems.length ? problems.join("; ") : OK_MEDIA;
			},
			OK_MEDIA,
		),
		optional: true,
	});
	f.urls = (p) => links(p)?.urls ?? [];
	return f;
}
const OK_MEDIA = "no stale media";
export const PRESENT = "(present)";

// The section types edited through one generic dialog writer. Each says how
// to find its live entry, which attributes it carries and how they read, and
// how to fill its editor. Dialog shapes are from read-only probes of each
// editor on 2026-10-29; the create forms ("new") reuse the edit labels and
// are only proven by dry run.
const FORM_TYPES = {
	education: {
		section: "education",
		heading: "education",
		deleteButton: "Delete education",
		newPath: "details/education/edit/forms/new/",
		identity: "match",
		locate: (p, a) => {
			const rx = new RegExp(escapeRe(a.match), "i");
			return onlyOne(
				entityList(p, "educations").filter((e) =>
					rx.test([e.school, e.degree, e.field].filter(Boolean).join(" · ")),
				),
				`match="${a.match}"`,
			);
		},
		expect: (e) => [{ pattern: "^School\\*?$", value: e.school }],
		facets: {
			school: { read: (e) => e.school, step: (v) => text("^School\\*?$", v) },
			degree: { read: (e) => e.degree, step: (v) => text("^Degree$", v) },
			field: {
				read: (e) => e.field,
				step: (v) => text("^Field of study$", v),
			},
			dates: {
				parse: (v) => {
					const d = parseRange(v);
					if (d.end === null)
						throw new Error(
							"an education has an end date (or expected), not Present",
						);
					return d;
				},
				read: (e) =>
					e.dates?.start
						? datesLabel({
								start: e.dates.start,
								end: e.dates.end ?? undefined,
							})
						: undefined,
				label: (d) => datesLabel(d),
				steps: (d) => [...datePair(d?.start, 0), ...datePair(d?.end, 1)],
			},
			grade: { read: (e) => e.grade, step: (v) => text("^Grade", v) },
			activities: {
				read: (e) => e.activities,
				step: (v) => text("^Activities and societies", v),
			},
		},
		description: "^Description",
		required: ["school"],
	},
	honor: {
		section: "honors",
		heading: "honors",
		deleteButton: "Delete honors & awards",
		newPath: "details/honors/edit/forms/new/",
		identity: "title",
		locate: (p, a) =>
			onlyOne(
				entityList(p, "honors").filter((e) => e.title === a.title),
				`title="${a.title}"`,
			),
		expect: (e) => [{ pattern: "^Title\\*?$", value: e.title }],
		create: (a) => [text("^Title\\*?$", a.title)],
		facets: {
			issuer: { read: (e) => e.issuer, step: (v) => text("^Issuer$", v) },
			date: {
				parse: (v) => {
					const d = parseDate(v);
					// The editor has Month and Year selects; Month may stay blank.
					if (!d || d.length > 7)
						throw new Error(
							`an honour's date is "Mon YYYY" or "YYYY", got ${JSON.stringify(v)}`,
						);
					return d;
				},
				read: (e) => (e.date ? dateLabel(e.date.slice(0, 7)) : undefined),
				label: (d) => dateLabel(d),
				steps: (d) => datePair(d, 0), // null blanks both selects
			},
			// The "Associated with" option, e.g. "Software Engineer at Acme
			// Corp". Live, the API gives the linked entry; it is rendered the way
			// the select labels it. Where LinkedIn labels a role by its linked
			// company page rather than the typed name, these can disagree.
			associated: {
				read: (e, p) => associationLabels(p, e.associated),
				step: (v) => select("^Associated with$", v),
			},
		},
		description: "^Description$",
	},
	publication: {
		section: "publications",
		heading: "publication",
		deleteButton: "Delete publication",
		newPath: "edit/forms/publication/new/",
		identity: "title",
		locate: (p, a) =>
			onlyOne(
				entityList(p, "publications").filter((e) => e.title === a.title),
				`title="${a.title}"`,
			),
		expect: (e) => [{ pattern: "^Title\\*?$", value: e.title }],
		create: (a) => [text("^Title\\*?$", a.title)],
		facets: {
			publisher: {
				read: (e) => e.publisher,
				step: (v) => text("^Publication/Publisher$", v),
			},
			// The editor's date is one mm/dd/yyyy text box. It showed the last day
			// of the month before for a date the API holds as the 1st (2026-10-29),
			// so saving the form untouched would move it a day back. The writer therefore always types
			// a date: the record's, or the stored one. Compared at the precision
			// the record gives: "Sep 2021" matches a stored 2021-09-01.
			// A stored year-only date has no day for the box to shift, so it is
			// left alone rather than retyped (usDate needs a month).
			date: {
				parse: (v) => {
					const d = parseDate(v);
					if (!d || d.length < 7)
						throw new Error(
							`a publication date is "Mon YYYY" or "Mon D, YYYY" (the editor's box takes a full date), got ${JSON.stringify(v)}`,
						);
					return d;
				},
				read: (e, _p, want) =>
					e.date ? dateLabel(e.date.slice(0, want?.length ?? 10)) : undefined,
				label: (d) => dateLabel(d),
				steps: (d) => [text("^Publication date$", d ? usDate(d) : "")],
				always: (e) => (e.date?.length >= 7 ? e.date : undefined),
			},
			url: { read: (e) => e.url, step: (v) => text("^Publication URL$", v) },
		},
		description: "^Description$",
	},
	volunteer: {
		section: "volunteer-experiences",
		heading: "volunteer",
		deleteButton: "Delete volunteer experience",
		newPath: "details/volunteer-experiences/edit/forms/new/",
		identity: "match",
		locate: (p, a) => {
			const rx = new RegExp(escapeRe(a.match), "i");
			return onlyOne(
				entityList(p, "volunteering").filter(
					(e) =>
						rx.test(e.organization ?? "") && (!a.role || e.role === a.role),
				),
				`match="${a.match}"${a.role ? ` role="${a.role}"` : ""}`,
			);
		},
		expect: (e) => [
			{ pattern: "^Organization\\*?$", value: e.organization },
			{ pattern: "^Role\\*?$", value: e.role },
		],
		create: (a) => [
			text("^Organization\\*?$", a.match),
			text("^Role\\*?$", a.role ?? ""),
		],
		facets: {
			cause: {
				read: (e) => (e.cause ? causeLabel(e.cause) : undefined),
				canon: causeKey,
				step: (v) => select("^Cause$", v),
			},
			// Rendered, like a position's: the volunteer editor has the same
			// "currently" checkbox, so the same Present question applies.
			dates: {
				parse: (v) => {
					const d = parseRange(v);
					if (d.end === undefined)
						throw new Error(
							`volunteer dates are a range, got ${JSON.stringify(v)}`,
						);
					return d;
				},
				read: (e, p) => {
					const rows = p?.sections?.Volunteering;
					if (!Array.isArray(rows))
						throw new Error("sections.Volunteering missing or not a list");
					const r = onlyOne(
						rows.filter(
							(x) => x.title === e.role && x.subtitle === e.organization,
						),
						`rendered volunteering "${e.role}" at ${e.organization}`,
					);
					if (!r)
						throw new Error(
							`"${e.role}" at ${e.organization} is in the API but not on the rendered page`,
						);
					return renderedRange(r.dates);
				},
				label: (d) => datesLabel(d),
				steps: (d) => {
					if (!d)
						throw new Error(
							'a volunteer role needs a start date; dates="" cannot clear it',
						);
					return [
						check("^I am currently volunteering in this role$", d.end === null),
						...datePair(d.start, 0),
						...(d.end ? datePair(d.end, 1) : []),
					];
				},
			},
		},
		description: "^Description",
		required: ["role"],
	},
	certification: {
		section: "certifications",
		heading: "license or certification",
		deleteButton: "Delete license or certification",
		newPath: "details/certifications/edit/forms/new/",
		identity: "name",
		locate: (p, a) =>
			onlyOne(
				entityList(p, "certifications").filter((e) => e.name === a.name),
				`name="${a.name}"`,
			),
		expect: (e) => [{ pattern: "^Name\\*?$", value: e.name }],
		create: (a) => [text("^Name\\*?$", a.name)],
		facets: {
			issuer: {
				read: (e) => e.issuer,
				step: (v) => text("^Issuing organization", v),
			},
			// "Mar 2018" (no expiry) or "Mar 2018 - Mar 2021" (issued - expires).
			dates: {
				parse: (v) => {
					const d = parseRange(v);
					if (d.end === null)
						throw new Error("a certification expires on a date, not Present");
					return d;
				},
				read: (e) =>
					e.dates?.start
						? datesLabel({
								start: e.dates.start,
								end: e.dates.end ?? undefined,
							})
						: undefined,
				label: (d) => datesLabel(d),
				steps: (d) => [...datePair(d?.start, 0), ...datePair(d?.end, 1)],
			},
			credential: {
				read: (e) => e.credentialId,
				step: (v) => text("^Credential ID$", v),
			},
			url: { read: (e) => e.url, step: (v) => text("^Credential URL$", v) },
		},
		description: null,
	},
};

/** The attribute that identifies an entry of a form type, or undefined for any other type. */
export const identityAttr = (type) => FORM_TYPES[type]?.identity;

/** "2020-06-01" or "2020-06" -> "6/1/2020", what the publication date box takes. */
function usDate(iso) {
	const [y, m, d] = iso.split("-");
	if (!m) throw new Error(`a publication date needs a month: ${iso}`);
	return `${Number(m)}/${Number(d ?? 1)}/${y}`;
}

// The labels the "Associated with" select could show for a linked entry.
function associationLabels(p, assoc) {
	if (!assoc) return [];
	if (assoc.position) {
		const e = entityList(p, "positions").find((x) => x.id === assoc.position);
		return e ? [`${e.title} at ${e.company}`, e.title] : [];
	}
	if (assoc.education) {
		const e = entityList(p, "educations").find((x) => x.id === assoc.education);
		return e
			? [
					`Student at ${[e.school, e.degree, e.field].filter(Boolean).join(", ")}`,
					e.school,
				]
			: [];
	}
	return [];
}

function formField(id, type, attrs, blockText) {
	const spec = FORM_TYPES[type];
	const key = attrs[spec.identity];
	if (!key)
		throw new Error(
			`block "${id}" needs a ${spec.identity}="..." attribute to find its entry`,
		);
	const locate = (p) => spec.locate(p, attrs);
	const describes = Boolean(spec.description) && blockText.trim() !== "";
	const facets = [];
	const values = {};
	for (const [name, fs] of Object.entries(spec.facets)) {
		if (attrs[name] === undefined) continue;
		const raw = attrs[name];
		const parsed = raw === "" ? null : fs.parse ? fs.parse(raw) : raw;
		values[name] = parsed;
		const want =
			parsed === null ? NONE : fs.label ? fs.label(parsed) : String(parsed);
		const canon = fs.canon ?? ((s) => s);
		facets.push(
			facet(
				id,
				name,
				(p) => {
					const e = locate(p);
					if (!e) return undefined;
					let live = fs.read(e, p, parsed ?? undefined);
					// A list of acceptable renderings (an association): agree if any does.
					if (Array.isArray(live))
						live = live.find((l) => canon(l) === canon(want)) ?? live[0];
					live = orNone(live);
					return canon(live) === canon(want) ? want : live;
				},
				want,
			),
		);
	}
	return {
		id,
		type,
		label: `${type[0].toUpperCase()}${type.slice(1)}: ${key}`,
		limit: TYPE_LIMITS[type],
		// With description text in the block, that text is the main value. With
		// none (or on a type that has no description), the entry's presence is:
		// an empty block must not read as "both empty" when the entry is missing.
		read: (p) => {
			const e = locate(p);
			if (!e) return undefined;
			return describes ? (e.description ?? "") : PRESENT;
		},
		canonDesired: describes ? undefined : () => PRESENT,
		exists: (p) => locate(p) !== undefined,
		facets,
		form: {
			type,
			heading: spec.heading,
			deleteButton: spec.deleteButton,
			newPath: spec.newPath,
			editorPath: editorPath(spec.section),
			locate,
			expect: spec.expect,
			// Steps to bring the open editor to the record. Identity attributes are
			// typed only when creating; editing checks them instead (expect).
			steps: ({ creating, entry, description }) => {
				const steps = creating && spec.create ? spec.create(attrs) : [];
				if (creating)
					for (const r of spec.required ?? [])
						if (attrs[r] === undefined && r !== spec.identity)
							throw new Error(
								`${id} is not on LinkedIn yet and creating it needs ${r}="..."`,
							);
				for (const [name, fs] of Object.entries(spec.facets)) {
					let v = values[name];
					if (v === undefined && fs.always && entry) {
						const stored = fs.always(entry);
						if (stored) v = stored;
					}
					if (v === undefined) continue;
					// null: the record set the attribute to "", so clear the control.
					if (fs.steps) steps.push(...fs.steps(v));
					else steps.push(fs.step(v ?? ""));
				}
				if (spec.description && description)
					steps.push({
						kind: "text",
						pattern: spec.description,
						value: description,
						multiline: true,
					});
				return steps;
			},
		},
	};
}

// One block lists every skill the profile should carry. Drift compares the
// sets; the writer adds what is missing and deletes what is extra. LinkedIn
// has no rename: a rename is a delete plus an add, and loses that skill's
// endorsements.
function skillsField(id) {
	const sorted = (xs) => [...xs].sort((a, b) => a.localeCompare(b, "en"));
	return {
		id,
		label: "Skills",
		limit: null,
		read: (p) => sorted(entityList(p, "skills").map((s) => s.name)).join("\n"),
		canonDesired: (t) => sorted(skillList(t)).join("\n"),
		diff: (live, desired) =>
			planSkills(live.split("\n").filter(Boolean), skillList(desired)),
		liveSkills: (p) => entityList(p, "skills"),
		skillList,
	};
}

/**
 * What it takes to bring the live skill names to the record's, compared
 * without case: a skill is a LinkedIn entity whose name LinkedIn spells, so
 * "Javascript" in the record and "JavaScript" live are the same skill. Those
 * pairs are `recase` (fix the record), never an add plus a delete: the add
 * would pick the existing entity and the delete would then remove it.
 */
export function planSkills(liveNames, wantNames) {
	const liveBy = new Map(liveNames.map((n) => [lc(n), n]));
	const wantBy = new Map(wantNames.map((n) => [lc(n), n]));
	return {
		add: [...wantBy].filter(([k]) => !liveBy.has(k)).map(([, n]) => n),
		remove: [...liveBy].filter(([k]) => !wantBy.has(k)).map(([, n]) => n),
		recase: [...wantBy]
			.filter(([k, n]) => liveBy.has(k) && liveBy.get(k) !== n)
			.map(([k, n]) => ({ record: n, live: liveBy.get(k) })),
	};
}

// Build every comparable field from the parsed copy blocks (id -> {text, attrs}).
export function fieldsFromBlocks(blocks, opts = {}) {
	const fields = [];
	for (const [id, b] of blocks) {
		if (!isCompared(id, b.attrs)) continue;
		fields.push(fieldFromBlock(id, b.attrs || {}, { ...opts, text: b.text }));
	}
	return { fields, byId: new Map(fields.map((f) => [f.id, f])) };
}

/**
 * Make two strings comparable without hiding real drift.
 *
 * Deliberately NOT normalised: straight vs curly quotes, and letter case.
 * Those are differences you would want a red check for. Only transport-level
 * mangling is folded away here. Every rule below earns its place by being
 * something a paste into a browser textarea can change on its own.
 */
export function normalize(s) {
	if (typeof s !== "string") return s;
	return s
		.normalize("NFC") // é as one code point, not e + combining acute
		.replace(/\r\n?/g, "\n") // textarea round-trips can introduce CRLF
		.replace(/ /g, " ") // LinkedIn emits NBSP where you typed a space
		.replace(/[ \t]+$/gm, "") // trailing space on a line is invisible
		.replace(/\n{3,}/g, "\n\n") // the editor collapses runs of blank lines
		.trim();
}
