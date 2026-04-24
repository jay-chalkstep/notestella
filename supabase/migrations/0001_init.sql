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
