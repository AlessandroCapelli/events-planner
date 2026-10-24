const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/** Loads web/js/api.js with `db` standing in for the Supabase client. */
async function loadApi(db) {
	const context = vm.createContext({
		window: { CONFIG: { supabaseUrl: "https://example.test", supabaseAnonKey: "public" } },
		URL,
		URLSearchParams,
		Intl,
		crypto,
		setTimeout,
	});
	const module = new vm.SourceTextModule(read("web/js/api.js"), { context });
	const sdk = new vm.SyntheticModule(
		["createClient"],
		function () {
			this.setExport("createClient", () => db);
		},
		{ context },
	);
	await module.link(() => sdk);
	await module.evaluate();
	return module.namespace;
}

/** Runs an Edge Function with `db` as its Supabase client; its handler ends up in `context.handler`. */
function loadEdge(file, db) {
	const context = vm.createContext({
		TextEncoder,
		Date,
		Intl,
		Response,
		Request,
		URL,
		console,
		createClient: () => db,
		Deno: {
			env: { get: () => "https://example.test/" },
			serve: (handler) => {
				context.handler = handler;
			},
		},
	});
	const code = stripTypeScriptTypes(read(file).replace(/^import .*;\r?\n/gm, ""), { mode: "strip" }).replace(
		/\bexport /g,
		"",
	);
	vm.runInContext(code, context, { filename: file });
	return context;
}

/** In-memory Supabase query builder over `tables` that really filters, sorts and pages at most `cap` rows. */
function tableClient(tables, cap = 7) {
	return {
		from(table) {
			const filters = [];
			const orders = [];
			const result = () =>
				(tables[table] || [])
					.filter((row) => filters.every((fn) => fn(row)))
					.sort((a, b) => {
						for (const [key, asc] of orders) if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (asc ? 1 : -1);
						return 0;
					});
			const filter = (fn) => {
				filters.push(fn);
				return query;
			};
			const query = {
				select: () => query,
				eq: (key, value) => filter((row) => row[key] === value),
				in: (key, values) => filter((row) => values.includes(row[key])),
				gt: (key, value) => filter((row) => row[key] > value),
				lte: (key, value) => filter((row) => row[key] <= value),
				order(key, options) {
					orders.push([key, options?.ascending !== false]);
					return query;
				},
				range: async (start, end) => ({ data: result().slice(start, Math.min(end + 1, start + cap)), error: null }),
				maybeSingle: async () => ({ data: result()[0] || null, error: null }),
			};
			return query;
		},
	};
}

module.exports = { root, read, loadApi, loadEdge, tableClient };
