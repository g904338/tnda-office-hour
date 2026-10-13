-- Start a semester fresh: keeps the course setup (settings, groups,
-- teachers, availability, weeks, holidays) but removes every request,
-- session, sign-in and log entry, and issues brand-new invite codes and
-- calendar links. Everyone has to join again with the new links.
--
--   psql "$DATABASE_URL" -f scripts/fresh-start.sql
begin;

truncate app.events, app.appointments, app.request_slots, app.requests,
         app.sessions, app.join_attempts restart identity;

update app.groups   set code = app.new_code(8),  feed = app.new_feed();
update app.teachers set code = app.new_code(10), feed = app.new_feed();
update app.admins   set code = app.new_code(12);

commit;

select 'groups' as what, count(*) from app.groups
union all select 'teachers', count(*) from app.teachers
union all select 'admins', count(*) from app.admins
union all select 'weeks', count(*) from app.weeks
union all select 'requests', count(*) from app.requests
union all select 'sessions', count(*) from app.sessions;
