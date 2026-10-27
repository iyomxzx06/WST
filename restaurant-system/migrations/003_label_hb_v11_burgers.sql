begin;

do $$
begin
  if to_regprocedure('public.import_hb_v11_catalog_unlabeled()') is null then
    if to_regprocedure('public.import_hb_v11_catalog()') is null then
      raise exception 'Run migration 002 before migration 003';
    end if;
    alter function public.import_hb_v11_catalog() rename to import_hb_v11_catalog_unlabeled;
  end if;
end;
$$;

create or replace function public.apply_hb_v11_product_labels(p_branch_id uuid)
returns integer language plpgsql security definer set search_path = public
as $$
declare
  item record;
  product_id uuid;
  target_id uuid;
  renamed_count integer := 0;
begin
  for item in
    select * from (values
      ('Classic Burger - Single','B1 - Classic Burger - Single'),
      ('Classic Burger - B1T1','B1 - Classic Burger - B1T1'),
      ('Cheese Burger - Single','B2 - Cheese Burger - Single'),
      ('Cheese Burger - B1T1','B2 - Cheese Burger - B1T1'),
      ('Deluxe Burger - Single','B3 - Deluxe Burger - Single'),
      ('Deluxe Burger - B1T1','B3 - Deluxe Burger - B1T1'),
      ('Double Cheese Burger - Single','B4 - Double Cheese Burger - Single'),
      ('Double Cheese Burger - B1T1','B4 - Double Cheese Burger - B1T1')
    ) as labels(old_name,new_name)
  loop
    select id into product_id from public.products
      where branch_id=p_branch_id and lower(name)=lower(item.old_name)
      order by created_at,id limit 1;
    if product_id is null then continue; end if;

    select id into target_id from public.products
      where branch_id=p_branch_id and lower(name)=lower(item.new_name)
      limit 1;
    if target_id is not null and target_id<>product_id then
      raise exception 'Cannot rename % because % already exists in this branch',
        item.old_name,item.new_name;
    end if;

    update public.products set name=item.new_name
      where id=product_id and branch_id=p_branch_id and name<>item.new_name;
    if found then renamed_count:=renamed_count+1; end if;
  end loop;
  return renamed_count;
end;
$$;

revoke all on function public.apply_hb_v11_product_labels(uuid) from public, anon, authenticated;

create or replace function public.import_hb_v11_catalog()
returns jsonb language plpgsql security definer set search_path = public, auth
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
  return import_result || jsonb_build_object('products_renamed',renamed_count);
end;
$$;

revoke all on function public.import_hb_v11_catalog() from public, anon;
grant execute on function public.import_hb_v11_catalog() to authenticated;

do $$
declare
  branch record;
begin
  for branch in select id from public.branches loop
    perform public.apply_hb_v11_product_labels(branch.id);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
commit;
