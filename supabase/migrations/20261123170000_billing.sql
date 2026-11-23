-- Stripe billing state and API keys (src/lib/billing/*, src/lib/accounts/data.ts billing and API key methods).
--
-- The stored state of a customer is what Retrofit last read from Stripe, with the time the read started
-- (state_at). An older read never replaces a newer one, so webhooks that arrive late or out of order
-- cannot bring an old state back. A read that starts after a change sees it, and every change sends an
-- event whose handler reads after it, so the last event leaves the latest state.
--
-- apply_billing_event records a Stripe event and applies its state in one transaction: an event is
-- applied at most once, and a failure records nothing, so Stripe's redelivery applies it. An event that
-- applied nothing (an older read, or a customer without a row) is not recorded, so reading Stripe again
-- can still apply it, and it creates no row.
--
-- deleted_customers is the only proof that a customer without a row belongs to a deleted account:
-- delete_account_data writes it in the transaction that deletes the row. A missing row alone proves
-- nothing (a restored database, another project), so nothing is ever cancelled for it. The table keeps a
-- hash of the customer id and the time, no account and no address. Linking a customer removes its mark.
-- A customer is linked only to an account with a profile, under the profile's lock, and the deletion
-- deletes the profile first: a link in progress is waited for and marked, a later one finds no account.
--
-- Lock order: account_profiles, then site_claims, published_sites (as in *_publishing.sql), then
-- billing_customers; stripe_events, then billing_customers. So these functions never deadlock.
--
-- Access contract, as for delete_account_data: security invoker with an empty search_path,
-- EXECUTE for service_role only.

alter table public.billing_customers
  add column subscription_id text
    constraint billing_customers_subscription check (subscription_id ~ '^sub_[A-Za-z0-9_]{1,200}$'),
  add column cancel_at_period_end boolean not null default false,
  -- While past due: the start of the first unpaid period. Kept while the same subscription stays past due.
  add column unpaid_since timestamptz,
  -- When the stored state was read from Stripe; null before the first read.
  add column state_at timestamptz,
  add constraint billing_customers_status check (status ~ '^[a-z_]{1,40}$'),
  add constraint billing_customers_customer check (stripe_customer_id ~ '^cus_[A-Za-z0-9_]{1,200}$');

create table public.deleted_customers (
  customer_hash text primary key
    constraint deleted_customers_hash check (customer_hash ~ '^[0-9a-f]{64}$'),
  deleted_at timestamptz not null default now()
);

alter table public.deleted_customers enable row level security;
revoke all on table public.deleted_customers from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.deleted_customers to service_role;

-- SHA-256 hex of a customer id, as the application computes it.
create function public.customer_hash(p_customer_id text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_customer_id, 'UTF8')), 'hex');
$$;

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
    'subscription_id', b.subscription_id, 'unpaid_since', b.unpaid_since, 'state_at', b.state_at);
$$;

-- One customer per account and one account per customer. The unique constraints decide a race; the
-- profile's lock orders it against the account's deletion.
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
  perform 1 from public.account_profiles p where p.account_id = p_account_id for share;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'no_account');
  end if;
  begin
    insert into public.billing_customers (account_id, stripe_customer_id) values (p_account_id, p_customer_id)
    on conflict do nothing
    returning * into v_row;
  exception
    -- The auth user was deleted meanwhile: no row is created for it.
    when foreign_key_violation then
      return pg_catalog.jsonb_build_object('outcome', 'no_account');
  end;
  if v_row.account_id is not null then
    delete from public.deleted_customers d where d.customer_hash = public.customer_hash(p_customer_id);
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
  p_subscription_id text, p_unpaid_since timestamptz, p_observed_at timestamptz)
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
      subscription_id = p_subscription_id, state_at = p_observed_at, updated_at = pg_catalog.now(),
      unpaid_since = case
        when p_status <> 'past_due' then null
        when b.status = 'past_due' and b.subscription_id is not distinct from p_subscription_id then least(b.unpaid_since, p_unpaid_since)
        else p_unpaid_since
      end
  where b.account_id = v_row.account_id
  returning * into v_row;
  return pg_catalog.jsonb_build_object('outcome', 'applied', 'billing', public.billing_json(v_row));
end;
$$;

create function public.apply_billing_event(
  p_event_id text, p_type text,
  p_customer_id text, p_plan text, p_status text, p_current_period_end timestamptz, p_cancel_at_period_end boolean,
  p_subscription_id text, p_unpaid_since timestamptz, p_observed_at timestamptz)
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
  v_answer := public.apply_billing_state(p_customer_id, p_plan, p_status, p_current_period_end, p_cancel_at_period_end, p_subscription_id, p_unpaid_since, p_observed_at);
  -- Nothing was applied (an older read, or the row went away since the check): the event is not recorded.
  if v_answer ->> 'outcome' <> 'applied' then
    delete from public.stripe_events e where e.event_id = p_event_id;
  end if;
  return v_answer;
end;
$$;

-- As in *_publishing.sql, with the profile deleted first (it orders the deletion against link_billing_customer)
-- and the account's customer marked as deleted in the same transaction.
create or replace function public.delete_account_data(p_account_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_account_id is null then
    raise exception 'delete_account_data: account id is required' using errcode = '22004';
  end if;
  delete from public.account_profiles where account_id = p_account_id;
  -- The claims go before the publications; their publications go with them (claim_id ... on delete cascade), then any other of the account's.
  delete from public.site_claims where account_id = p_account_id;
  delete from public.published_sites where account_id = p_account_id;
  delete from public.saved_reports where account_id = p_account_id;
  delete from public.api_keys where account_id = p_account_id;
  insert into public.deleted_customers (customer_hash)
    select public.customer_hash(b.stripe_customer_id) from public.billing_customers b where b.account_id = p_account_id
    on conflict do nothing;
  delete from public.billing_customers where account_id = p_account_id;
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

revoke all on function public.delete_account_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_account_data(uuid) to service_role;
revoke all on function public.customer_hash(text) from public, anon, authenticated;
grant execute on function public.customer_hash(text) to service_role;
revoke all on function public.billing_json(public.billing_customers) from public, anon, authenticated;
revoke all on function public.link_billing_customer(uuid, text) from public, anon, authenticated;
revoke all on function public.apply_billing_state(text, text, text, timestamptz, boolean, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.apply_billing_event(text, text, text, text, text, timestamptz, boolean, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.create_api_key(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.billing_json(public.billing_customers) to service_role;
grant execute on function public.link_billing_customer(uuid, text) to service_role;
grant execute on function public.apply_billing_state(text, text, text, timestamptz, boolean, text, timestamptz, timestamptz) to service_role;
grant execute on function public.apply_billing_event(text, text, text, text, text, timestamptz, boolean, text, timestamptz, timestamptz) to service_role;
grant execute on function public.create_api_key(uuid, text, text, integer) to service_role;
