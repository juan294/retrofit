-- The daily recheck's order (src/lib/claims/recheck.ts). A check that could not be made records no result, so
-- by last_checked_at alone such claims would stay first in every run and starve the claims behind them.
-- last_attempt_at orders them behind; which claims are due is still decided by last_checked_at.

alter table public.site_claims add column last_attempt_at timestamptz;

drop index public.site_claims_due;
create index site_claims_due on public.site_claims (status, (greatest(last_checked_at, last_attempt_at)) nulls first) where status in ('verified', 'lapsed');

-- The same signature and access as before (20261123150000_claims.sql); only the order changes.
create or replace function public.claims_due(p_checked_before timestamptz, p_slow_lapsed_before timestamptz, p_slow_checked_before timestamptz, p_limit integer)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  -- Each branch is ordered and limited on its own, so the site_claims_due index serves it.
  select coalesce(pg_catalog.jsonb_agg(public.claim_json(d.claim) order by d.rank, d.tried nulls first, d.id), '[]'::jsonb)
  from (
    (select c as claim, 0 as rank, greatest(c.last_checked_at, c.last_attempt_at) as tried, c.id
     from public.site_claims c
     where c.status = 'verified' and (c.last_checked_at is null or c.last_checked_at < p_checked_before)
     order by greatest(c.last_checked_at, c.last_attempt_at) nulls first, c.id
     limit greatest(p_limit, 0))
    union all
    (select c, 1, greatest(c.last_checked_at, c.last_attempt_at), c.id
     from public.site_claims c
     where c.status = 'lapsed' and (c.last_checked_at is null or c.last_checked_at <
       case when c.lapsed_at < p_slow_lapsed_before then least(p_checked_before, p_slow_checked_before) else p_checked_before end)
     order by greatest(c.last_checked_at, c.last_attempt_at) nulls first, c.id
     limit greatest(p_limit, 0))
    order by 2, 3 nulls first, 4
    limit greatest(p_limit, 0)
  ) d;
$$;
