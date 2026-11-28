-- Saved reports, once each and at most a fixed number per account (src/lib/accounts/data.ts
-- saveReport). A report is identified by (account, host, fetched_at): saving it again returns the
-- first copy. save_report serializes one account's saves with a transaction-scoped advisory lock,
-- so the count check and the insert cannot race across server instances.
--
-- Access contract, as for delete_account_data: security invoker with an empty search_path,
-- EXECUTE for service_role only.

alter table public.saved_reports
  add constraint saved_reports_once unique (account_id, host, fetched_at);

create function public.save_report(p_account_id uuid, p_host text, p_report jsonb, p_fetched_at timestamptz, p_max integer)
returns table (id uuid, host text, fetched_at timestamptz, created_at timestamptz, score jsonb, outcome text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_count integer;
begin
  if p_account_id is null or p_host is null or p_report is null or p_fetched_at is null or p_max is null then
    raise exception 'save_report: every argument is required' using errcode = '22004';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('save_report:' || p_account_id::text, 0));

  return query
    select r.id, r.host, r.fetched_at, r.created_at, r.report -> 'score', 'existing'::text
    from public.saved_reports r
    where r.account_id = p_account_id and r.host = p_host and r.fetched_at = p_fetched_at;
  if found then
    return;
  end if;

  select count(*) into v_count from public.saved_reports r where r.account_id = p_account_id;
  if v_count >= p_max then
    return query select null::uuid, null::text, null::timestamptz, null::timestamptz, null::jsonb, 'full'::text;
    return;
  end if;

  return query
    insert into public.saved_reports as r (account_id, host, report, fetched_at)
    values (p_account_id, p_host, p_report, p_fetched_at)
    returning r.id, r.host, r.fetched_at, r.created_at, r.report -> 'score', 'created'::text;
end;
$$;

revoke all on function public.save_report(uuid, text, jsonb, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.save_report(uuid, text, jsonb, timestamptz, integer) to service_role;
