# 📅 Events Planner

Web app minimale per organizzare gli eventi di un gruppo: chi c'è, chi forse, chi no, quante persone si porta dietro, proposte di data e luogo alternativi e la lista delle cose da portare.

- **Frontend**: HTML/CSS/JS vanilla, senza build, pubblicato su GitHub Pages.
- **Backend**: [Supabase](https://supabase.com) (piano free): Auth, Postgres con Row Level Security e una Edge Function per la gestione degli utenti.
- **Privacy**: il codice è pubblico, mentre i dati stanno su Supabase e sono leggibili solo dagli utenti loggati.
- **Lingue**: italiano (predefinito) e inglese.

## Funzionalità

|                 |                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------ |
| Accesso         | Gli account li crea solo l'admin; non c'è registrazione pubblica.                          |
| Eventi          | Elenco dei prossimi eventi, creazione, dettaglio. Un evento sparisce 12 ore dopo l'inizio. |
| Presenza        | _Ci sono / Forse / Non ci sono_ + numero di accompagnatori (+N).                           |
| Proposte        | Data e/o luogo alternativi, voto 👍/👎; il creatore dell'evento o un admin può adottarle.  |
| Cose da portare | Lista condivisa; ognuno può prenotare un oggetto ("Lo porto io").                          |
| Permessi        | L'evento lo modificano o eliminano solo il creatore e gli admin.                           |
| Admin           | Crea ed elimina utenti, reimposta password, assegna il ruolo admin.                        |

## Struttura

```
web/                      sito statico (GitHub Pages)
  index.html  style.css  config.example.js
  js/app.js               router + viste
  js/api.js               accesso a Supabase
  js/i18n.js              traduzioni it/en
  js/ui.js                template html con escape, toast, date
supabase/
  migrations/             schema + RLS
  functions/admin-users/  Edge Function per la gestione utenti
.github/workflows/pages.yml
```

## Setup

### 1. Supabase

1. Crea un progetto su [supabase.com](https://supabase.com).
2. **SQL Editor** → incolla ed esegui `supabase/migrations/20261023000000_init.sql`
   (in alternativa, con la CLI: `supabase link --project-ref <ref>` e poi `supabase db push`).
3. **Authentication → Sign In / Providers** → disattiva _Allow new users to sign up_.
4. Pubblica la Edge Function:
    ```sh
    npx supabase functions deploy admin-users --project-ref <ref>
    ```
5. Crea il primo utente da **Authentication → Users → Add user** (con _Auto Confirm User_) e rendilo admin:
    ```sql
    update public.profiles set is_admin = true where id = (select id from auth.users where email = 'tu@example.com');
    ```

### 2. GitHub

1. Pubblica il repository su GitHub.
2. **Settings → Secrets and variables → Actions → Variables**: aggiungi
    - `SUPABASE_URL`: `https://<ref>.supabase.co`
    - `SUPABASE_ANON_KEY`: la _anon_ / _publishable_ key (è pubblica per design, perché i dati li protegge la RLS)
3. **Settings → Pages → Source**: _GitHub Actions_.
4. Fai push su `main`: il workflow genera `config.js` e pubblica `web/`.
5. In Supabase, **Authentication → URL Configuration → Site URL**: imposta l'URL di Pages.

### Sviluppo locale

```sh
cp web/config.example.js web/config.js   # inserisci URL e chiave
npx serve web                             # oppure: python -m http.server -d web
```

## Sicurezza

- Ogni tabella ha la RLS attiva; gli utenti anonimi non hanno accesso a nulla.
- Il client può aggiornare solo colonne specifiche (column grant): per esempio non può modificare `is_admin` né `created_by`.
- Le operazioni con la service role key avvengono solo nella Edge Function, che controlla che chi la chiama sia admin.

## Licenza

[MIT](LICENSE)
