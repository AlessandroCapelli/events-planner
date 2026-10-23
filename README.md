# Events Planner

Web app minimale per organizzare gli eventi di un gruppo: chi c'è, chi forse, chi no, quante persone si porta dietro, proposte di data e luogo alternativi e la lista delle cose da portare.

- **Frontend**: HTML/CSS/JS vanilla, senza build, pubblicato su GitHub Pages.
- **Backend**: [Supabase](https://supabase.com) (piano free): Auth, Postgres con Row Level Security, Realtime e due Edge Function (gestione utenti, calendario).
- **Privacy**: il codice è pubblico, i dati stanno su Supabase e sono leggibili solo dagli utenti loggati, secondo chi può vedere cosa.
- **Lingue**: italiano (predefinito) e inglese. Tema scuro, ottimizzato per desktop e mobile.

## Funzionalità

|                 |                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Accesso         | Gli account li crea solo l'admin: non c'è registrazione pubblica.                                                                         |
| Eventi          | Lista dei prossimi eventi raggruppati per giorno, creazione e dettaglio. Si può creare anche un evento che inizia adesso.                 |
| Form            | Validazione uniforme: errore sotto il campo, messaggi tradotti e comprensibili, errori di invio in un unico riquadro in fondo al form.    |
| Invitati        | Un evento è per _tutto il gruppo_ oppure _solo per gli invitati_ scelti dall'organizzatore: gli altri non lo vedono affatto.              |
| Archivio        | 12 ore dopo l'inizio un evento è concluso: resta in lista sotto i futuri, in sola lettura (solo un admin può eliminarlo).                 |
| Tempo reale     | Risposte, voti, proposte e cose da portare si aggiornano da sole, senza perdere quello che si sta scrivendo.                              |
| Presenza        | _Ci sono / Forse / Non ci sono_, più il numero di accompagnatori; elenco di chi deve ancora rispondere.                                   |
| Proposte        | Data e/o luogo alternativi con voto 👍/👎. Il creatore o un admin può adottarne una: l'evento si aggiorna e le risposte vengono azzerate. |
| Cose da portare | Lista condivisa; ognuno prenota quello che porta.                                                                                         |
| Condividi       | Anteprima dell'evento e invio via WhatsApp, Telegram, email o condivisione di sistema; link da copiare.                                   |
| Calendario      | Export `.ics` del singolo evento, oppure calendario sincronizzato personale (Google, Apple, Outlook) con tutti gli eventi che vedi.       |
| Permessi        | Un evento aperto lo modificano o eliminano solo il suo creatore e gli admin.                                                              |
| Admin           | Crea ed elimina utenti, reimposta password, assegna il ruolo admin. Gli admin vedono anche gli eventi su invito.                          |

## Struttura

```
web/                         sito statico (GitHub Pages)
  index.html  style.css  favicon.svg  config.example.js
  js/app.js                  router e viste
  js/api.js                  accesso a Supabase
  js/i18n.js                 traduzioni it/en e formattazione date
  js/ui.js                   template html con escape, dialog, toast, icone
supabase/
  migrations/                schema, RLS e funzioni (da eseguire in ordine)
  functions/admin-users/     gestione utenti (solo admin)
  functions/calendar/        feed iCalendar personale (link segreto)
.github/workflows/pages.yml  deploy su GitHub Pages
```

## Setup

### 1. Supabase

1. Crea un progetto su [supabase.com](https://supabase.com).
2. **SQL Editor**: esegui, in ordine, i file in `supabase/migrations/`. In alternativa, con la CLI: `supabase link --project-ref <ref>`, poi `supabase db push`.
3. **Authentication → Sign In / Providers**: disattiva _Allow new users to sign up_ e _Allow anonymous sign-ins_.
4. **Authentication → Providers → Email**: imposta _Minimum password length_ a 8.
5. Pubblica le Edge Function, dalla dashboard (**Edge Functions → Deploy a new function**) oppure con la CLI:
    - `admin-users`, con _Verify JWT_ **attivo**;
    - `calendar`, con _Verify JWT_ **disattivato**: i calendari non possono autenticarsi, la protezione è il token segreto nel link.

    ```sh
    npx supabase functions deploy admin-users --project-ref <ref>
    npx supabase functions deploy calendar --no-verify-jwt --project-ref <ref>
    ```

    Nell'editor della dashboard incolla il contenuto del rispettivo `supabase/functions/<nome>/index.ts`. I file `.sql` vanno nel **SQL Editor**, non nell'editor delle Edge Function.

    In **Edge Functions → Secrets**, aggiungi facoltativamente `APP_URL` con l'URL pubblico dell'app (es. `https://utente.github.io/events-planner/`): aggiunge agli eventi del calendario il link all'app. `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` sono già forniti da Supabase alle funzioni; la service role non va inserita nel frontend né nelle variabili GitHub Pages. Il token personale del calendario viene generato dall'app e non va configurato come secret.

6. Crea il primo utente da **Authentication → Users → Add user** (con _Auto Confirm User_) e rendilo admin:
    ```sql
    update public.profiles set is_admin = true
    where id = (select id from auth.users where email = 'tu@example.com');
    ```

### 2. GitHub Pages

1. **Settings → Secrets and variables → Actions → Variables** (non _Secrets_):
    - `SUPABASE_URL`: `https://<ref>.supabase.co`
    - `SUPABASE_ANON_KEY`: la _publishable_ key (`sb_publishable_…`), pubblica per design
2. **Settings → Pages → Source**: _GitHub Actions_.
3. Fai push su `main`: il workflow genera `config.js` e pubblica `web/`.
4. In Supabase, **Authentication → URL Configuration → Site URL**: imposta l'URL di Pages.

### Avvio locale

```sh
cp web/config.example.js web/config.js   # inserisci URL e chiave
npx serve web
```

## Sicurezza

- Ogni tabella ha la RLS attiva; il ruolo `anon` non ha alcun permesso.
- **Chi vede cosa** è deciso in un solo punto, `event_visible_to()`: eventi di gruppo per tutti, eventi su invito per organizzatore, invitati e admin. Lo usano RLS (eventi, risposte, proposte, voti, oggetti, inviti), Realtime e calendario, quindi non possono divergere.
- Eventi e invitati si scrivono solo tramite `save_event()`, che verifica permessi e date (un evento si crea o modifica finché è aperto, cioè iniziato da meno di 12 ore) e risponde con codici che l'app traduce; chi viene tolto dagli invitati perde anche risposte, voti e prenotazioni.
- Realtime non applica la RLS alle cancellazioni e ne invia la chiave primaria a tutti: per questo inviti, risposte e voti hanno chiavi surrogate casuali, che non rivelano chi era invitato a un evento privato.
- Il calendario usa un token casuale (244 bit) per utente, leggibile solo dal proprietario; rigenerarlo invalida subito il vecchio link. Il feed è generato con la service role solo dalla Edge Function.
- Il client può aggiornare solo colonne specifiche: non può toccare `is_admin` né `created_by`.
- Tutto dipende dal fatto che solo l'admin possa creare account: tieni disattivate registrazione e accesso anonimo (passo 3 del setup).

## Licenza

[MIT](LICENSE)
