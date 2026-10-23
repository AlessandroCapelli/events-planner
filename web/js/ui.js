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

/** Renderizza il markup in root e collega i click su [data-action] e i submit di form[data-submit]. */
export function mount(root, markup, actions = {}) {
	root.innerHTML = markup;
	root.onclick = (e) => {
		const el = e.target.closest("[data-action]");
		const fn = el && actions[el.dataset.action];
		if (fn) guard(() => fn(el.dataset, el));
	};
	root.onsubmit = (e) => {
		const form = e.target;
		const fn = actions[form.dataset.submit];
		if (!fn) return;
		e.preventDefault();
		const button = e.submitter;
		if (button) button.disabled = true;
		guard(() => fn(Object.fromEntries(new FormData(form)), form)).finally(
			() => {
				if (button) button.disabled = false;
			},
		);
	};
}

export async function guard(fn) {
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

const pad = (n) => String(n).padStart(2, "0");

/** Date → valore per <input type="datetime-local"> nel fuso orario locale. */
export const toInput = (d) =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const fromInput = (value) => new Date(value).toISOString();
