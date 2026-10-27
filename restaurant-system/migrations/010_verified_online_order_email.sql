begin;

do $$
begin
  if to_regclass('public.online_orders') is null
     or to_regprocedure('public.submit_online_order(jsonb,text,text,text,text,text,text,text,uuid,text)') is null then
    raise exception 'Run migration 009 before migration 010';
  end if;
end;
$$;

alter table public.online_orders
  add column customer_email text;

alter table public.online_orders
  add constraint online_orders_customer_email_normalized_check
  check (customer_email is null or customer_email=lower(trim(customer_email)));

alter function public.submit_online_order(jsonb,text,text,text,text,text,text,text,uuid,text)
  rename to submit_online_order_internal;

revoke all on function public.submit_online_order_internal(jsonb,text,text,text,text,text,text,text,uuid,text)
  from public,anon,authenticated;

create or replace function public.submit_online_order(
  p_items jsonb,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_fulfillment_type text,
  p_delivery_address text,
  p_delivery_landmark text,
  p_payment_method text,
  p_notes text,
  p_idempotency_key uuid,
  p_tracking_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_email text := lower(trim(coalesce(p_customer_email,'')));
  v_verified_email text;
  v_email_confirmed_at timestamptz;
  v_result jsonb;
  v_saved_email text;
begin
  if auth.uid() is null then
    raise exception 'Verify your email before sending an order';
  end if;

  select lower(u.email),u.email_confirmed_at
    into v_verified_email,v_email_confirmed_at
  from auth.users u
  where u.id=auth.uid();

  if v_email_confirmed_at is null or v_verified_email is distinct from v_email then
    raise exception 'Verify the email address you entered before sending an order';
  end if;

  v_result := public.submit_online_order_internal(
    p_items,
    p_customer_name,
    p_customer_phone,
    p_fulfillment_type,
    p_delivery_address,
    p_delivery_landmark,
    p_payment_method,
    p_notes,
    p_idempotency_key,
    p_tracking_token
  );

  update public.online_orders
  set customer_email=v_email
  where tracking_token_hash=encode(digest(p_tracking_token,'sha256'),'hex')
    and (customer_email is null or customer_email=v_email)
  returning customer_email into v_saved_email;

  if v_saved_email is null then
    raise exception 'This checkout belongs to a different verified email address';
  end if;

  return v_result;
end;
$$;

revoke all on function public.submit_online_order(jsonb,text,text,text,text,text,text,text,text,uuid,text)
  from public,anon;
grant execute on function public.submit_online_order(jsonb,text,text,text,text,text,text,text,text,uuid,text)
  to authenticated;

commit;
