const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { root, read } = require("./helpers.cjs");

test("config.js is generated as JSON, and missing variables stop the deployment", () => {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "events-config-"));
	fs.mkdirSync(path.join(folder, "web"));
	const script = path.join(root, "scripts/generate-config.mjs");
	const env = {
		...process.env,
		SUPABASE_URL: "https://example.test/",
		SUPABASE_ANON_KEY: 'key";window.injected=true;//',
	};
	execFileSync(process.execPath, [script], { cwd: folder, env });
	const context = { window: {} };
	vm.runInNewContext(fs.readFileSync(path.join(folder, "web/config.js"), "utf8"), context);
	assert.equal(context.window.CONFIG.supabaseUrl, "https://example.test");
	assert.equal(context.window.CONFIG.supabaseAnonKey, env.SUPABASE_ANON_KEY);
	assert.equal(context.window.injected, undefined);
	assert.throws(() =>
		execFileSync(process.execPath, [script], { cwd: folder, env: { ...env, SUPABASE_ANON_KEY: "" }, stdio: "pipe" }),
	);
	assert.throws(() =>
		execFileSync(process.execPath, [script], {
			cwd: folder,
			env: { ...env, SUPABASE_URL: "http://example.test" },
			stdio: "pipe",
		}),
	);
	fs.rmSync(folder, { recursive: true });
});

test("every translation exists in both languages and the frontend modules parse", () => {
	const keys = (lang) => Object.keys(JSON.parse(read(`web/locales/${lang}.json`))).sort();
	assert.deepEqual(keys("it"), keys("en"));
	for (const file of ["api", "ui", "i18n", "app"]) new vm.SourceTextModule(read(`web/js/${file}.js`));
});

test("every icon used by the app exists in the sprite", () => {
	const sprite = new Set([...read("web/icons.svg").matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
	const code = read("web/js/app.js") + read("web/js/ui.js");
	const used = [...code.matchAll(/icon\("([^"]+)"/g), ...code.matchAll(/\bicon: "([^"]+)"/g)].map((m) => m[1]);
	for (const name of used) assert.ok(sprite.has(name), `missing icon: ${name}`);
});
