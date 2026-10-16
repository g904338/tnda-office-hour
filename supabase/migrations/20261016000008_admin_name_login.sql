-- Admins can sign in by name too, like students and teachers. Each
-- admin account says whether its name works for that; the original
-- "助教" account stays code-only (a role word anyone could guess), as a
-- backup way in.
alter table app.admins add column name_login boolean not null default true;
update app.admins set name_login = false where name = '助教';

-- Sign in by name: students (roster), teachers, and admins that allow it.
-- Unknown names count as failed guesses, like codes.
create or replace function public.oh_login(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text := app.name_key(left(p_name, 100));
  r record;
  n int;
  v_token text := app.new_token();
  v app.sessions;
begin
  perform app.check_throttle();
  if k is null then
    return jsonb_build_object('ok', false, 'error', 'NAME_REQUIRED');
  end if;

  select count(*) into n from (
    select 1 from app.roster x join app.groups g on g.id = x.group_id
     where app.name_key(x.name) = k and g.active
    union all
    select 1 from app.teachers t where app.name_key(t.name) = k and t.active
    union all
    select 1 from app.admins a where app.name_key(a.name) = k and a.active and a.name_login
  ) m;
  if n = 0 then
    perform app.note_failure();
    return jsonb_build_object('ok', false, 'error', 'NAME_UNKNOWN');
  elsif n > 1 then
    return jsonb_build_object('ok', false, 'error', 'NAME_AMBIGUOUS');
  end if;

  select 'student' as role, x.group_id, null::int as teacher_id, null::int as admin_id, x.name into r
    from app.roster x join app.groups g on g.id = x.group_id
   where app.name_key(x.name) = k and g.active;
  if not found then
    select 'teacher' as role, null::int as group_id, t.id as teacher_id, null::int as admin_id, t.name into r
      from app.teachers t where app.name_key(t.name) = k and t.active;
  end if;
  if not found then
    select 'admin' as role, null::int as group_id, null::int as teacher_id, a.id as admin_id, a.name into r
      from app.admins a where app.name_key(a.name) = k and a.active and a.name_login;
  end if;

  insert into app.sessions (token_hash, role, group_id, teacher_id, admin_id, name, created_at, seen_at)
  values (app.hash_token(v_token), r.role, r.group_id, r.teacher_id, r.admin_id, r.name, app.now(), app.now())
  returning * into v;
  perform app.log(v, 'member.joined', v.group_id, null, jsonb_build_object('via', 'name'));
  return jsonb_build_object('ok', true, 'token', v_token, 'session', app.session_json(v));
end $$;

-- Rosters may not reuse a teacher's or a name-login admin's name either.
create or replace function public.oh_admin_roster(p_token text, p_group int, p_names jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_names text[] := '{}';
  v_keys text[] := '{}';
  v_raw text;
  v_name text;
  v_taken text;
begin
  if not exists (select 1 from app.groups g where g.id = p_group) then
    perform app.err('NOT_FOUND');
  end if;
  if p_names is null or jsonb_typeof(p_names) <> 'array' or jsonb_array_length(p_names) > 200 then
    perform app.err('VALIDATION', 'roster');
  end if;

  -- cleaned, non-empty, the first spelling of each name wins
  for v_raw in select jsonb_array_elements_text(p_names) loop
    v_name := app.clean(v_raw);
    continue when v_name is null or app.name_key(v_name) = any (v_keys);
    if length(v_name) > 20 then
      perform app.err('VALIDATION', 'roster');
    end if;
    v_names := v_names || v_name;
    v_keys := v_keys || app.name_key(v_name);
  end loop;

  select string_agg(x, '、') into v_taken
    from unnest(v_names) x
   where exists (select 1 from app.roster r where app.name_key(r.name) = app.name_key(x) and r.group_id <> p_group)
      or exists (select 1 from app.teachers t where app.name_key(t.name) = app.name_key(x))
      or exists (select 1 from app.admins a where app.name_key(a.name) = app.name_key(x) and a.name_login);
  if v_taken is not null then
    perform app.err('NAME_TAKEN', v_taken);
  end if;

  delete from app.roster r where r.group_id = p_group;
  insert into app.roster (group_id, name, created_at)
  select p_group, x, app.now() from unnest(v_names) with ordinality u (x, i) order by i;
  perform app.log(s, 'config.group.roster', p_group, null, jsonb_build_object('count', cardinality(v_names)));

  return jsonb_build_object('roster', to_jsonb(v_names));
exception
  when unique_violation then  -- another admin saved the same name a moment ago
    perform app.err('NAME_TAKEN', '');
end $$;

-- Admin configuration shows which admins can sign in by name.
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
                 'roster', (select coalesce(jsonb_agg(r.name order by r.id), '[]'::jsonb)
                              from app.roster r where r.group_id = g.id),
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
                 'name_login', x.name_login,
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

revoke execute on all functions in schema app from public;
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('oh_login', 'oh_admin_roster', 'oh_admin_config')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
