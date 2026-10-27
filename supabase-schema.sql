create table if not exists public.pos_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  state jsonb not null
);

alter table public.pos_state enable row level security;

grant select, insert, update on public.pos_state to authenticated;

drop policy if exists "Users can read their own POS state" on public.pos_state;
create policy "Users can read their own POS state"
  on public.pos_state for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own POS state" on public.pos_state;
create policy "Users can create their own POS state"
  on public.pos_state for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own POS state" on public.pos_state;
create policy "Users can update their own POS state"
  on public.pos_state for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
