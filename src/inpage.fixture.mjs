#!/usr/bin/env node

// The in-page writers against local editors that behave the way LinkedIn's
// do where timing matters: a dialog that opens as a shell and fills a beat
// later, saved values that arrive after their controls, a "Discard" prompt
// that renders late, a control an earlier step reveals, and controls with no
// label. Each case runs through the real MCP server (an isolated, headless,
// throwaway browser; never the LinkedIn profile or the shared Chrome), so the
// functions travel as source text exactly as they do in a write, and each
// must pass its check and finish inside a time budget. The budgets are what
// stop a fixed pause, or a wait on a control that is not there, from coming
// back.
//
//   node src/inpage.fixture.mjs    exits 1 on a failed case; 0 with a note if
//                                  there is no Chrome to run them in

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import {
	describeDialog,
	fillDialog,
	fillForm,
	removeProjectMedia,
} from "./inpage.mjs";
import { startMcp } from "./mcp.mjs";

const CHROME =
	process.env.LINKEDIN_CHROME_BIN ||
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (process.env.LINKEDIN_SKIP_BROWSER_TESTS === "1" || !existsSync(CHROME)) {
	console.log("in-page fixtures: skipped (no Chrome to run them in)");
	process.exit(0);
}

// One editor page. `?kind=intro` is a contenteditable dialog; `?kind=form` a
// labelled form. Every delay is one LinkedIn has been seen to have, or longer.
const PAGE = `<!doctype html><meta charset="utf-8"><title>fixture</title>
<body><script>
const kind = new URLSearchParams(location.search).get("kind");
const later = (ms, f) => setTimeout(f, ms);
const el = (h) => { const t = document.createElement("template"); t.innerHTML = h.trim(); return t.content.firstChild; };
later(250, () => {
  const d = el('<div role="dialog" aria-modal="true"><h2></h2><div class="body"></div><button aria-label="Dismiss">x</button><button>Save</button></div>');
  document.body.append(d);
  const body = d.querySelector(".body");
  let initial = "";
  // Shell first, contents a beat later.
  later(300, () => {
    if (kind === "intro") {
      d.querySelector("h2").textContent = "Edit intro";
      body.append(el('<div contenteditable="true"></div>'));
      // Ten controls with no label at all: the probe must not wait on each.
      for (let i = 0; i < 10; i++) body.append(el('<input type="text" value="x">'));
      // The saved value arrives after its control.
      later(400, () => { body.querySelector("[contenteditable]").innerText = initial = "Old headline"; });
    } else {
      d.querySelector("h2").textContent = "Edit education";
      body.append(el('<label for="s">School*</label>'), el('<input id="s">'));
      body.append(el('<label for="g">Degree</label>'), el('<input id="g">'));
      body.append(el('<input type="checkbox" id="c" checked>'), el('<label for="c">I am currently studying</label>'));
      later(400, () => { d.querySelector("#s").value = initial = "Uni"; d.querySelector("#g").value = "BSc"; });
      // Unticking "current" reveals the end year, a moment later.
      d.querySelector("#c").addEventListener("change", (e) => {
        if (!e.target.checked) later(300, () => {
          body.append(el('<label for="e">End year</label>'), el('<select id="e"><option>-</option><option>2016</option><option>2017</option></select>'));
        });
      });
    }
  });
  const value = () => kind === "intro" ? d.querySelector("[contenteditable]").innerText : d.querySelector("#g").value;
  d.querySelector('[aria-label="Dismiss"]').onclick = () => {
    if (value() === (kind === "intro" ? initial : "BSc")) return d.remove();
    // The prompt renders late, as LinkedIn's does.
    later(400, () => {
      const p = el('<div role="alertdialog"><button>Discard</button></div>');
      p.querySelector("button").onclick = () => { p.remove(); d.remove(); };
      document.body.append(p);
    });
  };
  d.querySelector("button:last-child").onclick = async () => {
    await fetch("/save", { method: "POST", body: value() });
    d.remove();
  };
});
</script>`;

// A project editor shaped like LinkedIn's (probe 2026-10-30): media items as
// "Edit media, <title>" links, each opening an "Edit media" dialog whose
// Delete asks for confirmation, then the project editor back without it.
const MEDIA_PAGE = `<!doctype html><meta charset="utf-8"><title>fixture</title>
<body><script>
const el = (h) => { const t = document.createElement("template"); t.innerHTML = h.trim(); return t.content.firstChild; };
const items = ["Live site", "Old repo"];
const d = el('<div role="dialog"><h2>Edit project</h2><label for="n">Project name*</label><input id="n"><div class="m"></div><button aria-label="Dismiss">x</button><button class="save">Save</button></div>');
document.body.append(d);
setTimeout(() => { d.querySelector("#n").value = "Fixture Project"; }, 300);
let dirty = false;
const draw = () => {
  const m = d.querySelector(".m"); m.innerHTML = "";
  for (const t of items) {
    const a = el('<a href="#"><div></div></a>'); a.firstChild.textContent = "Edit media, " + t;
    a.onclick = (e) => { e.preventDefault(); later(() => openMedia(t)); };
    m.append(a);
  }
};
const later = (f) => setTimeout(f, 300);
const openMedia = (t) => {
  const md = el('<div role="dialog"><h2>Edit media</h2><input><button aria-label="Dismiss">x</button><button class="del">Delete</button><button>Back</button><button>Save</button></div>');
  md.querySelector("input").value = t;
  md.querySelector('[aria-label="Dismiss"]').onclick = () => md.remove();
  md.querySelector(".del").onclick = () => later(() => {
    const c = el('<div role="alertdialog"><h2>Delete media?</h2><button class="yes">Delete</button><button>Cancel</button></div>');
    c.querySelector(".yes").onclick = () => { c.remove(); md.remove(); later(() => { items.splice(items.indexOf(t), 1); dirty = true; draw(); }); };
    document.body.append(c);
  });
  document.body.append(md);
};
draw();
d.querySelector('[aria-label="Dismiss"]').onclick = () => d.remove();
d.querySelector(".save").onclick = async () => {
  await fetch("/save", { method: "POST", body: "media:" + items.join("|") });
  d.remove();
};
</script>`;

const saves = [];
const server = createServer((req, res) => {
	if (req.method === "POST") {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			// The save answers slowly: the call must still see it land.
			setTimeout(() => {
				saves.push(body);
				res.end("ok");
			}, 300);
		});
		return;
	}
	res.setHeader("content-type", "text/html");
	res.end(req.url.includes("kind=media") ? MEDIA_PAGE : PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const mcp = startMcp({ clientName: "linkedin-fixtures", isolated: true });
let failed = 0;
const check = (name, ok, detail) => {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `: ${detail}`}`);
};
// Time one in-page call, navigation included, the way a write makes it.
async function timed(kind, fn, args) {
	await mcp.callTool(
		"browser_navigate",
		{ url: `${base}?kind=${kind}` },
		30000,
	);
	const t0 = performance.now();
	const out = JSON.parse(await mcp.runFn(fn, args, 60000));
	return { out, secs: (performance.now() - t0) / 1000 };
}

try {
	await mcp.init();

	{
		const { out, secs } = await timed("intro", describeDialog, { shot: null });
		const ce = out.controls?.find((c) => c.editable === "true");
		check(
			"describeDialog waits for the late value",
			ce?.valueHead === "Old headline",
			JSON.stringify(ce),
		);
		check(
			"describeDialog reads the heading",
			out.heading === "Edit intro",
			out.heading,
		);
		// Before: 1.3s of fixed pauses plus 0.8s per missing label lookup,
		// three per unlabelled control (about 25s for these ten).
		check(
			`describeDialog with ten unlabelled controls in ${secs.toFixed(1)}s (budget 4s)`,
			secs < 4,
			`${secs.toFixed(1)}s`,
		);
	}

	const intro = (mode) => ({
		control: '[contenteditable="true"]',
		text: "New headline",
		mode,
		shot: null,
		title: null,
		titleLabel: null,
		notifySwitch: false,
		dates: null,
		dateLabels: null,
		extra: null,
		editing: true,
		monthNames: [],
	});
	{
		// Describe first, as a write does, so the value has landed.
		await timed("intro", describeDialog, { shot: null });
		const t0 = performance.now();
		const out = JSON.parse(await mcp.runFn(fillDialog, intro("dry"), 60000));
		const secs = (performance.now() - t0) / 1000;
		check("dry run reads back as desired", out.matches === true, out.after);
		check(
			"dry run answers the late Discard prompt",
			out.dialogGone === true,
			JSON.stringify(out),
		);
		check("dry run saves nothing", saves.length === 0, saves);
		check(
			`dry run fill in ${secs.toFixed(1)}s (budget 3s)`,
			secs < 3,
			`${secs.toFixed(1)}s`,
		);
	}
	{
		await timed("intro", describeDialog, { shot: null });
		const t0 = performance.now();
		const out = JSON.parse(await mcp.runFn(fillDialog, intro("save"), 60000));
		const secs = (performance.now() - t0) / 1000;
		check(
			"save reads back, saves and closes",
			out.matches === true && out.dialogGone === true,
			JSON.stringify(out),
		);
		// The call returns only once the save request it started has answered.
		check(
			"save has landed when the call returns",
			saves.at(-1) === "New headline",
			JSON.stringify(saves),
		);
		check(
			`save in ${secs.toFixed(1)}s (budget 3s)`,
			secs < 3,
			`${secs.toFixed(1)}s`,
		);
	}
	{
		const { out, secs } = await timed("form", fillForm, {
			steps: [
				{ kind: "text", pattern: "^Degree$", value: "MSc" },
				{
					kind: "checkbox",
					pattern: "^I am currently studying$",
					value: false,
				},
				{ kind: "select", pattern: "^End year$", option: "2017" },
			],
			// Identity: the saved School arrives after its control does.
			expect: [{ pattern: "^School\\*?$", value: "Uni" }],
			heading: "education",
			mode: "dry",
			shot: null,
		});
		check(
			"fillForm waits for the identity value instead of refusing",
			!out.error,
			out.error,
		);
		check(
			"fillForm fills a control an earlier step revealed",
			out.ok === true,
			JSON.stringify(out.results),
		);
		check(
			"fillForm dry run discards",
			out.dialogGone === true,
			JSON.stringify(out),
		);
		check(
			`fillForm in ${secs.toFixed(1)}s (budget 5s)`,
			secs < 5,
			`${secs.toFixed(1)}s`,
		);
	}
	{
		// The wrong entry is still refused, after the wait, not before.
		const { out } = await timed("form", fillForm, {
			steps: [{ kind: "text", pattern: "^Degree$", value: "MSc" }],
			expect: [{ pattern: "^School\\*?$", value: "Another Uni" }],
			heading: "education",
			mode: "dry",
			shot: null,
		});
		check(
			"fillForm still refuses the wrong entry",
			/the wrong entry/.test(out.error ?? ""),
			JSON.stringify(out),
		);
	}
	{
		const args = (dryRun, media = "Old repo") => ({
			title: "Fixture Project",
			media,
			dryRun,
			shot: null,
		});
		const dry = await timed("media", removeProjectMedia, args(true));
		check(
			"removeProjectMedia dry run reaches Delete and saves nothing",
			dry.out.wouldClick === "Delete" &&
				!saves.some((x) => x.startsWith("media:")),
			JSON.stringify(dry.out),
		);
		const wrong = await timed("media", removeProjectMedia, args(true, "Nope"));
		check(
			"removeProjectMedia refuses an item that is not there",
			/0 media items/.test(wrong.out.error ?? ""),
			JSON.stringify(wrong.out),
		);
		const real = await timed("media", removeProjectMedia, args(false));
		check(
			"removeProjectMedia confirms, saves the project without the item",
			real.out.dialogGone === true &&
				real.out.confirmed === true &&
				saves.at(-1) === "media:Live site",
			JSON.stringify({ out: real.out, saves }),
		);
	}
} catch (err) {
	failed++;
	console.log(`FAIL  fixture run: ${err.message}`);
} finally {
	try {
		await mcp.callTool("browser_close", {}, 5000);
	} catch {}
	mcp.close();
	server.close();
}
console.log(
	failed
		? `\n${failed} in-page fixture failure(s)`
		: "\nin-page fixtures: the writers wait for what they need and nothing else",
);
process.exit(failed ? 1 : 0);
