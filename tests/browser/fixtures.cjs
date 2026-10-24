const base = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const mockApi = fs.readFileSync(path.join(__dirname, "mock-api.js"), "utf8");

/** Playwright `test` whose pages run in English against the in-memory API in mock-api.js, never Supabase. */
const test = base.test.extend({
	page: async ({ page }, use) => {
		await page.addInitScript(() => localStorage.setItem("lang", "en"));
		await page.route("https://**/*", (route) => route.abort());
		await page.route("**/config.js", (route) =>
			route.fulfill({ contentType: "text/javascript", body: "window.CONFIG = {};" }),
		);
		await page.route("**/js/api.js", (route) => route.fulfill({ contentType: "text/javascript", body: mockApi }));
		await use(page);
	},
});

module.exports = { test, expect: base.expect, eventPath: "/#/event/00000000-0000-4000-8000-000000000001" };
