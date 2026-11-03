#!/usr/bin/env node
// linkedin-sync: keep a LinkedIn profile in sync with a Markdown record.
//
//   linkedin-sync init                      export, then write linkedin.md from the live profile
//   linkedin-sync export [--connections]    read the live profile into mirror.json
//   linkedin-sync drift [--check-links]     compare the record with the mirror
//   linkedin-sync write <block>...          bring LinkedIn to the record, then prove it
//   linkedin-sync mcp                       the same, as an MCP server on stdio

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { connect } from "./browser.ts";
import { runDrift } from "./drift.ts";
import { Refused } from "./editor.ts";
import {
	exportConnections,
	exportProfile,
	mergeRecent,
	parseCsv,
	writeCsv,
} from "./export.ts";
import { bootstrap } from "./init.ts";
import { serve } from "./mcp.ts";
import { MAX_AGE_DAYS, writeMirror } from "./mirror.ts";
import {
	DEFAULTS,
	DELETE_TYPES,
	deleteEntry,
	type Options,
	projectMedia,
	writeBlocks,
} from "./write.ts";

const USAGE = `usage:
  linkedin-sync init
  linkedin-sync export [--connections [--force | --recent]]
  linkedin-sync drift [--max-age-days N] [--check-links] [--json]
  linkedin-sync write [--dry-run | --noop | --probe] [--json] [--trace] [--no-verify]
                      [--max-age-days N] [--allow-mass-remove] (<block>... | --all-drift)
  linkedin-sync write [--dry-run] --delete <${DELETE_TYPES.join("|")}> <title, name or match> [role=...]
  linkedin-sync write [--dry-run] --add-link <project-block> [--move-legacy-url]
  linkedin-sync write [--dry-run] --remove-media <project-block> <media title> [--kind LINK|IMAGE|...]
  linkedin-sync mcp`;

const Days = z.coerce.number().positive();

async function exportCommand(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		strict: true,
		options: {
			connections: { type: "boolean" },
			force: { type: "boolean" },
			recent: { type: "boolean" },
		},
	});
	const s = await connect();
	try {
		if (!values.connections) {
			writeMirror(await exportProfile(s));
			return 0;
		}
		const path = fileURLToPath(new URL("../connections.csv", import.meta.url));
		if (values.recent) {
			// Only the newest page, merged in: the rest of the file stays as it is.
			const read = await exportConnections(s.api, console.error, 1);
			if (read.length <= 1)
				throw new Refused("no connections read; not changing the file");
			const old = existsSync(path) ? parseCsv(readFileSync(path, "utf8")) : [];
			const merged = mergeRecent(old, read);
			writeCsv(path, merged);
			console.error(`${merged.length - old.length} new connections -> ${path}`);
			return 0;
		}
		const rows = await exportConnections(s.api);
		const before = existsSync(path)
			? readFileSync(path, "utf8").trim().split("\n").length
			: 0;
		// A short read must not overwrite a longer list.
		if (rows.length <= 1)
			throw new Refused("the export returned no connections; not overwriting");
		if (rows.length < before && !values.force)
			throw new Refused(
				`the export returned ${rows.length - 1} connections, the file has ${before - 1}; not overwriting (--force)`,
			);
		writeCsv(path, rows);
		console.error(`${rows.length - 1} connections -> ${path}`);
		return 0;
	} finally {
		await s.close();
	}
}

async function driftCommand(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		strict: true,
		options: {
			"max-age-days": { type: "string" },
			"check-links": { type: "boolean" },
			json: { type: "boolean" },
		},
	});
	const r = await runDrift({
		maxAgeDays: Days.parse(values["max-age-days"] ?? MAX_AGE_DAYS),
		checkLinks: values["check-links"] ?? false,
	});
	if (values.json)
		console.log(JSON.stringify({ code: r.code, results: r.results }));
	else console.log(r.lines.join("\n"));
	return r.code;
}

const WRITE_FLAGS = {
	"dry-run": { type: "boolean" },
	noop: { type: "boolean" },
	probe: { type: "boolean" },
	json: { type: "boolean" },
	trace: { type: "boolean" },
	"no-verify": { type: "boolean" },
	"max-age-days": { type: "string" },
	"allow-mass-remove": { type: "boolean" },
	"all-drift": { type: "boolean" },
	delete: { type: "string" },
	"add-link": { type: "string" },
	"remove-media": { type: "string" },
	kind: { type: "string" },
	"move-legacy-url": { type: "boolean" },
} as const;
type WriteFlags = ReturnType<
	typeof parseArgs<{ options: typeof WRITE_FLAGS }>
>["values"];
const MODES = { "dry-run": "dry", noop: "noop", probe: "probe" } as const;

/** The options a write runs with; conflicting flags are refused. */
function writeOptions(values: WriteFlags): Options {
	const modes = (Object.keys(MODES) as (keyof typeof MODES)[]).filter(
		(k) => values[k],
	);
	if (modes.length > 1)
		throw new Refused(`--${modes.join(" and --")} cannot be combined`);
	const actions = (
		["delete", "add-link", "remove-media", "all-drift"] as const
	).filter((k) => values[k] !== undefined);
	if (actions.length > 1)
		throw new Refused(`--${actions.join(" and --")} cannot be combined`);
	const mode = modes[0] ? MODES[modes[0]] : "save";
	if (
		actions.length &&
		actions[0] !== "all-drift" &&
		(mode === "noop" || mode === "probe")
	)
		throw new Refused(`--${modes[0]} only applies to writing blocks`);
	return {
		...DEFAULTS,
		mode,
		json: values.json ?? false,
		trace: values.trace ?? false,
		verify: !values["no-verify"],
		maxAgeDays: Days.parse(values["max-age-days"] ?? MAX_AGE_DAYS),
		allowMassRemove: values["allow-mass-remove"] ?? false,
	};
}

function writeCommand(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		strict: true,
		allowPositionals: true,
		options: WRITE_FLAGS,
	});
	const o = writeOptions(values);
	if (values.kind !== undefined && values["remove-media"] === undefined)
		throw new Refused("--kind only applies to --remove-media");
	if (values["move-legacy-url"] && values["add-link"] === undefined)
		throw new Refused("--move-legacy-url only applies to --add-link");
	if (values.delete !== undefined) {
		const type = z.enum(DELETE_TYPES).safeParse(values.delete);
		if (!(type.success && positionals.length))
			throw new Refused(
				`--delete takes <${DELETE_TYPES.join("|")}> and what to delete`,
			);
		return deleteEntry(type.data, positionals, o);
	}
	if (values["add-link"] !== undefined)
		return projectMedia(
			values["add-link"],
			{ add: true, moveLegacy: values["move-legacy-url"] ?? false },
			o,
		);
	if (values["remove-media"] !== undefined) {
		const [media, ...extra] = positionals;
		if (!media || extra.length)
			throw new Refused(
				"--remove-media takes <project-block> and one media title",
			);
		return projectMedia(
			values["remove-media"],
			{
				remove: media,
				...(values.kind === undefined ? {} : { kind: values.kind }),
			},
			o,
		);
	}
	return writeBlocks(positionals, values["all-drift"] ?? false, o);
}

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
	init: async () => {
		await bootstrap();
		return 0;
	},
	export: exportCommand,
	drift: driftCommand,
	write: writeCommand,
	mcp: () => {
		serve();
		// Runs until the client closes stdin.
		return new Promise<number>((done) =>
			process.stdin.once("close", () => done(0)),
		);
	},
};

const [command = "", ...rest] = process.argv.slice(2);
const run = COMMANDS[command];
if (!run) {
	console.error(USAGE);
	process.exit(1);
}
try {
	process.exitCode = await run(rest);
} catch (err) {
	// A refusal or a bad flag: nothing was written. Anything else is a crash.
	const known =
		err instanceof Refused ||
		(err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ||
		err instanceof z.ZodError;
	console.error(known ? `${(err as Error).message}\nNothing written.` : err);
	process.exitCode = known ? 1 : 2;
}
