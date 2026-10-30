// Read the live profile into the mirror through LinkedIn's own API (the
// Voyager GraphQL and REST calls its pages make), every response checked by
// a schema. A section or collection that cannot be read in full is left out
// and its reason kept in `warnings`: a short read must never pass as
// complete, because a writer that sees an entry missing creates it again.
//
// Query ids are hashes of LinkedIn's GraphQL queries and rotate when it
// ships. To fix one: open the network tab on your profile, find the failing
// request, and copy its queryId here.

import { writeFileSync } from "node:fs";
import { z } from "zod";
import { type Session, StopError, type Voyager } from "./browser.ts";
import {
	ENTITIES,
	type EntityKind,
	type Item,
	Mirror,
	SECTION_SLUGS,
} from "./mirror.ts";

const QUERY = {
	profile: "voyagerIdentityDashProfiles.a1a483e719b20537a256b6853cdca711",
	cards: "voyagerIdentityDashProfileCards.ef04d8d8a644bb1271d8640b7fd373d3",
	cards2: "voyagerIdentityDashProfileCards.55af784c21dc8640b500ab5b45937064",
	section:
		"voyagerIdentityDashProfileComponents.c5d4db426a0f8247b8ab7bc1d660775a",
	sectionPage:
		"voyagerIdentityDashProfileComponents.1ad109a952e36585fdc2e7c2dedcc357",
} as const;

// --- Response shapes (only what is read; LinkedIn sends nulls freely) ---------

const n = <S extends z.ZodType>(schema: S) => schema.nullish();
const Text = z.object({ text: z.string() });
const TextVm = z.object({ text: Text });
const Included = z.array(
	z.looseObject({ $type: n(z.string()), entityUrn: n(z.string()) }),
);

const MediaC = z.object({
	titleV2: n(TextVm),
	title: n(Text),
	actionTarget: n(z.string()),
	thumbnail: n(
		z.object({ actionTarget: n(z.string()), entityImage: z.unknown() }),
	),
	description: n(TextVm),
});
const Components = z.object({
	textComponent: n(z.object({ text: Text })),
	mediaComponent: n(MediaC),
	get entityComponent() {
		return n(EntityC);
	},
	get fixedListComponent() {
		return n(
			z.object({
				components: z.array(z.object({ components: n(Components) })),
			}),
		);
	},
});
const EntityC = z.object({
	titleV2: n(TextVm),
	title: n(Text),
	subtitle: n(Text),
	caption: n(Text),
	metadata: n(Text),
	subComponents: n(
		z.object({ components: z.array(z.object({ components: n(Components) })) }),
	),
});
const Element = z.object({ components: n(Components) });
type Element = z.infer<typeof Element>;
const Plc = z.object({
	entityUrn: n(z.string()),
	decorationType: n(z.string()),
	components: n(
		z.object({
			elements: n(z.array(Element)),
			paging: n(z.object({ total: n(z.number()) })),
		}),
	),
});
type Plc = z.infer<typeof Plc>;
const isPlc = (i: { $type?: string | null | undefined }) =>
	i.$type?.includes("PagedListComponent") ?? false;

// --- Rendered sections -------------------------------------------------------

function parseMedia(mc: z.infer<typeof MediaC>) {
	// An external link carries its URL; an upload, or a link LinkedIn could not
	// preview, only a viewer URL, so url is null and kind comes from its type=.
	const target = mc.actionTarget ?? mc.thumbnail?.actionTarget ?? "";
	const viewer = target.includes("multiple-media-viewer");
	const description = mc.description?.text.text;
	return {
		title: mc.titleV2?.text.text ?? mc.title?.text ?? "",
		kind: viewer
			? (/[?&]type=([A-Z_]+)/u.exec(target)?.[1] ?? "UNKNOWN")
			: "LINK",
		url: viewer ? null : target || null,
		thumbnail: Boolean(mc.thumbnail?.entityImage),
		...(description ? { description } : {}),
	};
}

function parseEntity(ec: z.infer<typeof EntityC>): Item | undefined {
	const out: Item = {};
	const title = ec.titleV2?.text.text || ec.title?.text;
	if (title) out.title = title;
	if (ec.subtitle?.text) out.subtitle = ec.subtitle.text;
	if (ec.caption?.text) out.dates = ec.caption.text;
	if (ec.metadata?.text) out.location = ec.metadata.text;
	const descriptions: string[] = [];
	const skills: string[] = [];
	const roles: Item[] = [];
	const media: NonNullable<Item["media"]> = [];
	const collect = (c: z.infer<typeof Components> | null | undefined) => {
		const t = c?.textComponent?.text.text;
		if (t?.startsWith("Skills: ")) skills.push(...t.slice(8).split(" · "));
		else if (t) descriptions.push(t);
		const child = c?.entityComponent
			? parseEntity(c.entityComponent)
			: undefined;
		if (child) roles.push(child);
		if (c?.mediaComponent) media.push(parseMedia(c.mediaComponent));
	};
	for (const sub of ec.subComponents?.components ?? []) {
		collect(sub.components);
		for (const nested of sub.components?.fixedListComponent?.components ?? [])
			collect(nested.components);
	}
	if (descriptions.length)
		out.description = descriptions.join("\n").replace(/\n{3,}/gu, "\n\n");
	if (skills.length) out.skills = skills;
	if (roles.length) out.roles = roles;
	if (media.length) out.media = media;
	return Object.keys(out).length ? out : undefined;
}

const parseElements = (els: Element[]): Item[] =>
	els.flatMap((el): Item[] => {
		const c = el.components;
		if (c?.entityComponent) {
			const e = parseEntity(c.entityComponent);
			return e ? [e] : [];
		}
		const t = c?.textComponent?.text.text;
		return t ? [{ title: t }] : [];
	});

const SectionPage = z.object({
	data: z.object({
		data: z.object({
			identityDashProfileComponentsByPagedListComponent: z.object({
				elements: z.array(Element),
			}),
		}),
	}),
});

/** Every page of one rendered list, or throw. `seen` dedupes across lists (skills sit in several categories). */
async function pageList(
	api: Voyager,
	plc: Plc,
	seen = new Set<string>(),
): Promise<Item[]> {
	const first = plc.components?.elements ?? [];
	const total = plc.components?.paging?.total ?? first.length;
	const items: Item[] = [];
	const keep = (els: Element[]) => {
		for (const it of parseElements(els)) {
			const key = `${it.title}|${it.dates ?? ""}`;
			if (!seen.has(key)) {
				seen.add(key);
				items.push(it);
			}
		}
	};
	keep(first);
	let fetched = first.length;
	if (fetched < total && !plc.entityUrn)
		throw new Error(`read ${fetched} of ${total}; no list urn to page with`);
	const urn = encodeURIComponent(plc.entityUrn ?? "")
		.replaceAll("(", "%28")
		.replaceAll(")", "%29");
	while (fetched < total) {
		const page = await api(
			`/voyager/api/graphql?variables=(start:${fetched},count:20,paginationToken:null,pagedListComponent:${urn})&queryId=${QUERY.sectionPage}`,
			SectionPage,
		);
		const els =
			page.data.data.identityDashProfileComponentsByPagedListComponent.elements;
		if (!els.length)
			throw new Error(`read ${fetched} of ${total}; a page came back empty`);
		keep(els);
		fetched += els.length;
	}
	return items;
}

// --- Structured entities (the edit forms' own records) --------------------------

const DateParts = z.object({
	year: n(z.number()),
	month: n(z.number()),
	day: n(z.number()),
});
const isoDate = (d: z.infer<typeof DateParts> | null | undefined) =>
	d?.year
		? [d.year, d.month, d.day]
				.flatMap((x) => (x ? [String(x).padStart(2, "0")] : []))
				.join("-")
		: null;
const DateRange = z.object({ start: n(DateParts), end: n(DateParts) });
const isoRange = (r: z.infer<typeof DateRange> | null | undefined) =>
	r ? { start: isoDate(r.start), end: isoDate(r.end) } : undefined;
const Occupation = z.object({
	profilePosition: n(z.string()),
	profileEducation: n(z.string()),
});
// "urn:li:fsd_profileEducation:(ACoA...,123456789)" -> "123456789", the id an editor URL takes.
const entityId = (urn: string | null | undefined) =>
	/,([^,)]+)\)$/u.exec(urn ?? "")?.[1];
const occupation = (u: z.infer<typeof Occupation> | null | undefined) => {
	const position = entityId(u?.profilePosition);
	const education = entityId(u?.profileEducation);
	if (position) return { position };
	return education ? { education } : undefined;
};
const str = n(z.string());
/** One collection: its REST name, its record $type, the record's schema, and the mirror row it makes. */
type Raw = readonly [
	string,
	string,
	(record: unknown) => Record<string, unknown>,
];
const row = <S extends z.ZodType>(
	collection: string,
	type: string,
	schema: S,
	toRow: (e: z.infer<S>) => Record<string, unknown>,
): Raw => [collection, type, (record) => toRow(schema.parse(record))];
const RAW = {
	positions: row(
		"profilePositions",
		"Position",
		z.object({
			title: str,
			companyName: str,
			locationName: str,
			dateRange: n(DateRange),
			description: str,
		}),
		(e) => ({
			title: e.title,
			company: e.companyName,
			location: e.locationName,
			dates: isoRange(e.dateRange),
			description: e.description,
		}),
	),
	educations: row(
		"profileEducations",
		"Education",
		z.object({
			schoolName: str,
			degreeName: str,
			fieldOfStudy: str,
			grade: str,
			activities: str,
			dateRange: n(DateRange),
			description: str,
		}),
		(e) => ({
			school: e.schoolName,
			degree: e.degreeName,
			field: e.fieldOfStudy,
			grade: e.grade,
			activities: e.activities,
			dates: isoRange(e.dateRange),
			description: e.description,
		}),
	),
	certifications: row(
		"profileCertifications",
		"Certification",
		z.object({
			name: str,
			authority: str,
			dateRange: n(DateRange),
			licenseNumber: str,
			url: str,
		}),
		(e) => ({
			name: e.name,
			issuer: e.authority,
			dates: isoRange(e.dateRange),
			credentialId: e.licenseNumber,
			url: e.url,
		}),
	),
	honors: row(
		"profileHonors",
		"Honor",
		z.object({
			title: str,
			issuer: str,
			issuedOn: n(DateParts),
			occupationUnion: n(Occupation),
			description: str,
		}),
		(e) => ({
			title: e.title,
			issuer: e.issuer,
			date: isoDate(e.issuedOn),
			associated: occupation(e.occupationUnion),
			description: e.description,
		}),
	),
	publications: row(
		"profilePublications",
		"Publication",
		z.object({
			name: str,
			publisher: str,
			publishedOn: n(DateParts),
			url: str,
			description: str,
		}),
		(e) => ({
			title: e.name,
			publisher: e.publisher,
			date: isoDate(e.publishedOn),
			url: e.url,
			description: e.description,
		}),
	),
	volunteering: row(
		"profileVolunteerExperiences",
		"VolunteerExperience",
		z.object({
			companyName: str,
			role: str,
			cause: str,
			dateRange: n(DateRange),
			description: str,
		}),
		(e) => ({
			organization: e.companyName,
			role: e.role,
			cause: e.cause,
			dates: isoRange(e.dateRange),
			description: e.description,
		}),
	),
	projects: row(
		"profileProjects",
		"Project",
		z.object({
			title: str,
			url: str,
			dateRange: n(DateRange),
			occupationUnion: n(Occupation),
			description: str,
		}),
		(e) => ({
			title: e.title,
			url: e.url,
			dates: isoRange(e.dateRange),
			associated: occupation(e.occupationUnion),
			description: e.description,
		}),
	),
	skills: row(
		"profileSkills",
		"Skill",
		z.object({ name: z.string() }),
		(e) => ({ name: e.name }),
	),
} satisfies Record<EntityKind, Raw>;

const Collection = z.object({
	data: z.object({
		"*elements": z.array(z.string()),
		paging: n(z.object({ total: n(z.number()) })),
	}),
	included: n(Included),
});

/** Every page of one collection, or throw: a count short of paging.total is not "all of it". */
async function readEntities(
	api: Voyager,
	urn: string,
	kind: EntityKind,
): Promise<unknown[]> {
	const [collection, type, toRow] = RAW[kind];
	const COUNT = 100;
	const out: unknown[] = [];
	for (let start = 0; ; ) {
		const page = await api(
			`/voyager/api/identity/dash/${collection}?q=viewee&profileUrn=${urn}&start=${start}&count=${COUNT}`,
			Collection,
		);
		const byUrn = new Map(
			(page.included ?? [])
				.filter((i) => i.$type?.endsWith(`.${type}`))
				.map((i) => [i.entityUrn, i]),
		);
		for (const u of page.data["*elements"]) {
			const e = byUrn.get(u);
			if (!e) throw new Error(`element ${u} has no ${type} record`);
			const fields = Object.fromEntries(
				Object.entries({ id: entityId(u), ...toRow(e) }).filter(
					([, v]) => v !== null && v !== undefined,
				),
			);
			out.push(ENTITIES[kind].parse(fields));
		}
		const order = page.data["*elements"];
		const total = page.data.paging?.total;
		start += order.length;
		if (typeof total === "number") {
			if (start >= total) return out;
			if (!order.length)
				throw new Error(
					`read ${out.length} of ${total}; a page came back empty`,
				);
		} else if (order.length < COUNT) return out;
		else if (start >= COUNT * 50)
			throw new Error(`no paging.total and still paging at ${start}`);
	}
}

// --- The whole profile --------------------------------------------------------------

const Graph = z.object({ data: z.unknown(), included: n(Included) });
const ProfileLookup = z.object({
	data: z.object({
		data: z.object({
			identityDashProfilesByMemberIdentity: z.object({
				"*elements": z.array(z.string()),
			}),
		}),
	}),
	included: n(Included),
});
const Me = z.looseObject({
	entityUrn: z.string(),
	firstName: z.string(),
	lastName: z.string(),
	headline: n(z.string()),
});
const Card = z.object({
	topComponents: z.array(
		z.object({
			components: n(
				z.object({
					headerComponent: n(z.object({ title: n(Text) })),
					textComponent: n(z.object({ text: n(Text) })),
				}),
			),
		}),
	),
});

type Plcs = (sectionType: string) => Promise<(Plc & { raw: unknown })[]>;
const Elements = z.object({
	components: z.object({ elements: z.array(z.unknown()) }),
});

/** Experience: one list, plus one more per company that holds several roles, matched by position group id. */
async function readExperience(plcs: Plcs, warnings: string[]): Promise<Item[]> {
	const all = await plcs("experience");
	const main = all.find((p) => p.decorationType === "LINE_SEPARATED");
	if (!main) throw new Error("no experience list in the response");
	const entries = parseElements(main.components?.elements ?? []);
	// The group id sits in keys the schema does not keep, so search the raw record.
	const raw = Elements.parse(main.raw).components.elements.map((el) =>
		JSON.stringify(el),
	);
	const groups = all.filter(
		(p) =>
			p.decorationType === "NONE" &&
			p.entityUrn?.includes("profilePositionGroup"),
	);
	for (const plc of groups) {
		const group =
			/fsd_profilePositionGroup:([^)]+)/u.exec(plc.entityUrn ?? "")?.[1] ?? "";
		const entry = entries[raw.findIndex((el) => group && el.includes(group))];
		if (!entry) {
			// Noted, not fatal: a role it held reads absent, and positions are never created.
			warnings.push(
				`sections.Experience: position group ${group} matches no entry`,
			);
			continue;
		}
		const roles = parseElements(plc.components?.elements ?? []);
		for (const r of roles) if (entry.title) r.company = entry.title;
		entry.roles = roles;
	}
	return entries;
}

/** Skills sit in several category lists; a skill is kept once. */
async function readSkills(api: Voyager, plcs: Plcs): Promise<Item[]> {
	const seen = new Set<string>();
	const out: Item[] = [];
	for (const plc of await plcs("skills"))
		out.push(...(await pageList(api, plc, seen)));
	return out;
}

const TABS = {
	RECEIVED_RECOMMENDATIONS: "received",
	GIVEN_RECOMMENDATIONS: "given",
	PENDING_RECOMMENDATIONS: "pending",
};
async function readRecommendations(
	plcs: Plcs,
): Promise<Record<string, Item[]>> {
	const out: Record<string, Item[]> = {};
	for (const plc of await plcs("recommendations")) {
		const tab =
			Object.entries(TABS).find(([frag]) =>
				plc.entityUrn?.includes(frag),
			)?.[1] ?? `tab_${Object.keys(out).length}`;
		const items = parseElements(plc.components?.elements ?? []);
		if (items.length) out[tab] = items;
	}
	return out;
}

/** About and Causes: header and text pairs on the profile cards. */
function cardTexts(included: z.infer<typeof Included>): Record<string, string> {
	const text: Record<string, string> = {};
	for (const item of included) {
		const top = Card.safeParse(item).data?.topComponents;
		const header = top?.[0]?.components?.headerComponent?.title?.text;
		const body = top?.[1]?.components?.textComponent?.text?.text;
		if (header && body) text[header] = body;
	}
	return text;
}

/** The whole profile, as the mirror holds it. */
export async function exportProfile(
	{ api, vanity }: Pick<Session, "api" | "vanity">,
	log = console.error,
): Promise<Mirror> {
	const warnings: string[] = [];
	// A failed read leaves its key out and says why; it never becomes empty.
	const attempt = async <T>(
		what: string,
		read: () => Promise<T>,
	): Promise<T | undefined> => {
		try {
			return await read();
		} catch (err) {
			// A stop (429) ends the export: more requests after "stop" make it worse.
			if (!(err instanceof Error) || err instanceof StopError) throw err;
			const why = `${what}: ${err.message.split("\n")[0]}`;
			warnings.push(why);
			log(`  ${why}`);
			return undefined;
		}
	};
	const lookup = await api(
		`/voyager/api/graphql?variables=(vanityName:${vanity})&queryId=${QUERY.profile}`,
		ProfileLookup,
	);
	const profileUrn =
		lookup.data.data.identityDashProfilesByMemberIdentity["*elements"][0];
	if (!profileUrn) throw new Error(`no profile for ${vanity}`);
	const urn = encodeURIComponent(profileUrn);
	const graph = (variables: string, q: string) =>
		api(`/voyager/api/graphql?variables=(${variables})&queryId=${q}`, Graph);
	const plcs: Plcs = async (sectionType) =>
		(
			(
				await graph(
					`profileUrn:${urn},sectionType:${sectionType}`,
					QUERY.section,
				)
			).included ?? []
		)
			.filter(isPlc)
			.map((raw) => ({ ...Plc.parse(raw), raw }));
	const list = async (slug: string) => {
		const all = await plcs(slug);
		const plc =
			all.find((p) => p.decorationType === "LINE_SEPARATED") ?? all[0];
		return plc ? pageList(api, plc) : [];
	};

	const [info, cards, xp, sk, recs, ...rest] = await Promise.all([
		graph(`profileUrn:${urn}`, QUERY.cards),
		graph(`profileUrn:${urn}`, QUERY.cards2),
		attempt("sections.Experience", () => readExperience(plcs, warnings)),
		attempt("sections.Skills", () => readSkills(api, plcs)),
		attempt("sections.Recommendations", () => readRecommendations(plcs)),
		...Object.entries(SECTION_SLUGS).map(
			async ([name, slug]) =>
				[name, await attempt(`sections.${name}`, () => list(slug))] as const,
		),
	]);
	// Your own Profile record carries the name and headline.
	const me = [lookup, info, cards]
		.flatMap((r) => r.included ?? [])
		.filter((i) => i.$type?.includes("Profile") && i.entityUrn === profileUrn)
		.flatMap((i) => Me.safeParse(i).data ?? [])[0];
	// Checked before the entity reads: no traffic for an export that cannot succeed.
	// Without it the headline would read as empty: stale, when the read is what broke.
	if (!me)
		throw new Error(
			"your own profile record is not in the response; the cards query may have rotated",
		);
	const entities: Record<string, unknown[]> = {};
	for (const kind of Object.keys(RAW) as EntityKind[]) {
		const rows = await attempt(`entities.${kind}`, () =>
			readEntities(api, urn, kind),
		);
		if (rows) entities[kind] = rows;
	}

	const text = cardTexts(cards.included ?? []);
	const recommendations = recs && Object.keys(recs).length ? recs : undefined;
	const sections = Object.fromEntries(
		[
			["About", text["About"]],
			["Causes", text["Causes"]],
			["Experience", xp],
			["Skills", sk],
			["Recommendations", recommendations],
			...rest.map(
				([name, items]) => [name, items?.length ? items : undefined] as const,
			),
		].filter(([, v]) => v !== undefined),
	);
	return Mirror.parse({
		name: `${me.firstName} ${me.lastName}`,
		headline: me.headline ?? "",
		vanityName: vanity,
		profileUrn,
		exportedAt: new Date().toISOString(),
		sections,
		entities,
		...(warnings.length ? { warnings } : {}),
	});
}

// --- First-degree connections -----------------------------------------------------

const Connections = z.object({
	data: z.object({ "*elements": z.array(z.string()) }),
	included: n(z.array(z.looseObject({ entityUrn: n(z.string()) }))),
});
const Person = z.object({
	firstName: str,
	lastName: str,
	headline: str,
	publicIdentifier: str,
});
const Conn = z.object({ createdAt: n(z.number()) });

/** Every first-degree connection, newest first, as CSV rows. */
export async function exportConnections(
	api: Voyager,
	log = console.error,
): Promise<string[][]> {
	const Size = 40; // what the UI asks for; larger is refused
	const rows: string[][] = [["name", "headline", "url", "connected_on"]];
	const seen = new Set<string>();
	for (let start = 0; ; start += Size) {
		const page = await api(
			`/voyager/api/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16&count=${Size}&q=search&sortType=RECENTLY_ADDED&start=${start}`,
			Connections,
		);
		const byUrn = new Map((page.included ?? []).map((i) => [i.entityUrn, i]));
		for (const urn of page.data["*elements"]) {
			const id = urn.split(":").pop() ?? "";
			const person = Person.safeParse(byUrn.get(`urn:li:fsd_profile:${id}`));
			if (!person.success || seen.has(id)) continue;
			seen.add(id);
			const p = person.data;
			const at = Conn.safeParse(byUrn.get(urn)).data?.createdAt;
			rows.push([
				`${p.firstName ?? ""} ${p.lastName ?? ""}`.replace(/\s+/gu, " ").trim(),
				(p.headline ?? "").replace(/\s+/gu, " ").trim(),
				p.publicIdentifier
					? `https://www.linkedin.com/in/${p.publicIdentifier}/`
					: "",
				at ? new Date(at).toISOString().slice(0, 10) : "",
			]);
		}
		log(`  connections: ${rows.length - 1}`);
		if (page.data["*elements"].length < Size) return rows;
		await new Promise((r) => setTimeout(r, 800)); // roughly the UI's scroll cadence
	}
}

// Names and headlines are other people's text, opened in a spreadsheet: a
// leading = + - @ tab or CR would run as a formula, so it gets a ' in front.
const cell = (v: string) =>
	`"${v.replace(/^[=+\-@\t\r]/u, "'$&").replaceAll('"', '""')}"`;
export const writeCsv = (path: string, rows: string[][]): void =>
	writeFileSync(path, `${rows.map((r) => r.map(cell).join(",")).join("\n")}\n`);
