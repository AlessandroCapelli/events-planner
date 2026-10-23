// Feed iCalendar personale: GET /functions/v1/calendar?token=…&lang=it&tz=Europe/Rome
// Pubblica, senza login (i calendari non sanno autenticarsi): la protezione è il token segreto.
// Va pubblicata con "Verify JWT" disattivato. Contiene solo gli eventi che il proprietario del token vede.
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

const escape = (value: string) => value.replace(/[\\;,]/g, '\\$&').replace(/\r\n|\r|\n/g, '\\n');

/** Spezza le righe oltre i 75 byte (RFC 5545 §3.1) senza tagliare caratteri multibyte. */
function fold(line: string): string {
	const encoder = new TextEncoder();
	const parts: string[] = [];
	let current = '';
	for (const char of line) {
		const limit = parts.length ? 74 : 75; // le righe di continuazione iniziano con uno spazio
		if (encoder.encode(current + char).length > limit) {
			parts.push(current);
			current = char;
		} else current += char;
	}
	parts.push(current);
	return parts.join('\r\n ');
}

/** Data locale (YYYYMMDD) dell'istante nel fuso indicato, più `days` giorni. */
function localDay(iso: string, timeZone: string, days = 0): string {
	const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
		.formatToParts(new Date(iso));
	const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
	return new Date(Date.UTC(part('year'), part('month') - 1, part('day') + days)).toISOString().slice(0, 10).replaceAll('-', '');
}

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

function validTimeZone(value: string | null): string {
	try {
		if (value) return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
	} catch {
		// fuso non valido: si usa quello predefinito
	}
	return 'Europe/Rome';
}

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
	auth: { persistSession: false },
});

Deno.serve(async (req) => {
	const url = new URL(req.url);
	const token = url.searchParams.get('token') ?? '';
	const notFound = () => new Response('Not found', { status: 404 });
	if (!['GET', 'HEAD'].includes(req.method) || !/^[0-9a-f]{64}$/.test(token)) return notFound();

	const { data, error } = await db.rpc('calendar_feed', { p_token: token });
	if (error) return error.code === 'P0002' ? notFound() : new Response('Error', { status: 500 });

	const body = buildCalendar(data, {
		lang: url.searchParams.get('lang') === 'en' ? 'en' : 'it',
		timeZone: validTimeZone(url.searchParams.get('tz')),
		appUrl: Deno.env.get('APP_URL') ?? '',
	});
	return new Response(req.method === 'HEAD' ? null : body, {
		headers: {
			'Content-Type': 'text/calendar; charset=utf-8',
			'Content-Disposition': 'inline; filename="events-planner.ics"',
			'Cache-Control': 'private, max-age=300',
		},
	});
});
