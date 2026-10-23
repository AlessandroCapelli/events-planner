import * as api from "./api.js";
import {
	dayParts,
	fmtDate,
	fmtLongDate,
	fmtTime,
	groupLabel,
	isLive,
	isPast,
	lang,
	openSince,
	relative,
	setLang,
	t,
	tn,
} from "./i18n.js";
import {
	ask,
	avatar,
	downloadFile,
	FieldError,
	fromInput,
	html,
	icon,
	mount,
	notify,
	randomPassword,
	toInput,
} from "./ui.js";

const app = document.getElementById("app");
const nav = document.getElementById("nav");
const STATUSES = ["yes", "maybe", "no"];
const STATUS_ICON = { yes: "check", maybe: "help", no: "x" };
const MAX_GUESTS = 20;
const PAST_PAGE = 20;
const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

/** Profilo dell'utente loggato (con email), o null. */
let me = null;
/** Contatore di navigazione: scarta le viste caricate dopo che l'utente ha già cambiato pagina. */
let seq = 0;
/** Quanti eventi conclusi mostrare in lista ("Mostra eventi più vecchi" ne aggiunge altri). */
let pastLimit = PAST_PAGE;
/** Chiude l'iscrizione in tempo reale della pagina corrente. */
let stopLive = () => {};

// `live` elenca le tabelle da osservare ([tabella, filtro?]) per aggiornare la pagina in tempo reale.
const routes = [
	{
		path: /^\/$/,
		view: viewEvents,
		live: () => [["events"], ["responses"], ["invitations"], ["profiles"]],
	},
	{ path: /^\/new$/, view: () => viewEventForm() },
	{
		path: new RegExp(`^/event/${UUID}$`),
		view: viewEvent,
		live: (id) => [
			["events", `id=eq.${id}`],
			["responses", `event_id=eq.${id}`],
			["proposals", `event_id=eq.${id}`],
			["items", `event_id=eq.${id}`],
			["invitations", `event_id=eq.${id}`],
			["votes"],
			["profiles"],
		],
	},
	{ path: new RegExp(`^/event/${UUID}/edit$`), view: viewEventForm },
	{ path: /^\/account$/, view: viewAccount },
	{ path: /^\/admin$/, view: viewAdmin },
];

/**
 * Esegue una vista e ne monta il risultato, se nel frattempo non si è cambiata pagina.
 * Con `quiet` (aggiornamenti in background) un errore lascia la pagina com'è invece di sostituirla.
 */
async function show(view, args = [], { quiet = false } = {}) {
	const current = ++seq;
	let result;
	try {
		result = await view(...args);
	} catch (err) {
		if (quiet) return;
		result = [errorState(err.message)];
	}
	if (current === seq && result) mount(app, ...result);
}

/** Aggiorna la pagina quando cambiano le tabelle osservate, quando la scheda torna visibile e dopo una riconnessione. */
function goLive(bindings, refresh) {
	let timer;
	// Un'azione tocca spesso più righe (es. adottare una proposta): un solo refresh per raffica.
	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(refresh, 250);
	};
	const onVisible = () =>
		document.visibilityState === "visible" && schedule();
	const unsubscribe = api.subscribe(bindings, schedule);
	document.addEventListener("visibilitychange", onVisible);
	stopLive = () => {
		clearTimeout(timer);
		unsubscribe();
		document.removeEventListener("visibilitychange", onVisible);
		stopLive = () => {};
	};
}

async function render() {
	stopLive();
	if (!api.configured)
		return void mount(app, errorState(t("common.missingConfig")));
	renderNav();
	if (!me) return show(viewLogin);

	const path = location.hash.slice(1) || "/";
	const route = routes.find((r) => r.path.test(path));
	if (!route) return void (location.hash = "#/");
	const args = path.match(route.path).slice(1);

	app.innerHTML = skeleton();
	window.scrollTo(0, 0);
	if (route.live)
		goLive(route.live(...args), () =>
			show(route.view, args, { quiet: true }),
		);
	await show(route.view, args);
}

function renderNav() {
	mount(
		nav,
		me
			? html`<details class="menu">
					<summary
						class="menu-trigger"
						aria-label="${t("nav.menu")}"
						title="${t("nav.menu")}"
					>
						${icon("settings")}
					</summary>
					<div class="menu-panel">
						<div class="menu-head">
							${avatar(me.display_name, me.id, "lg")}
							<div class="grow">
								<strong class="truncate"
									>${me.display_name}</strong
								>
								<div class="muted small truncate">
									${me.email}
								</div>
							</div>
						</div>
						<a class="menu-item" href="#/account"
							>${icon("user")}${t("nav.account")}</a
						>
						${me.is_admin &&
						html`<a class="menu-item" href="#/admin"
							>${icon("users")}${t("nav.admin")}</a
						>`}
						<button class="menu-item" data-action="lang">
							${icon("globe")}${t("nav.switchLang")}
						</button>
						<button class="menu-item danger" data-action="logout">
							${icon("logout")}${t("nav.logout")}
						</button>
					</div>
				</details>`
			: html`<button class="btn btn-ghost btn-sm" data-action="lang">
					${icon("globe")}${t("nav.switchLang")}
				</button>`,
		{
			lang: () => {
				setLang(lang() === "it" ? "en" : "it");
				render();
			},
			logout: () => api.signOut(),
		},
	);
}

// Chiude il menu impostazioni cliccando fuori, su una voce o premendo Esc.
document.addEventListener("click", (e) => {
	for (const menu of document.querySelectorAll("details.menu[open]")) {
		if (!menu.contains(e.target) || e.target.closest(".menu-item"))
			menu.open = false;
	}
});
document.addEventListener("keydown", (e) => {
	if (e.key !== "Escape") return;
	for (const menu of document.querySelectorAll("details.menu[open]"))
		menu.open = false;
});

// ── Helper ───────────────────────────────────────────────────────────────

/** Persone per stato, contando anche gli accompagnatori di chi viene o forse viene. */
const tally = (responses) =>
	responses.reduce(
		(sum, r) => {
			sum[r.status] += r.status === "no" ? 1 : 1 + r.guests;
			return sum;
		},
		{ yes: 0, maybe: 0, no: 0 },
	);

const score = (proposal) => proposal.votes.reduce((sum, v) => sum + v.value, 0);

const byName = (a, b) =>
	(a.profile?.display_name ?? "").localeCompare(
		b.profile?.display_name ?? "",
	);

const skeleton = () =>
	html`<div
		class="skeleton-page"
		aria-busy="true"
		aria-label="${t("common.loading")}"
	>
		<div class="skeleton skeleton-title"></div>
		${[1, 2, 3].map(() => html`<div class="skeleton skeleton-card"></div>`)}
	</div>`;

const pageHead = (title, subtitle, action) =>
	html`<header class="page-head">
		<div>
			<h1>${title}</h1>
			${subtitle && html`<p class="muted">${subtitle}</p>`}
		</div>
		${action}
	</header>`;

const backLink = (href, label) =>
	html`<a class="back" href="${href}">${icon("back")}${label}</a>`;

const emptyState = (name, title, text, action) =>
	html`<div class="empty">
		<div class="empty-icon">${icon(name)}</div>
		<h2>${title}</h2>
		${text && html`<p class="muted">${text}</p>`} ${action}
	</div>`;

const errorState = (message) =>
	emptyState(
		"alert",
		t("error.title"),
		message,
		html`<button class="btn" onclick="location.reload()">
			${icon("refresh")}${t("common.retry")}
		</button>`,
	);

const dateTile = (iso, size = "") => {
	const { weekday, day, month } = dayParts(iso);
	return html`<div class="date-tile ${size}" aria-hidden="true">
		<span>${month}</span><strong>${day}</strong><span>${weekday}</span>
	</div>`;
};

const avatarStack = (responses, max = 4) =>
	html`<span class="avatar-stack">
		${responses
			.slice(0, max)
			.map((r) => avatar(r.profile?.display_name, r.user_id, "sm"))}
		${responses.length > max &&
		html`<span class="avatar avatar-sm more"
			>+${responses.length - max}</span
		>`}
	</span>`;

const statusPill = (status) =>
	html`<span class="pill ${status}"
		>${icon(STATUS_ICON[status])}${t(`rsvp.${status}`)}</span
	>`;

const deleteButton = (action, id, name) =>
	html`<button
		class="btn-icon danger"
		data-action="${action}"
		data-id="${id}"
		data-name="${name}"
		title="${t("common.delete")}"
		aria-label="${t("common.delete")}"
	>
		${icon("trash")}
	</button>`;

const eventUrl = (id) => `${location.origin}${location.pathname}#/event/${id}`;

const setInvitees = (form, checked) => {
	for (const box of form.querySelectorAll(
		'input[name="invitees"]:not(:disabled)',
	))
		box.checked = checked;
	// Come un clic dell'utente: aggiorna lo stato del form (es. toglie l'errore "nessun invitato").
	form.querySelector('input[name="invitees"]')?.dispatchEvent(
		new Event("input", { bubbles: true }),
	);
};

/** Gli errori di save_event arrivano come codice: li si traduce, legandoli al campo quando possibile. */
function eventSaveError(err) {
	if (err.message === "event_in_past")
		return new FieldError("starts_at", t("validation.eventEnded"));
	if (err.message === "not_allowed") return new Error(t("form.notAllowed"));
	return err;
}

/** Errori di Supabase Auth sulle password, riportati sul campo password. */
function passwordError(err, field = "password") {
	if (err.code === "same_password")
		return new FieldError(field, t("validation.samePassword"));
	if (err.code === "weak_password")
		return new FieldError(field, t("validation.weakPassword"));
	return err;
}

/** Evento "tutto il giorno": l'orario, che si perderebbe, va in testa alla descrizione. */
function toIcs(event) {
	const day = (date) => toInput(date).slice(0, 10).replaceAll("-", "");
	const text = (value) =>
		value.replace(/[\\;,]/g, "\\$&").replace(/\r\n|\r|\n/g, "\\n");
	// RFC 5545: al massimo 75 byte per riga, senza dividere caratteri UTF-8.
	const encoder = new TextEncoder();
	const fold = (line) => {
		const parts = [];
		let current = "";
		let bytes = 0;
		for (const char of line) {
			const size = encoder.encode(char).length;
			if (bytes + size > (parts.length ? 74 : 75)) {
				parts.push(current);
				current = "";
				bytes = 0;
			}
			current += char;
			bytes += size;
		}
		parts.push(current);
		return parts.join("\r\n ");
	};
	const start = new Date(event.starts_at);
	const end = new Date(
		start.getFullYear(),
		start.getMonth(),
		start.getDate() + 1,
	);
	const description = [
		`${t("form.startsAt")}: ${fmtLongDate(event.starts_at)}, ${fmtTime(event.starts_at)}`,
		event.description,
	]
		.filter(Boolean)
		.join("\n\n");
	return (
		[
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Events Planner//EN",
			"CALSCALE:GREGORIAN",
			"BEGIN:VEVENT",
			`UID:${event.id}@events-planner`,
			`DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
			`DTSTART;VALUE=DATE:${day(start)}`,
			`DTEND;VALUE=DATE:${day(end)}`,
			`SUMMARY:${text(event.title)}`,
			event.location && `LOCATION:${text(event.location)}`,
			`DESCRIPTION:${text(description)}`,
			"END:VEVENT",
			"END:VCALENDAR",
		]
			.filter(Boolean)
			.map(fold)
			.join("\r\n") + "\r\n"
	);
}

const slug = (value) =>
	value
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.replace(/[^\w]+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase() || "event";

/** Finestra di condivisione: anteprima, app di messaggistica, condivisione di sistema e link da copiare. */
function shareEvent(event) {
	const url = eventUrl(event.id);
	const summary = [
		`📅 ${event.title}`,
		`🕗 ${fmtLongDate(event.starts_at)}, ${fmtTime(event.starts_at)}`,
		event.location && `📍 ${event.location}`,
	]
		.filter(Boolean)
		.join("\n");
	const message = `${summary}\n\n${t("share.reply")} ${url}`;
	const enc = encodeURIComponent;
	const targets = [
		{
			id: "whatsapp",
			label: "WhatsApp",
			icon: "message",
			href: `https://wa.me/?text=${enc(message)}`,
		},
		{
			id: "telegram",
			label: "Telegram",
			icon: "send",
			href: `https://t.me/share/url?url=${enc(url)}&text=${enc(summary)}`,
		},
		{
			id: "email",
			label: t("share.email"),
			icon: "mail",
			href: `mailto:?subject=${enc(event.title)}&body=${enc(message)}`,
		},
	];

	return ask({
		title: t("share.title"),
		message: t("share.subtitle"),
		body: html`<div class="share-preview">
				${dateTile(event.starts_at, "date-tile-sm")}
				<div class="grow">
					<strong class="truncate">${event.title}</strong>
					<div class="muted small truncate">
						${fmtLongDate(event.starts_at)},
						${fmtTime(event.starts_at)}
					</div>
					${event.location &&
					html`<div class="muted small truncate">
						${event.location}
					</div>`}
				</div>
			</div>
			<div class="share-targets">
				${targets.map(
					(target) =>
						html`<a
							class="share-target ${target.id}"
							href="${target.href}"
							${target.id !== "email" &&
							html`target="_blank" rel="noopener"`}
						>
							<span class="share-icon">${icon(target.icon)}</span
							>${target.label}
						</a>`,
				)}
				${"share" in navigator &&
				html`<button
					type="button"
					class="share-target"
					data-handler="native"
				>
					<span class="share-icon">${icon("more")}</span>${t(
						"share.more",
					)}
				</button>`}
			</div>
			<div class="input-group">
				<input
					value="${url}"
					readonly
					aria-label="${t("share.link")}"
				/>
				<button type="button" class="btn" data-copy="${url}">
					${icon("copy")}<span>${t("share.copy")}</span>
				</button>
			</div>`,
		confirm: t("common.close"),
		cancel: null,
		handlers: {
			native: async (_, dialog) => {
				try {
					await navigator.share({
						title: event.title,
						text: summary,
						url,
					});
					dialog.close();
				} catch {
					// Condivisione annullata dall'utente: la finestra resta aperta.
				}
			},
		},
	});
}

// ── Viste ────────────────────────────────────────────────────────────────
// Ogni vista restituisce [markup, actions] da montare, oppure undefined se ha già rediretto.

function viewLogin() {
	return [
		html`<div class="auth">
			<form class="card auth-card" data-submit="login">
				<img
					class="auth-logo"
					src="favicon.svg"
					alt=""
					width="48"
					height="48"
				/>
				<div>
					<h1>${t("login.title")}</h1>
					<p class="muted">${t("login.subtitle")}</p>
				</div>
				<label class="field">
					<span>${t("login.email")}</span>
					<input
						name="email"
						type="email"
						autocomplete="username"
						inputmode="email"
						required
					/>
				</label>
				<label class="field">
					<span>${t("login.password")}</span>
					<input
						name="password"
						type="password"
						autocomplete="current-password"
						required
					/>
				</label>
				<button class="btn btn-primary btn-block">
					${t("login.submit")}
				</button>
				<p class="muted small center">${t("login.hint")}</p>
			</form>
		</div>`,
		{
			login: async ({ email, password }) => {
				try {
					await api.signIn(email.trim(), password);
				} catch (err) {
					throw err.status === 400
						? new Error(t("login.invalid"))
						: err;
				}
			},
		},
	];
}

async function viewEvents() {
	const since = openSince();
	const [upcoming, past] = await Promise.all([
		api.listUpcoming(since),
		api.listPast(since, pastLimit + 1),
	]);
	const hasMore = past.length > pastLimit;

	// Gruppi consecutivi per intestazione: se l'ultimo futuro e il primo concluso cadono nello
	// stesso mese finiscono nello stesso gruppo (le card concluse si distinguono dallo stile).
	const groups = [];
	for (const event of [...upcoming, ...past.slice(0, pastLimit)]) {
		const label = groupLabel(event.starts_at);
		if (groups.at(-1)?.label !== label) groups.push({ label, events: [] });
		groups.at(-1).events.push(event);
	}

	return [
		html`<div class="page-narrow">
			${pageHead(
				t("events.title"),
				upcoming.length
					? tn("events.count", upcoming.length)
					: t("events.subtitle"),
				html`<a
					class="btn btn-primary fab"
					href="#/new"
					aria-label="${t("events.new")}"
					>${icon("plus")}<span>${t("events.new")}</span></a
				>`,
			)}
			<div>
				${!upcoming.length &&
				emptyState(
					"calendar",
					t("events.emptyTitle"),
					t("events.empty"),
					html`<a class="btn btn-primary" href="#/new"
						>${icon("plus")}${t("events.new")}</a
					>`,
				)}
				${groups.map(
					(g) =>
						html`<section class="day-group">
							<h2 class="group-label">${g.label}</h2>
							<ul class="event-list">
								${g.events.map(eventCard)}
							</ul>
						</section>`,
				)}
				${hasMore &&
				html`<button
					class="btn btn-ghost btn-block more"
					data-action="more"
				>
					${t("events.more")}
				</button>`}
			</div>
		</div>`,
		{
			more: () => {
				pastLimit += PAST_PAGE;
				return show(viewEvents);
			},
		},
	];
}

function eventCard(event) {
	const past = isPast(event.starts_at);
	const mine = event.responses.find((r) => r.user_id === me.id);
	const going = event.responses
		.filter((r) => r.status === "yes")
		.sort(byName);
	const count = tally(event.responses);
	const attendance = past
		? count.yes
			? tn("people.went", count.yes)
			: t("people.nobodyWent")
		: count.yes
			? tn("people.going", count.yes)
			: t("people.nobody");
	return html`<li>
		<a class="card event-card ${past && "past"}" href="#/event/${event.id}">
			${dateTile(event.starts_at)}
			<div class="event-card-body">
				<h3>${event.title}</h3>
				<div class="meta">
					<span
						>${icon("clock")}${fmtTime(event.starts_at)} ·
						<span class="when ${isLive(event.starts_at) && "live"}"
							>${relative(event.starts_at)}</span
						></span
					>
					${event.location &&
					html`<span
						>${icon("pin")}<span class="truncate"
							>${event.location}</span
						></span
					>`}
					${event.invite_only &&
					html`<span
						>${icon("lock")}${t("audience.inviteOnly")}</span
					>`}
				</div>
				<div class="event-card-foot">
					${going.length > 0 && avatarStack(going)}
					<span class="muted small">${attendance}</span>
					${mine
						? statusPill(mine.status)
						: past
							? html`<span class="pill">${t("date.past")}</span>`
							: html`<span class="pill pending"
									>${t("rsvp.none")}</span
								>`}
				</div>
			</div>
		</a>
	</li>`;
}

async function viewEvent(id) {
	const [event, members] = await Promise.all([
		api.getEvent(id),
		api.listProfiles(),
	]);
	if (!event) {
		return [
			emptyState(
				"calendar",
				t("event.notFound"),
				t("event.notFoundHint"),
				html`<a class="btn" href="#/"
					>${icon("back")}${t("event.back")}</a
				>`,
			),
		];
	}

	// Un evento concluso è in sola lettura; solo un admin può ancora eliminarlo (come impone la RLS).
	const closed = isPast(event.starts_at);
	const isOwner = event.created_by === me.id;
	const canEdit = !closed && (me.is_admin || isOwner);
	const canDelete = me.is_admin || (!closed && isOwner);
	const mine = event.responses.find((r) => r.user_id === me.id);
	const count = tally(event.responses);
	const people = [...event.responses].sort(
		(a, b) =>
			STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) ||
			byName(a, b),
	);
	const proposals = [...event.proposals].sort((a, b) => score(b) - score(a));
	const items = [...event.items].sort((a, b) =>
		a.created_at.localeCompare(b.created_at),
	);
	// A chi è rivolto l'evento: gli invitati (più l'organizzatore) oppure tutto il gruppo.
	const invited = new Set(event.invitations.map((i) => i.user_id));
	const audience = event.invite_only
		? members.filter((m) => invited.has(m.id) || m.id === event.created_by)
		: members;
	const answered = new Set(event.responses.map((r) => r.user_id));
	const pending = audience.filter((m) => !answered.has(m.id));
	const reload = () => show(viewEvent, [id]);

	const proposalRow = (p) => {
		const myVote = p.votes.find((v) => v.user_id === me.id)?.value ?? 0;
		const total = score(p);
		return html`<li class="row proposal">
			<div class="grow">
				${p.starts_at &&
				html`<div class="row-line">
					${icon("clock")}<strong>${fmtDate(p.starts_at)}</strong>
				</div>`}
				${p.location &&
				html`<div class="row-line">
					${icon("pin")}<strong>${p.location}</strong>
				</div>`}
				<div class="muted small">
					${t("proposals.by", {
						name: p.author?.display_name ?? "—",
					})}
				</div>
			</div>
			<div class="row-actions">
				<div
					class="vote"
					role="group"
					aria-label="${t("proposals.vote")}"
				>
					<button
						class="vote-btn up"
						data-action="vote"
						data-id="${p.id}"
						data-value="1"
						aria-pressed="${String(myVote === 1)}"
						aria-label="${t("proposals.up")}"
						${closed && "disabled"}
					>
						${icon("up")}
					</button>
					<span
						class="vote-score ${total > 0
							? "pos"
							: total < 0
								? "neg"
								: ""}"
						>${total > 0 ? `+${total}` : total}</span
					>
					<button
						class="vote-btn down"
						data-action="vote"
						data-id="${p.id}"
						data-value="-1"
						aria-pressed="${String(myVote === -1)}"
						aria-label="${t("proposals.down")}"
						${closed && "disabled"}
					>
						${icon("down")}
					</button>
				</div>
				${canEdit &&
				html`<button
					class="btn btn-sm btn-soft"
					data-action="adopt"
					data-id="${p.id}"
					title="${t("proposals.adoptHint")}"
				>
					${icon("check")}${t("proposals.adopt")}
				</button>`}
				${!closed &&
				(canEdit || p.created_by === me.id) &&
				deleteButton("deleteProposal", p.id)}
			</div>
		</li>`;
	};

	const itemRow = (item) =>
		html`<li class="row">
			${item.claimer
				? avatar(item.claimer.display_name, item.claimed_by)
				: html`<span class="item-icon">${icon("package")}</span>`}
			<div class="grow">
				<strong>${item.label}</strong>
				<div class="muted small">
					${item.claimed_by === me.id
						? t("items.yours")
						: item.claimer
							? t("items.claimedBy", {
									name: item.claimer.display_name,
								})
							: t("items.free")}
				</div>
			</div>
			${!closed &&
			html`<div class="row-actions">
				${!item.claimed_by &&
				html`<button
					class="btn btn-sm btn-soft"
					data-action="claim"
					data-id="${item.id}"
				>
					${t("items.claim")}
				</button>`}
				${item.claimed_by === me.id &&
				html`<button
					class="btn btn-sm btn-ghost"
					data-action="unclaim"
					data-id="${item.id}"
				>
					${t("items.unclaim")}
				</button>`}
				${(canEdit || item.created_by === me.id) &&
				deleteButton("deleteItem", item.id)}
			</div>`}
		</li>`;

	const rsvpFooter = () => {
		if (closed) {
			if (!mine)
				return html`<p class="muted small">${t("rsvp.noReply")}</p>`;
			return (
				mine.status !== "no" &&
				html`<p class="muted small">
					${tn("rsvp.totalPast", 1 + mine.guests)}
				</p>`
			);
		}
		if (!mine) return html`<p class="muted small">${t("rsvp.pending")}</p>`;
		return (
			mine.status !== "no" &&
			html`<div class="guests">
				<div>
					<strong>${t("rsvp.bring")}</strong>
					<div class="muted small">
						${tn("rsvp.total", 1 + mine.guests)}
					</div>
				</div>
				<div class="stepper">
					<button
						class="btn-icon"
						data-action="guests"
						data-delta="-1"
						aria-label="${t("rsvp.less")}"
						${!mine.guests && "disabled"}
					>
						${icon("minus")}
					</button>
					<output aria-live="polite">${mine.guests}</output>
					<button
						class="btn-icon"
						data-action="guests"
						data-delta="1"
						aria-label="${t("rsvp.more")}"
						${mine.guests >= MAX_GUESTS && "disabled"}
					>
						${icon("plus")}
					</button>
				</div>
			</div>`
		);
	};

	return [
		html`${backLink("#/", t("event.back"))}
			${closed &&
			html`<p class="notice">
				${icon("archive")}${t("event.readOnly")}
			</p>`}
			<div class="event-layout">
				<div class="col">
					<article class="card panel hero ${closed && "past"}">
						<div class="hero-head">
							${dateTile(event.starts_at, "date-tile-lg")}
							<div class="hero-title">
								${isLive(event.starts_at) &&
								html`<span class="pill live"
									>${t("date.live")}</span
								>`}
								${closed &&
								html`<span class="pill"
									>${icon("archive")}${t("date.past")}</span
								>`}
								<h1>${event.title}</h1>
								<p class="muted small">
									${t("event.by", {
										name:
											event.creator?.display_name ?? "—",
									})}
								</p>
							</div>
						</div>
						<ul class="facts">
							<li>
								${icon("clock")}
								<div>
									<strong
										>${fmtLongDate(event.starts_at)}</strong
									>
									<span class="muted"
										>${fmtTime(event.starts_at)} ·
										${relative(event.starts_at)}</span
									>
								</div>
							</li>
							${event.location &&
							html`<li>
								${icon("pin")}
								<div>
									<strong>${event.location}</strong>
									<a
										href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
											event.location,
										)}"
										target="_blank"
										rel="noopener"
										>${t("event.openMap")}</a
									>
								</div>
							</li>`}
							<li>
								${icon(event.invite_only ? "lock" : "users")}
								<div>
									<strong
										>${event.invite_only
											? t("audience.invited")
											: t("audience.all")}</strong
									>
									<span class="muted"
										>${event.invite_only
											? audience
													.map((m) => m.display_name)
													.join(", ")
											: tn(
													"audience.members",
													audience.length,
												)}</span
									>
								</div>
							</li>
						</ul>
						${event.description &&
						html`<p class="desc">${event.description}</p>`}
						<div class="hero-actions">
							<button
								class="btn btn-sm btn-primary"
								data-action="share"
							>
								${icon("share")}${t("share.button")}
							</button>
							<button class="btn btn-sm" data-action="ics">
								${icon("download")}${t("event.addToCalendar")}
							</button>
							${canEdit &&
							html`<a
								class="btn btn-sm"
								href="#/event/${event.id}/edit"
								>${icon("edit")}${t("event.edit")}</a
							>`}
							${canDelete &&
							html`<button
								class="btn btn-sm btn-danger"
								data-action="deleteEvent"
							>
								${icon("trash")}${t("common.delete")}
							</button>`}
						</div>
					</article>

					${(!closed || proposals.length > 0) &&
					html`<section class="card panel proposals-card">
						<div>
							<h2 class="card-title">
								${icon("bulb")}${t("proposals.title")}
							</h2>
							${!closed &&
							html`<p class="muted small">
								${t("proposals.subtitle")}
							</p>`}
						</div>
						${proposals.length > 0 &&
						html`<ul class="rows">
							${proposals.map(proposalRow)}
						</ul>`}
						${!closed &&
						html`<form class="add-form" data-submit="propose">
							<label class="field">
								<span>${t("proposals.date")}</span>
								<input
									name="starts_at"
									type="datetime-local"
									min="${toInput(
										new Date(Date.now() + 60e3),
									)}"
								/>
							</label>
							<label class="field">
								<span>${t("proposals.location")}</span>
								<input
									name="location"
									maxlength="200"
									placeholder="${t(
										"proposals.locationPlaceholder",
									)}"
								/>
							</label>
							<button class="btn">
								${icon("plus")}${t("proposals.add")}
							</button>
						</form>`}
					</section>`}
					${(!closed || items.length > 0) &&
					html`<section class="card panel items-card">
						<div>
							<h2 class="card-title">
								${icon("package")}${t("items.title")}
							</h2>
							${!closed &&
							html`<p class="muted small">
								${t("items.subtitle")}
							</p>`}
						</div>
						${items.length > 0 &&
						html`<ul class="rows">
							${items.map(itemRow)}
						</ul>`}
						${!closed &&
						html`<form
							class="add-form single"
							data-submit="addItem"
						>
							<label class="field">
								<input
									name="label"
									required
									maxlength="120"
									placeholder="${t("items.placeholder")}"
									aria-label="${t("items.title")}"
								/>
							</label>
							<button class="btn" aria-label="${t("items.add")}">
								${icon("plus")}<span class="hide-xs"
									>${t("items.add")}</span
								>
							</button>
						</form>`}
					</section>`}
				</div>

				<aside class="col">
					<section class="card panel rsvp">
						<h2 class="card-title">
							${icon("calendarCheck")}${t(
								closed ? "rsvp.titlePast" : "rsvp.title",
							)}
						</h2>
						<div
							class="rsvp-options"
							role="group"
							aria-label="${t(
								closed ? "rsvp.titlePast" : "rsvp.title",
							)}"
						>
							${STATUSES.map(
								(s) =>
									html`<button
										class="rsvp-option ${s}"
										data-action="respond"
										data-status="${s}"
										aria-pressed="${String(
											mine?.status === s,
										)}"
										${closed && "disabled"}
									>
										${icon(STATUS_ICON[s])}<span
											>${t(`rsvp.${s}`)}</span
										>
									</button>`,
							)}
						</div>
						${rsvpFooter()}
					</section>

					<section class="card panel people-card">
						<h2 class="card-title">
							${icon("users")}${t("people.title")}
						</h2>
						<div class="stats">
							${STATUSES.map(
								(s) =>
									html`<div class="stat ${s}">
										<strong>${count[s]}</strong
										><span>${t(`rsvp.${s}`)}</span>
									</div>`,
							)}
						</div>
						${people.length
							? html`<ul class="people">
										${people.map(
											(r) =>
												html`<li>
													${avatar(
														r.profile?.display_name,
														r.user_id,
													)}
													<span class="grow truncate">
														${r.profile
															?.display_name ??
														"—"}
														${r.user_id === me.id &&
														html`<span class="muted"
															>(${t(
																"common.you",
															)})</span
														>`}
													</span>
													${r.status !== "no" &&
													r.guests > 0 &&
													html`<span class="pill"
														>+${r.guests}</span
													>`}
													${statusPill(r.status)}
												</li>`,
										)}
									</ul>
									<p class="muted small">
										${t("people.hint")}
									</p>`
							: html`<p class="empty-inline">
									${t("people.empty")}
								</p>`}
						${pending.length > 0 &&
						html`<div class="pending">
							<h3 class="pending-title">
								${t(
									closed
										? "people.noAnswer"
										: "people.pending",
								)}
								<span class="muted">${pending.length}</span>
							</h3>
							<div class="pending-list">
								${pending.map(
									(m) =>
										html`<span class="chip"
											>${avatar(
												m.display_name,
												m.id,
												"sm",
											)}${m.display_name}</span
										>`,
								)}
							</div>
						</div>`}
					</section>
				</aside>
			</div>`,
		{
			share: () => shareEvent(event),
			ics: () =>
				downloadFile(
					`${slug(event.title)}.ics`,
					toIcs(event),
					"text/calendar",
				),
			deleteEvent: async () => {
				const ok = await ask({
					title: t("event.confirmDelete"),
					message: t("event.confirmDeleteHint"),
					confirm: t("common.delete"),
					danger: true,
				});
				if (!ok) return;
				await api.deleteEvent(id);
				notify(t("event.deleted"));
				location.hash = "#/";
			},
			respond: async ({ status }) => {
				if (mine?.status === status) return;
				await api.respond(
					id,
					me.id,
					status,
					status === "no" ? 0 : (mine?.guests ?? 0),
				);
				await reload();
			},
			guests: async ({ delta }) => {
				const guests = Math.min(
					MAX_GUESTS,
					Math.max(0, mine.guests + Number(delta)),
				);
				await api.respond(id, me.id, mine.status, guests);
				await reload();
			},
			propose: async ({ starts_at, location: place }) => {
				if (!starts_at && !place.trim())
					throw new Error(t("proposals.hint"));
				await api.addProposal(id, {
					starts_at: starts_at ? fromInput(starts_at) : null,
					location: place.trim() || null,
				});
				await reload();
			},
			vote: async ({ id: pid, value }) => {
				const current = event.proposals
					.find((p) => p.id === pid)
					.votes.find((v) => v.user_id === me.id)?.value;
				await api.vote(
					pid,
					me.id,
					current === Number(value) ? 0 : Number(value),
				);
				await reload();
			},
			adopt: async ({ id: pid }) => {
				const ok = await ask({
					title: t("proposals.confirmAdopt"),
					message: t("proposals.confirmAdoptHint"),
					confirm: t("proposals.adopt"),
				});
				if (!ok) return;
				await api.adoptProposal(pid);
				notify(t("proposals.adopted"));
				await reload();
			},
			deleteProposal: async ({ id: pid }) => {
				await api.deleteProposal(pid);
				await reload();
			},
			addItem: async ({ label }) => {
				await api.addItem(id, label.trim());
				await reload();
			},
			claim: async ({ id: itemId }) => {
				const updated = await api.claimItem(itemId, me.id);
				if (!updated.length) notify(t("items.taken"), true);
				await reload();
			},
			unclaim: async ({ id: itemId }) => {
				await api.claimItem(itemId, null);
				await reload();
			},
			deleteItem: async ({ id: itemId }) => {
				await api.deleteItem(itemId);
				await reload();
			},
		},
	];
}

async function viewEventForm(id) {
	const [event, members] = await Promise.all([
		id ? api.getEvent(id) : null,
		api.listProfiles(),
	]);
	if (id && !(event && (me.is_admin || event.created_by === me.id)))
		return void (location.hash = "#/");
	if (event && isPast(event.starts_at))
		return void (location.hash = `#/event/${id}`);
	const back = id ? `#/event/${id}` : "#/";
	// L'organizzatore vede sempre l'evento: compare in elenco ma non si può togliere.
	const organizer = event?.created_by ?? me.id;
	const invited = new Set(event?.invitations.map((i) => i.user_id));
	const inviteOnly = Boolean(event?.invite_only);

	return [
		html`<div class="page-narrow">
			${backLink(back, t(id ? "event.backToEvent" : "event.back"))}
			${pageHead(
				t(id ? "form.editTitle" : "form.newTitle"),
				t(id ? "form.editSubtitle" : "form.newSubtitle"),
			)}
			<form class="card panel" data-submit="save">
				<label class="field">
					<span>${t("form.title")}</span>
					<input
						name="title"
						required
						maxlength="120"
						value="${event?.title}"
						placeholder="${t("form.titlePlaceholder")}"
					/>
				</label>
				<label class="field">
					<span>${t("form.startsAt")}</span>
					<input
						name="starts_at"
						type="datetime-local"
						required
						value="${event && toInput(new Date(event.starts_at))}"
						min="${toInput(new Date(openSince()))}"
					/>
				</label>
				<label class="field">
					<span
						>${t("form.location")}
						<em class="optional">${t("common.optional")}</em></span
					>
					<input
						name="location"
						maxlength="200"
						value="${event?.location}"
						placeholder="${t("form.locationPlaceholder")}"
					/>
				</label>
				<label class="field">
					<span
						>${t("form.description")}
						<em class="optional">${t("common.optional")}</em></span
					>
					<textarea
						name="description"
						rows="5"
						maxlength="2000"
						placeholder="${t("form.descriptionPlaceholder")}"
					>
${event?.description}</textarea
					>
				</label>
				<fieldset class="field audience">
					<legend>${t("audience.label")}</legend>
					<div class="segmented" role="radiogroup">
						<label
							><input
								type="radio"
								name="audience"
								value="all"
								${!inviteOnly && "checked"}
							/>${icon("users")}${t("audience.all")}</label
						>
						<label
							><input
								type="radio"
								name="audience"
								value="invited"
								${inviteOnly && "checked"}
							/>${icon("lock")}${t("audience.invited")}</label
						>
					</div>
					<p class="muted small audience-hint-all">
						${t("audience.hintAll")}
					</p>
					<div class="invitees">
						<div class="invitees-head">
							<span class="muted small"
								>${t("audience.hintInvited")}</span
							>
							<span class="invitees-tools">
								<button
									type="button"
									class="link"
									data-action="selectAll"
								>
									${t("audience.selectAll")}
								</button>
								<button
									type="button"
									class="link"
									data-action="selectNone"
								>
									${t("audience.selectNone")}
								</button>
							</span>
						</div>
						<ul class="invitee-list">
							${members.map(
								(m) =>
									html`<li>
										<label class="invitee">
											<input
												type="checkbox"
												name="invitees"
												value="${m.id}"
												${(m.id === organizer ||
													invited.has(m.id)) &&
												"checked"}
												${m.id === organizer &&
												"disabled"}
											/>
											${avatar(m.display_name, m.id)}
											<span class="grow truncate"
												>${m.display_name}</span
											>
											${m.id === organizer &&
											html`<span class="muted small"
												>${t(
													"audience.organizer",
												)}</span
											>`}
										</label>
									</li>`,
							)}
						</ul>
					</div>
				</fieldset>
				<div class="form-actions">
					<a class="btn btn-ghost" href="${back}"
						>${t("common.cancel")}</a
					>
					<button class="btn btn-primary">
						${t(id ? "common.save" : "form.create")}
					</button>
				</div>
			</form>
		</div>`,
		{
			selectAll: (_, el) => setInvitees(el.form, true),
			selectNone: (_, el) => setInvitees(el.form, false),
			save: async (values, form) => {
				const invitees = new FormData(form).getAll("invitees");
				const inviteOnly = values.audience === "invited";
				if (inviteOnly && !invitees.length)
					throw new FieldError(
						"invitees",
						t("audience.noneSelected"),
					);
				const data = {
					title: values.title.trim(),
					starts_at: fromInput(values.starts_at),
					location: values.location.trim() || null,
					description: values.description.trim() || null,
					invite_only: inviteOnly,
				};
				let savedId;
				try {
					savedId = await api.saveEvent(id ?? null, data, invitees);
				} catch (err) {
					throw eventSaveError(err);
				}
				notify(t(id ? "common.saved" : "form.created"));
				location.hash = `#/event/${savedId}`;
			},
		},
	];
}

async function viewAccount() {
	const token = await api.getCalendarToken();
	const feedUrl = token && api.calendarFeedUrl(token, lang());
	const webcalUrl = feedUrl?.replace(/^https:/, "webcal:");
	const calendarCard = html`<section class="card panel">
		<div>
			<h2 class="card-title">
				${icon("calendar")}${t("calendar.title")}
			</h2>
			<p class="muted small">${t("calendar.hint")}</p>
		</div>
		${token
			? html`<div class="calendar-apps">
						<a class="btn" href="${webcalUrl}"
							>${icon("calendarCheck")}${t("calendar.apple")}</a
						>
						<button class="btn" data-action="outlookCalendar">
							${icon("calendarCheck")}Outlook
						</button>
						<a
							class="btn"
							href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent(
								webcalUrl,
							)}"
							target="_blank"
							rel="noopener"
							>${icon("calendarCheck")}${t("calendar.google")}</a
						>
					</div>
					<div class="field">
						<label for="calendar-url">${t("calendar.link")}</label>
						<div class="input-group">
							<input
								id="calendar-url"
								value="${feedUrl}"
								readonly
							/>
							<button
								type="button"
								class="btn"
								data-action="copyCalendar"
							>
								${icon("copy")}<span>${t("share.copy")}</span>
							</button>
						</div>
					</div>
					<p class="notice small">
						${icon("lock")}${t("calendar.private")}
					</p>
					<div class="form-actions">
						<button
							class="btn btn-ghost"
							data-action="disableCalendar"
						>
							${t("calendar.disable")}
						</button>
						<button class="btn" data-action="rotateCalendar">
							${icon("refresh")}${t("calendar.rotate")}
						</button>
					</div>`
			: html`<div class="form-actions">
					<button
						class="btn btn-primary"
						data-action="enableCalendar"
					>
						${icon("calendarCheck")}${t("calendar.enable")}
					</button>
				</div>`}
	</section>`;

	return [
		html`<div class="page-narrow">
			${backLink("#/", t("event.back"))}
			${pageHead(t("account.title"), t("account.subtitle"))}
			<section class="card profile-card">
				${avatar(me.display_name, me.id, "xl")}
				<div class="grow">
					<strong class="profile-name truncate"
						>${me.display_name}</strong
					>
					<div class="muted truncate">${me.email}</div>
					${me.is_admin &&
					html`<span class="pill accent"
						>${t("admin.isAdmin")}</span
					>`}
				</div>
			</section>
			<form class="card panel" data-submit="name">
				<h2 class="card-title">
					${icon("user")}${t("account.profile")}
				</h2>
				<label class="field">
					<span>${t("account.name")}</span>
					<input
						name="display_name"
						required
						maxlength="60"
						value="${me.display_name}"
					/>
				</label>
				<div class="form-actions">
					<button class="btn btn-primary">${t("common.save")}</button>
				</div>
			</form>
			<form class="card panel" data-submit="password">
				<h2 class="card-title">
					${icon("key")}${t("account.security")}
				</h2>
				<label class="field">
					<span>${t("account.password")}</span>
					<input
						name="password"
						type="password"
						autocomplete="new-password"
						required
						minlength="8"
					/>
				</label>
				<label class="field">
					<span>${t("account.passwordConfirm")}</span>
					<input
						name="confirm"
						type="password"
						autocomplete="new-password"
						required
						data-match="password"
					/>
				</label>
				<div class="form-actions">
					<button class="btn btn-primary">
						${t("account.changePassword")}
					</button>
				</div>
			</form>
			${calendarCard}
		</div>`,
		{
			outlookCalendar: () =>
				ask({
					title: t("calendar.outlookTitle"),
					message: t("calendar.outlookHint"),
					body: html`<div class="input-group">
						<input
							value="${feedUrl}"
							readonly
							aria-label="${t("calendar.link")}"
						/>
						<button
							type="button"
							class="btn"
							data-copy="${feedUrl}"
						>
							${icon("copy")}<span>${t("share.copy")}</span>
						</button>
					</div>`,
					confirm: t("common.close"),
					cancel: null,
				}),
			enableCalendar: async () => {
				await api.rotateCalendarToken();
				await show(viewAccount);
			},
			copyCalendar: async () => {
				await navigator.clipboard.writeText(feedUrl);
				notify(t("common.copied"));
			},
			rotateCalendar: async () => {
				const ok = await ask({
					title: t("calendar.rotateConfirm"),
					message: t("calendar.rotateHint"),
					confirm: t("calendar.rotate"),
				});
				if (!ok) return;
				await api.rotateCalendarToken();
				notify(t("calendar.rotated"));
				await show(viewAccount);
			},
			disableCalendar: async () => {
				const ok = await ask({
					title: t("calendar.disableConfirm"),
					message: t("calendar.disableHint"),
					confirm: t("calendar.disable"),
					danger: true,
				});
				if (!ok) return;
				await api.deleteCalendarToken();
				notify(t("calendar.disabled"));
				await show(viewAccount);
			},
			name: async ({ display_name }) => {
				const name = display_name.trim();
				await api.updateProfile(me.id, name);
				me.display_name = name;
				notify(t("common.saved"));
				render();
			},
			password: async ({ password }, form) => {
				try {
					await api.changePassword(password);
				} catch (err) {
					throw passwordError(err);
				}
				form.reset();
				notify(t("account.passwordChanged"));
			},
		},
	];
}

async function viewAdmin() {
	if (!me.is_admin) return void (location.hash = "#/");
	const users = await api.admin("list");

	return [
		html`<div class="page-narrow">
			${backLink("#/", t("event.back"))}
			${pageHead(t("admin.title"), tn("admin.count", users.length))}

			<details class="card disclosure" ${users.length <= 1 && "open"}>
				<summary>
					${icon("userPlus")}<span>${t("admin.create")}</span>${icon(
						"chevronDown",
						"chev",
					)}
				</summary>
				<form
					class="disclosure-body"
					data-submit="create"
					autocomplete="off"
				>
					<div class="field-grid">
						<label class="field">
							<span>${t("admin.name")}</span>
							<input
								name="display_name"
								required
								maxlength="60"
							/>
						</label>
						<label class="field">
							<span>${t("login.email")}</span>
							<input
								name="email"
								type="email"
								inputmode="email"
								required
							/>
						</label>
						<div class="field">
							<label for="new-password"
								>${t("admin.password")}</label
							>
							<div class="input-group">
								<input
									id="new-password"
									name="password"
									required
									minlength="8"
									value="${randomPassword()}"
									autocomplete="new-password"
									spellcheck="false"
								/>
								<button
									type="button"
									class="btn-icon"
									data-action="generate"
									title="${t("admin.generate")}"
									aria-label="${t("admin.generate")}"
								>
									${icon("refresh")}
								</button>
							</div>
						</div>
					</div>
					<label class="check">
						<input name="is_admin" type="checkbox" />
						<span>${t("admin.makeAdmin")}</span>
					</label>
					<div class="form-actions">
						<button class="btn btn-primary">
							${icon("userPlus")}${t("admin.add")}
						</button>
					</div>
				</form>
			</details>

			<ul class="user-list">
				${users.map(
					(u) =>
						html`<li class="card user-row">
							${avatar(u.display_name, u.id, "lg")}
							<div class="grow">
								<strong>${u.display_name ?? "—"}</strong>
								${u.id === me.id &&
								html`<span class="muted"
									>(${t("common.you")})</span
								>`}
								<div class="muted small truncate">
									${u.email}
								</div>
							</div>
							<div class="row-actions">
								<label class="switch">
									<input
										type="checkbox"
										data-action="toggleAdmin"
										data-id="${u.id}"
										${u.is_admin && "checked"}
										${u.id === me.id && "disabled"}
									/>
									<span>${t("admin.isAdmin")}</span>
								</label>
								<button
									class="btn-icon"
									data-action="resetPassword"
									data-id="${u.id}"
									data-name="${u.display_name}"
									title="${t("admin.resetPassword")}"
									aria-label="${t("admin.resetPassword")}"
								>
									${icon("key")}
								</button>
								${u.id === me.id
									? html`<span
											class="btn-icon"
											aria-hidden="true"
										></span>`
									: deleteButton(
											"deleteUser",
											u.id,
											u.display_name,
										)}
							</div>
						</li>`,
				)}
			</ul>
		</div>`,
		{
			generate: (_, el) => {
				el.closest(".input-group").querySelector("input").value =
					randomPassword();
			},
			create: async (form) => {
				const user = {
					display_name: form.display_name.trim(),
					email: form.email.trim(),
					password: form.password,
					is_admin: form.is_admin === "on",
				};
				try {
					await api.admin("create", user);
				} catch (err) {
					if (err.code === "email_exists")
						throw new FieldError(
							"email",
							t("validation.emailExists"),
						);
					throw passwordError(err);
				}
				const loginUrl = location.origin + location.pathname;
				await ask({
					title: t("admin.createdTitle"),
					message: t("admin.createdMessage", {
						name: user.display_name,
					}),
					body: html`<div class="credentials">
							<div>
								<span class="muted small"
									>${t("login.email")}</span
								><code>${user.email}</code>
							</div>
							<div>
								<span class="muted small"
									>${t("login.password")}</span
								><code>${user.password}</code>
							</div>
							<div>
								<span class="muted small"
									>${t("admin.link")}</span
								><code>${loginUrl}</code>
							</div>
						</div>
						<button
							type="button"
							class="btn btn-sm"
							data-copy="${`${loginUrl}\n${t("login.email")}: ${user.email}\n${t("login.password")}: ${user.password}`}"
						>
							${icon("copy")}<span>${t("admin.copy")}</span>
						</button>`,
					confirm: t("common.done"),
					cancel: null,
				});
				await show(viewAdmin);
			},
			toggleAdmin: async ({ id }, el) => {
				try {
					await api.admin("update", { id, is_admin: el.checked });
					notify(t("common.saved"));
				} catch (err) {
					el.checked = !el.checked;
					throw err;
				}
			},
			resetPassword: async ({ id, name }) => {
				const password = await ask({
					title: t("admin.resetTitle", { name }),
					message: t("admin.resetHint"),
					input: {
						label: t("admin.newPassword"),
						value: randomPassword(),
						minlength: 8,
						generate: true,
					},
					confirm: t("admin.resetPassword"),
				});
				if (!password) return;
				await api.admin("update", { id, password });
				notify(t("admin.passwordUpdated"));
			},
			deleteUser: async ({ id, name }) => {
				const ok = await ask({
					title: t("admin.confirmDelete", { name }),
					message: t("admin.confirmDeleteHint"),
					confirm: t("common.delete"),
					danger: true,
				});
				if (!ok) return;
				await api.admin("delete", { id });
				notify(t("admin.deleted"));
				await show(viewAdmin);
			},
		},
	];
}

// ── Avvio ────────────────────────────────────────────────────────────────

window.addEventListener("hashchange", render);

if (api.configured) {
	api.onUserChange(async (user) => {
		me = null;
		if (user) {
			try {
				const profile = await api.getProfile(user.id);
				// Utente eliminato dall'admin: la sessione è ancora valida ma il profilo non esiste più.
				if (!profile) return void api.signOut();
				me = { ...profile, email: user.email };
			} catch (err) {
				stopLive();
				renderNav();
				return void mount(app, errorState(err.message));
			}
		}
		render();
	});
} else {
	render();
}
