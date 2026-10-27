begin;

alter table public.staff_profiles
  drop constraint if exists staff_profiles_role_check;

update public.staff_profiles
set role='manager'
where role='inventory';

alter table public.staff_profiles
  add constraint staff_profiles_role_check
  check (role in ('owner_admin','manager','cashier','kitchen'));

drop policy if exists "staff read branch profiles" on public.staff_profiles;
create policy "staff read branch profiles" on public.staff_profiles for select to authenticated
  using (
    user_id=(select auth.uid())
    or (branch_id=public.current_branch_id() and public.current_staff_role()='owner_admin')
  );

drop policy if exists "staff read ingredients" on public.ingredients;
create policy "managers read ingredients" on public.ingredients for select to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'));

drop policy if exists "inventory manage ingredients" on public.ingredients;
create policy "managers manage ingredients" on public.ingredients for all to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'))
  with check (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'));

drop policy if exists "staff read recipes" on public.recipes;
create policy "managers read recipes" on public.recipes for select to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'));

drop policy if exists "inventory manage recipes" on public.recipes;
create policy "managers manage recipes" on public.recipes for all to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'))
  with check (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'));

drop policy if exists "staff read suppliers" on public.suppliers;
create policy "managers read suppliers" on public.suppliers for select to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'));

drop policy if exists "inventory manage suppliers" on public.suppliers;
create policy "managers manage suppliers" on public.suppliers for all to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'))
  with check (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'));

drop policy if exists "staff read purchases" on public.purchase_orders;
create policy "managers read purchases" on public.purchase_orders for select to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'));

drop policy if exists "inventory create purchases" on public.purchase_orders;
create policy "managers create purchases" on public.purchase_orders for insert to authenticated
  with check (
    branch_id=public.current_branch_id()
    and public.current_staff_role() in ('owner_admin','manager')
    and created_by=(select auth.uid())
  );

drop policy if exists "staff read purchase items" on public.purchase_order_items;
create policy "managers read purchase items" on public.purchase_order_items for select to authenticated
  using (
    purchase_order_id in (
      select id from public.purchase_orders
      where branch_id=public.current_branch_id()
        and public.current_staff_role() in ('owner_admin','manager')
    )
  );

create or replace function public.list_readonly_inventory()
returns table (
  id uuid,
  name text,
  unit text,
  stock_quantity numeric
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_role text := public.current_staff_role();
  v_branch_id uuid := public.current_branch_id();
begin
  if v_branch_id is null or v_role not in ('cashier','kitchen') then
    raise exception 'You do not have permission to view inventory';
  end if;

  return query
    select i.id,i.name,i.unit,i.stock_quantity
    from public.ingredients i
    where i.branch_id=v_branch_id and i.active
    order by i.name;
end;
$$;

revoke all on function public.list_readonly_inventory() from public,anon;
grant execute on function public.list_readonly_inventory() to authenticated;

notify pgrst,'reload schema';
commit;
