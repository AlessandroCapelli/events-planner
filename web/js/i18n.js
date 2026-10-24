import en from "../locales/en.json" with { type: "json" };
import it from "../locales/it.json" with { type: "json" };

/** UI strings by language; `{name}` placeholders are filled by `t()`. */
const dict = { it, en };

const STORAGE_KEY = "lang";

/** Language saved by a previous visit, if storage is available and holds a known one. */
function stored() {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		return value in dict ? value : null;
	} catch {
		return null;
	}
}

let current = stored() ?? "it";
document.documentElement.lang = current;

/** Current UI language code. */
export const lang = () => current;

/** Switches the UI language and remembers it for the next visit. */
export function setLang(value) {
	current = value;
	document.documentElement.lang = value;
	try {
		localStorage.setItem(STORAGE_KEY, value);
	} catch {
		/* the choice just isn't remembered */
	}
}

/** Translates `key`, replacing `{name}` placeholders with `vars`; unknown keys are returned as is. */
export const t = (key, vars = {}) => (dict[current][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "");

/** Plural-aware `t()`: picks `<key>.one` or `<key>.other` for `n`, available as `{n}`. */
export const tn = (key, n, vars = {}) =>
	t(`${key}.${new Intl.PluralRules(current).select(n) === "one" ? "one" : "other"}`, { n, ...vars });

const fmt = (options) => new Intl.DateTimeFormat(current, options);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Calendar days from today to `date`: 0 today, 1 tomorrow, -1 yesterday. */
const dayDiff = (date) => Math.round((startOfDay(date) - startOfDay(new Date())) / 864e5);
const yearIfOther = (date) => (date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {});

/** Hours an event stays open after it starts; must match `public.is_open()`. */
const OPEN_HOURS = 12;

/** ISO instant before which an event has ended and become read-only. */
export const openSince = () => new Date(Date.now() - OPEN_HOURS * 36e5).toISOString();
/** Whether the event has ended. */
export const isPast = (iso) => new Date(iso) <= new Date(openSince());
/** Whether the event has started but not ended yet. */
export const isLive = (iso) => !isPast(iso) && new Date(iso) <= new Date();

/** Time of day, e.g. "18:30". */
export const fmtTime = (iso) => fmt({ hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** Short date and time, with the year only when it isn't the current one. */
export function fmtDate(iso) {
	const date = new Date(iso);
	return fmt({
		weekday: "short",
		day: "numeric",
		month: "short",
		...yearIfOther(date),
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

/** Full date without time, e.g. "Saturday 24 October". */
export function fmtLongDate(iso) {
	const date = new Date(iso);
	return capitalize(fmt({ weekday: "long", day: "numeric", month: "long", ...yearIfOther(date) }).format(date));
}

/** Short month, day number and short weekday, for the date tile. */
export function dayParts(iso) {
	const date = new Date(iso);
	return {
		month: fmt({ month: "short" }).format(date).replace(".", ""),
		day: date.getDate(),
		weekday: fmt({ weekday: "short" }).format(date).replace(".", ""),
	};
}

/** List group heading: today, tomorrow or yesterday, otherwise month and year (always for past events). */
export function groupLabel(iso) {
	const date = new Date(iso);
	if (!isPast(iso)) {
		const diff = dayDiff(date);
		if (diff === 0) return t("date.today");
		if (diff === -1) return t("date.yesterday");
		if (diff === 1) return t("date.tomorrow");
	}
	return capitalize(fmt({ month: "long", year: "numeric" }).format(date));
}

/** Relative time such as "in 2 hours" or "3 days ago", or "live" while the event is open and started. */
export function relative(iso) {
	if (isLive(iso)) return t("date.live");
	const date = new Date(iso);
	const rtf = new Intl.RelativeTimeFormat(current, { numeric: "auto" });
	const days = dayDiff(date);
	if (days === 0) {
		const minutes = Math.round((date - Date.now()) / 6e4) || 1;
		return Math.abs(minutes) < 60 ? rtf.format(minutes, "minute") : rtf.format(Math.round(minutes / 60), "hour");
	}
	const span = Math.abs(days);
	if (span < 7) return rtf.format(days, "day");
	if (span < 30) return rtf.format(Math.round(days / 7), "week");
	if (span < 365) return rtf.format(Math.round(days / 30), "month");
	return rtf.format(Math.round(days / 365), "year");
}
