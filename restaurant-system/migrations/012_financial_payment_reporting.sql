begin;

do $$
begin
  if to_regclass('public.online_orders') is null
     or to_regclass('public.payments') is null
     or to_regprocedure('public.create_pos_order(jsonb,text,text,text,uuid,numeric,text)') is null then
    raise exception 'Run migrations 001 and 009 before migration 012';
  end if;
end;
$$;

create table if not exists public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  reason text not null check (length(trim(reason)) between 1 and 500),
  recorded_by uuid not null references auth.users(id),
  recorded_at timestamptz not null default now()
);

create index if not exists payment_refunds_branch_recorded_at_idx
  on public.payment_refunds(branch_id,recorded_at desc);
create index if not exists payment_refunds_payment_id_idx
  on public.payment_refunds(payment_id);
create index if not exists payment_refunds_payment_recorded_at_idx
  on public.payment_refunds(payment_id,recorded_at desc);
create index if not exists payments_branch_recorded_at_idx
  on public.payments(branch_id,recorded_at desc);

alter table public.payment_refunds enable row level security;
revoke all on public.payment_refunds from public,anon,authenticated;
grant select on public.payment_refunds to authenticated;

drop policy if exists "managers read branch payment refunds" on public.payment_refunds;
create policy "managers read branch payment refunds" on public.payment_refunds
  for select to authenticated
  using (
    branch_id=public.current_branch_id()
    and public.current_staff_role() in ('owner_admin','manager')
  );

create or replace function public.record_online_order_payment(
  p_order_id uuid,
  p_payment_method text,
  p_amount_tendered numeric default null,
  p_external_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_branch_id uuid := public.current_branch_id();
  v_role text := public.current_staff_role();
  v_total numeric(12,2);
  v_payment_id uuid;
  v_change_due numeric(12,2) := 0;
begin
  if v_branch_id is null or v_role not in ('owner_admin','manager','cashier') then
    raise exception 'You do not have permission to record online order payments';
  end if;
  if coalesce(p_payment_method,'') not in ('cash','gcash','card')
     or length(coalesce(p_external_reference,'')) > 120 then
    raise exception 'Enter a valid payment method and reference';
  end if;
  if p_payment_method='cash' and nullif(trim(coalesce(p_external_reference,'')),'') is not null then
    raise exception 'A cash payment cannot have an external reference';
  end if;
  if p_payment_method<>'cash' and p_amount_tendered is not null then
    raise exception 'Tendered amount is only valid for cash';
  end if;

  select s.total into v_total
  from public.sales_orders s
  join public.online_orders o
    on o.sales_order_id=s.id and o.branch_id=s.branch_id
  where s.id=p_order_id
    and s.branch_id=v_branch_id
    and s.status<>'void'
    and o.status='accepted'
  for update of s;
  if not found then
    raise exception 'Accepted online order not found or already void';
  end if;

  if exists(select 1 from public.payments where order_id=p_order_id) then
    raise exception 'Payment has already been recorded for this order';
  end if;

  if p_payment_method='cash' then
    if p_amount_tendered is null or p_amount_tendered<v_total then
      raise exception 'Cash received must be at least the order total';
    end if;
    v_change_due := p_amount_tendered-v_total;
  end if;

  insert into public.payments(
    branch_id,order_id,payment_method,amount,amount_tendered,change_due,external_reference,recorded_by
  ) values (
    v_branch_id,p_order_id,p_payment_method,v_total,p_amount_tendered,v_change_due,
    nullif(trim(coalesce(p_external_reference,'')),''),auth.uid()
  )
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;

revoke all on function public.record_online_order_payment(uuid,text,numeric,text) from public,anon;
grant execute on function public.record_online_order_payment(uuid,text,numeric,text) to authenticated;

create or replace function public.record_payment_refund(
  p_order_id uuid,
  p_amount numeric,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_branch_id uuid := public.current_branch_id();
  v_role text := public.current_staff_role();
  v_payment_id uuid;
  v_payment_amount numeric(12,2);
  v_refunded_amount numeric(12,2);
  v_refund_id uuid;
begin
  if v_branch_id is null or v_role not in ('owner_admin','manager') then
    raise exception 'Only an Owner/Admin or Manager can record a refund';
  end if;
  if p_amount is null or p_amount<=0
     or length(trim(coalesce(p_reason,''))) not between 1 and 500 then
    raise exception 'Enter a positive refund amount and reason';
  end if;

  select p.id,p.amount
  into v_payment_id,v_payment_amount
  from public.payments p
  where p.order_id=p_order_id and p.branch_id=v_branch_id
  for update;
  if not found then
    raise exception 'Payment not found for this branch';
  end if;

  select coalesce(sum(r.amount),0) into v_refunded_amount
  from public.payment_refunds r
  where r.payment_id=v_payment_id;
  if p_amount>v_payment_amount-v_refunded_amount then
    raise exception 'Refund amount exceeds the remaining refundable balance';
  end if;

  insert into public.payment_refunds(branch_id,payment_id,amount,reason,recorded_by)
  values(v_branch_id,v_payment_id,p_amount,trim(p_reason),auth.uid())
  returning id into v_refund_id;

  return v_refund_id;
end;
$$;

revoke all on function public.record_payment_refund(uuid,numeric,text) from public,anon;
grant execute on function public.record_payment_refund(uuid,numeric,text) to authenticated;

create or replace function public.get_operational_report(
  p_start timestamptz,
  p_end timestamptz,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_branch_id uuid := public.current_branch_id();
  order_summary jsonb;
  payment_summary jsonb;
  outstanding_summary jsonb;
  expense_summary jsonb;
begin
  if v_branch_id is null or public.current_staff_role() not in ('owner_admin','manager') then
    raise exception 'You do not have permission to view reports';
  end if;
  if p_start is null or p_end is null or p_start>=p_end
     or p_start_date is null or p_end_date is null or p_start_date>=p_end_date then
    raise exception 'Enter a valid report date range';
  end if;

  select jsonb_build_object(
    'order_count',count(*) filter (where status<>'void'),
    'void_count',count(*) filter (where status='void'),
    'recorded_order_value',coalesce(sum(total) filter (where status<>'void'),0)
  ) into order_summary
  from public.sales_orders
  where branch_id=v_branch_id and created_at>=p_start and created_at<p_end;

  with payment_rows as (
    select p.id,p.payment_method,p.amount,p.recorded_at,s.status as order_status,
      coalesce(sum(r.amount) filter (
        where r.recorded_at>=p_start and r.recorded_at<p_end
      ),0) as refunded_in_range,
      coalesce(sum(r.amount),0) as refunded_total
    from public.payments p
    join public.sales_orders s on s.id=p.order_id and s.branch_id=p.branch_id
    left join public.payment_refunds r on r.payment_id=p.id
    where p.branch_id=v_branch_id
      and (
        (p.recorded_at>=p_start and p.recorded_at<p_end)
        or exists(
          select 1 from public.payment_refunds period_refund
          where period_refund.payment_id=p.id
            and period_refund.recorded_at>=p_start and period_refund.recorded_at<p_end
        )
      )
    group by p.id,p.payment_method,p.amount,p.recorded_at,s.status
  )
  select jsonb_build_object(
    'payment_count',count(*) filter (
      where recorded_at>=p_start and recorded_at<p_end
    ),
    'payments_collected',coalesce(sum(amount) filter (
      where recorded_at>=p_start and recorded_at<p_end
    ),0),
    'refunds_issued',coalesce(sum(refunded_in_range),0),
    'net_collected',
      coalesce(sum(amount) filter (where recorded_at>=p_start and recorded_at<p_end),0)
      - coalesce(sum(refunded_in_range),0),
    'cash_collected',coalesce(sum(amount) filter (
      where payment_method='cash' and recorded_at>=p_start and recorded_at<p_end
    ),0),
    'gcash_collected',coalesce(sum(amount) filter (
      where payment_method='gcash' and recorded_at>=p_start and recorded_at<p_end
    ),0),
    'card_collected',coalesce(sum(amount) filter (
      where payment_method='card' and recorded_at>=p_start and recorded_at<p_end
    ),0),
    'cash_refunded',coalesce(sum(refunded_in_range) filter (where payment_method='cash'),0),
    'gcash_refunded',coalesce(sum(refunded_in_range) filter (where payment_method='gcash'),0),
    'card_refunded',coalesce(sum(refunded_in_range) filter (where payment_method='card'),0),
    'voided_collected',coalesce(sum(amount) filter (
      where order_status='void' and recorded_at>=p_start and recorded_at<p_end
    ),0),
    'voided_refunded',coalesce(sum(refunded_in_range) filter (where order_status='void'),0),
    'voided_unreturned_amount',coalesce(sum(amount-refunded_total) filter (
      where order_status='void' and recorded_at>=p_start and recorded_at<p_end
    ),0)
  ) into payment_summary
  from payment_rows;

  select jsonb_build_object(
    'unpaid_order_count',count(*),
    'amount',coalesce(sum(s.total),0)
  ) into outstanding_summary
  from public.online_orders o
  join public.sales_orders s on s.id=o.sales_order_id and s.branch_id=o.branch_id
  where o.branch_id=v_branch_id
    and o.status='accepted'
    and s.status<>'void'
    and not exists(select 1 from public.payments p where p.order_id=s.id);

  select jsonb_build_object(
    'expense_count',count(*),
    'total',coalesce(sum(amount),0)
  ) into expense_summary
  from public.expenses
  where branch_id=v_branch_id and spent_at>=p_start_date and spent_at<p_end_date;

  return jsonb_build_object(
    'orders',order_summary,
    'payments',payment_summary,
    'outstanding',outstanding_summary,
    'expenses',expense_summary
  );
end;
$$;

revoke all on function public.get_operational_report(timestamptz,timestamptz,date,date) from public,anon;
grant execute on function public.get_operational_report(timestamptz,timestamptz,date,date) to authenticated;

notify pgrst,'reload schema';
commit;
