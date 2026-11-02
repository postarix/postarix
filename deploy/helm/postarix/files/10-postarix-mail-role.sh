#!/bin/sh
# Runs once, when the PostgreSQL data directory is first created.
# Creates the read-only role Postfix uses. It can read the views in the "mail"
# schema (created by the API migrations) and nothing else.
set -eu
: "${POSTFIX_DB_PASSWORD:?POSTFIX_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v mail_password="$POSTFIX_DB_PASSWORD" -v owner="$POSTGRES_USER" -v dbname="$POSTGRES_DB" <<'SQL'
CREATE ROLE postarix_mail LOGIN PASSWORD :'mail_password';
CREATE SCHEMA IF NOT EXISTS mail AUTHORIZATION :"owner";
GRANT USAGE ON SCHEMA mail TO postarix_mail;
GRANT SELECT ON ALL TABLES IN SCHEMA mail TO postarix_mail;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA mail GRANT SELECT ON TABLES TO postarix_mail;
REVOKE ALL ON SCHEMA public FROM postarix_mail;
-- Nothing through PUBLIC either: no temporary tables, no other databases.
REVOKE TEMPORARY ON DATABASE :"dbname" FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO postarix_mail;
SQL
