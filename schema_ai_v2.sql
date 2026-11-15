-- Run once in Supabase SQL Editor, after schema.sql and schema_ai.sql. Safe to run more than once.

alter table meals add column if not exists eaten_at timestamptz not null default now();
alter table meals add column if not exists classified_meal text;   -- the meal type Gemini detected
create index if not exists meals_user_eaten_idx on meals(user_id, eaten_at desc);

alter table meal_items add column if not exists eaten_at timestamptz;
alter table meal_items add column if not exists confidence double precision;  -- lower of food and portion confidence
alter table meal_items add column if not exists source_type text;             -- government, manufacturer_label, database, web_reference, ai_estimate
alter table meal_items add column if not exists source_url text;
alter table meal_items add column if not exists verification text not null default 'verified';
do $$ begin
  alter table meal_items add constraint meal_items_verification_chk check (verification in ('verified', 'ai_estimated'));
exception when duplicate_object then null; end $$;
