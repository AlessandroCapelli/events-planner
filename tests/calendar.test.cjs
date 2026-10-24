const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { read, loadEdge } = require("./helpers.cjs");

const event = {
	id: "e1",
	title: "Dinner à 🎉 ".repeat(12),
	starts_at: "2026-10-25T00:30:00Z",
	location: "Square; one, two\\three",
	description: "First\rSecond\r\nThird\n" + "🎉à".repeat(400),
	my_status: "yes",
};

function validate(ics) {
	assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
	assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
	assert.ok(!/[\r\n]/.test(ics.replace(/\r\n/g, "")));
	for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
	const unfolded = ics.replace(/\r\n /g, "");
	assert.ok(unfolded.includes("First\\nSecond\\nThird\\n"));
	assert.ok(unfolded.includes("LOCATION:Square\\; one\\, two\\\\three"));
	assert.ok(unfolded.includes("SUMMARY:" + event.title));
	return unfolded;
}

test("the .ics export and the feed follow the same iCalendar rules, UTF-8 and newlines included", () => {
	const app = read("web/js/app.js");
	const ui = read("web/js/ui.js");
	const context = vm.createContext({
		TextEncoder,
		Date,
		Intl,
		t: () => "Date and time",
		fmtLongDate: () => "Saturday",
		fmtTime: () => "15:00",
	});
	vm.runInContext(
		ui.slice(ui.indexOf("const pad =")).replace(/export /g, "") +
			"\n" +
			app.slice(app.indexOf("function toIcs("), app.indexOf("\nconst slug =")),
		context,
	);
	validate(context.toIcs(event));
	const edge = loadEdge("supabase/functions/calendar/index.ts", {});
	const la = validate(edge.buildCalendar([event], { timeZone: "America/Los_Angeles" }));
	assert.ok(la.includes("DTSTART;VALUE=DATE:20261024\r\n"));
	assert.ok(la.includes("DTEND;VALUE=DATE:20261025\r\n"));
	const zurich = validate(edge.buildCalendar([event], { timeZone: "Europe/Zurich" }));
	assert.ok(zurich.includes("DTSTART;VALUE=DATE:20261025\r\n"));
	assert.ok(zurich.includes("DTEND;VALUE=DATE:20261026\r\n"));
});

test("the feed is never truncated and handles GET, HEAD, invalid tokens and database errors", async () => {
	const events = Array.from({ length: 1103 }, (_, i) => ({ ...event, id: String(i) }));
	let failure = null;
	const db = {
		rpc: () => {
			const query = {
				order: () => query,
				range: async (start) => ({ data: events.slice(start, start + 17), error: failure }),
			};
			return query;
		},
	};
	const edge = loadEdge("supabase/functions/calendar/index.ts", db);
	const url = "https://example.test/calendar?token=" + "a".repeat(64);
	const get = await edge.handler(new Request(url));
	assert.equal(get.status, 200);
	assert.equal(get.headers.get("Cache-Control"), "private, no-cache, must-revalidate");
	assert.equal(get.headers.get("Content-Type"), "text/calendar; charset=utf-8");
	assert.equal(((await get.text()).match(/BEGIN:VEVENT/g) || []).length, 1103);
	const head = await edge.handler(new Request(url, { method: "HEAD" }));
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
	assert.equal((await edge.handler(new Request("https://example.test/calendar?token=invalid"))).status, 404);
	failure = { code: "P0002" };
	assert.equal((await edge.handler(new Request(url))).status, 404);
	failure = { code: "other" };
	assert.equal((await edge.handler(new Request(url))).status, 500);
});
