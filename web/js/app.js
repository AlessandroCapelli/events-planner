import * as api from "./api.js";
import { fmtDate, lang, setLang, t } from "./i18n.js";
import { fromInput, html, mount, notify, toInput } from "./ui.js";

const app = document.getElementById("app");
const nav = document.getElementById("nav");
const STATUSES = ["yes", "maybe", "no"];

/** Profilo dell'utente loggato, o null. */
let me = null;

const routes = [
	[/^\/$/, viewEvents],
	[/^\/new$/, () => viewEventForm()],
	[/^\/event\/([\w-]+)$/, viewEvent],
	[/^\/event\/([\w-]+)\/edit$/, viewEventForm],
	[/^\/account$/, viewAccount],
	[/^\/admin$/, viewAdmin],
];

async function render() {
	if (!api.configured)
		return void (app.textContent = t("common.missingConfig"));
	renderNav();
	if (!me) return viewLogin();

	const path = location.hash.slice(1) || "/";
	const route = routes.find(([re]) => re.test(path));
	if (!route) return void (location.hash = "#/");

	app.innerHTML = html`<p class="muted">${t("common.loading")}</p>`;
	try {
		await route[1](...path.match(route[0]).slice(1));
	} catch (err) {
		app.innerHTML = html`<p class="error">
			${t("common.error", { msg: err.message })}
		</p>`;
	}
}

function renderNav() {
	const other = lang() === "it" ? "en" : "it";
	mount(
		nav,
		html` ${me &&
			html` <a href="#/">${t("nav.events")}</a>
				${me.is_admin && html`<a href="#/admin">${t("nav.admin")}</a>`}
				<a href="#/account">${me.display_name}</a>`}
			<button class="link" data-action="lang" data-lang="${other}">
				${other.toUpperCase()}
			</button>
			${me &&
			html`<button class="link" data-action="logout">
				${t("nav.logout")}
			</button>`}`,
		{
			lang: (data) => {
				setLang(data.lang);
				render();
			},
			logout: () => api.signOut(),
		},
	);
}

// Somma le persone per stato, contando anche gli accompagnatori di chi viene o forse viene.
const tally = (responses) =>
	responses.reduce(
		(sum, r) => {
			sum[r.status] += r.status === "no" ? 1 : 1 + r.guests;
			return sum;
		},
		{ yes: 0, maybe: 0, no: 0 },
	);

const score = (proposal) => proposal.votes.reduce((sum, v) => sum + v.value, 0);

// ── Viste ────────────────────────────────────────────────────────────────

function viewLogin() {
	mount(
		app,
		html` <form class="card stack narrow" data-submit="login">
			<h1>${t("login.title")}</h1>
			<label
				>${t("login.email")}<input
					name="email"
					type="email"
					autocomplete="username"
					required
			/></label>
			<label
				>${t("login.password")}<input
					name="password"
					type="password"
					autocomplete="current-password"
					required
			/></label>
			<button class="btn primary">${t("login.submit")}</button>
			<p class="muted small">${t("login.hint")}</p>
		</form>`,
		{
			login: ({ email, password }) => api.signIn(email, password),
		},
	);
}

async function viewEvents() {
	const events = await api.listEvents();
	mount(
		app,
		html` <div class="row">
				<h1>${t("events.title")}</h1>
				<a class="btn primary" href="#/new">${t("events.new")}</a>
			</div>
			${events.length
				? html`<ul class="cards">
						${events.map(eventCard)}
					</ul>`
				: html`<p class="muted">${t("events.empty")}</p>`}`,
	);
}

function eventCard(event) {
	const mine = event.responses.find((r) => r.user_id === me.id);
	const count = tally(event.responses);
	return html` <li>
		<a class="card" href="#/event/${event.id}">
			<strong>${event.title}</strong>
			<span class="muted"
				>${fmtDate(event.starts_at)}${event.location &&
				` · ${event.location}`}</span
			>
			<div class="small">
				✓ ${count.yes} · ? ${count.maybe}
				${mine &&
				html`<span class="badge ${mine.status}"
					>${t(`rsvp.${mine.status}`)}</span
				>`}
			</div>
		</a>
	</li>`;
}

async function viewEvent(id) {
	const event = await api.getEvent(id);
	if (!event) {
		return mount(
			app,
			html`<p>${t("event.notFound")}</p>
				<a href="#/">${t("event.back")}</a>`,
		);
	}

	const canManage = me.is_admin || event.created_by === me.id;
	const mine = event.responses.find((r) => r.user_id === me.id);
	const count = tally(event.responses);
	const proposals = [...event.proposals].sort((a, b) => score(b) - score(a));
	const items = [...event.items].sort((a, b) =>
		a.created_at.localeCompare(b.created_at),
	);
	const reload = () => viewEvent(id);

	const proposalRow = (p) => {
		const myVote = p.votes.find((v) => v.user_id === me.id)?.value ?? 0;
		const total = score(p);
		return html` <li>
			<div class="grow">
				${p.starts_at &&
				html`📅 ${fmtDate(p.starts_at)} `}${p.location &&
				html`📍 ${p.location}`}
				<div class="muted small">${p.author?.display_name}</div>
			</div>
			<button
				class="btn icon ${myVote === 1 && "active yes"}"
				data-action="vote"
				data-id="${p.id}"
				data-value="1"
			>
				👍
			</button>
			<strong>${total > 0 ? `+${total}` : total}</strong>
			<button
				class="btn icon ${myVote === -1 && "active no"}"
				data-action="vote"
				data-id="${p.id}"
				data-value="-1"
			>
				👎
			</button>
			${canManage &&
			html`<button class="btn" data-action="adopt" data-id="${p.id}">
				${t("proposals.adopt")}
			</button>`}
			${(canManage || p.created_by === me.id) &&
			html` <button
				class="btn icon danger"
				data-action="deleteProposal"
				data-id="${p.id}"
				title="${t("common.delete")}"
			>
				✕
			</button>`}
		</li>`;
	};

	const itemRow = (item) =>
		html` <li>
			<span class="grow">
				${item.label}
				${item.claimer &&
				html`<span class="muted small">
					—
					${t("items.claimedBy", {
						name: item.claimer.display_name,
					})}</span
				>`}
			</span>
			${!item.claimed_by &&
			html`<button class="btn" data-action="claim" data-id="${item.id}">
				${t("items.claim")}
			</button>`}
			${item.claimed_by === me.id &&
			html`<button class="btn" data-action="unclaim" data-id="${item.id}">
				${t("items.unclaim")}
			</button>`}
			${(canManage || item.created_by === me.id) &&
			html` <button
				class="btn icon danger"
				data-action="deleteItem"
				data-id="${item.id}"
				title="${t("common.delete")}"
			>
				✕
			</button>`}
		</li>`;

	mount(
		app,
		html` <a href="#/">${t("event.back")}</a>
			<article>
				<h1>${event.title}</h1>
				<p>
					📅
					${fmtDate(event.starts_at)}${event.location &&
					html`<br />📍 ${event.location}`}
				</p>
				${event.description &&
				html`<p class="desc">${event.description}</p>`}
				<p class="muted small">
					${t("event.by", {
						name: event.creator?.display_name ?? "—",
					})}
				</p>
				${canManage &&
				html` <div class="actions">
					<a class="btn" href="#/event/${event.id}/edit"
						>${t("event.edit")}</a
					>
					<button class="btn danger" data-action="deleteEvent">
						${t("common.delete")}
					</button>
				</div>`}
			</article>

			<section>
				<h2>${t("rsvp.title")}</h2>
				<div class="segmented">
					${STATUSES.map(
						(s) =>
							html` <button
								class="btn ${mine?.status === s &&
								`active ${s}`}"
								data-action="respond"
								data-status="${s}"
							>
								${t(`rsvp.${s}`)}
							</button>`,
					)}
				</div>
				${mine &&
				mine.status !== "no" &&
				html` <div class="guests">
					<span>${t("rsvp.guests")}</span>
					<button
						class="btn icon"
						data-action="guests"
						data-delta="-1"
						${!mine.guests && "disabled"}
					>
						−
					</button>
					<strong>+${mine.guests}</strong>
					<button
						class="btn icon"
						data-action="guests"
						data-delta="1"
						${mine.guests >= 20 && "disabled"}
					>
						+
					</button>
				</div>`}
			</section>

			<section>
				<h2>${t("people.title")}</h2>
				${event.responses.length
					? html` <p class="muted small">
								${t("people.summary", count)}
							</p>
							${STATUSES.map((s) => {
								const group = event.responses.filter(
									(r) => r.status === s,
								);
								return (
									group.length > 0 &&
									html` <div class="group">
										<span class="badge ${s}"
											>${t(`rsvp.${s}`)}</span
										>
										${group.map(
											(r) =>
												html`<span class="chip"
													>${r.profile
														?.display_name}${s !==
														"no" &&
													r.guests > 0 &&
													` +${r.guests}`}</span
												>`,
										)}
									</div>`
								);
							})}`
					: html`<p class="muted">${t("people.empty")}</p>`}
			</section>

			<section>
				<h2>${t("proposals.title")}</h2>
				${proposals.length
					? html`<ul class="list">
							${proposals.map(proposalRow)}
						</ul>`
					: html`<p class="muted">${t("proposals.empty")}</p>`}
				<form class="inline" data-submit="propose">
					<input
						name="starts_at"
						type="datetime-local"
						min="${toInput(new Date())}"
					/>
					<input
						name="location"
						maxlength="200"
						placeholder="${t("proposals.location")}"
					/>
					<button class="btn">${t("proposals.add")}</button>
				</form>
			</section>

			<section>
				<h2>${t("items.title")}</h2>
				${items.length
					? html`<ul class="list">
							${items.map(itemRow)}
						</ul>`
					: html`<p class="muted">${t("items.empty")}</p>`}
				<form class="inline" data-submit="addItem">
					<input
						name="label"
						required
						maxlength="120"
						placeholder="${t("items.placeholder")}"
					/>
					<button class="btn">${t("items.add")}</button>
				</form>
			</section>`,
		{
			deleteEvent: async () => {
				if (!confirm(t("event.confirmDelete"))) return;
				await api.deleteEvent(id);
				location.hash = "#/";
			},
			respond: async ({ status }) => {
				await api.respond(
					id,
					me.id,
					status,
					status === "no" ? 0 : (mine?.guests ?? 0),
				);
				await reload();
			},
			guests: async ({ delta }) => {
				await api.respond(
					id,
					me.id,
					mine.status,
					Math.min(20, Math.max(0, mine.guests + Number(delta))),
				);
				await reload();
			},
			propose: async ({ starts_at, location }) => {
				if (!starts_at && !location.trim())
					return notify(t("proposals.hint"), true);
				await api.addProposal(id, {
					starts_at: starts_at ? fromInput(starts_at) : null,
					location: location.trim() || null,
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
				if (!confirm(t("proposals.confirmAdopt"))) return;
				await api.adoptProposal(pid);
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
				await api.claimItem(itemId, me.id);
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
	);
}

async function viewEventForm(id) {
	const event = id ? await api.getEvent(id) : null;
	if (id && !(event && (me.is_admin || event.created_by === me.id)))
		return void (location.hash = "#/");

	mount(
		app,
		html` <h1>${t(id ? "form.editTitle" : "form.newTitle")}</h1>
			<form class="stack" data-submit="save">
				<label
					>${t("form.title")}<input
						name="title"
						required
						maxlength="120"
						value="${event?.title}"
				/></label>
				<label
					>${t("form.startsAt")}
					<input
						name="starts_at"
						type="datetime-local"
						required
						value="${event && toInput(new Date(event.starts_at))}"
						${!id && html`min="${toInput(new Date())}"`}
					/>
				</label>
				<label
					>${t("form.location")}<input
						name="location"
						maxlength="200"
						value="${event?.location}"
				/></label>
				<label
					>${t("form.description")}<textarea
						name="description"
						rows="4"
						maxlength="2000"
					>
${event?.description}</textarea
					>
				</label>
				<div class="actions">
					<button class="btn primary">${t("common.save")}</button>
					<a class="btn" href="${id ? `#/event/${id}` : "#/"}"
						>${t("common.cancel")}</a
					>
				</div>
			</form>`,
		{
			save: async (form) => {
				const data = {
					title: form.title.trim(),
					starts_at: fromInput(form.starts_at),
					location: form.location.trim() || null,
					description: form.description.trim() || null,
				};
				const savedId = id ?? (await api.createEvent(data)).id;
				if (id) await api.updateEvent(id, data);
				location.hash = `#/event/${savedId}`;
			},
		},
	);
}

function viewAccount() {
	mount(
		app,
		html` <h1>${t("account.title")}</h1>
			<form class="stack" data-submit="name">
				<label
					>${t("account.name")}<input
						name="display_name"
						required
						maxlength="60"
						value="${me.display_name}"
				/></label>
				<button class="btn">${t("common.save")}</button>
			</form>
			<form class="stack" data-submit="password">
				<label
					>${t("account.password")}<input
						name="password"
						type="password"
						autocomplete="new-password"
						required
						minlength="8"
				/></label>
				<button class="btn">${t("account.changePassword")}</button>
			</form>`,
		{
			name: async ({ display_name }) => {
				await api.updateProfile(me.id, display_name.trim());
				me.display_name = display_name.trim();
				renderNav();
				notify(t("common.saved"));
			},
			password: async ({ password }, form) => {
				await api.changePassword(password);
				form.reset();
				notify(t("common.saved"));
			},
		},
	);
}

async function viewAdmin() {
	if (!me.is_admin) return void (location.hash = "#/");
	const users = await api.admin("list");

	mount(
		app,
		html` <h1>${t("admin.title")}</h1>
			<ul class="list">
				${users.map(
					(u) =>
						html` <li>
							<div class="grow">
								<strong>${u.display_name}</strong>
								<div class="muted small">${u.email}</div>
							</div>
							<label class="check">
								<input
									type="checkbox"
									data-action="toggleAdmin"
									data-id="${u.id}"
									${u.is_admin && "checked"}
									${u.id === me.id && "disabled"}
								/>
								${t("admin.isAdmin")}
							</label>
							<button
								class="btn"
								data-action="resetPassword"
								data-id="${u.id}"
								data-name="${u.display_name}"
							>
								${t("admin.resetPassword")}
							</button>
							${u.id !== me.id &&
							html` <button
								class="btn danger"
								data-action="deleteUser"
								data-id="${u.id}"
								data-name="${u.display_name}"
							>
								${t("common.delete")}
							</button>`}
						</li>`,
				)}
			</ul>

			<h2>${t("admin.create")}</h2>
			<form class="stack" data-submit="create">
				<label
					>${t("admin.name")}<input
						name="display_name"
						required
						maxlength="60"
				/></label>
				<label
					>${t("login.email")}<input
						name="email"
						type="email"
						required
				/></label>
				<label
					>${t("admin.password")}<input
						name="password"
						required
						minlength="8"
						autocomplete="off"
				/></label>
				<label class="check"
					><input name="is_admin" type="checkbox" /> ${t(
						"admin.isAdmin",
					)}</label
				>
				<button class="btn primary">${t("admin.add")}</button>
			</form>`,
		{
			create: async (form) => {
				await api.admin("create", {
					...form,
					display_name: form.display_name.trim(),
					is_admin: form.is_admin === "on",
				});
				notify(t("admin.created"));
				await viewAdmin();
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
				const password = prompt(t("admin.newPassword", { name }));
				if (!password) return;
				await api.admin("update", { id, password });
				notify(t("common.saved"));
			},
			deleteUser: async ({ id, name }) => {
				if (!confirm(t("admin.confirmDelete", { name }))) return;
				await api.admin("delete", { id });
				await viewAdmin();
			},
		},
	);
}

// ── Avvio ────────────────────────────────────────────────────────────────

window.addEventListener("hashchange", render);

if (api.configured) {
	api.onUserChange(async (userId) => {
		me = userId ? await api.getProfile(userId).catch(() => null) : null;
		if (userId && !me) return void api.signOut();
		render();
	});
} else {
	render();
}
