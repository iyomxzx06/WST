begin;

create or replace function public.apply_hb_inventory_stock_rules(p_branch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item record;
  product_row record;
  v_ingredient_id uuid;
  buns_id uuid;
  patties_id uuid;
  cheese_id uuid;
  lettuce_id uuid;
  tomato_id uuid;
  onion_id uuid;
  sauce_id uuid;
  bacon_id uuid;
  burger_number integer;
  is_b1t1 boolean;
  bun_quantity numeric(14,3);
  patty_quantity numeric(14,3);
begin
  if p_branch_id is null then
    raise exception 'A branch is required to configure inventory stock rules';
  end if;

  for item in
    select * from (values
      ('Buns','pcs',array['buns','bun','burger buns','burger bun']::text[]),
      ('Patties','pcs',array['patties','patty','beef patties','beef patty']::text[]),
      ('Cheese','pcs',array['cheese','slice cheese','cheese slice']::text[]),
      ('Lettuce','pcs',array['lettuce']::text[]),
      ('Tomato','pcs',array['tomato','tomatoes']::text[]),
      ('Onion','pcs',array['onion','onions']::text[]),
      ('Sauce','serving',array['sauce']::text[]),
      ('Bacon','slice',array['bacon']::text[])
    ) as stock(name,unit,aliases)
  loop
    v_ingredient_id:=null;
    select id into v_ingredient_id
      from public.ingredients
      where branch_id=p_branch_id and lower(trim(name))=any(item.aliases)
      order by case when lower(trim(name))=lower(item.name) then 0 else 1 end,created_at,id
      limit 1;
    if v_ingredient_id is null then
      insert into public.ingredients(branch_id,name,unit,stock_quantity,reorder_level)
        values(p_branch_id,item.name,item.unit,0,0)
        on conflict (branch_id,name) do nothing
        returning id into v_ingredient_id;
      if v_ingredient_id is null then
        select id into v_ingredient_id from public.ingredients
          where branch_id=p_branch_id and lower(trim(name))=lower(item.name)
          order by created_at,id limit 1;
      end if;
    end if;

    case item.name
      when 'Buns' then buns_id:=v_ingredient_id;
      when 'Patties' then patties_id:=v_ingredient_id;
      when 'Cheese' then cheese_id:=v_ingredient_id;
      when 'Lettuce' then lettuce_id:=v_ingredient_id;
      when 'Tomato' then tomato_id:=v_ingredient_id;
      when 'Onion' then onion_id:=v_ingredient_id;
      when 'Sauce' then sauce_id:=v_ingredient_id;
      when 'Bacon' then bacon_id:=v_ingredient_id;
    end case;
  end loop;

  if exists (
    select 1 from public.ingredients
    where id in (buns_id,patties_id,cheese_id,lettuce_id,tomato_id,onion_id,sauce_id,bacon_id)
      and not active
  ) then
    raise exception 'An inventory ingredient required by the default menu is inactive; activate it before applying stock rules';
  end if;

  for product_row in
    select id,name from public.products
    where branch_id=p_branch_id and active
  loop
    burger_number:=case
      when lower(product_row.name) like 'b1 - %' or lower(product_row.name) like 'classic burger - %' then 1
      when lower(product_row.name) like 'b2 - %' or lower(product_row.name) like 'cheese burger - %' then 2
      when lower(product_row.name) like 'b3 - %' or lower(product_row.name) like 'deluxe burger - %' then 3
      when lower(product_row.name) like 'b4 - %' or lower(product_row.name) like 'double cheese burger - %' then 4
      else null
    end;
    is_b1t1:=lower(product_row.name) like '% - b1t1';

    if burger_number is not null and
       (lower(product_row.name) like '% - single' or is_b1t1) then
      bun_quantity:=case when is_b1t1 then 2 else 1 end;
      patty_quantity:=case burger_number
        when 1 then case when is_b1t1 then 2 else 1 end
        when 2 then case when is_b1t1 then 2 else 1 end
        when 3 then case when is_b1t1 then 2 else 1 end
        when 4 then case when is_b1t1 then 4 else 2 end
      end;

      update public.products set track_inventory=true where id=product_row.id and branch_id=p_branch_id;
      insert into public.recipes(branch_id,product_id,ingredient_id,quantity) values
        (p_branch_id,product_row.id,buns_id,bun_quantity),
        (p_branch_id,product_row.id,patties_id,patty_quantity)
      on conflict (product_id,ingredient_id) do update set quantity=excluded.quantity;

      if burger_number=2 then
        insert into public.recipes(branch_id,product_id,ingredient_id,quantity)
          values(p_branch_id,product_row.id,cheese_id,case when is_b1t1 then 2 else 1 end)
        on conflict (product_id,ingredient_id) do update set quantity=excluded.quantity;
      elsif burger_number=3 then
        insert into public.recipes(branch_id,product_id,ingredient_id,quantity) values
          (p_branch_id,product_row.id,lettuce_id,case when is_b1t1 then 2 else 1 end),
          (p_branch_id,product_row.id,tomato_id,case when is_b1t1 then 2 else 1 end)
        on conflict (product_id,ingredient_id) do update set quantity=excluded.quantity;
      end if;
    end if;
  end loop;

  for product_row in
    select p.id,p.name,extras.ingredient_id
    from public.products p
    join (values
      ('Onion',onion_id),('Lettuce',lettuce_id),('Tomato',tomato_id),
      ('Sauce',sauce_id),('Slice Cheese',cheese_id),('Bacon',bacon_id),
      ('Beef Patty',patties_id)
    ) as extras(name,ingredient_id) on lower(p.name)=lower(extras.name)
    where p.branch_id=p_branch_id and p.active
  loop
    update public.products set track_inventory=true where id=product_row.id and branch_id=p_branch_id;
    insert into public.recipes(branch_id,product_id,ingredient_id,quantity)
      values(p_branch_id,product_row.id,product_row.ingredient_id,1)
    on conflict (product_id,ingredient_id) do update set quantity=excluded.quantity;
  end loop;
end;
$$;

revoke all on function public.apply_hb_inventory_stock_rules(uuid) from public,anon,authenticated;

create or replace function public.import_hb_v11_catalog()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_branch_id uuid := public.current_branch_id();
  import_result jsonb;
  marker public.catalog_file_imports%rowtype;
  renamed_count integer;
begin
  if v_branch_id is null or public.current_staff_role() not in ('owner_admin','manager','inventory') then
    raise exception 'You do not have permission to import the product catalog';
  end if;

  select * into marker from public.catalog_file_imports where branch_id=v_branch_id;
  if found then
    renamed_count:=public.apply_hb_v11_product_labels(v_branch_id);
    perform public.apply_hb_inventory_stock_rules(v_branch_id);
    return jsonb_build_object(
      'products_imported',marker.products_imported,
      'products_skipped',marker.products_skipped,
      'products_renamed',renamed_count,
      'already_imported',true,
      'source',marker.source
    );
  end if;

  import_result:=public.import_hb_v11_catalog_unlabeled();
  renamed_count:=public.apply_hb_v11_product_labels(v_branch_id);
  perform public.apply_hb_inventory_stock_rules(v_branch_id);
  return import_result || jsonb_build_object('products_renamed',renamed_count);
end;
$$;

revoke all on function public.import_hb_v11_catalog() from public,anon;
grant execute on function public.import_hb_v11_catalog() to authenticated;

do $$
declare
  branch record;
begin
  for branch in select id from public.branches loop
    perform public.apply_hb_inventory_stock_rules(branch.id);
  end loop;
end;
$$;

notify pgrst,'reload schema';
commit;
