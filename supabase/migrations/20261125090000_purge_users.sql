-- Sign-in users without an account. Asking for a sign-in link creates an auth user with the typed address
-- (AuthGateway signInWithOtp), also when a stranger typed it; opening a link and choosing Cancel confirms the
-- address and creates no account. The daily cleanup deletes such a user once its link can no longer work and
-- nothing in Retrofit belongs to it.
--
-- Security definer: service_role has no privileges on auth.users. The function is the whole surface: an empty
-- search_path, no dynamic SQL, one statement that selects and deletes the same rows, EXECUTE for service_role
-- only. A user with an account profile, or any other account row, is never selected, so no row that belongs to an
-- account can cascade.
create function public.purge_users_without_account(p_before timestamptz, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_before is null or p_limit is null then
    raise exception 'purge_users_without_account: every argument is required' using errcode = '22004';
  end if;
  if p_before > pg_catalog.now() - interval '2 hours' then
    raise exception 'purge_users_without_account: p_before must be at least 2 hours ago (a link works for one hour)' using errcode = '22023';
  end if;
  delete from auth.users u
  where u.id in (
    select c.id
    from auth.users c
    where greatest(c.created_at, c.confirmation_sent_at, c.recovery_sent_at, c.email_confirmed_at, c.last_sign_in_at) < p_before
      and not exists (select 1 from public.account_profiles p where p.account_id = c.id)
      and not exists (select 1 from public.billing_customers b where b.account_id = c.id)
      and not exists (select 1 from public.site_claims s where s.account_id = c.id)
      and not exists (select 1 from public.saved_reports r where r.account_id = c.id)
      and not exists (select 1 from public.api_keys k where k.account_id = c.id)
    order by c.created_at
    limit greatest(p_limit, 0)
    for update skip locked
  );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_users_without_account(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.purge_users_without_account(timestamptz, integer) to service_role;
