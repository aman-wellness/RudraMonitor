-- 0020_dlp_invoice_addon.sql
-- Extend create_invoice_for_license to add a DLP add-on line item:
--   (count of agents with dlp_enabled=true) × plans.dlp_addon_price_inr

create or replace function public.create_invoice_for_license(
  p_license_id    uuid,
  p_due_days      int default 7,
  p_notes         text default null
)
returns table(invoice_id uuid, invoice_number text, total_inr numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_caller         uuid := auth.uid();
  v_caller_role    text;
  v_caller_partner uuid;
  v_lic            record;
  v_plan           record;
  v_amount         numeric(10,2);
  v_dlp_count      int;
  v_dlp_addon      numeric(10,2);
  v_subtotal       numeric(10,2);
  v_gst            numeric(10,2);
  v_total          numeric(10,2);
  v_commission     numeric(10,2);
  v_inv_id         uuid;
  v_inv_num        text;
  v_notes_full     text;
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

  -- DLP add-on: count agents with dlp_enabled in this org × per-agent price
  select count(*) into v_dlp_count
  from public.agents
  where org_id = v_lic.organization_id and dlp_enabled = true;
  v_dlp_addon := coalesce(v_plan.dlp_addon_price_inr, 0) * coalesce(v_dlp_count, 0);

  v_subtotal := v_amount + v_dlp_addon;
  v_gst := round(v_subtotal * 0.18, 2);
  v_total := v_subtotal + v_gst;

  v_commission := case
    when v_lic.partner_id is null then 0
    else round(v_subtotal * coalesce(
        (select commission_pct from public.partners where id = v_lic.partner_id), 0
      ) / 100.0, 2)
  end;

  -- Append the add-on detail to the notes so the customer can see what they're charged for
  v_notes_full := coalesce(p_notes, '') ||
    case when v_dlp_count > 0
         then format(E'\nDLP add-on: %s agent(s) × ₹%s = ₹%s',
                     v_dlp_count, v_plan.dlp_addon_price_inr, v_dlp_addon)
         else ''
    end;

  v_inv_num := public.next_invoice_number();
  insert into public.invoices (
    invoice_number, organization_id, partner_id, license_id, plan_id,
    amount_inr, gst_pct, gst_amount_inr, total_inr,
    partner_commission_inr, status, due_at, notes
  ) values (
    v_inv_num, v_lic.organization_id, v_lic.partner_id, v_lic.id, v_lic.plan_id,
    v_subtotal,                              -- amount = plan + DLP add-on
    18.00, v_gst, v_total,
    v_commission, 'pending',
    now() + (p_due_days || ' days')::interval,
    nullif(v_notes_full, '')
  )
  returning id into v_inv_id;

  insert into public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  values (v_caller, v_caller_role, 'invoice.create', 'invoice', v_inv_id,
          jsonb_build_object(
            'license_id', p_license_id,
            'plan_amount', v_amount,
            'dlp_addon', v_dlp_addon,
            'dlp_agents', v_dlp_count,
            'total', v_total
          ));

  return query select v_inv_id, v_inv_num, v_total;
end $$;
