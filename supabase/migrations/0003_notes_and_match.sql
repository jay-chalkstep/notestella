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
-- NOTE: IVFFlat trains centroids from existing rows. Creating it on an empty
-- table produces a degenerate index that still answers queries but without
-- acceleration. After ~100 notes exist, rebuild in place:
--   REINDEX INDEX notes_embedding_idx;
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
