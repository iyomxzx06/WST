-- Operations controls: audit trail, cashier closing, wastage, and order voids.
-- Additive only. Existing orders, payments, stock, and users are preserved.

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  actor_id uuid not null references auth.users(id),
  action text not null check (length(trim(action)) between 1 and 80),
  entity_type text not null check (length(trim(entity_type)) between 1 and 80),
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_branch_created_at_idx
  on public.audit_logs(branch_id,created_at desc);

create table if not exists public.cashier_closings (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  closed_by uuid not null references auth.users(id),
  business_date date not null,
  expected_cash numeric(12,2) not null check (expected_cash >= 0),
  actual_cash numeric(12,2) not null check (actual_cash >= 0),
  difference numeric(12,2) generated always as (actual_cash - expected_cash) stored,
  notes text,
  created_at timestamptz not null default now(),
  unique(branch_id,business_date,closed_by)
);

create index if not exists cashier_closings_branch_date_idx
  on public.cashier_closings(branch_id,business_date desc);

alter table public.audit_logs enable row level security;
alter table public.cashier_closings enable row level security;

drop policy if exists "managers read audit logs" on public.audit_logs;
create policy "managers read audit logs" on public.audit_logs for select to authenticated
  using (branch_id=public.current_branch_id() and public.current_staff_role() in ('owner_admin','manager'));

drop policy if exists "staff read cashier closings" on public.cashier_closings;
create policy "staff read cashier closings" on public.cashier_closings for select to authenticated
  using (branch_id=public.current_branch_id() and (closed_by=auth.uid() or public.current_staff_role() in ('owner_admin','manager')));

revoke all on public.audit_logs,public.cashier_closings from public,anon,authenticated;
grant select on public.audit_logs,public.cashier_closings to authenticated;

create or replace function public.write_audit_log(
  p_action text,p_entity_type text,p_entity_id uuid default null,p_details jsonb default '{}'::jsonb
)
returns uuid language plpgsql security definer set search_path = public, auth
as $$
declare v_branch_id uuid; v_id uuid;
begin
  v_branch_id:=public.current_branch_id();
  if v_branch_id is null or public.current_staff_role() is null then
    raise exception 'You are not assigned to an active branch';
  end if;
  insert into public.audit_logs(branch_id,actor_id,action,entity_type,entity_id,details)
  values(v_branch_id,auth.uid(),trim(p_action),trim(p_entity_type),p_entity_id,coalesce(p_details,'{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.record_inventory_waste(
  p_ingredient_id uuid,p_quantity numeric,p_note text
)
returns void language plpgsql security definer set search_path = public, auth
as $$
declare v_branch_id uuid; v_role text; v_stock numeric; v_name text;
begin
  v_branch_id:=public.current_branch_id(); v_role:=public.current_staff_role();
  if v_branch_id is null or v_role not in ('owner_admin','manager') then
    raise exception 'Only an Owner/Admin or Manager can record wastage';
  end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Waste quantity must be greater than zero'; end if;
  select stock_quantity,name into v_stock,v_name from public.ingredients
    where id=p_ingredient_id and branch_id=v_branch_id and active for update;
  if not found then raise exception 'Ingredient not found'; end if;
  if v_stock < p_quantity then raise exception 'Waste quantity exceeds current stock'; end if;
  update public.ingredients set stock_quantity=stock_quantity-p_quantity where id=p_ingredient_id;
  insert into public.inventory_movements(branch_id,ingredient_id,quantity_change,movement_type,note,created_by)
    values(v_branch_id,p_ingredient_id,-p_quantity,'waste',nullif(trim(coalesce(p_note,'')),''),auth.uid());
  perform public.write_audit_log('record_waste','ingredient',p_ingredient_id,
    jsonb_build_object('ingredient',v_name,'quantity',p_quantity,'note',nullif(trim(coalesce(p_note,'')),'')));
end;
$$;

create or replace function public.void_sales_order(p_order_id uuid,p_reason text)
returns void language plpgsql security definer set search_path = public, auth
as $$
declare v_branch_id uuid; v_role text; v_status text; v_number bigint; v_total numeric;
begin
  v_branch_id:=public.current_branch_id(); v_role:=public.current_staff_role();
  if v_branch_id is null or v_role not in ('owner_admin','manager') then
    raise exception 'Only an Owner/Admin or Manager can void orders';
  end if;
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'A void reason is required'; end if;
  select status,order_number,total into v_status,v_number,v_total from public.sales_orders
    where id=p_order_id and branch_id=v_branch_id for update;
  if not found then raise exception 'Order not found'; end if;
  if v_status='void' then raise exception 'This order is already void'; end if;
  update public.sales_orders set status='void' where id=p_order_id;
  perform public.write_audit_log('void_order','sales_order',p_order_id,
    jsonb_build_object('order_number',v_number,'total',v_total,'previous_status',v_status,'reason',trim(p_reason)));
end;
$$;

create or replace function public.close_cashier_day(
  p_business_date date,p_actual_cash numeric,p_notes text default null
)
returns jsonb language plpgsql security definer set search_path = public, auth
as $$
declare v_branch_id uuid; v_role text; v_start timestamptz; v_end timestamptz;
  v_expected numeric(12,2); v_id uuid; v_difference numeric(12,2);
begin
  v_branch_id:=public.current_branch_id(); v_role:=public.current_staff_role();
  if v_branch_id is null or v_role not in ('owner_admin','manager','cashier') then
    raise exception 'You do not have permission to close the cashier day';
  end if;
  if p_business_date is null or p_actual_cash is null or p_actual_cash<0 then raise exception 'Enter a valid closing date and cash amount'; end if;
  v_start:=(p_business_date::text||' 00:00:00+08')::timestamptz;
  v_end:=((p_business_date+1)::text||' 00:00:00+08')::timestamptz;
  select coalesce(sum(p.amount),0) into v_expected
    from public.payments p
    where p.branch_id=v_branch_id and p.payment_method='cash' and p.recorded_at>=v_start and p.recorded_at<v_end;
  v_expected:=v_expected-coalesce((select sum(r.amount) from public.payment_refunds r
    join public.payments rp on rp.id=r.payment_id
    where rp.branch_id=v_branch_id and rp.payment_method='cash' and r.created_at>=v_start and r.created_at<v_end),0);
  v_expected:=greatest(v_expected,0);
  insert into public.cashier_closings(branch_id,closed_by,business_date,expected_cash,actual_cash,notes)
    values(v_branch_id,auth.uid(),p_business_date,v_expected,p_actual_cash,nullif(trim(coalesce(p_notes,'')),''))
    returning id,difference into v_id,v_difference;
  perform public.write_audit_log('close_cashier_day','cashier_closing',v_id,
    jsonb_build_object('business_date',p_business_date,'expected_cash',v_expected,'actual_cash',p_actual_cash,'difference',v_difference));
  return jsonb_build_object('id',v_id,'expected_cash',v_expected,'actual_cash',p_actual_cash,'difference',v_difference);
end;
$$;

revoke all on function public.write_audit_log(text,text,uuid,jsonb) from public,anon;
revoke all on function public.record_inventory_waste(uuid,numeric,text) from public,anon;
revoke all on function public.void_sales_order(uuid,text) from public,anon;
revoke all on function public.close_cashier_day(date,numeric,text) from public,anon;
grant execute on function public.record_inventory_waste(uuid,numeric,text) to authenticated;
grant execute on function public.void_sales_order(uuid,text) to authenticated;
grant execute on function public.close_cashier_day(date,numeric,text) to authenticated;
