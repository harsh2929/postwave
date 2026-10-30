# Moosewave local infrastructure

This directory's Docker Compose files are for local development and test only.
The sole Moosewave Cloud production contract is AWS ECS Fargate in `us-west-2`;
see [`aws/PRODUCTION_DEPLOY_RUNBOOK.md`](aws/PRODUCTION_DEPLOY_RUNBOOK.md).
The repository contract does not claim that a live environment exists.

Local development stack for Moosewave. Brings up the supporting services that
the Next.js web app and Go services talk to.

## Bring it up

```bash
# from repo root
docker compose -f infra/docker-compose.yml up -d
```

Listmonk selects the v6.1.0 version tag for development by default. A tag is
not immutable release provenance; staging and production require an approved
`listmonk/listmonk@sha256:<digest>`. To test another version locally without
editing the Compose file:

```bash
LISTMONK_VERSION=v6.1.0 docker compose -f infra/docker-compose.yml up -d
```

First boot will:

1. Start Postgres 16 and create the `postwave` database (main app DB).
2. Run `postgres/init.sql` to create the `listmonk` database and
   `listmonk_user` role.
3. Start Redis 7 (used by Asynq for engine job queues).
4. Run the one-shot `listmonk-init` container, which executes
   `./listmonk --install --idempotent --yes` against the freshly created
   `listmonk` DB.
5. Start the long-running Listmonk container on port 9000.

## What runs where

| Service   | Host port | Container          | Purpose                                |
|-----------|-----------|--------------------|----------------------------------------|
| Postgres  | 5432      | postwave-postgres  | Main app DB + Listmonk DB              |
| Redis     | 6379      | postwave-redis     | Asynq job queue                        |
| Listmonk  | 9000      | postwave-listmonk  | AGPL engine — HTTP-only consumer       |

## Credentials (dev only — do NOT reuse in production)

- Postgres admin: `postgres` / `public-local-demo-only` / db `postwave`
- Moosewave app role: `postwave_app` / `postwave_app_dev`
- Postgres listmonk: `listmonk_user` / `listmonk_dev` / db `listmonk`
- Listmonk admin: created on first run by `--install` (default `listmonk` /
  `listmonk` — change immediately by visiting http://localhost:9000).

Runtime services fail fast if `DATABASE_URL` is configured but Postgres cannot
be reached. For isolated UI demos only, set `POSTWAVE_ALLOW_MEMORY_FALLBACK=1`
to permit the in-memory stores.

## Tear down

```bash
docker compose -f infra/docker-compose.yml down            # keep data
docker compose -f infra/docker-compose.yml down -v         # nuke volumes
```

## License boundary reminder

Listmonk is AGPL. Moosewave application services talk to it only over HTTP at
`http://localhost:9000`. Never `import` Listmonk Go packages. See
[../LICENSE-BOUNDARY.md](../LICENSE-BOUNDARY.md).
