-- =====================================================================
-- Office Hour · calendar subscriptions
--
-- Every teacher and every group gets a secret feed URL that Google
-- Calendar, Apple Calendar or Outlook can subscribe to. The calendar app
-- polls it, so moves and cancellations show up without anyone exporting
-- anything again. The feed is served straight from PostgREST as
-- text/calendar through the "*/*" media type handler.
-- =====================================================================

create or replace function app.new_feed() returns text
language sql volatile set search_path = '' as $$
  select encode(uuid_send(gen_random_uuid()), 'hex')
$$;

alter table app.teachers add column if not exists feed text;
alter table app.groups add column if not exists feed text;
update app.teachers set feed = app.new_feed() where feed is null;
update app.groups set feed = app.new_feed() where feed is null;
alter table app.teachers alter column feed set default app.new_feed(), alter column feed set not null;
alter table app.groups alter column feed set default app.new_feed(), alter column feed set not null;
create unique index if not exists teachers_feed_uni on app.teachers (feed);
create unique index if not exists groups_feed_uni on app.groups (feed);

-- PostgREST returns functions of this type as raw bytes, whatever the
-- client accepts; the function sets the real Content-Type itself.
do $$
begin
  create domain "*/*" as bytea;
exception when duplicate_object then
  null;
end $$;

-- RFC 5545 text escaping
create or replace function app.ics_text(p text) returns text
language sql immutable set search_path = '' as $$
  select replace(replace(replace(replace(replace(coalesce(p, ''), '\', '\\'), ';', '\;'), ',', '\,'), E'\r', ''), E'\n', '\n')
$$;

-- RFC 5545 lines are folded at 75 octets (UTF-8 aware)
create or replace function app.ics_fold(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_out text := '';
  v_line text := '';
  v_bytes int := 0;
  v_ch text;
  v_n int;
begin
  for i in 1 .. char_length(p) loop
    v_ch := substr(p, i, 1);
    v_n := octet_length(v_ch);
    if v_bytes + v_n > 74 then
      v_out := v_out || v_line || E'\r\n ';
      v_line := '';
      v_bytes := 1;
    end if;
    v_line := v_line || v_ch;
    v_bytes := v_bytes + v_n;
  end loop;
  return v_out || v_line;
end $$;

create or replace function app.ics_stamp(p_d date, p_t time) returns text
language sql stable set search_path = '' as $$
  select to_char(((p_d + p_t) at time zone (select s.timezone from app.settings s where s.id = 1)) at time zone 'UTC',
                 'YYYYMMDD"T"HH24MISS"Z"')
$$;

create or replace function public.oh_calendar(p_feed text, apikey text default null) returns "*/*"
language plpgsql stable security definer set search_path = '' as $$
declare
  cfg app.settings := app.cfg();
  t app.teachers;
  g app.groups;
  v_name text;
  v_lines text[] := '{}';
  r record;
  v_end interval := make_interval(mins => cfg.slot_minutes);
  v_now text := to_char(app.now() at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"');
begin
  if p_feed is not null and length(p_feed) = 32 then
    select * into t from app.teachers x where x.feed = p_feed and x.active;
    if t.id is null then
      select * into g from app.groups x where x.feed = p_feed and x.active;
    end if;
  end if;
  v_name := case
    when t.id is not null then 'Office Hour · ' || t.name
    when g.id is not null then 'Office Hour · ' || app.group_title(g.id)
    else 'Office Hour（訂閱連結已失效）'
  end;

  v_lines := array['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tnda-office-hour//calendar//ZH-TW', 'CALSCALE:GREGORIAN',
                   'METHOD:PUBLISH', 'X-WR-CALNAME:' || app.ics_text(v_name), 'X-WR-TIMEZONE:' || cfg.timezone,
                   'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M'];

  for r in
    select a.id, a.d, a.t, gr.id as gid, te.name as tname,
           rq.topic, rq.progress, rq.link, rq.author
      from app.appointments a
      join app.groups gr on gr.id = a.group_id
      join app.teachers te on te.id = a.teacher_id
      left join app.requests rq on rq.week_id = a.week_id and rq.group_id = a.group_id
     where a.status = 'confirmed'
       and a.d >= app.today() - 90
       and ((t.id is not null and a.teacher_id = t.id) or (g.id is not null and a.group_id = g.id))
     order by a.d, a.t
  loop
    v_lines := v_lines || array[
      'BEGIN:VEVENT',
      'UID:oh-' || r.id || '@tnda-office-hour',
      'DTSTAMP:' || v_now,
      'DTSTART:' || app.ics_stamp(r.d, r.t),
      'DTEND:' || app.ics_stamp(r.d, r.t + v_end),
      'SUMMARY:' || app.ics_text(case
        when t.id is not null then 'Office Hour · ' || app.group_title(r.gid) || coalesce('｜' || r.topic, '')
        else 'Office Hour · ' || cfg.host_label || case when cfg.show_teacher_names then ' ' || r.tname else '' end
             || coalesce('｜' || r.topic, '')
      end),
      'LOCATION:' || app.ics_text(cfg.location),
      'DESCRIPTION:' || app.ics_text(concat_ws(E'\n',
        app.group_title(r.gid),
        case when r.topic is not null then '題目：' || r.topic end,
        case when t.id is not null and r.progress is not null then '進度：' || r.progress end,
        case when r.link is not null then '資料：' || r.link end)),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Office Hour', 'END:VALARM',
      'END:VEVENT'];
  end loop;
  v_lines := v_lines || 'END:VCALENDAR'::text;

  perform set_config('response.headers',
    jsonb_build_array(
      jsonb_build_object('Content-Type', 'text/calendar; charset=utf-8'),
      jsonb_build_object('Cache-Control', 'max-age=300'),
      jsonb_build_object('Content-Disposition', 'inline; filename="office-hour.ics"'))::text,
    true);
  return convert_to((select string_agg(app.ics_fold(l), E'\r\n') from unnest(v_lines) as l) || E'\r\n', 'UTF8');
end $$;

-- The signed-in person's own feed (a teacher's, or their group's).
-- p_reset issues a new URL and retires the old one.
create or replace function public.oh_calendar_feed(p_token text, p_reset boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['student', 'teacher']);
  v text;
begin
  if s.role = 'teacher' then
    if p_reset then
      update app.teachers x set feed = app.new_feed() where x.id = s.teacher_id;
    end if;
    select x.feed into v from app.teachers x where x.id = s.teacher_id;
  else
    if p_reset then
      update app.groups x set feed = app.new_feed() where x.id = s.group_id;
      perform app.log(s, 'config.group.feed_reset', s.group_id, null);
    end if;
    select x.feed into v from app.groups x where x.id = s.group_id;
  end if;
  return jsonb_build_object('feed', v);
end $$;

revoke execute on all functions in schema app from public;
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('oh_calendar', 'oh_calendar_feed')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
