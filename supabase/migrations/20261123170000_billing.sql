-- Stripe billing state and API keys (src/lib/billing/*, src/lib/accounts/data.ts billing and API key methods).
--
-- The stored state of a customer is what Retrofit last read from Stripe, with the time the read started
-- (state_at). An older read never replaces a newer one, so webhooks that arrive late or out of order
-- cannot bring an old state back. A read that starts after a change sees it, and every change sends an
-- event whose handler reads after it, so the last event leaves the latest state.
--
-- apply_billing_event records a Stripe event and applies its state in one transaction: an event is
-- applied at most once, and a failure records nothing, so Stripe's redelivery applies it. An event for
-- a customer without a row (a deleted account, or a customer of another product) records nothing and
-- creates no row.
--
-- Lock order: stripe_events, then billing_customers. delete_account_data and the auth user's deletion
-- (cascade) touch only billing_customers of the two, so they never deadlock with these functions.
--
-- Access contract, as for delete_account_data: security invoker with an empty search_path,
-- EXECUTE for service_role only.

alter table public.billing_customers
  add column subscription_id text
    constraint billing_customers_subscription check (subscription_id ~ '^sub_[A-Za-z0-9_]{1,200}$'),
  add column cancel_at_period_end boolean not null default false,
  -- When the stored state was read from Stripe; null before the first read.
  add column state_at timestamptz,
  add constraint billing_customers_status check (status ~ '^[a-z_]{1,40}$'),
  add constraint billing_customers_customer check (stripe_customer_id ~ '^cus_[A-Za-z0-9_]{1,200}$');

alter table public.api_keys
  -- The key's last four characters, so its owner can tell keys apart.
  add column hint text
    constraint api_keys_hint check (hint ~ '^[0-9a-f]{4}$');

create function public.billing_json(b public.billing_customers)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'account_id', b.account_id, 'stripe_customer_id', b.stripe_customer_id, 'plan', b.plan, 'status', b.status,
    'current_period_end', b.current_period_end, 'cancel_at_period_end', b.cancel_at_period_end,
    'subscription_id', b.subscription_id, 'state_at', b.state_at);
$$;

-- One customer per account and one account per customer. The unique constraints decide a race.
create function public.link_billing_customer(p_account_id uuid, p_customer_id text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.billing_customers;
begin
  if p_account_id is null or p_customer_id is null then
    raise exception 'link_billing_customer: every argument is required' using errcode = '22004';
  end if;
  begin
    insert into public.billing_customers (account_id, stripe_customer_id) values (p_account_id, p_customer_id)
    on conflict do nothing
    returning * into v_row;
  exception
    -- The account was deleted meanwhile: no row is created for it.
    when foreign_key_violation then
      return pg_catalog.jsonb_build_object('outcome', 'no_account');
  end;
  if v_row.account_id is not null then
    return pg_catalog.jsonb_build_object('outcome', 'linked', 'billing', public.billing_json(v_row));
  end if;
  select * into v_row from public.billing_customers b where b.account_id = p_account_id;
  if found then
    return pg_catalog.jsonb_build_object('outcome', 'existing', 'billing', public.billing_json(v_row));
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'taken');
end;
$$;

create function public.apply_billing_state(
  p_customer_id text, p_plan text, p_status text, p_current_period_end timestamptz, p_cancel_at_period_end boolean,
  p_subscription_id text, p_observed_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.billing_customers;
begin
  if p_customer_id is null or p_plan is null or p_status is null or p_cancel_at_period_end is null or p_observed_at is null then
    raise exception 'apply_billing_state: a required argument is null' using errcode = '22004';
  end if;
  select * into v_row from public.billing_customers b where b.stripe_customer_id = p_customer_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'unknown');
  end if;
  if v_row.state_at > p_observed_at then
    return pg_catalog.jsonb_build_object('outcome', 'stale', 'billing', public.billing_json(v_row));
  end if;
  update public.billing_customers b
  set plan = p_plan, status = p_status, current_period_end = p_current_period_end, cancel_at_period_end = p_cancel_at_period_end,
      subscription_id = p_subscription_id, state_at = p_observed_at, updated_at = pg_catalog.now()
  where b.account_id = v_row.account_id
  returning * into v_row;
  return pg_catalog.jsonb_build_object('outcome', 'applied', 'billing', public.billing_json(v_row));
end;
$$;

create function public.apply_billing_event(
  p_event_id text, p_type text,
  p_customer_id text, p_plan text, p_status text, p_current_period_end timestamptz, p_cancel_at_period_end boolean,
  p_subscription_id text, p_observed_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_answer jsonb;
begin
  if p_event_id is null or p_type is null then
    raise exception 'apply_billing_event: the event id and type are required' using errcode = '22004';
  end if;
  if not exists (select 1 from public.billing_customers b where b.stripe_customer_id = p_customer_id) then
    return pg_catalog.jsonb_build_object('outcome', 'unknown');
  end if;
  -- A concurrent delivery of the same event waits here for the first one's transaction.
  insert into public.stripe_events (event_id, type) values (p_event_id, p_type) on conflict do nothing;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'duplicate');
  end if;
  v_answer := public.apply_billing_state(p_customer_id, p_plan, p_status, p_current_period_end, p_cancel_at_period_end, p_subscription_id, p_observed_at);
  -- The row went away between the check and the update (a deletion): the event is not recorded either.
  if v_answer ->> 'outcome' = 'unknown' then
    delete from public.stripe_events e where e.event_id = p_event_id;
  end if;
  return v_answer;
end;
$$;

-- At most p_max active keys per account; one account's creations run one at a time.
create function public.create_api_key(p_account_id uuid, p_key_hash text, p_hint text, p_max integer)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.api_keys;
begin
  if p_account_id is null or p_key_hash is null or p_hint is null or p_max is null then
    raise exception 'create_api_key: every argument is required' using errcode = '22004';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('create_api_key:' || p_account_id::text, 0));
  if (select count(*) from public.api_keys k where k.account_id = p_account_id and k.revoked_at is null) >= p_max then
    return pg_catalog.jsonb_build_object('outcome', 'full');
  end if;
  insert into public.api_keys (account_id, key_hash, hint) values (p_account_id, p_key_hash, p_hint) returning * into v_row;
  return pg_catalog.jsonb_build_object('outcome', 'created', 'id', v_row.id, 'hint', v_row.hint, 'created_at', v_row.created_at);
end;
$$;

revoke all on function public.billing_json(public.billing_customers) from public, anon, authenticated;
revoke all on function public.link_billing_customer(uuid, text) from public, anon, authenticated;
revoke all on function public.apply_billing_state(text, text, text, timestamptz, boolean, text, timestamptz) from public, anon, authenticated;
revoke all on function public.apply_billing_event(text, text, text, text, text, timestamptz, boolean, text, timestamptz) from public, anon, authenticated;
revoke all on function public.create_api_key(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.billing_json(public.billing_customers) to service_role;
grant execute on function public.link_billing_customer(uuid, text) to service_role;
grant execute on function public.apply_billing_state(text, text, text, timestamptz, boolean, text, timestamptz) to service_role;
grant execute on function public.apply_billing_event(text, text, text, text, text, timestamptz, boolean, text, timestamptz) to service_role;
grant execute on function public.create_api_key(uuid, text, text, integer) to service_role;
