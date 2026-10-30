-- Moosewave local-dev Postgres init script.
--
-- The main `postwave` database is created automatically by the
-- POSTGRES_DB env var on first boot. Here we provision the secondary
-- `listmonk` database and its dedicated role, used by the Listmonk
-- standalone container.
--
-- This file runs once on first container start (empty data dir) via
-- /docker-entrypoint-initdb.d. It is a no-op on subsequent boots.

CREATE ROLE postwave_app WITH
    LOGIN
    PASSWORD 'postwave_app_dev'
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOINHERIT;

CREATE ROLE listmonk_user WITH LOGIN PASSWORD 'listmonk_dev';

GRANT CONNECT ON DATABASE postwave TO postwave_app;

CREATE DATABASE listmonk WITH OWNER listmonk_user ENCODING 'UTF8';

GRANT ALL PRIVILEGES ON DATABASE listmonk TO listmonk_user;

-- Connect into the new DB to grant schema-level privileges.
\connect listmonk

GRANT ALL ON SCHEMA public TO listmonk_user;
ALTER SCHEMA public OWNER TO listmonk_user;
