begin;

create or replace function public.set_ingredient_stock_count(p_ingredient_id uuid,p_stock_count numeric)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_branch_id uuid:=public.current_branch_id();
  v_current_stock numeric(14,3);
  v_change numeric(14,3);
  v_movement_type text;
begin
  if v_branch_id is null or public.current_staff_role() not in ('owner_admin','manager','inventory') then
    raise exception 'You do not have permission to set inventory counts';
  end if;
  if p_stock_count is null or p_stock_count<0 then
    raise exception 'Stock count must be zero or greater';
  end if;

  select stock_quantity into v_current_stock
  from public.ingredients
  where id=p_ingredient_id and branch_id=v_branch_id and active
  for update;
  if not found then raise exception 'Ingredient not found or inactive'; end if;

  v_change:=p_stock_count-v_current_stock;
  if v_change=0 then return; end if;
  v_movement_type:=case when v_current_stock=0 and p_stock_count>0 then 'opening' else 'adjustment' end;

  update public.ingredients
    set stock_quantity=p_stock_count
    where id=p_ingredient_id and branch_id=v_branch_id;
  insert into public.inventory_movements(
    branch_id,ingredient_id,quantity_change,movement_type,note,created_by
  ) values (
    v_branch_id,p_ingredient_id,v_change,v_movement_type,'Opening/current stock count',auth.uid()
  );
end;
$$;

revoke all on function public.set_ingredient_stock_count(uuid,numeric) from public,anon;
grant execute on function public.set_ingredient_stock_count(uuid,numeric) to authenticated;

notify pgrst,'reload schema';
commit;
