#!/bin/sh
# Resets the local Supabase stack (supabase start) to a fresh semester with
# fixed, throwaway codes for testing: admin LOCALADMIN01, groups LOCALG01…,
# teachers LOCALT0001…  Never run against the cloud project.
set -e
cd "$(dirname "$0")/.."
supabase db reset --local >/dev/null 2>&1
PSQL=${PSQL:-psql}
command -v "$PSQL" >/dev/null 2>&1 || PSQL=/opt/homebrew/opt/libpq/bin/psql
"$PSQL" postgresql://postgres:postgres@127.0.0.1:54322/postgres -q -c "
  update app.admins set code = 'LOCALADMIN01';
  update app.groups set code = 'LOCALG' || lpad(no::text, 2, '0');
  update app.teachers set code = 'LOCALT' || lpad(sort::text, 4, '0');"
echo "local database reset"
