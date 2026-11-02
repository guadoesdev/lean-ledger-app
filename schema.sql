-- Run once in Supabase: SQL Editor > New query > paste > Run.

create table if not exists users (
  id bigint generated always as identity primary key,
  email text not null unique,
  pass text not null,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  user_id bigint primary key references users(id) on delete cascade,
  sex text not null check (sex in ('m', 'f')),
  age double precision not null,
  height double precision not null,
  start_weight double precision not null,
  goal_weight double precision not null,
  activity double precision not null,
  deficit double precision not null,
  protein_per_kg double precision not null,
  sodium double precision not null
);

-- user_id is null for the built-in foods shared by everyone.
create table if not exists foods (
  id bigint generated always as identity primary key,
  user_id bigint references users(id) on delete cascade,
  name text not null,
  serving text not null,
  kcal double precision not null default 0,
  protein double precision not null default 0,
  carbs double precision not null default 0,
  fat double precision not null default 0,
  sodium double precision not null default 0,
  fiber double precision not null default 0
);
create index if not exists foods_user_idx on foods(user_id);

create table if not exists log_entries (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  day date not null,
  meal text not null check (meal in ('Breakfast', 'Lunch', 'Dinner', 'Snacks')),
  name text not null,
  serving text not null,
  qty double precision not null,
  kcal double precision not null default 0,
  protein double precision not null default 0,
  carbs double precision not null default 0,
  fat double precision not null default 0,
  sodium double precision not null default 0,
  fiber double precision not null default 0
);
create index if not exists log_user_day_idx on log_entries(user_id, day);

create table if not exists weights (
  user_id bigint not null references users(id) on delete cascade,
  day date not null,
  kg double precision not null,
  primary key (user_id, day)
);

-- Lock the tables against the public anon key. The server uses the service role key,
-- which bypasses row level security, so no policies are needed.
alter table users enable row level security;
alter table profiles enable row level security;
alter table foods enable row level security;
alter table log_entries enable row level security;
alter table weights enable row level security;
