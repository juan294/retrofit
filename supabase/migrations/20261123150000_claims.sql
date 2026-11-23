-- Ownership claims (src/lib/claims/*, src/lib/accounts/data.ts claim methods): the latest check's
-- result on each claim, and four functions that change claims atomically.
--
-- create_claim and restart_claim serialize one account's claim changes with a transaction-scoped
-- advisory lock, so the pending-claim limit holds across server instances. verify_claim serializes
-- one host's verifications the same way: in one transaction every other account's verified or
-- lapsed claim for the host becomes superseded (superseded_at, superseded_by = the verifying
-- account) and the verifying claim becomes verified, so the partial unique index (one verified
-- claim per host) never refuses a move. A superseded claim is terminal: no function changes it.
-- verify_claim and record_claim_failure apply a check only when the claim's token hash still
-- equals the one the check compared with, so a check that raced Start over changes nothing.
--
-- Access contract, as for delete_account_data: security invoker with an empty search_path,
-- EXECUTE for service_role only. Every function returns jsonb {outcome, claim} where claim is the
-- row without superseded_by.

alter table public.site_claims
  add column last_result text
    constraint site_claims_last_result check (last_result in (
      'verified', 'tag_missing', 'tag_mismatch', 'robots_blocked', 'robots_unavailable', 'redirected', 'http_status',
      'not_html', 'timeout', 'not_public', 'fetch_failed', 'record_missing', 'record_mismatch', 'dns_failed')),
  add column last_detail integer;

-- The daily recheck reads verified and lapsed claims, least recently checked first.
create index site_claims_due on public.site_claims (last_checked_at nulls first) where status in ('verified', 'lapsed');

-- The claim as the functions return it.
create function public.claim_json(p_claim public.site_claims)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select pg_catalog.to_jsonb(p_claim) - 'superseded_by';
$$;

create function public.create_claim(p_account_id uuid, p_host text, p_method text, p_token_hash text, p_max_pending integer)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim public.site_claims;
  v_pending integer;
begin
  if p_account_id is null or p_host is null or p_method is null or p_token_hash is null or p_max_pending is null then
    raise exception 'create_claim: every argument is required' using errcode = '22004';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('site_claims_account:' || p_account_id::text, 0));

  select * into v_claim from public.site_claims c where c.account_id = p_account_id and c.host = p_host;
  if found then
    return pg_catalog.jsonb_build_object('outcome', 'exists', 'claim', public.claim_json(v_claim));
  end if;
  select count(*) into v_pending from public.site_claims c where c.account_id = p_account_id and c.status = 'pending';
  if v_pending >= p_max_pending then
    return pg_catalog.jsonb_build_object('outcome', 'full');
  end if;
  insert into public.site_claims (account_id, host, method, token_hash)
  values (p_account_id, p_host, p_method, p_token_hash)
  returning * into v_claim;
  return pg_catalog.jsonb_build_object('outcome', 'created', 'claim', public.claim_json(v_claim));
end;
$$;

create function public.restart_claim(p_claim_id uuid, p_account_id uuid, p_method text, p_token_hash text, p_max_pending integer)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim public.site_claims;
  v_pending integer;
begin
  if p_claim_id is null or p_account_id is null or p_method is null or p_token_hash is null or p_max_pending is null then
    raise exception 'restart_claim: every argument is required' using errcode = '22004';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('site_claims_account:' || p_account_id::text, 0));

  select * into v_claim from public.site_claims c where c.id = p_claim_id and c.account_id = p_account_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'missing');
  end if;
  if v_claim.status in ('verified', 'superseded') then
    return pg_catalog.jsonb_build_object('outcome', v_claim.status, 'claim', public.claim_json(v_claim));
  end if;
  if v_claim.status <> 'pending' then
    select count(*) into v_pending from public.site_claims c where c.account_id = p_account_id and c.status = 'pending';
    if v_pending >= p_max_pending then
      return pg_catalog.jsonb_build_object('outcome', 'full');
    end if;
  end if;
  update public.site_claims c
  set method = p_method, token_hash = p_token_hash, status = 'pending', verified_at = null, last_checked_at = null,
      failures = 0, last_result = null, last_detail = null
  where c.id = p_claim_id
  returning * into v_claim;
  return pg_catalog.jsonb_build_object('outcome', 'restarted', 'claim', public.claim_json(v_claim));
end;
$$;

create function public.record_claim_failure(p_claim_id uuid, p_token_hash text, p_result text, p_detail integer, p_now timestamptz, p_lapse_after integer)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim public.site_claims;
begin
  if p_claim_id is null or p_token_hash is null or p_result is null or p_now is null or p_lapse_after is null then
    raise exception 'record_claim_failure: every argument except p_detail is required' using errcode = '22004';
  end if;
  if p_result = 'verified' then
    raise exception 'record_claim_failure: a failure cannot have the result verified' using errcode = '22023';
  end if;

  select * into v_claim from public.site_claims c where c.id = p_claim_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'missing');
  end if;
  if v_claim.status = 'superseded' then
    return pg_catalog.jsonb_build_object('outcome', 'superseded', 'claim', public.claim_json(v_claim));
  end if;
  if v_claim.token_hash <> p_token_hash then
    return pg_catalog.jsonb_build_object('outcome', 'stale', 'claim', public.claim_json(v_claim));
  end if;
  update public.site_claims c
  set failures = c.failures + 1, last_checked_at = p_now, last_result = p_result, last_detail = p_detail,
      status = case when c.status in ('verified', 'lapsed') and c.failures + 1 >= p_lapse_after then 'lapsed' else c.status end
  where c.id = p_claim_id
  returning * into v_claim;
  return pg_catalog.jsonb_build_object('outcome', 'updated', 'claim', public.claim_json(v_claim));
end;
$$;

create function public.verify_claim(p_claim_id uuid, p_token_hash text, p_now timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim public.site_claims;
  v_moved uuid[];
begin
  if p_claim_id is null or p_token_hash is null or p_now is null then
    raise exception 'verify_claim: every argument is required' using errcode = '22004';
  end if;

  select * into v_claim from public.site_claims c where c.id = p_claim_id;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'missing');
  end if;
  -- One host's verifications run one at a time; then read the claim again under the lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('site_claims_host:' || v_claim.host, 0));
  select * into v_claim from public.site_claims c where c.id = p_claim_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'missing');
  end if;
  if v_claim.status = 'superseded' then
    return pg_catalog.jsonb_build_object('outcome', 'superseded', 'claim', public.claim_json(v_claim));
  end if;
  if v_claim.token_hash <> p_token_hash then
    return pg_catalog.jsonb_build_object('outcome', 'stale', 'claim', public.claim_json(v_claim));
  end if;

  -- The host moves. Phase 4: the published sites of the superseded claims are paused here.
  with moved as (
    update public.site_claims c
    set status = 'superseded', superseded_at = p_now, superseded_by = v_claim.account_id
    where c.host = v_claim.host and c.id <> v_claim.id and c.status in ('verified', 'lapsed')
    returning c.account_id
  )
  select coalesce(pg_catalog.array_agg(m.account_id), '{}') into v_moved from moved m;

  update public.site_claims c
  set status = 'verified', verified_at = case when c.status = 'verified' then c.verified_at else p_now end,
      last_checked_at = p_now, failures = 0, last_result = 'verified', last_detail = null
  where c.id = p_claim_id
  returning * into v_claim;
  return pg_catalog.jsonb_build_object('outcome', 'verified', 'claim', public.claim_json(v_claim), 'moved_from', pg_catalog.to_jsonb(v_moved));
end;
$$;

revoke all on function public.claim_json(public.site_claims) from public, anon, authenticated;
revoke all on function public.create_claim(uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.restart_claim(uuid, uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.record_claim_failure(uuid, text, text, integer, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.verify_claim(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_json(public.site_claims) to service_role;
grant execute on function public.create_claim(uuid, text, text, text, integer) to service_role;
grant execute on function public.restart_claim(uuid, uuid, text, text, integer) to service_role;
grant execute on function public.record_claim_failure(uuid, text, text, integer, timestamptz, integer) to service_role;
grant execute on function public.verify_claim(uuid, text, timestamptz) to service_role;
