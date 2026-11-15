-- Run once in Supabase SQL Editor. Stores each day's chat so it stays visible after reloads and on other devices.
create table if not exists chat_messages (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  day date not null,
  role text not null check (role in ('user', 'bot')),
  text text not null,
  meal_id bigint,        -- set on replies that logged a meal (no foreign key, so history survives an Undo)
  pending jsonb,         -- set when the assistant asked a follow-up question and is waiting for an answer
  created_at timestamptz not null default now()
);
create index if not exists chat_user_day_idx on chat_messages(user_id, day, id);
alter table chat_messages enable row level security;
