const dict = {
	it: {
		"nav.events": "Eventi",
		"nav.admin": "Utenti",
		"nav.logout": "Esci",
		"login.title": "Accedi",
		"login.email": "Email",
		"login.password": "Password",
		"login.submit": "Entra",
		"login.hint":
			"Gli account vengono creati dall'amministratore del gruppo.",
		"events.title": "Prossimi eventi",
		"events.new": "Nuovo evento",
		"events.empty": "Nessun evento in programma. Creane uno!",
		"event.back": "← Eventi",
		"event.by": "Creato da {name}",
		"event.edit": "Modifica",
		"event.confirmDelete": "Eliminare questo evento?",
		"event.notFound": "Evento non trovato o già concluso.",
		"rsvp.title": "Ci sei?",
		"rsvp.yes": "Ci sono",
		"rsvp.maybe": "Forse",
		"rsvp.no": "Non ci sono",
		"rsvp.guests": "Persone con te",
		"people.title": "Partecipanti",
		"people.summary":
			"{yes} ci sono · {maybe} forse · {no} non ci sono (accompagnatori inclusi)",
		"people.empty": "Ancora nessuna risposta.",
		"proposals.title": "Proposte",
		"proposals.hint": "Proponi una data e/o un luogo alternativi.",
		"proposals.empty": "Nessuna proposta.",
		"proposals.location": "Luogo alternativo",
		"proposals.add": "Proponi",
		"proposals.adopt": "Adotta",
		"proposals.confirmAdopt": "Aggiornare l'evento con questa proposta?",
		"items.title": "Cose da portare",
		"items.empty": "Ancora niente in lista.",
		"items.placeholder": "es. bibite, chitarra…",
		"items.add": "Aggiungi",
		"items.claim": "Lo porto io",
		"items.unclaim": "Rinuncio",
		"items.claimedBy": "porta {name}",
		"form.newTitle": "Nuovo evento",
		"form.editTitle": "Modifica evento",
		"form.title": "Titolo",
		"form.startsAt": "Data e ora",
		"form.location": "Luogo",
		"form.description": "Descrizione",
		"admin.title": "Utenti",
		"admin.create": "Nuovo utente",
		"admin.name": "Nome",
		"admin.password": "Password iniziale",
		"admin.isAdmin": "Admin",
		"admin.add": "Crea utente",
		"admin.created": "Utente creato.",
		"admin.resetPassword": "Reimposta password",
		"admin.newPassword": "Nuova password per {name} (min. 8 caratteri):",
		"admin.confirmDelete":
			"Eliminare {name}? Verranno rimosse anche le sue risposte.",
		"account.title": "Il tuo account",
		"account.name": "Nome visualizzato",
		"account.password": "Nuova password",
		"account.changePassword": "Cambia password",
		"common.save": "Salva",
		"common.saved": "Salvato.",
		"common.cancel": "Annulla",
		"common.delete": "Elimina",
		"common.loading": "Caricamento…",
		"common.error": "Errore: {msg}",
		"common.missingConfig":
			"Configurazione mancante: crea web/config.js partendo da web/config.example.js.",
	},
	en: {
		"nav.events": "Events",
		"nav.admin": "Users",
		"nav.logout": "Log out",
		"login.title": "Sign in",
		"login.email": "Email",
		"login.password": "Password",
		"login.submit": "Sign in",
		"login.hint": "Accounts are created by the group administrator.",
		"events.title": "Upcoming events",
		"events.new": "New event",
		"events.empty": "No events planned. Create one!",
		"event.back": "← Events",
		"event.by": "Created by {name}",
		"event.edit": "Edit",
		"event.confirmDelete": "Delete this event?",
		"event.notFound": "Event not found or already over.",
		"rsvp.title": "Are you in?",
		"rsvp.yes": "I'm in",
		"rsvp.maybe": "Maybe",
		"rsvp.no": "Can't make it",
		"rsvp.guests": "People with you",
		"people.title": "Attendees",
		"people.summary":
			"{yes} in · {maybe} maybe · {no} out (guests included)",
		"people.empty": "No responses yet.",
		"proposals.title": "Proposals",
		"proposals.hint": "Suggest an alternative date and/or place.",
		"proposals.empty": "No proposals.",
		"proposals.location": "Alternative place",
		"proposals.add": "Propose",
		"proposals.adopt": "Adopt",
		"proposals.confirmAdopt": "Update the event with this proposal?",
		"items.title": "What to bring",
		"items.empty": "Nothing on the list yet.",
		"items.placeholder": "e.g. drinks, guitar…",
		"items.add": "Add",
		"items.claim": "I'll bring it",
		"items.unclaim": "Drop",
		"items.claimedBy": "{name} brings it",
		"form.newTitle": "New event",
		"form.editTitle": "Edit event",
		"form.title": "Title",
		"form.startsAt": "Date and time",
		"form.location": "Place",
		"form.description": "Description",
		"admin.title": "Users",
		"admin.create": "New user",
		"admin.name": "Name",
		"admin.password": "Initial password",
		"admin.isAdmin": "Admin",
		"admin.add": "Create user",
		"admin.created": "User created.",
		"admin.resetPassword": "Reset password",
		"admin.newPassword": "New password for {name} (min. 8 characters):",
		"admin.confirmDelete":
			"Delete {name}? Their responses will be removed too.",
		"account.title": "Your account",
		"account.name": "Display name",
		"account.password": "New password",
		"account.changePassword": "Change password",
		"common.save": "Save",
		"common.saved": "Saved.",
		"common.cancel": "Cancel",
		"common.delete": "Delete",
		"common.loading": "Loading…",
		"common.error": "Error: {msg}",
		"common.missingConfig":
			"Missing configuration: create web/config.js from web/config.example.js.",
	},
};

const STORAGE_KEY = "lang";

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

export const lang = () => current;

export function setLang(value) {
	current = value;
	document.documentElement.lang = value;
	try {
		localStorage.setItem(STORAGE_KEY, value);
	} catch {
		/* storage non disponibile */
	}
}

export const t = (key, vars = {}) =>
	(dict[current][key] ?? key).replace(
		/\{(\w+)\}/g,
		(_, name) => vars[name] ?? "",
	);

export function fmtDate(iso) {
	const date = new Date(iso);
	const otherYear = date.getFullYear() !== new Date().getFullYear();
	return new Intl.DateTimeFormat(current, {
		weekday: "short",
		day: "numeric",
		month: "short",
		...(otherYear && { year: "numeric" }),
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}
