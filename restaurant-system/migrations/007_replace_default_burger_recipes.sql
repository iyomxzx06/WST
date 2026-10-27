begin;

do $$
begin
  if to_regprocedure('public.apply_hb_inventory_stock_rules(uuid)') is null then
    raise exception 'Run migration 004 before migration 007';
  end if;
end;
$$;

delete from public.recipes r
using public.products p
where r.product_id=p.id
  and r.branch_id=p.branch_id
  and lower(p.name) in (
    'classic burger - single',
    'classic burger - b1t1',
    'cheese burger - single',
    'cheese burger - b1t1',
    'deluxe burger - single',
    'deluxe burger - b1t1',
    'double cheese burger - single',
    'double cheese burger - b1t1',
    'b1 - classic burger - single',
    'b1 - classic burger - b1t1',
    'b2 - cheese burger - single',
    'b2 - cheese burger - b1t1',
    'b3 - deluxe burger - single',
    'b3 - deluxe burger - b1t1',
    'b4 - double cheese burger - single',
    'b4 - double cheese burger - b1t1'
  );

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
