# Events Planner

Web app minimale per organizzare gli eventi di un gruppo: chi c'è, chi forse, chi no, quante persone si porta dietro, proposte di data e luogo alternativi e la lista delle cose da portare.

- **Frontend**: HTML/CSS/JS vanilla, senza build, pubblicato su GitHub Pages.
- **Backend**: [Supabase](https://supabase.com) (piano free): Auth, Postgres con Row Level Security e una Edge Function per la gestione degli utenti.
- **Privacy**: il codice è pubblico, i dati stanno su Supabase e sono leggibili solo dagli utenti loggati.
- **Lingue**: italiano (predefinito) e inglese. Tema scuro, ottimizzato per desktop e mobile.

## Funzionalità

|                 |                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Accesso         | Gli account li crea solo l'admin: non c'è registrazione pubblica.                                                                         |
| Eventi          | Lista dei prossimi eventi raggruppati per giorno, creazione e dettaglio.                                                                  |
| Archivio        | 12 ore dopo l'inizio un evento è concluso: resta in lista sotto i futuri, in sola lettura (solo un admin può eliminarlo).                 |
| Tempo reale     | Risposte, voti, proposte e cose da portare si aggiornano da sole, senza perdere quello che si sta scrivendo.                              |
| Condividi       | Anteprima dell'evento e invio via WhatsApp, Telegram, email o condivisione di sistema; link da copiare.                                   |
| Presenza        | _Ci sono / Forse / Non ci sono_, più il numero di accompagnatori.                                                                         |
| Proposte        | Data e/o luogo alternativi con voto 👍/👎. Il creatore o un admin può adottarne una: l'evento si aggiorna e le risposte vengono azzerate. |
| Cose da portare | Lista condivisa; ognuno prenota quello che porta.                                                                                         |
| Calendario      | Export `.ics` come evento di un giorno intero, con l'orario nella descrizione.                                                            |
| Permessi        | Un evento aperto lo modificano o eliminano solo il suo creatore e gli admin.                                                              |
| Admin           | Crea ed elimina utenti, reimposta password, assegna il ruolo admin.                                                                       |

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
  functions/admin-users/     Edge Function per la gestione utenti
.github/workflows/pages.yml  deploy su GitHub Pages
```

## Setup

### 1. Supabase

1. Crea un progetto su [supabase.com](https://supabase.com).
2. **SQL Editor**: esegui, in ordine, i file in `supabase/migrations/`. In alternativa, con la CLI: `supabase link --project-ref <ref>`, poi `supabase db push`.
3. **Authentication → Sign In / Providers**: disattiva _Allow new users to sign up_ e _Allow anonymous sign-ins_.
4. **Authentication → Providers → Email**: imposta _Minimum password length_ a 8.
5. Pubblica la Edge Function, dalla dashboard (**Edge Functions → Deploy a new function**, nome `admin-users`) oppure con la CLI:
    ```sh
    npx supabase functions deploy admin-users --project-ref <ref>
    ```
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

### Sviluppo locale

```sh
cp web/config.example.js web/config.js   # inserisci URL e chiave
npx serve web
```

## Sicurezza

- Ogni tabella ha la RLS attiva; il ruolo `anon` non ha alcun permesso.
- Il client può aggiornare solo colonne specifiche: non può toccare `is_admin` né `created_by`.
- La service role key esiste solo nella Edge Function, che verifica che chi la chiama sia admin.
- Tutto dipende dal fatto che solo l'admin possa creare account: tieni disattivate registrazione e accesso anonimo (passo 3 del setup).

## Licenza

[MIT](LICENSE)
