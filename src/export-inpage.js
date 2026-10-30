// Paste into browser console on your LinkedIn profile page.
// Extracts full profile data via Voyager GraphQL, saves as JSON.
//
// Query IDs are hashes of LinkedIn's GraphQL queries. They rotate when
// LinkedIn updates their frontend. To fix: open Network tab, find the
// failing request, grab the new hash from queryId=, update here.
const QUERY_IDS = {
	PROFILE_LOOKUP:
		"voyagerIdentityDashProfiles.a1a483e719b20537a256b6853cdca711",
	PROFILE_CARDS:
		"voyagerIdentityDashProfileCards.ef04d8d8a644bb1271d8640b7fd373d3",
	PROFILE_CARDS_2:
		"voyagerIdentityDashProfileCards.55af784c21dc8640b500ab5b45937064",
	SECTION:
		"voyagerIdentityDashProfileComponents.c5d4db426a0f8247b8ab7bc1d660775a",
	SECTION_PAGE:
		"voyagerIdentityDashProfileComponents.1ad109a952e36585fdc2e7c2dedcc357",
};

const SECTION_SLUGS = {
	Education: "education",
	Courses: "courses",
	"Honors & awards": "honors",
	Languages: "languages",
	Publications: "publications",
	Volunteering: "volunteering-experiences",
	Projects: "projects",
	"Licenses & certifications": "certifications",
	Featured: "featured", // 200 on 2026-09-12; empty until a card exists
};

// One structured collection, every page of it, or null when the pages cannot
// be trusted to be all of it. Null is "unreadable": export.mjs leaves the
// collection out of the mirror and every reader and writer refuses on it.
// A short read must never pass as complete: a writer that sees an entry
// missing creates it again. So a page that failed, a page whose shape is
// not the one below, an element with no matching record, or a count short
// of paging.total all give null (the last three throw, so the reason lands
// in the export's warnings). Without paging.total, only a page shorter than
// the one asked for proves it was the last.
// fetchPage(start, count) -> the normalized+json response.
const collectEntities = async (fetchPage, type, toRow) => {
	const COUNT = 100;
	const out = [];
	for (let start = 0; ; ) {
		const page = await fetchPage(start, COUNT);
		if (page?.failed) return null;
		const order = page?.data?.["*elements"];
		if (!Array.isArray(order) || !Array.isArray(page.included ?? []))
			throw new Error(`unexpected response shape at start=${start}`);
		const byUrn = new Map(
			(page.included ?? [])
				.filter((i) => i?.$type?.endsWith(`.${type}`))
				.map((i) => [i.entityUrn, i]),
		);
		for (const u of order) {
			const e = byUrn.get(u);
			if (!e) throw new Error(`element ${u} has no ${type} record`);
			const row = toRow(u, e);
			for (const k of Object.keys(row))
				if (row[k] === null || row[k] === undefined) delete row[k];
			out.push(row);
		}
		const total = page.data.paging?.total;
		start += order.length;
		if (typeof total === "number") {
			if (start >= total) return out;
			if (order.length === 0)
				throw new Error(
					`read ${out.length} of ${total}; a page came back empty`,
				);
		} else if (order.length < COUNT) return out;
		else if (start >= COUNT * 50)
			throw new Error(`no paging.total and still paging at ${start}`);
	}
};

// One rendered section's PagedListComponent, every page of it, or throw.
// Like collectEntities, a short read must never pass as complete: Projects
// read here is what the project writer checks before adding one, so a page
// that failed, or fewer elements than paging.total, throws and export leaves
// the section out of the mirror (unreadable, the reason in warnings) rather
// than writing a partial list a create would take as "absent". Counts the
// elements fetched, not the items kept: skills share `seen` across category
// lists, so a skill in two categories is dropped from the second on purpose.
// fetchPage(start) -> the normalized+json response for that page.
const paginatePlc = async (plc, fetchPage, parse, seen = new Set()) => {
	const elements = plc.components?.elements || [];
	const total = plc.components?.paging?.total || elements.length;
	const items = [];
	const keep = (els) => {
		for (const item of parse(els)) {
			const key = `${item.title}|${item.dates || ""}`;
			if (!seen.has(key)) {
				seen.add(key);
				items.push(item);
			}
		}
	};
	keep(elements);
	let fetched = elements.length;
	if (fetched < total && !plc.entityUrn)
		throw new Error(`read ${fetched} of ${total}; no list urn to page with`);
	while (fetched < total) {
		const page = await fetchPage(fetched);
		if (page?.failed)
			throw new Error(`read ${fetched} of ${total}; a page failed`);
		const els =
			page?.data?.data?.identityDashProfileComponentsByPagedListComponent
				?.elements || [];
		if (els.length === 0)
			throw new Error(`read ${fetched} of ${total}; a page came back empty`);
		keep(els);
		fetched += els.length;
	}
	return { items, total };
};

(async () => {
	try {
		const csrf = document.cookie.match(/JSESSIONID="?([^";]+)/)?.[1];
		const vanity = location.pathname.match(/\/in\/([^/]+)/)?.[1];
		if (!csrf || !vanity)
			return console.error("Navigate to /in/yourname first");

		// Non-OK responses degrade to an empty section rather than aborting, so
		// one rotated query ID does not lose the whole export. They are recorded
		// in the output as `warnings`; the console alone is invisible to the
		// node harness.
		const warnings = [];
		const get = (url) =>
			fetch(url, {
				headers: {
					"csrf-token": csrf,
					accept: "application/vnd.linkedin.normalized+json+2.1",
					"x-restli-protocol-version": "2.0.0",
				},
			}).then((r) => {
				if (!r.ok) {
					const endpoint = url.split("?")[0];
					const hint =
						url.match(/sectionType:(\w+)/)?.[1] ||
						url.match(/queryId=\w+\.(\w+)/)?.[1] ||
						"";
					warnings.push(`API ${r.status}: ${endpoint}...${hint}`);
					console.warn(warnings[warnings.length - 1]);
					return { included: [], data: {}, failed: true };
				}
				return r.json();
			});

		// --- Parsing ---

		const parseEntity = (ec) => {
			if (!ec) return null;
			const entry = {};
			const title = ec.titleV2?.text?.text || ec.title?.text || "";
			const subtitle = ec.subtitle?.text || "";
			const caption = ec.caption?.text || "";
			const meta = ec.metadata?.text || "";
			if (title) entry.title = title;
			if (subtitle) entry.subtitle = subtitle;
			if (caption) entry.dates = caption;
			if (meta) entry.location = meta;

			const descriptions = [];
			const skillTexts = [];
			const children = [];
			const media = [];

			const collectText = (text) => {
				if (text.startsWith("Skills: ")) {
					skillTexts.push(...text.slice(8).split(" · "));
				} else {
					descriptions.push(text);
				}
			};

			const collectComponents = (components) => {
				const sc = components || {};
				if (sc.textComponent?.text?.text)
					collectText(sc.textComponent.text.text);
				if (sc.entityComponent) {
					const child = parseEntity(sc.entityComponent);
					if (child) children.push(child);
				}
				if (sc.mediaComponent) media.push(parseMedia(sc.mediaComponent));
			};

			for (const sub of ec.subComponents?.components || []) {
				collectComponents(sub.components);
				for (const nc of sub.components?.fixedListComponent?.components || []) {
					collectComponents(nc.components);
				}
			}

			if (descriptions.length)
				entry.description = descriptions.join("\n").replace(/\n{3,}/g, "\n\n");
			if (skillTexts.length) entry.skills = skillTexts;
			if (children.length) entry.roles = children;
			if (media.length) entry.media = media;
			return Object.keys(entry).length ? entry : null;
		};

		// A media item (image, document, link) attached to an entry. An external
		// link carries its URL; an upload, and a link LinkedIn could not unfurl,
		// carries only a LinkedIn viewer URL, so `url` is null and `kind` comes
		// from the viewer's type= parameter (probe 2026-10-29: a LINK item with no
		// thumbnail and a viewer URL whose page reads "This page doesn't exist").
		const parseMedia = (mc) => {
			const target = mc.actionTarget || mc.thumbnail?.actionTarget || "";
			const viewer = /multiple-media-viewer/.test(target);
			const item = {
				title: mc.titleV2?.text?.text || mc.title?.text || "",
				kind: viewer
					? target.match(/[?&]type=([A-Z_]+)/)?.[1] || "UNKNOWN"
					: "LINK",
				url: viewer ? null : target || null,
				thumbnail: Boolean(mc.thumbnail?.entityImage),
			};
			const description = mc.description?.text?.text;
			if (description) item.description = description;
			return item;
		};

		const parseElements = (elements) => {
			const items = [];
			for (const el of elements) {
				const sc = el.components || {};
				if (sc.entityComponent) {
					const parsed = parseEntity(sc.entityComponent);
					if (parsed) items.push(parsed);
				} else if (sc.textComponent?.text?.text) {
					items.push({ title: sc.textComponent.text.text });
				}
			}
			return items;
		};

		// --- Shared fetching ---

		const encodePlcUrn = (entityUrn) =>
			encodeURIComponent(entityUrn).replace(/\(/g, "%28").replace(/\)/g, "%29");

		// Fetch a section and return all PagedListComponents from the response
		const fetchSectionPlcs = async (sectionType) => {
			const resp = await get(
				`/voyager/api/graphql?variables=(profileUrn:${urn},sectionType:${sectionType})&queryId=${QUERY_IDS.SECTION}`,
			);
			return (resp.included || []).filter((i) =>
				i.$type?.includes("PagedListComponent"),
			);
		};

		// Paginate a single PLC (see paginatePlc above); a partial read throws.
		const pagePlc = (plc, seen) =>
			paginatePlc(
				plc,
				(start) =>
					get(
						`/voyager/api/graphql?variables=(start:${start},count:20,paginationToken:null,pagedListComponent:${encodePlcUrn(plc.entityUrn)})&queryId=${QUERY_IDS.SECTION_PAGE}`,
					),
				parseElements,
				seen,
			);

		// --- Step 1: Profile URN ---
		console.log("Fetching profile URN...");
		const profileResp = await get(
			`/voyager/api/graphql?variables=(vanityName:${vanity})&queryId=${QUERY_IDS.PROFILE_LOOKUP}`,
		);
		const profileUrn =
			profileResp.data?.data?.identityDashProfilesByMemberIdentity?.[
				"*elements"
			]?.[0];
		if (!profileUrn)
			return console.error("Could not resolve profile URN", profileResp);
		const urn = encodeURIComponent(profileUrn);
		console.log("URN:", profileUrn);

		// --- Step 2+3: Name + headline, About + Causes (parallel) ---
		console.log("Fetching profile cards...");
		const [infoResp, cardsResp] = await Promise.all([
			get(
				`/voyager/api/graphql?variables=(profileUrn:${urn})&queryId=${QUERY_IDS.PROFILE_CARDS}`,
			),
			get(
				`/voyager/api/graphql?variables=(profileUrn:${urn})&queryId=${QUERY_IDS.PROFILE_CARDS_2}`,
			),
		]);
		// The vanity lookup carries the full Profile record for the target. The
		// cards responses carry it fully only for your own profile; for anyone
		// else it is a 4-key stub, so search the lookup first.
		const isTarget = (i) =>
			i.$type?.includes("Profile") && i.entityUrn === profileUrn;
		const me = [profileResp, infoResp, cardsResp]
			.flatMap((r) => r.included || [])
			.find((i) => isTarget(i) && i.firstName);
		const textSections = {};
		for (const item of cardsResp.included || []) {
			const tc = item.topComponents;
			if (!tc) continue;
			const header = tc[0]?.components?.headerComponent?.title?.text;
			const text = tc[1]?.components?.textComponent?.text?.text;
			if (header && text) textSections[header] = text;
		}

		// --- Step 4: Paginated section fetcher ---
		const fetchPagedList = async (sectionType, label = sectionType) => {
			console.log(`Fetching ${label}...`);
			const plcs = await fetchSectionPlcs(sectionType);
			const plc =
				plcs.find((p) => p.decorationType === "LINE_SEPARATED") || plcs[0];
			if (!plc) return [];

			const { items, total } = await pagePlc(plc);
			console.log(`  ${sectionType}: ${items.length}/${total}`);
			return items;
		};

		// --- Step 5: Experience (grouped roles need special handling) ---
		const fetchExperience = async () => {
			console.log("Fetching experience...");
			const plcs = await fetchSectionPlcs("experience");
			const mainPlc = plcs.find((p) => p.decorationType === "LINE_SEPARATED");
			if (!mainPlc) return [];

			const rawElements = mainPlc.components?.elements || [];
			const entries = parseElements(rawElements);

			// Sub-role PLCs: NONE type with profilePositionGroup in entityUrn.
			// Match each to its group container by position group ID.
			const subRolePlcs = plcs.filter(
				(p) =>
					p.decorationType === "NONE" &&
					p.entityUrn?.includes("profilePositionGroup"),
			);
			for (const plc of subRolePlcs) {
				const groupId = plc.entityUrn?.match(
					/fsd_profilePositionGroup:([^)]+)/,
				)?.[1];
				if (!groupId) continue;

				let matched = false;
				for (let i = 0; i < rawElements.length; i++) {
					if (JSON.stringify(rawElements[i]).includes(groupId)) {
						const detailed = parseElements(plc.components?.elements || []);
						for (const role of detailed) role.company = entries[i].title;
						entries[i].roles = detailed;
						console.log(
							`    ${entries[i].title}: ${detailed.length} sub-roles matched by positionGroup`,
						);
						matched = true;
						break;
					}
				}
				if (!matched) console.warn(`    Unmatched positionGroup: ${groupId}`);
			}

			const paging = mainPlc.components?.paging || {};
			console.log(
				`  experience: ${entries.length}/${paging.total || entries.length} top-level (${subRolePlcs.length} grouped companies)`,
			);
			return entries;
		};

		// --- Step 6: Skills (collect from ALL category PLCs, dedup across them) ---
		const fetchSkills = async () => {
			console.log("Fetching skills...");
			const plcs = await fetchSectionPlcs("skills");
			const allSkills = [];
			const seen = new Set();
			for (const plc of plcs) {
				const { items } = await pagePlc(plc, seen);
				allSkills.push(...items);
			}
			console.log(
				`  skills: ${allSkills.length} unique from ${plcs.length} category PLCs`,
			);
			return allSkills;
		};

		// --- Step 7: Recommendations (separate PLCs for received/given/pending) ---
		const fetchRecommendations = async () => {
			console.log("Fetching recommendations...");
			const plcs = await fetchSectionPlcs("recommendations");
			const tabFragments = {
				RECEIVED_RECOMMENDATIONS: "received",
				GIVEN_RECOMMENDATIONS: "given",
				PENDING_RECOMMENDATIONS: "pending",
			};
			const recs = {};
			for (const plc of plcs) {
				const tab = Object.entries(tabFragments).find(([frag]) =>
					plc.entityUrn?.includes(frag),
				);
				const label = tab?.[1] || `tab_${Object.keys(recs).length}`;
				const items = parseElements(plc.components?.elements || []);
				if (items.length) recs[label] = items;
			}
			if (Object.keys(recs).length) {
				console.log(
					`  recommendations: ${Object.entries(recs)
						.map(([k, v]) => `${k}:${v.length}`)
						.join(", ")}`,
				);
			} else {
				console.log("  recommendations: empty or not found");
			}
			return recs;
		};

		// --- Step 7b: Structured entities (the edit forms' own data) ---
		// The sections above are what the page renders: display strings. A few
		// fields never render (an education's grade, a credential ID, which role
		// an honour belongs to) and every editor URL carries the entry's numeric
		// id, so the same records are also read from the dash REST collections
		// the edit forms are built from (probe 2026-10-29). A collection that
		// fails to load is left out, never written as empty: drift reads a
		// missing collection as unreadable and an empty one as "no entries".
		const ENTITY_KINDS = {
			positions: ["profilePositions", "Position"],
			educations: ["profileEducations", "Education"],
			certifications: ["profileCertifications", "Certification"],
			honors: ["profileHonors", "Honor"],
			publications: ["profilePublications", "Publication"],
			volunteering: ["profileVolunteerExperiences", "VolunteerExperience"],
			projects: ["profileProjects", "Project"],
			skills: ["profileSkills", "Skill"],
		};
		const isoDate = (d) =>
			d?.year
				? [
						String(d.year),
						d.month ? String(d.month).padStart(2, "0") : null,
						d.day ? String(d.day).padStart(2, "0") : null,
					]
						.filter(Boolean)
						.join("-")
				: null;
		const isoRange = (r) =>
			r ? { start: isoDate(r.start), end: isoDate(r.end) } : null;
		// "urn:li:fsd_profileEducation:(ACoA...,123456789)" -> "123456789", the
		// id the editor URL takes: /details/education/edit/forms/123456789/
		const entityId = (urn) => urn?.match(/,([^,)]+)\)$/)?.[1] ?? null;
		const occupation = (u) =>
			u?.profilePosition
				? { position: entityId(u.profilePosition) }
				: u?.profileEducation
					? { education: entityId(u.profileEducation) }
					: null;
		const NORMALIZE = {
			positions: (e) => ({
				title: e.title,
				company: e.companyName,
				location: e.locationName,
				dates: isoRange(e.dateRange),
				description: e.description,
			}),
			educations: (e) => ({
				school: e.schoolName,
				degree: e.degreeName,
				field: e.fieldOfStudy,
				grade: e.grade,
				activities: e.activities,
				dates: isoRange(e.dateRange),
				description: e.description,
			}),
			certifications: (e) => ({
				name: e.name,
				issuer: e.authority,
				dates: isoRange(e.dateRange),
				credentialId: e.licenseNumber,
				url: e.url,
			}),
			honors: (e) => ({
				title: e.title,
				issuer: e.issuer,
				date: isoDate(e.issuedOn),
				associated: occupation(e.occupationUnion),
				description: e.description,
			}),
			publications: (e) => ({
				title: e.name,
				publisher: e.publisher,
				date: isoDate(e.publishedOn),
				url: e.url,
				description: e.description,
			}),
			volunteering: (e) => ({
				organization: e.companyName,
				role: e.role,
				cause: e.cause,
				dates: isoRange(e.dateRange),
				description: e.description,
			}),
			projects: (e) => ({
				title: e.title,
				url: e.url,
				dates: isoRange(e.dateRange),
				associated: occupation(e.occupationUnion),
				description: e.description,
			}),
			skills: (e) => ({ name: e.name }),
		};
		const fetchEntities = async (kind) => {
			const [collection, type] = ENTITY_KINDS[kind];
			const out = await collectEntities(
				(start, count) =>
					get(
						`/voyager/api/identity/dash/${collection}?q=viewee&profileUrn=${urn}&start=${start}&count=${count}`,
					),
				type,
				(u, e) => ({ id: entityId(u), ...NORMALIZE[kind](e) }),
			);
			if (out) console.log(`  entities.${kind}: ${out.length}`);
			return out;
		};
		const fetchAllEntities = async () => {
			const entities = {};
			for (const kind of Object.keys(ENTITY_KINDS)) {
				const rows = await fetchEntities(kind).catch((err) => {
					warnings.push(`entities.${kind}: ${err.message}`);
					return null;
				});
				if (rows) entities[kind] = rows;
			}
			return entities;
		};

		// --- Step 8: Fetch all sections in parallel, then assemble ---
		console.log("Fetching all sections in parallel...");
		const [experience, skills, recs, entities, ...sectionResults] =
			await Promise.all([
				fetchExperience(),
				fetchSkills().catch((err) => {
					warnings.push(`sections.Skills: ${err.message}`);
					return null;
				}),
				fetchRecommendations(),
				fetchAllEntities(),
				...Object.entries(SECTION_SLUGS).map(([name, slug]) =>
					fetchPagedList(slug, name)
						.then((items) => ({ name, items }))
						.catch((err) => {
							// Left out of the mirror, so it reads as unreadable, never empty.
							warnings.push(`sections.${name}: ${err.message}`);
							console.warn(`  ${name} failed, skipping:`, err.message);
							return null;
						}),
				),
			]);

		const profile = {
			name: me ? `${me.firstName} ${me.lastName}` : vanity,
			headline: me?.headline || "",
			vanityName: vanity,
			profileUrn,
			exportedAt: new Date().toISOString(),
			sections: {},
			entities,
		};

		if (textSections.About) profile.sections.About = textSections.About;
		if (textSections.Causes) profile.sections.Causes = textSections.Causes;

		profile.sections.Experience = experience;
		if (skills) profile.sections.Skills = skills;
		if (Object.keys(recs).length) profile.sections.Recommendations = recs;

		for (const result of sectionResults) {
			if (result?.items.length) profile.sections[result.name] = result.items;
			else if (result) console.log(`  ${result.name}: empty or not found`);
		}
		if (warnings.length) profile.warnings = warnings;

		// --- Step 9: Output ---
		const output = JSON.stringify(profile, null, 2);
		console.log(
			`\nExport complete: ${Object.keys(profile.sections).length} sections`,
		);
		for (const [k, v] of Object.entries(profile.sections)) {
			if (Array.isArray(v)) {
				console.log(`  ${k}: ${v.length} items`);
			} else if (typeof v === "string") {
				console.log(`  ${k}: ${v.length} chars`);
			} else {
				const detail = Object.entries(v)
					.map(([sk, sv]) => `${sk}:${sv.length}`)
					.join(", ");
				console.log(`  ${k}: ${detail}`);
			}
		}

		const blob = new Blob([output], { type: "application/json" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `linkedin-${vanity}-${new Date().toISOString().split("T")[0]}.json`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
		console.log("Download started!");
	} catch (err) {
		console.error("Export failed:", err);
	}
})();
