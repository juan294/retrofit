-- Retrofit Store (src/lib/store/types.ts) on Postgres.
--
-- Access contract: only `service_role` (the server, through PostgREST rpc) may
-- read, write or execute anything here. `anon`, `authenticated` and `public`
-- get no table privilege and no EXECUTE. RLS is enabled on every table with no
-- policy, so a privilege granted by mistake still exposes no row (service_role
-- bypasses RLS).
--
-- Every operation, including get, set and delete, is a function, so the
-- adapter needs no table privilege beyond what the functions use, every read
-- ignores expired rows in one place and every multi-step operation is one
-- transaction. Functions are `security invoker` with an empty search_path and
-- fully qualified names. Time is the database clock (`now()`).
--
-- Expired rows: every read skips them; reads of one key delete that key's
-- expired row; `store_cleanup()` deletes all expired rows (daily cron).

-- Default privileges first, so objects created by this migration and later
-- ones by the same owner are not granted to anon or authenticated. Supabase
-- grants ALL on new public tables, sequences and functions to anon and
-- authenticated through `postgres` default privileges; PostgreSQL grants
-- EXECUTE on every new function to PUBLIC.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, public;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, public;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, public;
alter default privileges for role postgres revoke execute on functions from public;

-- Tables ---------------------------------------------------------------------

create table public.kv (
  key text primary key,
  value jsonb not null,
  -- Write counter of the row (1 on create, +1 on each write). compareAndSet
  -- compares the `version` field inside `value`, which is the Store contract.
  version bigint not null,
  expires_at timestamptz not null
);

create table public.counters (
  key text,
  window_start timestamptz,
  count bigint not null,
  -- The window ends here. The Store contract starts a window at its first
  -- increment and keeps that end for later calls (src/lib/store/memory.ts), and
  -- callers pass a window length that shrinks toward an aligned end
  -- (src/lib/fetch/limits.ts ttlUntil), so the end is stored, not derived.
  expires_at timestamptz not null,
  primary key (key, window_start)
);

create table public.leases (
  key text primary key,
  token uuid not null,
  expires_at timestamptz not null
);

create sequence public.queue_seq;

create table public.queue (
  queue text not null,
  item_id text not null,
  seq bigint not null default nextval('public.queue_seq'),
  expires_at timestamptz not null,
  primary key (queue, item_id)
);

create index queue_order on public.queue (queue, seq);
create index kv_expires_at on public.kv (expires_at);
create index counters_expires_at on public.counters (expires_at);
create index leases_expires_at on public.leases (expires_at);
create index queue_expires_at on public.queue (expires_at);

alter table public.kv enable row level security;
alter table public.counters enable row level security;
alter table public.leases enable row level security;
alter table public.queue enable row level security;

-- Helpers --------------------------------------------------------------------

create function public.store_ttl(p_seconds double precision)
returns interval
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if p_seconds is null or p_seconds <= 0 or p_seconds = 'Infinity'::double precision or p_seconds = 'NaN'::double precision then
    raise exception 'ttl must be a positive number of seconds' using errcode = '22023';
  end if;
  return pg_catalog.make_interval(secs => p_seconds);
end;
$$;

-- get, set, delete -----------------------------------------------------------

create function public.store_get(p_key text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_value jsonb;
begin
  delete from public.kv where key = p_key and expires_at <= pg_catalog.now();
  select value into v_value from public.kv where key = p_key and expires_at > pg_catalog.now();
  return v_value;
end;
$$;

create function public.store_set(p_key text, p_value jsonb, p_ttl_seconds double precision)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.kv as t (key, value, version, expires_at)
  values (p_key, coalesce(p_value, 'null'::jsonb), 1, pg_catalog.now() + public.store_ttl(p_ttl_seconds))
  on conflict (key) do update
    set value = excluded.value, version = t.version + 1, expires_at = excluded.expires_at;
end;
$$;

create function public.store_delete(p_key text)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.kv where key = p_key;
$$;

-- putIfAbsent: one statement; the conflict branch overwrites only an expired row.
create function public.store_put_if_absent(p_key text, p_value jsonb, p_ttl_seconds double precision)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_value jsonb;
begin
  -- A live row that a concurrent delete removes between the two statements
  -- makes the SELECT find nothing; the next round then creates the value.
  for i in 1..3 loop
    insert into public.kv as t (key, value, version, expires_at)
    values (p_key, coalesce(p_value, 'null'::jsonb), 1, pg_catalog.now() + public.store_ttl(p_ttl_seconds))
    on conflict (key) do update
      set value = excluded.value, version = t.version + 1, expires_at = excluded.expires_at
      where t.expires_at <= pg_catalog.now()
    returning t.value into v_value;
    if found then
      return pg_catalog.jsonb_build_object('created', true, 'value', v_value);
    end if;
    select value into v_value from public.kv where key = p_key and expires_at > pg_catalog.now();
    if found then
      return pg_catalog.jsonb_build_object('created', false, 'value', v_value);
    end if;
  end loop;
  raise exception 'put_if_absent did not settle' using errcode = '40001';
end;
$$;

-- compareAndSet: the row lock of the UPDATE makes concurrent writers serialize;
-- a loser re-checks the version against the winner's row and matches nothing.
create function public.store_compare_and_set(p_key text, p_expected_version numeric, p_next jsonb, p_ttl_seconds double precision)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_next is null or p_next -> 'version' is distinct from pg_catalog.to_jsonb(p_expected_version + 1) then
    raise exception 'next.version must be expected.version + 1' using errcode = '22023';
  end if;
  delete from public.kv where key = p_key and expires_at <= pg_catalog.now();
  update public.kv
    set value = p_next, version = version + 1, expires_at = pg_catalog.now() + public.store_ttl(p_ttl_seconds)
    where key = p_key
      and expires_at > pg_catalog.now()
      and pg_catalog.jsonb_typeof(value -> 'version') = 'number'
      and value -> 'version' = pg_catalog.to_jsonb(p_expected_version);
  return found;
end;
$$;

-- incrementWindow: a transaction advisory lock per key serializes the
-- read-modify-write, so two first increments never open two windows.
create function public.store_increment_window(p_key text, p_window_seconds double precision, p_by bigint default 1)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count bigint;
  v_len interval := public.store_ttl(p_window_seconds);
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('retrofit.counters:' || p_key, 0));
  delete from public.counters where key = p_key and expires_at <= pg_catalog.now();
  update public.counters set count = count + p_by
    where key = p_key and expires_at > pg_catalog.now()
    returning count into v_count;
  if not found then
    insert into public.counters (key, window_start, count, expires_at)
    values (p_key, pg_catalog.now(), p_by, pg_catalog.now() + v_len)
    returning count into v_count;
  end if;
  return v_count;
end;
$$;

-- Leases ---------------------------------------------------------------------

create function public.store_acquire_lease(p_key text, p_ttl_seconds double precision)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_token uuid;
begin
  insert into public.leases as t (key, token, expires_at)
  values (p_key, pg_catalog.gen_random_uuid(), pg_catalog.now() + public.store_ttl(p_ttl_seconds))
  on conflict (key) do update
    set token = excluded.token, expires_at = excluded.expires_at
    where t.expires_at <= pg_catalog.now()
  returning t.token into v_token;
  return v_token::text;
end;
$$;

-- Tokens are compared as text, so a malformed token is a mismatch, not an error.
create function public.store_renew_lease(p_key text, p_token text, p_ttl_seconds double precision)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.leases set expires_at = pg_catalog.now() + public.store_ttl(p_ttl_seconds)
    where key = p_key and token::text = p_token and expires_at > pg_catalog.now();
  return found;
end;
$$;

create function public.store_release_lease(p_key text, p_token text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.leases where key = p_key and token::text = p_token and expires_at > pg_catalog.now();
  return found;
end;
$$;

-- Queues ---------------------------------------------------------------------

-- A live item keeps its place; an expired entry for the same item is replaced
-- and moves to the back.
create function public.store_enqueue(p_queue text, p_item_id text, p_ttl_seconds double precision)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.queue where queue = p_queue and expires_at <= pg_catalog.now();
  insert into public.queue as t (queue, item_id, expires_at)
  values (p_queue, p_item_id, pg_catalog.now() + public.store_ttl(p_ttl_seconds))
  on conflict (queue, item_id) do update
    set seq = excluded.seq, expires_at = excluded.expires_at
    where t.expires_at <= pg_catalog.now();
end;
$$;

-- `for update skip locked`: concurrent claims lock different rows, so two
-- claims never return one item.
create function public.store_claim_next(p_queue text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item text;
begin
  delete from public.queue where queue = p_queue and expires_at <= pg_catalog.now();
  with next as (
    select q.queue, q.item_id from public.queue q
    where q.queue = p_queue and q.expires_at > pg_catalog.now()
    order by q.seq
    limit 1
    for update skip locked
  )
  delete from public.queue t using next
    where t.queue = next.queue and t.item_id = next.item_id
    returning t.item_id into v_item;
  return v_item;
end;
$$;

-- Cleanup --------------------------------------------------------------------

create function public.store_cleanup()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_kv bigint;
  v_counters bigint;
  v_leases bigint;
  v_queue bigint;
begin
  delete from public.kv where expires_at <= pg_catalog.now();
  get diagnostics v_kv = row_count;
  delete from public.counters where expires_at <= pg_catalog.now();
  get diagnostics v_counters = row_count;
  delete from public.leases where expires_at <= pg_catalog.now();
  get diagnostics v_leases = row_count;
  delete from public.queue where expires_at <= pg_catalog.now();
  get diagnostics v_queue = row_count;
  return pg_catalog.jsonb_build_object('kv', v_kv, 'counters', v_counters, 'leases', v_leases, 'queue', v_queue);
end;
$$;

-- Privileges -----------------------------------------------------------------

revoke all on table public.kv, public.counters, public.leases, public.queue from public, anon, authenticated;
revoke all on sequence public.queue_seq from public, anon, authenticated;
revoke all on function
  public.store_ttl(double precision),
  public.store_get(text),
  public.store_set(text, jsonb, double precision),
  public.store_delete(text),
  public.store_put_if_absent(text, jsonb, double precision),
  public.store_compare_and_set(text, numeric, jsonb, double precision),
  public.store_increment_window(text, double precision, bigint),
  public.store_acquire_lease(text, double precision),
  public.store_renew_lease(text, text, double precision),
  public.store_release_lease(text, text),
  public.store_enqueue(text, text, double precision),
  public.store_claim_next(text),
  public.store_cleanup()
from public, anon, authenticated;

grant select, insert, update, delete on table public.kv, public.counters, public.leases, public.queue to service_role;
grant usage on sequence public.queue_seq to service_role;
grant execute on function
  public.store_ttl(double precision),
  public.store_get(text),
  public.store_set(text, jsonb, double precision),
  public.store_delete(text),
  public.store_put_if_absent(text, jsonb, double precision),
  public.store_compare_and_set(text, numeric, jsonb, double precision),
  public.store_increment_window(text, double precision, bigint),
  public.store_acquire_lease(text, double precision),
  public.store_renew_lease(text, text, double precision),
  public.store_release_lease(text, text),
  public.store_enqueue(text, text, double precision),
  public.store_claim_next(text),
  public.store_cleanup()
to service_role;
