-- Run this in Supabase SQL Editor

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client text,
  color text not null default '#1E6B68',
  start_date date not null,
  end_date date not null,
  created_at timestamptz default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  name text not null,
  category text not null, -- 'crea' | 'prod' | 'sourcing'
  subcategory text,        -- 'mood' | '3d' | 'validations' | 'atelier' | 'logistique' | 'montage' | 'demontage'
  start_date date not null,
  end_date date not null,
  progress integer default 0,
  created_at timestamptz default now()
);

-- Allow public read/write (no auth for now — team internal tool)
alter table projects enable row level security;
alter table tasks enable row level security;

create policy "Public access projects" on projects for all using (true) with check (true);
create policy "Public access tasks" on tasks for all using (true) with check (true);
