-- 0015_billing_rpcs.sql
-- Razorpay billing helpers:
--   - create_invoice_for_license: creates a pending invoice (super-admin or partner-of-license)
--   - mark_invoice_paid:          called by webhook only (security definer, locked-down)
--   - extend_license_on_payment:  bumps expires_at by plan billing_cycle, sets status=active

-- ---------------------------------------------------------------------------
-- 1. Invoice creation (manual — by super-admin or partner)
-- ---------------------------------------------------------------------------
create or replace function public.create_invoice_for_license(
  p_license_id    uuid,
  p_due_days      int default 7,
  p_notes         text default null
)
returns table(invoice_id uuid, invoice_number text, total_inr numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_caller       uuid := auth.uid();
  v_caller_role  text;
  v_caller_partner uuid;
  v_lic          record;
  v_plan         record;
  v_amount       numeric(10,2);
  v_gst          numeric(10,2);
  v_total        numeric(10,2);
  v_commission   numeric(10,2);
  v_inv_id       uuid;
  v_inv_num      text;
begin
  if v_caller is null then raise exception 'unauthenticated' using errcode = '42501'; end if;

  select app_role, partner_id into v_caller_role, v_caller_partner
  from public.app_users where user_id = v_caller;

  select l.*, o.partner_id as org_partner from public.licenses l
    join public.organizations o on o.id = l.organization_id
    where l.id = p_license_id into v_lic;
  if not found then raise exception 'license not found' using errcode = 'P0002'; end if;

  if v_caller_role = 'partner' then
    if v_lic.partner_id is null or v_lic.partner_id <> v_caller_partner then
      raise exception 'forbidden: license not yours' using errcode = '42501';
    end if;
  elsif v_caller_role <> 'super_admin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_plan from public.plans where id = v_lic.plan_id;
  v_amount := v_plan.price_inr;
  v_gst := round(v_amount * 0.18, 2);
  v_total := v_amount + v_gst;
  v_commission := case
    when v_lic.partner_id is null then 0
    else round(v_amount * coalesce(
        (select commission_pct from public.partners where id = v_lic.partner_id), 0
      ) / 100.0, 2)
  end;

  v_inv_num := public.next_invoice_number();
  insert into public.invoices (
    invoice_number, organization_id, partner_id, license_id, plan_id,
    amount_inr, gst_pct, gst_amount_inr, total_inr,
    partner_commission_inr, status, due_at, notes
  ) values (
    v_inv_num, v_lic.organization_id, v_lic.partner_id, v_lic.id, v_lic.plan_id,
    v_amount, 18.00, v_gst, v_total,
    v_commission, 'pending', now() + (p_due_days || ' days')::interval, p_notes
  )
  returning id into v_inv_id;

  insert into public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  values (v_caller, v_caller_role, 'invoice.create', 'invoice', v_inv_id,
          jsonb_build_object('license_id', p_license_id, 'total', v_total));

  return query select v_inv_id, v_inv_num, v_total;
end $$;

revoke all on function public.create_invoice_for_license(uuid, int, text) from public;
grant execute on function public.create_invoice_for_license(uuid, int, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Mark invoice paid (called by webhook via service role only)
-- ---------------------------------------------------------------------------
-- NOTE: this is intentionally not granted to authenticated; only the service role
-- (used by the razorpay-webhook edge function) can execute it.
create or replace function public.mark_invoice_paid(
  p_invoice_id          uuid,
  p_razorpay_order_id   text,
  p_razorpay_payment_id text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_inv record;
  v_lic record;
  v_plan record;
  v_new_expiry timestamptz;
begin
  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then raise exception 'invoice not found' using errcode = 'P0002'; end if;
  if v_inv.status = 'paid' then return; end if;  -- idempotent

  update public.invoices
    set status = 'paid',
        paid_at = now(),
        razorpay_order_id = coalesce(p_razorpay_order_id, razorpay_order_id),
        razorpay_payment_id = coalesce(p_razorpay_payment_id, razorpay_payment_id)
    where id = p_invoice_id;

  -- Extend the linked license by one billing cycle
  if v_inv.license_id is not null then
    select * into v_lic from public.licenses where id = v_inv.license_id;
    select * into v_plan from public.plans where id = v_lic.plan_id;
    v_new_expiry := case
      when v_plan.billing_cycle = 'yearly'  then greatest(v_lic.expires_at, now()) + interval '1 year'
      else                                       greatest(v_lic.expires_at, now()) + interval '1 month'
    end;
    update public.licenses
      set status = 'active', expires_at = v_new_expiry
      where id = v_inv.license_id;
  end if;

  insert into public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  values (null, 'system', 'invoice.paid', 'invoice', p_invoice_id,
          jsonb_build_object('payment_id', p_razorpay_payment_id, 'order_id', p_razorpay_order_id));
end $$;

revoke all on function public.mark_invoice_paid(uuid, text, text) from public;
-- (no grant — service role bypasses RLS and grants)
