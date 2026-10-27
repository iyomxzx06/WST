begin;

create or replace function public.set_ingredient_stock_counts(p_counts jsonb)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_branch_id uuid:=public.current_branch_id();
  v_item jsonb;
  v_ingredient_id uuid;
  v_stock_count numeric(14,3);
  v_current_stock numeric(14,3);
  v_change numeric(14,3);
  v_saved_count integer:=0;
begin
  if v_branch_id is null or public.current_staff_role() not in ('owner_admin','manager','inventory') then
    raise exception 'You do not have permission to set inventory counts';
  end if;
  if coalesce(jsonb_typeof(p_counts),'')<>'array' then
    raise exception 'Inventory counts must be submitted as a list';
  end if;
  if jsonb_array_length(p_counts)<1 or jsonb_array_length(p_counts)>100 then
    raise exception 'Submit between 1 and 100 inventory counts';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_counts) as entry(value)
    where coalesce(entry.value->>'ingredient_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(entry.value->>'stock_count','') !~ '^[0-9]+(\.[0-9]{1,3})?$'
  ) then
    raise exception 'Each count must include a valid ingredient ID and a non-negative quantity with at most 3 decimal places';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_counts) as entry(value)
    group by (entry.value->>'ingredient_id')::uuid
    having count(*)>1
  ) then
    raise exception 'Each ingredient can only appear once per stock-count submission';
  end if;

  for v_item in
    select entry.value
    from jsonb_array_elements(p_counts) as entry(value)
    order by (entry.value->>'ingredient_id')::uuid
  loop
    v_ingredient_id:=(v_item->>'ingredient_id')::uuid;
    v_stock_count:=(v_item->>'stock_count')::numeric;

    select stock_quantity into v_current_stock
    from public.ingredients
    where id=v_ingredient_id and branch_id=v_branch_id and active
    for update;
    if not found then raise exception 'Ingredient % not found or inactive',v_ingredient_id; end if;

    v_change:=v_stock_count-v_current_stock;
    if v_change=0 then continue; end if;

    update public.ingredients
      set stock_quantity=v_stock_count
      where id=v_ingredient_id and branch_id=v_branch_id;
    insert into public.inventory_movements(
      branch_id,ingredient_id,quantity_change,movement_type,note,created_by
    ) values (
      v_branch_id,
      v_ingredient_id,
      v_change,
      case when v_current_stock=0 and v_stock_count>0 then 'opening' else 'adjustment' end,
      'Opening/current stock count',
      auth.uid()
    );
    v_saved_count:=v_saved_count+1;
  end loop;

  return v_saved_count;
end;
$$;

revoke all on function public.set_ingredient_stock_counts(jsonb) from public,anon;
grant execute on function public.set_ingredient_stock_counts(jsonb) to authenticated;

notify pgrst,'reload schema';
commit;
