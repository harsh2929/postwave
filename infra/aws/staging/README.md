<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Moosewave lean staging — runbook (NON-PRODUCTION)

**Paused on 13 October 2026:** all 10 current ECS services and the database are
stopped; the public Moosewave website remains online. Use the
[pause record and restart guide](PAUSED-2026-10-13.md) to restore this environment.
The older `pause.sh` / `resume.sh` and inventory below only cover four services.

A small, cheap, disposable copy of the platform on `*.staging.moosewave.com`,
built from `apps/api` and `apps/web`. It exists to test the product end to end
before production, not to be production: one task per service, one
self-managed Postgres, no NAT, no WAF, no sidecars, no Campaign Assurance. The
images it runs are unsigned staging artifacts. **Never promote them to
production.**

Everything here is driven by the scripts in `scripts/`. They create, update,
pause and delete staging only, and each one checks that a resource carries the
tag `Project=moosewave-staging` before it touches it.

## What runs where

| Stack (script step) | Region | Holds |
|---|---|---|
| `moosewave-staging-cost-global` (`cost-global`) | us-east-1 | Monthly ($160) and daily ($6.50) cost budgets, and a tag-scoped Cost Anomaly Detection monitor. |
| `moosewave-staging-cost-regional` (`cost-regional`) | us-west-2 | Alert topic, the Fargate/ALB/database/Valkey alarms, an unexpected-resource rule, and the daily cost digest. |
| `moosewave-staging-ses` (`ses`) | eu-west-1 | The `staging.moosewave.com` SES identity (Easy DKIM), configuration set `moosewave-staging`, and the bounce and complaint topics. |
| `moosewave-staging-base` (`base`) | us-west-2 | KMS, S3, Postgres 16 on EC2, Valkey, Cloud Map, the ECS cluster, the ALB with its certificate and DNS, and IAM. |
| `moosewave-staging-services` (`services`) | us-west-2 | ECS services for clamav, listmonk, api and web, plus the migrator task definition. |

Outside the stacks, the scripts own:
- the `postwave/staging/*` secrets (`secrets.sh`);
- five ECR repositories (`postwave-api`, `-web`, `-db-migrator`, `-clamav`, `-listmonk`) in us-west-2 (`build-images.sh`);
- the CodeBuild project `moosewave-staging-images` in us-east-1, with its log group and its objects in the account's CodeBuild source bucket (`build-images.sh`).

Public names, all served through one ALB:

| Name | Goes to |
|---|---|
| `staging.moosewave.com`, `app.`, `forms.` | web |
| `api.`, `archive.` | API |

`assets.`, `docs.` and the sidecar hosts do not exist.

Why Postgres runs on EC2 and not RDS: ten migrations create `NOLOGIN BYPASSRLS`
definer roles, and only a real superuser can do that. The migrator therefore
runs as `postgres`, as it does in CI. `postwave_app`, `postwave_ops` and
`listmonk_user` stay unprivileged.

## Files

| File | Purpose |
|---|---|
| `cost-guard-global.yaml`, `cost-guard-regional.yaml`, `ses.yaml`, `base.yaml`, `services.yaml` | The stacks. Each template's header documents its parameters. |
| `buildspec-images.yml` | CodeBuild buildspec: builds, pushes and records the images. |
| `api-mjml.Dockerfile` | The API image plus a pinned mjml 5.4.0 CLI (`MJML_BIN`). Without it, production mode refuses every MJML render. `Dockerfile.go` is not modified. |
| `mjml/package.json`, `mjml/package-lock.json` | The exact mjml dependency tree, installed with `npm ci`. |
| `clamav.Dockerfile` | clamav-debian 1.4.6 (pinned) with `TestDatabases no` and `ConcurrentDatabaseReload no`, so it fits its 2 GB task. |
| `scripts/common.sh` | Shared constants and helpers: endpoints, the tag interlock, stack and secret readers. |
| `scripts/secrets.sh` | Creates and checks the secrets. |
| `scripts/build-images.sh` | Exports a commit, runs the CodeBuild build and records the digests. |
| `scripts/codebuild-images.sh` | The build's own steps; runs inside CodeBuild. |
| `scripts/deploy.sh` | Creates and updates the stacks through change sets. |
| `scripts/deploy-web-only.sh` | Rolls only the recorded web image through a guarded change set using the deployed services template; leaves the API and its provider secrets untouched. |
| `scripts/migrate.sh` | Runs the migrator task. |
| `scripts/db-post-migrate.sh` | Database-host steps through SSM. |
| `scripts/pause.sh`, `scripts/resume.sh` | Stop and start the costly parts. |
| `scripts/teardown.sh` | Tag-interlocked deletion. |
| `scripts/smoke.sh` | HTTPS checks from the outside. |
| `scripts/tests/run.sh`, `scripts/tests/fake-aws` | Offline tests for all of the above, and the fake AWS CLI they run against. |

Every script prints its usage with `--help`. The five stateful scripts also
accept `DRY_RUN=1`: `deploy.sh`, `teardown.sh`, `pause.sh`, `resume.sh` and
`secrets.sh`. So do `build-images.sh`, `migrate.sh` and `db-post-migrate.sh`.
A dry run makes read-only AWS calls and prints what it would do, but calls no
write API.

## Prerequisites

- **Credentials:** an administrator AWS identity for the account in the usual
  way (`AWS_PROFILE` or the default credentials).
- **Tools:**
  - AWS CLI v2, `jq`, `curl`, `openssl`, `git`, `zip` and `unzip`;
  - bash 3.2 or later (macOS `/bin/bash` is enough);
  - Docker only for `scripts/tests/run.sh`, because the images build in
    CodeBuild.
- **IPv6.** This machine's IPv4 path drops full-size packets, so every AWS
  call goes to the service's dual-stack endpoint (see `common.sh`). If your
  IPv4 path is healthy and IPv6 is missing, set
  `STAGING_AWS_ENDPOINTS=default`. Never set the CLI-wide
  `use_dualstack_endpoint`: Secrets Manager has no `*.api.aws` name, so every
  secret call would fail.
- **Owner data comes only from the environment.** Nothing personal is
  committed.
  ```bash
  export ALERT_EMAIL=...        # receives budgets, alarms, OPS_ALERT_EMAIL; may receive staging mail (plain address, no * or ?)
  export HOSTED_ZONE_ID=...     # optional: the public moosewave.com zone (found by exact name otherwise)
  ```
- **Activate the `Project` cost allocation tag once,** so that the budgets and
  the anomaly monitor can see tagged spend:
  ```bash
  aws ce update-cost-allocation-tags-status \
    --cost-allocation-tags-status TagKey=Project,Status=Active
  ```
  Until it is active, `deploy.sh` notices, says so, and scopes the budgets to
  us-west-2 only.
- **A commit that can build the web image for another domain.** Its
  `apps/web/Dockerfile` must have `ARG POSTWAVE_WEB_CANONICAL_DOMAIN`, and its
  `check-container-build-env.mjs` must honour it. `build-images.sh` refuses a
  web build from a commit without them.
- **For every platform mail, a commit that passes the platform sender to the
  API's notification workers.** Without it, three workers fall back to
  `@moosewave.com` senders: segment-decay alerts (`noreply@`), dashboard
  digests (`digest@`) and webhook-failure alerts (`alerts@`). The API role
  may send only as `*@staging.moosewave.com`, so SES refuses those three with
  AccessDenied; everything else works. The fix is the API's
  `configuredPlatformSender()` (it reads `POSTWAVE_AUTH_FROM_ADDRESS`, which
  staging sets). `build-images.sh` warns when it builds an API from a commit
  without it.
- **Only committed work is built.** `build-images.sh` ships the commit you
  name, never the working tree.

## First bring-up, in order

Run everything from the repository root. Each step can be rerun safely.

1. **Cost guard first.**
   ```bash
   infra/aws/staging/scripts/deploy.sh cost-global cost-regional
   ```
   Confirm the SNS subscription email ("AWS Notification - Subscription
   Confirmation") within 3 days. Then invoke the digest once to prove the
   alert path end to end. It makes one or two Cost Explorer requests, at
   $0.01 each:
   ```bash
   aws lambda invoke --region us-west-2 \
     --function-name moosewave-staging-cost-digest /dev/null
   ```
2. **Secrets.**
   ```bash
   infra/aws/staging/scripts/secrets.sh bootstrap
   ```
   This creates every generated secret, including the three database DSNs,
   all on host `db.postwave.internal`. `redis-url` comes later, from base.
   Third-party values are optional; each needs its own command:
   ```bash
   infra/aws/staging/scripts/secrets.sh put stripe-secret-key
   ```
   The value is read from stdin, and Stripe takes TEST keys only.
3. **Images** (about 30–40 minutes on CodeBuild):
   ```bash
   infra/aws/staging/scripts/build-images.sh      # default IMAGES=api-mjml,db-migrator,clamav,listmonk
   ```
   The digests land in `~/.local/state/moosewave-staging/digests.env`, and
   `deploy.sh` picks them up from there.
4. **SES and base.**
   ```bash
   infra/aws/staging/scripts/deploy.sh ses base
   ```
   base takes about 25–40 minutes: the certificate validates by DNS, Valkey
   starts, and the database host bootstraps and signals success. Then arm the
   resource-id alarms and write `redis-url`:
   ```bash
   infra/aws/staging/scripts/deploy.sh cost-regional
   infra/aws/staging/scripts/secrets.sh redis-url
   ```
   Expect one `moosewave-staging-db-cpu-credits` ALARM email about 15
   minutes later. A T4g in standard mode launches with no CPU credits and
   earns 24 an hour, while the bootstrap and the migrations spend them. It
   clears itself after an idle hour or two, and it fires again only after a
   pause longer than 7 days, when the credits expire.
   Once the secrets exist, `deploy.sh all` runs steps 1, 4 and 5 in one go.
5. **Services, all stopped.** This creates the task definitions, including the
   migrator.
   ```bash
   infra/aws/staging/scripts/deploy.sh services
   ```
6. **Migrate.** The first run on the empty database stops with exit 5 (it
   replays migration 0339's reviewed partition cutover). Rerun it with the
   bootstrap override:
   ```bash
   infra/aws/staging/scripts/migrate.sh
   infra/aws/staging/scripts/migrate.sh --allow-unsafe-bootstrap
   ```
   The script allows the override only when a dry-run task proves the
   database has no migrations applied. It always ends with a plain run that
   must report "migrations: nothing to do".
7. **Let postwave_ops log in** (migration 1700 created it `NOLOGIN`):
   ```bash
   infra/aws/staging/scripts/db-post-migrate.sh ops-login
   ```
8. **ClamAV, then Listmonk, then Listmonk's API user.** The API's Listmonk
   password is this user's token. The same step points Listmonk's SMTP at its
   own loopback, so Listmonk delivers no mail (see Known limitations):
   ```bash
   DEPLOY_CLAMAV=true infra/aws/staging/scripts/deploy.sh services
   DEPLOY_LISTMONK=true infra/aws/staging/scripts/deploy.sh services
   infra/aws/staging/scripts/db-post-migrate.sh listmonk-api-user   # restarts listmonk
   ```
   Rerun it after anything that reinstalls Listmonk's database.
9. **API.**
   ```bash
   DEPLOY_API=true infra/aws/staging/scripts/deploy.sh services
   infra/aws/staging/scripts/smoke.sh api
   ```
   A fresh listmonk v6.1.0 creates its transactional template as id 3, which
   is the default. Check it once with an authenticated `GET /api/templates` on
   listmonk. If it differs, redeploy with `LISTMONK_TEMPLATE_ID=<id>`.
10. **SES events to the API.** The API must answer `/api/ready` first,
    because SNS sends its one confirmation immediately:
    ```bash
    SES_API_SUBSCRIBE=1 infra/aws/staging/scripts/deploy.sh ses
    ```
    Find each `SubscribeURL` in the API log (`/ecs/postwave-staging/api`) and
    open it within 3 days.
11. **Consent key, then web.** Follow the next section, then:
    ```bash
    IMAGES=web CONSENT_SITE_KEY=pwk_... infra/aws/staging/scripts/build-images.sh
    DEPLOY_WEB=true infra/aws/staging/scripts/deploy.sh services
    infra/aws/staging/scripts/smoke.sh
    ```

## Minting the consent key and rebuilding web

The web image bakes in a `pwk_` consent site key, and that key lives in the
staging database. So mint it against the running staging API, and mint a new
one after any database rebuild.

Signup starts a session at once; email verification is not needed. The key
endpoint requires the dashboard origin.

```bash
jar=$(mktemp)
read -r -s -p 'staging owner password (12+ chars): ' PW; echo
jq -n --arg e "$ALERT_EMAIL" --arg p "$PW" \
  '{email:$e, password:$p, workspace_name:"Moosewave Staging", workspace_slug:"moosewave-staging"}' |
  curl -sS -c "$jar" -H 'Content-Type: application/json' -H 'Origin: https://app.staging.moosewave.com' \
    --data @- https://api.staging.moosewave.com/api/v1/auth/signup >/dev/null
unset PW
CONSENT_SITE_KEY=$(curl -sS -b "$jar" -H 'Content-Type: application/json' \
  -H 'Origin: https://app.staging.moosewave.com' --data '{"label":"staging web"}' \
  https://api.staging.moosewave.com/api/v1/conversions/keys | jq -r .plaintext)
rm -f "$jar"
printf '%s\n' "$CONSENT_SITE_KEY" | grep -Eq '^pwk_[0-9a-f]{48}$' && echo "key minted"
```

Log in instead of signing up if the workspace already exists
(`POST /api/v1/auth/login` with `{email, password}`).

The key is public by design: it ships in the browser bundle. Keep it with the
build. Then build and roll web:

```bash
IMAGES=web CONSENT_SITE_KEY="$CONSENT_SITE_KEY" infra/aws/staging/scripts/build-images.sh
DEPLOY_WEB=true infra/aws/staging/scripts/deploy.sh services
```

The web build uses:
- `POSTWAVE_WEB_CANONICAL_DOMAIN=staging.moosewave.com` and the staging origins;
- the uploads bucket's regional origin (a base output);
- `https://assets.staging.moosewave.com` as the assets base.

It is checked with `scripts/release/verify-web-image.sh` before it is pushed.

## Everyday operations

### Dodo Payments test-mode setup

The API task is configured for Dodo Payments test mode. Before deploying a new
API revision, store the complete test credential set without printing values:

```bash
infra/aws/staging/scripts/secrets.sh put dodo-payments-api-key
infra/aws/staging/scripts/secrets.sh put dodo-payments-webhook-key
infra/aws/staging/scripts/secrets.sh put dodo-payments-product-launch-monthly
infra/aws/staging/scripts/secrets.sh put dodo-payments-product-growth-monthly
infra/aws/staging/scripts/secrets.sh put dodo-payments-product-scale-monthly
infra/aws/staging/scripts/secrets.sh check
```

Use three distinct test-mode `pdt_...` product IDs. Configure Dodo's test
webhook destination as
`https://api.staging.moosewave.com/api/public/dodo/webhook`. Leave
`BILLING_LAUNCH_APPROVAL` unset until the full checkout, portal, subscription,
failed-payment recovery, cancellation, refund, and replay rehearsal has a
reviewed evidence record. The deploy script rejects a partial Dodo secret set,
and `DeployApi=true` rejects a missing set.

- **New code:** commit it, build, deploy.
  ```bash
  infra/aws/staging/scripts/build-images.sh
  infra/aws/staging/scripts/deploy.sh services
  ```
  `deploy.sh` prints every digest it changes. Set `KEEP_IMAGES=1` to leave the
  deployed images alone.
- **New code with new migrations:** the new API must not start before its
  schema exists, and the migrator task definition lives in the same stack as
  the API. So stop the API and web while the new migrator lands, migrate, then
  start both:
  ```bash
  infra/aws/staging/scripts/build-images.sh        # api-mjml, db-migrator, web
  DEPLOY_API=false DEPLOY_WEB=false infra/aws/staging/scripts/deploy.sh services
  infra/aws/staging/scripts/migrate.sh             # must end "nothing to do"
  DEPLOY_API=true DEPLOY_WEB=true infra/aws/staging/scripts/deploy.sh services
  infra/aws/staging/scripts/smoke.sh
  ```
  The site is down for the few minutes between the first and last deploy.
- **Rebuild web** whenever its origins, the consent key or its code change.
  The API image does not need rebuilding for that.
- **Web-only rollout while the next API template needs unavailable Dodo test
  secrets:** build `IMAGES=web` from the intended commit, then run
  `infra/aws/staging/scripts/deploy-web-only.sh`. It checks the tagged ECR
  digest against that commit, retains the currently deployed template and all
  non-web parameters, and refuses a change set that touches any non-web
  resource. `DRY_RUN=1` performs the read-only preflight.
- **Turn a service on or off:** set `DEPLOY_<SERVICE>=true|false` for
  `deploy.sh services`. Flags you don't set keep their current values.
- **Status:** `deploy.sh status` prints every stack with its outputs.
  `secrets.sh check` reports missing, untagged or inconsistent secrets
  without printing any value.
- **Alert email:** change `ALERT_EMAIL`, then run `deploy.sh all`. It also
  changes the one address outside moosewave.com that the API may mail.
- **Change-set guard:** a change set that would replace or remove a stateful
  resource is refused, and deleted before execution. That covers the
  database instance, Valkey, the buckets, the KMS keys, the Cloud Map
  namespace, and the SES identity and configuration set. `ALLOW_REPLACEMENT=1`
  overrides it, so use it only when losing that resource's data is intended.
  `DbImageId` is never refreshed automatically, because a new AMI id would
  replace the database.

## Pause and resume

```bash
infra/aws/staging/scripts/pause.sh    # services to 0 (web, api, listmonk, clamav), then stop the database
infra/aws/staging/scripts/resume.sh   # database, then clamav+listmonk, api, web (only those whose flag is true)
infra/aws/staging/scripts/smoke.sh
```

Paused, the ALB, Valkey, DNS, secrets and every byte of data stay. The public
names answer 503 and the cost drops to about $1.7 a day.

Both scripts refuse unless:
- the stacks, the cluster, every service and the database instance carry the
  staging tag;
- no migrator task is running (pause only).

## Teardown

```bash
DRY_RUN=1 infra/aws/staging/scripts/teardown.sh     # inventory + interlock, deletes nothing
infra/aws/staging/scripts/teardown.sh               # asks you to type "moosewave-staging"
```

It first inventories everything it would delete and tag-checks each item. If
any item is untagged, or a stack does not come from these templates, it stops
before deleting anything.

Then it deletes, in order:
1. stray tasks;
2. the services stack;
3. the bucket contents;
4. the base stack (its KMS keys enter a 7-day pending deletion);
5. leftover ACM validation CNAMEs, only when no certificate still needs them;
6. the database snapshots;
7. the SES stack;
8. the ECR repositories;
9. the secrets (7-day recovery; `FORCE_DELETE_SECRETS=1` deletes them at once);
10. the CodeBuild project, its log group and its source objects.

It never touches any other record in the moosewave.com zone, or the zone itself.

The cost guard stays so you can watch the bill reach zero. Remove it once the
daily digest has shown $0.00 twice:

```bash
infra/aws/staging/scripts/teardown.sh cost-guard
```

A first create that ended `ROLLBACK_COMPLETE` cannot be updated. Delete just
that stack, then deploy again:

```bash
infra/aws/staging/scripts/teardown.sh stack moosewave-staging-base
```

## Cost

| State | Per day | Per 30 days |
|---|---|---|
| Running | about $4.7–5 | about $140–150 |
| Paused (`pause.sh`) | about $1.7 | about $50 |
| Torn down, cost guard kept | about $0.05 | under $2 |

Running cost breaks down roughly as:
- Fargate: $2.0 (api 1 vCPU/2 GB, web 0.5/1, clamav 0.25/2, listmonk 0.25/0.5);
- public IPv4: $0.8 (four tasks, the database and the ALB's two addresses);
- ALB: $0.55;
- the t4g.small database and its 20 GB gp3 volume: $0.45;
- Valkey: $0.3;
- secrets: $0.4;
- KMS, alarms, logs, DNS and snapshots: the rest.

A full image build costs about $0.50 on ARM `BUILD_GENERAL1_LARGE` in
us-east-1. It is tagged, so the tag-scoped budgets count it.

Alerts come from these, and all of them exclude credits, which currently
cover every charge in this account:
- **Budgets:** monthly $160, with actual alerts at 50/80/100/120 % and a
  forecast alert at 100 %; daily $6.50.
- **Anomaly monitor:** mails when an anomaly's impact is at least $3.
- **Daily digest:** 06:30 UTC.
- **Fargate vCPU alarm:** fires above 2.3 vCPU for an hour.
- **Database CPU-credit alarm:** fires once on the first day and after a
  pause of more than 7 days, as expected (see step 4). At any other time it
  means the database is being throttled.
- **Unexpected-resource rule:** NAT gateways, RDS databases and serverless
  caches from any caller, CloudFormation included, because staging creates
  none. Instances, load balancers and cache clusters only when made outside
  CloudFormation, because staging creates its own through CloudFormation.

Billing data lags up to a day, and the anomaly monitor needs about ten days
of history.

## Known limitations

- **No sidecars.** The voice, automation, deliverability and migration
  features answer 503 `service_not_deployed` in staging (their
  `*_SERVICE_URL` is `disabled`), and the status page does not list them.
  That is expected, not a failure.
- **No asset CDN.** `POSTWAVE_ASSETS_PUBLIC_BASE_URL` is
  `https://assets.staging.moosewave.com`, which has no DNS. Boot checks only
  the URL's shape, so uploaded and public asset images do not render.
- **SES recipient allowlist.** The API's role may send only as
  `*@staging.moosewave.com`, only through configuration set
  `moosewave-staging`, and only to:
  - `*@moosewave.com`;
  - `*@simulator.amazonses.com`;
  - `ALERT_EMAIL`.

  Mail to anyone else fails with AccessDenied, so a signup from another
  address gets no verification email. Its session still works. The
  allowlist covers only the API's own SES sends, not mail Listmonk sends
  (next item).

  Hosted-form double opt-in confirmations are API SES sends, queued by the
  outbox (`forms.confirmation.send`) and retried on failure. A form without a
  sender on a domain its workspace verified sends from the standard sender,
  `FORMS_CONFIRMATION_FROM` (`confirm@` the staging domain, never the
  account-mail `noreply@`), with a fixed text naming the workspace and form.
  To exercise the whole confirm flow, sign up on a published double opt-in
  form with a `*@moosewave.com` inbox (or `ALERT_EMAIL`) and click the link;
  SES refuses any other address, and the form's Submissions page shows
  "Confirmation email not delivered" on that pending submission.
- **Listmonk delivers no mail, so campaign sends and test sends reach no
  one.** Campaign sends (the send loop, once
  `ENABLE_CAMPAIGN_LIVE_DISPATCH=true`), campaign test sends and automation
  emails all go through Listmonk's `/api/tx`, and the API records each
  accepted send as sent. Staging can exercise these
  flows, not prove delivery. Listmonk sends them over its own SMTP settings,
  not the API's SES role, so the recipient allowlist cannot reach them. A fresh install points SMTP at
  `smtp.yoursite.com:25`, a third-party host. Staging closes that path in
  two places:
  - `db-post-migrate.sh listmonk-api-user` points Listmonk's only SMTP
    server at the task's own loopback and removes any postback messenger.
    Listmonk still answers these sends with success, then logs `error
    sending message … connection refused` in `/ecs/postwave-staging/listmonk`.
    Turning every server off instead is not safe: Listmonk v6.1.0 then
    crashes on the first send.
  - The Listmonk security group allows only HTTPS and Postgres out, so no
    SMTP port can leave even if someone changes the settings in Listmonk's
    UI.

  `LISTMONK_smtp__*` environment variables cannot change this: Listmonk's
  database settings override them. Delivering this mail would need a relay
  that enforces the same From and recipient allowlist, for example SES SMTP
  credentials limited like the API role. That is an owner decision; it needs
  a long-lived IAM access key.
- **Search engines.** Staging relies on the web's own guard while
  `POSTWAVE_PUBLIC_RELEASE_APPROVAL` is unset: `X-Robots-Tag: noindex` and a
  disallow-all `robots.txt`. Keep it unset. The API hosts (`api.`,
  `archive.`) send no site-wide noindex, so do not publish archive links.
- **One client IP.** Every tester reaches the API through the web task's
  public IP (the same ALB hairpin as production). One auth lockout, about 5
  minutes, therefore locks everyone out at once.
- **One database, no point-in-time recovery.**
  - Losing the instance means restoring from a DLM snapshot (daily, 3 kept)
    or starting over. Starting over means a new consent key and a web
    rebuild.
  - The instance's user data runs only at first boot.
- **Migrator ledger.** `infra/migrations/checksum-supersessions.json` must be
  re-reviewed by 2026-10-15. After that date the migrator refuses to run,
  here as everywhere.
- **Keep-last-5 ECR lifecycle.** After five newer pushes to a repository, the
  digest a paused service still points at can expire, and resume then fails
  to pull. Redeploy after building.
- **The domain is HSTS-preloaded.** The apex sends `includeSubDomains;
  preload`, so every staging name must serve valid HTTPS, and they do. Plain
  HTTP only redirects.
- **SES reputation is shared.** eu-west-1's reputation is shared with the
  moosewave.com mail forwarder. Keep test sends to the allowlist and the SES
  simulator.
- **Image builds use the account's shared CodeBuild role.** The
  `moosewave-staging-images` project runs as `codebuild-docai-role`, which
  the account's DocAI builds also use. The tag interlock does not limit
  that role:
  - it can write to every S3 bucket in the account (`AmazonS3FullAccess`),
    other projects' buckets included;
  - it can push to every ECR repository in every region, so it could
    overwrite other projects' production images;
  - it can update another project's production ECS service.

  Whatever the build runs gets all of this, so build only committed,
  reviewed code. `build-images.sh` already ships the named commit, never
  the working tree.
- **freshclam logs are misleading.** They show "Testing database … Database
  test passed" even with `TestDatabases no`. ClamAV prints both lines
  unconditionally, and only the load test itself is skipped.

## Troubleshooting

- **Stack failures:** `deploy.sh` streams stack events while it waits, and
  prints the failing ones. Full history is under `aws cloudformation
  describe-stack-events`, which accepts `--endpoint-url` too.
- **Image builds:** `build-images.sh` prints the end of a failed build's log.
  For the whole log:
  ```bash
  POSTWAVE_CI_PROJECT=moosewave-staging-images scripts/ci/aws-ci.sh --log <build-id>
  ```
- **Service logs:** `/ecs/postwave-staging/{api,web,clamav,listmonk,migrator}`
  in us-west-2, kept 14 days. Migrator logs are also saved locally, under
  `~/.local/state/moosewave-staging/migrate/`.
- **Database host:** `aws ssm start-session --target <DbInstanceId>` (the
  base output; it needs the Session Manager plugin). The bootstrap log is
  `/var/log/postwave-db-bootstrap.log`. To see exactly what a
  `db-post-migrate.sh` step sends, run
  `db-post-migrate.sh print-host-script ops-login` (or `listmonk-api-user`).
- **API not ready:** `/api/ready` answers only `{"status":"unavailable"}`.
  The detail is in the API log, and in the authenticated operator report at
  `/api/internal/ops/readiness`.
- **An API or web task stops before its main container starts:** read the
  `scratch-permissions` stream in its log group
  (`api/scratch-permissions/<task-id>` or `web/...`). That container runs
  first, as root, and gives the scratch volumes (`/tmp`, and web's
  `.next/cache`) to uid 10001. Fargate creates them root-owned 0755, so
  exports, CSV imports and the Next.js cache could not write without it. On
  success it logs `scratch volume <dir>: 10001:10001 <mode>, writable by uid
  10001` for each directory, which proves the write on every task start.

## Tests

```bash
infra/aws/staging/scripts/tests/run.sh
```

The suite runs offline against a fake `aws` CLI that fails any write call a
dry run makes. It checks that:
- dry runs of `deploy.sh`, `teardown.sh`, `pause.sh`, `resume.sh` and
  `secrets.sh` make no writes;
- a real `secrets.sh bootstrap` passes every value as a `file://`, never on a
  command line or in its output, gives each secret the right shape and tag,
  builds the DSNs from their passwords, and is idempotent;
- `deploy.sh` keeps unset parameters' previous values on update;
- teardown and pause refuse untagged resources before deleting anything;
- the secret list matches the templates' parameters and references;
- the web build arguments pass the repository's own build check;
- the digest and change-set handling, and the smoke parsing, work;
- the mail and cost-guard invariants hold in the templates:
  - every `AlertEmail` pattern, and `valid_email`, refuse `*` and `?`;
  - the Listmonk security group opens no SMTP port;
  - the SES statement refuses sends that name no recipients;
  - the unexpected-resource rule exempts CloudFormation only for what staging
    creates;
- the API and web tasks run the scratch-volume init first, over exactly
  their main container's mounts, and wait for it;
- the database user data parses, pins UTF8 before `initdb`, and checks it
  before signalling success;
- `build-images.sh` warns about an API commit without the platform sender.

With Docker available, it also:
- runs the scratch-volume init on the API's and web's own base images,
  against empty root-owned 0755 volumes as Fargate creates them. uid 10001
  must fail to write before it and succeed after;
- builds the ClamAV image;
- runs the database-host SQL against a real Postgres 16;
- starts the real Listmonk v6.1.0 that staging runs, on a network with no
  route out. After `listmonk-api-user`, it checks that a send is accepted,
  refused on loopback, and that Listmonk stays up.
