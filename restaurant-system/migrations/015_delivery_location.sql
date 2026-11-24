begin;

alter table public.online_orders
  add column if not exists delivery_latitude numeric(9,6),
  add column if not exists delivery_longitude numeric(9,6);

alter table public.online_orders
  drop constraint if exists online_orders_delivery_coordinates_check;
alter table public.online_orders
  add constraint online_orders_delivery_coordinates_check check (
    (delivery_latitude is null and delivery_longitude is null)
    or (delivery_latitude between -90 and 90 and delivery_longitude between -180 and 180)
  );

create or replace function public.save_online_order_location(
  p_tracking_token text,
  p_latitude numeric,
  p_longitude numeric
)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
begin
  if coalesce(p_tracking_token,'') !~ '^[0-9a-f]{64}$'
     or p_latitude is null or p_longitude is null
     or p_latitude not between -90 and 90
     or p_longitude not between -180 and 180 then
    raise exception 'The delivery location is invalid';
  end if;

  update public.online_orders
  set delivery_latitude=round(p_latitude,6), delivery_longitude=round(p_longitude,6)
  where tracking_token_hash=encode(digest(p_tracking_token,'sha256'),'hex')
    and fulfillment_type='delivery' and status='pending';

  if not found then raise exception 'Order not found or location cannot be saved'; end if;
end;
$$;

revoke all on function public.save_online_order_location(text,numeric,numeric) from public;
grant execute on function public.save_online_order_location(text,numeric,numeric) to anon,authenticated;

notify pgrst,'reload schema';
commit;
