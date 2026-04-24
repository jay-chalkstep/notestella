# Notestella

Personal intelligence layer for a reMarkable Pro.

Notestella turns a calendar, a CRM, and a tablet into a feedback loop. Every
morning it delivers meeting briefs to your reMarkable by email; every evening
it pulls the annotated versions back, extracts your handwritten notes, and
feeds them forward into the next day's briefs and into daily + weekly
reflections. The goal is to augment judgment, not substitute for it — see
**Invariants** below for what that means in practice.

## How it works

### Morning — 4:45am MT (Vercel cron)

Fetches today's Google Calendar events, generates a brief per meeting with at
least one attendee (context, agenda, open threads, questions, and — when Phase
2 is configured — a CRM section tailored to the meeting's lens), plus a daily
overview PDF. Any undelivered reflection from the night before is attached
too. One email lands at your `@my.remarkable.com` address with every PDF as an
attachment; the tablet picks them up before you wake.

### Evening — 9pm MT (GitHub Actions)

`rmapi` pulls annotated PDFs from `/Daily` on the reMarkable, rasterizes each
page at 200dpi, skips blank pages (pixel-mean heuristic — saves an Opus
multimodal call per blank), and POSTs each non-blank page to the evening-sync
route. Claude extracts handwriting into structured notes (`raw_text`,
`summary`, `decisions`, `action_items`). Voyage embeds the result, and notes
land in Supabase keyed to the meeting via the filename's identity stamp.

### Reflection — 9:30pm MT daily, Sunday 10pm MT weekly (Vercel cron)

Daily reflection synthesizes the day's meetings + extracted notes into a
factual narrative with patterns (never conclusions) and a single reflective
question. Weekly reflection covers the past Mon–Sun, adds HubSpot deltas when
snapshot history exists, and ships Monday morning alongside briefs.

### Search — `/` on the deployed URL

Semantic search across every note ever extracted. Ask `what did we decide
about SoCalGas` in plain English; Claude answers from your notes with `[n1]`
inline citations linking to source meetings. Gated by
`NOTESTELLA_READ_SECRET` — the page prompts for the password once and caches
it in `localStorage`.

## Invariants

Two rules that are load-bearing. Every future prompt edit, PDF template
change, and schema migration has to respect them.

### No interpretation

Every generated artifact — briefs, daily overviews, daily reflections, weekly
reflections, search answers — surfaces **facts and patterns**, never
conclusions or psychological interpretation.

| Allowed                                                   | Forbidden                              |
| --------------------------------------------------------- | -------------------------------------- |
| "Austin came up in 3 conversations today re: SoCalGas"    | "Austin seems disengaged"              |
| "Deal at Proposal has no activity for 47 days"            | "This deal is stuck"                   |
| "Rep activity this week is 30% below their 30-day mean"   | "Rep X is checked out"                 |
| Reflective prompts as questions                           | Reflective prompts as advice           |

This is enforced in the system prompts for every Claude call. If you edit a
prompt, scan the output for interpretive verbs ("seems", "appears", "looks
like", "is struggling") and restate as the underlying fact.

### Identity-on-document

Every PDF carries its own identity — no user tagging required. The evening
loop reads identity back out of the document itself.

- **Filename:** `YYYY-MM-DD__slug__meetingId.pdf` (e.g.
  `2026-04-24__austin-weekly__abc123xyz.pdf`). `encodeFilename` /
  `decodeFilename` in `src/types/index.ts` are the canonical encoders.
- **QR footer:** 25pt QR encoding `{meetingId, seriesId, date, version}`.
  Scannable; evening-sync trusts the filename but the QR is the backstop if
  filenames ever get renamed on the device.
- **Series ID:** recurring meetings use Google's `recurringEventId`; one-offs
  use `adhoc:<slug>:<sha1 of sorted attendee emails>` so "Quarterly review
  with ACME" matches the same series whether you add or drop an attendee for
  one instance.

## Requirements

- **reMarkable Pro** with email import configured (mobile app → Settings →
  General → Email Import)
- **ddvk rmapi fork** (`https://github.com/ddvk/rmapi`) — the upstream rmapi
  doesn't auth against the current reMarkable cloud
- Accounts: Supabase (Postgres 15+ with pgvector), Vercel, Anthropic, Google
  Cloud (Calendar API), Resend (domain-verified), HubSpot (Private App),
  Voyage AI. Free tiers of Vercel/Supabase/Resend/HubSpot suffice at personal
  volume.
- Node 20 LTS + pnpm

## Setup

One-time checklist. Details in `docs/build-book.md` §§1–2.

- [ ] Supabase project → `supabase link --project-ref <ref> && supabase db push`
      (applies migrations 0001–0004 in order)
- [ ] Google OAuth Playground dance → `GOOGLE_REFRESH_TOKEN` (book §2.3)
- [ ] Resend domain verify + reMarkable email-import allowlist for the
      from-address (book §2.4 — silent-drop gotcha if the address isn't
      exactly right)
- [ ] HubSpot Private App token with the scopes in book §1.1
- [ ] Seed `people` table with your team (see **Operations** below)
- [ ] All env vars populated in `.env.local` and in Vercel Project Settings
- [ ] Vercel deploy → four crons auto-register from `vercel.json`
- [ ] GitHub repo secrets for evening sync (see **Operations** below)
- [ ] Smoke tests (see **Development** below)

## Development

```bash
pnpm install
pnpm dev   # http://localhost:3000
```

Migrations apply in order via `supabase db push`. 0001 (meetings + briefs),
0002 (people), 0003 (notes + pgvector + `match_notes`), 0004 (reflections +
hubspot_snapshots).

### Smoke tests

Hit each cron route locally with the `CRON_SECRET`:

```bash
# Morning brief — full flow: calendar → briefs → overview → email
curl -X POST http://localhost:3000/api/cron/morning-brief \
  -H "Authorization: Bearer $CRON_SECRET"

# Daily reflection — needs today's meetings + notes in Supabase
curl -X POST http://localhost:3000/api/cron/daily-reflection \
  -H "Authorization: Bearer $CRON_SECRET"

# Weekly reflection — computes Mon–Sun of the week containing today in MT
curl -X POST http://localhost:3000/api/cron/weekly-reflection \
  -H "Authorization: Bearer $CRON_SECRET"

# HubSpot snapshot — writes today's pipeline + rep_activity
curl -X POST http://localhost:3000/api/cron/hubspot-snapshot \
  -H "Authorization: Bearer $CRON_SECRET"
```

Evening-sync is harder to exercise locally because it needs an annotated PDF
on the tablet. Easiest path: dispatch the GitHub Actions workflow manually
(`gh workflow run "Notestella evening sync"`) after writing on a brief.

Search UI: open `http://localhost:3000/`, enter `NOTESTELLA_READ_SECRET` at
the prompt, query.

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

`hubspot_owner_id` is required for the seller lens to query their pipeline;
get it from HubSpot → Settings → Users & Teams → each user's URL.

### Environment variables

Set in `.env.local` for dev and mirror to Vercel Project Settings for prod.

- `ANTHROPIC_API_KEY`, `CRON_SECRET`, `NOTESTELLA_READ_SECRET`
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`
- `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `REMARKABLE_EMAIL`
- `HUBSPOT_PRIVATE_APP_TOKEN`, `HUBSPOT_PORTAL_ID`, `MY_EMAIL`
- `VOYAGE_API_KEY`

`MY_EMAIL` is required whenever `HUBSPOT_PRIVATE_APP_TOKEN` is set —
morning-brief fails loud if you forget it. `NOTESTELLA_READ_SECRET` fails
closed: if unset, `/api/search` returns 401 to everyone including you.

### GitHub Actions secrets (evening sync)

- `RMAPI_CONFIG` — full contents of `~/.config/rmapi/rmapi.conf` after a local
  `rmapi` auth (ddvk fork)
- `EVENING_SYNC_ENDPOINT` — `https://<your-domain>/api/cron/evening-sync`
- `CRON_SECRET` — same value as the Vercel env var

### Expected monthly cost

At personal volume (~10 briefs/day, ~20 notes extracted/day):

- Anthropic: **$15–40/mo** (dominates; most of it is multimodal extraction)
- Voyage: <$5/mo
- Vercel, Supabase, Resend, HubSpot Private App: free tiers are plenty

Set Anthropic usage alerts at $50 and $100 in the Anthropic console.

### Common breakages

| Symptom                                               | Likely cause                                                         | Fix                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| 5am — no email arrives, route logs 200                | reMarkable from-address not in device email-import allowlist          | Open reMarkable app → Settings → Email Import → add address   |
| 5am — route 401s                                      | `CRON_SECRET` drift between Vercel and cron header                    | Rotate in Vercel, redeploy                                     |
| 5am — Google Calendar 401                             | `GOOGLE_REFRESH_TOKEN` expired (6mo non-use or revocation)            | Redo OAuth Playground dance (book §2.3), update env, redeploy  |
| Brief shows no CRM section                            | `MY_EMAIL` unset or attendee not in `people` table                    | Check both; morning-brief now throws on the former              |
| Evening sync fails authentication                     | rmapi token rotated                                                   | Re-auth locally, copy new `rmapi.conf` into `RMAPI_CONFIG`     |
| `match_notes` returns weak hits after ~100 notes      | IVFFlat index trained on empty table                                  | `REINDEX INDEX notes_embedding_idx;` in Supabase SQL editor    |
| Search page returns 401 on every query                | `NOTESTELLA_READ_SECRET` unset or mistyped                            | Set in Vercel, clear `localStorage.ns_read_secret`, re-prompt |

### Known stubs

- `pipeline_wow_delta` in `getExecutiveLensData` — wakes up after two Sunday
  snapshots exist. Needs a small diff-computation against the two most recent
  `hubspot_snapshots` rows; no blocker, just not written yet.
- `rep_anomalies` in `getExecutiveLensData` — needs a 30-day rolling mean and
  stdev of per-rep activity to flag "1.5 stdev below". Requires ~4 Sunday
  snapshots of history. `rep_activity` is now populated by the snapshot cron,
  so the data will be there when you're ready to write the anomaly detector.

## Architecture

See `docs/build-book.md` for phases, contracts, and the canonical prompt
text. File tour:

- `src/app/api/cron/*` — five Vercel-scheduled routes (morning, evening sync,
  daily & weekly reflection, HubSpot snapshot)
- `src/app/api/search/route.ts` — bearer-gated semantic search
- `src/app/page.tsx` — search UI (client component with password prompt)
- `src/lib/*` — external integrations (anthropic, google-calendar, hubspot,
  resend, supabase, voyage) + `lens.ts` for CRM lens selection
- `src/pdf/*` — four `@react-pdf/renderer` templates (meeting brief, daily
  overview, daily/weekly reflection)
- `src/types/index.ts` — `encodeFilename` / `decodeFilename` / `slugify` —
  the identity-on-document encoders
- `supabase/migrations/*` — four migrations, apply in order
- `scripts/evening-sync.sh` — GitHub Actions sidecar, pulls annotated PDFs
  from reMarkable and POSTs each page to the evening-sync route
- `.github/workflows/evening-sync.yml` — nightly runner for the sidecar

The build is a stock Next.js 16 app router deploy — no middleware, no custom
runtime. Every route handler is a straight `POST(req)` that authenticates on
a bearer header and returns `Response.json(...)`.
