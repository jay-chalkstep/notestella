create type reflection_type as enum ('daily', 'weekly');

create table reflections (
  id uuid primary key default uuid_generate_v4(),
  type reflection_type not null,
  period_start date not null,
  period_end date not null,
  content jsonb not null,
  -- pdf_filename is the intended delivery filename, NOT a pointer to stored bytes.
  -- Reflection PDFs are re-rendered on demand from content jsonb at morning-brief
  -- delivery time — content is the source of truth, PDF is disposable.
  pdf_filename text,
  delivered_at timestamptz,
  source_notes jsonb not null default '[]'::jsonb,       -- array of note ids
  source_meetings jsonb not null default '[]'::jsonb,    -- array of meeting ids
  created_at timestamptz not null default now()
);

-- Plain composite unique (not the book's two partial indexes): Supabase's upsert
-- sends on_conflict=type,period_start with no WHERE clause, which can't match a
-- partial index's predicate, causing the second upsert for any (type, period_start)
-- to fail. Plain composite keeps the same uniqueness semantics (type is in the
-- key, so daily/weekly on the same date don't collide) and is upsert-compatible.
create unique index reflections_unique_period on reflections(type, period_start);

-- §5.6 HubSpot weekly snapshots for WoW delta computation.
create table hubspot_snapshots (
  snapshot_date date primary key,
  pipeline_by_stage jsonb not null,
  rep_activity jsonb not null,
  top_open_deals jsonb not null,
  raw jsonb not null,
  created_at timestamptz not null default now()
);
