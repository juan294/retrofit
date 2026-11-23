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

-- The eight tables of the parent plan and the deletion marks, one column each for an UPDATE probe, and whether an account owns the row.
create temp table account_tables (name text primary key, col text not null, owned boolean not null);
insert into account_tables values
  ('notify_signups', 'created_at', false),
  ('account_profiles', 'created_at', true),
  ('saved_reports', 'created_at', true),
  ('site_claims', 'created_at', true),
  ('published_sites', 'published_at', true),
  ('billing_customers', 'updated_at', true),
  ('stripe_events', 'received_at', false),
  ('deleted_customers', 'deleted_at', false),
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

-- The host moves: in one transaction the first claim becomes superseded by the second account and
-- the second claim becomes verified. Moving it back restores the first account's claim.
insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000a3');
do $$
begin
  perform pg_temp.expect_allowed('service_role', $q$update public.site_claims set status = 'superseded', superseded_at = now(), superseded_by = '00000000-0000-4000-8000-0000000000a2' where account_id = '00000000-0000-4000-8000-0000000000a1' and host = 'access.example'$q$);
  perform pg_temp.expect_allowed('service_role', $q$update public.site_claims set status = 'verified', verified_at = now() where account_id = '00000000-0000-4000-8000-0000000000a2' and host = 'access.example'$q$);
  perform pg_temp.expect_allowed('service_role', $q$update public.site_claims set status = 'pending', superseded_at = null, superseded_by = null where account_id = '00000000-0000-4000-8000-0000000000a2' and host = 'access.example'$q$);
  perform pg_temp.expect_allowed('service_role', $q$update public.site_claims set status = 'verified', superseded_at = null, superseded_by = null where account_id = '00000000-0000-4000-8000-0000000000a1' and host = 'access.example'$q$);
  -- superseded_by must name an auth user.
  perform pg_temp.expect_error('service_role', $q$update public.site_claims set superseded_by = '00000000-0000-4000-8000-0000000000ff' where account_id = '00000000-0000-4000-8000-0000000000a2'$q$, '23503');
  -- A third account supersedes a2's claim; deleting that account keeps the claim and clears superseded_by.
  perform pg_temp.expect_allowed('service_role', $q$update public.site_claims set status = 'superseded', superseded_at = now(), superseded_by = '00000000-0000-4000-8000-0000000000a3' where account_id = '00000000-0000-4000-8000-0000000000a2'$q$);
end;
$$;

delete from auth.users where id = '00000000-0000-4000-8000-0000000000a3';

do $$
begin
  if (select superseded_by from public.site_claims where account_id = '00000000-0000-4000-8000-0000000000a2') is not null
     or (select status from public.site_claims where account_id = '00000000-0000-4000-8000-0000000000a2') is distinct from 'superseded'
     or (select superseded_at from public.site_claims where account_id = '00000000-0000-4000-8000-0000000000a2') is null then
    raise exception 'accounts_access: deleting the superseding account must keep the superseded claim and set superseded_by to null';
  end if;
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

-- delete_account_data (account deletion) deletes every row one account owns, and nothing of another's.
insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000d1'), ('00000000-0000-4000-8000-0000000000d2');
do $$
declare
  v_id text;
  v_n text;
  r record;
  v_left bigint;
  v_bad text;
begin
  foreach v_n in array array['1', '2'] loop
    v_id := '00000000-0000-4000-8000-0000000000d' || v_n;
    insert into public.account_profiles (account_id) values (v_id::uuid);
    insert into public.saved_reports (account_id, host, report, fetched_at) values (v_id::uuid, 'del.example', '{}', now());
    insert into public.site_claims (id, account_id, host, method, token_hash) values (('00000000-0000-4000-8000-0000000000e' || v_n)::uuid, v_id::uuid, 'del' || v_n || '.example', 'dns', repeat(v_n, 64));
    insert into public.published_sites (host, account_id, claim_id, snapshot, report) values ('del' || v_n || '.example', v_id::uuid, ('00000000-0000-4000-8000-0000000000e' || v_n)::uuid, '{}', '{}');
    insert into public.billing_customers (account_id, stripe_customer_id) values (v_id::uuid, 'cus_del' || v_n);
    insert into public.api_keys (account_id, key_hash) values (v_id::uuid, repeat('e' || v_n, 32));
  end loop;

  perform pg_temp.expect_denied('anon', $q$select public.delete_account_data('00000000-0000-4000-8000-0000000000d1')$q$);
  perform pg_temp.expect_denied('authenticated', $q$select public.delete_account_data('00000000-0000-4000-8000-0000000000d1')$q$);
  perform pg_temp.expect_allowed('service_role', $q$select public.delete_account_data('00000000-0000-4000-8000-0000000000d1')$q$);
  -- A retry after a lost answer succeeds and changes nothing.
  perform pg_temp.expect_allowed('service_role', $q$select public.delete_account_data('00000000-0000-4000-8000-0000000000d1')$q$);
  perform pg_temp.expect_error('service_role', $q$select public.delete_account_data(null)$q$, '22004');

  for r in select name from account_tables where owned loop
    execute pg_catalog.format('select count(*) from public.%I where account_id = %L', r.name, '00000000-0000-4000-8000-0000000000d1') into v_left;
    if v_left <> 0 then
      raise exception 'accounts_access: delete_account_data left % rows in %', v_left, r.name;
    end if;
    execute pg_catalog.format('select count(*) from public.%I where account_id = %L', r.name, '00000000-0000-4000-8000-0000000000d2') into v_left;
    if v_left <> 1 then
      raise exception 'accounts_access: delete_account_data changed another account''s rows in % (% left)', r.name, v_left;
    end if;
  end loop;
  if not exists (select 1 from auth.users where id = '00000000-0000-4000-8000-0000000000d1') then
    raise exception 'accounts_access: delete_account_data must not delete the auth user';
  end if;

  -- Security invoker, empty search_path, EXECUTE for service_role only.
  if not exists (select 1 from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'delete_account_data') then
    raise exception 'accounts_access: delete_account_data is missing';
  end if;
  select pg_catalog.string_agg(p.proname, ', ') into v_bad
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'delete_account_data'
    and (p.prosecdef
      or not ('search_path=""' = any (coalesce(p.proconfig, '{}')))
      or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a where a.grantee = 0)
      or not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'accounts_access: delete_account_data is security definer, without search_path = '''', or has the wrong EXECUTE grants';
  end if;
end;
$$;

-- save_report (saved reports once each, at most p_max per account), and every account function's grants.
insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000f1');
do $$
declare
  v_bad text;
begin
  perform pg_temp.expect_denied('anon', $q$select * from public.save_report('00000000-0000-4000-8000-0000000000f1', 's.example', '{}', now(), 100)$q$);
  perform pg_temp.expect_denied('authenticated', $q$select * from public.save_report('00000000-0000-4000-8000-0000000000f1', 's.example', '{}', now(), 100)$q$);
  perform pg_temp.expect_allowed('service_role', $q$select * from public.save_report('00000000-0000-4000-8000-0000000000f1', 's.example', '{"score": 3}', '2026-11-23T10:00:00Z', 2)$q$);
  if (select outcome from public.save_report('00000000-0000-4000-8000-0000000000f1', 's.example', '{}', '2026-11-23T10:00:00Z', 2)) <> 'existing' then
    raise exception 'accounts_access: save_report stored the same report twice';
  end if;
  perform pg_temp.expect_allowed('service_role', $q$select * from public.save_report('00000000-0000-4000-8000-0000000000f1', 's.example', '{}', '2026-11-23T11:00:00Z', 2)$q$);
  if (select outcome from public.save_report('00000000-0000-4000-8000-0000000000f1', 's.example', '{}', '2026-11-23T12:00:00Z', 2)) <> 'full' then
    raise exception 'accounts_access: save_report stored past p_max';
  end if;
  if (select count(*) from public.saved_reports where account_id = '00000000-0000-4000-8000-0000000000f1') <> 2 then
    raise exception 'accounts_access: save_report kept the wrong number of reports';
  end if;
  -- The unique constraint holds even for a direct insert.
  perform pg_temp.expect_error('service_role', $q$insert into public.saved_reports (account_id, host, report, fetched_at) values ('00000000-0000-4000-8000-0000000000f1', 's.example', '{}', '2026-11-23T10:00:00Z')$q$, '23505');

  -- Every account function: security invoker, empty search_path, EXECUTE for service_role only.
  select pg_catalog.string_agg(p.proname, ', ') into v_bad
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname in ('save_report', 'delete_account_data')
    and (p.prosecdef
      or not ('search_path=""' = any (coalesce(p.proconfig, '{}')))
      or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a where a.grantee = 0)
      or not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'));
  if v_bad is not null or (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname in ('save_report', 'delete_account_data')) <> 2 then
    raise exception 'accounts_access: account functions missing, security definer, without search_path = '''', or with wrong EXECUTE: %', coalesce(v_bad, 'missing');
  end if;
end;
$$;

-- Claim functions (*_claims.sql): the pending limit, Start over, failures that lapse, the host moving in
-- one transaction, a superseded claim staying terminal, stale checks, and the grants of every account function.
insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000b1'), ('00000000-0000-4000-8000-0000000000b2');
do $$
declare
  v jsonb;
  v_first uuid;
  v_second uuid;
  v_bad text;
  v_fn text;
begin
  foreach v_fn in array array[
    $q$select public.create_claim('00000000-0000-4000-8000-0000000000b1', 'fn.example', 'meta', repeat('1', 64), 10)$q$,
    $q$select public.restart_claim('00000000-0000-4000-8000-0000000000c9', '00000000-0000-4000-8000-0000000000b1', 'meta', repeat('1', 64), 10)$q$,
    $q$select public.record_claim_failure('00000000-0000-4000-8000-0000000000c9', repeat('1', 64), 'tag_missing', null, now(), 3)$q$,
    $q$select public.verify_claim('00000000-0000-4000-8000-0000000000c9', repeat('1', 64), now())$q$
  ] loop
    perform pg_temp.expect_denied('anon', v_fn);
    perform pg_temp.expect_denied('authenticated', v_fn);
  end loop;

  set local role service_role;
  -- One claim per account and host; at most p_max_pending pending claims.
  v := public.create_claim('00000000-0000-4000-8000-0000000000b1', 'fn.example', 'meta', repeat('1', 64), 1);
  if v ->> 'outcome' <> 'created' or v -> 'claim' ->> 'status' <> 'pending' or v -> 'claim' ? 'superseded_by' then
    raise exception 'accounts_access: create_claim did not create a pending claim without superseded_by: %', v;
  end if;
  v_first := (v -> 'claim' ->> 'id')::uuid;
  if public.create_claim('00000000-0000-4000-8000-0000000000b1', 'fn.example', 'dns', repeat('2', 64), 1) ->> 'outcome' <> 'exists' then
    raise exception 'accounts_access: create_claim stored a second claim for one account and host';
  end if;
  if public.create_claim('00000000-0000-4000-8000-0000000000b1', 'fn2.example', 'meta', repeat('2', 64), 1) ->> 'outcome' <> 'full' then
    raise exception 'accounts_access: create_claim stored past p_max_pending';
  end if;
  -- Start over: a new token and method, pending, no result; a check against the old token is stale.
  perform public.record_claim_failure(v_first, repeat('1', 64), 'tag_missing', null, now(), 3);
  v := public.restart_claim(v_first, '00000000-0000-4000-8000-0000000000b1', 'dns', repeat('3', 64), 1);
  if v ->> 'outcome' <> 'restarted' or v -> 'claim' ->> 'token_hash' <> repeat('3', 64) or v -> 'claim' ->> 'method' <> 'dns'
     or (v -> 'claim' ->> 'failures')::int <> 0 or v -> 'claim' ->> 'last_result' is not null then
    raise exception 'accounts_access: restart_claim did not reset the claim: %', v;
  end if;
  if public.restart_claim(v_first, '00000000-0000-4000-8000-0000000000b2', 'dns', repeat('4', 64), 1) ->> 'outcome' <> 'missing' then
    raise exception 'accounts_access: restart_claim changed another account''s claim';
  end if;
  if public.verify_claim(v_first, repeat('1', 64), now()) ->> 'outcome' <> 'stale'
     or public.record_claim_failure(v_first, repeat('1', 64), 'tag_missing', null, now(), 3) ->> 'outcome' <> 'stale' then
    raise exception 'accounts_access: a check against a replaced token was applied';
  end if;
  -- Verified, then three failures lapse it.
  v := public.verify_claim(v_first, repeat('3', 64), '2026-11-23T09:00:00Z');
  if v ->> 'outcome' <> 'verified' or v -> 'claim' ->> 'status' <> 'verified' or v -> 'moved_from' <> '[]'::jsonb then
    raise exception 'accounts_access: verify_claim did not verify: %', v;
  end if;
  perform public.record_claim_failure(v_first, repeat('3', 64), 'tag_missing', null, '2026-11-24T09:00:00Z', 3);
  perform public.record_claim_failure(v_first, repeat('3', 64), 'http_status', 500, '2026-11-25T09:00:00Z', 3);
  v := public.record_claim_failure(v_first, repeat('3', 64), 'record_missing', null, '2026-11-26T09:00:00Z', 3);
  if v -> 'claim' ->> 'status' <> 'lapsed' or (v -> 'claim' ->> 'failures')::int <> 3 then
    raise exception 'accounts_access: three failures did not lapse the claim: %', v;
  end if;
  if v -> 'claim' ->> 'lapsed_at' is distinct from '2026-11-26T09:00:00+00:00' then
    raise exception 'accounts_access: the lapse instant was not recorded: %', v;
  end if;
  v := public.record_claim_failure(v_first, repeat('3', 64), 'crawl_delay', 86400, '2026-11-26T12:00:00Z', 3);
  if v -> 'claim' ->> 'lapsed_at' is distinct from '2026-11-26T09:00:00+00:00' or (v -> 'claim' ->> 'last_detail')::int <> 86400 then
    raise exception 'accounts_access: a later failure moved the lapse instant: %', v;
  end if;
  -- claims_due: verified before lapsed, each least recently checked first; a long-lapsed claim only weekly.
  if (select pg_catalog.jsonb_agg(x ->> 'id') from pg_catalog.jsonb_array_elements(public.claims_due('2026-11-27T00:00:00Z', '2026-10-01T00:00:00Z', '2026-11-20T00:00:00Z', 50)) x
      where x ->> 'host' = 'fn.example') <> pg_catalog.jsonb_build_array(v_first::text) then
    raise exception 'accounts_access: claims_due did not list the recently lapsed claim';
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(public.claims_due('2026-12-30T00:00:00Z', '2026-12-01T00:00:00Z', '2026-11-20T00:00:00Z', 50)) x where x ->> 'id' = v_first::text) then
    raise exception 'accounts_access: claims_due listed a long-lapsed claim checked within the week';
  end if;
  if pg_catalog.jsonb_array_length(public.claims_due('2026-11-27T00:00:00Z', '2026-10-01T00:00:00Z', '2026-11-20T00:00:00Z', 0)) <> 0 then
    raise exception 'accounts_access: claims_due ignored p_limit';
  end if;
  -- A second account verifies: the lapsed claim is superseded in the same call and stays terminal.
  v := public.create_claim('00000000-0000-4000-8000-0000000000b2', 'fn.example', 'meta', repeat('5', 64), 10);
  v_second := (v -> 'claim' ->> 'id')::uuid;
  v := public.verify_claim(v_second, repeat('5', 64), '2026-11-27T09:00:00Z');
  if v ->> 'outcome' <> 'verified' or v -> 'moved_from' <> '["00000000-0000-4000-8000-0000000000b1"]'::jsonb then
    raise exception 'accounts_access: verify_claim did not move the host: %', v;
  end if;
  if (select status from public.site_claims where id = v_first) <> 'superseded'
     or (select superseded_by from public.site_claims where id = v_first) <> '00000000-0000-4000-8000-0000000000b2'
     or (select superseded_at from public.site_claims where id = v_first) <> '2026-11-27T09:00:00Z' then
    raise exception 'accounts_access: the first claim was not superseded by the second account';
  end if;
  if (select lapsed_at from public.site_claims where id = v_first) is not null then
    raise exception 'accounts_access: a superseded claim kept its lapse instant';
  end if;
  if public.verify_claim(v_first, repeat('3', 64), now()) ->> 'outcome' <> 'superseded'
     or public.record_claim_failure(v_first, repeat('3', 64), 'tag_missing', null, now(), 3) ->> 'outcome' <> 'superseded'
     or public.restart_claim(v_first, '00000000-0000-4000-8000-0000000000b1', 'meta', repeat('6', 64), 10) ->> 'outcome' <> 'superseded'
     or (select status from public.site_claims where id = v_first) <> 'superseded' then
    raise exception 'accounts_access: a superseded claim changed';
  end if;
  reset role;
  perform pg_temp.expect_error('service_role', $q$update public.site_claims set last_result = 'found' where host = 'fn.example'$q$, '23514');
  perform pg_temp.expect_error('service_role', $q$update public.site_claims set lapsed_at = now() where host = 'fn.example' and status <> 'lapsed'$q$, '23514');
  perform pg_temp.expect_denied('anon', $q$select public.claims_due(now(), now(), now(), 10)$q$);
  perform pg_temp.expect_denied('authenticated', $q$select public.claims_due(now(), now(), now(), 10)$q$);
  perform pg_temp.expect_error('service_role', $q$select public.record_claim_failure('00000000-0000-4000-8000-0000000000c9', repeat('1', 64), 'verified', null, now(), 3)$q$, '22023');

  -- Every account function: security invoker, empty search_path, EXECUTE for service_role only.
  select pg_catalog.string_agg(p.proname, ', ') into v_bad
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('save_report', 'delete_account_data', 'claim_json', 'create_claim', 'restart_claim', 'record_claim_failure', 'verify_claim', 'claims_due')
    and (p.prosecdef
      or not ('search_path=""' = any (coalesce(p.proconfig, '{}')))
      or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a where a.grantee = 0)
      or not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'));
  if v_bad is not null or (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('save_report', 'delete_account_data', 'claim_json', 'create_claim', 'restart_claim', 'record_claim_failure', 'verify_claim', 'claims_due')) <> 8 then
    raise exception 'accounts_access: account functions missing, security definer, without search_path = '''', or with wrong EXECUTE: %', coalesce(v_bad, 'missing');
  end if;
end;
$$;

-- Publishing functions (*_publishing.sql): the one public rule, publish under the claim's lock, transfers that end
-- other publications for good, the column limits, and the grants.
insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000d4'), ('00000000-0000-4000-8000-0000000000d5');
do $$
declare
  a constant uuid := '00000000-0000-4000-8000-0000000000d4';
  b constant uuid := '00000000-0000-4000-8000-0000000000d5';
  v jsonb;
  v_first uuid;
  v_second uuid;
  v_third uuid;
  v_bad text;
  v_fn text;
begin
  foreach v_fn in array array[
    $q$select public.site_is_public('00000000-0000-4000-8000-0000000000c9', '00000000-0000-4000-8000-0000000000d4', 'p.example')$q$,
    $q$select public.public_site('p.example', 'snapshot')$q$,
    $q$select public.public_hosts(10)$q$,
    $q$select public.publish_site('00000000-0000-4000-8000-0000000000d4', 'p.example', '{}', '{}', now(), now())$q$,
    $q$select public.verify_claim('00000000-0000-4000-8000-0000000000c9', repeat('1', 64), now())$q$
  ] loop
    perform pg_temp.expect_denied('anon', v_fn);
    perform pg_temp.expect_denied('authenticated', v_fn);
  end loop;

  set local role service_role;
  -- Publishing needs the account's own verified claim.
  if public.publish_site(a, 'p.example', '{"n": 1}', '{"score": 7}', '2026-11-20T08:00:00Z', '2026-11-20T10:00:00Z') ->> 'outcome' <> 'no_claim' then
    raise exception 'accounts_access: publish_site published without a claim';
  end if;
  v_first := (public.create_claim(a, 'p.example', 'meta', repeat('1', 64), 10) -> 'claim' ->> 'id')::uuid;
  if public.publish_site(a, 'p.example', '{"n": 1}', '{"score": 7}', '2026-11-20T08:00:00Z', '2026-11-20T10:00:00Z') ->> 'outcome' <> 'not_verified' then
    raise exception 'accounts_access: publish_site published under a pending claim';
  end if;
  perform public.verify_claim(v_first, repeat('1', 64), '2026-11-20T09:00:00Z');
  if public.publish_site(b, 'p.example', '{"n": 1}', '{"score": 7}', '2026-11-20T08:00:00Z', '2026-11-20T10:00:00Z') ->> 'outcome' <> 'no_claim' then
    raise exception 'accounts_access: publish_site published under another account''s claim';
  end if;
  v := public.publish_site(a, 'p.example', '{"n": 1}', '{"score": 7}', '2026-11-20T08:00:00Z', '2026-11-20T10:00:00Z');
  if v ->> 'outcome' <> 'published' or (v -> 'site' ->> 'score')::int <> 7 or v -> 'site' ? 'snapshot' or (v -> 'site' ->> 'claim_id')::uuid <> v_first then
    raise exception 'accounts_access: publish_site did not publish: %', v;
  end if;

  -- The light read carries neither the report nor the snapshot; each part carries only itself.
  v := public.public_site('p.example', 'site');
  if v ->> 'host' <> 'p.example' or (v ->> 'score')::int <> 7 or v ? 'snapshot' or v ? 'report' then
    raise exception 'accounts_access: the light public read is wrong: %', v;
  end if;
  if (public.public_site('p.example', 'report') ? 'snapshot') or not (public.public_site('p.example', 'report') ? 'report')
     or (public.public_site('p.example', 'snapshot') ? 'report') or (public.public_site('p.example', 'snapshot') -> 'snapshot' ->> 'n')::int <> 1 then
    raise exception 'accounts_access: public_site returned the wrong part';
  end if;
  if not (public.public_hosts(1000) ? 'p.example') or pg_catalog.jsonb_array_length(public.public_hosts(0)) <> 0 then
    raise exception 'accounts_access: public_hosts is wrong';
  end if;

  -- A refresh must be newer; it keeps the first publication time and clears the error.
  update public.published_sites set last_refresh_error = 'too_large' where host = 'p.example';
  v := public.publish_site(a, 'p.example', '{"n": 2}', '{"score": 8}', '2026-11-20T08:00:00Z', '2026-11-21T10:00:00Z');
  if v ->> 'outcome' <> 'not_newer' or (v -> 'site' ->> 'score')::int <> 7 or v -> 'site' ->> 'last_refresh_error' <> 'too_large'
     or (public.public_site('p.example', 'snapshot') -> 'snapshot' ->> 'n')::int <> 1 then
    raise exception 'accounts_access: a refresh that is not newer changed the snapshot';
  end if;
  v := public.publish_site(a, 'p.example', '{"n": 2}', '{"score": 8}', '2026-11-21T08:00:00Z', '2026-11-21T10:00:00Z');
  if v ->> 'outcome' <> 'refreshed' or (v -> 'site' ->> 'published_at')::timestamptz <> '2026-11-20T10:00:00Z' or v -> 'site' ->> 'last_refresh_error' is not null then
    raise exception 'accounts_access: publish_site did not refresh: %', v;
  end if;

  -- A lapse hides it; a pass restores the same publication.
  for n in 1..3 loop
    perform public.record_claim_failure(v_first, repeat('1', 64), 'tag_missing', null, '2026-11-22T09:00:00Z'::timestamptz + pg_catalog.make_interval(days => n), 3);
  end loop;
  if public.public_site('p.example', 'site') is not null or public.public_hosts(1000) ? 'p.example' then
    raise exception 'accounts_access: a lapsed claim left its site public';
  end if;
  perform public.verify_claim(v_first, repeat('1', 64), '2026-11-26T09:00:00Z');
  if (public.public_site('p.example', 'snapshot') -> 'snapshot' ->> 'n')::int is distinct from 2 then
    raise exception 'accounts_access: a recovered claim did not restore its site';
  end if;

  -- A publication whose claim is another account's, or for another host, is never public.
  v_third := (public.create_claim(b, 'q.example', 'meta', repeat('3', 64), 10) -> 'claim' ->> 'id')::uuid;
  perform public.verify_claim(v_third, repeat('3', 64), '2026-11-26T09:00:00Z');
  insert into public.published_sites (host, account_id, claim_id, snapshot, report) values ('q.example', a, v_third, '{}', '{}');
  if public.public_site('q.example', 'site') is not null then
    raise exception 'accounts_access: a site under another account''s claim was public';
  end if;
  update public.published_sites set account_id = b, host = 'r.example' where host = 'q.example';
  if public.public_site('r.example', 'site') is not null then
    raise exception 'accounts_access: a site under a claim of another host was public';
  end if;

  -- A transfer deletes the old publication, also one paused by a pending claim, so it never comes back.
  for n in 1..3 loop
    perform public.record_claim_failure(v_first, repeat('1', 64), 'tag_missing', null, '2026-11-27T09:00:00Z'::timestamptz + pg_catalog.make_interval(days => n), 3);
  end loop;
  perform public.restart_claim(v_first, a, 'meta', repeat('4', 64), 10);
  v_second := (public.create_claim(b, 'p.example', 'dns', repeat('2', 64), 10) -> 'claim' ->> 'id')::uuid;
  perform public.verify_claim(v_second, repeat('2', 64), '2026-12-01T09:00:00Z');
  if exists (select 1 from public.published_sites where host = 'p.example') then
    raise exception 'accounts_access: a transfer kept the old publication';
  end if;
  delete from public.site_claims where id = v_second;
  perform public.verify_claim(v_first, repeat('4', 64), '2026-12-02T09:00:00Z');
  if public.public_site('p.example', 'site') is not null then
    raise exception 'accounts_access: the old publication came back after the host moved twice';
  end if;
  -- Removing the claim removes its publication.
  perform public.publish_site(a, 'p.example', '{"n": 3}', '{"score": 9}', '2026-12-02T08:00:00Z', '2026-12-02T10:00:00Z');
  if public.public_site('p.example', 'site') is null then
    raise exception 'accounts_access: publishing again after a transfer did not make the site public';
  end if;
  delete from public.site_claims where id = v_first;
  if exists (select 1 from public.published_sites where host = 'p.example') then
    raise exception 'accounts_access: removing a claim kept its publication';
  end if;
  reset role;

  perform pg_temp.expect_error('service_role', $q$update public.published_sites set last_refresh_error = '<b>page text</b>' where host = 'r.example'$q$, '23514');
  perform pg_temp.expect_error('service_role', $q$update public.published_sites set last_refresh_error = 'not_newer' where host = 'r.example'$q$, '23514');
  perform pg_temp.expect_error('service_role', $q$update public.published_sites set host = 'R.example' where host = 'r.example'$q$, '23514');
  -- publish_site refuses an oversized snapshot or report before any write.
  perform pg_temp.expect_error('service_role', $q$select public.publish_site('00000000-0000-4000-8000-0000000000d5', 'q.example', '{}', pg_catalog.jsonb_build_object('pad', repeat('x', 600000)), now(), now())$q$, '54000');
  perform pg_temp.expect_error('service_role', $q$select public.publish_site('00000000-0000-4000-8000-0000000000d5', 'q.example', pg_catalog.jsonb_build_object('pad', repeat('x', 4200000)), '{}', now(), now())$q$, '54000');
  perform pg_temp.expect_allowed('service_role', $q$select public.publish_site('00000000-0000-4000-8000-0000000000d5', 'q.example', pg_catalog.jsonb_build_object('pad', repeat('x', 4100000)), pg_catalog.jsonb_build_object('pad', repeat('x', 500000)), now(), now())$q$);
  -- The score column follows the report and cannot be written; a report without a number has no score.
  perform pg_temp.expect_error('service_role', $q$update public.published_sites set score = 100 where host = 'r.example'$q$, '428C9');
  perform pg_temp.expect_allowed('service_role', $q$update public.published_sites set report = '{"score": "100"}' where host = 'r.example'$q$);
  if (select score from public.published_sites where host = 'r.example') is not null then
    raise exception 'accounts_access: a score that is not a number became a score';
  end if;
  perform pg_temp.expect_allowed('service_role', $q$update public.published_sites set report = '{"score": 41}' where host = 'r.example'$q$);
  if (select score from public.published_sites where host = 'r.example') is distinct from 41 then
    raise exception 'accounts_access: the score column does not follow the report';
  end if;
  perform pg_temp.expect_denied('anon', $q$select public.published_site_json('p.example')$q$);
  perform pg_temp.expect_denied('authenticated', $q$select public.published_site_json('p.example')$q$);
  perform pg_temp.expect_error('service_role', $q$select public.publish_site(null, 'p.example', '{}', '{}', now(), now())$q$, '22004');

  select pg_catalog.string_agg(p.proname, ', ') into v_bad
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('site_is_public', 'public_site', 'public_hosts', 'published_site_json', 'publish_site', 'verify_claim')
    and (p.prosecdef
      or not ('search_path=""' = any (coalesce(p.proconfig, '{}')))
      or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) x where x.grantee = 0)
      or not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'));
  if v_bad is not null or (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('site_is_public', 'public_site', 'public_hosts', 'published_site_json', 'publish_site', 'verify_claim')) <> 6 then
    raise exception 'accounts_access: publishing functions missing, security definer, without search_path = '''', or with wrong EXECUTE: %', coalesce(v_bad, 'missing');
  end if;
end;
$$;

-- Billing functions (*_billing.sql): one customer per account, the newest read wins, an event applies once and
-- together with its state, an unknown customer creates nothing, the API key limit, and the functions' grants.
insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000f5'), ('00000000-0000-4000-8000-0000000000f6');
do $$
declare
  v jsonb;
  v_bad text;
  v_fn text;
begin
  foreach v_fn in array array[
    $q$select public.link_billing_customer('00000000-0000-4000-8000-0000000000f5', 'cus_probe')$q$,
    $q$select public.apply_billing_state('cus_probe', 'pro', 'active', null, false, null, null, now())$q$,
    $q$select public.apply_billing_event('evt_probe', 'customer.subscription.updated', 'cus_probe', 'pro', 'active', null, false, null, null, now())$q$,
    $q$select public.create_api_key('00000000-0000-4000-8000-0000000000f5', repeat('7', 64), 'beef', 5)$q$,
    $q$select public.customer_hash('cus_probe')$q$,
    $q$select public.prune_stripe_events(now(), 1)$q$,
    $q$select public.billing_json(null::public.billing_customers)$q$
  ] loop
    perform pg_temp.expect_denied('anon', v_fn);
    perform pg_temp.expect_denied('authenticated', v_fn);
  end loop;

  set local role service_role;
  -- Without a profile (its data was deleted) nothing is linked.
  if public.link_billing_customer('00000000-0000-4000-8000-0000000000f5', 'cus_probe') ->> 'outcome' <> 'no_account' then
    raise exception 'accounts_access: link_billing_customer linked an account without a profile';
  end if;
  insert into public.account_profiles (account_id) values ('00000000-0000-4000-8000-0000000000f5'), ('00000000-0000-4000-8000-0000000000f6');
  v := public.link_billing_customer('00000000-0000-4000-8000-0000000000f5', 'cus_probe');
  if v ->> 'outcome' <> 'linked' or v -> 'billing' ->> 'plan' <> 'free' or v -> 'billing' ->> 'status' <> 'none' or v -> 'billing' ->> 'state_at' is not null then
    raise exception 'accounts_access: link_billing_customer did not link a free customer: %', v;
  end if;
  if public.link_billing_customer('00000000-0000-4000-8000-0000000000f5', 'cus_other') -> 'billing' ->> 'stripe_customer_id' <> 'cus_probe' then
    raise exception 'accounts_access: link_billing_customer replaced a customer';
  end if;
  if public.link_billing_customer('00000000-0000-4000-8000-0000000000f6', 'cus_probe') ->> 'outcome' <> 'taken' then
    raise exception 'accounts_access: link_billing_customer shared a customer';
  end if;
  -- An account that does not exist gets no row and an answer, not an error.
  if public.link_billing_customer('00000000-0000-4000-8000-0000000000ff', 'cus_gone') ->> 'outcome' <> 'no_account' then
    raise exception 'accounts_access: link_billing_customer answered wrongly for a deleted account';
  end if;
  -- The newest read wins; an equal time applies. Each step is its own statement, so the next one sees it.
  if public.apply_billing_state('cus_probe', 'pro', 'active', '2027-03-01T00:00:00Z', false, 'sub_1', null, '2027-02-01T10:00:00Z') ->> 'outcome' <> 'applied' then
    raise exception 'accounts_access: apply_billing_state did not apply';
  end if;
  if public.apply_billing_state('cus_probe', 'free', 'canceled', null, false, null, null, '2027-02-01T09:59:59.999Z') ->> 'outcome' <> 'stale' then
    raise exception 'accounts_access: an older read was not stale';
  end if;
  if (select plan from public.billing_customers where stripe_customer_id = 'cus_probe') is distinct from 'pro' then
    raise exception 'accounts_access: an older read changed the plan';
  end if;
  if public.apply_billing_state('cus_probe', 'pro', 'past_due', '2027-03-01T00:00:00Z', true, 'sub_1', null, '2027-02-01T10:00:00Z') ->> 'outcome' <> 'applied' then
    raise exception 'accounts_access: a read with an equal time was refused';
  end if;
  -- An event applies once; an unknown customer's event is not recorded and creates no row.
  if public.apply_billing_event('evt_probe', 'customer.subscription.updated', 'cus_probe', 'agency', 'active', null, false, 'sub_1', null, '2027-02-02T10:00:00Z') ->> 'outcome' <> 'applied' then
    raise exception 'accounts_access: apply_billing_event did not apply';
  end if;
  if public.apply_billing_event('evt_probe', 'customer.subscription.updated', 'cus_probe', 'free', 'canceled', null, false, null, null, '2027-02-03T10:00:00Z') ->> 'outcome' <> 'duplicate' then
    raise exception 'accounts_access: a replayed event was not a duplicate';
  end if;
  if (select plan from public.billing_customers where stripe_customer_id = 'cus_probe') is distinct from 'agency' then
    raise exception 'accounts_access: a replayed event changed the plan';
  end if;
  if public.apply_billing_event('evt_unknown', 'customer.subscription.updated', 'cus_nobody', 'pro', 'active', null, false, null, null, now()) ->> 'outcome' <> 'unknown' then
    raise exception 'accounts_access: an unknown customer''s event was not unknown';
  end if;
  if exists (select 1 from public.stripe_events where event_id = 'evt_unknown') or exists (select 1 from public.billing_customers where stripe_customer_id = 'cus_nobody') then
    raise exception 'accounts_access: an unknown customer''s event was recorded or created a row';
  end if;
  -- A stale event is not recorded: reading again can apply it.
  if public.apply_billing_event('evt_stale', 'customer.subscription.updated', 'cus_probe', 'free', 'canceled', null, false, null, null, '2027-02-01T10:00:00Z') ->> 'outcome' <> 'stale' then
    raise exception 'accounts_access: an older event was not stale';
  end if;
  if exists (select 1 from public.stripe_events where event_id = 'evt_stale') then
    raise exception 'accounts_access: a stale event was recorded';
  end if;
  -- The first start of an unpaid time is kept while the same subscription stays past due.
  perform public.apply_billing_state('cus_probe', 'pro', 'past_due', null, false, 'sub_1', '2027-02-03T00:00:00Z', '2027-02-03T10:00:00Z');
  v := public.apply_billing_state('cus_probe', 'pro', 'past_due', null, false, 'sub_1', '2027-03-03T00:00:00Z', '2027-02-03T11:00:00Z');
  if (v -> 'billing' ->> 'unpaid_since')::timestamptz <> '2027-02-03T00:00:00Z' then
    raise exception 'accounts_access: the start of the unpaid time moved: %', v;
  end if;
  v := public.apply_billing_state('cus_probe', 'pro', 'active', null, false, 'sub_1', '2027-03-03T00:00:00Z', '2027-02-03T12:00:00Z');
  if v -> 'billing' ->> 'unpaid_since' is not null then
    raise exception 'accounts_access: a paid subscription kept its unpaid time: %', v;
  end if;
  -- At most p_max active keys; a revoked key frees its place.
  if public.create_api_key('00000000-0000-4000-8000-0000000000f5', repeat('7', 64), 'beef', 1) ->> 'outcome' <> 'created' then
    raise exception 'accounts_access: create_api_key did not create';
  end if;
  if public.create_api_key('00000000-0000-4000-8000-0000000000f5', repeat('8', 64), 'beef', 1) ->> 'outcome' <> 'full' then
    raise exception 'accounts_access: create_api_key does not keep its limit';
  end if;
  update public.api_keys set revoked_at = now() where key_hash = repeat('7', 64);
  if public.create_api_key('00000000-0000-4000-8000-0000000000f5', repeat('8', 64), 'beef', 1) ->> 'outcome' <> 'created' then
    raise exception 'accounts_access: a revoked key still counts';
  end if;
  -- The deletion marks the account's customer, in the hash the application computes, and only that one; a retry keeps it.
  perform public.link_billing_customer('00000000-0000-4000-8000-0000000000f6', 'cus_marked');
  perform public.delete_account_data('00000000-0000-4000-8000-0000000000f6');
  perform public.delete_account_data('00000000-0000-4000-8000-0000000000f6');
  if (select count(*) from public.deleted_customers where customer_hash = public.customer_hash('cus_marked')) <> 1
     or exists (select 1 from public.deleted_customers where customer_hash = public.customer_hash('cus_probe'))
     or public.customer_hash('cus_marked') <> '7c408137c538f4a8e30dea7ad39c656bfa7dd9d6d458cb51b4948d44e3ecbdae' then
    raise exception 'accounts_access: delete_account_data did not mark exactly its customer';
  end if;
  insert into public.account_profiles (account_id) values ('00000000-0000-4000-8000-0000000000f6');
  perform public.link_billing_customer('00000000-0000-4000-8000-0000000000f6', 'cus_marked');
  if exists (select 1 from public.deleted_customers where customer_hash = public.customer_hash('cus_marked')) then
    raise exception 'accounts_access: linking a customer kept its deletion mark';
  end if;
  reset role;

  -- A failure while applying records no event (one transaction), so the redelivery applies it.
  perform pg_temp.expect_error('service_role', $q$select public.apply_billing_event('evt_crash', 'customer.subscription.updated', 'cus_probe', 'gold', 'active', null, false, null, null, '2027-02-04T10:00:00Z')$q$, '23514');
  if exists (select 1 from public.stripe_events where event_id = 'evt_crash') then
    raise exception 'accounts_access: a failed event was recorded';
  end if;
  if public.apply_billing_event('evt_crash', 'customer.subscription.updated', 'cus_probe', 'pro', 'active', null, false, null, null, '2027-02-04T10:00:00Z') ->> 'outcome' <> 'applied' then
    raise exception 'accounts_access: the redelivery after a failure was not applied';
  end if;
  perform pg_temp.expect_error('service_role', $q$select public.apply_billing_state('cus_probe', 'pro', 'Active!', null, false, null, null, '2030-01-01T00:00:00Z')$q$, '23514');
  perform pg_temp.expect_error('service_role', $q$select public.apply_billing_state('cus_probe', 'pro', 'active', null, false, 'nope', null, '2030-01-01T00:00:00Z')$q$, '23514');
  perform pg_temp.expect_error('service_role', $q$insert into public.deleted_customers (customer_hash) values ('cus_raw')$q$, '23514');
  delete from public.billing_customers where account_id = '00000000-0000-4000-8000-0000000000f6';
  perform pg_temp.expect_error('service_role', $q$select public.link_billing_customer('00000000-0000-4000-8000-0000000000f6', 'acct_1')$q$, '23514');
  perform pg_temp.expect_error('service_role', $q$select public.create_api_key('00000000-0000-4000-8000-0000000000f6', repeat('9', 64), 'key!', 5)$q$, '23514');
  -- Pruning takes the oldest events before the time, at most the limit.
  insert into public.stripe_events (event_id, type, received_at) values ('evt_p1', 't', '2015-01-01'), ('evt_p2', 't', '2015-01-02'), ('evt_p3', 't', '2015-01-03');
  if public.prune_stripe_events('2015-01-02T12:00:00Z', 1) <> 1 then
    raise exception 'accounts_access: prune_stripe_events ignored its limit';
  end if;
  if exists (select 1 from public.stripe_events where event_id = 'evt_p1') or (select count(*) from public.stripe_events where event_id in ('evt_p2', 'evt_p3')) <> 2 then
    raise exception 'accounts_access: prune_stripe_events did not take the oldest event';
  end if;
  if public.prune_stripe_events('2015-01-02T12:00:00Z', 10) <> 1 then
    raise exception 'accounts_access: prune_stripe_events did not stop at its time';
  end if;
  perform pg_temp.expect_error('service_role', $q$select public.prune_stripe_events(null, 1)$q$, '22004');
  perform pg_temp.expect_error('service_role', $q$select public.link_billing_customer(null, 'cus_x')$q$, '22004');
  perform pg_temp.expect_error('service_role', $q$select public.apply_billing_state('cus_probe', 'pro', 'active', null, false, null, null, null)$q$, '22004');
  perform pg_temp.expect_error('service_role', $q$select public.apply_billing_event(null, 't', 'cus_probe', 'pro', 'active', null, false, null, null, now())$q$, '22004');
  perform pg_temp.expect_error('service_role', $q$select public.create_api_key('00000000-0000-4000-8000-0000000000f6', repeat('9', 64), 'beef', null)$q$, '22004');

  select pg_catalog.string_agg(p.proname, ', ') into v_bad
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('billing_json', 'customer_hash', 'prune_stripe_events', 'link_billing_customer', 'apply_billing_state', 'apply_billing_event', 'create_api_key')
    and (p.prosecdef
      or not ('search_path=""' = any (coalesce(p.proconfig, '{}')))
      or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) x where x.grantee = 0)
      or not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'));
  if v_bad is not null or (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('billing_json', 'customer_hash', 'prune_stripe_events', 'link_billing_customer', 'apply_billing_state', 'apply_billing_event', 'create_api_key')) <> 7 then
    raise exception 'accounts_access: billing functions missing, security definer, without search_path = '''', or with wrong EXECUTE: %', coalesce(v_bad, 'missing');
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
