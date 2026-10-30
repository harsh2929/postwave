# Deploy Procedure

Moosewave production runs on AWS ECS Fargate behind CloudFormation in
`us-west-2` (see `config/production-platform.json`). Every merge to
`main` runs `ci.yml` and, when green, the `Docker Push` workflow
(`.github/workflows/docker-push.yml`) builds and signs the release
images in GHCR. Nothing deploys automatically: promotion into ECR and
every ECS rollout are operator-driven through the numbered sections of
[`infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md`](../../infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md)
(referred to below as "the AWS runbook"). This document covers the
routine-release approval checklist, the order in which to run those
sections, smoke tests, and the rollback path.

## Pre-Deploy Checklist

Before starting a production rollout, confirm all of the following:

### 1. The change has been on staging for at least 30 minutes

Thirty minutes is the minimum window we have empirically found to catch
issues that don't surface in the test suite — most commonly N+1 query
regressions and cache-invalidation bugs.

For changes labeled `db-migration` or `infra`, hold staging for at
least 4 hours. These changes have a higher blast radius and benefit
from soaking through a daily maintenance window.

### 2. No active P0/P1 incidents

Check `#oncall-alerts` for active incidents. Do not deploy on top of
a fire — even a "small fix" that's unrelated. The on-call rotation
needs cognitive bandwidth, and your deploy doubles their on-call load.

If you're deploying the fix for the active incident itself, this rule
is suspended (obviously). Coordinate in `#incident-active` first.

### 3. Migration check

If your branch includes a migration, run the preflight against a
staging snapshot. The script reads `DATABASE_URL` only:

```bash
DATABASE_URL="postgres://...staging-snapshot..." \
  scripts/update/preflight.sh
```

Confirm:

- No `DROP TABLE` or `ALTER TABLE ... DROP COLUMN` without a
  preceding deprecation cycle.
- No long-running locks on hot tables. Anything touching
  `subscribers`, `campaign_recipients`, or `audit_log` must use
  `CREATE INDEX CONCURRENTLY` and small-step ALTER TABLEs.
- Migration filename is the next available number under
  `infra/migrations/` (for example `2045_...` if `2044_...` is the
  latest committed).
- The preflight script produced a fresh `*.dump`, `*.dump.sha256`,
  and `*.dump.manifest.json` under `backups/pre-update/` (created on
  first run).
- The migration dry-run has no `blocker` safety findings. Warnings
  require staff-engineer acknowledgement in the deploy note.

The migration runner (`apps/api/cmd/migrate`) blocks destructive
operations by default. The `--allow-unsafe` flag exists only for
incident-level, backup-verified maintenance and must not be used in
normal production deploys.

### 4. Rollback story

For every deploy, you should be able to answer: "If this breaks, how
do I get back to where we were 30 minutes ago?"

For typical code changes the answer is "redeploy the previous API task
definition ARN through CloudFormation." For migrations, the answer is
more involved — see the Rollback section below.

### 5. Stripe / Postmark live mode

If your branch touches billing or sending, double-check we are not
shipping test credentials to production. The AWS runbook step 3
preflight refuses a `STRIPE_SECRET_KEY` that does not start with
`sk_live_` and a `STRIPE_WEBHOOK_SECRET` that does not start with
`whsec_`; `POSTMARK_ACCOUNT_TOKEN` has no prefix check, so confirm the
Secrets Manager value is the live account token by hand. Never bypass
those checks.

## Deploy Command Sequence

These commands assume you have the production deploy role and the
shell variables from AWS runbook section 1 exported (`AWS_REGION`,
`ACCOUNT_ID`, `DOMAIN`, `GIT_SHA`, `IMAGE_TAG`, `GITHUB_REPOSITORY`).
If you don't, this section is information-only — ask in `#eng-leads`
to be added.

### Step 1: Confirm CI and the signed build are green

```bash
gh run list --branch main --workflow ci.yml --limit 5
gh run list --workflow docker-push.yml --commit "$GIT_SHA" --limit 5
```

The most recent `ci.yml` and `Docker Push` runs for the SHA you intend
to deploy must both be `success`. If either is `pending`, wait. If
either is `failed`, do not deploy.

### Step 2: Snapshot the current state

Record the task definition currently serving traffic and take an RDS
snapshot. The rollback procedure uses both:

```bash
aws ecs describe-services --cluster postwave-prod --services postwave-api \
  --query 'services[0].taskDefinition' --output text
aws rds create-db-snapshot --db-instance-identifier postwave-prod \
  --db-snapshot-identifier postwave-prod-pre-deploy-$(date +%Y%m%d%H%M)
```

Keep the printed task definition ARN in the deploy note.

### Step 3: Promote and verify images

Run the `ECR Bridge` workflow for the commit, then resolve and
`cosign verify` every digest exactly as in AWS runbook step 1:

```bash
gh workflow run ecr-bridge.yml --ref main -f git_sha="$GIT_SHA" -f service=all
gh run list --workflow ecr-bridge.yml --event workflow_dispatch --limit 5
```

Do not build or push images locally; the bridge is the only production
publisher. Continue only with the eight exported `*_IMAGE_DIGEST`
values.

### Step 4: Apply migrations (if any)

Register the signed migrator digest and run it once **without** the
unsafe override, following AWS runbook step 6 (`run_migrator` with no
arguments). The migrator is idempotent — running it with no pending
migrations is a no-op. It writes a row to `schema_migrations` for each
applied file and re-verifies every checksum against the baked manifest.

If a migration fails, the task exits non-zero and the script aborts.
Transactional phases roll back via PostgreSQL transactional DDL. A
migration marked `migration-execution: phased` may already have
completed and durably recorded an online index phase; retry the exact
immutable migration so the runner can attest and reuse that phase. Do
not proceed to the next step until migrations have applied cleanly.

If the migrator log reports `unsafe migration detected; refusing to
apply without --allow-unsafe`, it found a destructive operation. Stop.
Do not roll forward with `POSTWAVE_MIGRATOR_ALLOW_UNSAFE=1` unless the
change has a named backup artifact, a restore target, and explicit
staff-engineer approval in the incident/deploy channel.

#### Migration 2007 webhook writer cutover

Migration `2007_webhook_playground_fire_receipts` is migrate-before-roll
compatible only because its database trigger advances `config_version` for a
pre-2007 writer that leaves the new column unchanged. New writers advance it
explicitly. Treat that trigger branch as a rolling-deploy bridge, not as
permission to keep unknown writers indefinitely.

Before applying it:

1. Rehearse the exact migration-runner image and migration checksum on a
   production-sized restore. Record elapsed time, the valid/ready concurrent
   index, the adopted constraint, and one legacy-style plus one current-style
   capability update.
2. Inventory every API task, worker task, scheduled maintenance job and ad-hoc
   SQL path that can update `outbound_webhooks`. Record the pre-2007 image/task
   definitions so the later drain has a finite, reviewable target.
3. Keep the normal snapshot/PITR evidence and verify no other migration runner
   owns the advisory lock.

Apply and roll in this order:

1. Run the normal migration command. Its first phase builds
   `outbound_webhooks_tenant_id_id_key` with `CREATE UNIQUE INDEX CONCURRENTLY`;
   its transaction then adopts that exact index and installs the compatibility
   trigger and fire ledger.
2. If the transactional phase hits its five-second table-lock budget, stop.
   **Do not increase or disable `lock_timeout`** while traffic is live. Drain
   affected writers, let their transactions finish, and retry the exact same
   migration. Do not manually recreate, rename or drop a valid index retained
   by the phase ledger.
3. Verify the index is valid/ready, the constraint owns that same index, the
   trigger is enabled, and the migration checksum is recorded before rolling
   application tasks.
4. Roll the config-version-aware API and worker images. Then drain every
   pre-2007 API and worker task, stop old scheduled jobs, and verify that no old
   task definition or long-lived database session remains. Retain this evidence
   with the deploy record.
5. Keep the auto-bump bridge after the drain. A future contract migration may
   remove it only after the old-writer absence proof and rollback window are
   approved; migration 2007 itself must not tighten that contract mid-rollout.

If the bridge cannot be rehearsed or the writer inventory cannot be made
complete, use a quiesced cutover instead: pause every route/job that mutates
`outbound_webhooks`, wait for their database transactions to finish, apply the
migration, deploy only the new writer image, verify it, and then resume writes.
Do not mix an unverified old writer with the new trigger contract.

For application rollback, redeploy the previous images first. They remain
compatible with the auto-bump bridge. **Leave the 2007 schema objects in place**:
the concurrent index/constraint, `config_version`, trigger and fire ledger are
forward-compatible and required by any fire identity already issued. Removing
them is a separately reviewed contract/data rollback, not an image rollback.

### Step 5: Roll the deployment

Render and register the API and Campaign Assurance task definitions from
the new digests, roll the sidecar stack, then update the main stack with
the new ARNs — AWS runbook step 7, in that order:

```bash
aws cloudformation deploy \
  --template-file infra/aws/cloudformation/postwave-sidecars.yaml \
  --stack-name postwave-sidecars-prod \
  --parameter-overrides DeploySidecarServices=true \
  --no-fail-on-empty-changeset
aws ecs wait services-stable --cluster "$ECS_CLUSTER_NAME" --services \
  postwave-voice postwave-automation postwave-deliverability postwave-migration

aws cloudformation deploy \
  --template-file infra/aws/cloudformation/postwave-stack.yaml \
  --stack-name postwave-prod \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    DeployApplicationServices=true \
    ApiTaskDefinitionArn=${API_TASK_DEFINITION_ARN} \
    DeployCampaignAssuranceService=true \
    CampaignAssuranceTaskDefinitionArn=${ASSURANCE_TASK_DEFINITION_ARN} \
    CampaignAssuranceTaskRoleArn=${ASSURANCE_TASK_ROLE_ARN} \
    CampaignAssuranceImageEvidenceBucketName=${ASSURANCE_IMAGE_EVIDENCE_BUCKET} \
    CampaignAssuranceEvidenceKmsKeyArn=${ASSURANCE_EVIDENCE_KMS_KEY_ARN} \
  --no-fail-on-empty-changeset
aws ecs wait services-stable --cluster "$ECS_CLUSTER_NAME" --services \
  postwave-api postwave-campaign-assurance
```

ECS performs a rolling update with the deployment circuit breaker
enabled. Old tasks keep serving traffic until the new tasks pass their
health checks. Never bypass CloudFormation with `aws ecs update-service`
for a routine release.

### Step 6: Smoke test

See the next section.

## Smoke Tests After Deploy

Run all six. If any fail, abort and roll back.

### 1. API readiness

```bash
curl -fsS https://api.moosewave.com/api/ready
# expects: 200, body: {"status":"ready"}
```

The public probe is intentionally detail-free and carries no build
identifier. Confirm the running revision instead:

```bash
aws ecs describe-services --cluster postwave-prod --services postwave-api \
  --query 'services[0].{task:taskDefinition,running:runningCount,rollout:deployments[0].rolloutState}'
# task must be the ARN you registered; rollout must be COMPLETED
```

### 2. Status page

```bash
curl -fsS https://api.moosewave.com/api/public/status | jq .overall_status
# expects: "ok"
```

### 3. Marketing site

```bash
curl -fsS https://moosewave.com | grep -q "Moosewave"
# exit 0
```

### 4. Login flow

Manually: open https://app.moosewave.com, log in with the QA account,
land on the dashboard. Should take <3 seconds. If the dashboard shows
errors or the login page hangs, abort.

### 5. Webhook endpoint

```bash
curl -sS -X POST https://api.moosewave.com/api/public/stripe/webhook \
  -H "Content-Type: application/json" \
  -H "Stripe-Signature: t=0,v1=invalid" \
  -d '{}'
# expects: 400, body contains "invalid_signature"
```

A 4xx response confirms the webhook handler is receiving requests; the
`invalid_signature` code confirms the verification path is wired.

### 6. Operator readiness report and logs

From an approved operator IP, sign in with the platform-operator
account, complete TOTP, and open
`https://api.moosewave.com/api/internal/ops/readiness`. Top-level
`status` must be `ok` with no failed required check (AWS runbook step
12). Then tail the API log group for errors during the first minutes:

```bash
aws logs tail /ecs/postwave-api --since 10m
```

## Rollback Procedure

If smoke tests fail or you see an error spike post-deploy, roll back
immediately. Don't try to debug forward.

### Code-only rollback

Redeploy the task definition ARN recorded in Step 2 through
CloudFormation (AWS runbook section 4, row 7). Keep the Campaign
Assurance parameters unchanged unless that service is implicated:

```bash
aws cloudformation deploy \
  --template-file infra/aws/cloudformation/postwave-stack.yaml \
  --stack-name postwave-prod \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    DeployApplicationServices=true \
    ApiTaskDefinitionArn=<previous-api-task-definition-arn> \
    DeployCampaignAssuranceService=true \
    CampaignAssuranceTaskDefinitionArn=${ASSURANCE_TASK_DEFINITION_ARN} \
    CampaignAssuranceTaskRoleArn=${ASSURANCE_TASK_ROLE_ARN} \
    CampaignAssuranceImageEvidenceBucketName=${ASSURANCE_IMAGE_EVIDENCE_BUCKET} \
    CampaignAssuranceEvidenceKmsKeyArn=${ASSURANCE_EVIDENCE_KMS_KEY_ARN} \
  --no-fail-on-empty-changeset
aws ecs wait services-stable --cluster postwave-prod --services postwave-api
```

Rolling back is the same procedure as rolling forward. If the circuit
breaker already reverted the service, confirm with
`aws ecs describe-services ... --query 'services[0].deployments'`
rather than assuming.

### Migration rollback

This is the hard case. Migrations are not transactionally reversible
in the general case — a `DROP COLUMN` cannot be undone without
restoring data from a backup.

The rule we follow: every migration must be backwards-compatible with
the previous code release. If you broke this contract, you need to:

1. Stop the bleeding: pause writes to the affected tables.
2. Restore from the Step 2 snapshot or from RDS point-in-time recovery
   (automated backup retention is 14 days, `BackupRetentionPeriod: 14`
   in `infra/aws/cloudformation/postwave-stack.yaml`; see
   `disaster-recovery.md`).
3. Replay the deltas you want to keep manually.

Because this is painful, we don't ship migrations that aren't
backwards-compatible. If you find yourself wanting to, file a design
review first.

### Image-only rollback (no migration)

If the deploy didn't include a migration, the code-only rollback above
is sufficient. No further action needed.

## After-Deploy Tasks

Within 10 minutes of a successful deploy:

- Post in `#eng-deploys` with the SHA, the registered task definition
  ARNs, what changed, and any follow-up watch items.
- Check the release overview dashboard (link in `dashboards.md`) — most
  metrics auto-flag if they regress, but eyeballing the trends for
  the first 30 minutes catches subtle issues.
- If the deploy fixes a Linear ticket, mark the ticket "Done" with
  a link to the deploy run.

## Emergency Hotfix Path

If you need to ship a fix during an active incident:

1. Skip the 30-minute staging soak (still go through staging — just
   move fast).
2. Record in the incident channel that the "no active incident" rule
   is suspended for this deploy; there is no flag that bypasses it.
3. Document the emergency deploy in the incident post-mortem.

Emergency deploys account for <2% of our deploys. If you find
yourself reaching for this path often, the code or test suite is
broken.
