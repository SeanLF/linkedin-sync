// The agent surface: export, drift and write as MCP tools on stdio. Each
// calls the same function the CLI does; the log comes back as text and the
// write events as structured content. A write here is as real as one from
// the CLI, so it defaults to a dry run unless the caller says save.

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { connect } from "./browser.ts";
import { runDrift } from "./drift.ts";
import { Refused } from "./editor.ts";
import { exportProfile } from "./export.ts";
import { MAX_AGE_DAYS, writeMirror } from "./mirror.ts";
import { DEFAULTS, writeBlocks } from "./write.ts";

const text = (s: string, isError = false) => ({
	content: [{ type: "text" as const, text: s }],
	isError,
});

function build(): McpServer {
	const server = new McpServer({ name: "linkedin-sync", version: "0.2.0" });

	server.registerTool(
		"export",
		{
			description:
				"Read the live LinkedIn profile into the mirror (mirror.json). Run before drift or write.",
			inputSchema: z.object({}),
		},
		async () => {
			const s = await connect();
			try {
				const m = await exportProfile(s, () => undefined);
				writeMirror(m);
				return text(
					`exported at ${m.exportedAt}${m.warnings ? `; warnings: ${m.warnings.join("; ")}` : ""}`,
				);
			} finally {
				await s.close();
			}
		},
	);

	server.registerTool(
		"drift",
		{
			description:
				"Compare the record (linkedin.md) with the mirror. Exit code 0 clean, 1 stale, 2 unreadable or too old to judge.",
			inputSchema: z.object({
				maxAgeDays: z.number().positive().default(MAX_AGE_DAYS),
			}),
		},
		async ({ maxAgeDays }) => {
			const r = await runDrift({ maxAgeDays, checkLinks: false });
			return {
				...text(r.lines.join("\n"), r.code === 2),
				structuredContent: { code: r.code, results: r.results },
			};
		},
	);

	server.registerTool(
		"write",
		{
			description:
				"Bring LinkedIn to the record for the named blocks (or every stale one), then re-export and compare. mode defaults to dry (fill and discard); save writes for real.",
			inputSchema: z.object({
				blocks: z.array(z.string()).default([]),
				allDrift: z.boolean().default(false),
				mode: z.enum(["dry", "save", "probe"]).default("dry"),
			}),
		},
		async ({ blocks, allDrift, mode }) => {
			const log: string[] = [];
			const events: object[] = [];
			try {
				const code = await writeBlocks(blocks, allDrift, {
					...DEFAULTS,
					mode,
					sink: { say: (s) => log.push(s), emit: (e) => events.push(e) },
				});
				return {
					...text(log.join("\n"), code !== 0),
					structuredContent: { code, events },
				};
			} catch (err) {
				if (!(err instanceof Refused)) throw err;
				return text(`${err.message}\nNothing written.`, true);
			}
		},
	);

	return server;
}

export function serve(): void {
	serveStdio(build);
}
