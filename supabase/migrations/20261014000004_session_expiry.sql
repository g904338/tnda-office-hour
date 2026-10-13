-- Sessions that have not been used for 180 days stop working; students
-- simply enter their group code again next semester.
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
  if not found or v.seen_at < app.now() - interval '180 days' then
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

revoke execute on function app.session(text, text[]) from public;
