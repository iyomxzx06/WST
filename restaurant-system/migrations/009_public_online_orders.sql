begin;

do $$
begin
  if to_regprocedure('public.create_pos_order(jsonb,text,text,text,uuid,numeric,text)') is null
     or to_regprocedure('public.set_kitchen_status(uuid,text)') is null
     or to_regclass('public.payments') is null then
    raise exception 'Run migration 001 before migration 009';
  end if;
end;
$$;

alter table public.sales_orders
  drop constraint if exists sales_orders_order_type_check;
alter table public.sales_orders
  add constraint sales_orders_order_type_check
  check (order_type in ('dine_in','takeout','delivery'));

create table if not exists public.online_orders (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  public_reference text not null unique,
  tracking_token_hash text not null unique,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  customer_name text not null check (length(trim(customer_name)) between 2 and 120),
  customer_phone text not null check (customer_phone ~ '^[0-9]{10,15}$'),
  fulfillment_type text not null check (fulfillment_type in ('pickup','delivery')),
  delivery_address text,
  delivery_landmark text,
  delivery_fee numeric(12,2) not null default 0 check (delivery_fee in (0,30)),
  payment_method text not null check (payment_method in ('cash','gcash')),
  subtotal numeric(12,2) not null check (subtotal >= 0),
  total numeric(12,2) not null check (total = subtotal + delivery_fee),
  notes text check (notes is null or length(notes) <= 500),
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  sales_order_id uuid references public.sales_orders(id) on delete set null,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_by uuid references auth.users(id) on delete set null,
  unique(branch_id,idempotency_key),
  check (
    (fulfillment_type='pickup' and delivery_fee=0 and delivery_address is null)
    or (fulfillment_type='delivery' and delivery_fee=30 and length(trim(coalesce(delivery_address,''))) between 8 and 400)
  )
);

create table if not exists public.online_order_items (
  id uuid primary key default gen_random_uuid(),
  online_order_id uuid not null references public.online_orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  quantity integer not null check (quantity between 1 and 20),
  unit_price numeric(12,2) not null check (unit_price >= 0)
);

create index if not exists online_orders_branch_status_created_idx
  on public.online_orders(branch_id,status,created_at desc);
create index if not exists online_order_items_order_id_idx
  on public.online_order_items(online_order_id);

alter table public.online_orders enable row level security;
alter table public.online_order_items enable row level security;

drop policy if exists "staff read branch online orders" on public.online_orders;
create policy "staff read branch online orders" on public.online_orders for select to authenticated
  using (
    branch_id=public.current_branch_id()
    and public.current_staff_role() in ('owner_admin','manager','cashier')
  );

drop policy if exists "staff read online order items" on public.online_order_items;
create policy "staff read online order items" on public.online_order_items for select to authenticated
  using (
    online_order_id in (
      select id from public.online_orders
      where branch_id=public.current_branch_id()
        and public.current_staff_role() in ('owner_admin','manager','cashier')
    )
  );

revoke all on public.online_orders,public.online_order_items from public,anon,authenticated;
grant select on public.online_orders,public.online_order_items to authenticated;

create or replace function public.get_public_order_menu()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, extensions
as $$
declare
  v_branch_id uuid;
  v_branch_name text;
  v_business_name text;
  v_products jsonb;
begin
  select b.id,b.name,coalesce(biz.name,'Havens Burger')
    into v_branch_id,v_branch_name,v_business_name
  from public.branches b
  join public.businesses biz on biz.id=b.business_id
  order by b.created_at,b.id
  limit 1;

  if v_branch_id is null then
    raise exception 'Online ordering is not available yet';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'name',p.name,'price',p.price
  ) order by p.name),'[]'::jsonb)
    into v_products
  from public.products p
  where p.branch_id=v_branch_id and p.active;

  return jsonb_build_object(
    'business_name',v_business_name,
    'branch_name',v_branch_name,
    'delivery_fee',30,
    'products',v_products
  );
end;
$$;

create or replace function public.submit_online_order(
  p_items jsonb,
  p_customer_name text,
  p_customer_phone text,
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
  v_branch_id uuid;
  v_order_id uuid;
  v_reference text;
  v_fingerprint text;
  v_saved_fingerprint text;
  v_saved_tracking_hash text;
  v_name text := trim(coalesce(p_customer_name,''));
  v_phone text := regexp_replace(coalesce(p_customer_phone,''),'[^0-9]','','g');
  v_fulfillment text := coalesce(p_fulfillment_type,'');
  v_address text := nullif(trim(coalesce(p_delivery_address,'')),'');
  v_landmark text := nullif(trim(coalesce(p_delivery_landmark,'')),'');
  v_notes text := nullif(trim(coalesce(p_notes,'')),'');
  v_fee numeric(12,2);
  v_subtotal numeric(12,2) := 0;
  v_product public.products%rowtype;
  v_line jsonb;
  v_quantity integer;
begin
  if p_idempotency_key is null or coalesce(p_tracking_token,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'Refresh the page and submit your order again';
  end if;
  if length(v_name) not between 2 and 120 then
    raise exception 'Enter your name (2 to 120 characters)';
  end if;
  if length(v_phone) not between 10 and 15 then
    raise exception 'Enter a valid phone number with 10 to 15 digits';
  end if;
  if v_fulfillment not in ('pickup','delivery') then
    raise exception 'Choose pickup or delivery';
  end if;
  if v_fulfillment='delivery' and length(coalesce(v_address,'')) not between 8 and 400 then
    raise exception 'Enter a delivery address between 8 and 400 characters';
  end if;
  if v_fulfillment='pickup' and (v_address is not null or v_landmark is not null) then
    raise exception 'Pickup orders should not include a delivery address';
  end if;
  if v_landmark is not null and length(v_landmark)>150 then
    raise exception 'Delivery landmark must be 150 characters or less';
  end if;
  if coalesce(p_payment_method,'') not in ('cash','gcash') then
    raise exception 'Choose cash or GCash';
  end if;
  if v_notes is not null and length(v_notes)>500 then
    raise exception 'Order notes must be 500 characters or less';
  end if;
  if coalesce(jsonb_typeof(p_items),'')<>'array' then
    raise exception 'Choose between 1 and 30 menu items';
  end if;
  if jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>30 then
    raise exception 'Choose between 1 and 30 menu items';
  end if;
  if (select count(distinct lower(value->>'product_id')) from jsonb_array_elements(p_items))
      <> jsonb_array_length(p_items) then
    raise exception 'Remove duplicate menu items and try again';
  end if;

  select b.id into v_branch_id
  from public.branches b
  order by b.created_at,b.id
  limit 1;
  if v_branch_id is null then raise exception 'Online ordering is not available yet'; end if;

  v_fee := case when v_fulfillment='delivery' then 30 else 0 end;
  v_fingerprint := encode(digest(jsonb_build_object(
    'items',p_items,
    'customer_name',v_name,
    'customer_phone',v_phone,
    'fulfillment_type',v_fulfillment,
    'delivery_address',coalesce(v_address,''),
    'delivery_landmark',coalesce(v_landmark,''),
    'payment_method',p_payment_method,
    'notes',coalesce(v_notes,'')
  )::text,'sha256'),'hex');

  perform pg_advisory_xact_lock(9009,hashtext(p_idempotency_key::text));
  select id,public_reference,request_fingerprint,tracking_token_hash
    into v_order_id,v_reference,v_saved_fingerprint,v_saved_tracking_hash
  from public.online_orders
  where branch_id=v_branch_id and idempotency_key=p_idempotency_key;
  if found then
    if v_saved_fingerprint is distinct from v_fingerprint then
      raise exception 'This checkout was already submitted with different details';
    end if;
    if v_saved_tracking_hash is distinct from encode(digest(p_tracking_token,'sha256'),'hex') then
      raise exception 'This order was already submitted. Use the tracking link from the original confirmation.';
    end if;
    return jsonb_build_object(
      'reference',v_reference,'tracking_token',p_tracking_token,'status','pending'
    );
  end if;

  perform pg_advisory_xact_lock(9010,hashtext(v_phone));
  if (
    select count(*) from public.online_orders o
    where o.branch_id=v_branch_id and o.customer_phone=v_phone
      and o.created_at>now()-interval '15 minutes'
  )>=5 then
    raise exception 'Too many recent orders for this phone. Please wait a few minutes or call the restaurant.';
  end if;

  for v_line in select value from jsonb_array_elements(p_items)
  loop
    if coalesce(v_line->>'product_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(v_line->>'quantity','') !~ '^[0-9]{1,2}$' then
      raise exception 'A menu item or quantity is invalid';
    end if;
    v_quantity := (v_line->>'quantity')::integer;
    if v_quantity not between 1 and 20 then raise exception 'Each quantity must be from 1 to 20'; end if;
    select * into v_product
    from public.products p
    where p.id=(v_line->>'product_id')::uuid
      and p.branch_id=v_branch_id and p.active
    for share;
    if not found then raise exception 'A selected menu item is no longer available'; end if;
    v_subtotal := v_subtotal+round(v_product.price*v_quantity,2);
  end loop;

  v_subtotal := round(v_subtotal,2);
  v_reference := 'HB-'||upper(encode(gen_random_bytes(8),'hex'));
  insert into public.online_orders(
    branch_id,public_reference,tracking_token_hash,idempotency_key,request_fingerprint,
    customer_name,customer_phone,fulfillment_type,delivery_address,delivery_landmark,
    delivery_fee,payment_method,subtotal,total,notes
  ) values (
    v_branch_id,v_reference,encode(digest(p_tracking_token,'sha256'),'hex'),p_idempotency_key,v_fingerprint,
    v_name,v_phone,v_fulfillment,v_address,v_landmark,v_fee,p_payment_method,
    v_subtotal,v_subtotal+v_fee,v_notes
  ) returning id into v_order_id;

  for v_line in select value from jsonb_array_elements(p_items)
  loop
    select * into v_product from public.products
    where id=(v_line->>'product_id')::uuid and branch_id=v_branch_id and active;
    insert into public.online_order_items(online_order_id,product_id,product_name,quantity,unit_price)
    values(v_order_id,v_product.id,v_product.name,(v_line->>'quantity')::integer,v_product.price);
  end loop;

  return jsonb_build_object(
    'reference',v_reference,'tracking_token',p_tracking_token,'status','pending',
    'subtotal',v_subtotal,'delivery_fee',v_fee,'total',v_subtotal+v_fee
  );
end;
$$;

create or replace function public.get_online_order_status(p_tracking_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, extensions
as $$
declare
  v_order public.online_orders%rowtype;
  v_sales_status text;
begin
  if coalesce(p_tracking_token,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'This order tracking link is invalid';
  end if;
  select * into v_order
  from public.online_orders
  where tracking_token_hash=encode(digest(p_tracking_token,'sha256'),'hex');
  if not found then raise exception 'Order not found. Check the tracking link from your confirmation.'; end if;

  if v_order.status='accepted' and v_order.sales_order_id is not null then
    select status into v_sales_status from public.sales_orders where id=v_order.sales_order_id;
  end if;

  return jsonb_build_object(
    'reference',v_order.public_reference,
    'status',coalesce(v_sales_status,v_order.status),
    'fulfillment_type',v_order.fulfillment_type,
    'payment_method',v_order.payment_method,
    'subtotal',v_order.subtotal,
    'delivery_fee',v_order.delivery_fee,
    'total',v_order.total,
    'created_at',v_order.created_at,
    'updated_at',coalesce(v_order.processed_at,v_order.created_at)
  );
end;
$$;

create or replace function public.accept_online_order(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_role text := public.current_staff_role();
  v_branch_id uuid := public.current_branch_id();
  v_online public.online_orders%rowtype;
  v_sale_id uuid;
  v_line record;
  v_stock record;
  v_required numeric(14,3);
begin
  if v_branch_id is null or v_role not in ('owner_admin','manager','cashier') then
    raise exception 'You do not have permission to accept online orders';
  end if;
  select * into v_online from public.online_orders
  where id=p_order_id and branch_id=v_branch_id for update;
  if not found or v_online.status<>'pending' then
    raise exception 'This online order is no longer awaiting confirmation';
  end if;

  for v_line in
    select oi.product_id,oi.product_name,oi.quantity,oi.unit_price,p.track_inventory,p.active
    from public.online_order_items oi
    left join public.products p on p.id=oi.product_id and p.branch_id=v_branch_id
    where oi.online_order_id=v_online.id
  loop
    if v_line.product_id is null or v_line.active is distinct from true then
      raise exception 'A menu item in this order is no longer available';
    end if;
    if v_line.track_inventory and not exists(
      select 1 from public.recipes r
      where r.product_id=v_line.product_id and r.branch_id=v_branch_id
    ) then
      raise exception 'Set up the stock recipe for % before accepting this order',v_line.product_name;
    end if;
    if v_line.track_inventory and exists(
      select 1
      from public.recipes r
      left join public.ingredients i on i.id=r.ingredient_id and i.branch_id=v_branch_id
      where r.product_id=v_line.product_id and r.branch_id=v_branch_id
        and (i.id is null or not i.active)
    ) then
      raise exception 'A stock ingredient for % is inactive',v_line.product_name;
    end if;
  end loop;

  perform i.id
  from public.ingredients i
  where i.branch_id=v_branch_id and i.id in (
    select r.ingredient_id
    from public.online_order_items oi
    join public.products p on p.id=oi.product_id and p.branch_id=v_branch_id and p.track_inventory
    join public.recipes r on r.product_id=p.id and r.branch_id=v_branch_id
    where oi.online_order_id=v_online.id
  )
  order by i.id
  for update;

  for v_stock in
    select i.id,i.name,i.stock_quantity,
      sum(r.quantity*oi.quantity) as required_quantity
    from public.online_order_items oi
    join public.products p on p.id=oi.product_id and p.branch_id=v_branch_id and p.track_inventory
    join public.recipes r on r.product_id=p.id and r.branch_id=v_branch_id
    join public.ingredients i on i.id=r.ingredient_id and i.branch_id=v_branch_id and i.active
    where oi.online_order_id=v_online.id
    group by i.id,i.name,i.stock_quantity
    order by i.id
  loop
    if v_stock.stock_quantity<v_stock.required_quantity then
      raise exception 'Not enough % in stock to accept this order',v_stock.name;
    end if;
  end loop;

  insert into public.sales_orders(
    branch_id,status,order_type,payment_method,total,notes,created_by,idempotency_key,request_fingerprint
  ) values (
    v_branch_id,'new',case when v_online.fulfillment_type='delivery' then 'delivery' else 'takeout' end,
    v_online.payment_method,v_online.total,nullif(v_online.notes,''),auth.uid(),
    gen_random_uuid(),encode(digest(v_online.id::text,'sha256'),'hex')
  ) returning id into v_sale_id;

  for v_line in
    select oi.product_id,oi.product_name,oi.quantity,oi.unit_price,p.track_inventory
    from public.online_order_items oi
    join public.products p on p.id=oi.product_id and p.branch_id=v_branch_id
    where oi.online_order_id=v_online.id
  loop
    insert into public.sales_order_items(order_id,product_id,product_name,quantity,unit_price)
    values(v_sale_id,v_line.product_id,v_line.product_name,v_line.quantity,v_line.unit_price);
  end loop;

  if v_online.delivery_fee>0 then
    insert into public.sales_order_items(order_id,product_id,product_name,quantity,unit_price)
    values(v_sale_id,null,'Delivery fee',1,v_online.delivery_fee);
  end if;

  for v_stock in
    select i.id,i.name,
      sum(r.quantity*oi.quantity) as required_quantity
    from public.online_order_items oi
    join public.products p on p.id=oi.product_id and p.branch_id=v_branch_id and p.track_inventory
    join public.recipes r on r.product_id=p.id and r.branch_id=v_branch_id
    join public.ingredients i on i.id=r.ingredient_id and i.branch_id=v_branch_id and i.active
    where oi.online_order_id=v_online.id
    group by i.id,i.name
    order by i.id
  loop
    update public.ingredients
    set stock_quantity=stock_quantity-v_stock.required_quantity
    where id=v_stock.id and branch_id=v_branch_id;
    insert into public.inventory_movements(
      branch_id,ingredient_id,quantity_change,movement_type,reference_id,note,created_by
    ) values (
      v_branch_id,v_stock.id,-v_stock.required_quantity,'sale',v_sale_id,
      'Online order '||v_online.public_reference,auth.uid()
    );
  end loop;

  update public.online_orders
  set status='accepted',sales_order_id=v_sale_id,processed_at=now(),processed_by=auth.uid()
  where id=v_online.id;
  return v_sale_id;
end;
$$;

create or replace function public.reject_online_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_branch_id uuid := public.current_branch_id();
begin
  if v_branch_id is null or public.current_staff_role() not in ('owner_admin','manager','cashier') then
    raise exception 'You do not have permission to reject online orders';
  end if;
  update public.online_orders
  set status='rejected',processed_at=now(),processed_by=auth.uid()
  where id=p_order_id and branch_id=v_branch_id and status='pending';
  if not found then raise exception 'This online order is no longer awaiting confirmation'; end if;
end;
$$;

revoke all on function public.get_public_order_menu() from public;
revoke all on function public.submit_online_order(jsonb,text,text,text,text,text,text,text,uuid,text) from public;
revoke all on function public.get_online_order_status(text) from public;
revoke all on function public.accept_online_order(uuid) from public,anon;
revoke all on function public.reject_online_order(uuid) from public,anon;

grant execute on function public.get_public_order_menu() to anon,authenticated;
grant execute on function public.submit_online_order(jsonb,text,text,text,text,text,text,text,uuid,text) to anon,authenticated;
grant execute on function public.get_online_order_status(text) to anon,authenticated;
grant execute on function public.accept_online_order(uuid) to authenticated;
grant execute on function public.reject_online_order(uuid) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication where pubname='supabase_realtime') then
    raise exception 'Supabase Realtime publication was not found; create it before applying this migration';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='online_orders'
  ) then
    alter publication supabase_realtime add table public.online_orders;
  end if;
end;
$$;

notify pgrst,'reload schema';
commit;
