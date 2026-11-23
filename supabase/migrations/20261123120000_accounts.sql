-- Retrofit account data (src/lib/accounts/data.ts): the eight tables of
-- docs/plans/2026-11-23-retrofit-accounts-claims-publishing-billing.md (Design, Data).
--
-- Access contract, as for the store tables (*_store.sql): only `service_role`
-- (the server) may read or write. `anon`, `authenticated` and `public` get no
-- privilege. RLS is enabled on every table with no policy, so a privilege
-- granted by mistake still exposes no row (service_role bypasses RLS). The
-- store migration's default privileges already keep later tables away from
-- anon and authenticated; the explicit revokes below repeat it per table.
--
-- Accounts are Supabase Auth users. A row an account owns references
-- auth.users(id) on delete cascade, so deleting the auth user deletes the
-- account's data. Raw tokens and keys are never stored: only SHA-256 hex.
--
-- Columns cover the later phases (claims, publishing, billing, API keys) so
-- that they need no new migration for the planned behavior.

-- Pricing page "notify me" (Phase 1). One row per address; a repeat signup changes nothing.
create table public.notify_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null unique
    constraint notify_signups_email_lower check (email = lower(btrim(email)) and length(email) between 3 and 254 and position('@' in email) > 1),
  marketing_consent boolean not null default false,
  unsubscribe_token_hash text not null unique
    constraint notify_signups_token_hash check (unsubscribe_token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unsubscribed_at timestamptz
);

-- Retrofit-side account data (Phase 2). deleted_at marks a deletion in progress.
create table public.account_profiles (
  account_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Reports an account keeps beyond the 24-hour analysis life (Phase 2). report is score/v1.
create table public.saved_reports (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.users (id) on delete cascade,
  host text not null,
  report jsonb not null,
  fetched_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index saved_reports_account on public.saved_reports (account_id, created_at desc);

-- Ownership claims (Phase 3). One claim per account and host; at most one verified claim per host
-- (the first to verify wins; a later verification by another account moves the host in one
-- transaction). Three failed rechecks lapse a claim.
create table public.site_claims (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.users (id) on delete cascade,
  host text not null,
  method text not null
    constraint site_claims_method check (method in ('meta', 'dns')),
  token_hash text not null
    constraint site_claims_token_hash check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending'
    constraint site_claims_status check (status in ('pending', 'verified', 'lapsed')),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  last_checked_at timestamptz,
  failures integer not null default 0
    constraint site_claims_failures check (failures >= 0),
  constraint site_claims_account_host unique (account_id, host)
);

create unique index site_claims_one_verified_per_host on public.site_claims (host) where status = 'verified';
create index site_claims_host on public.site_claims (host);

-- Retrofit-hosted agents (Phase 4). One published site per host, tied to the claim that allows it.
create table public.published_sites (
  host text primary key,
  account_id uuid not null references auth.users (id) on delete cascade,
  claim_id uuid not null references public.site_claims (id) on delete cascade,
  snapshot jsonb not null,
  report jsonb not null,
  published_at timestamptz not null default now(),
  refreshed_at timestamptz not null default now(),
  last_refresh_error text
);

create index published_sites_account on public.published_sites (account_id);
create index published_sites_claim on public.published_sites (claim_id);

-- Stripe link and entitlement (Phase 5). plan is a plan id of src/lib/billing/plans.ts; status is
-- the Stripe subscription status as Stripe reports it ("none" before the first subscription).
create table public.billing_customers (
  account_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique,
  plan text not null default 'free'
    constraint billing_customers_plan check (plan in ('free', 'pro', 'agency')),
  status text not null default 'none',
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

-- Webhook idempotency (Phase 5): the event id is recorded before the event is applied.
create table public.stripe_events (
  event_id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);

-- Bulk API access (Phase 5). The key is shown once; only its hash is stored.
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.users (id) on delete cascade,
  key_hash text not null unique
    constraint api_keys_key_hash check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index api_keys_account on public.api_keys (account_id);

-- RLS on, no policy ------------------------------------------------------------

alter table public.notify_signups enable row level security;
alter table public.account_profiles enable row level security;
alter table public.saved_reports enable row level security;
alter table public.site_claims enable row level security;
alter table public.published_sites enable row level security;
alter table public.billing_customers enable row level security;
alter table public.stripe_events enable row level security;
alter table public.api_keys enable row level security;

-- Privileges: service_role only -------------------------------------------------

revoke all on table
  public.notify_signups,
  public.account_profiles,
  public.saved_reports,
  public.site_claims,
  public.published_sites,
  public.billing_customers,
  public.stripe_events,
  public.api_keys
from public, anon, authenticated, service_role;

grant select, insert, update, delete on table
  public.notify_signups,
  public.account_profiles,
  public.saved_reports,
  public.site_claims,
  public.published_sites,
  public.billing_customers,
  public.stripe_events,
  public.api_keys
to service_role;
