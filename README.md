# Events Planner

A small web app to plan a group's events: who's in, who might come, how many guests they bring, alternative dates and places to vote on, and a list of things to bring.

Static vanilla HTML/CSS/JS on GitHub Pages, no build step. [Supabase](https://supabase.com) (free tier) provides Auth, Postgres with Row Level Security, Realtime and two Edge Functions. The UI is in Italian (default) and English, dark theme only, for desktop and mobile.

![Event list](docs/screenshots/events.png)

![Event page](docs/screenshots/event.png)

<p align="center">
  <img src="docs/screenshots/mobile-events.png" width="300" alt="Event list on mobile">
  <img src="docs/screenshots/mobile-event.png" width="300" alt="Event page on mobile">
</p>

## Features

- **Invite-only accounts**: users are created by an admin, there is no public sign-up.
- **RSVP**: _I'm in / Maybe / Can't make it_, plus guests, and a list of who hasn't replied yet.
- **Groups**: every user belongs to one or more groups and every event to one group, which only its members can see. The list shows a group filter when you are in more than one.
- **Audience**: an event is for its whole group or only for the members its organizer invites; nobody else can see it.
- **Proposals**: suggest another date or place and vote on it. The organizer or an admin can adopt a proposal, which updates the event and clears the responses.
- **Polls**: ask the group a question with 2 to 10 options, single or multiple choice, and see who voted for what.
- **Things to bring**: a shared list where everyone claims what they'll bring.
- **Archive**: 12 hours after it starts an event becomes read-only and moves to the _Past_ section.
- **Real time**: changes from others show up instantly, without losing what you are typing.
- **Sharing**: WhatsApp, Telegram, email, the system share sheet or a link to copy.
- **Calendar**: download a single event as `.ics`, or subscribe to a personal feed with every event you can see (Google, Apple, Outlook).
- **Privacy notice**: a GDPR notice readable without signing in, naming the data controller you configure.
- **Admin**: create, rename and delete groups (a group's events are deleted with it), choose each user's groups, create and delete users, reset passwords, grant the admin role. As participants, admins see only the events of their own groups.

## Structure

```
web/                          static site (GitHub Pages)
  js/app.js                   router and views
  js/api.js                   Supabase access
  js/i18n.js                  language and date formatting
  js/ui.js                    escaped html templates, forms, dialogs
  locales/                    translations (it, en)
  icons.svg                   icon sprite
  vendor/supabase.js          bundled Supabase client
supabase/
  migrations/                 schema, RLS and functions
  functions/admin-users/      user management (admins only)
  functions/calendar/         personal iCalendar feed
scripts/                      deployment config, asset versioning, Supabase client bundle
tests/                        unit, browser (Playwright) and database tests
```

## Setup

### Supabase

1. Create a project on [supabase.com](https://supabase.com).
2. Run the files in `supabase/migrations/` in order in the **SQL Editor**, or with the CLI: `supabase link --project-ref <ref>` and `supabase db push`. This creates a first group, `Default`, that you can rename later.
3. In **Authentication → Sign In / Providers**, turn off _Allow new users to sign up_ and _Allow anonymous sign-ins_, and set the email _Minimum password length_ to 8.
4. Deploy the Edge Functions, from the dashboard (**Edge Functions → Deploy a new function**, pasting `supabase/functions/<name>/index.ts`) or with the CLI:

   ```sh
   npx supabase functions deploy admin-users --project-ref <ref>
   npx supabase functions deploy calendar --no-verify-jwt --project-ref <ref>
   ```

   `admin-users` keeps _Verify JWT_ on. `calendar` must have it **off**: calendar apps can't log in, so the secret token in the feed URL is the credential.

   Optionally add the `APP_URL` secret (e.g. `https://you.github.io/events-planner/`) to link calendar entries back to the app.

5. Create the first user in **Authentication → Users → Add user** (with _Auto Confirm User_): users created from the dashboard join the oldest group. Then make them admin:

   ```sql
   update public.profiles set is_admin = true
   where id = (select id from auth.users where email = 'you@example.com');
   ```

### GitHub Pages

1. In **Settings → Secrets and variables → Actions → Variables** (not _Secrets_), add `SUPABASE_URL` (`https://<ref>.supabase.co`), `SUPABASE_ANON_KEY` (the `sb_publishable_…` key, public by design) and `PRIVACY_CONTACT`, the data controller shown in the privacy notice (e.g. `Name Surname, privacy@example.com`).
2. In **Settings → Pages**, set the source to _GitHub Actions_.
3. Push to `main`: the workflow runs every check, then generates `config.js`, adds the commit to every asset URL (`scripts/stamp-assets.mjs`), so browsers never mix two versions, and publishes `web/`. A failing check stops the deployment.
4. In Supabase, set **Authentication → URL Configuration → Site URL** to the Pages URL.

### Backups

`.github/workflows/backup.yml` dumps roles, schema and data (including the `auth` users) every night at 04:00 Italian time (`TIME_ZONE` in the workflow, daylight saving time included) with the Supabase CLI, encrypts the dump with GPG and keeps it as a workflow artifact for 30 days. It needs two repository **secrets**:

- `SUPABASE_DB_URL`: the _Session pooler_ connection string from **Connect** in the Supabase dashboard, with the database password;
- `BACKUP_PASSPHRASE`: a long random passphrase. Keep a copy outside GitHub: without it the backups can't be opened.

To restore, download the artifact and run:

```sh
gpg --decrypt backup-<date>.tar.gz.gpg | tar -xz
psql "$DATABASE_URL" -f backup/roles.sql -f backup/schema.sql \
  -c 'SET session_replication_role = replica' -f backup/data.sql
```

GitHub pauses scheduled workflows after 60 days without commits; re-enable it from the **Actions** tab if that happens.

### Local development

```sh
cp web/config.example.js web/config.js   # fill in URL and key
npx serve web
```

```sh
npm ci
npm test              # unit tests
npm run test:ui       # browser tests (npx playwright install chromium first)
npm run test:db       # database tests, needs psql and an empty PostgreSQL
npm run lint          # formatting check (npm run format fixes it)
```

Browser checks run headlessly against an in-memory API, without touching Supabase. They cover every page in Italian and English at mobile, tablet and desktop widths and save screenshots under `test-results/`. Set `PLAYWRIGHT_PORT` to use another local port, or `PLAYWRIGHT_CHANNEL=msedge` to use an installed Microsoft Edge.

The Supabase client is bundled in `web/vendor/supabase.js`, so the app loads nothing from third-party CDNs. To update it, change the `@supabase/supabase-js` version in `package.json`, then run `npm install` and `npm run vendor`.

## Calendar sync

The personal feed is read live on every request: it includes every event you can see, except the ones you declined. Calendar apps poll it on their own schedule, which for Outlook can take over a day. A downloaded `.ics` file is a one-off copy and never updates.

In Outlook, use **Add calendar → Subscribe from web** with the HTTPS link from the account page; Apple Calendar uses the `webcal:` link. If the link is rejected, open it in a private window: it should return a document starting with `BEGIN:VCALENDAR`. A `401 Missing authorization header` means _Verify JWT_ is still on for `calendar`, and a 404 means an invalid token or an undeployed function.

## Security

- RLS is on for every table, and the `anon` role has no privileges. Clients can only update specific columns, never `is_admin` or `created_by`.
- Visibility is defined once, in `event_visible_to()`: an event is visible to the members of its group, and an invite-only one only to its organizer, invitees and the group's admins. RLS, Realtime and the calendar feed all use it.
- Profiles are visible only to people who share a group or an event with them. Groups and memberships are changed only by admins, through database functions that keep every user in at least one group; leaving a group removes the user's responses, votes and claims from its upcoming events.
- Events and invitees are written only through `save_event()`, which checks permissions and dates. People removed from the invitees also lose their responses, votes and claims.
- Realtime sends deletions to every subscriber with their primary key, so invitations, responses and votes use random surrogate keys that reveal nothing about private events.
- The app also refreshes every 5 minutes while visible, to catch revocations that Realtime cannot deliver.
- Each calendar token has 244 random bits, readable only by its owner; rotating it disables the old link at once.
- The service role key lives only in the Edge Functions, never in the frontend or the repository.
- All of this relies on admins being the only ones who can create accounts, so keep sign-ups and anonymous sign-ins disabled.

## License

[MIT](LICENSE)
