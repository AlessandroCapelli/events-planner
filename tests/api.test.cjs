const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApi, tableClient } = require("./helpers.cjs");

test("lists are complete beyond 1,000 rows even when the API caps pages lower", async () => {
	const events = Array.from({ length: 1103 }, (_, i) => ({
		id: String(i).padStart(5, "0"),
		starts_at: "2026-10-24",
		title: "Event",
	}));
	const profiles = events.map((e) => ({ id: e.id, display_name: "Name" }));
	const responses = events.map((e) => ({ id: e.id, event_id: e.id, status: "yes", guests: 0 }));
	const api = await loadApi(tableClient({ events, profiles, responses }));
	assert.equal((await api.listProfiles()).length, 1103);
	const upcoming = await api.listUpcoming("2026-10-23");
	assert.equal(upcoming.length, 1103);
	assert.ok(upcoming.every((e) => e.responses.length === 1));
	assert.equal((await api.listPast("2026-10-25", 1030)).length, 1030);
});

test("event responses, votes and invitations are paged too", async () => {
	const responses = Array.from({ length: 1021 }, (_, i) => ({ id: String(i), event_id: "event", user_id: String(i) }));
	const invitations = responses.map((r) => ({ ...r }));
	const votes = responses.map((r) => ({ ...r, proposal_id: "proposal", value: 1 }));
	const api = await loadApi(
		tableClient({
			events: [{ id: "event" }],
			responses,
			invitations,
			votes,
			proposals: [{ id: "proposal", event_id: "event" }],
			items: [],
		}),
	);
	const event = await api.getEvent("event");
	assert.equal(event.responses.length, 1021);
	assert.equal(event.invitations.length, 1021);
	assert.equal(event.proposals[0].votes.length, 1021);
	assert.equal(await api.getEvent("missing"), null);
});

test("group memberships remain complete beyond the API row cap", async () => {
	const groups = [
		{ id: "default", name: "Default" },
		{ id: "climbing", name: "Climbing" },
	];
	const memberships = Array.from({ length: 1103 }, (_, i) => ({
		id: String(i).padStart(5, "0"),
		group_id: i % 2 ? "climbing" : "default",
		user_id: `user-${i}`,
	}));
	const api = await loadApi(tableClient({ groups, memberships }));
	const result = await api.listGroups();
	for (const group of result) {
		const expected = memberships.filter((m) => m.group_id === group.id).map((m) => m.user_id);
		assert.deepEqual([...group.members], expected);
	}
});

test("the selected group filters both upcoming and archived events", async () => {
	const events = ["default", "climbing"].flatMap((group_id) => [
		{ id: `${group_id}-past`, group_id, starts_at: "2026-10-23" },
		{ id: `${group_id}-future`, group_id, starts_at: "2026-10-26" },
	]);
	const api = await loadApi(tableClient({ events }));
	assert.deepEqual(
		[...(await api.listUpcoming("2026-10-25", "climbing"))].map((e) => e.id),
		["climbing-future"],
	);
	assert.deepEqual(
		[...(await api.listPast("2026-10-25", 20, "default"))].map((e) => e.id),
		["default-past"],
	);
	assert.equal((await api.listUpcoming("2026-10-25")).length, 2);
});

test("deletes that RLS silently filters out are reported as forbidden", async () => {
	const deleted = (rows) => ({
		from: () => ({ delete: () => ({ eq: () => ({ select: async () => ({ data: rows, error: null }) }) }) }),
	});
	const allowed = await loadApi(deleted([{ id: "event" }]));
	assert.deepEqual(await allowed.deleteEvent("event"), [{ id: "event" }]);
	const denied = await loadApi(deleted([]));
	await assert.rejects(denied.deleteEvent("event"), { code: "42501" });
});

test("DELETEs are subscribed unfiltered and every join refreshes the view", async () => {
	const listeners = [];
	let joined;
	let removed = false;
	let changes = 0;
	const channel = {
		on(type, binding, callback) {
			listeners.push({ binding, callback });
			return channel;
		},
		subscribe(cb) {
			joined = cb;
		},
	};
	const api = await loadApi({
		channel: () => channel,
		removeChannel: () => {
			removed = true;
		},
	});
	const stop = api.subscribe([["items", "event_id=eq.example"]], () => changes++);
	assert.equal(listeners.length, 3);
	assert.equal(listeners.find((l) => l.binding.event === "DELETE").binding.filter, undefined);
	assert.equal(listeners.find((l) => l.binding.event === "UPDATE").binding.filter, "event_id=eq.example");
	joined("SUBSCRIBED");
	joined("SUBSCRIBED");
	assert.equal(changes, 2);
	stop();
	assert.equal(removed, true);
});
