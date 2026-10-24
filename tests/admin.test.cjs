const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadEdge, tableClient } = require("./helpers.cjs");

function setup({ admin = true, valid = true, failure = null } = {}) {
	const users = Array.from({ length: 1103 }, (_, i) => ({ id: String(i), email: i + "@example.test" }));
	const profiles = users.map((u) => ({ id: u.id, display_name: "Name " + u.id, is_admin: u.id === "0" && admin }));
	const db = tableClient({ profiles });
	let created;
	db.auth = {
		getUser: async () => ({ data: { user: valid ? { id: "0" } : null }, error: null }),
		admin: {
			listUsers: async ({ page, perPage }) => ({
				data: { users: users.slice((page - 1) * perPage, page * perPage) },
				error: null,
			}),
			createUser: async (payload) => {
				created = payload;
				return { data: { user: { id: "new" } }, error: failure };
			},
		},
	};
	const edge = loadEdge("supabase/functions/admin-users/index.ts", db);
	const request = (body, token = "valid") =>
		new Request("https://example.test/admin-users", {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
			body: JSON.stringify(body),
		});
	return { edge, request, created: () => created };
}

test("authenticates explicitly, even if the gateway's JWT check were off", async () => {
	const noToken = setup();
	assert.equal((await noToken.edge.handler(noToken.request({ action: "list" }, ""))).status, 401);
	const invalid = setup({ valid: false });
	assert.equal((await invalid.edge.handler(invalid.request({ action: "list" }))).status, 401);
	const member = setup({ admin: false });
	assert.equal((await member.edge.handler(member.request({ action: "list" }))).status, 403);
	assert.equal((await noToken.edge.handler(new Request("https://example.test/admin-users"))).status, 405);
});

test("lists every user and profile beyond 1,000", async () => {
	const { edge, request } = setup();
	const response = await edge.handler(request({ action: "list" }));
	assert.equal(response.status, 200);
	const users = await response.json();
	assert.equal(users.length, 1103);
	assert.ok(users.every((u) => u.display_name));
});

test("sets the initial role and groups in the single createUser call", async () => {
	const { edge, request, created } = setup();
	const response = await edge.handler(
		request({
			action: "create",
			email: "new@example.test",
			password: "test password",
			display_name: "New",
			is_admin: true,
			groups: ["group"],
		}),
	);
	assert.equal(response.status, 200);
	assert.equal(created().app_metadata.initial_admin, true);
	assert.deepEqual([...created().app_metadata.initial_groups], ["group"]);
	assert.equal(created().user_metadata.display_name, "New");
	const failure = setup({ failure: { message: "Trigger failed", code: "unexpected_failure" } });
	const create = { action: "create", is_admin: true, groups: ["group"] };
	assert.equal((await failure.edge.handler(failure.request(create))).status, 400);
});

test("refuses to create a user without groups", async () => {
	for (const groups of [undefined, [], [1]]) {
		const { edge, request, created } = setup();
		const response = await edge.handler(request({ action: "create", email: "new@example.test", groups }));
		assert.equal(response.status, 400);
		assert.equal((await response.json()).code, "no_group");
		assert.equal(created(), undefined);
	}
});
