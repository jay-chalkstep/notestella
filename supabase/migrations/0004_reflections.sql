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

-- §5.6 HubSpot weekly snapshots for WoW delta computation.
create table hubspot_snapshots (
  snapshot_date date primary key,
  pipeline_by_stage jsonb not null,
  rep_activity jsonb not null,
  top_open_deals jsonb not null,
  raw jsonb not null,
  created_at timestamptz not null default now()
);
