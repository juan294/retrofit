-- Store.claimWithLease (src/lib/store/types.ts): one round trip that claims the
-- oldest live queue item together with the first free lease of a list. Crawl
-- dispatch uses it with the crawl-slot leases, so a dispatch makes one RPC per
-- started job, and one RPC that changes nothing when the queue is empty or
-- every slot is held (validation V16).
--
-- Access contract: as in 20261115120000_store.sql. Only service_role may
-- execute it; anon, authenticated and public get no EXECUTE. It is security
-- invoker with an empty search_path and fully qualified names, and it uses only
-- tables whose privileges and RLS that migration set. Time is the database
-- clock (`now()`).

create function public.store_claim_with_lease(p_queue text, p_lease_keys text[], p_ttl_seconds double precision)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_len interval := public.store_ttl(p_ttl_seconds);
  v_item text;
  v_key text;
  v_token uuid;
begin
  delete from public.queue where queue = p_queue and expires_at <= pg_catalog.now();
  for i in 1..3 loop
    -- The oldest live item, locked; a concurrent claim skips it and takes the next one.
    select q.item_id into v_item from public.queue q
      where q.queue = p_queue and q.expires_at > pg_catalog.now()
      order by q.seq
      limit 1
      for update skip locked;
    exit when v_item is not null;
    -- Every live item is locked by a concurrent claim. That claim may find no free lease (it
    -- looked before a worker released one), so wait for it instead of returning null, or a
    -- queued job could wait for the next request while a slot is free. A row this transaction
    -- locks here is not skipped on the next round.
    exit when not exists (select 1 from public.queue q where q.queue = p_queue and q.expires_at > pg_catalog.now());
    perform 1 from public.queue q
      where q.queue = p_queue and q.expires_at > pg_catalog.now()
      order by q.seq
      limit 1
      for update;
  end loop;
  if v_item is null then
    return null;
  end if;
  -- Candidate leases in the given order, skipping live ones without locking them. The insert
  -- re-checks under the row lock, so a lease taken meanwhile is a miss, never a second owner.
  for v_key in
    select u.k from pg_catalog.unnest(coalesce(p_lease_keys, array[]::text[])) with ordinality as u(k, n)
    where not exists (select 1 from public.leases l where l.key = u.k and l.expires_at > pg_catalog.now())
    order by u.n
  loop
    insert into public.leases as t (key, token, expires_at)
    values (v_key, pg_catalog.gen_random_uuid(), pg_catalog.now() + v_len)
    on conflict (key) do update
      set token = excluded.token, expires_at = excluded.expires_at
      where t.expires_at <= pg_catalog.now()
    returning t.token into v_token;
    if v_token is not null then
      delete from public.queue where queue = p_queue and item_id = v_item;
      return pg_catalog.jsonb_build_object('itemId', v_item, 'leaseKey', v_key, 'token', v_token::text);
    end if;
  end loop;
  -- No free lease: the item stays queued (its row lock ends with the transaction).
  return null;
end;
$$;

revoke all on function public.store_claim_with_lease(text, text[], double precision) from public, anon, authenticated;
grant execute on function public.store_claim_with_lease(text, text[], double precision) to service_role;
