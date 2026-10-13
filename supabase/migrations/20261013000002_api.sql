-- =====================================================================
-- Office Hour · API
--
-- Internal helpers live in schema app. The browser-facing API is the set
-- of public.oh_* functions: SECURITY DEFINER, empty search_path, and every
-- one of them starts by resolving the caller's session token.
--
-- Errors are raised as SQLSTATE P0001 with a short machine code in the
-- message (AUTH, FORBIDDEN, VALIDATION, SLOT_LATE, ...) and an optional
-- detail; the client turns those into human sentences.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Time
-- ---------------------------------------------------------------------

-- Current time. Outside the REST API (tests, the in-browser demo) the
-- clock can be pinned with: set app.now = '2026-10-19 09:00+08'.
create or replace function app.now() returns timestamptz
language sql stable set search_path = '' as $$
  select case
    when session_user::text <> 'authenticator'
      then coalesce(nullif(current_setting('app.now', true), '')::timestamptz, pg_catalog.now())
    else pg_catalog.now()
  end
$$;

create or replace function app.cfg() returns app.settings
language sql stable set search_path = '' as $$
  select s.* from app.settings s where s.id = 1
$$;

create or replace function app.local_now() returns timestamp
language sql stable set search_path = '' as $$
  select app.now() at time zone (select s.timezone from app.settings s where s.id = 1)
$$;

create or replace function app.today() returns date
language sql stable set search_path = '' as $$
  select app.local_now()::date
$$;

create or replace function app.iso(p timestamptz) returns text
language sql immutable set search_path = '' as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

create or replace function app.hm(p time) returns text
language sql immutable set search_path = '' as $$
  select to_char(p, 'HH24:MI')
$$;

create or replace function app.clock() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('now', app.iso(app.now()), 'today', app.today(),
                            'tz', (select s.timezone from app.settings s where s.id = 1))
$$;

-- ---------------------------------------------------------------------
-- Errors, text, codes, tokens
-- ---------------------------------------------------------------------
create or replace function app.err(p_code text, p_detail text default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = coalesce(p_detail, '');
end $$;

-- Single-line text: control characters become spaces, runs of
-- whitespace collapse, empty becomes null.
create or replace function app.clean(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g')), '')
$$;

-- Multi-line text: keeps line breaks (at most one blank line in a row).
create or replace function app.clean_multiline(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(btrim(
           regexp_replace(
             regexp_replace(
               regexp_replace(replace(coalesce(p, ''), E'\r\n', E'\n'), E'[\\x01-\\x08\\x0B\\x0C\\x0D\\x0E-\\x1F\\x7F]', '', 'g'),
               E'[ \\t]+\\n', E'\n', 'g'),
             E'\\n{3,}', E'\n\n', 'g'),
           E' \t\n'), '')
$$;

create or replace function app.norm_code(p text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p, ''), '[^0-9A-Za-z]', '', 'g'))
$$;

-- Random code from an alphabet without look-alikes (no 0 O 1 I L U).
create or replace function app.gen_code(p_len int) returns text
language plpgsql volatile set search_path = '' as $$
declare
  alpha constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_out text := '';
  v_bytes bytea;
  v_byte int;
begin
  while length(v_out) < p_len loop
    v_bytes := uuid_send(gen_random_uuid());
    for i in 0..15 loop
      continue when i = 6 or i = 8;          -- uuid version / variant bits
      v_byte := get_byte(v_bytes, i);
      continue when v_byte >= 240;           -- 240 = 8 * 30, keeps it unbiased
      v_out := v_out || substr(alpha, (v_byte % 30) + 1, 1);
      exit when length(v_out) >= p_len;
    end loop;
  end loop;
  return v_out;
end $$;

create or replace function app.new_code(p_len int) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v text;
begin
  loop
    v := app.gen_code(p_len);
    exit when not exists (select 1 from app.groups x where x.code = v)
          and not exists (select 1 from app.teachers x where x.code = v)
          and not exists (select 1 from app.admins x where x.code = v);
  end loop;
  return v;
end $$;

create or replace function app.new_token() returns text
language sql volatile set search_path = '' as $$
  select encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex')
$$;

create or replace function app.hash_token(p text) returns bytea
language sql immutable set search_path = '' as $$
  select sha256(convert_to(coalesce(p, ''), 'UTF8'))
$$;

-- ---------------------------------------------------------------------
-- Throttling of code guesses (per client IP, 20 misses / 10 minutes)
-- ---------------------------------------------------------------------
create or replace function app.client_ip() returns text
language plpgsql stable set search_path = '' as $$
declare
  h jsonb;
  v text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    return 'unknown';
  end;
  if h is null then return 'local'; end if;
  v := coalesce(h ->> 'cf-connecting-ip', split_part(h ->> 'x-forwarded-for', ',', 1), h ->> 'x-real-ip');
  return coalesce(nullif(btrim(v), ''), 'unknown');
end $$;

create or replace function app.check_throttle() returns void
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from app.join_attempts j
       where j.ip = app.client_ip() and j.at > app.now() - interval '10 minutes') >= 20 then
    perform app.err('RATE_LIMIT');
  end if;
end $$;

create or replace function app.note_failure() returns void
language sql set search_path = '' as $$
  delete from app.join_attempts j where j.at < app.now() - interval '1 day';
  insert into app.join_attempts (ip, at) values (app.client_ip(), app.now());
$$;

-- ---------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------
create or replace function app.session(p_token text, p_roles text[]) returns app.sessions
language plpgsql set search_path = '' as $$
declare
  v app.sessions;
begin
  if p_token is null or length(p_token) <> 64 then
    perform app.err('AUTH');
  end if;
  select s.* into v from app.sessions s
   where s.token_hash = app.hash_token(p_token) and s.revoked_at is null;
  if not found then
    perform app.err('AUTH');
  end if;
  if (v.role = 'student' and not exists (select 1 from app.groups x where x.id = v.group_id and x.active))
     or (v.role = 'teacher' and not exists (select 1 from app.teachers x where x.id = v.teacher_id and x.active))
     or (v.role = 'admin' and not exists (select 1 from app.admins x where x.id = v.admin_id and x.active)) then
    perform app.err('AUTH');
  end if;
  if not (v.role = any (p_roles)) then
    perform app.err('FORBIDDEN');
  end if;
  if v.seen_at < app.now() - interval '5 minutes' then
    update app.sessions set seen_at = app.now() where id = v.id;
  end if;
  return v;
end $$;

create or replace function app.session_json(v app.sessions) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', v.id, 'role', v.role, 'name', v.name,
    'group',   (select jsonb_build_object('id', g.id, 'no', g.no, 'name', g.name) from app.groups g where g.id = v.group_id),
    'teacher', (select jsonb_build_object('id', x.id, 'name', x.name) from app.teachers x where x.id = v.teacher_id),
    'admin',   (select jsonb_build_object('id', x.id, 'name', x.name) from app.admins x where x.id = v.admin_id))
$$;

create or replace function app.settings_json() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'course_code', s.course_code, 'course_title', s.course_title, 'host_label', s.host_label,
    'location', s.location, 'notice', s.notice, 'lead_days', s.lead_days, 'week_cap', s.week_cap,
    'day_cap', s.day_cap, 'cancel_hours', s.cancel_hours, 'slot_minutes', s.slot_minutes,
    'show_teacher_names', s.show_teacher_names, 'timezone', s.timezone)
  from app.settings s where s.id = 1
$$;

create or replace function app.log(v app.sessions, p_kind text, p_group int, p_week int, p_data jsonb default '{}')
returns void
language sql set search_path = '' as $$
  insert into app.events (at, actor_role, actor_name, kind, group_id, week_id, data)
  values (app.now(), v.role, v.name, p_kind, p_group, p_week, coalesce(p_data, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------
-- Calendar maths
-- ---------------------------------------------------------------------

-- Every bookable (date, start time, teacher) in a week, after closures.
create or replace function app.week_slots(p_week int)
returns table (d date, t time, teacher_id int)
language sql stable set search_path = '' as $$
  with wk as (
    select w.start_date from app.weeks w where w.id = p_week
  ), step as (
    select make_interval(mins => s.slot_minutes) as v from app.settings s where s.id = 1
  ), days as (
    select wk.start_date + i as day, i + 1 as dow from wk, generate_series(0, 6) as i
  ), b as (
    select days.day, bl.teacher_id, bl.start_time, bl.end_time
      from days
      join app.blocks bl
        on (bl.dow = days.dow
            and (bl.valid_from is null or days.day >= bl.valid_from)
            and (bl.valid_to is null or days.day <= bl.valid_to))
        or bl.on_date = days.day
      join app.teachers te on te.id = bl.teacher_id and te.active
  )
  select distinct b.day, gs::time, b.teacher_id
    from b
    cross join step
    cross join lateral generate_series(b.day + b.start_time, b.day + b.end_time - step.v, step.v) as gs
   where not exists (
     select 1 from app.closures c
      where c.on_date = b.day and (c.teacher_id is null or c.teacher_id = b.teacher_id))
$$;

-- A week a student can still act on: open and with at least one slot
-- that is not past the booking deadline.
create or replace function app.week_bookable(p_week int) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from app.weeks w
     where w.id = p_week and w.open
       and exists (select 1 from app.week_slots(w.id) ws
                    where ws.d >= app.today() + (select s.lead_days from app.settings s where s.id = 1)))
$$;

create or replace function app.request_json(p_id bigint) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'week_id', r.week_id, 'group_id', r.group_id,
    'topic', r.topic, 'progress', r.progress, 'link', r.link, 'want', r.want,
    'author', r.author, 'status', r.status, 'version', r.version,
    'created_at', app.iso(r.created_at), 'updated_at', app.iso(r.updated_at),
    'slots', coalesce((select jsonb_agg(jsonb_build_object('d', rs.d, 't', app.hm(rs.t)) order by rs.d, rs.t)
                         from app.request_slots rs where rs.request_id = r.id), '[]'::jsonb))
  from app.requests r where r.id = p_id
$$;

create or replace function app.appt_json(a app.appointments) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id, 'week_id', a.week_id, 'group_id', a.group_id, 'teacher_id', a.teacher_id,
    'd', a.d, 't', app.hm(a.t), 'status', a.status,
    'created_by', a.created_by, 'created_at', app.iso(a.created_at),
    'published_at', app.iso(a.published_at), 'cancelled_at', app.iso(a.cancelled_at),
    'cancelled_by', a.cancelled_by, 'cancel_reason', a.cancel_reason)
$$;

-- Creates (p_appt null) or moves a draft/confirmed appointment.
-- Hard conflicts always fail. Soft issues fail with NEEDS_FORCE unless
-- p_force, so the admin can knowingly make an exception.
create or replace function app.assign(
  p_admin app.sessions, p_appt bigint, p_week int, p_group int, p_teacher int,
  p_d date, p_t time, p_force boolean
) returns app.appointments
language plpgsql set search_path = '' as $$
declare
  cfg app.settings := app.cfg();
  w app.weeks;
  v app.appointments;
  v_issues text[] := '{}';
  v_constraint text;
begin
  select * into w from app.weeks x where x.id = p_week;
  if not found then
    perform app.err('NOT_FOUND', 'week');
  end if;
  if p_d is null or p_t is null or p_d < w.start_date or p_d > w.start_date + 6
     or (extract(epoch from p_t)::int % (cfg.slot_minutes * 60)) <> 0 then
    perform app.err('SLOT_INVALID');
  end if;
  if not exists (select 1 from app.groups x where x.id = p_group and x.active) then
    perform app.err('NOT_FOUND', 'group');
  end if;
  if not exists (select 1 from app.teachers x where x.id = p_teacher and x.active) then
    perform app.err('NOT_FOUND', 'teacher');
  end if;

  if exists (select 1 from app.appointments a
              where a.teacher_id = p_teacher and a.d = p_d and a.t = p_t
                and a.status <> 'cancelled' and a.id is distinct from p_appt) then
    perform app.err('TEACHER_BUSY');
  end if;
  if exists (select 1 from app.appointments a
              where a.group_id = p_group and a.d = p_d and a.t = p_t
                and a.status <> 'cancelled' and a.id is distinct from p_appt) then
    perform app.err('GROUP_BUSY');
  end if;

  if not exists (select 1 from app.week_slots(p_week) ws
                  where ws.d = p_d and ws.t = p_t and ws.teacher_id = p_teacher) then
    v_issues := array_append(v_issues, 'OFF_HOURS');
  end if;
  if (select count(*) from app.appointments a
       where a.group_id = p_group and a.week_id = p_week
         and a.status <> 'cancelled' and a.id is distinct from p_appt) >= cfg.week_cap then
    v_issues := array_append(v_issues, 'CAP_WEEK');
  end if;
  if (select count(*) from app.appointments a
       where a.group_id = p_group and a.d = p_d
         and a.status <> 'cancelled' and a.id is distinct from p_appt) >= cfg.day_cap then
    v_issues := array_append(v_issues, 'CAP_DAY');
  end if;
  if not exists (select 1 from app.requests r
                   join app.request_slots rs on rs.request_id = r.id
                  where r.week_id = p_week and r.group_id = p_group and r.status = 'open'
                    and rs.d = p_d and rs.t = p_t) then
    v_issues := array_append(v_issues, 'NOT_REQUESTED');
  end if;
  if p_d + p_t < app.local_now() then
    v_issues := array_append(v_issues, 'PAST');
  end if;
  if cardinality(v_issues) > 0 and not coalesce(p_force, false) then
    perform app.err('NEEDS_FORCE', array_to_string(v_issues, ','));
  end if;

  if p_appt is null then
    insert into app.appointments (week_id, group_id, teacher_id, d, t, status, created_by, created_at)
    values (p_week, p_group, p_teacher, p_d, p_t, 'draft', p_admin.name, app.now())
    returning * into v;
  else
    update app.appointments a
       set teacher_id = p_teacher, d = p_d, t = p_t
     where a.id = p_appt
    returning * into v;
  end if;
  return v;
exception
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform app.err(case when v_constraint = 'appointments_group_slot' then 'GROUP_BUSY' else 'TEACHER_BUSY' end);
end $$;

-- Week an admin should see first: the earliest not-yet-over week that
-- still has requests waiting, otherwise the current/next week.
create or replace function app.admin_default_week() returns int
language sql stable set search_path = '' as $$
  select coalesce(
    (select w.id from app.weeks w
      where w.start_date + 6 >= app.today()
        and exists (select 1 from app.requests r
                     where r.week_id = w.id and r.status = 'open'
                       and not exists (select 1 from app.appointments a
                                        where a.week_id = w.id and a.group_id = r.group_id
                                          and a.status = 'confirmed'))
      order by w.start_date limit 1),
    (select w.id from app.weeks w where w.start_date + 6 >= app.today() order by w.start_date limit 1),
    (select w.id from app.weeks w order by w.start_date desc limit 1))
$$;

-- ---------------------------------------------------------------------
-- Realtime: every write pings the shared "oh-sync" broadcast topic.
-- The payload only names the table; clients refetch through the API,
-- so nothing private ever travels over the public channel.
-- ---------------------------------------------------------------------
create or replace function app.ping() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform realtime.send(jsonb_build_object('t', tg_table_name), 'change', 'oh-sync', false);
  exception when others then
    null;  -- realtime unavailable (local tests); writes must never fail because of it
  end;
  return null;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['settings', 'groups', 'teachers', 'admins', 'weeks', 'blocks', 'closures',
                           'requests', 'request_slots', 'appointments', 'events'] loop
    execute format('drop trigger if exists ping on app.%I', t);
    execute format('create trigger ping after insert or update or delete on app.%I
                    for each statement execute function app.ping()', t);
  end loop;
end $$;

-- =====================================================================
-- Public API · everyone
-- =====================================================================

-- Looks up a code without signing in, so the join screen can say
-- "you are joining group 2" before asking for a name.
create or replace function public.oh_peek(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c text := app.norm_code(p_code);
  g app.groups;
  t app.teachers;
  a app.admins;
begin
  perform app.check_throttle();
  if length(c) between 8 and 12 then
    select * into g from app.groups x where x.code = c and x.active;
    if found then
      return jsonb_build_object('ok', true, 'role', 'student',
                                'group', jsonb_build_object('no', g.no, 'name', g.name));
    end if;
    select * into t from app.teachers x where x.code = c and x.active;
    if found then
      return jsonb_build_object('ok', true, 'role', 'teacher', 'name', t.name);
    end if;
    select * into a from app.admins x where x.code = c and x.active;
    if found then
      return jsonb_build_object('ok', true, 'role', 'admin', 'name', a.name);
    end if;
  end if;
  perform app.note_failure();
  return jsonb_build_object('ok', false, 'error', 'CODE_INVALID');
end $$;

create or replace function public.oh_join(p_code text, p_name text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c text := app.norm_code(p_code);
  v_name text := left(app.clean(p_name), 20);
  v_role text;
  v_token text := app.new_token();
  g app.groups;
  t app.teachers;
  a app.admins;
  v app.sessions;
begin
  perform app.check_throttle();
  if length(c) between 8 and 12 then
    select * into g from app.groups x where x.code = c and x.active;
    if found then
      v_role := 'student';
    else
      select * into t from app.teachers x where x.code = c and x.active;
      if found then
        v_role := 'teacher';
      else
        select * into a from app.admins x where x.code = c and x.active;
        if found then
          v_role := 'admin';
        end if;
      end if;
    end if;
  end if;
  if v_role is null then
    perform app.note_failure();
    return jsonb_build_object('ok', false, 'error', 'CODE_INVALID');
  end if;
  if v_role = 'student' and v_name is null then
    return jsonb_build_object('ok', false, 'error', 'NAME_REQUIRED');
  end if;
  if v_role = 'teacher' then
    v_name := t.name;
  elsif v_role = 'admin' then
    v_name := a.name;
  end if;

  insert into app.sessions (token_hash, role, group_id, teacher_id, admin_id, name, created_at, seen_at)
  values (app.hash_token(v_token), v_role, g.id, t.id, a.id, v_name, app.now(), app.now())
  returning * into v;
  perform app.log(v, 'member.joined', v.group_id, null);
  return jsonb_build_object('ok', true, 'token', v_token, 'session', app.session_json(v));
end $$;

create or replace function public.oh_me(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['student', 'teacher', 'admin']);
begin
  return jsonb_build_object('session', app.session_json(s), 'settings', app.settings_json(), 'clock', app.clock());
end $$;

create or replace function public.oh_leave(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update app.sessions s set revoked_at = app.now()
   where s.token_hash = app.hash_token(p_token) and s.revoked_at is null;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.oh_rename(p_token text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['student']);
  v_name text := left(app.clean(p_name), 20);
begin
  if v_name is null then
    perform app.err('VALIDATION', 'name');
  end if;
  update app.sessions x set name = v_name where x.id = s.id returning * into s;
  return app.session_json(s);
end $$;

-- =====================================================================
-- Public API · students
-- =====================================================================
create or replace function public.oh_student_state(p_token text, p_week int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['student']);
  cfg app.settings := app.cfg();
  v_today date := app.today();
  v_week int := p_week;
begin
  if v_week is null or not exists (select 1 from app.weeks w where w.id = v_week) then
    select w.id into v_week from app.weeks w
     where app.week_bookable(w.id) order by w.start_date limit 1;
    if v_week is null then
      select w.id into v_week from app.weeks w
       where w.start_date + 6 >= v_today order by w.start_date limit 1;
    end if;
    if v_week is null then
      select w.id into v_week from app.weeks w order by w.start_date desc limit 1;
    end if;
  end if;

  return jsonb_build_object(
    'clock', app.clock(),
    'settings', app.settings_json(),
    'me', app.session_json(s),
    'members', (select coalesce(jsonb_agg(m.name order by m.first), '[]'::jsonb)
                  from (select x.name, min(x.created_at) as first from app.sessions x
                         where x.group_id = s.group_id and x.revoked_at is null group by x.name) m),
    'week_id', v_week,
    'weeks', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', w.id, 'start', w.start_date, 'label', w.label, 'open', w.open, 'note', w.note,
                'bookable', app.week_bookable(w.id),
                'requested', exists (select 1 from app.requests r
                                      where r.week_id = w.id and r.group_id = s.group_id and r.status = 'open'),
                'booked', (select count(*) from app.appointments a
                            where a.week_id = w.id and a.group_id = s.group_id and a.status = 'confirmed')
              ) order by w.start_date), '[]'::jsonb) from app.weeks w),
    'slots', (select coalesce(jsonb_agg(jsonb_build_object(
                'd', x.d, 't', app.hm(x.t), 'cap', x.cap,
                'late', x.d < v_today + cfg.lead_days,
                'demand', x.demand) order by x.d, x.t), '[]'::jsonb)
              from (select ws.d, ws.t, count(distinct ws.teacher_id) as cap,
                           (select count(distinct r.group_id) from app.requests r
                              join app.request_slots rs on rs.request_id = r.id
                             where r.week_id = v_week and r.status = 'open' and r.group_id <> s.group_id
                               and rs.d = ws.d and rs.t = ws.t) as demand
                      from app.week_slots(v_week) ws group by ws.d, ws.t) x),
    'closures', (select coalesce(jsonb_agg(jsonb_build_object('d', c.on_date, 'reason', c.reason) order by c.on_date), '[]'::jsonb)
                   from app.closures c join app.weeks w on w.id = v_week
                  where c.teacher_id is null and c.on_date between w.start_date and w.start_date + 6),
    'request', (select app.request_json(r.id) from app.requests r
                 where r.week_id = v_week and r.group_id = s.group_id),
    'scheduling', exists (select 1 from app.appointments a
                           where a.week_id = v_week and a.group_id = s.group_id and a.status = 'draft'),
    'appointments', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', a.id, 'week_id', a.week_id, 'd', a.d, 't', app.hm(a.t), 'status', a.status,
                       'teacher', case when cfg.show_teacher_names then te.name end,
                       'cancel_reason', a.cancel_reason, 'cancelled_by', a.cancelled_by,
                       'can_cancel', a.status = 'confirmed'
                                     and a.d + a.t > app.local_now() + make_interval(hours => cfg.cancel_hours),
                       'topic', (select r.topic from app.requests r where r.week_id = a.week_id and r.group_id = a.group_id)
                     ) order by a.d, a.t), '[]'::jsonb)
                     from app.appointments a join app.teachers te on te.id = a.teacher_id
                    where a.group_id = s.group_id
                      and (a.status = 'confirmed' or (a.status = 'cancelled' and a.published_at is not null)))
  );
end $$;

create or replace function public.oh_request_save(
  p_token text, p_week int, p_topic text, p_progress text, p_link text,
  p_want int, p_slots jsonb, p_version int default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['student']);
  cfg app.settings := app.cfg();
  w app.weeks;
  r app.requests;
  v_topic text := app.clean(p_topic);
  v_progress text := app.clean_multiline(p_progress);
  v_link text := app.clean(p_link);
  v_slots timestamp[];
  v_valid timestamp[];
  v_old timestamp[] := '{}';
  v_new boolean := false;
begin
  select * into w from app.weeks x where x.id = p_week;
  if not found then
    perform app.err('NOT_FOUND', 'week');
  end if;
  if not w.open then
    perform app.err('WEEK_CLOSED');
  end if;
  if v_topic is null or length(v_topic) > 80 then
    perform app.err('VALIDATION', 'topic');
  end if;
  if v_progress is null or length(v_progress) > 1000 then
    perform app.err('VALIDATION', 'progress');
  end if;
  if v_link is not null and (length(v_link) > 500 or v_link !~* '^https?://[^\s/?#]+\.[^\s]*$') then
    perform app.err('VALIDATION', 'link');
  end if;
  if p_want is null or p_want < 1 or p_want > cfg.week_cap then
    perform app.err('VALIDATION', 'want');
  end if;
  if p_slots is null or jsonb_typeof(p_slots) <> 'array'
     or jsonb_array_length(p_slots) = 0 or jsonb_array_length(p_slots) > 200 then
    perform app.err('VALIDATION', 'slots');
  end if;
  begin
    select array_agg(distinct ((e ->> 'd')::date + (e ->> 't')::time)) into v_slots
      from jsonb_array_elements(p_slots) e;
  exception when others then
    perform app.err('VALIDATION', 'slots');
  end;
  if array_position(v_slots, null) is not null then
    perform app.err('VALIDATION', 'slots');
  end if;

  v_valid := array(select distinct ws.d + ws.t from app.week_slots(p_week) ws);
  if exists (select 1 from unnest(v_slots) x where not (x = any (v_valid))) then
    perform app.err('SLOT_INVALID');
  end if;

  select * into r from app.requests x
   where x.week_id = p_week and x.group_id = s.group_id
   for update;
  if found then
    if p_version is distinct from r.version then
      perform app.err('CONFLICT');
    end if;
    v_old := array(select rs.d + rs.t from app.request_slots rs where rs.request_id = r.id);
  end if;

  -- Newly picked slots must respect the deadline; slots that were picked
  -- earlier may stay even after their deadline has passed.
  if exists (select 1 from unnest(v_slots) x
              where not (x = any (v_old)) and x::date < app.today() + cfg.lead_days) then
    perform app.err('SLOT_LATE');
  end if;

  if r.id is null then
    insert into app.requests (week_id, group_id, topic, progress, link, want, author, status, version, created_at, updated_at)
    values (p_week, s.group_id, v_topic, v_progress, v_link, p_want, s.name, 'open', 1, app.now(), app.now())
    on conflict (week_id, group_id) do nothing
    returning * into r;
    if r.id is null then
      perform app.err('CONFLICT');
    end if;
    v_new := true;
  else
    update app.requests x
       set topic = v_topic, progress = v_progress, link = v_link, want = p_want,
           author = s.name, status = 'open', version = x.version + 1, updated_at = app.now()
     where x.id = r.id
    returning * into r;
  end if;

  delete from app.request_slots rs where rs.request_id = r.id;
  insert into app.request_slots (request_id, d, t)
  select r.id, x::date, x::time from unnest(v_slots) x;

  perform app.log(s, case when v_new then 'request.created' else 'request.updated' end, s.group_id, p_week,
                  jsonb_build_object('topic', v_topic, 'slots', cardinality(v_slots), 'want', p_want));
  return app.request_json(r.id);
end $$;

create or replace function public.oh_request_withdraw(p_token text, p_week int, p_version int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['student']);
  r app.requests;
begin
  select * into r from app.requests x
   where x.week_id = p_week and x.group_id = s.group_id and x.status = 'open'
   for update;
  if not found then
    perform app.err('NOT_FOUND', 'request');
  end if;
  if p_version is distinct from r.version then
    perform app.err('CONFLICT');
  end if;
  if exists (select 1 from app.appointments a
              where a.week_id = p_week and a.group_id = s.group_id and a.status = 'confirmed') then
    perform app.err('HAS_APPOINTMENTS');
  end if;
  delete from app.appointments a
   where a.week_id = p_week and a.group_id = s.group_id and a.status = 'draft';
  update app.requests x
     set status = 'withdrawn', version = x.version + 1, author = s.name, updated_at = app.now()
   where x.id = r.id;
  perform app.log(s, 'request.withdrawn', s.group_id, p_week, jsonb_build_object('topic', r.topic));
  return app.request_json(r.id);
end $$;

-- Students cancel their own confirmed sessions (up to cancel_hours
-- before the start); admins can cancel any confirmed session.
create or replace function public.oh_appointment_cancel(p_token text, p_id bigint, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['student', 'admin']);
  cfg app.settings := app.cfg();
  a app.appointments;
  v_reason text := left(app.clean(p_reason), 200);
begin
  select * into a from app.appointments x where x.id = p_id for update;
  if not found or (s.role = 'student' and a.group_id <> s.group_id) or a.status <> 'confirmed' then
    perform app.err('NOT_FOUND', 'appointment');
  end if;
  if s.role = 'student' and a.d + a.t <= app.local_now() + make_interval(hours => cfg.cancel_hours) then
    perform app.err('CANCEL_LATE');
  end if;
  update app.appointments x
     set status = 'cancelled', cancelled_at = app.now(), cancelled_by = s.name, cancel_reason = v_reason
   where x.id = a.id
  returning * into a;
  perform app.log(s, 'appt.cancelled', a.group_id, a.week_id,
                  jsonb_build_object('d', a.d, 't', app.hm(a.t), 'reason', v_reason));
  return app.appt_json(a);
end $$;

-- =====================================================================
-- Public API · teachers
-- =====================================================================
create or replace function public.oh_teacher_state(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['teacher']);
  v_today date := app.today();
  v_monday date := v_today - (extract(isodow from v_today)::int - 1);
begin
  return jsonb_build_object(
    'clock', app.clock(),
    'settings', app.settings_json(),
    'me', app.session_json(s),
    'mine', (select coalesce(jsonb_agg(jsonb_build_object(
               'id', a.id, 'd', a.d, 't', app.hm(a.t), 'status', a.status,
               'cancel_reason', a.cancel_reason,
               'group', jsonb_build_object('no', g.no, 'name', g.name),
               'request', (select jsonb_build_object('topic', r.topic, 'progress', r.progress, 'link', r.link,
                                                     'want', r.want, 'author', r.author,
                                                     'updated_at', app.iso(r.updated_at))
                             from app.requests r where r.week_id = a.week_id and r.group_id = a.group_id)
             ) order by a.d, a.t), '[]'::jsonb)
             from app.appointments a join app.groups g on g.id = a.group_id
            where a.teacher_id = s.teacher_id and a.d >= v_today - 28
              and (a.status = 'confirmed'
                   or (a.status = 'cancelled' and a.published_at is not null and a.d >= v_today))),
    'team', (select coalesce(jsonb_agg(jsonb_build_object(
               'd', a.d, 't', app.hm(a.t), 'teacher', te.name, 'mine', a.teacher_id = s.teacher_id,
               'group', jsonb_build_object('no', g.no, 'name', g.name),
               'topic', (select r.topic from app.requests r where r.week_id = a.week_id and r.group_id = a.group_id)
             ) order by a.d, a.t, te.sort), '[]'::jsonb)
             from app.appointments a
             join app.groups g on g.id = a.group_id
             join app.teachers te on te.id = a.teacher_id
            where a.status = 'confirmed' and a.d between v_monday and v_monday + 13),
    'blocks', (select coalesce(jsonb_agg(jsonb_build_object(
                 'dow', b.dow, 'on_date', b.on_date, 'start', app.hm(b.start_time), 'end', app.hm(b.end_time),
                 'valid_from', b.valid_from, 'valid_to', b.valid_to
               ) order by b.on_date nulls first, b.dow, b.start_time), '[]'::jsonb)
               from app.blocks b
              where b.teacher_id = s.teacher_id
                and (b.on_date is null or b.on_date >= v_today)
                and (b.valid_to is null or b.valid_to >= v_today)),
    'closures', (select coalesce(jsonb_agg(jsonb_build_object('d', c.on_date, 'reason', c.reason, 'mine', c.teacher_id is not null)
                   order by c.on_date), '[]'::jsonb)
                 from app.closures c
                where c.on_date between v_today and v_today + 90
                  and (c.teacher_id is null or c.teacher_id = s.teacher_id))
  );
end $$;

-- =====================================================================
-- Public API · admins
-- =====================================================================
create or replace function public.oh_admin_state(p_token text, p_week int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  cfg app.settings := app.cfg();
  v_today date := app.today();
  v_week int := p_week;
  v_start date;
begin
  if v_week is null or not exists (select 1 from app.weeks w where w.id = v_week) then
    v_week := app.admin_default_week();
  end if;
  select w.start_date into v_start from app.weeks w where w.id = v_week;

  return jsonb_build_object(
    'clock', app.clock(),
    'settings', app.settings_json(),
    'me', app.session_json(s),
    'week_id', v_week,
    'weeks', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', w.id, 'start', w.start_date, 'label', w.label, 'open', w.open, 'note', w.note,
                'requests', (select count(*) from app.requests r where r.week_id = w.id and r.status = 'open'),
                'scheduled', (select count(distinct a.group_id) from app.appointments a
                               where a.week_id = w.id and a.status = 'confirmed'),
                'drafts', (select count(*) from app.appointments a where a.week_id = w.id and a.status = 'draft')
              ) order by w.start_date), '[]'::jsonb) from app.weeks w),
    'slots', (select coalesce(jsonb_agg(jsonb_build_object(
                'd', x.d, 't', app.hm(x.t), 'teachers', x.teachers,
                'late', x.d < v_today + cfg.lead_days) order by x.d, x.t), '[]'::jsonb)
              from (select ws.d, ws.t, jsonb_agg(ws.teacher_id order by ws.teacher_id) as teachers
                      from app.week_slots(v_week) ws group by ws.d, ws.t) x),
    'closures', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', c.id, 'd', c.on_date, 'teacher_id', c.teacher_id, 'reason', c.reason) order by c.on_date), '[]'::jsonb)
                 from app.closures c where c.on_date between v_start and v_start + 6),
    'teachers', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'active', x.active)
                   order by x.sort, x.id), '[]'::jsonb) from app.teachers x),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', g.id, 'no', g.no, 'name', g.name, 'active', g.active,
                 'members', (select count(*) from app.sessions x where x.group_id = g.id and x.revoked_at is null),
                 'done', (select count(*) from app.appointments a
                           where a.group_id = g.id and a.status = 'confirmed' and a.d + a.t < app.local_now()),
                 'total', (select count(*) from app.appointments a where a.group_id = g.id and a.status = 'confirmed'),
                 'recent_teachers', (select coalesce(jsonb_agg(a.teacher_id order by a.d desc, a.t desc), '[]'::jsonb)
                                       from app.appointments a where a.group_id = g.id and a.status = 'confirmed')
               ) order by g.no), '[]'::jsonb) from app.groups g),
    'requests', (select coalesce(jsonb_agg(app.request_json(r.id) order by r.created_at), '[]'::jsonb)
                   from app.requests r where r.week_id = v_week),
    'appointments', (select coalesce(jsonb_agg(app.appt_json(a) order by a.d, a.t), '[]'::jsonb)
                       from app.appointments a where a.week_id = v_week),
    'events', (select coalesce(jsonb_agg(e.j order by e.at desc), '[]'::jsonb)
                 from (select ev.at, jsonb_build_object(
                         'id', ev.id, 'at', app.iso(ev.at), 'role', ev.actor_role, 'name', ev.actor_name,
                         'kind', ev.kind, 'group_id', ev.group_id, 'week_id', ev.week_id, 'data', ev.data) as j
                         from app.events ev order by ev.at desc, ev.id desc limit 50) e)
  );
end $$;

create or replace function public.oh_admin_config(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
begin
  return jsonb_build_object(
    'clock', app.clock(),
    'settings', app.settings_json(),
    'me', app.session_json(s),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', g.id, 'no', g.no, 'name', g.name, 'code', g.code, 'active', g.active,
                 'webhook', g.webhook,
                 'members', (select coalesce(jsonb_agg(jsonb_build_object(
                               'id', x.id, 'name', x.name, 'created_at', app.iso(x.created_at),
                               'seen_at', app.iso(x.seen_at)) order by x.created_at), '[]'::jsonb)
                               from app.sessions x where x.group_id = g.id and x.revoked_at is null),
                 'used', exists (select 1 from app.requests r where r.group_id = g.id)
                         or exists (select 1 from app.appointments a where a.group_id = g.id)
               ) order by g.no), '[]'::jsonb) from app.groups g),
    'teachers', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', x.id, 'name', x.name, 'code', x.code, 'active', x.active, 'sort', x.sort,
                   'devices', (select count(*) from app.sessions se where se.teacher_id = x.id and se.revoked_at is null),
                   'used', exists (select 1 from app.appointments a where a.teacher_id = x.id)
                 ) order by x.sort, x.id), '[]'::jsonb) from app.teachers x),
    'admins', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', x.id, 'name', x.name, 'code', x.code, 'active', x.active, 'me', x.id = s.admin_id,
                 'devices', (select count(*) from app.sessions se where se.admin_id = x.id and se.revoked_at is null)
               ) order by x.id), '[]'::jsonb) from app.admins x),
    'weeks', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', w.id, 'start', w.start_date, 'label', w.label, 'open', w.open, 'note', w.note,
                'used', exists (select 1 from app.requests r where r.week_id = w.id)
                        or exists (select 1 from app.appointments a where a.week_id = w.id)
              ) order by w.start_date), '[]'::jsonb) from app.weeks w),
    'blocks', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', b.id, 'teacher_id', b.teacher_id, 'dow', b.dow, 'on_date', b.on_date,
                 'start', app.hm(b.start_time), 'end', app.hm(b.end_time),
                 'valid_from', b.valid_from, 'valid_to', b.valid_to
               ) order by b.on_date nulls first, b.dow, b.start_time, b.teacher_id), '[]'::jsonb) from app.blocks b),
    'closures', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', c.id, 'd', c.on_date, 'teacher_id', c.teacher_id, 'reason', c.reason) order by c.on_date), '[]'::jsonb)
                 from app.closures c)
  );
end $$;

create or replace function public.oh_admin_assign(
  p_token text, p_week int, p_group int, p_teacher int, p_d date, p_t text, p_force boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_t time;
  a app.appointments;
begin
  begin
    v_t := p_t::time;
  exception when others then
    perform app.err('SLOT_INVALID');
  end;
  a := app.assign(s, null, p_week, p_group, p_teacher, p_d, v_t, p_force);
  perform app.log(s, 'appt.drafted', a.group_id, a.week_id,
                  jsonb_build_object('d', a.d, 't', app.hm(a.t), 'teacher_id', a.teacher_id));
  return app.appt_json(a);
end $$;

create or replace function public.oh_admin_move(
  p_token text, p_id bigint, p_teacher int, p_d date, p_t text, p_force boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_t time;
  a app.appointments;
begin
  begin
    v_t := p_t::time;
  exception when others then
    perform app.err('SLOT_INVALID');
  end;
  select * into a from app.appointments x where x.id = p_id and x.status <> 'cancelled' for update;
  if not found then
    perform app.err('NOT_FOUND', 'appointment');
  end if;
  a := app.assign(s, a.id, a.week_id, a.group_id, p_teacher, p_d, v_t, p_force);
  perform app.log(s, case when a.status = 'confirmed' then 'appt.moved' else 'appt.drafted' end, a.group_id, a.week_id,
                  jsonb_build_object('d', a.d, 't', app.hm(a.t), 'teacher_id', a.teacher_id));
  return app.appt_json(a);
end $$;

-- Drafts are deleted, confirmed sessions are cancelled (the group sees
-- it), cancelled ones are removed from the record.
create or replace function public.oh_admin_remove(p_token text, p_id bigint, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  a app.appointments;
  v_reason text := left(app.clean(p_reason), 200);
begin
  select * into a from app.appointments x where x.id = p_id for update;
  if not found then
    perform app.err('NOT_FOUND', 'appointment');
  end if;
  if a.status = 'confirmed' then
    update app.appointments x
       set status = 'cancelled', cancelled_at = app.now(), cancelled_by = s.name, cancel_reason = v_reason
     where x.id = a.id;
    perform app.log(s, 'appt.cancelled', a.group_id, a.week_id,
                    jsonb_build_object('d', a.d, 't', app.hm(a.t), 'reason', v_reason));
  else
    delete from app.appointments x where x.id = a.id;
    if a.status = 'draft' then
      perform app.log(s, 'appt.undrafted', a.group_id, a.week_id, jsonb_build_object('d', a.d, 't', app.hm(a.t)));
    end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Applies a batch of drafts (the auto-scheduler's proposal) atomically.
create or replace function public.oh_admin_apply(p_token text, p_week int, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  e jsonb;
  a app.appointments;
  v_count int := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200 then
    perform app.err('VALIDATION', 'items');
  end if;
  for e in select * from jsonb_array_elements(p_items) loop
    begin
      a := app.assign(s, null, p_week, (e ->> 'group_id')::int, (e ->> 'teacher_id')::int,
                      (e ->> 'd')::date, (e ->> 't')::time, false);
    exception
      when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
        perform app.err('VALIDATION', 'items');
    end;
    v_count := v_count + 1;
  end loop;
  if v_count > 0 then
    perform app.log(s, 'appt.autofilled', null, p_week, jsonb_build_object('count', v_count));
  end if;
  return jsonb_build_object('count', v_count);
end $$;

create or replace function public.oh_admin_publish(p_token text, p_week int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v jsonb;
begin
  with p as (
    update app.appointments x set status = 'confirmed', published_at = app.now()
     where x.week_id = p_week and x.status = 'draft'
    returning x.*
  )
  select coalesce(jsonb_agg(app.appt_json(p) order by p.d, p.t), '[]'::jsonb) into v from p;
  if jsonb_array_length(v) > 0 then
    perform app.log(s, 'appt.published', null, p_week, jsonb_build_object('count', jsonb_array_length(v)));
  end if;
  return jsonb_build_object('published', v);
end $$;

create or replace function public.oh_admin_discard(p_token text, p_week int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_count int;
begin
  delete from app.appointments x where x.week_id = p_week and x.status = 'draft';
  get diagnostics v_count = row_count;
  if v_count > 0 then
    perform app.log(s, 'appt.discarded', null, p_week, jsonb_build_object('count', v_count));
  end if;
  return jsonb_build_object('count', v_count);
end $$;

-- Create or update one configuration record. p_kind: settings, group,
-- teacher, admin, week, block, closure.
create or replace function public.oh_admin_save(p_token text, p_kind text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  cfg app.settings := app.cfg();
  v_id int;
  v_step int := cfg.slot_minutes * 60;
  v_start time;
  v_end time;
  v_constraint text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    perform app.err('VALIDATION', p_kind);
  end if;
  v_id := nullif(p ->> 'id', '')::int;

  case p_kind
  when 'settings' then
    update app.settings x set
      course_code  = case when p ? 'course_code'  then coalesce(app.clean(p ->> 'course_code'), '')  else x.course_code end,
      course_title = case when p ? 'course_title' then coalesce(app.clean(p ->> 'course_title'), '') else x.course_title end,
      host_label   = case when p ? 'host_label'   then coalesce(app.clean(p ->> 'host_label'), 'PM') else x.host_label end,
      location     = case when p ? 'location'     then coalesce(app.clean(p ->> 'location'), '')     else x.location end,
      notice       = case when p ? 'notice'       then coalesce(app.clean_multiline(p ->> 'notice'), '') else x.notice end,
      lead_days    = case when p ? 'lead_days'    then (p ->> 'lead_days')::int    else x.lead_days end,
      week_cap     = case when p ? 'week_cap'     then (p ->> 'week_cap')::int     else x.week_cap end,
      day_cap      = case when p ? 'day_cap'      then (p ->> 'day_cap')::int      else x.day_cap end,
      cancel_hours = case when p ? 'cancel_hours' then (p ->> 'cancel_hours')::int else x.cancel_hours end,
      show_teacher_names = case when p ? 'show_teacher_names' then (p ->> 'show_teacher_names')::boolean
                                else x.show_teacher_names end,
      updated_at = app.now()
    where x.id = 1;
    perform app.log(s, 'config.settings', null, null);
    return app.settings_json();

  when 'group' then
    if v_id is null then
      insert into app.groups (no, name, code, active, webhook)
      values (coalesce((p ->> 'no')::int, (select coalesce(max(x.no), 0) + 1 from app.groups x)),
              coalesce(app.clean(p ->> 'name'), ''), app.new_code(8),
              coalesce((p ->> 'active')::boolean, true), app.clean(p ->> 'webhook'))
      returning id into v_id;
    else
      update app.groups x set
        no      = case when p ? 'no'      then (p ->> 'no')::int else x.no end,
        name    = case when p ? 'name'    then coalesce(app.clean(p ->> 'name'), '') else x.name end,
        active  = case when p ? 'active'  then (p ->> 'active')::boolean else x.active end,
        webhook = case when p ? 'webhook' then app.clean(p ->> 'webhook') else x.webhook end
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'group'); end if;
    end if;
    perform app.log(s, 'config.group', v_id, null);
    return (select jsonb_build_object('id', g.id, 'no', g.no, 'name', g.name, 'code', g.code,
                                      'active', g.active, 'webhook', g.webhook)
              from app.groups g where g.id = v_id);

  when 'teacher' then
    if v_id is null then
      insert into app.teachers (name, code, active, sort)
      values (app.clean(p ->> 'name'), app.new_code(10), coalesce((p ->> 'active')::boolean, true),
              coalesce((p ->> 'sort')::int, (select coalesce(max(x.sort), 0) + 1 from app.teachers x)))
      returning id into v_id;
    else
      update app.teachers x set
        name   = case when p ? 'name'   then app.clean(p ->> 'name') else x.name end,
        active = case when p ? 'active' then (p ->> 'active')::boolean else x.active end,
        sort   = case when p ? 'sort'   then (p ->> 'sort')::int else x.sort end
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'teacher'); end if;
    end if;
    perform app.log(s, 'config.teacher', null, null, jsonb_build_object('teacher_id', v_id));
    return (select jsonb_build_object('id', x.id, 'name', x.name, 'code', x.code, 'active', x.active, 'sort', x.sort)
              from app.teachers x where x.id = v_id);

  when 'admin' then
    if v_id is null then
      insert into app.admins (name, code, active)
      values (app.clean(p ->> 'name'), app.new_code(12), true)
      returning id into v_id;
    else
      if v_id = s.admin_id and p ? 'active' and not (p ->> 'active')::boolean then
        perform app.err('SELF');
      end if;
      update app.admins x set
        name   = case when p ? 'name'   then app.clean(p ->> 'name') else x.name end,
        active = case when p ? 'active' then (p ->> 'active')::boolean else x.active end
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'admin'); end if;
    end if;
    perform app.log(s, 'config.admin', null, null);
    return (select jsonb_build_object('id', x.id, 'name', x.name, 'code', x.code, 'active', x.active)
              from app.admins x where x.id = v_id);

  when 'week' then
    if v_id is null then
      insert into app.weeks (start_date, label, open, note)
      values ((p ->> 'start')::date, coalesce(app.clean(p ->> 'label'), ''),
              coalesce((p ->> 'open')::boolean, true), coalesce(app.clean(p ->> 'note'), ''))
      returning id into v_id;
    else
      update app.weeks x set
        label = case when p ? 'label' then coalesce(app.clean(p ->> 'label'), '') else x.label end,
        open  = case when p ? 'open'  then (p ->> 'open')::boolean else x.open end,
        note  = case when p ? 'note'  then coalesce(app.clean(p ->> 'note'), '') else x.note end
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'week'); end if;
    end if;
    perform app.log(s, 'config.week', null, v_id);
    return (select jsonb_build_object('id', w.id, 'start', w.start_date, 'label', w.label, 'open', w.open, 'note', w.note)
              from app.weeks w where w.id = v_id);

  when 'block' then
    v_start := (p ->> 'start')::time;
    v_end := (p ->> 'end')::time;
    if v_start is null or v_end is null or v_end <= v_start
       or extract(epoch from v_start)::int % v_step <> 0
       or extract(epoch from v_end)::int % v_step <> 0 then
      perform app.err('VALIDATION', 'block');
    end if;
    if not exists (select 1 from app.teachers x where x.id = (p ->> 'teacher_id')::int) then
      perform app.err('NOT_FOUND', 'teacher');
    end if;
    if v_id is null then
      insert into app.blocks (teacher_id, dow, on_date, start_time, end_time, valid_from, valid_to)
      values ((p ->> 'teacher_id')::int, (p ->> 'dow')::int, (p ->> 'on_date')::date, v_start, v_end,
              (p ->> 'valid_from')::date, (p ->> 'valid_to')::date)
      returning id into v_id;
    else
      update app.blocks x set
        teacher_id = (p ->> 'teacher_id')::int, dow = (p ->> 'dow')::int, on_date = (p ->> 'on_date')::date,
        start_time = v_start, end_time = v_end,
        valid_from = (p ->> 'valid_from')::date, valid_to = (p ->> 'valid_to')::date
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'block'); end if;
    end if;
    perform app.log(s, 'config.block', null, null);
    return jsonb_build_object('id', v_id);

  when 'closure' then
    if v_id is null then
      insert into app.closures (on_date, teacher_id, reason)
      values ((p ->> 'd')::date, (p ->> 'teacher_id')::int, coalesce(app.clean(p ->> 'reason'), ''))
      returning id into v_id;
    else
      update app.closures x set
        on_date = (p ->> 'd')::date, teacher_id = (p ->> 'teacher_id')::int,
        reason = coalesce(app.clean(p ->> 'reason'), '')
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'closure'); end if;
    end if;
    perform app.log(s, 'config.closure', null, null);
    return jsonb_build_object('id', v_id);

  else
    perform app.err('VALIDATION', 'kind');
  end case;
  return null;
exception
  when unique_violation then
    perform app.err('DUPLICATE', p_kind);
  when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format
       or datetime_field_overflow or numeric_value_out_of_range or string_data_right_truncation
       or invalid_parameter_value or foreign_key_violation then
    perform app.err('VALIDATION', p_kind);
end $$;

create or replace function public.oh_admin_delete(p_token text, p_kind text, p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
begin
  case p_kind
  when 'group' then
    if exists (select 1 from app.requests r where r.group_id = p_id)
       or exists (select 1 from app.appointments a where a.group_id = p_id) then
      perform app.err('IN_USE');
    end if;
    delete from app.groups x where x.id = p_id;
  when 'teacher' then
    if exists (select 1 from app.appointments a where a.teacher_id = p_id) then
      perform app.err('IN_USE');
    end if;
    delete from app.teachers x where x.id = p_id;
  when 'admin' then
    if p_id = s.admin_id then
      perform app.err('SELF');
    end if;
    delete from app.admins x where x.id = p_id;
  when 'week' then
    if exists (select 1 from app.requests r where r.week_id = p_id)
       or exists (select 1 from app.appointments a where a.week_id = p_id) then
      perform app.err('IN_USE');
    end if;
    delete from app.weeks x where x.id = p_id;
  when 'block' then
    delete from app.blocks x where x.id = p_id;
  when 'closure' then
    delete from app.closures x where x.id = p_id;
  when 'session' then
    update app.sessions x set revoked_at = app.now() where x.id = p_id and x.revoked_at is null;
  else
    perform app.err('VALIDATION', 'kind');
  end case;
  if not found then
    perform app.err('NOT_FOUND', p_kind);
  end if;
  perform app.log(s, 'config.' || p_kind || '.deleted', null, null, jsonb_build_object('id', p_id));
  return jsonb_build_object('ok', true);
end $$;

-- New code for a group / teacher / admin; optionally signs out every
-- device that used the old one (except the caller's own).
create or replace function public.oh_admin_rotate(p_token text, p_kind text, p_id int, p_revoke boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_code text;
  v_revoked int := 0;
begin
  case p_kind
  when 'group' then
    v_code := app.new_code(8);
    update app.groups x set code = v_code where x.id = p_id;
    if not found then perform app.err('NOT_FOUND', 'group'); end if;
    if p_revoke then
      update app.sessions x set revoked_at = app.now() where x.group_id = p_id and x.revoked_at is null;
      get diagnostics v_revoked = row_count;
    end if;
  when 'teacher' then
    v_code := app.new_code(10);
    update app.teachers x set code = v_code where x.id = p_id;
    if not found then perform app.err('NOT_FOUND', 'teacher'); end if;
    if p_revoke then
      update app.sessions x set revoked_at = app.now() where x.teacher_id = p_id and x.revoked_at is null;
      get diagnostics v_revoked = row_count;
    end if;
  when 'admin' then
    v_code := app.new_code(12);
    update app.admins x set code = v_code where x.id = p_id;
    if not found then perform app.err('NOT_FOUND', 'admin'); end if;
    if p_revoke then
      update app.sessions x set revoked_at = app.now()
       where x.admin_id = p_id and x.revoked_at is null and x.id <> s.id;
      get diagnostics v_revoked = row_count;
    end if;
  else
    perform app.err('VALIDATION', 'kind');
  end case;
  perform app.log(s, 'config.' || p_kind || '.rotated', case when p_kind = 'group' then p_id end, null,
                  jsonb_build_object('revoked', v_revoked));
  return jsonb_build_object('code', v_code, 'revoked', v_revoked);
end $$;

create or replace function public.oh_admin_weeks_generate(p_token text, p_start date, p_count int, p_first_no int default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_monday date;
  v_added int := 0;
  v_rows int;
begin
  if p_start is null or p_count is null or p_count < 1 or p_count > 52 then
    perform app.err('VALIDATION', 'weeks');
  end if;
  v_monday := p_start - (extract(isodow from p_start)::int - 1);
  for i in 0 .. p_count - 1 loop
    insert into app.weeks (start_date, label)
    values (v_monday + 7 * i, case when p_first_no is null then '' else 'W' || (p_first_no + i) end)
    on conflict (start_date) do nothing;
    get diagnostics v_rows = row_count;
    v_added := v_added + v_rows;
  end loop;
  perform app.log(s, 'config.weeks.generated', null, null, jsonb_build_object('added', v_added));
  return jsonb_build_object('added', v_added);
end $$;

create or replace function public.oh_admin_export(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
begin
  return jsonb_build_object(
    'requests', (select coalesce(jsonb_agg(jsonb_build_object(
                   'week', w.label, 'week_start', w.start_date, 'group_no', g.no, 'group_name', g.name,
                   'status', r.status, 'want', r.want, 'topic', r.topic, 'progress', r.progress,
                   'link', r.link, 'author', r.author,
                   'created_at', app.iso(r.created_at), 'updated_at', app.iso(r.updated_at),
                   'slots', (select coalesce(string_agg(to_char(rs.d, 'MM/DD') || ' ' || app.hm(rs.t), '; ' order by rs.d, rs.t), '')
                               from app.request_slots rs where rs.request_id = r.id)
                 ) order by w.start_date, g.no), '[]'::jsonb)
                 from app.requests r join app.weeks w on w.id = r.week_id join app.groups g on g.id = r.group_id),
    'appointments', (select coalesce(jsonb_agg(jsonb_build_object(
                       'week', w.label, 'date', a.d, 'time', app.hm(a.t), 'group_no', g.no, 'group_name', g.name,
                       'teacher', te.name, 'status', a.status, 'created_by', a.created_by,
                       'published_at', app.iso(a.published_at), 'cancelled_at', app.iso(a.cancelled_at),
                       'cancelled_by', a.cancelled_by, 'cancel_reason', a.cancel_reason,
                       'topic', (select r.topic from app.requests r where r.week_id = a.week_id and r.group_id = a.group_id)
                     ) order by a.d, a.t, g.no), '[]'::jsonb)
                     from app.appointments a
                     join app.weeks w on w.id = a.week_id
                     join app.groups g on g.id = a.group_id
                     join app.teachers te on te.id = a.teacher_id
                    where a.status <> 'draft')
  );
end $$;

-- ---------------------------------------------------------------------
-- Privileges: the oh_* functions are the only door in.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema app from public;

do $$
declare
  r text;
  f record;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema app from %I', r);
      execute format('revoke all on all tables in schema app from %I', r);
      execute format('revoke all on all sequences in schema app from %I', r);
      execute format('revoke all on all functions in schema app from %I', r);
    end if;
  end loop;
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'oh\_%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
