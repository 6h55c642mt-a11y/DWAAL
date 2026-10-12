-- Dwaal: database voor accounts (Supabase). Plak dit in Supabase → SQL Editor → Run.
-- Iedereen kan reviews lezen; routes en bezochte plekken zijn alleen van de eigenaar.

create table if not exists public.routes (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  city text not null,
  title text not null,
  color text,
  stops jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.visits (
  user_id uuid not null references auth.users(id) on delete cascade,
  city text not null,
  place_key text not null,
  visited_at timestamptz not null default now(),
  primary key (user_id, city, place_key)
);
create table if not exists public.reviews (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  city text not null,
  place_key text not null,
  stars smallint not null check (stars between 1 and 5),
  text text not null default '' check (char_length(text) <= 600),
  author_name text,
  created_at timestamptz not null default now()
);
create index if not exists reviews_place on public.reviews (city, place_key, created_at desc);

alter table public.routes enable row level security;
alter table public.visits enable row level security;
alter table public.reviews enable row level security;

create policy "eigen routes" on public.routes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "eigen bezoeken" on public.visits for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "reviews lezen" on public.reviews for select using (true);
create policy "eigen review plaatsen" on public.reviews for insert with check (auth.uid() = user_id);
create policy "eigen review verwijderen" on public.reviews for delete using (auth.uid() = user_id);
