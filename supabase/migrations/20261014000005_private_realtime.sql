-- Realtime pings move to a private channel: browsers may listen to
-- "oh-sync" but only the database can broadcast on it, so nobody can
-- flood every open page with fake "something changed" messages.
create or replace function app.ping() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform realtime.send(jsonb_build_object('t', tg_table_name), 'change', 'oh-sync', true);
  exception when others then
    null;  -- realtime unavailable (local tests); writes must never fail because of it
  end;
  return null;
end $$;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists "oh-sync: listen only" on realtime.messages';
    execute $p$
      create policy "oh-sync: listen only" on realtime.messages
        for select to anon, authenticated
        using (realtime.topic() = 'oh-sync' and extension = 'broadcast')
    $p$;
  end if;
end $$;
