// Does LinkedIn still say what the record says? Each block's main value and
// each facet get one of five verdicts. "Could not read this" is its own,
// louder verdict than "these differ": a two-state checker reports "same" when
// a selector stops finding its field, which is how a profile sits months
// behind a green check.

import { diffWords } from "diff";
import {
	type Facet,
	type Field,
	fieldFor,
	mediaFacet,
	PRESENT,
	planSkills,
} from "./fields.ts";
import { MAX_AGE_DAYS, type Mirror, mirrorAge } from "./mirror.ts";
import { type Block, countChars, isCompared, normalize } from "./record.ts";

export type Verdict =
	| "match"
	| "drift"
	| "absent"
	| "no-desired"
	| "unreadable";
export interface Result {
	id: string;
	verdict: Verdict;
	live?: string;
	desired?: string;
	detail?: string;
	skills?: ReturnType<typeof planSkills>;
	unwritten?: true;
}
/** 0 clean, 1 stale, 2 the instrument is broken (unreadable, or a mirror too old to prove anything). */
export type ExitCode = 0 | 1 | 2;

/** One comparison. Never throws: a read that throws is unreadable. */
export function compare(
	f: Pick<Field, "id" | "read" | "desired"> & { type?: string },
	m: Mirror,
): Result {
	const { id } = f;
	let live: string | undefined;
	try {
		live = f.read(m);
	} catch (err) {
		return { id, verdict: "unreadable", detail: (err as Error).message };
	}
	const desired = f.desired;
	const hasLive = live !== undefined && live.trim() !== "";
	const hasDesired = desired.trim() !== "";
	if (!(hasDesired || hasLive))
		return { id, verdict: "match", detail: "both empty" };
	if (!hasDesired)
		return {
			id,
			verdict: "no-desired",
			...(live === undefined ? {} : { live }),
		};
	if (!(hasLive && live)) return { id, verdict: "absent", desired };
	const a = normalize(live);
	const b = normalize(desired);
	if (f.type === "skills") {
		const skills = planSkills(a.split("\n"), b.split("\n"));
		const same = !(skills.add.length || skills.remove.length);
		return {
			id,
			verdict: same ? "match" : "drift",
			live: a,
			desired: b,
			skills,
			detail: `${b.split("\n").length} skills`,
		};
	}
	if (a === b)
		return {
			id,
			verdict: "match",
			detail: b === PRESENT ? "on LinkedIn" : `${countChars(b)} chars`,
		};
	return { id, verdict: "drift", live: a, desired: b };
}

/** Every comparison a field makes: its main value, then each facet on its own line. */
export function compareField(
	f: Field,
	m: Mirror,
	linkStatus: ReadonlyMap<string, number | string> = new Map(),
): Result[] {
	const media = mediaFacet(f, linkStatus);
	const facets: Facet[] = media ? [...f.facets, media] : f.facets;
	return [
		compare(f, m),
		...facets.flatMap((x) => {
			const r = compare(x, m);
			if (x.optional && r.verdict === "absent") return [];
			return [x.unwritten ? { ...r, unwritten: true as const } : r];
		}),
	];
}

export const compared = (blocks: Map<string, Block>): Field[] =>
	[...blocks.values()].filter(isCompared).map(fieldFor);

const stale = (r: Result) => r.verdict === "drift" || r.verdict === "absent";

/**
 * What `write --all-drift` writes: blocks whose main value or a written facet
 * is stale. `unwritten` lists stale facets left to another command;
 * `unreadable` lists blocks whose read threw (the caller refuses on any).
 */
export function staleFields(fields: Field[], m: Mirror) {
	const out = {
		stale: [] as string[],
		unwritten: [] as string[],
		unreadable: [] as string[],
	};
	for (const f of fields) {
		const results = compareField(f, m);
		if (results.some((r) => r.verdict === "unreadable"))
			out.unreadable.push(f.id);
		else {
			const off = results.filter(stale);
			if (off.some((r) => !r.unwritten)) out.stale.push(f.id);
			out.unwritten.push(...off.filter((r) => r.unwritten).map((r) => r.id));
		}
	}
	return out;
}

/** The mirror's age problem, or undefined when it is fresh enough to judge by. */
export function staleMirror(
	m: Mirror,
	maxAgeDays = MAX_AGE_DAYS,
): string | undefined {
	const age = mirrorAge(m);
	if (age === null)
		return "the mirror has no readable exportedAt, so its freshness is unknown";
	if (age > maxAgeDays)
		return `the mirror is ${age.toFixed(1)} days old (limit ${maxAgeDays})`;
	return undefined;
}

export function exitCode(
	results: Result[],
	m: Mirror,
	maxAgeDays = MAX_AGE_DAYS,
): ExitCode {
	if (
		results.some((r) => r.verdict === "unreadable") ||
		staleMirror(m, maxAgeDays)
	)
		return 2;
	return results.some(stale) ? 1 : 0;
}

/** url -> HTTP status, or why it could not be reached. HEAD first; a 403/405 is retried as GET. */
export async function checkLinks(
	urls: Iterable<string>,
): Promise<Map<string, number | string>> {
	const status = new Map<string, number | string>();
	await Promise.all(
		[...new Set(urls)].map(async (u) => {
			const hit = (method: string) =>
				fetch(u, {
					method,
					redirect: "follow",
					signal: AbortSignal.timeout(15_000),
				});
			try {
				let r = await hit("HEAD");
				if (r.status === 403 || r.status === 405) r = await hit("GET");
				status.set(u, r.status);
			} catch (err) {
				const e = err as Error & { cause?: { code?: string } };
				status.set(u, `unreachable (${e.cause?.code ?? e.message})`);
			}
		}),
	);
	return status;
}

const MARK: Record<Verdict, string> = {
	match: "ok",
	drift: "DRIFT",
	absent: "ABSENT",
	"no-desired": "no-rec",
	unreadable: "BROKEN",
};
const flat = (s: string) => s.replaceAll("\n", "\\n");

/** A changed span with a little context either side, as -[live]+{record}. */
function wordDiff(live: string, desired: string): string {
	const parts = diffWords(live, desired);
	const out: string[] = [];
	parts.forEach((p, i) => {
		if (p.added) out.push(`{+${flat(p.value)}+}`);
		else if (p.removed) out.push(`[-${flat(p.value)}-]`);
		else {
			const v = flat(p.value);
			const head = i === 0 ? "" : v.slice(0, 40);
			const tail = i === parts.length - 1 ? "" : v.slice(-40);
			out.push(
				v.length <= 90 ? v : `${head}${head && tail ? " ... " : "..."}${tail}`,
			);
		}
	});
	return out.join("");
}

/** The lines under a result that say what is off. */
function explain(r: Result): string[] {
	const out: string[] = [];
	if (r.skills) {
		if (r.skills.add.length) out.push(`add     ${r.skills.add.join(", ")}`);
		if (r.skills.remove.length)
			out.push(`remove  ${r.skills.remove.join(", ")}`);
		for (const c of r.skills.recase)
			out.push(
				`case    record ${JSON.stringify(c.record)}, LinkedIn ${JSON.stringify(c.live)} (fix the record; write leaves it)`,
			);
	} else if (
		r.verdict === "drift" &&
		r.live !== undefined &&
		r.desired !== undefined
	)
		out.push(wordDiff(r.live, r.desired));
	if (r.verdict === "absent")
		out.push(
			r.desired === PRESENT
				? "not on LinkedIn yet"
				: `not on LinkedIn yet (${countChars(r.desired ?? "")} chars in the record)`,
		);
	if (r.unwritten && stale(r)) out.push("(not written by write <id>)");
	return out;
}

/** The report a person reads. */
export function report(
	results: Result[],
	m: Mirror,
	blocks: number,
	maxAgeDays = MAX_AGE_DAYS,
): string[] {
	const age = mirrorAge(m);
	const lines = [
		`mirror   ${m.exportedAt}`,
		`         ${age === null ? "unknown age" : `${age.toFixed(1)} days old`}`,
		`record   ${blocks} blocks`,
		"",
	];
	const width = Math.max(...results.map((r) => r.id.length));
	for (const r of results) {
		lines.push(
			`${MARK[r.verdict].padEnd(7)} ${r.id.padEnd(width)}  ${r.detail ?? ""}`.trimEnd(),
			...explain(r).map((l) => `        ${l}`),
		);
	}
	const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
	const off = count("drift") + count("absent");
	lines.push(
		"",
		`${results.length} fields: ${count("match")} match, ${off} stale, ${count("no-desired")} not in the record, ${count("unreadable")} unreadable`,
	);
	if (count("unreadable"))
		lines.push(
			"",
			"A read stopped finding its field; fix src/fields.ts (or re-export) before trusting any verdict above.",
		);
	const old = staleMirror(m, maxAgeDays);
	if (old)
		lines.push(
			"",
			`${old}: a comparison against it proves nothing. Re-export first.`,
		);
	return lines;
}
