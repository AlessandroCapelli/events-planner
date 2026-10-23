import * as api from "./api.js";
import {
	dayParts,
	fmtDate,
	fmtLongDate,
	fmtTime,
	groupLabel,
	isLive,
	lang,
	relative,
	setLang,
	t,
	tn,
} from "./i18n.js";
import {
	ask,
	avatar,
	downloadFile,
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
const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const NOT_BLANK = ".*\\S.*";

/** Profilo dell'utente loggato (con email), o null. */
let me = null;
/** Contatore di navigazione: scarta le viste caricate dopo che l'utente ha già cambiato pagina. */
let seq = 0;

const routes = [
	[/^\/$/, viewEvents],
	[/^\/new$/, () => viewEventForm()],
	[new RegExp(`^/event/${UUID}$`), viewEvent],
	[new RegExp(`^/event/${UUID}/edit$`), viewEventForm],
	[/^\/account$/, viewAccount],
	[/^\/admin$/, viewAdmin],
];

async function show(view, ...args) {
	const current = ++seq;
	let result;
	try {
		result = await view(...args);
	} catch (err) {
		result = [errorState(err.message)];
	}
	if (current === seq && result) mount(app, ...result);
}

async function render() {
	if (!api.configured)
		return void mount(app, errorState(t("common.missingConfig")));
	renderNav();
	if (!me) return show(viewLogin);

	const path = location.hash.slice(1) || "/";
	const route = routes.find(([re]) => re.test(path));
	if (!route) return void (location.hash = "#/");

	app.innerHTML = skeleton();
	window.scrollTo(0, 0);
	await show(route[1], ...path.match(route[0]).slice(1));
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

/** Evento "tutto il giorno": l'orario, che si perderebbe, va in testa alla descrizione. */
function toIcs(event) {
	const day = (date) => toInput(date).slice(0, 10).replaceAll("-", "");
	const text = (value) =>
		value.replace(/[\\;,]/g, "\\$&").replace(/\r?\n/g, "\\n");
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
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Events Planner//EN",
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
		.join("\r\n");
}

const slug = (value) =>
	value
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.replace(/[^\w]+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase() || "event";

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
				<p class="form-error" role="alert" hidden></p>
				<button class="btn btn-primary btn-block">
					${t("login.submit")}
				</button>
				<p class="muted small center">${t("login.hint")}</p>
			</form>
		</div>`,
		{
			login: async ({ email, password }, form) => {
				const error = form.querySelector(".form-error");
				error.hidden = true;
				try {
					await api.signIn(email.trim(), password);
				} catch (err) {
					error.textContent =
						err.status === 400 ? t("login.invalid") : err.message;
					error.hidden = false;
				}
			},
		},
	];
}

async function viewEvents() {
	const events = await api.listEvents();
	const groups = [];
	for (const event of events) {
		const label = groupLabel(event.starts_at);
		if (groups.at(-1)?.label !== label) groups.push({ label, events: [] });
		groups.at(-1).events.push(event);
	}

	return [
		html`<div class="page-narrow">${pageHead(
			t("events.title"),
			events.length
				? tn("events.count", events.length)
				: t("events.subtitle"),
			html`<a
				class="btn btn-primary fab"
				href="#/new"
				aria-label="${t("events.new")}"
				>${icon("plus")}<span>${t("events.new")}</span></a
			>`,
		)}
		<div>
			${events.length
				? groups.map(
						(g) =>
							html`<section class="day-group">
								<h2 class="group-label">${g.label}</h2>
								<ul class="event-list">
									${g.events.map(eventCard)}
								</ul>
							</section>`,
					)
				: emptyState(
						"calendar",
						t("events.emptyTitle"),
						t("events.empty"),
						html`<a class="btn btn-primary" href="#/new"
							>${icon("plus")}${t("events.new")}</a
						>`,
					)}
		</div></div>`,
	];
}

function eventCard(event) {
	const mine = event.responses.find((r) => r.user_id === me.id);
	const going = event.responses
		.filter((r) => r.status === "yes")
		.sort(byName);
	const count = tally(event.responses);
	return html`<li>
		<a class="card event-card" href="#/event/${event.id}">
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
				</div>
				<div class="event-card-foot">
					${going.length > 0 && avatarStack(going)}
					<span class="muted small"
						>${count.yes
							? tn("people.going", count.yes)
							: t("people.nobody")}</span
					>
					${mine
						? statusPill(mine.status)
						: html`<span class="pill pending"
								>${t("rsvp.none")}</span
							>`}
				</div>
			</div>
		</a>
	</li>`;
}

async function viewEvent(id) {
	const event = await api.getEvent(id);
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

	const canManage = me.is_admin || event.created_by === me.id;
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
	const reload = () => show(viewEvent, id);

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
					>
						${icon("down")}
					</button>
				</div>
				${canManage &&
				html`<button
					class="btn btn-sm btn-soft"
					data-action="adopt"
					data-id="${p.id}"
					title="${t("proposals.adoptHint")}"
				>
					${icon("check")}${t("proposals.adopt")}
				</button>`}
				${(canManage || p.created_by === me.id) &&
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
			<div class="row-actions">
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
				${(canManage || item.created_by === me.id) &&
				deleteButton("deleteItem", item.id)}
			</div>
		</li>`;

	return [
		html`${backLink("#/", t("event.back"))}
			<div class="event-layout">
				<div class="col">
					<article class="card panel hero">
						<div class="hero-head">
							${dateTile(event.starts_at, "date-tile-lg")}
							<div class="hero-title">
								${isLive(event.starts_at) &&
								html`<span class="pill live"
									>${t("date.live")}</span
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
						</ul>
						${event.description &&
						html`<p class="desc">${event.description}</p>`}
						<div class="hero-actions">
							<button class="btn btn-sm" data-action="ics">
								${icon("download")}${t("event.addToCalendar")}
							</button>
							${canManage &&
							html`<a
									class="btn btn-sm"
									href="#/event/${event.id}/edit"
									>${icon("edit")}${t("event.edit")}</a
								>
								<button
									class="btn btn-sm btn-danger"
									data-action="deleteEvent"
								>
									${icon("trash")}${t("common.delete")}
								</button>`}
						</div>
					</article>

					<section class="card panel proposals-card">
						<div>
							<h2 class="card-title">
								${icon("bulb")}${t("proposals.title")}
							</h2>
							<p class="muted small">
								${t("proposals.subtitle")}
							</p>
						</div>
						${proposals.length > 0 &&
						html`<ul class="rows">
							${proposals.map(proposalRow)}
						</ul>`}
						<form class="add-form" data-submit="propose">
							<label class="field">
								<span>${t("proposals.date")}</span>
								<input
									name="starts_at"
									type="datetime-local"
									min="${toInput(new Date())}"
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
						</form>
					</section>

					<section class="card panel items-card">
						<div>
							<h2 class="card-title">
								${icon("package")}${t("items.title")}
							</h2>
							<p class="muted small">${t("items.subtitle")}</p>
						</div>
						${items.length > 0 &&
						html`<ul class="rows">
							${items.map(itemRow)}
						</ul>`}
						<form class="add-form single" data-submit="addItem">
							<input
								name="label"
								required
								maxlength="120"
								pattern="${NOT_BLANK}"
								placeholder="${t("items.placeholder")}"
								aria-label="${t("items.title")}"
							/>
							<button class="btn" aria-label="${t("items.add")}">
								${icon("plus")}<span class="hide-xs"
									>${t("items.add")}</span
								>
							</button>
						</form>
					</section>
				</div>

				<aside class="col">
					<section class="card panel rsvp">
						<h2 class="card-title">
							${icon("calendarCheck")}${t("rsvp.title")}
						</h2>
						<div
							class="rsvp-options"
							role="group"
							aria-label="${t("rsvp.title")}"
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
									>
										${icon(STATUS_ICON[s])}<span
											>${t(`rsvp.${s}`)}</span
										>
									</button>`,
							)}
						</div>
						${!mine &&
						html`<p class="muted small">${t("rsvp.pending")}</p>`}
						${mine &&
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
								<output aria-live="polite"
									>${mine.guests}</output
								>
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
						</div>`}
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
					</section>
				</aside>
			</div>`,
		{
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
					return notify(t("proposals.hint"), true);
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
	const event = id ? await api.getEvent(id) : null;
	if (id && !(event && (me.is_admin || event.created_by === me.id)))
		return void (location.hash = "#/");
	const back = id ? `#/event/${id}` : "#/";

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
						pattern="${NOT_BLANK}"
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
						${!id && html`min="${toInput(new Date())}"`}
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
			save: async (form) => {
				const data = {
					title: form.title.trim(),
					starts_at: fromInput(form.starts_at),
					location: form.location.trim() || null,
					description: form.description.trim() || null,
				};
				if (id) await api.updateEvent(id, data);
				const savedId = id ?? (await api.createEvent(data)).id;
				notify(t(id ? "common.saved" : "form.created"));
				location.hash = `#/event/${savedId}`;
			},
		},
	];
}

function viewAccount() {
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
						pattern="${NOT_BLANK}"
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
						minlength="8"
					/>
				</label>
				<p class="form-error" role="alert" hidden></p>
				<div class="form-actions">
					<button class="btn btn-primary">
						${t("account.changePassword")}
					</button>
				</div>
			</form>
		</div>`,
		{
			name: async ({ display_name }) => {
				const name = display_name.trim();
				await api.updateProfile(me.id, name);
				me.display_name = name;
				notify(t("common.saved"));
				render();
			},
			password: async ({ password, confirm }, form) => {
				const error = form.querySelector(".form-error");
				error.hidden = password === confirm;
				if (password !== confirm)
					return void (error.textContent = t(
						"account.passwordMismatch",
					));
				await api.changePassword(password);
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
								pattern="${NOT_BLANK}"
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
									? html`<span class="btn-icon" aria-hidden="true"></span>`
									: deleteButton("deleteUser", u.id, u.display_name)}
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
				await api.admin("create", user);
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
				renderNav();
				return void mount(app, errorState(err.message));
			}
		}
		render();
	});
} else {
	render();
}
