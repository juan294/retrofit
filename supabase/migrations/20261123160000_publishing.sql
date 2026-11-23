-- Retrofit-hosted publishing (src/lib/publish/*, src/lib/accounts/data.ts published-site methods).
--
-- One rule decides whether a site is public: public.site_is_public. Its publication exists and its
-- claim is verified now, for that host, and held by the publication's account. The page, its files,
-- the badge and the sitemap read it through public_site and public_hosts, each in one round trip.
--
-- publish_site writes a publication in one transaction that checks the claim again: it takes the
-- host lock that verify_claim takes and locks the claim row that record_claim_failure locks, so a
-- publish that races a transfer or a lapse never leaves another account's snapshot public.
--
-- verify_claim (replaced here) also deletes every publication of the host under another claim when
-- it verifies one. A superseded claim is terminal, so its publication could not come back anyway;
-- a publication paused by a lapsed claim that was started over (pending, not superseded) could.
--
-- Access contract, as for delete_account_data: security invoker with an empty search_path,
-- EXECUTE for service_role only.

alter table public.published_sites
  -- When Retrofit read the site: a refresh must be newer. publish_site always sets it; a column, so no read opens the snapshot for it.
  add column fetched_at timestamptz not null default now(),
  -- The code of the last failed refresh, never page text.
  add constraint published_sites_refresh_error check (last_refresh_error in ('no_analysis', 'not_newer', 'generation_failed', 'too_large')),
  add constraint published_sites_host check (host = lower(host) and length(host) between 1 and 253),
  -- Twice the application's limits (MAX_PUBLISHED_SNAPSHOT_BYTES, MAX_REPORT_BYTES): jsonb text has extra spaces.
  add constraint published_sites_snapshot_size check (octet_length(snapshot::text) <= 4194304),
  add constraint published_sites_report_size check (octet_length(report::text) <= 524288);

-- The one public rule. Scalars, not the row: a whole row would load its snapshot.
create function public.site_is_public(p_claim_id uuid, p_account_id uuid, p_host text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.site_claims c
    where c.id = p_claim_id and c.account_id = p_account_id and c.host = p_host and c.status = 'verified'
  );
$$;

-- The public site of p_host, or null; p_part 'report' or 'snapshot' adds that column, anything else adds neither.
create function public.public_site(p_host text, p_part text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
      'host', s.host, 'fetched_at', s.fetched_at, 'published_at', s.published_at, 'refreshed_at', s.refreshed_at, 'score', s.report -> 'score')
    || case p_part
         when 'report' then pg_catalog.jsonb_build_object('report', s.report)
         when 'snapshot' then pg_catalog.jsonb_build_object('snapshot', s.snapshot)
         else '{}'::jsonb
       end
  from public.published_sites s
  where s.host = p_host and public.site_is_public(s.claim_id, s.account_id, s.host);
$$;

-- Hosts with a public site, the most recently refreshed first, at most p_limit.
create function public.public_hosts(p_limit integer)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(h.host order by h.refreshed_at desc, h.host), '[]'::jsonb)
  from (
    select s.host, s.refreshed_at
    from public.published_sites s
    where public.site_is_public(s.claim_id, s.account_id, s.host)
    order by s.refreshed_at desc, s.host
    limit greatest(p_limit, 0)
  ) h;
$$;

create function public.publish_site(p_account_id uuid, p_host text, p_snapshot jsonb, p_report jsonb, p_fetched_at timestamptz, p_now timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim_id uuid;
  v_status text;
  v_fetched_at timestamptz;
  v_mine boolean;
  v_site jsonb;
begin
  if p_account_id is null or p_host is null or p_snapshot is null or p_report is null or p_fetched_at is null or p_now is null then
    raise exception 'publish_site: every argument is required' using errcode = '22004';
  end if;
  -- The host's verifications and publishes run one at a time; then the claim is read under its row lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('site_claims_host:' || p_host, 0));
  select c.id, c.status into v_claim_id, v_status
  from public.site_claims c
  where c.account_id = p_account_id and c.host = p_host
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'no_claim');
  end if;
  if v_status <> 'verified' then
    return pg_catalog.jsonb_build_object('outcome', 'not_verified');
  end if;

  select s.fetched_at into v_fetched_at
  from public.published_sites s
  where s.host = p_host and s.account_id = p_account_id
  for update;
  v_mine := found;
  if v_mine and v_fetched_at >= p_fetched_at then
    return pg_catalog.jsonb_build_object('outcome', 'not_newer');
  end if;

  -- A publication of another account for the host is replaced whole.
  insert into public.published_sites as s (host, account_id, claim_id, snapshot, report, fetched_at, published_at, refreshed_at, last_refresh_error)
  values (p_host, p_account_id, v_claim_id, p_snapshot, p_report, p_fetched_at, p_now, p_now, null)
  on conflict (host) do update
  set account_id = excluded.account_id, claim_id = excluded.claim_id, snapshot = excluded.snapshot, report = excluded.report,
      fetched_at = excluded.fetched_at, published_at = case when v_mine then s.published_at else excluded.published_at end,
      refreshed_at = excluded.refreshed_at, last_refresh_error = null
  returning pg_catalog.jsonb_build_object(
    'host', s.host, 'claim_id', s.claim_id, 'fetched_at', s.fetched_at, 'published_at', s.published_at, 'refreshed_at', s.refreshed_at,
    'last_refresh_error', s.last_refresh_error, 'score', s.report -> 'score')
  into v_site;
  return pg_catalog.jsonb_build_object('outcome', case when v_mine then 'refreshed' else 'published' end, 'site', v_site);
end;
$$;

-- As in *_claims.sql, plus the deletion of other claims' publications of the host.
create or replace function public.verify_claim(p_claim_id uuid, p_token_hash text, p_now timestamptz)
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

  -- The host moves, and every publication of it under another claim ends.
  with moved as (
    update public.site_claims c
    set status = 'superseded', superseded_at = p_now, superseded_by = v_claim.account_id, lapsed_at = null
    where c.host = v_claim.host and c.id <> v_claim.id and c.status in ('verified', 'lapsed')
    returning c.account_id
  )
  select coalesce(pg_catalog.array_agg(m.account_id), '{}') into v_moved from moved m;
  delete from public.published_sites s where s.host = v_claim.host and s.claim_id <> v_claim.id;

  update public.site_claims c
  set status = 'verified', verified_at = case when c.status = 'verified' then c.verified_at else p_now end,
      last_checked_at = p_now, failures = 0, last_result = 'verified', last_detail = null, lapsed_at = null
  where c.id = p_claim_id
  returning * into v_claim;
  return pg_catalog.jsonb_build_object('outcome', 'verified', 'claim', public.claim_json(v_claim), 'moved_from', pg_catalog.to_jsonb(v_moved));
end;
$$;

revoke all on function public.site_is_public(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.public_site(text, text) from public, anon, authenticated;
revoke all on function public.public_hosts(integer) from public, anon, authenticated;
revoke all on function public.publish_site(uuid, text, jsonb, jsonb, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.verify_claim(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.site_is_public(uuid, uuid, text) to service_role;
grant execute on function public.public_site(text, text) to service_role;
grant execute on function public.public_hosts(integer) to service_role;
grant execute on function public.publish_site(uuid, text, jsonb, jsonb, timestamptz, timestamptz) to service_role;
grant execute on function public.verify_claim(uuid, text, timestamptz) to service_role;
