import process from "node:process";
import { defineConfig } from "@playwright/test";

// One runner for everything: the logic tests use no browser, the dialog tests
// drive local copies of LinkedIn's editors in the installed Google Chrome.
export default defineConfig({
	testDir: "test",
	fullyParallel: true,
	forbidOnly: Boolean(process.env["CI"]),
	reporter: process.env["CI"] ? "github" : "list",
	use: { channel: "chrome", headless: true, trace: "retain-on-failure" },
});
