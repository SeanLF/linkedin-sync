// One Chrome, signed into LinkedIn once by hand, that every command attaches
// to over CDP. Never a scripted login: that walks into LinkedIn's
// app-approval checkpoint and then "Too many attempts". Chrome is started
// plainly (not by Playwright's launcher) so the page carries no automation
// flags, and it stays open between commands.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import process from "node:process";
import {
	type APIRequestContext,
	type BrowserContext,
	chromium,
	expect,
	type Page,
} from "@playwright/test";
import { z } from "zod";

const PORT = Number(process.env["LINKEDIN_CDP_PORT"] ?? 9333);
const PROFILE = `${homedir()}/Library/Caches/ms-playwright/mcp-chrome-linkedin-cdp`;
const CHROME =
	process.env["LINKEDIN_CHROME_BIN"] ??
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ORIGIN = "https://www.linkedin.com";

/** LinkedIn said stop. Nothing more runs in this session; retrying makes it worse. */
export class StopError extends Error {}

const alive = () =>
	fetch(`http://127.0.0.1:${PORT}/json/version`).then(
		(r) => r.ok,
		() => false,
	);

/** Start the persistent Chrome if it is not running. Visible unless LINKEDIN_HEADLESS=1. */
async function ensureChrome(): Promise<void> {
	if (await alive()) return;
	const headless = process.env["LINKEDIN_HEADLESS"] === "1";
	spawn(
		CHROME,
		[
			...(headless ? ["--headless=new"] : []),
			`--remote-debugging-port=${PORT}`,
			`--user-data-dir=${PROFILE}`,
			// The profile was created with a mock keychain; without it Chrome
			// cannot decrypt its own cookies and drops the session.
			"--use-mock-keychain",
			"--no-first-run",
			"--no-default-browser-check",
			"--window-size=1400,1000",
		],
		{ detached: true, stdio: "ignore" },
	).unref();
	await expect
		.poll(alive, { message: `Chrome on CDP port ${PORT}`, timeout: 20_000 })
		.toBe(true);
}

// With no tab open, Chrome refuses every browser-context call over CDP
// ("Browser context management is not supported"), cookies included, so make
// sure one tab exists before attaching. That tab is the one this tool drives.
async function ensureTab(): Promise<void> {
	const tabs = z
		.array(z.object({ type: z.string() }))
		.parse(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
	if (!tabs.some((t) => t.type === "page"))
		await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, {
			method: "PUT",
		});
}

export interface Session {
	context: BrowserContext;
	page: Page;
	api: Voyager;
	vanity: string;
	close: () => Promise<void>;
}

/** A GET against LinkedIn's own API, with the session's cookies and CSRF token. */
export type Voyager = <S extends z.ZodType>(
	path: string,
	schema: S,
) => Promise<z.infer<S>>;

class ApiError extends Error {
	readonly status: number;
	constructor(status: number, path: string) {
		super(`API ${status}: ${path.split("?")[0]}`);
		this.status = status;
	}
}

function voyager(request: APIRequestContext, csrf: string): Voyager {
	return async (path, schema) => {
		const r = await request.get(`${ORIGIN}${path}`, {
			headers: {
				"csrf-token": csrf,
				accept: "application/vnd.linkedin.normalized+json+2.1",
				"x-restli-protocol-version": "2.0.0",
			},
			maxRedirects: 0,
		});
		if (r.status() === 429)
			throw new StopError(
				"LinkedIn answered 429 (too many requests); stopping",
			);
		if (!r.ok()) throw new ApiError(r.status(), path);
		return schema.parse(await r.json());
	};
}

const Me = z.object({
	included: z.array(z.looseObject({ publicIdentifier: z.string().optional() })),
});

/** Attach to Chrome, check the session, and learn whose it is. */
export async function connect(): Promise<Session> {
	await ensureChrome();
	await ensureTab();
	// noDefaults: leave the profile's own settings alone. Without it, a Chrome
	// with no window open refuses Playwright's download default (playwright#40607).
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, {
		noDefaults: true,
	});
	const context = browser.contexts()[0];
	if (!context) throw new Error("the CDP Chrome has no browser context");
	const csrf = (await context.cookies(ORIGIN))
		.find((c) => c.name === "JSESSIONID")
		?.value.replaceAll('"', "");
	const signIn = new Error(
		`not signed in to LinkedIn. Sign in once, by hand, in the Chrome window this opened (port ${PORT}); the session then persists.`,
	);
	if (!csrf) throw signIn;
	const api = voyager(context.request, csrf);
	const me = await api("/voyager/api/me", Me).catch((err: unknown) => {
		if (err instanceof ApiError) throw signIn;
		throw err;
	});
	const vanity =
		process.env["LINKEDIN_VANITY"] ??
		me.included.find((i) => i.publicIdentifier)?.publicIdentifier;
	if (!vanity) throw new Error("/voyager/api/me named no member");
	const page = context.pages()[0] ?? (await context.newPage());
	return {
		context,
		page,
		api,
		vanity,
		close: async () => {
			// Detach only: Chrome and its tab stay for the next command.
			await browser.close();
		},
	};
}

/** Navigate to a path under the member's profile; stop if LinkedIn put up a checkpoint. */
export async function openProfilePath(
	s: Session,
	path: string,
): Promise<string> {
	const url = `${ORIGIN}/in/${s.vanity}/${path}`;
	await s.page.goto(url, { waitUntil: "domcontentloaded" });
	const at = s.page.url();
	if (/\/(checkpoint|authwall|login)\b/u.test(at))
		throw new StopError(`LinkedIn redirected to ${at}; stopping`);
	if (await s.page.getByText(/too many attempts/iu).count())
		throw new StopError('LinkedIn says "Too many attempts"; stopping');
	return url;
}
