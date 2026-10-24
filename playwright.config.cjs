const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
	testDir: "./tests/browser",
	fullyParallel: true,
	use: {
		baseURL: "http://127.0.0.1:4173",
		timezoneId: "Europe/Zurich",
		...(process.env.PLAYWRIGHT_CHANNEL && { channel: process.env.PLAYWRIGHT_CHANNEL }),
	},
	webServer: {
		command: `"${process.execPath}" tests/serve.cjs`,
		url: "http://127.0.0.1:4173",
		reuseExistingServer: false,
	},
});
