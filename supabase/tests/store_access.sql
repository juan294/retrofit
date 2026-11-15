-- Access test for supabase/migrations/*_store.sql and *_claim_with_lease.sql.
--
-- Run as `postgres` against a disposable stack after the migration:
--   psql "$SUPABASE_GATE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/store_access.sql
-- (tests/db/sql-access.test.ts does this). Everything runs in one transaction
-- that is rolled back, so the database is unchanged. Any failed expectation
-- raises and stops the script; the last line printed on success is
-- "store_access: ok".

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
  raise exception 'store_access: % was not denied: %', p_role, p_sql;
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
    raise exception 'store_access: % was denied or failed (% %): %', p_role, sqlstate, sqlerrm, p_sql;
end;
$$;

-- Every store table and function, as one statement each (sample arguments).
create temp table store_statements (kind text, stmt text);
insert into store_statements values
  ('table', 'select count(*) from public.kv'),
  ('table', 'select count(*) from public.counters'),
  ('table', 'select count(*) from public.leases'),
  ('table', 'select count(*) from public.queue'),
  ('table', $q$insert into public.kv (key, value, version, expires_at) values ('access:t', '1', 1, now() + interval '1 minute')$q$),
  ('table', $q$insert into public.counters (key, window_start, count, expires_at) values ('access:t', now(), 1, now() + interval '1 minute')$q$),
  ('table', $q$insert into public.leases (key, token, expires_at) values ('access:t', gen_random_uuid(), now() + interval '1 minute')$q$),
  ('table', $q$insert into public.queue (queue, item_id, expires_at) values ('access:t', 'x', now() + interval '1 minute')$q$),
  ('table', $q$update public.kv set version = version where key = 'access:t'$q$),
  ('table', $q$update public.counters set count = count where key = 'access:t'$q$),
  ('table', $q$update public.leases set expires_at = expires_at where key = 'access:t'$q$),
  ('table', $q$update public.queue set expires_at = expires_at where queue = 'access:t'$q$),
  ('table', $q$delete from public.kv where key = 'access:none'$q$),
  ('function', $q$select public.store_get('access:f')$q$),
  ('function', $q$select public.store_set('access:f', '{"version": 1}', 60)$q$),
  ('function', $q$select public.store_delete('access:none')$q$),
  ('function', $q$select public.store_put_if_absent('access:p', '1', 60)$q$),
  ('function', $q$select public.store_compare_and_set('access:f', 1, '{"version": 2}', 60)$q$),
  ('function', $q$select public.store_increment_window('access:w', 60, 1)$q$),
  ('function', $q$select public.store_acquire_lease('access:l', 60)$q$),
  ('function', $q$select public.store_renew_lease('access:l', 'not-a-token', 60)$q$),
  ('function', $q$select public.store_release_lease('access:l', 'not-a-token')$q$),
  ('function', $q$select public.store_enqueue('access:q', 'x', 60)$q$),
  ('function', $q$select public.store_claim_next('access:q')$q$),
  ('function', $q$select public.store_claim_with_lease('access:q', array['access:l'], 60)$q$),
  ('function', 'select public.store_cleanup()'),
  ('function', 'select public.store_ttl(60)');

do $$
declare
  r record;
  v_role text;
  v_missing text;
begin
  -- Every store_* function in public is covered by a statement above.
  select pg_catalog.string_agg(p.proname, ', ') into v_missing
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname like 'store\_%'
    and not exists (select 1 from store_statements s where s.stmt like '%public.' || p.proname || '(%');
  if v_missing is not null then
    raise exception 'store_access: functions without an access check: %', v_missing;
  end if;

  -- Denied for anon and authenticated, by privilege, for every statement.
  foreach v_role in array array['anon', 'authenticated'] loop
    for r in select stmt from store_statements loop
      perform pg_temp.expect_denied(v_role, r.stmt);
    end loop;
  end loop;

  -- Allowed for service_role.
  for r in select stmt from store_statements loop
    perform pg_temp.expect_allowed('service_role', r.stmt);
  end loop;
end;
$$;

-- Static checks: privileges, RLS, function settings.
do $$
declare
  v_bad text;
begin
  -- No grant to PUBLIC (grantee 0), anon or authenticated on any store table or sequence.
  select pg_catalog.string_agg(c.relname || ':' || a.privilege_type, ', ') into v_bad
  from pg_catalog.pg_class c
  cross join lateral pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault(case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) a
  where c.relnamespace = 'public'::regnamespace and c.relname in ('kv', 'counters', 'leases', 'queue', 'queue_seq')
    and (a.grantee = 0 or a.grantee in ('anon'::regrole, 'authenticated'::regrole));
  if v_bad is not null then
    raise exception 'store_access: table privileges granted: %', v_bad;
  end if;

  select pg_catalog.string_agg(c.relname, ', ') into v_bad
  from pg_catalog.pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relname in ('kv', 'counters', 'leases', 'queue')
    and (not c.relrowsecurity
      or exists (select 1 from pg_catalog.pg_policy pol where pol.polrelid = c.oid));
  if v_bad is not null then
    raise exception 'store_access: tables without RLS or with a policy: %', v_bad;
  end if;

  select pg_catalog.string_agg(p.proname, ', ') into v_bad
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname like 'store\_%'
    and (p.prosecdef
      or p.proconfig is null
      or not ('search_path=""' = any (p.proconfig))
      or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE')
      or not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'store_access: functions not security invoker, without search_path = '''', or with wrong EXECUTE: %', v_bad;
  end if;

  if pg_catalog.has_sequence_privilege('anon', 'public.queue_seq', 'USAGE')
     or pg_catalog.has_sequence_privilege('authenticated', 'public.queue_seq', 'USAGE') then
    raise exception 'store_access: queue_seq usable by anon or authenticated';
  end if;
end;
$$;

-- Objects created after the migration by the migration owner are not usable by
-- anon or authenticated (default privileges).
create table public.store_access_later (id int);
create sequence public.store_access_later_seq;
create function public.store_access_later_fn() returns int language sql as 'select 1';

do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    perform pg_temp.expect_denied(v_role, 'select * from public.store_access_later');
    perform pg_temp.expect_denied(v_role, 'insert into public.store_access_later values (1)');
    perform pg_temp.expect_denied(v_role, 'update public.store_access_later set id = 2');
    perform pg_temp.expect_denied(v_role, 'select nextval(''public.store_access_later_seq'')');
    perform pg_temp.expect_denied(v_role, 'select public.store_access_later_fn()');
  end loop;
end;
$$;

select 'store_access: ok' as result;
rollback;
