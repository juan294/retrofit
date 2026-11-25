-- Access test for supabase/migrations/*_purge_users.sql. Run as `postgres` against a disposable stack
-- (tests/db/purge.db.test.ts does). One transaction, rolled back; the last line on success is "purge_access: ok".

\set ON_ERROR_STOP on
\set QUIET on
begin;

do $$
declare
  v_old timestamptz := pg_catalog.now() - interval '2 days';
  v_left text;
begin
  -- The only security definer function of the project: an empty search_path, and EXECUTE for service_role only.
  if (select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'purge_users_without_account'
      and p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}'))
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) x where x.grantee = 0)
      and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) <> 1 then
    raise exception 'purge_access: the function is missing, has another search_path, or has the wrong EXECUTE grants';
  end if;
  if (select pg_catalog.string_agg(p.proname, ', ') from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proname <> 'purge_users_without_account') is not null then
    raise exception 'purge_access: another security definer function exists in public';
  end if;

  insert into auth.users (id, email, created_at, confirmation_sent_at, recovery_sent_at, email_confirmed_at, last_sign_in_at) values
    ('00000000-0000-4000-8000-00000000d001', 'stranger@example.test', v_old, v_old, null, null, null),
    ('00000000-0000-4000-8000-00000000d002', 'cancelled@example.test', v_old, v_old, null, v_old, v_old),
    ('00000000-0000-4000-8000-00000000d003', 'just-signed-in@example.test', v_old, v_old, null, v_old, pg_catalog.now()),
    ('00000000-0000-4000-8000-00000000d004', 'profile@example.test', v_old, v_old, null, null, null),
    ('00000000-0000-4000-8000-00000000d005', 'new-link@example.test', v_old, v_old, pg_catalog.now() - interval '10 minutes', null, null),
    ('00000000-0000-4000-8000-00000000d006', 'recent@example.test', pg_catalog.now(), pg_catalog.now(), null, null, null),
    ('00000000-0000-4000-8000-00000000d007', 'never-mailed@example.test', v_old, null, null, null, null),
    ('00000000-0000-4000-8000-00000000d008', 'claim@example.test', v_old, v_old, null, v_old, v_old);
  insert into public.site_claims (account_id, host, method, token_hash) values ('00000000-0000-4000-8000-00000000d008', 'purge.example', 'dns', repeat('a', 64));
  insert into public.account_profiles (account_id) values ('00000000-0000-4000-8000-00000000d004');

  set local role service_role;
  if public.purge_users_without_account(pg_catalog.now() - interval '1 day', 0) <> 0 then
    raise exception 'purge_access: p_limit 0 deleted users';
  end if;
  perform public.purge_users_without_account(pg_catalog.now() - interval '1 day', 1000);
  begin
    perform public.purge_users_without_account(pg_catalog.now() - interval '1 hour', 10);
    raise exception 'purge_access: a user whose link can still work was purged';
  exception when invalid_parameter_value then
    null;
  end;
  reset role;

  select pg_catalog.string_agg(pg_catalog.right(u.id::text, 1), ',' order by u.id) into v_left
  from auth.users u where u.id::text like '00000000-0000-4000-8000-00000000d00_';
  if v_left is distinct from '3,4,5,6,8' then
    raise exception 'purge_access: the wrong users are left: %', v_left;
  end if;
end;
$$;

select 'purge_access: ok' as result;
rollback;
