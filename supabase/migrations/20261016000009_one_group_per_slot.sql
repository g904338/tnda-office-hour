-- Sessions now all happen in one Google Meet room, so a time slot can
-- hold only one group, even when several teachers are free then.
-- Assigning a second group to a taken slot is a soft issue (SLOT_TAKEN)
-- the admin has to confirm; the auto-scheduler never proposes it.

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
  -- one meeting room: one group per time slot, whatever the teacher
  if exists (select 1 from app.appointments a
              where a.d = p_d and a.t = p_t and a.group_id <> p_group
                and a.status <> 'cancelled' and a.id is distinct from p_appt) then
    v_issues := array_append(v_issues, 'SLOT_TAKEN');
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

-- Students see one place per slot, and slots already confirmed for
-- another group as full.
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
                'full', x.full,
                'demand', x.demand) order by x.d, x.t), '[]'::jsonb)
              from (select ws.d, ws.t, least(count(distinct ws.teacher_id), 1) as cap,
                           exists (select 1 from app.appointments a
                                    where a.d = ws.d and a.t = ws.t and a.status = 'confirmed'
                                      and a.group_id <> s.group_id) as full,
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

revoke execute on all functions in schema app from public;
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('oh_student_state')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
