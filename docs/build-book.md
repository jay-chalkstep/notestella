# Notestella — Build Book

A phased, executable handoff. Follow top to bottom; each phase ends with a done criteria you can check against. If you're a coding assistant: you can fill in implementation details where the book gives you a behavioral contract — just don't invent structure the book doesn't specify.

---

## 0. Overview

You're building a personal intelligence layer for a reMarkable Pro. Three loops:

- **Morning** (Vercel cron, 4:45am MT): Calendar → per-meeting briefs + daily overview → email to `@my.remarkable.com`.
- **Evening** (GitHub Actions, ~9pm MT): rmapi pulls annotated PDFs → Claude multimodal extracts notes → embeddings stored in Supabase.
- **Reflection** (Vercel cron, ~9:30pm daily / Sunday 10pm weekly): Synthesizes notes into patterns, delivered with next morning's brief.

Identity travels with the document: every PDF has a structured filename, header metadata, and QR footer encoding `{meetingId, seriesId, date, version}`. Evening sync parses identity back out without any user tagging.

**Build in strict phase order.** Each phase depends on the previous one being stable.

### How to read this book

- Each phase has numbered steps. Do them in order.
- Bash commands are runnable as-is unless noted.
- SQL is final — copy verbatim into migration files.
- TypeScript shown is either final code (labeled "implementation") or a behavioral spec (labeled "contract"). Fill in contracts; don't change implementations.
- Environment variables use `UPPER_SNAKE` and are defined once in §1 — reference that list when wiring a new service.

---

## 1. Prerequisites

### 1.1 Accounts and services

Set these up in order; later steps need keys from earlier ones.

| Service | Purpose | What to get |
|---|---|---|
| GitHub | Source host + Phase 3 workflow runner | Empty private repo |
| Vercel | Hosting + cron | Linked to GitHub repo |
| Supabase | Postgres + pgvector | New project, Postgres 15+, region near you |
| Anthropic | Brief/reflection/extraction | API key with Claude access |
| Google Cloud | Calendar API | OAuth 2.0 client (web app type) |
| Resend | Email delivery | Domain verified, API key |
| HubSpot | CRM data (Phase 2) | Private App token with scopes below |
| Voyage AI | Embeddings (Phase 3) | API key |
| reMarkable | Target device | `@my.remarkable.com` email set up in mobile app |

**HubSpot scopes for Private App:** `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read`, `crm.objects.owners.read`, `crm.schemas.contacts.read`, `crm.schemas.companies.read`, `crm.schemas.deals.read`, `sales-email-read`.

### 1.2 Local tooling

- Node 20.x LTS
- pnpm (or npm — this book uses pnpm)
- Supabase CLI (`brew install supabase/tap/supabase`)
- Vercel CLI (`pnpm i -g vercel`)
- Go (only for Phase 3 rmapi build, and only if you build locally; CI builds its own)

### 1.3 Environment variables (master list)

Set these in `.env.local` for dev, and mirror them to Vercel Project Settings → Environment Variables for prod. The `*_PROD` split is optional; I use one value per name and rely on Vercel environments.

```
# Anthropic
ANTHROPIC_API_KEY=

# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # server-only, never expose to client

# Google Calendar
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
GOOGLE_CALENDAR_ID=primary        # or a specific calendar id

# Resend
RESEND_API_KEY=
RESEND_FROM_ADDRESS=notestella@yourdomain.com
REMARKABLE_EMAIL=you@my.remarkable.com

# HubSpot (Phase 2)
HUBSPOT_PRIVATE_APP_TOKEN=
HUBSPOT_PORTAL_ID=                # useful for deep-links into CRM

# Voyage AI (Phase 3)
VOYAGE_API_KEY=

# Cron security
CRON_SECRET=                      # long random string; Vercel sends it in Authorization header

# Optional
TZ=America/Denver                 # documentation only; Vercel cron is UTC
```

---

## 2. Phase 1 — Morning Loop (MVP)

Goal: by end of phase, PDFs arrive on the reMarkable every morning at 5am MT.

### 2.1 Repo bootstrap

```bash
pnpm create next-app@latest notestella --ts --app --tailwind --eslint --src-dir --import-alias "@/*"
cd notestella
pnpm add @anthropic-ai/sdk @supabase/supabase-js googleapis resend \
  @react-pdf/renderer qrcode zod date-fns date-fns-tz
pnpm add -D @types/qrcode
```

Create directory scaffolding:

```bash
mkdir -p supabase/migrations src/lib src/pdf src/types \
  src/app/api/cron/morning-brief \
  src/app/api/cron/evening-sync \
  src/app/api/search
```

### 2.2 Supabase schema — initial migration

File: `supabase/migrations/0001_init.sql`

```sql
create extension if not exists "uuid-ossp";

create table meetings (
  id text primary key,                          -- Google Cal event id
  series_id text not null,
  title text not null,
  description text,
  start_time timestamptz not null,
  end_time timestamptz not null,
  attendees jsonb not null default '[]'::jsonb, -- [{email, name?, organizer?, responseStatus?}]
  brief_generated_at timestamptz,
  notes_extracted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index meetings_series_id_idx on meetings(series_id);
create index meetings_start_time_idx on meetings(start_time desc);

create table briefs (
  id uuid primary key default uuid_generate_v4(),
  meeting_id text references meetings(id) on delete cascade,
  brief_date date not null,
  brief_type text not null,                     -- 'meeting' | 'daily_overview'
  pdf_filename text not null,
  delivered_to_remarkable boolean not null default false,
  delivered_at timestamptz,
  context_meetings jsonb default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index briefs_brief_date_idx on briefs(brief_date desc);
create index briefs_meeting_id_idx on briefs(meeting_id);

create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger meetings_updated_at before update on meetings
  for each row execute function set_updated_at();
```

Apply:

```bash
supabase link --project-ref <your-ref>
supabase db push
```

### 2.3 Google Calendar OAuth setup

One-time dance to get a long-lived refresh token.

1. Google Cloud Console → APIs & Services → OAuth consent screen. External user type. Add yourself as a test user.
2. Credentials → Create OAuth 2.0 Client → Web application. Authorized redirect URI: `https://developers.google.com/oauthplayground`.
3. Go to https://developers.google.com/oauthplayground. Click the gear, check "Use your own OAuth credentials", paste client ID + secret.
4. Left panel → "Calendar API v3" → select `https://www.googleapis.com/auth/calendar.readonly`.
5. Authorize → sign in with your Google account → Exchange authorization code for tokens.
6. Copy the refresh token. That's your `GOOGLE_REFRESH_TOKEN`.

Gotcha: refresh tokens expire after 6 months of non-use, or if the Google account revokes access. If you hit 401s in prod, redo this dance.

### 2.4 Resend + reMarkable allowlist

1. Add and verify a domain in Resend.
2. Create API key.
3. On your phone: open the reMarkable app → Settings → General → Email Import. Add the exact from-address you'll use (e.g. `notestella@yourdomain.com`). **Silent-drop gotcha**: if this isn't exactly right, emails vanish with no error anywhere.
4. Test: send yourself a plain email from that address with a PDF attachment. Confirm it appears in the device's Inbox. Do not proceed until this works.

### 2.5 Core lib files

#### `src/lib/supabase.ts` (implementation)

```ts
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);
```

#### `src/lib/google-calendar.ts` (contract)

Exports:

- `getTodaysEvents(date: Date): Promise<CalendarEvent[]>` — returns events for the given day in the calendar's timezone, with attendees populated. Only includes events where `status !== 'cancelled'`.
- `deriveSeriesId(event: CalendarEvent): string` — returns `event.recurringEventId` if present. Otherwise derives `adhoc:${slug(normalizedTitle)}:${sha1(sortedAttendeeEmails.join(','))}` (normalized = lowercase, strip leading "Re:", "Fwd:", and trim whitespace).

Uses `google.auth.OAuth2` with refresh token; no per-request auth flow.

#### `src/lib/anthropic.ts` (contract)

Exports:

- `generateMeetingBrief(input: BriefInput): Promise<BriefOutput>` — see §2.7 for the prompt and schema.
- `generateDailyOverview(input: DailyOverviewInput): Promise<DailyOverviewOutput>` — see §2.7.
- `extractNotesFromImage(imageBase64: string, meetingContext: { title: string; date: string }): Promise<NoteExtraction>` — Phase 3.
- `generateDailyReflection(input: ReflectionInput): Promise<ReflectionOutput>` — Phase 4.
- `generateWeeklyReflection(input: ReflectionInput): Promise<ReflectionOutput>` — Phase 4.

All callers use `claude-opus-4-7`. All JSON-returning calls: system prompt instructs "respond with JSON only, no markdown fences"; parser strips fences defensively; on parse failure, log the raw response body and throw.

#### `src/lib/resend.ts` (contract)

Exports:

- `sendPdfsToRemarkable(pdfs: { filename: string; buffer: Buffer }[], subject: string): Promise<void>` — one email with all attachments. Subject format: `Notestella — ${formattedDate}`.

#### `src/lib/qr.ts` (implementation)

```ts
import QRCode from 'qrcode';

export async function generateQrDataUrl(payload: object): Promise<string> {
  const json = JSON.stringify(payload);
  return QRCode.toDataURL(json, { errorCorrectionLevel: 'M', margin: 1, scale: 4 });
}
```

### 2.6 Filename convention + types

#### `src/types/index.ts`

```ts
export type Attendee = {
  email: string;
  name?: string;
  organizer?: boolean;
  responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
};

export type CalendarEvent = {
  id: string;
  recurringEventId?: string;
  title: string;
  description?: string;
  startTime: string;  // ISO
  endTime: string;    // ISO
  attendees: Attendee[];
};

export type Meeting = {
  id: string;
  series_id: string;
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  attendees: Attendee[];
  brief_generated_at?: string;
  notes_extracted_at?: string;
};

export type QrPayload = {
  meetingId: string;
  seriesId: string;
  date: string;      // YYYY-MM-DD
  version: number;   // start at 1; bump only if PDF format changes
};

const SLUG_MAX_LEN = 40;

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN);
}

export function encodeFilename(date: string, title: string, meetingId: string): string {
  return `${date}__${slugify(title)}__${meetingId}.pdf`;
}

const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})__([a-z0-9-]+)__(.+)\.pdf$/;

export function decodeFilename(filename: string):
  | { date: string; slug: string; meetingId: string }
  | null {
  const m = filename.match(FILENAME_RE);
  if (!m) return null;
  return { date: m[1], slug: m[2], meetingId: m[3] };
}
```

### 2.7 Claude prompts (Phase 1)

These are opinionated. Change only with evidence.

#### Meeting brief — system prompt

```
You generate meeting briefs for a CEO preparing on a reMarkable Pro tablet.
Output JSON only. No markdown fences, no preamble.

Required shape:
{
  "context": string,           // 2-4 sentences: why this meeting matters given priors
  "agenda_suggestions": string[], // 3-6 bullets, imperative voice
  "open_threads": string[],    // things carried over from prior meetings in this series
  "questions_to_ask": string[], // 3-5 sharp questions
  "prep_notes": string[]       // optional; up to 3 bullets if genuinely useful
}

Rules:
- Never fabricate facts. If priors say nothing, say nothing.
- Never advise on tone or psychology. Surface facts and open loops.
- Prefer specificity: "Follow up on SoCalGas scope changes from 4/12" > "Discuss project status".
- If the meeting has no priors, set open_threads to [] and say so in context briefly.
```

#### Meeting brief — user message template

```
Meeting: {{title}}
Date: {{date}} {{start_time}}-{{end_time}} MT
Attendees: {{attendee_names_and_emails}}
Description: {{description_or_none}}

Prior meetings in this series (most recent first, up to 5):
{{for each prior: ## {{date}} — {{title}}
Summary: {{summary_or_briefed_only}}
Decisions: {{decisions_json}}
Action items: {{action_items_json}}
---}}

Generate the brief.
```

#### Daily overview — system prompt

```
You generate a daily calendar overview for a CEO's reMarkable Pro.
Output JSON only.

Shape:
{
  "shape_of_day": string,              // 2-3 sentences on the day's arc
  "watch_outs": string[],              // conflicts, tight transitions, prep-heavy meetings
  "parking_lot_prompts": string[]      // 3-5 prompts to seed the parking-lot section
}

Rules:
- No fabrication. No psychology. No advice on how to show up.
- Watch-outs are mechanical (back-to-back, double-booked, travel time).
- Parking lot prompts are generic-but-useful: "What decision am I delaying?"
```

### 2.8 PDF templates

#### `src/pdf/meeting-brief.tsx` (contract)

Portrait letter-size. Sections top to bottom:

1. Header band: meeting title, date, time, attendees (max 6 shown; "+ N more" otherwise).
2. Context paragraph.
3. Open threads (if any).
4. Agenda suggestions (bulleted).
5. Questions (bulleted, sparse).
6. Prep notes (only if non-empty).
7. **CRM section placeholder** — empty in Phase 1, populated in Phase 2.
8. A large blank ruled area (the "notes zone") — at least 55% of the page.
9. Footer: tiny QR on left (25pt square), filename on right in 7pt mono.

QR payload: `{ meetingId, seriesId, date, version: 1 }`.

Use `Font.register` for a clean sans (Inter) and a readable mono (JetBrains Mono) for the filename. No color on the brief except a single accent stripe on the header.

#### `src/pdf/daily-overview.tsx` (contract)

Landscape letter-size. Two columns:

- **Left (40%)**: shape-of-day paragraph, watch-outs, the day's meeting list (time + title + attendee count).
- **Right (60%)**: parking lot — top third has the prompts as faint guidance; rest is a blank ruled canvas.

Footer: date on left, QR on right encoding `{ meetingId: "daily", seriesId: "daily-overview", date, version: 1 }`.

### 2.9 Morning cron route

File: `src/app/api/cron/morning-brief/route.ts`

Behavioral contract (implementation left to engineer):

```ts
// export async function POST(req: Request): Promise<Response>
// Auth: require header `Authorization: Bearer ${CRON_SECRET}`. 401 otherwise.
// Steps:
//   1. Compute today's date in MT.
//   2. Fetch events via getTodaysEvents(today).
//   3. Upsert into meetings table (id as pkey).
//   4. For each event with attendees.length >= 1:
//        a. Load up to 5 prior meetings WHERE series_id = X AND start_time < now ORDER BY start_time DESC.
//           For Phase 1, prior "summary" is "briefed only" since notes aren't extracted yet.
//        b. Call generateMeetingBrief.
//        c. Render meeting-brief PDF to Buffer.
//        d. Push onto an array of attachments with encodeFilename(date, title, id).
//        e. Insert briefs row.
//   5. Call generateDailyOverview with the day's meeting list.
//   6. Render daily-overview PDF.
//   7. Call sendPdfsToRemarkable with all attachments, subject `Notestella — <Weekday, Mon D>`.
//   8. Update meetings.brief_generated_at.
//   9. Return 200 with a summary JSON: { event_count, brief_count, delivered }.
//
// On any step failure: log with structured fields (phase, event_id), attempt to deliver what you have,
// return 207 Multi-Status with per-meeting results.
```

### 2.10 Cron schedule

File: `vercel.json`

```json
{
  "crons": [
    { "path": "/api/cron/morning-brief", "schedule": "45 10 * * *" }
  ]
}
```

Note: `45 10 * * *` UTC = 4:45am MT during DST. When DST ends (first Sunday in November), change to `45 11 * * *`. Add a calendar reminder.

Vercel sends cron requests with `Authorization: Bearer <your CRON_SECRET>` when that env var is set in Project Settings. Enforce it in the route.

### 2.11 Smoke test

1. Locally: `pnpm dev`, then `curl -X POST http://localhost:3000/api/cron/morning-brief -H "Authorization: Bearer $CRON_SECRET"`.
2. Inspect: a PDF per meeting + one daily overview should land in your reMarkable inbox within ~60s.
3. Open one brief on the tablet. Confirm: filename matches `YYYY-MM-DD__slug__id.pdf`, QR scans to valid JSON.
4. Deploy: `vercel --prod`. Set all env vars in Vercel dashboard. Verify first 4:45am MT run.

### 2.12 Phase 1 done criteria

- [ ] Tomorrow's 4:45am MT cron delivers briefs for all meetings with attendees.
- [ ] Filename format is correct; QR decodes to valid JSON.
- [ ] Daily overview PDF delivered alongside.
- [ ] Zero manual steps required between sleep and reading on the tablet.
- [ ] `briefs` table has a row for every delivered PDF.

---

## 3. Phase 2 — HubSpot Three-Lens

Goal: per-meeting briefs contain a CRM section appropriate to the attendee context — customer, seller, or sales leader.

### 3.1 HubSpot Private App

1. HubSpot → Settings → Integrations → Private Apps → Create.
2. Add scopes listed in §1.1.
3. Copy the token into `HUBSPOT_PRIVATE_APP_TOKEN`. Put your portal ID in `HUBSPOT_PORTAL_ID` (top of any HubSpot URL).

### 3.2 Migration — people table

File: `supabase/migrations/0002_people.sql`

```sql
create type person_role as enum ('customer', 'seller', 'sales_leader', 'other');

create table people (
  email text primary key,
  role person_role not null default 'customer',
  hubspot_owner_id text,
  display_name text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger people_updated_at before update on people
  for each row execute function set_updated_at();

-- Seed your team manually via psql or Supabase Studio after migration.
-- Example:
-- insert into people (email, role, hubspot_owner_id, display_name) values
--   ('seller1@yourcompany.com', 'seller', '12345', 'Seller One'),
--   ('leader@yourcompany.com', 'sales_leader', null, 'Theresa');
```

### 3.3 `src/lib/hubspot.ts` (contract)

Exports:

- `getCustomerLensData(emails: string[]): Promise<CustomerLensData>` — for one or more external attendees. Returns: contacts, associated companies, open deals grouped by company, stage names, last activity dates, a `stuck_deal_flags` array for deals where `stage !== 'Closed Won|Lost'` AND `days_since_last_activity > 30`.
- `getSellerLensData(hubspotOwnerId: string, windowDays: number = 7): Promise<SellerLensData>` — returns that seller's: pipeline snapshot (open deals by stage with amounts), activity count for window (emails logged, calls logged, meetings logged), deals that changed stage in window, deals with `days_since_last_activity > 14`, accounts they own with no activity in 30 days, forecast vs. actual (current-quarter closed won vs. quota if stored; nullable).
- `getExecutiveLensData(windowDays: number = 7): Promise<ExecutiveLensData>` — aggregate team view: total pipeline by stage, WoW delta, top 10 open deals by amount, at-risk deals (`days_since_last_activity > 21` OR `close_date_passed`), win/loss since last window, per-rep anomalies (activity count ≥ 1.5 stdev below 30-day mean).

**Implementation guardrails:**

- Use the `hubspot-api-client` SDK or fetch with `Authorization: Bearer ${token}`.
- Batch: for a meeting with N external attendees, one contact search by email array, then one company batch-read, then one deal search by company ids. Do NOT loop per-email.
- Cache within a single cron run: a simple in-memory Map keyed by email, company id, owner id.
- Respect rate limits: 100 req/10s per app. Insert delays only if you hit 429.

Lens data types should be JSON-serializable and shallow enough that the PDF template can iterate them without further processing.

### 3.4 Lens selection logic

Add `src/lib/lens.ts`:

```ts
// type Lens = 'customer' | 'seller' | 'sales_leader' | 'none';
//
// export async function selectLens(meeting: Meeting, myEmail: string): Promise<{
//   lens: Lens;
//   focusPersonEmail?: string; // for seller/sales_leader lenses
// }>
//
// Rules:
// 1. If meeting is a 1:1 (exactly 2 attendees) and the non-me attendee has role 'sales_leader' in people table → executive lens.
// 2. Else if meeting is a 1:1 and the non-me attendee has role 'seller' → seller lens, focusPerson = them.
// 3. Else if any external attendee exists and is not in people table or is role 'customer' → customer lens.
// 4. Else → 'none' (internal-only meeting with no sales role → skip CRM section).
//
// Ambiguity note: if a meeting has both a customer AND a seller (a joint call), lens is 'customer'.
// This is a first-pass rule — revisit if joint-call briefings feel thin.
```

### 3.5 Brief generator update

Update `generateMeetingBrief` in `src/lib/anthropic.ts` to accept lens data and inject a CRM section into output:

New output shape:

```
{
  "context": string,
  "agenda_suggestions": string[],
  "open_threads": string[],
  "questions_to_ask": string[],
  "prep_notes": string[],
  "crm_section": {
    "lens": "customer" | "seller" | "sales_leader" | "none",
    "facts": string[],     // raw factual bullets, no interpretation
    "flags": string[]      // anomalies worth noticing, still factual
  } | null
}
```

Add this to the system prompt:

```
If crm_section is provided in the input, synthesize it into facts[] and flags[].

Facts are mechanical readouts: "3 open deals totaling $420K", "Last activity on X: 14 days ago",
"Pipeline grew $180K week-over-week".

Flags are anomalies worth noticing, still stated as facts: "Deal at Proposal stage has no activity
for 47 days", "Activity this week is 40% below this rep's 30-day average".

Do not draw conclusions. Never write "X is struggling", "X is checked out", "this deal is stuck",
"the customer is disengaged". If you find yourself wanting to write a conclusion, restate the
underlying fact instead.
```

### 3.6 Meeting brief PDF — CRM section

Update `src/pdf/meeting-brief.tsx` to render CRM between Questions and the notes zone.

Render rules:
- If `crm_section === null`, skip entirely.
- Lens label renders at the top of the section ("CRM — Customer view", "CRM — Seller 1:1", "CRM — Executive view").
- Facts as a compact list.
- Flags in a separate sub-block with a subtle left border to draw attention without shouting.
- Budget: max 6 facts + 6 flags. If Claude returns more, truncate with "+N more" and log a warning.

### 3.7 Wire it together

In `morning-brief/route.ts`, for each meeting:

1. `const { lens, focusPersonEmail } = await selectLens(meeting, MY_EMAIL);`
2. Based on lens, call the appropriate `getXLensData`.
3. Pass result into `generateMeetingBrief`.

### 3.8 Phase 2 done criteria

- [ ] `people` table seeded with your team.
- [ ] A customer meeting brief shows accurate open deals and last-activity dates.
- [ ] A seller 1:1 brief shows their pipeline and activity stats.
- [ ] An exec 1:1 brief shows team-level aggregates and anomalies.
- [ ] No brief contains interpretive language ("checked out", "stuck", "struggling"). If any does, adjust the prompt and redeploy.
- [ ] One cron run uses ≤ 20 HubSpot API calls total across a typical 8-meeting day.

---

## 4. Phase 3 — Evening Loop

Goal: by end of phase, annotated PDFs from today automatically flow back as structured, embedded notes in Supabase.

### 4.1 Migration — notes + pgvector

File: `supabase/migrations/0003_notes_and_match.sql`

```sql
create extension if not exists vector;

create table notes (
  id uuid primary key default uuid_generate_v4(),
  meeting_id text not null references meetings(id) on delete cascade,
  series_id text not null,
  page_number int not null default 1,
  raw_text text not null,
  summary text,
  decisions jsonb not null default '[]'::jsonb,
  action_items jsonb not null default '[]'::jsonb,
  embedding vector(1024),
  note_date date not null,
  created_at timestamptz not null default now()
);

create index notes_meeting_id_idx on notes(meeting_id);
create index notes_series_id_idx on notes(series_id);
create index notes_note_date_idx on notes(note_date desc);

-- IVFFlat is fine for personal volume. Revisit if scale changes.
create index notes_embedding_idx on notes using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create or replace function match_notes(
  query_embedding vector(1024),
  match_threshold float default 0.7,
  match_count int default 10
)
returns table (
  id uuid,
  meeting_id text,
  series_id text,
  raw_text text,
  summary text,
  note_date date,
  similarity float
)
language sql stable as $$
  select
    n.id, n.meeting_id, n.series_id, n.raw_text, n.summary, n.note_date,
    1 - (n.embedding <=> query_embedding) as similarity
  from notes n
  where n.embedding is not null
    and 1 - (n.embedding <=> query_embedding) > match_threshold
  order by n.embedding <=> query_embedding
  limit match_count;
$$;
```

Apply: `supabase db push`.

### 4.2 rmapi setup

- Use the ddvk fork: https://github.com/ddvk/rmapi
- Register once on your local machine: `rmapi` → follow the one-time-code flow → a config file lands in `~/.config/rmapi/rmapi.conf`.
- This file contains the auth token. You'll copy it into a GitHub secret for CI.

### 4.3 Voyage setup

Trivial: API key in env. Endpoint: `https://api.voyageai.com/v1/embeddings`, model `voyage-3`, returns 1024-dim vectors.

`src/lib/voyage.ts` (contract): `embed(text: string): Promise<number[]>` — handles retries on 429/5xx.

### 4.4 GitHub Actions workflow

File: `.github/workflows/evening-sync.yml`

```yaml
name: Notestella evening sync

on:
  schedule:
    - cron: '0 3 * * *'   # 9pm MT during DST; switch to '0 4 * * *' after DST ends
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Install rmapi
        run: |
          wget -q https://github.com/ddvk/rmapi/releases/latest/download/rmapi-linuxx86-64.tar.gz
          tar -xzf rmapi-linuxx86-64.tar.gz
          sudo mv rmapi /usr/local/bin/
          mkdir -p ~/.config/rmapi
          echo "${{ secrets.RMAPI_CONFIG }}" > ~/.config/rmapi/rmapi.conf

      - name: Install image tools
        run: sudo apt-get update && sudo apt-get install -y poppler-utils imagemagick

      - name: Checkout
        uses: actions/checkout@v4

      - name: Pull today's annotated PDFs
        env:
          ENDPOINT: ${{ secrets.EVENING_SYNC_ENDPOINT }}    # https://notestella.com/api/cron/evening-sync
          CRON_SECRET: ${{ secrets.CRON_SECRET }}
        run: bash scripts/evening-sync.sh
```

### 4.5 Sidecar script

File: `scripts/evening-sync.sh` (behavioral contract — implement in bash or Node; bash shown):

```
# Behavior:
# 1. rmapi ls /Daily  → parse filenames modified in last 26 hours.
# 2. For each candidate filename matching YYYY-MM-DD__<slug>__<meetingId>.pdf:
#      a. rmapi get "/Daily/<name>" to ./tmp/<name>
#      b. pdftoppm -r 200 ./tmp/<name> ./tmp/<base> -png   # rasterize all pages
#      c. For each page PNG:
#           - heuristic: only submit pages that have significant non-white pixels beyond what the
#             template prints. (Simple impl: compare mean pixel value against the untouched template;
#             below a threshold = has ink.)  [OPTIONAL optimization — safe to send all pages initially.]
#           - base64-encode the PNG.
#           - POST to ENDPOINT with { filename, page_number, image_base64 }
#             Headers: Authorization: Bearer ${CRON_SECRET}
# 3. Log per-file success/failure. Exit 0 unless >50% failed.
```

### 4.6 Evening sync route

File: `src/app/api/cron/evening-sync/route.ts`

Behavior:

```
// POST { filename: string; page_number: int; image_base64: string }
// Auth: Bearer CRON_SECRET.
// Steps:
//   1. decodeFilename(filename) → { date, slug, meetingId }. If null, 400.
//   2. Load meeting by id. If missing, 404 (shouldn't happen — means the filename lies).
//   3. Call extractNotesFromImage(image_base64, { title, date }) → NoteExtraction.
//      NoteExtraction shape:
//      {
//        "raw_text": string,                 // best-effort transcription, preserving line breaks
//        "summary": string,                  // 2-4 sentences
//        "decisions": string[],              // 0..N
//        "action_items": [{ description, owner?, due? }]
//      }
//      If the page is blank / no handwriting detected, return { skipped: true }.
//   4. voyage.embed(summary + "\n\n" + raw_text) → vector.
//   5. Insert into notes: meeting_id, series_id (from meeting), page_number, raw_text, summary,
//      decisions, action_items, embedding, note_date = date.
//   6. Update meetings.notes_extracted_at = now().
//   7. Return 200 { note_id, skipped: false }.
```

### 4.7 Multimodal extraction prompt

System prompt for `extractNotesFromImage`:

```
You are extracting handwritten notes from a meeting page.

You will see an image of a PDF page with printed meeting metadata (title, date, context, etc.)
at the top, and handwritten notes below. IGNORE the printed content completely. Only extract
handwritten annotations.

If the page has no handwritten content, return { "skipped": true } and nothing else.

Otherwise return JSON:
{
  "raw_text": string,
  "summary": string,
  "decisions": string[],
  "action_items": [{ "description": string, "owner": string | null, "due": string | null }]
}

Rules:
- Preserve the writer's actual words. Don't paraphrase raw_text.
- If handwriting is unclear, your best guess is fine. Mark uncertain words with [?].
- A "decision" is something concluded (e.g., "Ship Phase 2 next Friday").
- An "action item" is something to be done (e.g., "Ping Austin re: SoCalGas").
- Do not infer beyond what's on the page.
```

User message is just the image + `Meeting: {{title}} on {{date}}`.

### 4.8 Phase 3 done criteria

- [ ] Write a test note on today's meeting brief. Evening sync extracts it within 24 hours.
- [ ] `notes` row populated with correct meeting_id and non-null embedding.
- [ ] Decisions and action items, if present, correctly split out.
- [ ] Next morning's brief for the same series shows that note's summary in "prior meetings".
- [ ] `match_notes` SQL function returns sensible similarity when tested with an arbitrary query embedding.

---

## 5. Phase 4 — Reflection Loop

Goal: by end of phase, every morning I read yesterday's reflection alongside today's briefs, and every Monday I start with the week's reflection.

### 5.1 Migration — reflections

File: `supabase/migrations/0004_reflections.sql`

```sql
create type reflection_type as enum ('daily', 'weekly');

create table reflections (
  id uuid primary key default uuid_generate_v4(),
  type reflection_type not null,
  period_start date not null,
  period_end date not null,
  content jsonb not null,
  pdf_filename text,
  delivered_at timestamptz,
  source_notes jsonb not null default '[]'::jsonb,       -- array of note ids
  source_meetings jsonb not null default '[]'::jsonb,    -- array of meeting ids
  created_at timestamptz not null default now()
);

create unique index reflections_unique_daily on reflections(type, period_start)
  where type = 'daily';
create unique index reflections_unique_weekly on reflections(type, period_start)
  where type = 'weekly';
```

### 5.2 Daily reflection generator

File: `src/app/api/cron/daily-reflection/route.ts`

Behavior:

```
// Runs at ~9:30pm MT (cron: "30 3 * * *" DST, "30 4 * * *" standard)
// Steps:
//   1. today := today's date in MT.
//   2. Load today's meetings + notes.
//   3. If both lists are empty → skip (log "no activity").
//   4. Call generateDailyReflection with both.
//   5. Render daily-reflection PDF.
//   6. Insert reflections row with type='daily', period_start=today, period_end=today,
//      source_notes/meetings populated, pdf_filename set.
//   7. Return 200 { reflection_id, note_count, meeting_count }.
// Delivery is handled by the morning-brief route, which picks up the most recent undelivered
// reflection and includes it in the email.
```

### 5.3 Daily reflection prompt

System prompt:

```
You generate a daily reflection for a CEO reviewing the day on a reMarkable Pro.
Output JSON only.

Shape:
{
  "day_in_review": string,           // 3-5 sentences, factual narrative of the day's arc
  "decisions_made": string[],        // pulled from notes
  "new_action_items": [{ "description": string, "owner": string | null, "due": string | null }],
  "open_threads": string[],          // items not resolved, carrying forward
  "patterns_noticed": string[],      // 0-3 observations across meetings. Patterns only, not conclusions.
  "reflective_prompt": string        // one single prompt, not a list
}

Rules (ABSOLUTE):
- Surface facts and patterns. Never conclusions.
- "Austin came up in 3 conversations today, all about SoCalGas" = pattern. OK.
- "Austin seems disengaged" = conclusion. FORBIDDEN.
- Reflective prompt is a question, not advice. "What would it take to close the SoCalGas loop this week?"
  not "You should focus on closing SoCalGas."
- If nothing rises to pattern level, return patterns_noticed: [].
- If notes are sparse, don't compensate by inflating. Short is fine.
```

User message: all of the day's meetings (title, attendees, time) plus all of the day's notes (summary, decisions, action_items). Raw text included as fallback but summary-first.

### 5.4 Weekly reflection generator

File: `src/app/api/cron/weekly-reflection/route.ts`

Behavior:

```
// Runs Sunday ~10pm MT (cron: "0 4 * * 1" DST, "0 5 * * 1" standard — note Monday UTC)
// Steps:
//   1. Compute week window: prior Monday 00:00 MT to Sunday 23:59 MT.
//   2. Load week's meetings + notes + last week's meetings/notes for delta context.
//   3. If Phase 2 is live: pull current HubSpot snapshot + last-week snapshot (you'll need to
//      persist weekly HubSpot snapshots; see §5.6).
//   4. Call generateWeeklyReflection with all.
//   5. Render weekly-reflection PDF.
//   6. Insert reflections row type='weekly', period_start = Monday, period_end = Sunday.
//   7. Queue for Monday morning delivery.
```

### 5.5 Weekly reflection prompt

System prompt:

```
You generate a weekly reflection for a CEO. Output JSON only.

Shape:
{
  "week_in_review": string,                // 4-6 sentences
  "recurring_people": [{ "name": string, "email": string, "count": int, "contexts": string[] }],
  "recurring_topics": [{ "topic": string, "meeting_refs": string[] }],
  "action_items_status": {
    "closed_this_week": string[],
    "still_open": string[],
    "drifting": string[]                   // open > 14 days
  },
  "hubspot_deltas": {                      // null if HubSpot data not provided
    "pipeline_change": string,             // "Pipeline +$420K WoW" style
    "deals_moved": string[],
    "deals_gone_cold": string[],
    "rep_anomalies": string[]
  } | null,
  "patterns_noticed": string[],
  "reflective_prompt": string              // one question for the week ahead
}

Rules:
- Same as daily: facts and patterns, never conclusions.
- "This rep's activity is 30% below their 30-day average" = anomaly fact. OK.
- "This rep is disengaged" = conclusion. FORBIDDEN.
- Drifting action items: list the description + age in days ("Ping Austin re: SoCalGas — 21d").
```

### 5.6 HubSpot weekly snapshot (supporting infrastructure)

For weekly deltas you need last-week's numbers on hand. Add a tiny cron `/api/cron/hubspot-snapshot` that runs Sunday 11pm MT, pulls a compact aggregate (pipeline by stage, rep activity counts, top open deals), and writes to a `hubspot_snapshots` table keyed by `snapshot_date`. Weekly reflection reads the two most recent snapshots to compute deltas.

```sql
create table hubspot_snapshots (
  snapshot_date date primary key,
  pipeline_by_stage jsonb not null,
  rep_activity jsonb not null,
  top_open_deals jsonb not null,
  raw jsonb not null,
  created_at timestamptz not null default now()
);
```

### 5.7 Reflection PDF templates

`src/pdf/daily-reflection.tsx` — portrait. Header "Daily Reflection — {{date}}". Sections: Day in review, Decisions, New action items, Open threads, Patterns, Reflective prompt (large, centered, italic). Blank space at bottom for handwritten response.

`src/pdf/weekly-reflection.tsx` — portrait or landscape (your call, test both). Similar sections. HubSpot deltas render as a compact table.

Same QR footer convention: `{ meetingId: "reflection-daily"|"reflection-weekly", seriesId: "reflection", date, version: 1 }`.

### 5.8 Wire into morning delivery

In `morning-brief/route.ts`, after rendering today's briefs:

```
// Look up the most recent undelivered reflection.
// If one exists AND its delivered_at IS NULL, include its PDF in the email attachments,
// then set delivered_at = now() after the send succeeds.
```

### 5.9 Cron schedule update

`vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/morning-brief", "schedule": "45 10 * * *" },
    { "path": "/api/cron/daily-reflection", "schedule": "30 3 * * *" },
    { "path": "/api/cron/weekly-reflection", "schedule": "0 4 * * 1" },
    { "path": "/api/cron/hubspot-snapshot", "schedule": "0 5 * * 0" }
  ]
}
```

Add `(DST)` / `(standard)` notes in a comment or README — remember to shift by one hour each daylight-saving transition.

### 5.10 Phase 4 done criteria

- [ ] Daily reflection generated after evening sync, delivered next morning with briefs.
- [ ] Weekly reflection generated Sunday night, delivered Monday morning.
- [ ] No reflection output contains interpretive language. Audit 7 days of output manually before declaring done.
- [ ] Action items tagged as "drifting" correctly reflect age > 14 days.
- [ ] HubSpot deltas show real WoW changes in pipeline and activity.

---

## 6. Phase 5 — Search UI (Optional)

Goal: a minimal web UI at notestella.com to search across notes with Claude synthesis.

### 6.1 Upgrade `/api/search`

Currently keyword-fallback. Replace with:

```
// POST { query: string }
// Steps:
//   1. voyage.embed(query) → vector.
//   2. match_notes(vector, threshold=0.7, count=12).
//   3. Pass results to Claude with a synthesis prompt.
//   4. Return { answer: string, citations: [{ note_id, meeting_id, date, snippet }] }.
```

Synthesis prompt: answer the question using only provided notes; cite note ids inline like `[n1]`; if the notes don't support an answer, say so plainly.

### 6.2 UI

`src/app/page.tsx`: a single text input, submit → results panel below. Render citations as collapsible cards linking to meeting dates. No auth (personal tool; gate by IP allowlist or basic auth at the Vercel edge if paranoid).

### 6.3 Phase 5 done criteria

- [ ] Query "what did we decide about SoCalGas" returns a cited answer from real notes.
- [ ] Citations link to source meetings.
- [ ] Latency under 3 seconds end-to-end on typical query.

---

## 7. Operational Runbook

Things to do on a schedule, and things that will break.

### 7.1 Daylight saving transitions

Twice a year, shift every cron by ±1 hour.

- **DST ends (first Sunday November)**: change `45 10` → `45 11`, `30 3` → `30 4`, `0 4 * * 1` → `0 5 * * 1`, `0 5 * * 0` → `0 6 * * 0`.
- **DST begins (second Sunday March)**: reverse.

Put a recurring calendar event on your personal calendar one week before each transition.

### 7.2 Google OAuth refresh

Refresh tokens can expire at 6 months non-use or if Google forces revocation. Symptom: 401s in the morning cron.

Fix: redo the OAuth Playground dance (§2.3), update `GOOGLE_REFRESH_TOKEN` in Vercel env, redeploy.

### 7.3 reMarkable allowlist

Symptom: no PDFs arrive but route logs success.

Fix: open reMarkable app → Settings → Email Import → verify your from-address is there exactly.

### 7.4 HubSpot rate limits

Symptom: 429s during morning cron. Usually triggered by over-broad searches.

Fix: ensure lens code batches by attendee list, not per-attendee loops. If a meeting has 10+ attendees, consider capping to the 5 most relevant.

### 7.5 Claude JSON parse failure

Symptom: a specific meeting's brief is missing, logs show `SyntaxError: ... is not valid JSON`.

Fix: the logged response body usually reveals the issue (extra preamble, markdown fences, trailing comma). Adjust the prompt (reiterate "JSON only, no preamble"). If it's a specific meeting content triggering it (weird characters in description), sanitize input.

### 7.6 rmapi failure

Symptom: evening-sync GitHub Action fails with `failed to authenticate` or `401 from cloud`.

Fix: re-auth rmapi locally, copy new `~/.config/rmapi/rmapi.conf` content into the `RMAPI_CONFIG` GitHub secret.

### 7.7 Cost monitoring

Expected monthly cost at personal volume (~10 briefs/day, ~20 notes extracted/day):

- Anthropic: $15–40/month depending on note volume and brief length.
- Voyage: <$5/month.
- Vercel: free tier is plenty.
- Supabase: free tier fits comfortably.
- Resend: free tier (3k emails/month) is plenty.
- HubSpot Private App: free with HubSpot account.

Set up Anthropic usage alerts at $50 and $100.

### 7.8 Backups

Supabase auto-backups are on by default. Additionally:

- Weekly: `supabase db dump > backup-$(date +%Y%m%d).sql` into a private GitHub repo's releases, via a tiny GitHub Action.
- The PDFs themselves are on the reMarkable. Don't bother separately backing them up — they're reproducible from meetings + briefs tables.

### 7.9 Manual overrides

You'll want a couple of manual trigger endpoints (same CRON_SECRET auth):

- `POST /api/admin/regenerate-brief?meetingId=...` — regenerate a specific brief and email it.
- `POST /api/admin/run?job=morning|evening|reflection|weekly` — kick off a job outside the schedule.

Keep these behind the CRON_SECRET. Never expose a public UI.

---

## 8. Appendix

### 8.1 Testing strategy

- Lib functions: unit-test `slugify`, `encodeFilename`, `decodeFilename`, `deriveSeriesId` with edge cases (titles with emoji, long titles, empty attendees, forwarded subjects).
- Prompts: maintain a `tests/fixtures/` folder with canned meeting inputs + expected JSON schema conformance. Run a script that calls Claude and validates the shape with zod, weekly.
- PDF rendering: render to buffer in a test, assert file is >N KB and has a PDF header. Don't visually snapshot — too flaky across `@react-pdf/renderer` versions.
- Full loop: a `scripts/dry-run.ts` that runs the morning cron against today but emails to a test address instead of the reMarkable.

### 8.2 Prompt registry

All prompts live in `src/lib/anthropic.ts` as named constants (`MEETING_BRIEF_SYSTEM`, `DAILY_OVERVIEW_SYSTEM`, `DAILY_REFLECTION_SYSTEM`, `WEEKLY_REFLECTION_SYSTEM`, `NOTE_EXTRACTION_SYSTEM`). Changes go through the same code review as any other code change. Bump a `PROMPT_VERSION` constant any time you change any of them; log it alongside Claude call outcomes so you can correlate output quality with prompt revisions.

### 8.3 Timezone handling

- Vercel cron is UTC. Document the current DST status in `vercel.json` via a comment.
- All date math in routes uses `date-fns-tz` with `America/Denver`.
- `note_date` and `period_start/end` in Postgres are `date` type (not timestamp) — treat them as local calendar dates.

### 8.4 Schema quick reference

Tables: `meetings`, `briefs`, `people`, `notes`, `reflections`, `hubspot_snapshots`.
Functions: `match_notes`, `set_updated_at`.
Extensions: `uuid-ossp`, `vector`.

### 8.5 Known simplifications to reconsider later

- Single-user, no auth: fine for now. Add basic auth at the edge if you ever host anywhere shared.
- `rmapi` in GitHub Actions: works but is a second CI surface. Fold back to Vercel if a Node-native client appears.
- IVFFlat vector index: fine at personal volume. If corpus > 50k notes, consider HNSW.
- No observability beyond Vercel logs: add Axiom or similar if you grow to caring about MTTD.
- Per-seller weekly anomaly thresholds are hardcoded (1.5 stdev). After 30 days of data, convert to a rolling percentile.

---

## 9. Final sanity checklist before declaring Notestella operational

- [ ] Tomorrow morning at 5:30am, PDFs are on the tablet without any intervention.
- [ ] Tonight at 9pm, the evening sync runs and produces `notes` rows.
- [ ] Monday morning delivers a weekly reflection.
- [ ] Yesterday's daily reflection arrived with this morning's briefs.
- [ ] Every PDF filename decodes. Every QR scans.
- [ ] No brief, overview, or reflection contains psychological interpretation.
- [ ] A week of usage results in no more than one manual intervention.

If all seven hold for two consecutive weeks, you're done. Go build something else.
