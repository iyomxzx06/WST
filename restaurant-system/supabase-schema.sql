create extension if not exists pgcrypto;

create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  created_at timestamptz not null default now()
);

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  unique (business_id, name)
);

create table if not exists public.staff_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  display_name text not null check (length(trim(display_name)) between 1 and 120),
  role text not null check (role in ('owner_admin','manager','cashier','kitchen','inventory')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.current_branch_id()
returns uuid language sql stable security definer set search_path = public
as $$
  select branch_id from public.staff_profiles
  where user_id = (select auth.uid()) and active
$$;

create or replace function public.current_staff_role()
returns text language sql stable security definer set search_path = public
as $$
  select role from public.staff_profiles
  where user_id = (select auth.uid()) and active
$$;

create or replace function public.bootstrap_business(p_business_name text, p_branch_name text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public, auth
as $$
declare
  new_business_id uuid;
  new_branch_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  perform pg_advisory_xact_lock(hashtext('havens_first_business_setup'));
  if exists (select 1 from public.staff_profiles) then
    raise exception 'Business setup has already been completed';
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
  return new_branch_id;
end;
$$;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  price numeric(12,2) not null check (price >= 0),
  track_inventory boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.ingredients (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  unit text not null check (length(trim(unit)) between 1 and 24),
  stock_quantity numeric(14,3) not null default 0,
  reorder_level numeric(14,3) not null default 0 check (reorder_level >= 0),
  unit_cost numeric(12,4) not null default 0 check (unit_cost >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(branch_id,name)
);

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  unique(product_id, ingredient_id)
);

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  contact_name text,
  phone text,
  email text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  status text not null default 'ordered' check (status in ('ordered','received','cancelled')),
  notes text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  received_at timestamptz
);

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_cost numeric(12,4) not null check (unit_cost >= 0)
);

create table if not exists public.sales_orders (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  order_number bigint generated always as identity,
  status text not null default 'new' check (status in ('new','preparing','ready','served','void')),
  order_type text not null default 'dine_in' check (order_type in ('dine_in','takeout')),
  payment_method text not null check (payment_method in ('cash','gcash','card')),
  total numeric(12,2) not null default 0 check (total >= 0),
  notes text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.sales_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.sales_orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0)
);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete restrict,
  quantity_change numeric(14,3) not null,
  movement_type text not null check (movement_type in ('opening','adjustment','purchase','sale','waste')),
  reference_id uuid,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  category text not null check (length(trim(category)) between 1 and 80),
  description text not null check (length(trim(description)) between 1 and 240),
  amount numeric(12,2) not null check (amount > 0),
  payment_method text not null default 'cash' check (payment_method in ('cash','gcash','card','other')),
  spent_at date not null default current_date,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.legacy_catalog_imports (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  imported_by uuid not null references auth.users(id),
  imported_at timestamptz not null default now()
);

alter table public.products add column if not exists track_inventory boolean not null default true;
alter table public.legacy_catalog_imports enable row level security;

drop policy if exists "staff read legacy import marker" on public.legacy_catalog_imports;
create policy "staff read legacy import marker" on public.legacy_catalog_imports for select to authenticated
  using (branch_id=public.current_branch_id());

grant select on public.legacy_catalog_imports to authenticated;

create or replace function public.import_legacy_pos_catalog()
returns jsonb language plpgsql security definer set search_path = public, auth
as $$
declare
  v_branch_id uuid := public.current_branch_id();
  legacy_state jsonb;
  burger jsonb;
  extra jsonb;
  ingredient_buns uuid;
  ingredient_patties uuid;
  product_id uuid;
  item_name text;
  item_price numeric(12,2);
  bun_qty numeric(14,3);
  patty_qty numeric(14,3);
  imported_products integer := 0;
  buns_stock numeric(14,3);
  patties_stock numeric(14,3);
  low_stock numeric(14,3);
begin
  if v_branch_id is null or public.current_staff_role() <> 'owner_admin' then
    raise exception 'Only the Owner/Admin can import the old POS catalog';
  end if;
  if to_regclass('public.pos_state') is null then
    raise exception 'The legacy POS table was not found in this Supabase project';
  end if;
  if exists(select 1 from public.legacy_catalog_imports where branch_id=v_branch_id) then
    raise exception 'The old POS catalog has already been imported for this branch';
  end if;
  execute 'select state from public.pos_state where user_id = $1'
    into legacy_state using auth.uid();
  if legacy_state is null then
    raise exception 'No old POS data was found for this Supabase login. Sign into Supabase with the account used by the old POS.';
  end if;
  if coalesce(jsonb_typeof(legacy_state->'menu'->'burgers'),'') <> 'array'
     or coalesce(jsonb_typeof(legacy_state->'menu'->'extras'),'') <> 'array' then
    raise exception 'The old POS menu data is missing or invalid';
  end if;
  if exists(select 1 from public.sales_orders where branch_id=v_branch_id)
     or exists(select 1 from public.purchase_orders where branch_id=v_branch_id) then
    raise exception 'Catalog import can only replace setup/test data. Existing sales or purchase orders were found.';
  end if;

  delete from public.legacy_catalog_imports where branch_id=v_branch_id;
  delete from public.recipes where branch_id=v_branch_id;
  delete from public.inventory_movements where branch_id=v_branch_id;
  delete from public.products where branch_id=v_branch_id;
  delete from public.ingredients where branch_id=v_branch_id;

  buns_stock := greatest(0,coalesce((legacy_state->'inv'->>'buns')::numeric,0));
  patties_stock := greatest(0,coalesce((legacy_state->'inv'->>'patties')::numeric,0));
  low_stock := greatest(0,coalesce((legacy_state->'settings'->>'lowStock')::numeric,0));

  insert into public.ingredients(branch_id,name,unit,stock_quantity,reorder_level)
    values(v_branch_id,'Buns','pcs',buns_stock,low_stock) returning id into ingredient_buns;
  insert into public.ingredients(branch_id,name,unit,stock_quantity,reorder_level)
    values(v_branch_id,'Patties','pcs',patties_stock,low_stock) returning id into ingredient_patties;
  insert into public.inventory_movements(branch_id,ingredient_id,quantity_change,movement_type,note,created_by)
    values(v_branch_id,ingredient_buns,buns_stock,'opening','Imported from old POS',auth.uid());
  insert into public.inventory_movements(branch_id,ingredient_id,quantity_change,movement_type,note,created_by)
    values(v_branch_id,ingredient_patties,patties_stock,'opening','Imported from old POS',auth.uid());

  for burger in select value from jsonb_array_elements(legacy_state->'menu'->'burgers')
  loop
    if length(trim(coalesce(burger->>'name',''))) = 0 then continue; end if;
    item_name := trim(burger->>'name');
    bun_qty := 1;
    patty_qty := greatest(0,coalesce((burger->>'patties')::numeric,0));
    item_price := coalesce((burger->>'single')::numeric,0);
    insert into public.products(branch_id,name,price,track_inventory)
      values(v_branch_id,left(item_name||' - Single',120),item_price,true) returning id into product_id;
    insert into public.recipes(branch_id,product_id,ingredient_id,quantity)
      values(v_branch_id,product_id,ingredient_buns,bun_qty);
    if patty_qty > 0 then
      insert into public.recipes(branch_id,product_id,ingredient_id,quantity)
        values(v_branch_id,product_id,ingredient_patties,patty_qty);
    end if;
    imported_products := imported_products+1;

    item_price := coalesce((burger->>'b1t1')::numeric,0);
    insert into public.products(branch_id,name,price,track_inventory)
      values(v_branch_id,left(item_name||' - B1T1',120),item_price,true) returning id into product_id;
    insert into public.recipes(branch_id,product_id,ingredient_id,quantity)
      values(v_branch_id,product_id,ingredient_buns,2);
    if patty_qty > 0 then
      insert into public.recipes(branch_id,product_id,ingredient_id,quantity)
        values(v_branch_id,product_id,ingredient_patties,patty_qty*2);
    end if;
    imported_products := imported_products+1;
  end loop;

  for extra in select value from jsonb_array_elements(legacy_state->'menu'->'extras')
  loop
    if length(trim(coalesce(extra->>'name',''))) = 0 then continue; end if;
    item_name := trim(extra->>'name');
    item_price := coalesce((extra->>'price')::numeric,0);
    patty_qty := greatest(0,coalesce((extra->>'patties')::numeric,0));
    insert into public.products(branch_id,name,price,track_inventory)
      values(v_branch_id,left(item_name,120),item_price,patty_qty>0) returning id into product_id;
    if patty_qty > 0 then
      insert into public.recipes(branch_id,product_id,ingredient_id,quantity)
        values(v_branch_id,product_id,ingredient_patties,patty_qty);
    end if;
    imported_products := imported_products+1;
  end loop;

  insert into public.legacy_catalog_imports(branch_id,imported_by)
    values(v_branch_id,auth.uid());
  return jsonb_build_object(
    'products_imported',imported_products,
    'buns_stock',buns_stock,
    'patties_stock',patties_stock,
    'source','old_pos_menu_and_current_stock'
  );
end;
$$;

create or replace function public.create_pos_order(p_items jsonb, p_payment_method text, p_order_type text, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public, auth
as $$
declare
  v_branch_id uuid := public.current_branch_id();
  new_order_id uuid;
  order_total numeric(12,2) := 0;
  line jsonb;
  product_row public.products%rowtype;
  recipe_row record;
  line_quantity integer;
  line_total numeric(12,2);
  stock_delta numeric(14,3);
begin
  if v_branch_id is null or public.current_staff_role() not in ('owner_admin','manager','cashier') then
    raise exception 'You do not have permission to create orders';
  end if;
  if coalesce(jsonb_typeof(p_items),'') <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order must contain at least one item';
  end if;
  if p_payment_method not in ('cash','gcash','card') or p_order_type not in ('dine_in','takeout') then
    raise exception 'Invalid payment method or order type';
  end if;
  insert into public.sales_orders(branch_id,payment_method,order_type,notes,created_by)
    values(v_branch_id,p_payment_method,p_order_type,nullif(trim(coalesce(p_notes,'')),''),auth.uid())
    returning id into new_order_id;
  for line in select value from jsonb_array_elements(p_items)
  loop
    line_quantity := (line->>'quantity')::integer;
    if line_quantity < 1 or line_quantity > 99 then raise exception 'Invalid item quantity'; end if;
    select * into product_row from public.products
      where id=(line->>'product_id')::uuid and products.branch_id=v_branch_id and active
      for share;
    if not found then raise exception 'A selected product is unavailable'; end if;
    if product_row.track_inventory and not exists(select 1 from public.recipes where product_id=product_row.id and branch_id=v_branch_id) then
      raise exception 'Set up the recipe for % before selling it',product_row.name;
    end if;
    line_total := product_row.price * line_quantity;
    order_total := order_total + line_total;
    insert into public.sales_order_items(order_id,product_id,product_name,quantity,unit_price)
      values(new_order_id,product_row.id,product_row.name,line_quantity,product_row.price);
    for recipe_row in
      select r.ingredient_id,r.quantity,i.name as ingredient_name
      from public.recipes r join public.ingredients i on i.id=r.ingredient_id
      where r.product_id=product_row.id and r.branch_id=v_branch_id and i.active
      for update of i
    loop
      stock_delta := recipe_row.quantity * line_quantity;
      if (select stock_quantity from public.ingredients where id=recipe_row.ingredient_id) < stock_delta then
        raise exception 'Not enough % in stock to complete this order',recipe_row.ingredient_name;
      end if;
      update public.ingredients set stock_quantity=stock_quantity-stock_delta where id=recipe_row.ingredient_id;
      insert into public.inventory_movements(branch_id,ingredient_id,quantity_change,movement_type,reference_id,note,created_by)
        values(v_branch_id,recipe_row.ingredient_id,-stock_delta,'sale',new_order_id,'Order ingredient use',auth.uid());
    end loop;
  end loop;
  update public.sales_orders set total=order_total where id=new_order_id;
  return new_order_id;
end;
$$;

create or replace function public.set_kitchen_status(p_order_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public, auth
as $$
begin
  if public.current_branch_id() is null
     or public.current_staff_role() not in ('owner_admin','manager','cashier','kitchen') then
    raise exception 'You do not have permission to update kitchen status';
  end if;
  if p_status not in ('preparing','ready','served') then raise exception 'Invalid kitchen status'; end if;
  update public.sales_orders set status=p_status
    where id=p_order_id and branch_id=public.current_branch_id() and status <> 'void';
  if not found then raise exception 'Order not found or already void'; end if;
end;
$$;

create or replace function public.adjust_ingredient_stock(p_ingredient_id uuid, p_quantity_change numeric, p_movement_type text, p_note text default null)
returns void language plpgsql security definer set search_path = public, auth
as $$
begin
  if public.current_branch_id() is null
     or public.current_staff_role() not in ('owner_admin','manager','inventory') then
    raise exception 'You do not have permission to adjust inventory';
  end if;
  if p_quantity_change = 0 or p_movement_type not in ('opening','adjustment','waste') then
    raise exception 'Enter a non-zero quantity and valid movement type';
  end if;
  update public.ingredients set stock_quantity=stock_quantity+p_quantity_change
    where id=p_ingredient_id and branch_id=public.current_branch_id();
  if not found then raise exception 'Ingredient not found'; end if;
  insert into public.inventory_movements(branch_id,ingredient_id,quantity_change,movement_type,note,created_by)
    values(public.current_branch_id(),p_ingredient_id,p_quantity_change,p_movement_type,nullif(trim(coalesce(p_note,'')),''),auth.uid());
end;
$$;

create or replace function public.create_ingredient(
  p_name text, p_unit text, p_starting_stock numeric, p_reorder_level numeric, p_unit_cost numeric
)
returns uuid language plpgsql security definer set search_path = public, auth
as $$
declare
  v_branch_id uuid := public.current_branch_id();
  new_ingredient_id uuid;
begin
  if v_branch_id is null or public.current_staff_role() not in ('owner_admin','manager','inventory') then
    raise exception 'You do not have permission to add ingredients';
  end if;
  if length(trim(coalesce(p_name,''))) not between 1 and 120
     or length(trim(coalesce(p_unit,''))) not between 1 and 24
     or p_starting_stock < 0 or p_reorder_level < 0 or p_unit_cost < 0 then
    raise exception 'Enter valid ingredient details and non-negative stock/cost values';
  end if;
  insert into public.ingredients(branch_id,name,unit,stock_quantity,reorder_level,unit_cost)
    values(v_branch_id,trim(p_name),trim(p_unit),p_starting_stock,p_reorder_level,p_unit_cost)
    returning id into new_ingredient_id;
  if p_starting_stock > 0 then
    insert into public.inventory_movements(branch_id,ingredient_id,quantity_change,movement_type,note,created_by)
      values(v_branch_id,new_ingredient_id,p_starting_stock,'opening','Initial stock',auth.uid());
  end if;
  return new_ingredient_id;
end;
$$;

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
  if not exists(select 1 from public.products where id=p_product_id and branch_id=v_branch_id and active) then
    raise exception 'Product not found';
  end if;
  if coalesce(jsonb_typeof(p_items),'') <> 'array' or jsonb_array_length(p_items)=0 then
    raise exception 'Add at least one ingredient to the recipe';
  end if;
  for line in select value from jsonb_array_elements(p_items)
  loop
    item_ingredient_id := (line->>'ingredient_id')::uuid;
    item_quantity := (line->>'quantity')::numeric;
    if item_quantity <= 0 or not exists(
      select 1 from public.ingredients where id=item_ingredient_id and branch_id=v_branch_id and active
    ) then
      raise exception 'Recipe contains an invalid ingredient or quantity';
    end if;
  end loop;
  delete from public.recipes where product_id=p_product_id and branch_id=v_branch_id;
  for line in select value from jsonb_array_elements(p_items)
  loop
    insert into public.recipes(branch_id,product_id,ingredient_id,quantity)
      values(v_branch_id,p_product_id,(line->>'ingredient_id')::uuid,(line->>'quantity')::numeric);
  end loop;
end;
$$;

create or replace function public.create_purchase_order(p_supplier_id uuid, p_items jsonb, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public, auth
as $$
declare
  v_branch_id uuid := public.current_branch_id();
  new_order_id uuid;
  line jsonb;
  item_quantity numeric(14,3);
  item_cost numeric(12,4);
begin
  if v_branch_id is null or public.current_staff_role() not in ('owner_admin','manager','inventory') then
    raise exception 'You do not have permission to create purchase orders';
  end if;
  if not exists(select 1 from public.suppliers where id=p_supplier_id and suppliers.branch_id=v_branch_id) then
    raise exception 'Supplier not found';
  end if;
  if coalesce(jsonb_typeof(p_items),'') <> 'array' or jsonb_array_length(p_items)=0 then
    raise exception 'Purchase order must contain items';
  end if;
  insert into public.purchase_orders(branch_id,supplier_id,notes,created_by)
    values(v_branch_id,p_supplier_id,nullif(trim(coalesce(p_notes,'')),''),auth.uid())
    returning id into new_order_id;
  for line in select value from jsonb_array_elements(p_items)
  loop
    item_quantity := (line->>'quantity')::numeric;
    item_cost := (line->>'unit_cost')::numeric;
    if item_quantity <= 0 or item_cost < 0 then raise exception 'Invalid purchase quantity or cost'; end if;
    if not exists(select 1 from public.ingredients where id=(line->>'ingredient_id')::uuid and ingredients.branch_id=v_branch_id and active) then
      raise exception 'Ingredient not found';
    end if;
    insert into public.purchase_order_items(purchase_order_id,ingredient_id,quantity,unit_cost)
      values(new_order_id,(line->>'ingredient_id')::uuid,item_quantity,item_cost);
  end loop;
  return new_order_id;
end;
$$;

create or replace function public.receive_purchase_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = public, auth
as $$
declare
  purchase_row public.purchase_orders%rowtype;
  line record;
begin
  if public.current_branch_id() is null
     or public.current_staff_role() not in ('owner_admin','manager','inventory') then
    raise exception 'You do not have permission to receive purchases';
  end if;
  select * into purchase_row from public.purchase_orders
    where id=p_order_id and branch_id=public.current_branch_id() for update;
  if not found or purchase_row.status <> 'ordered' then raise exception 'Order is not awaiting receipt'; end if;
  for line in select * from public.purchase_order_items where purchase_order_id=p_order_id
  loop
    update public.ingredients set stock_quantity=stock_quantity+line.quantity,unit_cost=line.unit_cost
      where id=line.ingredient_id and branch_id=public.current_branch_id();
    insert into public.inventory_movements(branch_id,ingredient_id,quantity_change,movement_type,reference_id,note,created_by)
      values(public.current_branch_id(),line.ingredient_id,line.quantity,'purchase',p_order_id,'Purchase received',auth.uid());
  end loop;
  update public.purchase_orders set status='received',received_at=now() where id=p_order_id;
end;
$$;

alter table public.businesses enable row level security;
alter table public.branches enable row level security;
alter table public.staff_profiles enable row level security;
alter table public.products enable row level security;
alter table public.ingredients enable row level security;
alter table public.recipes enable row level security;
alter table public.suppliers enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.sales_orders enable row level security;
alter table public.sales_order_items enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.expenses enable row level security;

drop policy if exists "staff read own business" on public.businesses;
create policy "staff read own business" on public.businesses for select to authenticated
  using (id in (select business_id from public.staff_profiles where user_id=(select auth.uid()) and active));
drop policy if exists "admins update business" on public.businesses;
create policy "admins update business" on public.businesses for update to authenticated
  using (id in (select business_id from public.staff_profiles where user_id=(select auth.uid()) and active and role='owner_admin'))
  with check (id in (select business_id from public.staff_profiles where user_id=(select auth.uid()) and active and role='owner_admin'));

drop policy if exists "staff read own branch" on public.branches;
create policy "staff read own branch" on public.branches for select to authenticated
  using (id=public.current_branch_id());
drop policy if exists "managers update branch" on public.branches;
create policy "managers update branch" on public.branches for update to authenticated
  using (id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'))
  with check (id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'));

drop policy if exists "staff read branch profiles" on public.staff_profiles;
create policy "staff read branch profiles" on public.staff_profiles for select to authenticated
  using (branch_id=public.current_branch_id());
drop policy if exists "admins update staff profiles" on public.staff_profiles;
create policy "admins update staff profiles" on public.staff_profiles for update to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role()='owner_admin')
  with check (branch_id=public.current_branch_id() and public.current_staff_role()='owner_admin');

drop policy if exists "staff read products" on public.products;
create policy "staff read products" on public.products for select to authenticated using (branch_id=public.current_branch_id());
drop policy if exists "managers manage products" on public.products;
create policy "managers manage products" on public.products for all to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager','inventory'))
  with check (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager','inventory'));

drop policy if exists "staff read ingredients" on public.ingredients;
create policy "staff read ingredients" on public.ingredients for select to authenticated using (branch_id=public.current_branch_id());
drop policy if exists "inventory manage ingredients" on public.ingredients;
create policy "inventory manage ingredients" on public.ingredients for all to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager','inventory'))
  with check (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager','inventory'));

drop policy if exists "staff read recipes" on public.recipes;
create policy "staff read recipes" on public.recipes for select to authenticated using (branch_id=public.current_branch_id());
drop policy if exists "inventory manage recipes" on public.recipes;
create policy "inventory manage recipes" on public.recipes for all to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager','inventory'))
  with check (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager','inventory'));

drop policy if exists "staff read suppliers" on public.suppliers;
create policy "staff read suppliers" on public.suppliers for select to authenticated using (branch_id=public.current_branch_id());
drop policy if exists "inventory manage suppliers" on public.suppliers;
create policy "inventory manage suppliers" on public.suppliers for all to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager','inventory'))
  with check (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager','inventory'));

drop policy if exists "staff read purchases" on public.purchase_orders;
create policy "staff read purchases" on public.purchase_orders for select to authenticated using (branch_id=public.current_branch_id());
drop policy if exists "inventory create purchases" on public.purchase_orders;
create policy "inventory create purchases" on public.purchase_orders for insert to authenticated
  with check (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager','inventory') and created_by=(select auth.uid()));
drop policy if exists "staff read purchase items" on public.purchase_order_items;
create policy "staff read purchase items" on public.purchase_order_items for select to authenticated
  using (purchase_order_id in (select id from public.purchase_orders where branch_id=public.current_branch_id()));

drop policy if exists "staff read sales" on public.sales_orders;
create policy "staff read sales" on public.sales_orders for select to authenticated using (branch_id=public.current_branch_id());
drop policy if exists "staff read sale items" on public.sales_order_items;
create policy "staff read sale items" on public.sales_order_items for select to authenticated
  using (order_id in (select id from public.sales_orders where branch_id=public.current_branch_id()));

drop policy if exists "staff read inventory movements" on public.inventory_movements;
create policy "staff read inventory movements" on public.inventory_movements for select to authenticated
  using (branch_id=public.current_branch_id());

drop policy if exists "managers read expenses" on public.expenses;
create policy "managers read expenses" on public.expenses for select to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'));
drop policy if exists "managers create expenses" on public.expenses;
create policy "managers create expenses" on public.expenses for insert to authenticated
  with check (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager') and created_by=(select auth.uid()));

revoke all on public.businesses,public.branches,public.staff_profiles,public.products,public.ingredients,public.recipes,
  public.suppliers,public.purchase_orders,public.purchase_order_items,public.sales_orders,public.sales_order_items,
  public.inventory_movements,public.expenses from anon;
grant select,update on public.businesses,public.branches to authenticated;
grant select,update on public.staff_profiles to authenticated;
grant select,insert,update,delete on public.products,public.ingredients,public.recipes,public.suppliers to authenticated;
grant select,insert on public.purchase_orders to authenticated;
grant select on public.purchase_order_items,public.sales_orders,public.sales_order_items,public.inventory_movements to authenticated;
grant select,insert on public.expenses to authenticated;

revoke all on function public.bootstrap_business(text,text,text) from public;
revoke all on function public.create_pos_order(jsonb,text,text,text) from public;
revoke all on function public.import_legacy_pos_catalog() from public;
revoke all on function public.set_kitchen_status(uuid,text) from public;
revoke all on function public.adjust_ingredient_stock(uuid,numeric,text,text) from public;
revoke all on function public.create_ingredient(text,text,numeric,numeric,numeric) from public;
revoke all on function public.save_product_recipe(uuid,jsonb) from public;
revoke all on function public.create_purchase_order(uuid,jsonb,text) from public;
revoke all on function public.receive_purchase_order(uuid) from public;
grant execute on function public.bootstrap_business(text,text,text) to authenticated;
grant execute on function public.create_pos_order(jsonb,text,text,text) to authenticated;
grant execute on function public.import_legacy_pos_catalog() to authenticated;
grant execute on function public.set_kitchen_status(uuid,text) to authenticated;
grant execute on function public.adjust_ingredient_stock(uuid,numeric,text,text) to authenticated;
grant execute on function public.create_ingredient(text,text,numeric,numeric,numeric) to authenticated;
grant execute on function public.save_product_recipe(uuid,jsonb) to authenticated;
grant execute on function public.create_purchase_order(uuid,jsonb,text) to authenticated;
grant execute on function public.receive_purchase_order(uuid) to authenticated;

notify pgrst, 'reload schema';
