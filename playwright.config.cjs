const { defineConfig } = require("@playwright/test");
const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || 4173}`;

module.exports = defineConfig({
	testDir: "./tests/browser",
	fullyParallel: true,
	use: {
		baseURL,
		timezoneId: "Europe/Zurich",
		...(process.env.PLAYWRIGHT_CHANNEL && { channel: process.env.PLAYWRIGHT_CHANNEL }),
	},
	webServer: { command: `"${process.execPath}" tests/serve.cjs`, url: baseURL, reuseExistingServer: false },
});
