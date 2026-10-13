-- =====================================================================
-- Office Hour · Discord notifications
--
-- A group can link a Discord channel webhook. When its sessions are
-- published, moved or cancelled, the channel gets a short message.
-- Messages are sent asynchronously by pg_net, so a slow or broken
-- webhook can never block or fail a booking. Where pg_net is missing
-- (tests, the in-browser demo) nothing is sent.
-- =====================================================================

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end $$;

create or replace function app.wday(p date) returns text
language sql immutable set search_path = '' as $$
  select (array['一', '二', '三', '四', '五', '六', '日'])[extract(isodow from p)::int]
$$;

-- "10/21（三）10:00–10:30"
create or replace function app.slot_text(p_d date, p_t time) returns text
language sql stable set search_path = '' as $$
  select to_char(p_d, 'FMMM/FMDD') || '（' || app.wday(p_d) || '）' || app.hm(p_t) || '–'
         || app.hm(p_t + make_interval(mins => (select s.slot_minutes from app.settings s where s.id = 1)))
$$;

create or replace function app.group_title(p_group int) returns text
language sql stable set search_path = '' as $$
  select '第 ' || g.no || ' 組' || case when g.name <> '' then '「' || g.name || '」' else '' end
    from app.groups g where g.id = p_group
$$;

create or replace function app.has_pg_net() returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'net' and p.proname = 'http_post')
$$;

-- Queues one message to a group's webhook. Returns the pg_net request id,
-- or null when there is nothing to send to.
create or replace function app.discord(p_group int, p_text text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_id bigint;
begin
  select g.webhook into v_url from app.groups g where g.id = p_group and g.active;
  if v_url is null or not app.has_pg_net() then
    return null;
  end if;
  begin
    execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 8000)'
       into v_id
      using v_url,
            jsonb_build_object(
              'content', left(p_text, 1900),
              'username', 'Office Hour',
              -- never let student-typed text ping @everyone or roles
              'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb)),
            '{"Content-Type": "application/json"}'::jsonb;
  exception when others then
    raise warning 'discord notify failed: %', sqlerrm;
    return null;
  end;
  return v_id;
end $$;

create or replace function app.appointments_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_location text := (select nullif(s.location, '') from app.settings s where s.id = 1);
begin
  -- drafts that were just published: one message per group
  for r in
    select n.group_id, n.week_id,
           string_agg('• ' || app.slot_text(n.d, n.t), E'\n' order by n.d, n.t) as lines
      from new_rows n join old_rows o on o.id = n.id
     where n.status = 'confirmed' and o.status = 'draft'
     group by n.group_id, n.week_id
  loop
    perform app.discord(r.group_id,
      '**📅 Office Hour 時間確定**' || E'\n' || app.group_title(r.group_id) || E'\n' || r.lines
      || coalesce(E'\n地點：' || v_location, '')
      || coalesce(E'\n題目：' || (select x.topic from app.requests x where x.week_id = r.week_id and x.group_id = r.group_id), ''));
  end loop;

  -- confirmed sessions that were cancelled
  for r in
    select n.* from new_rows n join old_rows o on o.id = n.id
     where n.status = 'cancelled' and o.status = 'confirmed'
  loop
    perform app.discord(r.group_id,
      '**Office Hour 已取消**' || E'\n' || app.group_title(r.group_id) || E'\n• ' || app.slot_text(r.d, r.t)
      || coalesce(E'\n' || r.cancelled_by || ' 取消' || coalesce('：' || r.cancel_reason, ''), ''));
  end loop;

  -- confirmed sessions that moved
  for r in
    select n.*, o.d as old_d, o.t as old_t from new_rows n join old_rows o on o.id = n.id
     where n.status = 'confirmed' and o.status = 'confirmed' and (n.d, n.t) is distinct from (o.d, o.t)
  loop
    perform app.discord(r.group_id,
      '**Office Hour 時間異動**' || E'\n' || app.group_title(r.group_id)
      || E'\n• ' || app.slot_text(r.old_d, r.old_t) || ' → ' || app.slot_text(r.d, r.t)
      || coalesce(E'\n地點：' || v_location, ''));
  end loop;
  return null;
end $$;

drop trigger if exists notify_discord on app.appointments;
create trigger notify_discord after update on app.appointments
  referencing old table as old_rows new table as new_rows
  for each statement execute function app.appointments_notify();

-- Sends a test message and returns the request id to check on.
create or replace function public.oh_admin_webhook_test(p_token text, p_group int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_id bigint;
begin
  if not exists (select 1 from app.groups g where g.id = p_group and g.webhook is not null) then
    perform app.err('NOT_FOUND', 'webhook');
  end if;
  v_id := app.discord(p_group, '✅ ' || app.group_title(p_group) || ' 已連結 Office Hour。之後排定、異動或取消的時間會自動通知到這個頻道。');
  perform app.log(s, 'config.group.webhook_test', p_group, null);
  return jsonb_build_object('request_id', v_id, 'available', app.has_pg_net());
end $$;

-- Status of a webhook request: pending, ok, or failed with a code.
create or replace function public.oh_admin_webhook_status(p_token text, p_request bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v jsonb;
begin
  if not app.has_pg_net() or p_request is null then
    return jsonb_build_object('state', 'unavailable');
  end if;
  execute 'select jsonb_build_object(''code'', r.status_code, ''error'', r.error_msg)
             from net._http_response r where r.id = $1'
     into v using p_request;
  if v is null then
    return jsonb_build_object('state', 'pending');
  end if;
  return v || jsonb_build_object('state',
    case when (v ->> 'code')::int between 200 and 299 then 'ok' else 'failed' end);
end $$;

revoke execute on all functions in schema app from public;
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('oh_admin_webhook_test', 'oh_admin_webhook_status')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
