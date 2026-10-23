import { t } from "./i18n.js";

const ESCAPES = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

class Safe {
	constructor(value) {
		this.value = value;
	}
	toString() {
		return this.value;
	}
}

const render = (v) =>
	v instanceof Safe
		? v.value
		: Array.isArray(v)
			? v.map(render).join("")
			: v == null || v === false
				? ""
				: String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Template tag: esegue l'escape di ogni valore interpolato, tranne i frammenti html`` annidati. */
export const html = (strings, ...values) =>
	new Safe(strings.reduce((out, s, i) => out + render(values[i - 1]) + s));

// Chiave stabile di un campo o di un pulsante d'azione, per ritrovarlo dopo un re-render.
const keyOf = (el) =>
	el.name && el.form
		? `field|${el.form.dataset.submit}|${el.name}`
		: el.dataset?.action &&
			`action|${el.dataset.action}|${el.dataset.id}|${el.dataset.status}|${el.dataset.value}|${el.dataset.delta}`;

const isDirty = (el) =>
	el.type === "checkbox"
		? el.checked !== el.defaultChecked
		: el.value !== el.defaultValue;

/** Testo digitato e non ancora inviato, più focus e cursore: sopravvivono al re-render della stessa pagina. */
function snapshot(root) {
	const values = new Map();
	for (const el of root.querySelectorAll(
		"form[data-submit]:not([data-sent]) [name]",
	))
		if (isDirty(el))
			values.set(
				keyOf(el),
				el.type === "checkbox" ? el.checked : el.value,
			);
	const active = root.contains(document.activeElement)
		? document.activeElement
		: null;
	const focus = active &&
		keyOf(active) && {
			key: keyOf(active),
			start: active.selectionStart,
			end: active.selectionEnd,
		};
	return { values, focus };
}

function restore(root, { values, focus }) {
	for (const el of root.querySelectorAll(
		"form[data-submit] [name], [data-action]",
	)) {
		const key = keyOf(el);
		if (values.has(key)) {
			if (el.type === "checkbox") el.checked = values.get(key);
			else el.value = values.get(key);
		}
		if (key && key === focus?.key) {
			el.focus({ preventScroll: true });
			if (focus.start != null)
				el.setSelectionRange?.(focus.start, focus.end);
		}
	}
}

/**
 * Renderizza il markup in root e collega i click su [data-action] e i submit di form[data-submit].
 * Mentre un'azione è in corso le altre vengono ignorate, così i doppi click non generano richieste concorrenti.
 * Se si ri-renderizza la stessa pagina (es. aggiornamento in tempo reale) il testo non inviato e il focus restano.
 */
export function mount(root, markup, actions = {}) {
	const page = location.hash;
	const kept = root.dataset.page === page ? snapshot(root) : null;
	let busy = false;
	const run = (fn) => {
		busy = true;
		root.classList.add("is-busy");
		return guard(fn).finally(() => {
			busy = false;
			root.classList.remove("is-busy");
		});
	};

	root.innerHTML = markup;
	root.dataset.page = page;
	if (kept) restore(root, kept);
	root.onclick = (e) => {
		const el = e.target.closest("[data-action]");
		const fn = el && actions[el.dataset.action];
		if (!fn) return;
		if (busy) return void e.preventDefault();
		run(() => fn(el.dataset, el));
	};
	root.onsubmit = (e) => {
		const form = e.target;
		const fn = actions[form.dataset.submit];
		if (!fn) return;
		e.preventDefault();
		if (busy) return;
		const button = e.submitter;
		if (button) button.disabled = true;
		// Un form inviato non va ripristinato dal re-render che segue il salvataggio.
		form.dataset.sent = "";
		run(() => fn(Object.fromEntries(new FormData(form)), form)).finally(
			() => {
				delete form.dataset.sent;
				if (button) button.disabled = false;
			},
		);
	};
}

async function guard(fn) {
	try {
		await fn();
	} catch (err) {
		notify(err.message ?? String(err), true);
	}
}

let toastTimer;
export function notify(message, isError = false) {
	const toast = document.getElementById("toast");
	toast.textContent = message;
	toast.className = isError ? "show error" : "show";
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (toast.className = ""), 3500);
}

/**
 * Dialog modale. Restituisce true (o il valore dell'input) se confermato, null se annullato.
 * `body` accetta un frammento html`` già sicuro; i suoi elementi [data-handler] chiamano `handlers[nome](el, dialog)`.
 */
export function ask({
	title,
	message,
	body,
	input,
	confirm = t("common.confirm"),
	cancel = t("common.cancel"),
	danger = false,
	handlers = {},
}) {
	const dialog = document.getElementById("dialog");
	dialog.innerHTML = html` <form method="dialog" class="dialog-form">
		<h2>${title}</h2>
		${message && html`<p class="muted">${message}</p>`} ${body}
		${input &&
		html` <div class="field">
			<label for="dialog-input">${input.label}</label>
			<div class="input-group">
				<input
					id="dialog-input"
					value="${input.value}"
					required
					minlength="${input.minlength ?? 1}"
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
				/>
				${input.generate &&
				html`<button
					type="button"
					class="btn-icon"
					data-generate
					title="${t("admin.generate")}"
					aria-label="${t("admin.generate")}"
				>
					${icon("refresh")}
				</button>`}
			</div>
		</div>`}
		<div class="dialog-actions">
			${cancel &&
			html`<button class="btn btn-ghost" value="cancel" formnovalidate>
				${cancel}
			</button>`}
			<button
				class="btn ${danger ? "btn-danger-solid" : "btn-primary"}"
				value="ok"
			>
				${confirm}
			</button>
		</div>
	</form>`;
	dialog.returnValue = "";
	dialog.showModal();

	return new Promise((resolve) => {
		dialog.onclick = async (e) => {
			if (e.target === dialog) return dialog.close();
			const handler = e.target.closest("[data-handler]");
			if (handler)
				return handlers[handler.dataset.handler]?.(handler, dialog);
			if (e.target.closest("[data-generate]")) {
				dialog.querySelector("#dialog-input").value = randomPassword();
			}
			const copy = e.target.closest("[data-copy]");
			if (copy) {
				await navigator.clipboard.writeText(copy.dataset.copy);
				const label = copy.querySelector("span");
				const original = label.textContent;
				label.textContent = t("common.copied");
				setTimeout(() => (label.textContent = original), 2000);
			}
		};
		dialog.addEventListener(
			"close",
			() => {
				if (dialog.returnValue !== "ok") return resolve(null);
				resolve(
					input
						? dialog.querySelector("#dialog-input").value.trim()
						: true,
				);
			},
			{ once: true },
		);
	});
}

// Icone in stile Lucide (24×24, stroke).
const ICONS = {
	alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
	archive:
		'<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
	mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
	message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
	more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
	send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
	share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>',
	back: '<path d="m15 18-6-6 6-6"/>',
	bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4"/>',
	calendar:
		'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
	calendarCheck:
		'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4"/>',
	check: '<path d="M20 6 9 17l-5-5"/>',
	chevronDown: '<path d="m6 9 6 6 6-6"/>',
	clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
	copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
	down: '<path d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>',
	download:
		'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
	edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
	globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
	help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
	key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
	logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
	minus: '<path d="M5 12h14"/>',
	package:
		'<path d="m7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
	pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	refresh:
		'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/>',
	settings:
		'<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
	trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
	up: '<path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
	user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
	userPlus:
		'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
	users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
	x: '<path d="M18 6 6 18M6 6l12 12"/>',
};

export const icon = (name, cls = "") =>
	html`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">
		${new Safe(ICONS[name])}
	</svg>`;

/** Avatar con iniziali; il colore è stabile perché derivato da `seed` (di solito l'id utente). */
export function avatar(name, seed = name, size = "") {
	const label = name ?? "?";
	const initials =
		label
			.trim()
			.split(/\s+/)
			.slice(0, 2)
			.map((word) => [...word][0] ?? "")
			.join("")
			.toUpperCase() || "?";
	// FNV-1a: distribuisce bene le tonalità anche tra id molto simili.
	let hash = 2166136261;
	for (const c of String(seed))
		hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
	return html`<span
		class="avatar ${size && `avatar-${size}`}"
		style="--hue: ${hash % 360}"
		title="${label}"
		aria-hidden="true"
		>${initials}</span
	>`;
}

export function randomPassword(length = 12) {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
	return Array.from(
		crypto.getRandomValues(new Uint32Array(length)),
		(n) => chars[n % chars.length],
	).join("");
}

export function downloadFile(name, content, type) {
	const url = URL.createObjectURL(new Blob([content], { type }));
	Object.assign(document.createElement("a"), {
		href: url,
		download: name,
	}).click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const pad = (n) => String(n).padStart(2, "0");

/** Date → valore per <input type="datetime-local"> nel fuso orario locale. */
export const toInput = (d) =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const fromInput = (value) => new Date(value).toISOString();
