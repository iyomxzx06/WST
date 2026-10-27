begin;

create table if not exists public.catalog_file_imports (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  source text not null check (source = 'hb_v11_file'),
  imported_by uuid not null references auth.users(id),
  products_imported integer not null check (products_imported >= 0),
  products_skipped integer not null check (products_skipped >= 0),
  imported_at timestamptz not null default now()
);

alter table public.catalog_file_imports enable row level security;
drop policy if exists "staff read branch catalog import" on public.catalog_file_imports;
create policy "staff read branch catalog import" on public.catalog_file_imports for select to authenticated
  using (branch_id=public.current_branch_id());
revoke all on public.catalog_file_imports from public, anon, authenticated;
grant select on public.catalog_file_imports to authenticated;

create or replace function public.import_hb_v11_catalog()
returns jsonb language plpgsql security definer set search_path = public, auth
as $$
declare
  v_branch_id uuid := public.current_branch_id();
  buns_id uuid;
  patties_id uuid;
  buns_active boolean;
  patties_active boolean;
  item record;
  product_id uuid;
  imported_count integer := 0;
  skipped_count integer := 0;
  ingredients_added integer := 0;
begin
  if v_branch_id is null or public.current_staff_role() not in ('owner_admin','manager','inventory') then
    raise exception 'You do not have permission to import the product catalog';
  end if;

  perform pg_advisory_xact_lock(hashtext('havens_hb_v11_catalog_'||v_branch_id::text));
  if exists(select 1 from public.catalog_file_imports where branch_id=v_branch_id) then
    raise exception 'The hb.html catalog has already been imported for this branch';
  end if;

  select id,active into buns_id,buns_active
    from public.ingredients where branch_id=v_branch_id and lower(name)='buns' limit 1;
  if buns_id is not null and not buns_active then
    raise exception 'The existing Buns ingredient is inactive; activate it before importing';
  elsif buns_id is null then
    insert into public.ingredients(branch_id,name,unit,stock_quantity,reorder_level)
      values(v_branch_id,'Buns','pcs',0,0) returning id into buns_id;
    ingredients_added:=ingredients_added+1;
  end if;

  select id,active into patties_id,patties_active
    from public.ingredients where branch_id=v_branch_id and lower(name)='patties' limit 1;
  if patties_id is not null and not patties_active then
    raise exception 'The existing Patties ingredient is inactive; activate it before importing';
  elsif patties_id is null then
    insert into public.ingredients(branch_id,name,unit,stock_quantity,reorder_level)
      values(v_branch_id,'Patties','pcs',0,0) returning id into patties_id;
    ingredients_added:=ingredients_added+1;
  end if;

  for item in
    select * from (values
      ('Classic Burger - Single',40.00,true,1.000,1.000),
      ('Classic Burger - B1T1',75.00,true,2.000,2.000),
      ('Cheese Burger - Single',55.00,true,1.000,1.000),
      ('Cheese Burger - B1T1',105.00,true,2.000,2.000),
      ('Deluxe Burger - Single',60.00,true,1.000,1.000),
      ('Deluxe Burger - B1T1',115.00,true,2.000,2.000),
      ('Double Cheese Burger - Single',100.00,true,1.000,2.000),
      ('Double Cheese Burger - B1T1',195.00,true,2.000,4.000),
      ('Onion',5.00,false,0.000,0.000),
      ('Lettuce',10.00,false,0.000,0.000),
      ('Tomato',10.00,false,0.000,0.000),
      ('Sauce',10.00,false,0.000,0.000),
      ('Slice Cheese',15.00,false,0.000,0.000),
      ('Bacon',25.00,false,0.000,0.000),
      ('Beef Patty',30.00,true,0.000,1.000)
    ) as catalog(name,price,track_inventory,buns_quantity,patties_quantity)
  loop
    if exists(select 1 from public.products where branch_id=v_branch_id and lower(name)=lower(item.name)) then
      skipped_count:=skipped_count+1;
      continue;
    end if;

    insert into public.products(branch_id,name,price,track_inventory)
      values(v_branch_id,item.name,item.price,item.track_inventory)
      returning id into product_id;

    if item.buns_quantity>0 then
      insert into public.recipes(branch_id,product_id,ingredient_id,quantity)
        values(v_branch_id,product_id,buns_id,item.buns_quantity);
    end if;
    if item.patties_quantity>0 then
      insert into public.recipes(branch_id,product_id,ingredient_id,quantity)
        values(v_branch_id,product_id,patties_id,item.patties_quantity);
    end if;
    imported_count:=imported_count+1;
  end loop;

  insert into public.catalog_file_imports(
    branch_id,source,imported_by,products_imported,products_skipped
  ) values (
    v_branch_id,'hb_v11_file',auth.uid(),imported_count,skipped_count
  );

  return jsonb_build_object(
    'products_imported',imported_count,
    'products_skipped',skipped_count,
    'ingredients_added',ingredients_added,
    'starting_stock',0,
    'source','hb_v11_file'
  );
end;
$$;

revoke all on function public.import_hb_v11_catalog() from public, anon;
grant execute on function public.import_hb_v11_catalog() to authenticated;

notify pgrst, 'reload schema';
commit;
