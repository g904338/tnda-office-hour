-- =====================================================================
-- Office Hour · schema
--
-- Every table lives in the private schema "app", which the REST API does
-- not expose. Browsers only ever call the SECURITY DEFINER functions in
-- "public" (prefix oh_, see the api migration). Each of those checks a
-- session token and applies the booking rules, so the rules hold no
-- matter which client calls them.
-- =====================================================================

create schema if not exists app;
revoke all on schema app from public;

-- ---------------------------------------------------------------------
-- Settings (single row)
-- ---------------------------------------------------------------------
create table app.settings (
  id                 int primary key default 1 check (id = 1),
  course_code        text not null default ''             check (length(course_code) <= 20),
  course_title       text not null default ''             check (length(course_title) <= 80),
  host_label         text not null default 'PM'           check (length(host_label) between 1 and 20),
  location           text not null default ''             check (length(location) <= 60),
  notice             text not null default ''             check (length(notice) <= 500),
  lead_days          int  not null default 4              check (lead_days between 0 and 60),
  week_cap           int  not null default 2              check (week_cap between 1 and 8),
  day_cap            int  not null default 1              check (day_cap between 1 and 8),
  cancel_hours       int  not null default 24             check (cancel_hours between 0 and 336),
  slot_minutes       int  not null default 30             check (slot_minutes in (15, 20, 30, 45, 60)),
  show_teacher_names boolean not null default false,
  timezone           text not null default 'Asia/Taipei',
  updated_at         timestamptz not null default now()
);
insert into app.settings (id) values (1);

-- ---------------------------------------------------------------------
-- People. Codes are random, system generated and can be rotated; the
-- three code lengths differ (8 / 10 / 12) so they never collide.
-- ---------------------------------------------------------------------
create table app.groups (
  id         int generated always as identity primary key,
  no         int  not null unique check (no between 1 and 999),
  name       text not null default '' check (length(name) <= 40),
  code       text not null unique,
  active     boolean not null default true,
  webhook    text check (webhook is null or webhook ~ '^https://(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$'),
  created_at timestamptz not null default now()
);

create table app.teachers (
  id         int generated always as identity primary key,
  name       text not null check (length(name) between 1 and 40),
  code       text not null unique,
  active     boolean not null default true,
  sort       int  not null default 0,
  created_at timestamptz not null default now()
);

create table app.admins (
  id         int generated always as identity primary key,
  name       text not null check (length(name) between 1 and 40),
  code       text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- One row per signed-in device. Only the SHA-256 of the token is stored.
create table app.sessions (
  id         bigint generated always as identity primary key,
  token_hash bytea not null unique,
  role       text  not null check (role in ('student', 'teacher', 'admin')),
  group_id   int references app.groups (id) on delete cascade,
  teacher_id int references app.teachers (id) on delete cascade,
  admin_id   int references app.admins (id) on delete cascade,
  name       text  not null check (length(name) between 1 and 40),
  created_at timestamptz not null default now(),
  seen_at    timestamptz not null default now(),
  revoked_at timestamptz,
  check ((role = 'student') = (group_id is not null)),
  check ((role = 'teacher') = (teacher_id is not null)),
  check ((role = 'admin')   = (admin_id is not null))
);
create index sessions_group_idx on app.sessions (group_id) where revoked_at is null;

-- Failed code attempts, for throttling guessing.
create table app.join_attempts (
  ip text not null,
  at timestamptz not null default now()
);
create index join_attempts_idx on app.join_attempts (ip, at);

-- ---------------------------------------------------------------------
-- Calendar
-- ---------------------------------------------------------------------
create table app.weeks (
  id         int generated always as identity primary key,
  start_date date not null unique check (extract(isodow from start_date) = 1),
  label      text not null default '' check (length(label) <= 12),
  open       boolean not null default true,
  note       text not null default '' check (length(note) <= 60)
);

-- Availability. A recurring block has dow (1 = Monday) and an optional
-- valid_from / valid_to range; a one-off block has on_date instead.
create table app.blocks (
  id         int generated always as identity primary key,
  teacher_id int  not null references app.teachers (id) on delete cascade,
  dow        int  check (dow between 1 and 7),
  on_date    date,
  start_time time not null,
  end_time   time not null,
  valid_from date,
  valid_to   date,
  check ((dow is null) <> (on_date is null)),
  check (end_time > start_time),
  check (valid_from is null or valid_to is null or valid_to >= valid_from)
);

-- Days off: a holiday for everyone (teacher_id null) or one teacher's leave.
create table app.closures (
  id         int generated always as identity primary key,
  on_date    date not null,
  teacher_id int references app.teachers (id) on delete cascade,
  reason     text not null default '' check (length(reason) <= 40)
);
create unique index closures_uni on app.closures (on_date, coalesce(teacher_id, 0));

-- ---------------------------------------------------------------------
-- Requests: one per group per week, with every slot that would work.
-- ---------------------------------------------------------------------
create table app.requests (
  id         bigint generated always as identity primary key,
  week_id    int  not null references app.weeks (id) on delete cascade,
  group_id   int  not null references app.groups (id) on delete cascade,
  topic      text not null check (length(topic) between 1 and 80),
  progress   text not null check (length(progress) between 1 and 1000),
  link       text check (link is null or length(link) <= 500),
  want       int  not null default 1 check (want between 1 and 8),
  author     text not null,
  status     text not null default 'open' check (status in ('open', 'withdrawn')),
  version    int  not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (week_id, group_id)
);

create table app.request_slots (
  request_id bigint not null references app.requests (id) on delete cascade,
  d          date not null,
  t          time not null,
  primary key (request_id, d, t)
);
create index request_slots_dt_idx on app.request_slots (d, t);

-- ---------------------------------------------------------------------
-- Appointments. Drafts are only visible to admins until published.
-- ---------------------------------------------------------------------
create table app.appointments (
  id            bigint generated always as identity primary key,
  week_id       int  not null references app.weeks (id) on delete cascade,
  group_id      int  not null references app.groups (id) on delete cascade,
  teacher_id    int  not null references app.teachers (id),
  d             date not null,
  t             time not null,
  status        text not null default 'draft' check (status in ('draft', 'confirmed', 'cancelled')),
  created_by    text not null default '',
  created_at    timestamptz not null default now(),
  published_at  timestamptz,
  cancelled_at  timestamptz,
  cancelled_by  text,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 200)
);
create unique index appointments_teacher_slot on app.appointments (teacher_id, d, t) where status <> 'cancelled';
create unique index appointments_group_slot   on app.appointments (group_id, d, t)   where status <> 'cancelled';
create index appointments_week_idx  on app.appointments (week_id);
create index appointments_group_idx on app.appointments (group_id, d);

-- ---------------------------------------------------------------------
-- Activity log (admin feed + audit trail)
-- ---------------------------------------------------------------------
create table app.events (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_role text,
  actor_name text,
  kind       text not null,
  group_id   int references app.groups (id) on delete set null,
  week_id    int references app.weeks (id) on delete set null,
  data       jsonb not null default '{}'
);
create index events_at_idx on app.events (at desc);

-- ---------------------------------------------------------------------
-- Lock everything down. Nothing here is reachable except through the
-- oh_* functions, which run as the owner.
-- ---------------------------------------------------------------------
alter table app.settings      enable row level security;
alter table app.groups        enable row level security;
alter table app.teachers      enable row level security;
alter table app.admins        enable row level security;
alter table app.sessions      enable row level security;
alter table app.join_attempts enable row level security;
alter table app.weeks         enable row level security;
alter table app.blocks        enable row level security;
alter table app.closures      enable row level security;
alter table app.requests      enable row level security;
alter table app.request_slots enable row level security;
alter table app.appointments  enable row level security;
alter table app.events        enable row level security;

revoke all on all tables in schema app from public;
revoke all on all sequences in schema app from public;
