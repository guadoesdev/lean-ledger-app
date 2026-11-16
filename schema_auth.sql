-- Run once in Supabase SQL Editor. Links the app's own users table to Supabase Auth. Safe to run more than once.
alter table users add column if not exists auth_id uuid unique;   -- the Supabase Auth user id
alter table users alter column pass drop not null;                -- passwords now live in Supabase Auth, not here
