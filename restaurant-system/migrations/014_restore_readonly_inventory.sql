-- Restore the read-only inventory RPC for Cashier and Kitchen accounts.
-- Safe to run after migration 013; it does not change inventory balances.

begin;

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
    select i.id, i.name, i.unit, i.stock_quantity
    from public.ingredients i
    where i.branch_id = v_branch_id and i.active
    order by i.name;
end;
$$;

revoke all on function public.list_readonly_inventory() from public, anon;
grant execute on function public.list_readonly_inventory() to authenticated;

notify pgrst, 'reload schema';
commit;
