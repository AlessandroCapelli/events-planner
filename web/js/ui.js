import { fmtDate, t } from "./i18n.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Markup that is already escaped and must be inserted verbatim. */
class Safe {
	constructor(value) {
		this.value = value;
	}
	toString() {
		return this.value;
	}
}

/** Turns an interpolated value into markup: escapes text, flattens arrays, drops null and false. */
const render = (v) =>
	v instanceof Safe
		? v.value
		: Array.isArray(v)
			? v.map(render).join("")
			: v == null || v === false
				? ""
				: String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Template tag that escapes every interpolated value except nested html`` fragments. */
export const html = (strings, ...values) => new Safe(strings.reduce((out, s, i) => out + render(values[i - 1]) + s));

const isToggle = (el) => el.type === "checkbox" || el.type === "radio";

/** Stable identity of a form field or action button, to find it again after a re-render. */
const keyOf = (el) =>
	el.name && el.form
		? `field|${el.form.dataset.submit}|${el.name}${isToggle(el) ? `|${el.value}` : ""}`
		: el.dataset?.action &&
			`action|${el.dataset.action}|${el.dataset.id}|${el.dataset.status}|${el.dataset.value}|${el.dataset.delta}`;

const isDirty = (el) =>
	isToggle(el)
		? el.checked !== el.defaultChecked
		: el.tagName === "SELECT"
			? [...el.options].some((option) => option.selected !== option.defaultSelected)
			: el.value !== el.defaultValue;

/** Captures unsent input, generated passwords, open panels, focus and caret, so a re-render can keep them. */
function snapshot(root) {
	const values = new Map();
	for (const el of root.querySelectorAll("form[data-submit] [name]"))
		if (isDirty(el) || el.hasAttribute("data-generate-on-success"))
			values.set(keyOf(el), isToggle(el) ? el.checked : el.value);
	const open = [...root.querySelectorAll("details")].map((d) => d.open);
	const active = root.contains(document.activeElement) ? document.activeElement : null;
	const focus = active &&
		keyOf(active) && { key: keyOf(active), start: active.selectionStart, end: active.selectionEnd };
	return { values, focus, open };
}

/** Reapplies a `snapshot()` to freshly rendered markup. */
function restore(root, { values, focus, open }) {
	const details = root.querySelectorAll("details");
	if (details.length === open.length) details.forEach((d, i) => (d.open = open[i]));
	for (const el of root.querySelectorAll("form[data-submit] [name], [data-action]")) {
		const key = keyOf(el);
		if (values.has(key)) {
			if (isToggle(el)) el.checked = values.get(key);
			else if (el.tagName !== "SELECT" || [...el.options].some((option) => option.value === values.get(key)))
				el.value = values.get(key);
		}
		if (key && key === focus?.key) {
			el.focus({ preventScroll: true });
			if (focus.start != null) el.setSelectionRange?.(focus.start, focus.end);
		}
	}
}

/** Error tied to a form field: its message is shown under that field. */
export class FieldError extends Error {
	constructor(field, message) {
		super(message);
		this.field = field;
	}
}

/** User-facing message for network, permission and database constraint errors. */
export function describeError(err) {
	const message = err?.message ?? String(err);
	if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(message)) return t("error.network");
	if (err?.code === "42501" || /row-level security|permission denied/i.test(message)) return t("error.forbidden");
	if (err?.code === "23503") return t("error.gone");
	if (err?.code === "23505") return t("error.duplicate");
	return message;
}

/** Translated validation message for a field, or null when it is valid. */
function invalidMessage(el) {
	if (isToggle(el)) return null;
	const value = el.value ?? "";
	if (el.validity.badInput) return t("validation.badInput");
	if (el.required && !value.trim()) return t("validation.required");
	if (el.type === "email" && el.validity.typeMismatch) return t("validation.email");
	if (el.minLength > 0 && value && value.length < el.minLength) return t("validation.tooShort", { n: el.minLength });
	if (el.maxLength > 0 && value.length > el.maxLength) return t("validation.tooLong", { n: el.maxLength });
	if (el.min && value && value < el.min) return t("validation.tooEarly", { date: fmtDate(fromInput(el.min)) });
	if (el.dataset.match && value !== el.form.elements[el.dataset.match].value) return t("validation.mismatch");
	return null;
}

/** Element that holds the error message of a field. */
const errorBox = (el) => el.closest("fieldset, .field") ?? el.parentElement;

function showFieldError(el, message) {
	const box = errorBox(el);
	let note = box.querySelector(":scope > .field-error");
	if (!note) {
		note = Object.assign(document.createElement("p"), { className: "field-error", id: `error-${crypto.randomUUID()}` });
		box.append(note);
	}
	note.innerHTML = html`${icon("alert")}<span>${message}</span>`;
	el.setAttribute("aria-invalid", "true");
	el.setAttribute("aria-describedby", note.id);
}

function clearFieldError(el) {
	const box = errorBox(el);
	box.querySelector(":scope > .field-error")?.remove();
	for (const field of [el, ...box.querySelectorAll("[aria-invalid]")]) {
		field.removeAttribute("aria-invalid");
		field.removeAttribute("aria-describedby");
	}
}

/** Shows a form-level error above the form actions. */
function showFormError(form, message) {
	let note = form.querySelector(":scope > .form-error");
	if (!note) {
		note = Object.assign(document.createElement("p"), { className: "form-error" });
		note.setAttribute("role", "alert");
		const anchor =
			!form.classList.contains("add-form") &&
			(form.querySelector(":scope > .form-actions") ?? form.querySelector(":scope > button:not([type='button'])"));
		if (anchor) anchor.before(note);
		else form.append(note);
	}
	note.innerHTML = html`${icon("alert")}<span>${message}</span>`;
	note.hidden = false;
}

function clearErrors(form) {
	for (const el of form.querySelectorAll("[aria-invalid]")) clearFieldError(el);
	const note = form.querySelector(":scope > .form-error");
	if (note) note.hidden = true;
}

/** Validates every field, shows the errors and focuses the first invalid one. */
function validate(form) {
	let first = null;
	for (const el of form.elements) {
		if (!el.name || el.disabled) continue;
		const message = invalidMessage(el);
		if (!message) continue;
		showFieldError(el, message);
		first ??= el;
	}
	first?.focus();
	return !first;
}

/** Shows a submit error on its field, on the form, or as a toast if the form is gone. */
function reportFormError(form, err) {
	if (!form.isConnected) return notify(describeError(err), true);
	const target = err instanceof FieldError && form.elements[err.field];
	const field = target instanceof RadioNodeList ? target[0] : target;
	if (field) {
		showFieldError(field, err.message);
		field.focus();
	} else showFormError(form, describeError(err));
}

function submittedFields(form) {
	return [...form.elements]
		.filter((el) => el.name && !el.disabled)
		.map((el) => ({ el, value: el.value, checked: el.checked }));
}

/**
 * Makes the submitted values the new defaults (or resets them with `data-reset-on-success`);
 * anything typed while the request was running stays as an unsent draft.
 */
function finishForm(form, fields) {
	const reset = form.hasAttribute("data-reset-on-success");
	for (const { el, value, checked } of fields) {
		if (isToggle(el)) {
			const current = el.checked;
			const next = reset ? el.defaultChecked : checked;
			el.defaultChecked = next;
			el.checked = current === checked ? next : current;
		} else {
			const current = el.value;
			const next = reset ? (el.hasAttribute("data-generate-on-success") ? randomPassword() : el.defaultValue) : value;
			el.defaultValue = next;
			el.value = current === value ? next : current;
		}
	}
}

const mounts = new WeakMap();

/** Forgets the mount state of `root`, so the next `mount()` starts a fresh page. */
export function resetMount(root) {
	mounts.delete(root);
	delete root.dataset.page;
	root.classList.remove("is-busy");
}

/**
 * Renders `markup` into `root` and wires `[data-action]` clicks, `[data-change]` changes and `form[data-submit]`
 * submits to `actions`.
 * One action runs at a time, so double clicks never send concurrent requests; a render that arrives
 * meanwhile is applied when the action ends. Re-rendering the same page keeps unsent input and focus.
 */
export function mount(root, markup, actions = {}) {
	const page = location.hash;
	let state = mounts.get(root);
	if (state?.page !== page) {
		state = { page, busy: false, pending: null };
		mounts.set(root, state);
	}
	if (state.busy) {
		state.pending = [markup, actions];
		return;
	}
	const kept = root.dataset.page === page ? snapshot(root) : null;
	const run = (fn) => {
		state.busy = true;
		root.classList.add("is-busy");
		return guard(fn).finally(() => {
			state.busy = false;
			if (mounts.get(root) !== state || location.hash !== page) return;
			root.classList.remove("is-busy");
			const pending = state.pending;
			state.pending = null;
			if (pending) {
				mount(root, ...pending);
				if (state.formError) {
					const form = [...root.querySelectorAll("form[data-submit]")].find(
						(el) => el.dataset.submit === state.formError.submit,
					);
					if (form) reportFormError(form, state.formError.error);
				}
			}
			state.formError = null;
		});
	};

	root.innerHTML = markup;
	root.dataset.page = page;
	for (const form of root.querySelectorAll("form[data-submit]")) form.noValidate = true;
	if (kept) restore(root, kept);
	root.oninput = (e) => e.target.form && clearFieldError(e.target);
	root.onchange = (e) => {
		const fn = actions[e.target.dataset.change];
		if (fn && !state.busy) run(() => fn(e.target.dataset, e.target));
	};
	root.onclick = (e) => {
		const el = e.target.closest("[data-action]");
		const fn = el && actions[el.dataset.action];
		if (!fn) return;
		if (state.busy) return void e.preventDefault();
		run(() => fn(el.dataset, el));
	};
	root.onsubmit = (e) => {
		const form = e.target;
		const fn = actions[form.dataset.submit];
		if (!fn) return;
		e.preventDefault();
		if (state.busy) return;
		clearErrors(form);
		if (!validate(form)) return;
		const fields = submittedFields(form);
		const button = e.submitter;
		if (button) button.disabled = true;
		run(async () => {
			try {
				await fn(Object.fromEntries(new FormData(form)), form);
				finishForm(form, fields);
			} catch (err) {
				state.formError = { submit: form.dataset.submit, error: err };
				reportFormError(form, err);
			}
		}).finally(() => {
			if (button) button.disabled = false;
		});
	};
}

/** Runs `fn` and shows any error as a toast. */
async function guard(fn) {
	try {
		await fn();
	} catch (err) {
		notify(describeError(err), true);
	}
}

let toastTimer;
/** Shows a short-lived toast message. */
export function notify(message, isError = false) {
	const toast = document.getElementById("toast");
	toast.textContent = message;
	toast.className = isError ? "show error" : "show";
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (toast.className = ""), 3500);
}

/**
 * Opens the modal dialog. Resolves to true, or the input value, when confirmed and to null otherwise.
 * `body` is an html`` fragment whose `[data-handler]` elements call `handlers[name](el, dialog)`;
 * `[data-copy]` buttons copy their value to the clipboard. `check(form)` may return a message that blocks confirming.
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
	check,
}) {
	const dialog = document.getElementById("dialog");
	if (dialog.open) return Promise.resolve(null);
	dialog.setAttribute("aria-labelledby", "dialog-title");
	dialog.innerHTML = html` <form method="dialog" class="dialog-form">
		<h2 id="dialog-title">${title}</h2>
		${message && html`<p class="muted">${message}</p>`} ${body}
		${input &&
		html` <div class="field">
			<label for="dialog-input">${input.label}</label>
			<div class="input-group">
				<input
					id="dialog-input"
					name="value"
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
			${cancel && html`<button class="btn btn-ghost" value="cancel">${cancel}</button>`}
			<button class="btn ${danger ? "btn-danger-solid" : "btn-primary"}" value="ok">${confirm}</button>
		</div>
	</form>`;
	dialog.returnValue = "";
	const form = dialog.querySelector("form");
	form.noValidate = true;
	form.onsubmit = (e) => {
		clearErrors(form);
		if (e.submitter?.value !== "ok") return;
		if (!validate(form)) return void e.preventDefault();
		const message = check?.(form);
		if (message) {
			showFormError(form, message);
			e.preventDefault();
		}
	};
	form.oninput = (e) => clearFieldError(e.target);
	dialog.showModal();

	return new Promise((resolve) => {
		dialog.onclick = async (e) => {
			if (e.target === dialog) return dialog.close();
			const handler = e.target.closest("[data-handler]");
			if (handler) return guard(() => handlers[handler.dataset.handler]?.(handler, dialog));
			if (e.target.closest("[data-generate]")) {
				dialog.querySelector("#dialog-input").value = randomPassword();
			}
			const copy = e.target.closest("[data-copy]");
			if (copy) {
				try {
					await navigator.clipboard.writeText(copy.dataset.copy);
				} catch (err) {
					showFormError(form, describeError(err));
					return;
				}
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
						? input.trim
							? dialog.querySelector("#dialog-input").value.trim()
							: dialog.querySelector("#dialog-input").value
						: true,
				);
			},
			{ once: true },
		);
	});
}

/** Icon from the Lucide-style sprite in icons.svg (24×24, stroked). */
export const icon = (name, cls = "") =>
	html`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="icons.svg#${name}"></use></svg>`;

/** Well-separated hues, so different people never get near-identical avatars. */
const AVATAR_HUES = [0, 28, 48, 142, 172, 196, 220, 258, 290, 325];

/** Initials avatar whose colour is derived from `seed` (usually the user id), so it never changes. */
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
	// FNV-1a followed by the MurmurHash3 finalizer spreads similar ids evenly across the hues.
	let hash = 2166136261;
	for (const c of String(seed)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x85ebca6b);
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2b2ae35);
	hash ^= hash >>> 16;
	return html`<span
		class="avatar ${size && `avatar-${size}`}"
		style="--hue: ${AVATAR_HUES[(hash >>> 0) % AVATAR_HUES.length]}"
		title="${label}"
		aria-hidden="true"
		>${initials}</span
	>`;
}

/** Random password without look-alike characters (0/O, 1/l/I). */
export function randomPassword(length = 12) {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
	return Array.from(crypto.getRandomValues(new Uint32Array(length)), (n) => chars[n % chars.length]).join("");
}

/** Saves `content` as a file download. */
export function downloadFile(name, content, type) {
	const url = URL.createObjectURL(new Blob([content], { type }));
	Object.assign(document.createElement("a"), { href: url, download: name }).click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const pad = (n) => String(n).padStart(2, "0");

/** Date as a local `<input type="datetime-local">` value. */
export const toInput = (d) =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** `datetime-local` value as an ISO instant. */
export const fromInput = (value) => new Date(value).toISOString();
