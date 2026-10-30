# Moosewave AWS deployment artifacts

Files for standing up the Moosewave production stack on AWS. Companion to
the executable [`PRODUCTION_DEPLOY_RUNBOOK.md`](./PRODUCTION_DEPLOY_RUNBOOK.md)
and the authentication operations guide at
[`docs/runbooks/auth-aws.md`](../../docs/runbooks/auth-aws.md).

The artifacts assume an ECS-Fargate-behind-ALB topology with RDS Postgres,
Secrets Manager, SES, S3, Cloud Map, CloudWatch Logs, and AWS WAF. This
directory describes a deployable target, not proof that a live account already
matches it. Verify CloudFormation outputs and the post-deploy gates in the
runbook before declaring an environment ready.

## Files

| File                                                                                   | Purpose                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`cloudformation/postwave-stack.yaml`](./cloudformation/postwave-stack.yaml)           | Main CloudFormation module: private encrypted uploads/assets and tenant-export storage, hardened RDS, ECS/ALB, WAF, Cloud Map, retained log groups, and a desired-zero bootstrap service. |
| [`cloudformation/postwave-sidecars.yaml`](./cloudformation/postwave-sidecars.yaml)     | Independent digest-pinned voice, automation, deliverability, and migration services with private discovery and desired-zero bootstrap gating.                           |
| [`cloudformation/postwave-web.yaml`](./cloudformation/postwave-web.yaml)               | Standalone digest-pinned Next.js service with desired-zero/signature gating, local process health, ALB routing, optional DNS, autoscaling, and retained logs.           |
| [`ecs-task-definition.json`](./ecs-task-definition.json)                               | Canonical, fully populated API task definition registered only after migration verification.                                                                            |
| [`ecs-migrator-task-definition.json`](./ecs-migrator-task-definition.json)             | Least-privilege, one-shot database migrator task. It receives only the privileged migration DSN.                                                                        |
| [`iam-policy-ecs-task-role.json`](./iam-policy-ecs-task-role.json)                     | Runtime task permissions, split by purpose and restricted to reviewed SES identities, S3 prefixes, secrets, and KMS keys.                                               |
| [`iam-policy-ecs-task-execution-role.json`](./iam-policy-ecs-task-execution-role.json) | Task-start permissions: pull only six ECR repositories, inject the enumerated secrets, and write streams only in six CloudFormation-managed log groups.                 |
| [`secrets-manager-bootstrap.json`](./secrets-manager-bootstrap.json)                   | Secret inventory, descriptions, rotation cadence, and consuming environment-variable names.                                                                             |
| [`observability-stack.yaml`](./observability-stack.yaml)                               | Private AMP, Grafana, alert routing, endpoint network, and desired-zero minimal metrics collector.                                                                      |
| [`observability-image-lock.json`](./observability-image-lock.json)                     | Reviewed collector toolchain, component, scanner, scratch-runtime, and promotion lock.                                                                                  |
| [`cloudwatch-alarms.yaml`](./cloudwatch-alarms.yaml)                                   | ECS, ALB, RDS, SES, SNS, log, dashboard, and encrypted alert-routing controls.                                                                                          |
| [`../backup/aws-rds-dr.yaml`](../backup/aws-rds-dr.yaml)                               | Canonical RDS cross-region backup/PITR and recovery controls.                                                                                                           |
| [`../backup/aws-dns-failover.yaml`](../backup/aws-dns-failover.yaml)                   | Guarded DNS failover controls used only after recovery verification.                                                                                                    |
| [`PRODUCTION_DEPLOY_RUNBOOK.md`](./PRODUCTION_DEPLOY_RUNBOOK.md)                       | Ordered signed-artifact, infrastructure, two-pass migration, rollout, smoke-test, and rollback procedure.                                                               |
| [`WEB_DEPLOY_RUNBOOK.md`](./WEB_DEPLOY_RUNBOOK.md)                                     | Desired-zero signed web-image promotion, Fargate rollout, DNS cutover, qualification, and rollback procedure.                                                           |
| [`OBSERVABILITY_RUNBOOK.md`](./OBSERVABILITY_RUNBOOK.md)                               | Operational telemetry and alerting procedure.                                                                                                                           |
| [`alb-listener-rules.md`](./alb-listener-rules.md)                                     | ALB routing and health-check contract.                                                                                                                                  |
| [`ses-domain-setup.md`](./ses-domain-setup.md)                                         | SES identity, DKIM/SPF/DMARC, feedback topics, and production-access procedure.                                                                                         |

## Order of operations

The production deployment runbook is authoritative. Its safety-critical order
is:

1. Verify external VPC, subnets, KMS keys, Redis, Listmonk, DNS, ACM, and
   provider prerequisites.
2. Resolve and verify the six signed application/migrator ECR manifest digests
   and the signed web and collector GHCR manifest digests exactly once.
3. Create the secret inventory and least-privilege IAM roles.
4. Deploy the API, sidecar, and web CloudFormation modules with all services at
   desired count zero, then bootstrap the observability stack with its collector
   at desired count zero so immutable ECR repositories exist.
5. Promote the verified web and collector indexes to their retained ECR
   repositories and prove digest equality and destination signatures.
6. Set separate runtime and migration database roles, then run the immutable
   migrator twice: apply followed by read-only/idempotency verification.
7. Register the canonical API task, enable sidecars and API, qualify and enable
   the separate web module, then enable the metrics collector and alarms.
8. Complete DNS/provider callbacks and pass the documented readiness, security,
   observability, and smoke-test gates before exposing clients.

## External ownership boundaries

- **VPC, subnets, NAT, internet gateway, KMS keys.** Foundation
  resources; outlive the application stack and rotate on a different
  cadence. Pass IDs/ARNs into the CloudFormation template as parameters.
- **Redis and Listmonk.** They are private-network prerequisites with explicit
  runtime health gates; this stack does not create them.
- **Portable backup workload.** The separate
  [`../backup/aws-backup-dr.yaml`](../backup/aws-backup-dr.yaml) stack owns its
  buckets and writer identity. The API task never receives that writer policy.
  RDS native encrypted automated backups and PITR are canonical for this AWS
  deployment.
- **Archived Terraform prototype.** [`../terraform/`](../terraform/) is
  explicitly non-production historical material. It is not an alternate
  deployment path and is excluded from release certification.
- **Web service.** The Next.js frontend has its own desired-zero module and
  runbook because its signed build-time environment and DNS cutover are
  independent of API migrations. Live deployment evidence is still external.

## Maintenance

- Add a new secret consumer to `secrets-manager-bootstrap.json`, the relevant
  task definition, and only the IAM role that actually resolves it. Do not
  automatically mirror every secret into both roles.
- Add a new SES from-address -> update the `ses:FromAddress` condition in
  `iam-policy-ecs-task-role.json` AND verify the address in SES.
- Add a workload -> create an explicit retained log group and add only its
  stream ARN to the execution role; tasks must never set
  `awslogs-create-group`.
- Change the metrics plane -> update the governed emitter/dashboard/alert
  contract, minimal collector lock, release scan, and observability runbook in
  the same change. Never substitute an upstream collector image directly.
- Run `node scripts/release/verify-aws-deployment-contracts.mjs`, `cfn-lint`,
  AWS CloudFormation validation, IAM Access Analyzer, and ECS task-definition
  shape validation after any deployment-contract change.
