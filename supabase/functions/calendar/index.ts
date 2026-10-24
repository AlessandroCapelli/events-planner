import { createClient } from 'npm:@supabase/supabase-js@2';

type FeedEvent = {
	id: string;
	title: string;
	starts_at: string;
	location: string | null;
	description: string | null;
	my_status: 'yes' | 'maybe' | 'no' | null;
};

const TEXT = {
	it: { name: 'Events Planner', time: 'Data e ora', reply: 'La tua risposta', none: 'Non hai ancora risposto', yes: 'Ci sono', maybe: 'Forse', no: 'Non ci sono', open: 'Apri' },
	en: { name: 'Events Planner', time: 'Date and time', reply: 'Your reply', none: "You haven't replied yet", yes: "I'm in", maybe: 'Maybe', no: "Can't make it", open: 'Open' },
};

/** Escapes a value for an iCalendar TEXT property. */
const escape = (value: string) => value.replace(/[\\;,]/g, '\\$&').replace(/\r\n|\r|\n/g, '\\n');

/** Folds a content line at 75 octets (RFC 5545 §3.1) without splitting multibyte characters. */
function fold(line: string): string {
	const encoder = new TextEncoder();
	const parts: string[] = [];
	let current = '';
	for (const char of line) {
		const limit = parts.length ? 74 : 75;
		if (encoder.encode(current + char).length > limit) {
			parts.push(current);
			current = char;
		} else current += char;
	}
	parts.push(current);
	return parts.join('\r\n ');
}

/** Local date (YYYYMMDD) of an instant in `timeZone`, shifted by `days`. */
function localDay(iso: string, timeZone: string, days = 0): string {
	const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
		.formatToParts(new Date(iso));
	const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
	return new Date(Date.UTC(part('year'), part('month') - 1, part('day') + days)).toISOString().slice(0, 10).replaceAll('-', '');
}

/** Builds the iCalendar document, with every event as an all-day entry in `timeZone`. */
export function buildCalendar(
	events: FeedEvent[],
	{ lang = 'it', timeZone = 'Europe/Rome', appUrl = '' }: { lang?: 'it' | 'en'; timeZone?: string; appUrl?: string } = {},
): string {
	const text = TEXT[lang];
	const when = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'it-IT', {
		timeZone,
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
	const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Events Planner//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		`X-WR-CALNAME:${text.name}`,
		'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
		'X-PUBLISHED-TTL:PT1H',
	];
	for (const event of events) {
		const description = [
			`${text.time}: ${when.format(new Date(event.starts_at))}`,
			`${text.reply}: ${event.my_status ? text[event.my_status] : text.none}`,
			event.description,
			appUrl && `${text.open}: ${appUrl}#/event/${event.id}`,
		]
			.filter(Boolean)
			.join('\n\n');
		lines.push(
			'BEGIN:VEVENT',
			`UID:${event.id}@events-planner`,
			`DTSTAMP:${stamp}`,
			`DTSTART;VALUE=DATE:${localDay(event.starts_at, timeZone)}`,
			`DTEND;VALUE=DATE:${localDay(event.starts_at, timeZone, 1)}`,
			`SUMMARY:${escape(event.title)}`,
			...(event.location ? [`LOCATION:${escape(event.location)}`] : []),
			`DESCRIPTION:${escape(description)}`,
			...(appUrl ? [`URL:${appUrl}#/event/${event.id}`] : []),
			'TRANSP:TRANSPARENT',
			'END:VEVENT',
		);
	}
	lines.push('END:VCALENDAR');
	return lines.map(fold).join('\r\n') + '\r\n';
}

/** Returns `value` if it is a valid IANA time zone, otherwise the default one. */
function validTimeZone(value: string | null): string {
	try {
		if (value) return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
	} catch {
		/* falls back to the default time zone */
	}
	return 'Europe/Rome';
}

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
	auth: { persistSession: false },
});

/**
 * Personal iCalendar feed: `GET /functions/v1/calendar?token=…&lang=it&tz=Europe/Rome`.
 * Calendar apps cannot log in, so the secret token in the URL is the only credential;
 * the feed holds exactly the events its owner can see. Deploy with JWT verification off.
 */
Deno.serve(async (req) => {
	const url = new URL(req.url);
	const token = url.searchParams.get('token') ?? '';
	const notFound = () => new Response('Not found', { status: 404 });
	if (!['GET', 'HEAD'].includes(req.method) || !/^[0-9a-f]{64}$/.test(token)) return notFound();

	const events: FeedEvent[] = [];
	for (; ;) {
		const { data, error } = await db.rpc('calendar_feed', { p_token: token })
			.order('starts_at').order('id').range(events.length, events.length + 199);
		if (error) return error.code === 'P0002' ? notFound() : new Response('Error', { status: 500 });
		if (!data.length) break;
		events.push(...data);
	}

	const body = buildCalendar(events, {
		lang: url.searchParams.get('lang') === 'en' ? 'en' : 'it',
		timeZone: validTimeZone(url.searchParams.get('tz')),
		appUrl: Deno.env.get('APP_URL') ?? '',
	});
	return new Response(req.method === 'HEAD' ? null : body, {
		headers: {
			'Content-Type': 'text/calendar; charset=utf-8',
			'Content-Disposition': 'inline; filename="events-planner.ics"',
			'Cache-Control': 'private, no-cache, must-revalidate',
		},
	});
});
