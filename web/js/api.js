import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const { supabaseUrl, supabaseAnonKey } = window.CONFIG ?? {};
/** Whether `config.js` provides the Supabase project URL and publishable key. */
export const configured = Boolean(supabaseUrl && supabaseAnonKey);
const sb = configured ? createClient(supabaseUrl, supabaseAnonKey) : null;

/** Returns the `data` of a Supabase response, throwing its `error` if set. */
const unwrap = ({ data, error }) => {
	if (error) throw error;
	return data;
};

/**
 * Runs a write and fails with a permission error when it touched no rows: RLS silently
 * filters writes it denies, e.g. deleting an event that has just ended.
 */
const changed = (query) =>
	query
		.select("id")
		.then(unwrap)
		.then((rows) => {
			if (!rows.length) throw Object.assign(new Error("not_allowed"), { code: "42501" });
			return rows;
		});

/**
 * Reads up to `limit` rows of `query()` page by page. It advances by the rows actually
 * returned and stops at an empty page, so it works with any Data API row cap.
 */
async function allRows(query, limit = Infinity) {
	const rows = [];
	while (rows.length < limit) {
		const end = rows.length + Math.min(200, limit - rows.length) - 1;
		const page = unwrap(await query().range(rows.length, end));
		if (!page.length) break;
		rows.push(...page);
	}
	return rows;
}

/** Reads every row of `table` whose `column` is one of `ids`, in URL-safe chunks. */
async function relatedRows(table, select, column, ids) {
	const rows = [];
	for (let offset = 0; offset < ids.length; offset += 100) {
		const chunk = ids.slice(offset, offset + 100);
		rows.push(...(await allRows(() => sb.from(table).select(select).in(column, chunk).order("id"))));
	}
	return rows;
}

const EVENT_DETAIL = `
  *,
  creator:profiles!events_created_by_fkey(display_name),
  group:groups(name)`;

/** Calls `cb(user | null)` whenever the signed-in user changes, ignoring token refreshes. */
export function onUserChange(cb) {
	let current;
	sb.auth.onAuthStateChange((_event, session) => {
		const user = session?.user ?? null;
		if ((user?.id ?? null) === current) return;
		current = user?.id ?? null;
		// Supabase calls made inside this callback would deadlock on the auth lock.
		setTimeout(() => cb(user), 0);
	});
}

export const signIn = (email, password) => sb.auth.signInWithPassword({ email, password }).then(unwrap);
export const signOut = () => sb.auth.signOut().then(unwrap);
export const changePassword = (password) => sb.auth.updateUser({ password }).then(unwrap);

export const getProfile = (id) => sb.from("profiles").select("*").eq("id", id).maybeSingle().then(unwrap);
export const updateProfile = (id, display_name) =>
	sb.from("profiles").update({ display_name }).eq("id", id).then(unwrap);
export const listProfiles = () =>
	allRows(() => sb.from("profiles").select("id, display_name").order("display_name").order("id"));

/** Groups the user can see (all of them for admins), each with the ids of its members. */
export async function listGroups() {
	const groups = await allRows(() => sb.from("groups").select("id, name").order("name").order("id"));
	const memberships = await relatedRows(
		"memberships",
		"id, group_id, user_id",
		"group_id",
		groups.map((g) => g.id),
	);
	const byGroup = new Map(groups.map((g) => [g.id, []]));
	for (const membership of memberships) byGroup.get(membership.group_id)?.push(membership.user_id);
	return groups.map((group) => ({ ...group, members: byGroup.get(group.id) }));
}
/** Creates (`id` null) or renames a group; resolves to its id. */
export const saveGroup = (id, name) => sb.rpc("save_group", { p_id: id, p_name: name }).then(unwrap);
/** Deletes a group together with its events. */
export const deleteGroup = (id) => sb.rpc("delete_group", { p_id: id }).then(unwrap);
/** Replaces the groups of a user (at least one). */
export const setUserGroups = (userId, groupIds) =>
	sb.rpc("set_user_groups", { p_user: userId, p_groups: groupIds }).then(unwrap);

const EVENT_SUMMARY = "id, group_id, title, starts_at, location, invite_only";

/** Narrows an event query to one group, or leaves it as is for `null`. */
const inGroup = (query, groupId) => (groupId ? query.eq("group_id", groupId) : query);

/** Events of `query` with their responses, for the event list. */
async function summaries(query, limit) {
	const events = await allRows(query, limit);
	const responses = await relatedRows(
		"responses",
		"id, event_id, user_id, status, guests, profile:profiles(display_name)",
		"event_id",
		events.map((e) => e.id),
	);
	const byEvent = new Map(events.map((e) => [e.id, []]));
	for (const response of responses) byEvent.get(response.event_id)?.push(response);
	return events.map((event) => ({ ...event, responses: byEvent.get(event.id) }));
}

/** Open events (starting after `since`), soonest first, optionally of one group only. */
export const listUpcoming = (since, groupId = null) =>
	summaries(() =>
		inGroup(sb.from("events").select(EVENT_SUMMARY), groupId).gt("starts_at", since).order("starts_at").order("id"),
	);

/** Past events, most recent first, at most `limit`, optionally of one group only. */
export const listPast = (since, limit, groupId = null) =>
	summaries(
		() =>
			inGroup(sb.from("events").select(EVENT_SUMMARY), groupId)
				.lte("starts_at", since)
				.order("starts_at", { ascending: false })
				.order("id"),
		limit,
	);

/** Event with creator, group, responses, proposals and their votes, items and invitations; null if not visible. */
export async function getEvent(id) {
	const event = await sb.from("events").select(EVENT_DETAIL).eq("id", id).maybeSingle().then(unwrap);
	if (!event) return null;
	const [responses, proposals, items, invitations] = await Promise.all([
		relatedRows("responses", "id, user_id, status, guests, profile:profiles(display_name)", "event_id", [id]),
		relatedRows("proposals", "*, author:profiles!proposals_created_by_fkey(display_name)", "event_id", [id]),
		relatedRows("items", "*, claimer:profiles!items_claimed_by_fkey(display_name)", "event_id", [id]),
		relatedRows("invitations", "id, user_id", "event_id", [id]),
	]);
	const votes = await relatedRows(
		"votes",
		"id, proposal_id, user_id, value",
		"proposal_id",
		proposals.map((p) => p.id),
	);
	const byProposal = new Map(proposals.map((p) => [p.id, []]));
	for (const vote of votes) byProposal.get(vote.proposal_id)?.push(vote);
	return {
		...event,
		responses,
		items,
		invitations,
		proposals: proposals.map((p) => ({ ...p, votes: byProposal.get(p.id) })),
	};
}

/** Creates (`id` null) or updates an event together with its group and invitees; resolves to the event id. */
export const saveEvent = (id, event, invitees) =>
	sb
		.rpc("save_event", {
			p_id: id,
			p_group_id: event.group_id,
			p_title: event.title,
			p_starts_at: event.starts_at,
			p_location: event.location,
			p_description: event.description,
			p_invite_only: event.invite_only,
			p_invitees: invitees,
		})
		.then(unwrap);
export const deleteEvent = (id) => changed(sb.from("events").delete().eq("id", id));

export const respond = (event_id, user_id, status, guests) =>
	sb.from("responses").upsert({ event_id, user_id, status, guests }, { onConflict: "event_id,user_id" }).then(unwrap);

export const addProposal = (event_id, data) =>
	sb
		.from("proposals")
		.insert({ event_id, ...data })
		.then(unwrap);
export const deleteProposal = (id) => changed(sb.from("proposals").delete().eq("id", id));
export const adoptProposal = (pid) => sb.rpc("adopt_proposal", { pid }).then(unwrap);

/** Sets the vote of `user_id` on a proposal: 1, -1, or 0 to remove it. */
export const vote = (proposal_id, user_id, value) =>
	value
		? sb.from("votes").upsert({ proposal_id, user_id, value }, { onConflict: "proposal_id,user_id" }).then(unwrap)
		: changed(sb.from("votes").delete().match({ proposal_id, user_id }));

export const addItem = (event_id, label) => sb.from("items").insert({ event_id, label }).then(unwrap);
/** Claims (or releases, with null) an item; resolves to no rows when RLS refused, e.g. it was already taken. */
export const claimItem = (id, user_id) =>
	sb.from("items").update({ claimed_by: user_id }).eq("id", id).select("id").then(unwrap);
export const deleteItem = (id) => changed(sb.from("items").delete().eq("id", id));

/**
 * Calls `onChange` on every Realtime change of the given `[table, filter?]` bindings, and after each
 * (re)connection to catch up on changes missed meanwhile. Returns the unsubscribe function.
 */
export function subscribe(bindings, onChange) {
	const channel = sb.channel(`live:${crypto.randomUUID()}`);
	for (const [table, filter] of bindings) {
		channel.on(
			"postgres_changes",
			{ event: filter ? "INSERT" : "*", schema: "public", table, ...(filter && { filter }) },
			onChange,
		);
		if (filter) {
			channel.on("postgres_changes", { event: "UPDATE", schema: "public", table, filter }, onChange);
			// DELETE payloads only carry the primary key, so they can't be filtered.
			channel.on("postgres_changes", { event: "DELETE", schema: "public", table }, onChange);
		}
	}
	channel.subscribe((status) => {
		if (status !== "SUBSCRIBED") return;
		onChange();
	});
	return () => sb.removeChannel(channel);
}

export const getCalendarToken = () => sb.rpc("get_calendar_token").then(unwrap);
export const rotateCalendarToken = () => sb.rpc("rotate_calendar_token").then(unwrap);
export const deleteCalendarToken = () => sb.rpc("delete_calendar_token").then(unwrap);

/** HTTPS URL of the personal iCalendar feed served by the `calendar` Edge Function. */
export const calendarFeedUrl = (token, lang) => {
	const url = new URL(`${supabaseUrl}/functions/v1/calendar`);
	url.search = new URLSearchParams({ token, lang, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
	return url.href;
};

/** Calls the `admin-users` Edge Function; errors carry the function's `code`. */
export async function admin(action, payload = {}) {
	const { data, error } = await sb.functions.invoke("admin-users", { body: { action, ...payload } });
	if (error) {
		const body = await error.context?.json?.().catch(() => null);
		throw Object.assign(new Error(body?.error ?? error.message), { code: body?.code });
	}
	return data;
}
