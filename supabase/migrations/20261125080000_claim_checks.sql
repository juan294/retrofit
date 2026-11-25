-- A failed check that a visitor starts on a verified claim (src/lib/api/claims.ts Check again) is shown to the
-- owner and changes nothing else: it raises no failures, so clicks during a short outage never lapse the claim,
-- and it leaves last_checked_at, so claims_due still lists the claim for the daily recheck and the owner of a
-- lost claim cannot hold it verified. visitor_checked_at is when that check ran, for display only.
--
-- record_claim_failure gets p_visitor (the row's status is read under its lock, so a check that raced a lapse or
-- a pass counts by the claim's state now). Its default, false, is a check that counts, as before. The old signature
-- is dropped; the access contract is the same: security invoker, empty search_path, EXECUTE for service_role only.

alter table public.site_claims add column visitor_checked_at timestamptz;

drop function public.record_claim_failure(uuid, text, text, integer, timestamptz, integer);

create function public.record_claim_failure(
  p_claim_id uuid, p_token_hash text, p_result text, p_detail integer, p_now timestamptz, p_lapse_after integer, p_visitor boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim public.site_claims;
  v_lapses boolean;
begin
  if p_claim_id is null or p_token_hash is null or p_result is null or p_now is null or p_lapse_after is null or p_visitor is null then
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
  if p_visitor and v_claim.status = 'verified' then
    update public.site_claims c
    set visitor_checked_at = p_now, last_result = p_result, last_detail = p_detail
    where c.id = p_claim_id
    returning * into v_claim;
    return pg_catalog.jsonb_build_object('outcome', 'updated', 'claim', public.claim_json(v_claim));
  end if;
  v_lapses := v_claim.status in ('verified', 'lapsed') and v_claim.failures + 1 >= p_lapse_after;
  update public.site_claims c
  set failures = c.failures + 1, last_checked_at = p_now, last_result = p_result, last_detail = p_detail,
      status = case when v_lapses then 'lapsed' else c.status end,
      lapsed_at = case when v_lapses then coalesce(c.lapsed_at, p_now) else null end
  where c.id = p_claim_id
  returning * into v_claim;
  return pg_catalog.jsonb_build_object('outcome', 'updated', 'claim', public.claim_json(v_claim));
end;
$$;

revoke all on function public.record_claim_failure(uuid, text, text, integer, timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.record_claim_failure(uuid, text, text, integer, timestamptz, integer, boolean) to service_role;
