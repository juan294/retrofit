-- Access test for supabase/migrations/*_accounts.sql.
--
-- Run as `postgres` against a disposable stack after the migrations:
--   psql "$SUPABASE_GATE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/accounts_access.sql
-- (tests/db/sql-access.test.ts does this). Everything runs in one transaction
-- that is rolled back, so the database is unchanged. Any failed expectation
-- raises and stops the script; the last line printed on success is
-- "accounts_access: ok".

\set ON_ERROR_STOP on
\set QUIET on
begin;

-- Runs p_sql as p_role and requires a privilege error (SQLSTATE 42501).
create function pg_temp.expect_denied(p_role text, p_sql text) returns void language plpgsql as $$
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    execute p_sql;
  exception
    when insufficient_privilege then
      return; -- the subtransaction rollback also restores the role
  end;
  raise exception 'accounts_access: % was not denied: %', p_role, p_sql;
end;
$$;

-- Runs p_sql as p_role and requires success.
create function pg_temp.expect_allowed(p_role text, p_sql text) returns void language plpgsql as $$
begin
  execute pg_catalog.format('set local role %I', p_role);
  execute p_sql;
  reset role;
exception
  when others then
    raise exception 'accounts_access: % was denied or failed (% %): %', p_role, sqlstate, sqlerrm, p_sql;
end;
$$;

-- Runs p_sql as p_role and requires the error p_state (for example 23505, a unique violation).
create function pg_temp.expect_error(p_role text, p_sql text, p_state text) returns void language plpgsql as $$
declare
  v_state text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    execute p_sql;
  exception
    when others then
      v_state := sqlstate;
  end;
  reset role;
  if v_state is distinct from p_state then
    raise exception 'accounts_access: expected SQLSTATE % from % but got %: %', p_state, p_role, coalesce(v_state, 'success'), p_sql;
  end if;
end;
$$;

-- The eight tables of the parent plan, one column each for an UPDATE probe, and whether an account owns the row.
create temp table account_tables (name text primary key, col text not null, owned boolean not null);
insert into account_tables values
  ('notify_signups', 'created_at', false),
  ('account_profiles', 'created_at', true),
  ('saved_reports', 'created_at', true),
  ('site_claims', 'created_at', true),
  ('published_sites', 'published_at', true),
  ('billing_customers', 'updated_at', true),
  ('stripe_events', 'received_at', false),
  ('api_keys', 'created_at', true);

do $$
declare
  r record;
  v_role text;
  v_missing text;
begin
  select pg_catalog.string_agg(t.name, ', ') into v_missing
  from account_tables t
  where pg_catalog.to_regclass('public.' || t.name) is null;
  if v_missing is not null then
    raise exception 'accounts_access: tables missing: %', v_missing;
  end if;

  -- Denied for anon and authenticated, by privilege, for every statement kind on every table.
  foreach v_role in array array['anon', 'authenticated'] loop
    for r in select name, col from account_tables loop
      perform pg_temp.expect_denied(v_role, pg_catalog.format('select count(*) from public.%I', r.name));
      perform pg_temp.expect_denied(v_role, pg_catalog.format('insert into public.%I default values', r.name));
      perform pg_temp.expect_denied(v_role, pg_catalog.format('update public.%I set %I = %I', r.name, r.col, r.col));
      perform pg_temp.expect_denied(v_role, pg_catalog.format('delete from public.%I', r.name));
    end loop;
  end loop;

  -- Readable by service_role.
  for r in select name from account_tables loop
    perform pg_temp.expect_allowed('service_role', pg_catalog.format('select count(*) from public.%I', r.name));
  end loop;
end;
$$;

-- service_role writes one row in every table for one account; the constraints hold.
insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000a1');

do $$
begin
  perform pg_temp.expect_allowed('service_role', $q$insert into public.account_profiles (account_id) values ('00000000-0000-4000-8000-0000000000a1')$q$);
  perform pg_temp.expect_allowed('service_role', $q$insert into public.saved_reports (account_id, host, report, fetched_at) values ('00000000-0000-4000-8000-0000000000a1', 'access.example', '{}', now())$q$);
  perform pg_temp.expect_allowed('service_role', $q$insert into public.site_claims (id, account_id, host, method, token_hash) values ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a1', 'access.example', 'meta', repeat('b', 64))$q$);
  perform pg_temp.expect_allowed('service_role', $q$insert into public.published_sites (host, account_id, claim_id, snapshot, report) values ('access.example', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', '{}', '{}')$q$);
  perform pg_temp.expect_allowed('service_role', $q$insert into public.billing_customers (account_id, stripe_customer_id) values ('00000000-0000-4000-8000-0000000000a1', 'cus_access')$q$);
  perform pg_temp.expect_allowed('service_role', $q$insert into public.api_keys (account_id, key_hash) values ('00000000-0000-4000-8000-0000000000a1', repeat('c', 64))$q$);
  perform pg_temp.expect_allowed('service_role', $q$insert into public.stripe_events (event_id, type) values ('evt_access', 'checkout.session.completed')$q$);
  perform pg_temp.expect_allowed('service_role', $q$insert into public.notify_signups (email, unsubscribe_token_hash) values ('probe@access.example', repeat('d', 64))$q$);
  perform pg_temp.expect_allowed('service_role', $q$update public.notify_signups set unsubscribed_at = now() where email = 'probe@access.example'$q$);
  perform pg_temp.expect_allowed('service_role', $q$update public.site_claims set status = 'verified', verified_at = now(), failures = 0 where host = 'access.example'$q$);

  -- Defaults the later phases rely on.
  if (select marketing_consent from public.notify_signups where email = 'probe@access.example') is distinct from false then
    raise exception 'accounts_access: marketing_consent does not default to false';
  end if;
  if (select plan from public.billing_customers where stripe_customer_id = 'cus_access') is distinct from 'free' then
    raise exception 'accounts_access: billing_customers.plan does not default to free';
  end if;

  -- Constraints: lower-case email, one row per address, hashes in SHA-256 hex, known claim methods and
  -- states, one published site and one verified claim per host, one row per Stripe event and customer.
  perform pg_temp.expect_error('service_role', $q$insert into public.notify_signups (email, unsubscribe_token_hash) values ('Upper@access.example', repeat('e', 64))$q$, '23514');
  perform pg_temp.expect_error('service_role', $q$insert into public.notify_signups (email, unsubscribe_token_hash) values ('probe@access.example', repeat('f', 64))$q$, '23505');
  perform pg_temp.expect_error('service_role', $q$insert into public.notify_signups (email, unsubscribe_token_hash) values ('raw@access.example', 'not-a-hash')$q$, '23514');
  perform pg_temp.expect_error('service_role', $q$insert into public.site_claims (account_id, host, method, token_hash) values ('00000000-0000-4000-8000-0000000000a1', 'other.example', 'email', repeat('b', 64))$q$, '23514');
  perform pg_temp.expect_error('service_role', $q$update public.site_claims set status = 'done' where host = 'access.example'$q$, '23514');
  perform pg_temp.expect_error('service_role', $q$update public.site_claims set failures = -1 where host = 'access.example'$q$, '23514');
  perform pg_temp.expect_error('service_role', $q$insert into public.published_sites (host, account_id, claim_id, snapshot, report) values ('access.example', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', '{}', '{}')$q$, '23505');
  perform pg_temp.expect_error('service_role', $q$insert into public.stripe_events (event_id, type) values ('evt_access', 'checkout.session.completed')$q$, '23505');
  perform pg_temp.expect_error('service_role', $q$update public.billing_customers set plan = 'gold' where stripe_customer_id = 'cus_access'$q$, '23514');
  perform pg_temp.expect_error('service_role', $q$insert into public.api_keys (account_id, key_hash) values ('00000000-0000-4000-8000-0000000000a1', repeat('c', 64))$q$, '23505');
  perform pg_temp.expect_error('service_role', $q$insert into public.saved_reports (account_id, host, report, fetched_at) values ('00000000-0000-4000-8000-0000000000ff', 'access.example', '{}', now())$q$, '23503');
end;
$$;

-- A second account's verified claim for the same host is refused while the first is verified.
insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000a2');
do $$
begin
  perform pg_temp.expect_error('service_role', $q$insert into public.site_claims (account_id, host, method, token_hash, status, verified_at) values ('00000000-0000-4000-8000-0000000000a2', 'access.example', 'dns', repeat('9', 64), 'verified', now())$q$, '23505');
  perform pg_temp.expect_allowed('service_role', $q$insert into public.site_claims (account_id, host, method, token_hash) values ('00000000-0000-4000-8000-0000000000a2', 'access.example', 'dns', repeat('9', 64))$q$);
end;
$$;

-- Deleting the auth user deletes every row the account owns, and nothing else.
delete from auth.users where id = '00000000-0000-4000-8000-0000000000a1';

do $$
declare
  r record;
  v_left bigint;
begin
  for r in select name from account_tables where owned loop
    execute pg_catalog.format('select count(*) from public.%I where account_id = %L', r.name, '00000000-0000-4000-8000-0000000000a1') into v_left;
    if v_left <> 0 then
      raise exception 'accounts_access: % kept % rows after the account was deleted', r.name, v_left;
    end if;
  end loop;
  if not exists (select 1 from public.notify_signups where email = 'probe@access.example')
     or not exists (select 1 from public.stripe_events where event_id = 'evt_access')
     or not exists (select 1 from public.site_claims where account_id = '00000000-0000-4000-8000-0000000000a2') then
    raise exception 'accounts_access: deleting one account removed rows it does not own';
  end if;
end;
$$;

-- Static checks: privileges, RLS and foreign keys.
do $$
declare
  v_bad text;
begin
  -- No grant to PUBLIC (grantee 0), anon or authenticated on any account table.
  select pg_catalog.string_agg(c.relname || ':' || a.privilege_type, ', ') into v_bad
  from pg_catalog.pg_class c
  cross join lateral pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
  where c.relnamespace = 'public'::regnamespace and c.relname in (select name from account_tables)
    and (a.grantee = 0 or a.grantee in ('anon'::regrole, 'authenticated'::regrole));
  if v_bad is not null then
    raise exception 'accounts_access: table privileges granted: %', v_bad;
  end if;

  -- service_role has exactly the four data privileges (no TRUNCATE, REFERENCES or TRIGGER).
  select pg_catalog.string_agg(t.name || ':' || p.priv, ', ') into v_bad
  from account_tables t
  cross join (values ('SELECT', true), ('INSERT', true), ('UPDATE', true), ('DELETE', true), ('TRUNCATE', false), ('REFERENCES', false), ('TRIGGER', false)) p(priv, expected)
  where pg_catalog.has_table_privilege('service_role', 'public.' || t.name, p.priv) is distinct from p.expected;
  if v_bad is not null then
    raise exception 'accounts_access: service_role privileges differ from select, insert, update, delete: %', v_bad;
  end if;

  -- Every table in public, including later ones, has RLS on and no policy.
  select pg_catalog.string_agg(c.relname, ', ') into v_bad
  from pg_catalog.pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
    and (not c.relrowsecurity
      or exists (select 1 from pg_catalog.pg_policy pol where pol.polrelid = c.oid));
  if v_bad is not null then
    raise exception 'accounts_access: tables without RLS or with a policy: %', v_bad;
  end if;

  -- Every account-owned table references auth.users(id) on delete cascade through account_id.
  select pg_catalog.string_agg(t.name, ', ') into v_bad
  from account_tables t
  where t.owned and not exists (
    select 1
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.conrelid = ('public.' || t.name)::regclass
      and con.contype = 'f'
      and con.confrelid = 'auth.users'::regclass
      and con.confdeltype = 'c'
      and pg_catalog.array_length(con.conkey, 1) = 1
      and att.attname = 'account_id'
  );
  if v_bad is not null then
    raise exception 'accounts_access: account tables without account_id -> auth.users(id) on delete cascade: %', v_bad;
  end if;
end;
$$;

select 'accounts_access: ok' as result;
rollback;
