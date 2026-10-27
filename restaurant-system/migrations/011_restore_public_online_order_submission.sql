begin;

do $$
begin
  if to_regclass('public.online_orders') is null
     or to_regprocedure('public.submit_online_order(jsonb,text,text,text,text,text,text,text,text,uuid,text)') is null
     or to_regprocedure('public.submit_online_order_internal(jsonb,text,text,text,text,text,text,text,uuid,text)') is null then
    raise exception 'Run migration 010 before migration 011';
  end if;
end;
$$;

drop function public.submit_online_order(jsonb,text,text,text,text,text,text,text,text,uuid,text);

alter function public.submit_online_order_internal(jsonb,text,text,text,text,text,text,text,uuid,text)
  rename to submit_online_order;

revoke all on function public.submit_online_order(jsonb,text,text,text,text,text,text,text,uuid,text)
  from public;
grant execute on function public.submit_online_order(jsonb,text,text,text,text,text,text,text,uuid,text)
  to anon,authenticated;

commit;
