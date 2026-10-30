# Runbook -- Auth on AWS

How to stand up the Moosewave auth backend on AWS from a clean account.
Operational, opinionated, tested against the artifacts in
[`infra/aws/`](../../infra/aws/). The disaster-recovery side of the story
lives in [`disaster-recovery.md`](./disaster-recovery.md); this runbook is
about getting auth into production cleanly the first time, plus the boring
maintenance procedures (secret rotation, OAuth re-config, rollback) that
on-call inherits afterward.

Ownership: Platform on-call. Escalates to Security on suspected
HMAC pepper compromise; to Deliverability on SES suspension.

## Prerequisites

You should have, before starting this runbook:

1. **An AWS account dedicated to Moosewave production.** Co-tenanting with
   staging or other apps is a recipe for IAM blast-radius surprises.
2. **A VPC with at least three AZs.** Public subnets in each (for the
   ALB + NAT gateways), private subnets in each (for ECS tasks + RDS).
   Size `/22` per subnet minimum -- Fargate tasks consume one ENI each
   and you will run out of IPs faster than you expect on a `/26`.
3. **NAT gateway per AZ.** Single-NAT is cheaper but takes the entire
   region down if that AZ blips. ECS tasks need outbound access to SES,
   S3, Secrets Manager, ECR, and Stripe webhooks; without NAT they cannot
   start.
4. **An ACM certificate** in `us-west-2` for `*.moosewave.com` and
   `moosewave.com` (SAN). Validation by DNS, not email.
5. **Route 53 hosted zone** for `moosewave.com`.
6. **A built and pushed container image.** See `apps/api/Dockerfile.go`
   in the repo root. Push to
   `<account>.dkr.ecr.us-west-2.amazonaws.com/postwave-api:<tag>` after
   creating the ECR repo.

## Step-by-step deploy

### 1. Create Secrets Manager entries

The full list lives in
[`infra/aws/secrets-manager-bootstrap.json`](../../infra/aws/secrets-manager-bootstrap.json).
Generate values, then create each secret:

```bash
# Auth pepper -- 64 random bytes, base64-encoded for storage but stored as-is.
PEPPER=$(openssl rand -base64 64)
aws secretsmanager create-secret \
  --name postwave/prod/auth-hmac-pepper \
  --description "HMAC pepper for auth_sessions.verifier_hash (POSTWAVE_AUTH_HMAC_PEPPER)" \
  --secret-string "${PEPPER}" \
  --region us-west-2

# Auth KEK -- 32 raw bytes, base64-encoded.
KEK=$(openssl rand -base64 32)
aws secretsmanager create-secret \
  --name postwave/prod/auth-kek \
  --secret-string "${KEK}" \
  --region us-west-2

# Repeat for every entry in secrets-manager-bootstrap.json.
```

Capture the returned ARNs; you'll plug them into the task definition's
`secrets` block (the file ships with `-XXXXXX` placeholders).

For the database DSN: create the RDS instance first (step 4), then assemble
the DSN with the master password it returns and write it as
`postwave/prod/db-dsn`. The DSN env var name is `DATABASE_URL` (matches
`apps/api/internal/config/config.go`).

### 2. Create the IAM roles

Two roles, two trust policies, two attached managed policies.

```bash
# Task role: trust policy = ecs-tasks.amazonaws.com.
aws iam create-role \
  --role-name postwave-ecs-task-role \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }'

aws iam put-role-policy \
  --role-name postwave-ecs-task-role \
  --policy-name postwave-task-permissions \
  --policy-document file://infra/aws/iam-policy-ecs-task-role.json

# Execution role: same trust, different policy.
aws iam create-role \
  --role-name postwave-ecs-task-execution-role \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }'

aws iam put-role-policy \
  --role-name postwave-ecs-task-execution-role \
  --policy-name postwave-execution-permissions \
  --policy-document file://infra/aws/iam-policy-ecs-task-execution-role.json
```

Substitute the `<account>`, `<region>`, and KMS key UUIDs in both JSON
files first; the policies will fail to attach if any ARN remains a
placeholder.

### 3. ECR + image push

```bash
aws ecr create-repository \
  --repository-name postwave-api \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=KMS \
  --region us-west-2

aws ecr get-login-password --region us-west-2 \
  | docker login --username AWS --password-stdin \
      <account>.dkr.ecr.us-west-2.amazonaws.com

docker build -f Dockerfile.go -t postwave-api:<tag> .
docker tag postwave-api:<tag> \
  <account>.dkr.ecr.us-west-2.amazonaws.com/postwave-api:<tag>
docker push <account>.dkr.ecr.us-west-2.amazonaws.com/postwave-api:<tag>
```

Tag with the git sha, not `latest`. `latest` is how task definitions silently
roll forward without a deploy event; it makes incident retros wrong.

### 4. RDS Postgres

`db.t4g.medium` is the starter size; expect to upsize to `db.r6g.large` once
the auth tables grow past tens of thousands of users. Multi-AZ from day one
-- the `auth_sessions` table is in the request hot path; an AZ outage
without a standby is an outage.

```bash
aws rds create-db-instance \
  --db-instance-identifier postwave-prod \
  --db-instance-class db.t4g.medium \
  --engine postgres \
  --engine-version 16.3 \
  --master-username postgres \
  --master-user-password "$(openssl rand -base64 24)" \
  --allocated-storage 100 \
  --storage-type gp3 \
  --storage-encrypted \
  --kms-key-id alias/postwave-rds-prod \
  --vpc-security-group-ids sg-postwave-rds-prod \
  --db-subnet-group-name postwave-private-subnets \
  --backup-retention-period 14 \
  --preferred-backup-window 08:00-09:00 \
  --enable-iam-database-authentication \
  --multi-az \
  --copy-tags-to-snapshot \
  --deletion-protection \
  --region us-west-2
```

Then connect once as `postgres`, create the `postwave_app` role and
`postwave` database (mirror `infra/postgres/init.sql`), run migrations,
and only after that write the assembled DSN into Secrets Manager.

### 5. Register the task definition + create the service

```bash
aws ecs register-task-definition \
  --cli-input-json file://infra/aws/ecs-task-definition.json \
  --region us-west-2

aws ecs create-cluster \
  --cluster-name postwave-prod \
  --capacity-providers FARGATE FARGATE_SPOT \
  --region us-west-2

# Service: 2 desired tasks, deployment circuit breaker enabled so a
# bad image rolls back automatically.
aws ecs create-service \
  --cluster postwave-prod \
  --service-name postwave-api \
  --task-definition postwave-api:1 \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-...,subnet-...],securityGroups=[sg-postwave-api-prod],assignPublicIp=DISABLED}' \
  --load-balancers 'targetGroupArn=arn:aws:elasticloadbalancing:us-west-2:<account>:targetgroup/tg-postwave-api/...,containerName=postwave-api,containerPort=8080' \
  --health-check-grace-period-seconds 60 \
  --deployment-configuration 'deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100' \
  --region us-west-2
```

The ALB target group must exist before this call; see
[`alb-listener-rules.md`](../../infra/aws/alb-listener-rules.md) for
shape. The health check grace period (60s) is deliberately longer than the
task health check `startPeriod` (30s) so the ALB doesn't kill a task that's
still warming up.

### 6. SES

Follow [`ses-domain-setup.md`](../../infra/aws/ses-domain-setup.md) end to
end **before** flipping `POSTWAVE_MAILER=ses` in the task definition.

### 7. OAuth callback URLs

Configure these **before** deploy, otherwise the very first OAuth attempt
fails with `redirect_uri_mismatch`:

- Google Cloud Console -> APIs & Services -> Credentials -> the OAuth
  client used for `POSTWAVE_OAUTH_GOOGLE_CLIENT_ID`. Add Authorized
  redirect URI: `https://api.moosewave.com/api/v1/auth/oauth/google/callback`.

The path prefix matches `apps/api/internal/auth/oauth.go`'s router. The
host matches `POSTWAVE_OAUTH_REDIRECT_BASE` from the task definition.

Before enabling Google, certify that its configured userinfo flow returns a
boolean `email_verified: true` for approved tenant accounts. Moosewave rejects a
missing or false claim; it does not infer verification from the presence of
`email`. A matching email also never auto-links an unrecognized provider
subject. Users must sign in locally and choose **Connect Google** under
Settings -> Security; the callback revalidates the exact session that started
that link before persisting it.

Microsoft native sign-in is disabled for this release. Do not provision an
Entra client secret or callback URI. A future implementation must validate the
Microsoft ID token's signature, issuer, audience, and nonce and preserve this
explicit, session-bound link/reauthentication contract before it can be
enabled.

### 8. First-tenant bootstrap

The auth backend's signup flow creates *both* a user and a new tenant in
one step (it has to -- you can't sign up "into" a tenant that doesn't
exist yet). For the very first tenant on a fresh deploy this is fine;
you just hit the signup page and become the owner of a brand-new tenant.

If you instead want the first tenant to be a specific named one (e.g. an
internal "postwave" tenant for staff dogfooding), seed it via SQL before
opening signup:

```sql
BEGIN;
-- 1) Create the tenant.
INSERT INTO tenants (id, slug, name, tier, data_region)
VALUES (gen_random_uuid(), 'postwave', 'Moosewave (internal)', 'pro', 'us-west-2')
RETURNING id \gset

-- 2) Create the owner user. external_user_id is NULL (password user).
INSERT INTO users (id, tenant_id, email, role, auth_provider, email_verified_at)
VALUES (gen_random_uuid(), :'id', 'platform@moosewave.com', 'owner', 'password', now())
RETURNING id \gset user_

-- 3) Insert a placeholder argon2id PHC string. Replace via password reset
--    flow on first login -- never use this hash for anything real.
INSERT INTO auth_credentials (user_id, tenant_id, password_phc)
VALUES (:'user_id', :'id',
        '$argon2id$v=19$m=65536,t=3,p=4$BOOTSTRAP_SALT_REPLACE$BOOTSTRAP_HASH_REPLACE');

COMMIT;
```

Then trigger a password reset from the public auth UI (`/auth/forgot`) for
`platform@moosewave.com`. The reset email arrives via SES; clicking it
through replaces the placeholder PHC with a real hash. This pattern keeps
the production deploy from ever holding a real password value in a SQL
script.

After the bootstrap tenant exists, normal invite-based onboarding takes
over: owners invite users from inside the app, no SQL required.

## Secret rotation procedures

Rotation is per-secret because the cost shape varies enormously across them.
A pepper rotation that invalidates every live session is **not** the same
operation as a Stripe webhook rotation that only the gateway has to learn.

### `db-dsn` (DB credentials)

Blue/green via dual-credentials. RDS supports this natively via
`ModifyDBInstance --master-user-password` plus a Secrets Manager rotation
Lambda; we've intentionally avoided the Lambda to keep the rotation
auditable.

1. Create a second user on the DB: `postwave_app_b` with the same grants.
2. Issue a new password to `postwave_app_b`. Build the new DSN, write it
   into a fresh secret version (Secrets Manager keeps versions; use
   `--version-stage AWSPENDING`).
3. Roll the ECS service. New tasks pick up the AWSPENDING DSN; old tasks
   keep working on AWSCURRENT.
4. Once all tasks have rolled, promote AWSPENDING to AWSCURRENT
   (`update-secret-version-stage`).
5. Drop `postwave_app` (the old user) after a 24h soak.

This is the same pattern as a normal blue/green deploy, applied to a
secret. The 24h soak exists so a long-running query holding a connection
on the old user has time to finish.

### `auth-hmac-pepper` (HMAC pepper)

This is the painful one. The pepper is HMAC'd into every session row's
`verifier_hash`; rotating it without a transition window invalidates every
live session at once -- effectively a forced re-login of the entire user
base.

**Procedure: dual-pepper read with bake-in.**

1. Stage the new pepper in Secrets Manager (don't promote yet).
2. Add a `POSTWAVE_AUTH_HMAC_PEPPER_NEXT` env var to the task definition
   wired to the new secret. *This requires a code change to
   `apps/api/internal/auth/repo.go`* to verify each session's
   `verifier_hash` against both peppers and prefer the new one on
   verification success. Track that work as a prerequisite to rotation;
   do not attempt rotation without it.
3. Deploy. New sessions are issued under the new pepper; old sessions
   verify under the old one.
4. After the configured session lifetime (typically 30 days), every live
   session was issued under the new pepper. Drop the old pepper from the
   task def, promote `_NEXT` -> `POSTWAVE_AUTH_HMAC_PEPPER`, redeploy.

If you cannot wait 30 days (suspected pepper compromise), accept the
forced re-login: rotate immediately, communicate via status page. Better a
mass re-login than a leaked session integrity guarantee.

### `auth-kek` (TOTP envelope key)

KEK rotation requires re-encrypting every row in `auth_totp_secrets`.
This is a maintenance window task: bring up a one-shot job that decrypts
each row under the old KEK, re-encrypts under the new, and atomically
swaps. Document the window publicly; users with TOTP enabled will not
notice if it's done correctly, but a bad re-encrypt locks them out.

### `oauth/google`

Provider-issued client secrets. Generate the new secret in the provider's
console first; it co-exists with the old one. Update Secrets Manager,
roll the ECS service. Once tasks are on the new secret, delete the old
one in the provider console.

### `listmonk-webhook`, `postmark-hmac`, `sendgrid-hmac`, `arf-hmac`

Symmetric HMAC secrets. Both ends must hold the same value; rotate by
deploying the new value to **the sender** first (Listmonk, Postmark,
SendGrid), then to the API. The verification path tolerates a brief
window where one side is ahead by checking against a list of accepted
secrets if you've coded that explicitly; otherwise schedule a 5-minute
maintenance window.

### `api-key-pepper`

Same shape as `auth-hmac-pepper` but worse: every customer-issued API key
hashes through it. Rotation requires re-issuing every API key (forced
expiry + customer migration window). Avoid unless required by an actual
compromise; treat as a multi-quarter project, not an operational task.

### `sending-kek`, `migration-session-kek`

Same pattern as `auth-kek`: maintenance window, batch re-encrypt of
affected rows.

### `internal-api-token`, `stripe-webhook`

Symmetric secrets between the API and an internal service or external
provider. Rotate provider-side first, then API-side. Soak briefly.

## Rollback procedure

ECS deployment circuit breaker (configured in step 5) catches the common
case automatically: if the new task set never reaches steady state within
the deployment timeout, ECS rolls back to the previous task definition
and reports the failure.

For deploys that *did* reach steady state but turn out to be bad (a
silent data correctness issue, say), the manual rollback is:

```bash
# Find the previous good revision.
aws ecs describe-services \
  --cluster postwave-prod \
  --services postwave-api \
  --region us-west-2 \
  --query 'services[0].deployments[*].{taskDefinition:taskDefinition,status:status,createdAt:createdAt}'

# Roll back by pinning the service to the previous task def revision.
aws ecs update-service \
  --cluster postwave-prod \
  --service postwave-api \
  --task-definition postwave-api:<previous-revision> \
  --force-new-deployment \
  --region us-west-2
```

Watch the deploy in the console; circuit breaker is enabled either way,
so a rollback that itself fails will revert again.

If the bad change was a database migration, see
[`migration-failure.md`](./migration-failure.md). Do not try to roll back
a forward-only migration with a service rollback; the schema and the code
will desync.

## Operational notes

- **Tenant residency.** `POSTWAVE_DEPLOYMENT_REGION` on the task
  definition must match the region this stack is in (`us-west-2`). The
  middleware in `apps/api/internal/regions/regions.go` rejects requests
  whose tenant `data_region` does not match. To serve `eu-central-1`
  tenants, run a parallel stack in that region with its own SES setup,
  RDS, S3 buckets, and Route 53 records.
- **Cookie domain.** `POSTWAVE_COOKIE_DOMAIN=.moosewave.com` so the
  session cookie set by `api.moosewave.com` is sent on requests to
  `app.moosewave.com`. Subdomain-locked cookies break the SPA.
- **Health endpoint scope.** `/api/health` is liveness only -- it does
  not check DB connectivity, because a DB blip should not cut every task
  out of the load balancer. `/api/ready` does the deep check; do not wire
  it into the ALB target group health check.
- **Argon2id sizing.** With m=64MiB, t=3, p=4 (the auth.go defaults), a
  single login burns 64MiB and ~80ms of CPU. The 1 vCPU / 2 GiB task
  size handles ~10 concurrent logins comfortably; under brute-force
  attack the WAF rate-limit rule (see `alb-listener-rules.md`) is the
  primary defence. Do not raise argon2id parameters without raising
  task CPU first or login latency tanks.
- **Auth migration interlock.** Migration `0058_auth_backend.sql` must
  have applied before the API can start. The migration runner
  (deployed as a separate ECS service) holds an advisory lock so two
  concurrent migration attempts cannot collide.

## Reference

- Schema: [`infra/migrations/0058_auth_backend.sql`](../../infra/migrations/0058_auth_backend.sql)
- Task definition: [`infra/aws/ecs-task-definition.json`](../../infra/aws/ecs-task-definition.json)
- Secrets inventory: [`infra/aws/secrets-manager-bootstrap.json`](../../infra/aws/secrets-manager-bootstrap.json)
- IAM policies: [`infra/aws/iam-policy-ecs-task-role.json`](../../infra/aws/iam-policy-ecs-task-role.json), [`iam-policy-ecs-task-execution-role.json`](../../infra/aws/iam-policy-ecs-task-execution-role.json)
- ALB rules: [`infra/aws/alb-listener-rules.md`](../../infra/aws/alb-listener-rules.md)
- SES: [`infra/aws/ses-domain-setup.md`](../../infra/aws/ses-domain-setup.md)
- DR: [`disaster-recovery.md`](./disaster-recovery.md)
