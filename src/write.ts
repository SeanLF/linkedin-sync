// Bring LinkedIn to the record, one editor at a time, and prove it.
//
// The safety rules live here, before any browser opens or any Save:
//  - an editor must show the entry it was opened for (editor.ts checks);
//  - nothing is created from a mirror that is partial, too old, or older
//    than the last write: "not in the mirror" is how a duplicate gets made;
//  - --noop re-saves what is there and never creates;
//  - skills: adds first, and any failed add cancels every delete;
//  - "Too many attempts" (or a checkpoint) stops the whole run.
// After any real save the profile is exported again and every field compared:
// the "saved" line is never the proof.

import { tmpdir } from "node:os";
import process from "node:process";
import {
	connect,
	openProfilePath,
	type Session,
	StopError,
} from "./browser.ts";
import { compared, compareField, staleFields, staleMirror } from "./drift.ts";
import {
	type Mode,
	Refused,
	runAddLink,
	runAddSkill,
	runDelete,
	runEditor,
	runRemoveMedia,
} from "./editor.ts";
import { exportProfile } from "./export.ts";
import {
	deleteEditor,
	type Editor,
	escapeRe,
	type Field,
	type FormType,
	fieldFor,
	identityAttr,
	planSkills,
} from "./fields.ts";
import {
	entities,
	type LastWrite,
	MAX_AGE_DAYS,
	type Mirror,
	readLastWrite,
	readMirror,
	recordWrite,
	writeMirror,
} from "./mirror.ts";
import { type Block, overLimit, readRecord, skillList } from "./record.ts";

export interface Options {
	mode: Mode;
	json: boolean;
	trace: boolean;
	verify: boolean;
	maxAgeDays: number;
	allowMassRemove: boolean;
	/** Where the log and the events go instead of the console (the MCP server captures them). */
	sink?: { say: (s: string) => void; emit: (e: object) => void };
}
export const DEFAULTS: Options = {
	mode: "save",
	json: false,
	trace: false,
	verify: true,
	maxAgeDays: MAX_AGE_DAYS,
	allowMassRemove: false,
};

/** 0 ok, 1 refused or not as the record, 2 broken (a crash, a stop, an unreadable read). */
type Code = 0 | 1 | 2;

/** Where the human log goes: stderr under --json, so stdout is only JSON lines. */
const sayer = (o: Options) =>
	o.sink?.say ??
	(o.json
		? (s: string) => process.stderr.write(`${s}\n`)
		: (s: string) => console.log(s));
const emitter = (o: Options) =>
	o.sink?.emit ??
	(o.json
		? (e: object) => process.stdout.write(`${JSON.stringify(e)}\n`)
		: () => undefined);
const saving = (o: Options) => o.mode === "save" || o.mode === "noop";

/** A create is refused unless the mirror is fresh and newer than the last write (prior: read before this run records its own). */
export function assertFreshForCreate(
	m: Mirror,
	what: string,
	prior: LastWrite | undefined,
	maxAgeDays: number,
): void {
	const old = staleMirror(m, maxAgeDays);
	if (old)
		throw new Refused(
			`${what} is not in the mirror, but ${old}; re-export before creating it`,
		);
	if (prior && Date.parse(prior.at) > Date.parse(m.exportedAt))
		throw new Refused(
			`${what} is not in the mirror, but the mirror (${m.exportedAt}) predates the last write (${prior.at}); an entry created since reads as absent. Re-export first.`,
		);
}

/** The skills plan, refused when it looks like a truncated block. */
export function skillsPlan(m: Mirror, text: string, allowMassRemove: boolean) {
	const live = entities(m, "skills");
	const want = skillList(text);
	if (!want.length)
		throw new Refused(
			"the skills block is empty; refusing to delete every skill (use --delete skill, one at a time)",
		);
	const plan = planSkills(
		live.map((s) => s.name),
		want,
	);
	const remove = live.filter((s) => plan.remove.includes(s.name));
	const cap = Math.max(5, Math.floor(live.length / 4));
	if (remove.length > cap && !allowMassRemove)
		throw new Refused(
			`refusing to delete ${remove.length} skills (more than ${cap}); if the list is right, rerun with --allow-mass-remove`,
		);
	return { ...plan, remove };
}

interface Run {
	s: Session;
	m: Mirror;
	prior: LastWrite | undefined;
	o: Options;
	say: (s: string) => void;
}

async function openEditor(run: Run, ed: Editor): Promise<void> {
	run.say(
		`  ${ed.creating ? "creating" : "editing"}: ${await openProfilePath(run.s, ed.path)}`,
	);
}

async function writeSkills(run: Run, b: Block): Promise<Code> {
	const { m, o, say, s } = run;
	const plan = skillsPlan(m, b.text, o.allowMassRemove);
	say(`  skills: add ${plan.add.length}, remove ${plan.remove.length}`);
	for (const c of plan.recase)
		say(
			`  = ${c.record}: LinkedIn spells it ${JSON.stringify(c.live)}; fix the record (no write for case)`,
		);
	if (plan.add.length && o.mode !== "probe")
		assertFreshForCreate(
			m,
			`skills ${plan.add.join(", ")}`,
			run.prior,
			o.maxAgeDays,
		);
	if (o.mode === "probe") return 0;
	const failed: string[] = [];
	for (const skill of plan.add) {
		await openProfilePath(s, "skills/edit/forms/new/");
		try {
			const picked = await runAddSkill(s.page, skill, o.mode === "dry");
			say(
				`  + ${skill}${o.mode === "dry" ? " (would add)" : ""}${picked === skill ? "" : `; LinkedIn spells it ${JSON.stringify(picked)}, fix the record`}`,
			);
		} catch (err) {
			if (!(err instanceof Refused)) throw err;
			failed.push(skill);
			say(`  + ${skill}: ${err.message}`);
		}
	}
	if (failed.length && plan.remove.length)
		throw new Refused(
			`${failed.length} add(s) failed, so none of the ${plan.remove.length} delete(s) ran: a rename whose add failed would lose the skill`,
		);
	for (const skill of plan.remove) {
		await openProfilePath(s, `details/skills/edit/forms/${skill.id}/`);
		const ed = skillEditor(skill.name);
		say(
			`  - ${skill.name}: ${await runDelete(s.page, ed, "Delete skill", o.mode === "dry")}`,
		);
	}
	return failed.length ? 1 : 0;
}

const skillEditor = (name: string): Editor => ({
	path: "",
	creating: false,
	// The skill editor's heading is "Edit <skill>": that is its identity check.
	heading: new RegExp(`^Edit ${escapeRe(name)}$`, "iu"),
	identity: [],
	steps: [],
	notify: "if-present",
});

async function writeField(run: Run, f: Field, b: Block): Promise<Code> {
	if (b.type === "skills") return writeSkills(run, b);
	if (!f.editor) throw new Refused(`${f.id} has no editor`);
	const ed = f.editor(run.m);
	if (ed.creating && run.o.mode === "noop")
		throw new Refused(
			`${f.id} is not on LinkedIn; --noop re-saves, it never creates`,
		);
	if (ed.creating && run.o.mode !== "probe")
		assertFreshForCreate(run.m, f.label, run.prior, run.o.maxAgeDays);
	await openEditor(run, ed);
	const filled = await runEditor(run.s.page, ed, run.o.mode);
	for (const r of filled.results)
		run.say(
			`  ${r.ok ? "ok " : "BAD"} ${r.control.padEnd(34)} ${r.ok ? "" : `want ${JSON.stringify(r.want)} got ${JSON.stringify(r.got)}`}`.trimEnd(),
		);
	run.say(`  ${filled.outcome}`);
	return filled.ok ? 0 : 1;
}

/** Run `fn` on one attached Chrome, with a Playwright trace kept for each failing step. */
async function session<T>(
	o: Options,
	fn: (s: Session, step: Step) => Promise<T>,
): Promise<T> {
	const s = await connect();
	await s.context.tracing.start({ screenshots: true, snapshots: true });
	const say = sayer(o);
	const step: Step = async (label, body) => {
		await s.context.tracing.startChunk({ title: label });
		let code: Code;
		try {
			code = await body();
		} catch (err) {
			if (err instanceof StopError) throw err;
			say(`  FAILED: ${(err as Error).message}`);
			code = err instanceof Refused ? 1 : 2;
		}
		const path = `${tmpdir()}/linkedin-${label.replace(/[^\w.-]+/gu, "_")}.zip`;
		if (code || o.trace) {
			await s.context.tracing.stopChunk({ path });
			say(`  trace: npx playwright show-trace ${path}`);
		} else await s.context.tracing.stopChunk();
		return code;
	};
	try {
		return await fn(s, step);
	} finally {
		await s.context.tracing.stop().catch(() => undefined);
		await s.close().catch(() => undefined);
	}
}
type Step = (label: string, body: () => Promise<Code>) => Promise<Code>;

/** After a real write: export again, compare every field. 0 clean, 1 stale, 2 broken. */
async function verify(o: Options, recordPath?: string): Promise<Code> {
	const say = sayer(o);
	const emit = emitter(o);
	say(
		"\nVerifying: re-exporting the profile and comparing every field (--no-verify skips this)",
	);
	let m: Mirror;
	try {
		const s = await connect();
		try {
			m = await exportProfile(s, say);
		} finally {
			await s.close();
		}
		writeMirror(m);
	} catch (err) {
		say(
			`Verify: the export failed (${(err as Error).message}); nothing is proven.`,
		);
		emit({ event: "verify", ok: false, code: 2, error: "export failed" });
		return 2;
	}
	const fields = compared(readRecord(recordPath));
	const off = fields
		.flatMap((f) => compareField(f, m))
		.filter(
			(r) =>
				r.verdict === "drift" ||
				r.verdict === "absent" ||
				r.verdict === "unreadable",
		);
	const unreadable = off
		.filter((r) => r.verdict === "unreadable")
		.map((r) => r.id);
	const stale = off.filter((r) => r.verdict !== "unreadable").map((r) => r.id);
	say(
		`Verify (mirror ${m.exportedAt}): ${fields.length} blocks, ${stale.length} stale, ${unreadable.length} unreadable`,
	);
	for (const r of off)
		say(
			`  ${r.verdict.toUpperCase().padEnd(10)} ${r.id}${r.unwritten ? "  (not written by write <id>)" : ""}`,
		);
	let code: Code = stale.length ? 1 : 0;
	if (unreadable.length) code = 2;
	emit({
		event: "verify",
		ok: code === 0,
		code,
		mirror: m.exportedAt,
		stale,
		unreadable,
	});
	return code;
}

/** What --all-drift adds: every stale block, from a mirror fresh enough and newer than the last write. */
export function driftIds(
	fields: Field[],
	m: Mirror,
	prior: LastWrite | undefined,
	o: Options,
): string[] {
	const old = staleMirror(m, o.maxAgeDays);
	if (old) throw new Refused(`--all-drift: ${old}; re-export first`);
	if (prior && Date.parse(prior.at) > Date.parse(m.exportedAt))
		throw new Refused(
			`--all-drift: the mirror (${m.exportedAt}) predates the last write (${prior.at}); re-export first`,
		);
	const { stale, unwritten, unreadable } = staleFields(fields, m);
	if (unreadable.length)
		throw new Refused(
			`--all-drift: drift cannot read ${unreadable.join(", ")}; run drift and fix that first`,
		);
	if (unwritten.length)
		sayer(o)(
			`--all-drift leaves ${unwritten.join(", ")} (a link is --add-link; media is LinkedIn's preview)`,
		);
	return stale;
}

/** Write the named blocks (and, with allDrift, every stale one) in one session. Returns the exit code. */
export async function writeBlocks(
	ids: string[],
	allDrift: boolean,
	o: Options,
	recordPath?: string,
): Promise<Code> {
	const say = sayer(o);
	const emit = emitter(o);
	const blocks = readRecord(recordPath);
	const fields = new Map(compared(blocks).map((f) => [f.id, f]));
	const prior = readLastWrite();
	const m = readMirror();
	const all = [
		...new Set([
			...ids,
			...(allDrift ? driftIds([...fields.values()], m, prior, o) : []),
		]),
	];
	if (!all.length) {
		say(
			allDrift
				? "Nothing stale; nothing to write."
				: "Name at least one block, or --all-drift.",
		);
		return allDrift ? 0 : 1;
	}
	const unknown = all.filter((id) => !fields.has(id));
	if (unknown.length)
		throw new Refused(
			`unknown block(s) ${unknown.join(", ")}; known: ${[...fields.keys()].join(", ")}`,
		);
	const problems = all.flatMap((id) =>
		blocks.get(id) ? overLimit(blocks.get(id) as Block) : [],
	);
	if (problems.length)
		throw new Refused(
			`over LinkedIn's limits; nothing written:\n  ${problems.join("\n  ")}`,
		);
	const textOnly = ["headline", "about", "position", "project"];
	const notText = all.filter(
		(id) => !textOnly.includes(fields.get(id)?.type ?? ""),
	);
	// A re-save of a section form can shift what it shows (the publication date box moves a day).
	if (o.mode === "noop" && notText.length)
		throw new Refused(
			`--noop is for headline, about, positions and projects, not ${notText.join(", ")}`,
		);
	if (saving(o)) recordWrite(all);

	const results: { id: string; code: Code; secs: number }[] = [];
	await session(o, async (s, step) => {
		const run: Run = { s, m, prior, o, say };
		for (const [i, id] of all.entries()) {
			const done = results.reduce((t, r) => t + r.secs, 0);
			const failed = results.filter((r) => r.code).length;
			say(
				`\n=== [${i + 1}/${all.length}] ${id} | ${i - failed} ok, ${failed} failed${i ? ` | ETA ${Math.round((done / i) * (all.length - i))}s` : ""}`,
			);
			const t0 = performance.now();
			let code: Code;
			try {
				code = await step(`${o.mode}-${id}`, () =>
					writeField(run, fields.get(id) as Field, blocks.get(id) as Block),
				);
			} catch (err) {
				// A stop: this field and every one after it fail, and the summary still comes.
				say(`  STOPPED: ${(err as Error).message}`);
				for (const rest of all.slice(i))
					results.push({ id: rest, code: 2, secs: 0 });
				break;
			}
			const secs = (performance.now() - t0) / 1000;
			results.push({ id, code, secs });
			say(
				`  ${id}: ${code ? `FAILED (${code})` : "ok"} in ${secs.toFixed(1)}s`,
			);
			emit({
				event: "field",
				id,
				mode: o.mode,
				ok: !code,
				code,
				secs: Number(secs.toFixed(2)),
				n: i + 1,
				total: all.length,
			});
		}
	}).catch((err: unknown) => {
		// Chrome would not attach, or died: what did not run is a failure, and the summary still comes.
		say(`\nFailed: ${(err as Error).message}`);
		for (const id of all.filter((x) => !results.some((r) => r.id === x)))
			results.push({ id, code: 2, secs: 0 });
	});
	const worst = Math.max(0, ...results.map((r) => r.code)) as Code;
	const total = results.reduce((t, r) => t + r.secs, 0);
	if (all.length > 1) {
		say(`\n${results.length} fields in ${total.toFixed(1)}s:`);
		for (const r of results)
			say(
				`  ${(r.code ? `FAIL(${r.code})` : "ok").padEnd(8)} ${r.id.padEnd(40)} ${r.secs.toFixed(1)}s`,
			);
	}
	emit({
		event: "batch",
		mode: o.mode,
		code: worst,
		ok: results.filter((r) => !r.code).map((r) => r.id),
		failed: results.filter((r) => r.code).map((r) => r.id),
		secs: Number(total.toFixed(2)),
	});
	if (saving(o) && o.verify)
		return Math.max(worst, await verify(o, recordPath)) as Code;
	return worst;
}

export type DeleteType = FormType | "project" | "skill";
export const DELETE_TYPES: DeleteType[] = [
	"education",
	"honor",
	"publication",
	"volunteer",
	"certification",
	"project",
	"skill",
];

/** Find the live entry a --delete names: bare words are the type's identity; key=value pairs set others (role=...). */
export function deleteTarget(
	type: DeleteType,
	words: string[],
	m: Mirror,
): { ed: Editor; button: string } {
	if (type === "skill") {
		const name = words.join(" ");
		const hits = entities(m, "skills").filter((x) => x.name === name);
		if (hits.length !== 1 || !hits[0])
			throw new Refused(
				`${hits.length} live skills are named ${JSON.stringify(name)}`,
			);
		return {
			ed: {
				...skillEditor(name),
				path: `details/skills/edit/forms/${hits[0].id}/`,
			},
			button: "Delete skill",
		};
	}
	const key = type === "project" ? "title" : identityAttr(type);
	const attrs: Record<string, string> = {};
	const bare: string[] = [];
	for (const w of words) {
		const kv = /^([a-z]+)=(.*)$/su.exec(w);
		if (kv?.[1] === undefined) bare.push(w);
		else attrs[kv[1]] = kv[2] ?? "";
	}
	if (bare.length) attrs[key] = bare.join(" ");
	const ed = deleteEditor(type, attrs, m);
	return { ed, button: ed.deleteButton ?? "Delete" };
}

/** Delete one live entry the record no longer carries. */
export async function deleteEntry(
	type: DeleteType,
	words: string[],
	o: Options,
	recordPath?: string,
): Promise<Code> {
	const m = readMirror();
	const { ed, button } = deleteTarget(type, words, m);
	if (o.mode === "save") recordWrite([`--delete ${type} ${words.join(" ")}`]);
	const code = await session(o, (s, step) =>
		step(`${o.mode}-delete`, async () => {
			sayer(o)(`Opening ${await openProfilePath(s, ed.path)}`);
			sayer(o)(`  ${await runDelete(s.page, ed, button, o.mode !== "save")}`);
			return 0;
		}),
	);
	return o.mode === "save" && o.verify
		? (Math.max(code, await verify(o, recordPath)) as Code)
		: code;
}

/** Attach a project block's link= as media, or remove one media item by title. */
export async function projectMedia(
	id: string,
	action: { add: true } | { remove: string },
	o: Options,
	recordPath?: string,
): Promise<Code> {
	const blocks = readRecord(recordPath);
	const b = blocks.get(id);
	const f = b && fieldFor(b);
	if (!f?.project) throw new Refused(`${id} is not a project block`);
	const m = readMirror();
	const ed = f.editor?.(m);
	if (!ed || ed.creating)
		throw new Refused(
			`"${f.project.title}" is not on LinkedIn yet; write the project first`,
		);
	const { title, link } = f.project;
	if ("add" in action) {
		if (!link) throw new Refused(`${id} has no link="..."`);
		if (f.project.urls(m).includes(link)) {
			sayer(o)(`${link} is already on "${title}"; nothing to add`);
			return 0;
		}
		// Adding a media item is a create: a rerun after a crash would add it twice.
		assertFreshForCreate(
			m,
			`${link} on "${title}"`,
			readLastWrite(),
			o.maxAgeDays,
		);
	}
	const dry = o.mode !== "save";
	if (!dry)
		recordWrite([`${"add" in action ? "--add-link" : "--remove-media"} ${id}`]);
	const code = await session(o, (s, step) =>
		step(`${o.mode}-media`, async () => {
			await openProfilePath(s, ed.path);
			const out =
				"add" in action
					? await runAddLink(s.page, title, link ?? "", dry)
					: await runRemoveMedia(s.page, title, action.remove, dry);
			sayer(o)(`  ${out}`);
			return 0;
		}),
	);
	return !dry && o.verify
		? (Math.max(code, await verify(o, recordPath)) as Code)
		: code;
}
