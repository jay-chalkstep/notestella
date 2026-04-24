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
