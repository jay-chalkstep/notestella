# Notestella

Personal intelligence layer for a reMarkable Pro. Three loops: morning briefs
delivered by email, evening sync of annotated PDFs back to Supabase as embedded
notes, and daily + weekly reflections. See `docs/build-book.md` for the full
spec.

## Setup

One-time checklist. Details in build book §§1–2.

- [ ] Supabase project → `supabase link --project-ref <ref> && supabase db push`
      (applies migrations 0001–0004)
- [ ] Google OAuth Playground dance → `GOOGLE_REFRESH_TOKEN` (book §2.3)
- [ ] Resend domain verify + reMarkable email-import allowlist for the
      from-address (book §2.4)
- [ ] HubSpot Private App token with the scopes in book §1.1
- [ ] Seed `people` table with your team (see below)
- [ ] All env vars populated in `.env.local` and in Vercel Project Settings
- [ ] Vercel deploy → four crons auto-register from `vercel.json`
- [ ] GitHub repo secrets for evening sync (see below)
- [ ] Smoke test: `curl -X POST https://<your-domain>/api/cron/morning-brief -H "Authorization: Bearer $CRON_SECRET"`

## Operations

Things that will break or need periodic attention.

### DST transitions — twice a year, shift every Vercel cron by ±1 hour

Vercel cron is UTC. The schedules in `vercel.json` are set for MT **DST**. When
DST ends (first Sunday in November), add 1 hour; when it begins (second Sunday
in March), subtract 1 hour back.

| Cron path                       | DST (current)    | Standard time    |
| ------------------------------- | ---------------- | ---------------- |
| `/api/cron/morning-brief`       | `45 10 * * *`    | `45 11 * * *`    |
| `/api/cron/daily-reflection`    | `30 3 * * *`     | `30 4 * * *`     |
| `/api/cron/weekly-reflection`   | `0 4 * * 1`      | `0 5 * * 1`      |
| `/api/cron/hubspot-snapshot`    | `0 5 * * 0`      | `0 6 * * 0`      |

The GitHub Actions evening-sync workflow (`.github/workflows/evening-sync.yml`)
is on `0 3 * * *` for DST — shift to `0 4 * * *` when DST ends.

Put a recurring calendar event on your personal calendar one week before each
transition so you remember.

### People table seed (Phase 2)

`selectLens` defaults to `customer` for unknown external attendees and `none`
for internal-only meetings where no attendee is in the table. Seed your team:

```sql
insert into people (email, role, hubspot_owner_id, display_name) values
  ('seller1@yourcompany.com', 'seller',       '12345', 'Seller One'),
  ('seller2@yourcompany.com', 'seller',       '67890', 'Seller Two'),
  ('leader@yourcompany.com',  'sales_leader', null,    'Theresa');
```

`hubspot_owner_id` is required for the seller lens to query their pipeline; get
it from HubSpot → Settings → Users & Teams → each user's URL.

### Environment variables

Set in `.env.local` for dev and mirror to Vercel Project Settings for prod.

- `ANTHROPIC_API_KEY`, `CRON_SECRET`, `NOTESTELLA_READ_SECRET`
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`
- `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `REMARKABLE_EMAIL`
- `HUBSPOT_PRIVATE_APP_TOKEN`, `HUBSPOT_PORTAL_ID`, `MY_EMAIL`
- `VOYAGE_API_KEY`

`MY_EMAIL` is required whenever `HUBSPOT_PRIVATE_APP_TOKEN` is set —
morning-brief fails loud if you forget it.

### GitHub Actions secrets (evening sync)

- `RMAPI_CONFIG` — full contents of `~/.config/rmapi/rmapi.conf` after a local
  `rmapi` auth (ddvk fork)
- `EVENING_SYNC_ENDPOINT` — `https://<your-domain>/api/cron/evening-sync`
- `CRON_SECRET` — same value as the Vercel env var

### Common breakages

| Symptom                                               | Likely cause                                                         | Fix                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| 5am — no email arrives, route logs 200                | reMarkable from-address not in device email-import allowlist          | Open reMarkable app → Settings → Email Import → add address   |
| 5am — route 401s                                      | `CRON_SECRET` drift between Vercel and cron header                    | Rotate in Vercel, redeploy                                     |
| 5am — Google Calendar 401                             | `GOOGLE_REFRESH_TOKEN` expired (6mo non-use or revocation)            | Redo OAuth Playground dance (book §2.3), update env, redeploy  |
| Brief shows no CRM section                            | `MY_EMAIL` unset or attendee not in `people` table                    | Check both; morning-brief now throws on the former              |
| Evening sync fails authentication                     | rmapi token rotated                                                   | Re-auth locally, copy new `rmapi.conf` into `RMAPI_CONFIG`     |
| `match_notes` returns weak hits after ~100 notes      | IVFFlat index trained on empty table                                  | `REINDEX INDEX notes_embedding_idx;` in Supabase SQL editor    |

### Known stubs

- `pipeline_wow_delta` in `getExecutiveLensData` — wakes up after two Sunday
  snapshots exist. Needs a small diff-computation against the two most recent
  `hubspot_snapshots` rows; no blocker, just not written yet.
- `rep_anomalies` in `getExecutiveLensData` — needs a 30-day rolling mean and
  stdev of per-rep activity to flag "1.5 stdev below". Requires ~4 Sunday
  snapshots of history. `rep_activity` is now populated by the snapshot cron,
  so the data will be there when you're ready to write the anomaly detector.

## Architecture

See `docs/build-book.md` for phases, contracts, and prompt sources. File tour:

- `src/app/api/cron/*` — five Vercel-scheduled routes (morning, evening sync,
  daily & weekly reflection, HubSpot snapshot)
- `src/app/api/search/route.ts` — bearer-gated semantic search
- `src/lib/*` — external integrations (anthropic, google-calendar, hubspot,
  resend, supabase, voyage) + `lens.ts` for CRM lens selection
- `src/pdf/*` — four `@react-pdf/renderer` templates (meeting brief, daily
  overview, daily/weekly reflection)
- `supabase/migrations/*` — four migrations, apply in order
- `scripts/evening-sync.sh` — GitHub Actions sidecar, pulls annotated PDFs
  from reMarkable and POSTs each page to the evening-sync route
