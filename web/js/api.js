import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const { supabaseUrl, supabaseAnonKey } = window.CONFIG ?? {};
export const configured = Boolean(supabaseUrl && supabaseAnonKey);
const sb = configured ? createClient(supabaseUrl, supabaseAnonKey) : null;

const unwrap = ({ data, error }) => {
	if (error) throw error;
	return data;
};

// Gli hint !<fk> servono perché responses/votes fanno da tabelle ponte verso profiles.
const EVENT_DETAIL = `
  *,
  creator:profiles!events_created_by_fkey(display_name),
  responses(user_id, status, guests, profile:profiles(display_name)),
  proposals(*, author:profiles!proposals_created_by_fkey(display_name), votes(user_id, value)),
  items(*, claimer:profiles!items_claimed_by_fkey(display_name)),
  invitations(user_id)`;

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
export const signOut = () => sb.auth.signOut();
export const changePassword = (password) =>
	sb.auth.updateUser({ password }).then(unwrap);

export const getProfile = (id) =>
	sb.from("profiles").select("*").eq("id", id).maybeSingle().then(unwrap);
export const updateProfile = (id, display_name) =>
	sb.from("profiles").update({ display_name }).eq("id", id).then(unwrap);
export const listProfiles = () =>
	sb
		.from("profiles")
		.select("id, display_name")
		.order("display_name")
		.then(unwrap);

const EVENT_SUMMARY =
	"id, title, starts_at, location, invite_only, responses(user_id, status, guests, profile:profiles(display_name))";

/** Eventi ancora aperti (iniziati dopo `since`), dal più vicino. */
export const listUpcoming = (since) =>
	sb
		.from("events")
		.select(EVENT_SUMMARY)
		.gt("starts_at", since)
		.order("starts_at")
		.then(unwrap);

/** Eventi conclusi, dal più recente; al massimo `limit`. */
export const listPast = (since, limit) =>
	sb
		.from("events")
		.select(EVENT_SUMMARY)
		.lte("starts_at", since)
		.order("starts_at", { ascending: false })
		.limit(limit)
		.then(unwrap);
export const getEvent = (id) =>
	sb
		.from("events")
		.select(EVENT_DETAIL)
		.eq("id", id)
		.maybeSingle()
		.then(unwrap);
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
	sb.from("events").delete().eq("id", id).then(unwrap);

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
	sb.from("proposals").delete().eq("id", id).then(unwrap);
export const adoptProposal = (pid) =>
	sb.rpc("adopt_proposal", { pid }).then(unwrap);

/** value: 1, -1 oppure 0 per rimuovere il voto. */
export const vote = (proposal_id, user_id, value) =>
	(value
		? sb
				.from("votes")
				.upsert(
					{ proposal_id, user_id, value },
					{ onConflict: "proposal_id,user_id" },
				)
		: sb.from("votes").delete().match({ proposal_id, user_id })
	).then(unwrap);

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
	sb.from("items").delete().eq("id", id).then(unwrap);

/**
 * Iscrive alle modifiche delle tabelle indicate come [tabella, filtro?] e chiama onChange a ogni modifica.
 * onChange viene chiamata anche dopo una riconnessione, per recuperare le modifiche perse nel frattempo.
 * Restituisce la funzione che chiude l'iscrizione.
 */
export function subscribe(bindings, onChange) {
	const channel = sb.channel(`live:${crypto.randomUUID()}`);
	for (const [table, filter] of bindings)
		channel.on(
			"postgres_changes",
			{ event: "*", schema: "public", table, ...(filter && { filter }) },
			onChange,
		);
	let joined = false;
	channel.subscribe((status) => {
		if (status !== "SUBSCRIBED") return;
		if (joined) onChange();
		joined = true;
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
