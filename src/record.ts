// Your source-of-truth file (linkedin.md): prose, with one fenced block per
// value this tool manages, tagged `linkedin:<id>` and carrying key="value"
// attributes that say which entry it maps to and which values it manages:
//
//     ```linkedin:project.dispatch title="Dispatch" dates="Mar 2026 - Present"
//     The description.
//     ```
//
// Fences rather than blockquotes: a fence keeps the text byte for byte.
// Parsing is remark's (mdast); this file only reads the info string. Every
// way a block can be wrong throws, because a block skipped is a field the
// drift check silently stops comparing.

import { readFileSync } from "node:fs";
import process from "node:process";
import type { Code, Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { z } from "zod";

export const RECORD_PATH =
	process.env["LINKEDIN_COPY"] ?? `${process.cwd()}/linkedin.md`;

// Which attributes each type accepts, and which one finds its entry. An
// attribute the type does not know is an error (a typo like dats= would
// otherwise manage nothing, silently).
const str = z.string();
const opt = str.optional();
const common = { compare: z.enum(["true", "false"]).optional() };
export const ATTRS = {
	headline: z.strictObject({ ...common }),
	about: z.strictObject({ ...common }),
	position: z.strictObject({
		...common,
		match: str.min(1),
		role: opt,
		dates: opt,
		company: opt,
		skills: opt,
	}),
	project: z.strictObject({
		...common,
		title: str.min(1).max(255),
		dates: opt,
		link: opt,
	}),
	education: z.strictObject({
		...common,
		match: str.min(1),
		school: opt,
		degree: opt,
		field: opt,
		dates: opt,
		grade: str.max(80).optional(),
		activities: str.max(500).optional(),
	}),
	honor: z.strictObject({
		...common,
		title: str.min(1).max(255),
		issuer: str.max(255).optional(),
		date: opt,
		associated: opt,
	}),
	publication: z.strictObject({
		...common,
		title: str.min(1).max(255),
		publisher: str.max(255).optional(),
		date: opt,
		url: opt,
	}),
	volunteer: z.strictObject({
		...common,
		match: str.min(1),
		role: opt,
		cause: opt,
		dates: opt,
	}),
	certification: z.strictObject({
		...common,
		name: str.min(1),
		issuer: opt,
		dates: opt,
		credential: str.max(80).optional(),
		url: opt,
	}),
	skills: z.strictObject({ ...common }),
} as const;
export type Type = keyof typeof ATTRS;
export type Attrs<T extends Type> = z.infer<(typeof ATTRS)[T]>;
const TYPES = Object.keys(ATTRS) as Type[];
export const isType = (t: string): t is Type => (TYPES as string[]).includes(t);

// LinkedIn's character limits for a block's text, from the editors'
// counters (2026-10-29). null: not free text. 0: the editor has no description.
export const TEXT_LIMITS: Record<Type, number | null> = {
	headline: 220,
	about: 2600,
	position: 2000,
	project: 2000,
	education: 1000,
	honor: 2000,
	publication: 2000,
	volunteer: 2000,
	certification: 0,
	skills: null,
};
const MAX_SKILLS = 100;
const SKILL_LIMIT = 80;

export interface Block {
	id: string;
	type: Type;
	attrs: Record<string, string>;
	text: string;
	line: number;
}

const ATTR = /([a-z]+)="((?:[^"\\]|\\.)*)"/guy;
/** `key="value"` pairs, escape-aware (a literal " is written \"); throws on anything else. */
function parseMeta(meta: string, where: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const s = meta.trim();
	ATTR.lastIndex = 0;
	for (let at = 0; at < s.length; ) {
		ATTR.lastIndex = at;
		const m = ATTR.exec(s);
		if (!m)
			throw new Error(
				`${where}: malformed attributes: ${s.slice(at, at + 60)}`,
			);
		const [whole, key = "", value = ""] = m;
		if (Object.hasOwn(attrs, key))
			throw new Error(`${where}: ${key}= appears twice`);
		attrs[key] = value.replace(/\\(["\\])/gu, "$1");
		at += whole.length;
		while (s[at] === " " || s[at] === "\t") at++;
	}
	return attrs;
}

function* codeNodes(node: Nodes): Generator<Code> {
	if (node.type === "code") yield node;
	if ("children" in node)
		for (const child of node.children) yield* codeNodes(child);
}

/** A skills block: one skill per line; blank lines and "- " bullets ignored. */
export const skillList = (text: string): string[] =>
	text
		.split("\n")
		.map((l) => l.replace(/^\s*[-*]\s+/u, "").trim())
		.filter(Boolean);

/** Count in code points: an emoji is one character to LinkedIn's counter. */
export const countChars = (s: string): number => [...normalize(s)].length;

/** Every `linkedin:` block in the file, checked. Throws on the first problem. */
export function parseRecord(
	source: string,
	path = RECORD_PATH,
): Map<string, Block> {
	const blocks = new Map<string, Block>();
	for (const node of codeNodes(fromMarkdown(source))) {
		if (!node.lang?.startsWith("linkedin:")) continue;
		const line = node.position?.start.line ?? 0;
		const where = `${path}:${line}`;
		const id = node.lang.slice("linkedin:".length);
		if (!/^[A-Za-z0-9_.-]+$/u.test(id))
			throw new Error(`${where}: bad block id "${id}"`);
		const closing = source.slice(0, node.position?.end.offset).trimEnd();
		if (!/(```|~~~)$/u.test(closing))
			throw new Error(`${where}: block "${id}" is never closed`);
		if (blocks.has(id)) throw new Error(`${where}: duplicate block "${id}"`);
		const type = id.split(".")[0] ?? "";
		if (!isType(type))
			throw new Error(
				`${where}: block "${id}" has an unknown type "${type}" (known: ${TYPES.join(", ")})`,
			);
		const attrs = parseMeta(node.meta ?? "", where);
		const checked = ATTRS[type].safeParse(attrs);
		if (!checked.success)
			throw new Error(
				`${where}: block "${id}": ${z.prettifyError(checked.error).replaceAll("\n", "; ")}`,
			);
		blocks.set(id, { id, type, attrs, text: node.value.trimEnd(), line });
	}
	return blocks;
}

export const readRecord = (path = RECORD_PATH): Map<string, Block> =>
	parseRecord(readFileSync(path, "utf8"), path);

/** LinkedIn's limits this block breaks, as readable problems. Empty means clean. */
export function overLimit(b: Block): string[] {
	const problems: string[] = [];
	const limit = TEXT_LIMITS[b.type];
	const n = countChars(b.text);
	if (limit === 0 && n)
		problems.push(
			`${b.id}: a ${b.type} has no description; leave the block empty`,
		);
	else if (limit !== null && n > limit)
		problems.push(`${b.id}: ${n} chars, limit ${limit} (over by ${n - limit})`);
	if (b.type === "skills") {
		const list = skillList(b.text);
		if (list.length > MAX_SKILLS)
			problems.push(`${b.id}: ${list.length} skills, limit ${MAX_SKILLS}`);
		for (const s of list)
			if ([...s].length > SKILL_LIMIT)
				problems.push(`${b.id}: skill "${s}" is over ${SKILL_LIMIT} chars`);
	}
	return problems;
}

/** Compared against the live profile unless it opts out: an id ending ".alt", or compare="false". */
export const isCompared = (b: Block): boolean =>
	b.attrs["compare"] !== "false" && !b.id.endsWith(".alt");

/**
 * Fold away only what a paste into a browser can change on its own. Quotes
 * and letter case are kept: those are differences you want reported.
 */
export function normalize(s: string): string {
	return s
		.normalize("NFC")
		.replace(/\r\n?/gu, "\n")
		.replaceAll("\u00a0", " ")
		.replace(/[ \t]+$/gmu, "")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}
