#!/usr/bin/env node

// Each inpage.mjs function travels to the browser as source text, so it must
// not name anything outside its own body. Biome's noUndeclaredVariables (on
// for that file) catches a name declared nowhere in it; this catches the two
// things it cannot: a top-level declaration other than an exported function,
// and one exported function naming another.
//
//   node src/inpage.check.mjs    exits 1 on any violation, and on a fixture
//                                that should have been caught and was not

import { readFileSync } from "node:fs";
import * as inpage from "./inpage.mjs";

const source = readFileSync(new URL("./inpage.mjs", import.meta.url), "utf8");

export function violations(src, fns) {
	const found = [];
	for (const line of src.split("\n"))
		if (/^(const|let|var|function|class|async)\b/.test(line))
			found.push(`top-level declaration that will not travel: ${line.trim()}`);
	const names = Object.keys(fns);
	for (const [name, fn] of Object.entries(fns)) {
		const body = String(fn);
		if (typeof fn !== "function" || !/^async \(\s*page\b/.test(body))
			found.push(`${name} is not an async (page, args) function`);
		for (const other of names)
			if (other !== name && new RegExp(`\\b${other}\\b`).test(body))
				found.push(`${name} names ${other}, which does not travel with it`);
		try {
			new Function(`return (${body})`);
		} catch (e) {
			found.push(`${name} does not compile on its own: ${e.message}`);
		}
	}
	return found;
}

const fixtures = [
	[
		"a sibling reference",
		"",
		{ a: async (page) => b(page), b: async (page) => page },
	],
	["a top-level constant", "const SEL = 'x';\n", { a: async (page) => page }],
	["a non-function export", "", { a: "async (page) => page" }],
];

let failed = 0;
for (const [name, src, fns] of fixtures) {
	const caught = violations(src, fns).length > 0;
	if (!caught) failed++;
	console.log(`${caught ? "ok  " : "FAIL"}  fixture: ${name} is caught`);
}
const real = violations(source, inpage);
for (const v of real) console.log(`FAIL  ${v}`);
failed += real.length;
console.log(
	failed
		? `\n${failed} in-page check failure(s)`
		: `\nin-page check: ${Object.keys(inpage).length} functions are self-contained`,
);
process.exit(failed ? 1 : 0);
