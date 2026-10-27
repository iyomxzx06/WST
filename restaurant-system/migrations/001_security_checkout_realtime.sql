begin;

create table if not exists public.owner_setup_allowlist (
  email text primary key check (email = lower(trim(email)) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  consumed_at timestamptz,
  consumed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.owner_setup_allowlist enable row level security;
revoke all on public.owner_setup_allowlist from public, anon, authenticated;

create or replace function public.bootstrap_business(p_business_name text, p_branch_name text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public, auth
as $$
declare
  new_business_id uuid;
  new_branch_id uuid;
  owner_email text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select lower(email) into owner_email from auth.users where id = auth.uid();
  if owner_email is null then raise exception 'Could not verify your account email'; end if;

  perform pg_advisory_xact_lock(hashtext('havens_first_business_setup'));
  if exists (select 1 from public.staff_profiles) then
    raise exception 'Business setup has already been completed';
  end if;
  if not exists (
    select 1 from public.owner_setup_allowlist
    where email = owner_email and consumed_at is null
  ) then
    raise exception 'This account is not authorized for initial Owner/Admin setup';
  end if;
  if length(trim(coalesce(p_business_name,''))) not between 1 and 120
     or length(trim(coalesce(p_branch_name,''))) not between 1 and 120
     or length(trim(coalesce(p_display_name,''))) not between 1 and 120 then
    raise exception 'Business, branch, and owner names are required';
  end if;

  insert into public.businesses(name) values (trim(p_business_name)) returning id into new_business_id;
  insert into public.branches(business_id,name) values (new_business_id,trim(p_branch_name)) returning id into new_branch_id;
  insert into public.staff_profiles(user_id,business_id,branch_id,display_name,role)
    values (auth.uid(),new_business_id,new_branch_id,trim(p_display_name),'owner_admin');
  update public.owner_setup_allowlist
    set consumed_at=now(),consumed_by=auth.uid()
    where email=owner_email and consumed_at is null;
  if not found then raise exception 'Initial Owner/Admin setup was already claimed'; end if;
  return new_branch_id;
end;
$$;

revoke all on function public.bootstrap_business(text,text,text) from public, anon;
grant execute on function public.bootstrap_business(text,text,text) to authenticated;

drop policy if exists "admins update staff profiles" on public.staff_profiles;
revoke update on public.staff_profiles from anon, authenticated;
grant select on public.staff_profiles to authenticated;

create unique index if not exists products_id_branch_id_key on public.products(id,branch_id);
create unique index if not exists ingredients_id_branch_id_key on public.ingredients(id,branch_id);
create unique index if not exists sales_orders_id_branch_id_key on public.sales_orders(id,branch_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname='recipes_product_branch_fk' and conrelid='public.recipes'::regclass) then
    alter table public.recipes add constraint recipes_product_branch_fk
      foreign key (product_id,branch_id) references public.products(id,branch_id) on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname='recipes_ingredient_branch_fk' and conrelid='public.recipes'::regclass) then
    alter table public.recipes add constraint recipes_ingredient_branch_fk
      foreign key (ingredient_id,branch_id) references public.ingredients(id,branch_id) on delete restrict not valid;
  end if;
end;
$$;

alter table public.recipes validate constraint recipes_product_branch_fk;
alter table public.recipes validate constraint recipes_ingredient_branch_fk;

alter table public.sales_orders add column if not exists idempotency_key uuid;
alter table public.sales_orders add column if not exists request_fingerprint text;
create unique index if not exists sales_orders_branch_idempotency_key_key
  on public.sales_orders(branch_id,idempotency_key);
create index if not exists sales_orders_branch_created_at_idx
  on public.sales_orders(branch_id,created_at desc);
create index if not exists sales_orders_branch_status_created_at_idx
  on public.sales_orders(branch_id,status,created_at);
create index if not exists sales_order_items_order_id_idx
  on public.sales_order_items(order_id);
create index if not exists purchase_order_items_order_id_idx
  on public.purchase_order_items(purchase_order_id);
create index if not exists expenses_branch_spent_at_idx
  on public.expenses(branch_id,spent_at desc);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  order_id uuid not null unique references public.sales_orders(id) on delete cascade,
  payment_method text not null check (payment_method in ('cash','gcash','card')),
  amount numeric(12,2) not null check (amount >= 0),
  amount_tendered numeric(12,2),
  change_due numeric(12,2) not null default 0 check (change_due >= 0),
  external_reference text check (external_reference is null or length(external_reference) <= 120),
  recorded_by uuid not null references auth.users(id),
  recorded_at timestamptz not null default now(),
  check (amount_tendered is null or amount_tendered >= amount)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname='payments_order_branch_fk' and conrelid='public.payments'::regclass) then
    alter table public.payments add constraint payments_order_branch_fk
      foreign key (order_id,branch_id) references public.sales_orders(id,branch_id) on delete cascade not valid;
  end if;
end;
$$;
alter table public.payments validate constraint payments_order_branch_fk;

alter table public.payments enable row level security;
drop policy if exists "staff read branch payments" on public.payments;
drop policy if exists "cashiers read branch payments" on public.payments;
create policy "cashiers read branch payments" on public.payments for select to authenticated
  using (
    branch_id=public.current_branch_id()
    and public.current_staff_role() in ('owner_admin','manager','cashier')
  );

drop policy if exists "inventory create purchases" on public.purchase_orders;
revoke all on public.businesses,public.branches,public.staff_profiles,public.products,public.ingredients,public.recipes,
  public.suppliers,public.purchase_orders,public.purchase_order_items,public.sales_orders,public.sales_order_items,
  public.inventory_movements,public.expenses,public.payments,public.legacy_catalog_imports
  from public,anon,authenticated;
grant select on public.businesses,public.branches to authenticated;
grant select on public.staff_profiles,public.ingredients,public.recipes,public.purchase_orders,
  public.purchase_order_items,public.sales_orders,public.sales_order_items,
  public.inventory_movements,public.payments to authenticated;
grant select,insert,update,delete on public.products,public.suppliers to authenticated;
grant select,insert on public.expenses to authenticated;

revoke all on function public.import_legacy_pos_catalog() from public, anon, authenticated;
revoke all on function public.create_pos_order(jsonb,text,text,text) from public, anon, authenticated;
revoke all on function public.current_branch_id() from public, anon;
revoke all on function public.current_staff_role() from public, anon;
revoke all on function public.set_kitchen_status(uuid,text) from public, anon;
revoke all on function public.adjust_ingredient_stock(uuid,numeric,text,text) from public, anon;
revoke all on function public.create_ingredient(text,text,numeric,numeric,numeric) from public, anon;
revoke all on function public.create_purchase_order(uuid,jsonb,text) from public, anon;
revoke all on function public.receive_purchase_order(uuid) from public, anon;
grant execute on function public.current_branch_id() to authenticated;
grant execute on function public.current_staff_role() to authenticated;
grant execute on function public.set_kitchen_status(uuid,text) to authenticated;
grant execute on function public.adjust_ingredient_stock(uuid,numeric,text,text) to authenticated;
grant execute on function public.create_ingredient(text,text,numeric,numeric,numeric) to authenticated;
grant execute on function public.create_purchase_order(uuid,jsonb,text) to authenticated;
grant execute on function public.receive_purchase_order(uuid) to authenticated;

create or replace function public.create_pos_order(
  p_items jsonb,
  p_payment_method text,
  p_order_type text,
  p_notes text,
  p_idempotency_key uuid,
  p_amount_tendered numeric,
  p_external_reference text
)
returns uuid language plpgsql security definer set search_path = public, auth, extensions
as $$
declare
  v_branch_id uuid := public.current_branch_id();
  new_order_id uuid;
  existing_order_id uuid;
  existing_fingerprint text;
  request_hash text;
  order_total numeric(12,2) := 0;
  line jsonb;
  product_row public.products%rowtype;
  stock_row record;
  line_quantity integer;
  change_due numeric(12,2);
begin
  if v_branch_id is null or public.current_staff_role() not in ('owner_admin','manager','cashier') then
    raise exception 'You do not have permission to create orders';
  end if;
  if coalesce(jsonb_typeof(p_items),'') <> 'array' or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 100 then
    raise exception 'Order must contain between 1 and 100 items';
  end if;
  if coalesce(p_payment_method,'') not in ('cash','gcash','card')
     or coalesce(p_order_type,'') not in ('dine_in','takeout')
     or p_idempotency_key is null then
    raise exception 'Invalid payment method, order type, or checkout key';
  end if;
  if length(coalesce(p_notes,'')) > 500 or length(coalesce(p_external_reference,'')) > 120 then
    raise exception 'Order notes or payment reference is too long';
  end if;
  if p_payment_method = 'cash' and p_external_reference is not null then
    raise exception 'A cash payment cannot have an external reference';
  end if;

  request_hash := encode(digest(jsonb_build_object(
    'items',p_items,'payment_method',p_payment_method,'order_type',p_order_type,
    'notes',coalesce(p_notes,''),'amount_tendered',p_amount_tendered,
    'external_reference',coalesce(p_external_reference,'')
  )::text,'sha256'),'hex');
  select id,request_fingerprint into existing_order_id,existing_fingerprint
    from public.sales_orders
    where branch_id=v_branch_id and idempotency_key=p_idempotency_key
    for update;
  if found then
    if existing_fingerprint is distinct from request_hash then
      raise exception 'This checkout key was already used for a different order. Start a new checkout.';
    end if;
    return existing_order_id;
  end if;

  for line in select value from jsonb_array_elements(p_items)
  loop
    line_quantity := (line->>'quantity')::integer;
    if line_quantity is null or line_quantity < 1 or line_quantity > 99 then raise exception 'Invalid item quantity'; end if;
    select * into product_row from public.products
      where id=(line->>'product_id')::uuid and branch_id=v_branch_id and active
      for share;
    if not found then raise exception 'A selected product is unavailable'; end if;
    if product_row.track_inventory and not exists(
      select 1 from public.recipes r where r.product_id=product_row.id and r.branch_id=v_branch_id
    ) then
      raise exception 'Set up the recipe for % before selling it',product_row.name;
    end if;
    if product_row.track_inventory and exists(
      select 1 from public.recipes r join public.ingredients i on i.id=r.ingredient_id
      where r.product_id=product_row.id and r.branch_id=v_branch_id and not i.active
    ) then
      raise exception 'A recipe ingredient for % is inactive',product_row.name;
    end if;
    order_total := order_total + round(product_row.price * line_quantity,2);
  end loop;
  order_total := round(order_total,2);

  if p_payment_method='cash' then
    if p_amount_tendered is null or p_amount_tendered < order_total then
      raise exception 'Cash received must be at least the order total';
    end if;
    change_due := p_amount_tendered-order_total;
  else
    if p_amount_tendered is not null then raise exception 'Tendered amount is only valid for cash'; end if;
    change_due := 0;
  end if;

  insert into public.sales_orders(
    branch_id,payment_method,order_type,notes,created_by,idempotency_key,request_fingerprint
  ) values (
    v_branch_id,p_payment_method,p_order_type,nullif(trim(coalesce(p_notes,'')),''),auth.uid(),p_idempotency_key,request_hash
  )
  on conflict (branch_id,idempotency_key) do nothing
  returning id into new_order_id;

  if new_order_id is null then
    select id,request_fingerprint into existing_order_id,existing_fingerprint
      from public.sales_orders
      where branch_id=v_branch_id and idempotency_key=p_idempotency_key
      for update;
    if existing_fingerprint is distinct from request_hash then
      raise exception 'This checkout key was already used for a different order. Start a new checkout.';
    end if;
    return existing_order_id;
  end if;

  perform i.id
    from public.ingredients i
    where i.branch_id=v_branch_id and i.id in (
      select r.ingredient_id
      from jsonb_array_elements(p_items) as item(value)
      join public.products p on p.id=(item.value->>'product_id')::uuid
        and p.branch_id=v_branch_id and p.track_inventory
      join public.recipes r on r.product_id=p.id and r.branch_id=v_branch_id
    )
    order by i.id
    for update;

  for stock_row in
    select i.id,i.name,i.stock_quantity,
      sum(r.quantity*(item.value->>'quantity')::integer) as required_quantity
    from jsonb_array_elements(p_items) as item(value)
    join public.products p on p.id=(item.value->>'product_id')::uuid
      and p.branch_id=v_branch_id and p.track_inventory
    join public.recipes r on r.product_id=p.id and r.branch_id=v_branch_id
    join public.ingredients i on i.id=r.ingredient_id and i.branch_id=v_branch_id and i.active
    group by i.id,i.name,i.stock_quantity
    order by i.id
  loop
    if stock_row.stock_quantity < stock_row.required_quantity then
      raise exception 'Not enough % in stock to complete this order',stock_row.name;
    end if;
    update public.ingredients
      set stock_quantity=stock_quantity-stock_row.required_quantity
      where id=stock_row.id and branch_id=v_branch_id;
    insert into public.inventory_movements(
      branch_id,ingredient_id,quantity_change,movement_type,reference_id,note,created_by
    ) values (
      v_branch_id,stock_row.id,-stock_row.required_quantity,'sale',new_order_id,'Order ingredient use',auth.uid()
    );
  end loop;

  for line in select value from jsonb_array_elements(p_items)
  loop
    line_quantity := (line->>'quantity')::integer;
    select * into product_row from public.products
      where id=(line->>'product_id')::uuid and branch_id=v_branch_id and active;
    insert into public.sales_order_items(order_id,product_id,product_name,quantity,unit_price)
      values(new_order_id,product_row.id,product_row.name,line_quantity,product_row.price);
  end loop;

  update public.sales_orders set total=order_total where id=new_order_id;
  insert into public.payments(
    branch_id,order_id,payment_method,amount,amount_tendered,change_due,external_reference,recorded_by
  ) values (
    v_branch_id,new_order_id,p_payment_method,order_total,p_amount_tendered,change_due,
    nullif(trim(coalesce(p_external_reference,'')),''),auth.uid()
  );
  return new_order_id;
end;
$$;

revoke all on function public.create_pos_order(jsonb,text,text,text,uuid,numeric,text) from public, anon;
grant execute on function public.create_pos_order(jsonb,text,text,text,uuid,numeric,text) to authenticated;

create or replace function public.save_product_recipe(p_product_id uuid, p_items jsonb)
returns void language plpgsql security definer set search_path = public, auth
as $$
declare
  v_branch_id uuid := public.current_branch_id();
  line jsonb;
  item_quantity numeric(14,3);
  item_ingredient_id uuid;
begin
  if v_branch_id is null or public.current_staff_role() not in ('owner_admin','manager','inventory') then
    raise exception 'You do not have permission to edit recipes';
  end if;
  perform 1 from public.products
    where id=p_product_id and branch_id=v_branch_id and active
    for update;
  if not found then raise exception 'Product not found'; end if;
  if coalesce(jsonb_typeof(p_items),'') <> 'array' or jsonb_array_length(p_items)=0 then
    raise exception 'Add at least one ingredient to the recipe';
  end if;
  for line in select value from jsonb_array_elements(p_items)
  loop
    item_ingredient_id := (line->>'ingredient_id')::uuid;
    item_quantity := (line->>'quantity')::numeric;
    if item_quantity <= 0 or not exists(
      select 1 from public.ingredients where id=item_ingredient_id and branch_id=v_branch_id and active
    ) then raise exception 'Recipe contains an invalid ingredient or quantity'; end if;
  end loop;
  delete from public.recipes where product_id=p_product_id and branch_id=v_branch_id;
  for line in select value from jsonb_array_elements(p_items)
  loop
    insert into public.recipes(branch_id,product_id,ingredient_id,quantity)
      values(v_branch_id,p_product_id,(line->>'ingredient_id')::uuid,(line->>'quantity')::numeric);
  end loop;
end;
$$;

revoke all on function public.save_product_recipe(uuid,jsonb) from public, anon;
grant execute on function public.save_product_recipe(uuid,jsonb) to authenticated;

create or replace function public.get_operational_report(p_start timestamptz,p_end timestamptz,p_start_date date,p_end_date date)
returns jsonb language plpgsql stable security definer set search_path = public, auth
as $$
declare
  v_branch_id uuid := public.current_branch_id();
  sales_summary jsonb;
  expense_summary jsonb;
begin
  if v_branch_id is null or public.current_staff_role() not in ('owner_admin','manager') then
    raise exception 'You do not have permission to view reports';
  end if;
  if p_start is null or p_end is null or p_start >= p_end
     or p_start_date is null or p_end_date is null or p_start_date >= p_end_date then
    raise exception 'Enter a valid report date range';
  end if;

  select jsonb_build_object(
    'order_count',count(*) filter (where status <> 'void'),
    'void_count',count(*) filter (where status = 'void'),
    'net_sales',coalesce(sum(total) filter (where status <> 'void'),0),
    'cash_sales',coalesce(sum(total) filter (where status <> 'void' and payment_method='cash'),0),
    'gcash_sales',coalesce(sum(total) filter (where status <> 'void' and payment_method='gcash'),0),
    'card_sales',coalesce(sum(total) filter (where status <> 'void' and payment_method='card'),0)
  ) into sales_summary
  from public.sales_orders where branch_id=v_branch_id and created_at >= p_start and created_at < p_end;

  select jsonb_build_object(
    'expense_count',count(*),
    'total',coalesce(sum(amount),0)
  ) into expense_summary
  from public.expenses
  where branch_id=v_branch_id and spent_at >= p_start_date and spent_at < p_end_date;

  return jsonb_build_object('sales',sales_summary,'expenses',expense_summary);
end;
$$;

revoke all on function public.get_operational_report(timestamptz,timestamptz,date,date) from public, anon;
grant execute on function public.get_operational_report(timestamptz,timestamptz,date,date) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication where pubname='supabase_realtime') then
    raise exception 'Supabase Realtime publication was not found; create it before applying this migration';
  end if;
  begin
    alter publication supabase_realtime add table public.sales_orders;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.ingredients;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.inventory_movements;
  exception when duplicate_object then null;
  end;
end;
$$;

notify pgrst, 'reload schema';
commit;
