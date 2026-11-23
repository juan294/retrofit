-- Account deletion (src/lib/accounts/delete.ts): one function that deletes every row an account
-- owns in one transaction, so a failure deletes nothing and a retry is safe. Account deletion calls
-- it before it deletes the Supabase Auth user (whose foreign keys would cascade the same rows).
--
-- Access contract, as for the store functions (*_store.sql): security invoker with an empty
-- search_path, EXECUTE for service_role only. The store migration's default privileges already
-- keep new functions away from PUBLIC, anon and authenticated; the revoke below repeats it.

create function public.delete_account_data(p_account_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_account_id is null then
    raise exception 'delete_account_data: account id is required' using errcode = '22004';
  end if;
  -- Children first: published_sites references site_claims.
  delete from public.published_sites where account_id = p_account_id;
  delete from public.site_claims where account_id = p_account_id;
  delete from public.saved_reports where account_id = p_account_id;
  delete from public.api_keys where account_id = p_account_id;
  delete from public.billing_customers where account_id = p_account_id;
  delete from public.account_profiles where account_id = p_account_id;
end;
$$;

revoke all on function public.delete_account_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_account_data(uuid) to service_role;
