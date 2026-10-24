import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const { supabaseUrl, supabaseAnonKey } = window.CONFIG ?? {};
export const configured = Boolean(supabaseUrl && supabaseAnonKey);
const sb = configured ? createClient(supabaseUrl, supabaseAnonKey) : null;

const unwrap = ({ data, error }) => {
	if (error) throw error;
	return data;
};

// Una DELETE bloccata dalla RLS non dà errore: tocca 0 righe. La si trasforma in errore,
// altrimenti l'app confermerebbe un'operazione mai avvenuta (es. evento appena concluso).
const changed = (query) =>
	query
		.select("id")
		.then(unwrap)
		.then((rows) => {
			if (!rows.length)
				throw Object.assign(new Error("not_allowed"), {
					code: "42501",
				});
			return rows;
		});

// Non assumere che il limite Data API sia 1.000: può essere più basso.
// Si avanza delle righe effettive e si termina solo con una pagina vuota.
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

async function relatedRows(table, select, column, ids) {
	const rows = [];
	for (let offset = 0; offset < ids.length; offset += 100) {
		const chunk = ids.slice(offset, offset + 100);
		rows.push(
			...(await allRows(() =>
				sb.from(table).select(select).in(column, chunk).order("id"),
			)),
		);
	}
	return rows;
}

// Gli hint !<fk> servono perché responses/votes fanno da tabelle ponte verso profiles.
const EVENT_DETAIL = `
  *,
  creator:profiles!events_created_by_fkey(display_name)`;

/** Invoca cb(user | null) solo quando cambia l'utente loggato (ignora i refresh del token). */
export function onUserChange(cb) {
	let current;
	sb.auth.onAuthStateChange((_event, session) => {
		const user = session?.user ?? null;
		if ((user?.id ?? null) === current) return;
		current = user?.id ?? null;
		// Differito: chiamare Supabase dentro questa callback può bloccare il lock di auth.
		setTimeout(() => cb(user), 0);
	});
}

export const signIn = (email, password) =>
	sb.auth.signInWithPassword({ email, password }).then(unwrap);
export const signOut = () => sb.auth.signOut().then(unwrap);
export const changePassword = (password) =>
	sb.auth.updateUser({ password }).then(unwrap);

export const getProfile = (id) =>
	sb.from("profiles").select("*").eq("id", id).maybeSingle().then(unwrap);
export const updateProfile = (id, display_name) =>
	sb.from("profiles").update({ display_name }).eq("id", id).then(unwrap);
export const listProfiles = () =>
	allRows(() =>
		sb
			.from("profiles")
			.select("id, display_name")
			.order("display_name")
			.order("id"),
	);

const EVENT_SUMMARY = "id, title, starts_at, location, invite_only";

async function summaries(query, limit) {
	const events = await allRows(query, limit);
	const responses = await relatedRows(
		"responses",
		"id, event_id, user_id, status, guests, profile:profiles(display_name)",
		"event_id",
		events.map((e) => e.id),
	);
	const byEvent = new Map(events.map((e) => [e.id, []]));
	for (const response of responses)
		byEvent.get(response.event_id)?.push(response);
	return events.map((event) => ({
		...event,
		responses: byEvent.get(event.id),
	}));
}

/** Eventi ancora aperti (iniziati dopo `since`), dal più vicino. */
export const listUpcoming = (since) =>
	summaries(() =>
		sb
			.from("events")
			.select(EVENT_SUMMARY)
			.gt("starts_at", since)
			.order("starts_at")
			.order("id"),
	);

/** Eventi conclusi, dal più recente; al massimo `limit`. */
export const listPast = (since, limit) =>
	summaries(
		() =>
			sb
				.from("events")
				.select(EVENT_SUMMARY)
				.lte("starts_at", since)
				.order("starts_at", { ascending: false })
				.order("id"),
		limit,
	);
export async function getEvent(id) {
	const event = await sb
		.from("events")
		.select(EVENT_DETAIL)
		.eq("id", id)
		.maybeSingle()
		.then(unwrap);
	if (!event) return null;
	const [responses, proposals, items, invitations] = await Promise.all([
		relatedRows(
			"responses",
			"id, user_id, status, guests, profile:profiles(display_name)",
			"event_id",
			[id],
		),
		relatedRows(
			"proposals",
			"*, author:profiles!proposals_created_by_fkey(display_name)",
			"event_id",
			[id],
		),
		relatedRows(
			"items",
			"*, claimer:profiles!items_claimed_by_fkey(display_name)",
			"event_id",
			[id],
		),
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
		proposals: proposals.map((p) => ({
			...p,
			votes: byProposal.get(p.id),
		})),
	};
}
/** Crea (id null) o modifica un evento insieme ai suoi invitati; restituisce l'id. */
export const saveEvent = (id, event, invitees) =>
	sb
		.rpc("save_event", {
			p_id: id,
			p_title: event.title,
			p_starts_at: event.starts_at,
			p_location: event.location,
			p_description: event.description,
			p_invite_only: event.invite_only,
			p_invitees: invitees,
		})
		.then(unwrap);
export const deleteEvent = (id) =>
	changed(sb.from("events").delete().eq("id", id));

export const respond = (event_id, user_id, status, guests) =>
	sb
		.from("responses")
		.upsert(
			{ event_id, user_id, status, guests },
			{ onConflict: "event_id,user_id" },
		)
		.then(unwrap);

export const addProposal = (event_id, data) =>
	sb
		.from("proposals")
		.insert({ event_id, ...data })
		.then(unwrap);
export const deleteProposal = (id) =>
	changed(sb.from("proposals").delete().eq("id", id));
export const adoptProposal = (pid) =>
	sb.rpc("adopt_proposal", { pid }).then(unwrap);

/** value: 1, -1 oppure 0 per rimuovere il voto. */
export const vote = (proposal_id, user_id, value) =>
	value
		? sb
				.from("votes")
				.upsert(
					{ proposal_id, user_id, value },
					{ onConflict: "proposal_id,user_id" },
				)
				.then(unwrap)
		: changed(sb.from("votes").delete().match({ proposal_id, user_id }));

export const addItem = (event_id, label) =>
	sb.from("items").insert({ event_id, label }).then(unwrap);
/** Restituisce le righe aggiornate: vuoto se qualcun altro l'ha già prenotato (bloccato dalla RLS). */
export const claimItem = (id, user_id) =>
	sb
		.from("items")
		.update({ claimed_by: user_id })
		.eq("id", id)
		.select("id")
		.then(unwrap);
export const deleteItem = (id) =>
	changed(sb.from("items").delete().eq("id", id));

/**
 * Iscrive alle modifiche delle tabelle indicate come [tabella, filtro?] e chiama onChange a ogni modifica.
 * onChange viene chiamata anche dopo una riconnessione, per recuperare le modifiche perse nel frattempo.
 * Restituisce la funzione che chiude l'iscrizione.
 */
export function subscribe(bindings, onChange) {
	const channel = sb.channel(`live:${crypto.randomUUID()}`);
	for (const [table, filter] of bindings) {
		channel.on(
			"postgres_changes",
			{
				event: filter ? "INSERT" : "*",
				schema: "public",
				table,
				...(filter && { filter }),
			},
			onChange,
		);
		if (filter) {
			channel.on(
				"postgres_changes",
				{ event: "UPDATE", schema: "public", table, filter },
				onChange,
			);
			// Con RLS e replica identity predefinita una DELETE ha solo la PK.
			// Si invalida la vista senza esporre event_id o user_id nelle righe eliminate.
			channel.on(
				"postgres_changes",
				{ event: "DELETE", schema: "public", table },
				onChange,
			);
		}
	}
	channel.subscribe((status) => {
		if (status !== "SUBSCRIBED") return;
		// Recupera anche le modifiche avvenute tra il caricamento e il primo join.
		onChange();
	});
	return () => sb.removeChannel(channel);
}

export const getCalendarToken = () => sb.rpc("get_calendar_token").then(unwrap);
export const rotateCalendarToken = () =>
	sb.rpc("rotate_calendar_token").then(unwrap);
export const deleteCalendarToken = () =>
	sb.rpc("delete_calendar_token").then(unwrap);

/** Link https del feed iCalendar personale (Edge Function "calendar"). */
export const calendarFeedUrl = (token, lang) => {
	const url = new URL(`${supabaseUrl}/functions/v1/calendar`);
	url.search = new URLSearchParams({
		token,
		lang,
		tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
	});
	return url.href;
};

export async function admin(action, payload = {}) {
	const { data, error } = await sb.functions.invoke("admin-users", {
		body: { action, ...payload },
	});
	if (error) {
		const body = await error.context?.json?.().catch(() => null);
		throw Object.assign(new Error(body?.error ?? error.message), {
			code: body?.code,
		});
	}
	return data;
}
