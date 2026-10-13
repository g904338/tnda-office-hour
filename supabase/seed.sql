-- Course data for TN0006, taken from the original prototype.
-- Codes are generated at random; read them back with
--   select no, name, code from app.groups;   (and app.teachers / app.admins)

update app.settings set
  course_code  = 'TN0006',
  course_title = '一場體驗如何發生：跨域數位製作實務',
  host_label   = '叁式 PM',
  location     = 'Discord 各組聊天室',
  lead_days    = 4,
  week_cap     = 2,
  day_cap      = 1,
  cancel_hours = 24
where id = 1;

insert into app.groups (no, name, code) values
  (1, '南宜到達的斜上方',     app.new_code(8)),
  (2, '看到太陽就知道完蛋了', app.new_code(8)),
  (3, '這組有誠意',           app.new_code(8)),
  (4, '閃身部',               app.new_code(8)),
  (5, '隨便打',               app.new_code(8)),
  (6, '會努力的',             app.new_code(8)),
  (7, '',                     app.new_code(8));

insert into app.teachers (name, code, sort) values
  ('Joseph',  app.new_code(10), 1),
  ('Prolong', app.new_code(10), 2),
  ('Tim',     app.new_code(10), 3);

insert into app.admins (name, code) values ('助教', app.new_code(12));

-- Weekly availability (1 = Monday)
insert into app.blocks (teacher_id, dow, start_time, end_time)
select t.id, b.dow, b.s::time, b.e::time
  from (values
    ('Joseph',  1, '17:00', '19:00'),
    ('Joseph',  2, '17:00', '19:00'),
    ('Prolong', 3, '10:00', '12:00'),
    ('Joseph',  3, '10:00', '12:00'),
    ('Prolong', 4, '10:00', '12:00'),
    ('Tim',     4, '16:00', '18:00'),
    ('Prolong', 5, '10:00', '12:00')
  ) as b (name, dow, s, e)
  join app.teachers t on t.name = b.name;

-- Semester weeks W7–W18; the week of 1/4 has no class but stays open.
insert into app.weeks (start_date, label, note)
select date '2026-10-19' + 7 * i,
       case when i <= 10 then 'W' || (7 + i) when i = 11 then '—' else 'W18' end,
       case when i = 11 then '本週無課' else '' end
  from generate_series(0, 12) as i;

insert into app.closures (on_date, reason) values ('2027-01-01', '元旦');
