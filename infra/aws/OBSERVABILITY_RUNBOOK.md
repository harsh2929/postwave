# Moosewave production observability runbook

This is the canonical deployment and verification procedure for Moosewave's
production metrics, alerting, dashboards, infrastructure alarms, and optional
distributed tracing. The production region is `us-west-2` and the canonical
domain is `moosewave.com`.

The default metrics plane is fully represented in this repository:

- five authenticated `/metrics` targets;
- a private, minimal OpenTelemetry collector on ECS/Fargate;
- a KMS-encrypted Amazon Managed Service for Prometheus (AMP) workspace;
- AMP rule groups and encrypted SNS alert routing;
- a private Amazon Managed Grafana workspace using IAM Identity Center;
- CloudWatch alarms for the API and Campaign Assurance ECS services, ALB, RDS,
  SES, SNS, structured error logs, and the collector;
- signed multi-architecture collector images with SBOM, provenance, and a
  blocking vulnerability scan.

The metrics collector intentionally does not accept OTLP traces. Tracing is a
separate, optional TLS-only integration described at the end of this runbook.

Companion documents and contracts:

- [`PRODUCTION_DEPLOY_RUNBOOK.md`](./PRODUCTION_DEPLOY_RUNBOOK.md)
- [`observability-stack.yaml`](./observability-stack.yaml)
- [`cloudwatch-alarms.yaml`](./cloudwatch-alarms.yaml)
- [`observability-image-lock.json`](./observability-image-lock.json)
- [`postwave-release-overview.json`](../grafana/dashboards/postwave-release-overview.json)
- [`release_core.yml`](../grafana/alerts/release_core.yml)

## 1. Preconditions

Do not enable the collector until all of these are true:

- the main and sidecar stacks exist in `us-west-2`;
- the API has two healthy tasks and each sidecar has one healthy task;
- the exact database migrator has completed twice as required by the main
  production runbook;
- the dedicated metrics token is injected into the API and all four sidecars;
- the collector release image passed CI, signature, SBOM/provenance, and Trivy
  gates;
- an on-call receiver has confirmed both SNS subscriptions;
- operators have private network access to the Grafana VPC endpoint.

Run the repository-owned checks from a clean, reviewed revision:

```bash
pnpm audit:observability
pnpm audit:observability:collector
pnpm audit:observability:collector:release
node scripts/release/verify-aws-deployment-contracts.mjs
```

The release scan must show zero fix-available `HIGH` or `CRITICAL` findings for
both `otelcol` and `healthcheck`. Never replace the reviewed collector with an
upstream ADOT or OpenTelemetry image directly; two such images were rejected by
this gate because their embedded Go runtimes had fixable HIGH vulnerabilities.

## 2. Operator variables

Set these without committing values. Subnets must span at least two
availability zones. The Grafana CIDR should normally be the corporate VPN
egress CIDR or a private routed operator CIDR, never `0.0.0.0/0`.

```bash
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
export MAIN_STACK=postwave-prod
export SIDECAR_STACK=postwave-sidecars-prod
export OBSERVABILITY_STACK=postwave-observability-prod
export ALARM_STACK=postwave-alarms-prod
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

export VPC_ID=vpc-...
export VPC_CIDR=10.0.0.0/16
export PRIVATE_SUBNET_IDS=subnet-aaa,subnet-bbb
export PRIVATE_ROUTE_TABLE_IDS=rtb-aaa,rtb-bbb
export GRAFANA_OPERATOR_CIDR=10.20.0.0/16
export SECRETS_KMS_KEY_ARN=arn:aws:kms:us-west-2:${ACCOUNT_ID}:key/...
export ALERT_EMAIL=oncall@moosewave.com
```

Confirm the selected VPC and subnets before any deployment:

```bash
aws ec2 describe-subnets --subnet-ids ${PRIVATE_SUBNET_IDS//,/ } \
  --query 'Subnets[].{id:SubnetId,vpc:VpcId,az:AvailabilityZone,cidr:CidrBlock}' \
  --output table
aws ec2 describe-route-tables --route-table-ids ${PRIVATE_ROUTE_TABLE_IDS//,/ } \
  --query 'RouteTables[].{id:RouteTableId,vpc:VpcId}' --output table
```

Stop if any resource belongs to a different account, region, or VPC.

## 3. Create and inject the dedicated metrics token

Metrics authentication must not reuse an API, internal-service, session, or
vendor credential. Generate at least 256 bits of entropy and store it under the
canonical secret name. The commands below do not print the secret value.

```bash
METRICS_TOKEN="$(openssl rand -hex 48)"
if aws secretsmanager describe-secret \
    --secret-id postwave/prod/metrics-token >/dev/null 2>&1; then
  aws secretsmanager put-secret-value \
    --secret-id postwave/prod/metrics-token \
    --secret-string "${METRICS_TOKEN}" >/dev/null
else
  aws secretsmanager create-secret \
    --name postwave/prod/metrics-token \
    --description 'Dedicated bearer token for private Moosewave metrics scrapes' \
    --kms-key-id "${SECRETS_KMS_KEY_ARN}" \
    --secret-string "${METRICS_TOKEN}" >/dev/null
fi
unset METRICS_TOKEN

export METRICS_TOKEN_SECRET_ARN="$(aws secretsmanager describe-secret \
  --secret-id postwave/prod/metrics-token --query ARN --output text)"
```

Pass `MetricsTokenSecretArn=${METRICS_TOKEN_SECRET_ARN}` to both
`postwave-stack.yaml` and `postwave-sidecars.yaml`. The canonical task
definitions inject the value as `METRICS_TOKEN`; it must never appear in a
plain `Environment` block, task-definition export, log line, dashboard, or
command transcript.

After the two application stacks are deployed, capture their outputs:

```bash
stack_output() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

export ECS_CLUSTER_NAME="$(stack_output "${MAIN_STACK}" EcsClusterName)"
export API_SECURITY_GROUP_ID="$(stack_output "${MAIN_STACK}" EcsTaskSecurityGroupId)"
export SIDECAR_SECURITY_GROUP_ID="$(stack_output "${SIDECAR_STACK}" EcsSidecarSecurityGroupId)"
```

## 4. Build, scan, sign, and promote the collector

The collector is built from
[`infra/observability/image/Dockerfile`](../observability/image/Dockerfile).
It compiles only the seven pinned OpenTelemetry modules in
`builder-config.yaml` with the pinned Go toolchain, then copies the two static
binaries and CA roots into a scratch image.

On a push to `main`, `docker-push.yml` publishes
`ghcr.io/<owner>/postwave-observability-collector` for `linux/amd64` and
`linux/arm64`, attaches SLSA provenance and an SPDX SBOM, and signs the exact
manifest with GitHub OIDC. Record the full 40-character Git SHA and resolve the
immutable manifest:

```bash
export GIT_SHA="$(git rev-parse HEAD)"
export OWNER_LC='<lowercase-github-owner>'
export GHCR_COLLECTOR="ghcr.io/${OWNER_LC}/postwave-observability-collector"
export COLLECTOR_DIGEST="$(docker buildx imagetools inspect \
  "${GHCR_COLLECTOR}:sha-${GIT_SHA}" \
  --format '{{json .Manifest.Digest}}' | tr -d '"')"
test "$(printf '%s' "${COLLECTOR_DIGEST}" | sed -n 's/^sha256:[0-9a-f]\{64\}$/ok/p')" = ok

cosign verify \
  --certificate-identity "https://github.com/<owner>/<repo>/.github/workflows/docker-push.yml@refs/heads/main" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "${GHCR_COLLECTOR}@${COLLECTOR_DIGEST}" >/dev/null
```

For the first deployment, the stack-owned ECR repository does not exist yet.
Create the observability stack with `DeployCollector=false`; registering a
desired-zero task definition does not pull the image. Then rerun the `ECR
Bridge` workflow for `GIT_SHA`. The bridge verifies the GHCR signature and
attestations, copies the identical multi-architecture index to the immutable
ECR repository, and signs the ECR digest.

Never use `latest`, `main`, a platform-specific digest, or a digest copied from
an unverified registry.

## 5. Bootstrap the private metrics plane

Create a reusable parameter array so the bootstrap and enable operations use
identical inputs:

```bash
OBSERVABILITY_PARAMETERS=(
  "VpcId=${VPC_ID}"
  "VpcCidr=${VPC_CIDR}"
  "PrivateSubnetIds=${PRIVATE_SUBNET_IDS}"
  "PrivateRouteTableIds=${PRIVATE_ROUTE_TABLE_IDS}"
  "EcsClusterName=${ECS_CLUSTER_NAME}"
  "ApiSecurityGroupId=${API_SECURITY_GROUP_ID}"
  "SidecarSecurityGroupId=${SIDECAR_SECURITY_GROUP_ID}"
  "MetricsTokenSecretArn=${METRICS_TOKEN_SECRET_ARN}"
  "SecretsManagerKmsKeyArn=${SECRETS_KMS_KEY_ARN}"
  "CollectorImageDigest=${COLLECTOR_DIGEST}"
  "GrafanaOperatorCidr=${GRAFANA_OPERATOR_CIDR}"
  "AlertEmail=${ALERT_EMAIL}"
  "MetricsRetentionDays=365"
)

aws cloudformation deploy \
  --template-file infra/aws/observability-stack.yaml \
  --stack-name "${OBSERVABILITY_STACK}" \
  --parameter-overrides "${OBSERVABILITY_PARAMETERS[@]}" DeployCollector=false \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset
```

Confirm that the workspace is active and the collector remains at zero:

```bash
export AMP_WORKSPACE_ID="$(stack_output "${OBSERVABILITY_STACK}" PrometheusWorkspaceId)"
export GRAFANA_WORKSPACE_ID="$(stack_output "${OBSERVABILITY_STACK}" GrafanaWorkspaceId)"
export COLLECTOR_SERVICE_NAME="$(stack_output "${OBSERVABILITY_STACK}" CollectorServiceName)"
export COLLECTOR_REPOSITORY="$(stack_output "${OBSERVABILITY_STACK}" CollectorRepositoryUri)"

aws amp describe-workspace --workspace-id "${AMP_WORKSPACE_ID}" \
  --query 'workspace.status.statusCode' --output text
aws ecs describe-services --cluster "${ECS_CLUSTER_NAME}" \
  --services "${COLLECTOR_SERVICE_NAME}" \
  --query 'services[0].{desired:desiredCount,running:runningCount,events:events[0:3].message}'
```

The expected values are `ACTIVE`, `desired=0`, and `running=0`.

Run or rerun `ECR Bridge` for `GIT_SHA`, then prove the destination digest is
identical:

```bash
aws ecr describe-images \
  --repository-name postwave-observability-collector \
  --image-ids imageTag="sha-${GIT_SHA}" \
  --query 'imageDetails[0].imageDigest' --output text

cosign verify \
  --certificate-identity "https://github.com/<owner>/<repo>/.github/workflows/ecr-bridge.yml@refs/heads/main" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "${COLLECTOR_REPOSITORY}@${COLLECTOR_DIGEST}" >/dev/null
```

Stop if the ECR digest differs from `COLLECTOR_DIGEST`.

## 6. Enable the collector

First verify the target services, not merely their desired counts:

```bash
aws ecs describe-services --cluster "${ECS_CLUSTER_NAME}" \
  --services postwave-api postwave-voice postwave-automation \
             postwave-deliverability postwave-migration \
  --query 'services[].{service:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount,deployments:deployments}'
```

Expected running counts are API `2` and every sidecar `1`, with no pending
tasks and one completed primary deployment per service. Then enable the
collector using the same parameters:

```bash
aws cloudformation deploy \
  --template-file infra/aws/observability-stack.yaml \
  --stack-name "${OBSERVABILITY_STACK}" \
  --parameter-overrides "${OBSERVABILITY_PARAMETERS[@]}" DeployCollector=true \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset

aws ecs wait services-stable --cluster "${ECS_CLUSTER_NAME}" \
  --services "${COLLECTOR_SERVICE_NAME}"
```

Verify task hardening and startup:

```bash
COLLECTOR_TASK_DEFINITION="$(aws ecs describe-services \
  --cluster "${ECS_CLUSTER_NAME}" --services "${COLLECTOR_SERVICE_NAME}" \
  --query 'services[0].taskDefinition' --output text)"
aws ecs describe-task-definition --task-definition "${COLLECTOR_TASK_DEFINITION}" \
  --query 'taskDefinition.containerDefinitions[0].{image:image,user:user,readonly:readonlyRootFilesystem,command:command,health:healthCheck.command}'

aws logs tail /ecs/postwave-observability-collector --since 10m
```

The task must show the exact ECR digest, user `10001`, read-only root `true`,
`--config=env:AOT_CONFIG_CONTENT`, and `/healthcheck`. Logs must include
`Everything is ready` and exactly five `Scrape job added` messages. Repeated
`403`, scrape, SigV4, remote-write, or secret-access errors are deployment
failures, not warnings to waive.

The public API must not expose metrics without the bearer token:

```bash
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  https://api.moosewave.com/metrics)" = 403
```

Do not test the production token from a shell transcript. Successful scrapes
are proven through collector logs and AMP's `up` series.

## 7. Configure private Grafana access

The workspace accepts IAM Identity Center identities only and is reachable
only through its private Grafana VPC endpoint. Ensure the operator is connected
through the routed VPN or private network, then add a named administrator:

```bash
export IDENTITY_CENTER_USER_ID='<identity-store-user-id>'
aws grafana update-permissions \
  --workspace-id "${GRAFANA_WORKSPACE_ID}" \
  --update-instruction-batch \
  "[{\"action\":\"ADD\",\"role\":\"ADMIN\",\"users\":[{\"id\":\"${IDENTITY_CENTER_USER_ID}\",\"type\":\"SSO_USER\"}]}]"

stack_output "${OBSERVABILITY_STACK}" GrafanaWorkspaceEndpoint
```

Inside Grafana:

1. Add the Amazon Managed Service for Prometheus data source using the
   `PrometheusEndpointUrl` stack output, SigV4 authentication, and region
   `us-west-2`. Do not add static AWS keys.
2. Import
   [`postwave-release-overview.json`](../grafana/dashboards/postwave-release-overview.json).
3. In Explore, run `up`. Exactly these jobs must be present with value `1`:
   `postwave-api`, `postwave-migration`, `postwave-deliverability`,
   `postwave-voice`, and `postwave-automation`.
4. Run the release queries for API 5xx rate, p95 latency, recurrence scanner
   freshness, automation queue depth, audit-sink failures, privacy deadlines,
   and reputation-provider failures. Confirm every panel has current data.

AMP alert rules are deployed by CloudFormation from the same governed queries
as `infra/grafana/alerts/release_core.yml`; do not create divergent manual
copies in Grafana.

## 8. Deploy infrastructure alarms

Capture the main-stack dimensions and deploy the CloudWatch alarm stack only
after both the API and Campaign Assurance data-plane services are healthy at
their certified count:

```bash
export LOAD_BALANCER_FULL_NAME="$(stack_output "${MAIN_STACK}" LoadBalancerFullName)"
export TARGET_GROUP_FULL_NAME="$(stack_output "${MAIN_STACK}" ApiTargetGroupFullName)"

aws ecs describe-services --cluster "${ECS_CLUSTER_NAME}" \
  --services postwave-api postwave-campaign-assurance \
  --query 'services[].{service:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount,rollout:deployments[?status==`PRIMARY`].rolloutState|[0]}' \
  --output table

aws cloudformation deploy \
  --template-file infra/aws/cloudwatch-alarms.yaml \
  --stack-name "${ALARM_STACK}" \
  --parameter-overrides \
    "OpsAlertEmail=${ALERT_EMAIL}" \
    "ECSClusterName=${ECS_CLUSTER_NAME}" \
    ECSServiceName=postwave-api \
    VoiceServiceName=postwave-voice \
    AutomationServiceName=postwave-automation \
    DeliverabilityServiceName=postwave-deliverability \
    MigrationServiceName=postwave-migration \
    CampaignAssuranceServiceName=postwave-campaign-assurance \
    ExpectedApiTaskCount=2 \
    ExpectedCampaignAssuranceTaskCount=2 \
    RDSInstanceId=postwave-prod \
    "LoadBalancerFullName=${LOAD_BALANCER_FULL_NAME}" \
    "TargetGroupFullName=${TARGET_GROUP_FULL_NAME}" \
    ApiLogGroupName=/ecs/postwave-api \
    CampaignAssuranceLogGroupName=/ecs/postwave-campaign-assurance \
  --no-fail-on-empty-changeset
```

Confirm the email subscriptions for both the AMP and CloudWatch SNS topics.
Attach the production paging integration to both topics; email alone is not an
on-call system. Test routing without placing credentials in the command:

```bash
export AMP_ALERT_TOPIC="$(stack_output "${OBSERVABILITY_STACK}" PrometheusAlertsTopicArn)"
export CLOUDWATCH_ALERT_TOPIC="$(stack_output "${ALARM_STACK}" OpsAlertsTopicArn)"
aws sns publish --topic-arn "${AMP_ALERT_TOPIC}" \
  --subject 'Moosewave AMP route smoke test' --message 'Operator initiated smoke test'
aws sns publish --topic-arn "${CLOUDWATCH_ALERT_TOPIC}" \
  --subject 'Moosewave CloudWatch route smoke test' --message 'Operator initiated smoke test'
```

Verify both messages arrive at the primary and backup on-call receivers. Then
inspect every alarm; `INSUFFICIENT_DATA` is acceptable only during its initial
evaluation window:

```bash
aws cloudwatch describe-alarms --alarm-name-prefix postwave- \
  --query 'MetricAlarms[].{name:AlarmName,state:StateValue,reason:StateReason}' \
  --output table
```

The dedicated email-HMAC projection failure and 15-minute staleness alarms are
release blockers. A failure means an exact signing key is returning the closed
`email_identity_projection_not_ready` contract; staleness means durable work
has not advanced for 15 minutes. Confirm the Campaign Assurance tasks are at
their expected count, then inspect only structured `error_class` values
`email_hmac_projection_failed` and `email_hmac_projection_stale`. Do not copy
database errors, envelopes, signing secrets, digests, or subscriber addresses
into incident evidence. Recover KMS/database availability, allow the fenced
worker to replay, and verify a later admin list page reports `ready`; never
override projection state by direct SQL.

## 9. Token rotation

Rotate in a scheduled maintenance window because targets accept one token at a
time. Silence only the five scrape-missing AMP alerts, update the secret value,
force new deployments of all five targets and the collector, wait for every
service to stabilize, then remove the silence and prove all five `up` series
are `1`. Campaign Assurance is deliberately not a sixth scrape target and does
not receive this token, so do not force-deploy it during token rotation. Do not
delete and recreate the secret ARN.

```bash
NEW_METRICS_TOKEN="$(openssl rand -hex 48)"
aws secretsmanager put-secret-value --secret-id "${METRICS_TOKEN_SECRET_ARN}" \
  --secret-string "${NEW_METRICS_TOKEN}" >/dev/null
unset NEW_METRICS_TOKEN

for service in postwave-api postwave-voice postwave-automation \
               postwave-deliverability postwave-migration \
               postwave-observability-collector; do
  aws ecs update-service --cluster "${ECS_CLUSTER_NAME}" \
    --service "${service}" --force-new-deployment >/dev/null
done
aws ecs wait services-stable --cluster "${ECS_CLUSTER_NAME}" \
  --services postwave-api postwave-voice postwave-automation \
             postwave-deliverability postwave-migration \
             postwave-observability-collector
```

Treat a leaked metrics token as a security incident. Rotate immediately and
review CloudTrail, ALB access logs, collector logs, and security-group changes.

## 10. Rollback and failure isolation

- Collector or AMP failure: update the observability stack with
  `DeployCollector=false`. CloudWatch alarms remain active. Do not disable
  application metrics authentication.
- Bad collector release: select a previously signed and scanned
  `sha-<git-sha>` ECR artifact, verify its signature and evidence, and update
  `CollectorImageDigest`. Never roll back to an unscanned upstream image.
- Alert storm: silence the narrow rule or disable actions on the named
  CloudWatch alarm; keep ingestion running and record the incident/change.
- Grafana access failure: diagnose VPN routes, the private endpoint, IAM
  Identity Center assignment, and workspace status. Do not make the workspace
  public as a workaround.
- Metrics 403 errors: confirm every task received the same secret ARN and was
  restarted after its current secret version. Never log the token.

## 11. Optional distributed tracing

All five Go services share TLS-by-default OTLP/gRPC tracing, W3C propagation,
route-template span names, and a default 10% parent-based sample rate. Tracing
is disabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is absent.

For a separately approved TLS OTLP backend, set on every service:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=https://<approved-otlp-host>:443
OTEL_TRACES_SAMPLER_ARG=0.1
POSTWAVE_ENV=production
POSTWAVE_RELEASE=<immutable-release-id>
```

Production and staging reject `OTEL_EXPORTER_OTLP_INSECURE=true`; the endpoint
cannot contain credentials, query parameters, fragments, or a path. Store any
vendor authorization value in Secrets Manager and inject it using the
vendor-supported exporter header mechanism. Verify one trace crosses the API
and a sidecar and confirm that raw paths, query strings, authorization headers,
subscriber data, and message bodies are absent before declaring tracing live.

## 12. Required release evidence

Store dated, access-controlled evidence for each production release:

- outputs of all repository observability and AWS contract gates;
- successful Trivy table/SARIF for both collector architectures;
- GHCR and ECR digest, signature verification, SBOM, and provenance results;
- CloudFormation change sets and final stack events;
- API, sidecar, Campaign Assurance, and collector desired/running counts plus
  collector task hardening output;
- collector startup showing five jobs and no scrape/remote-write errors;
- Grafana `up` result and release dashboard screenshots;
- current Campaign Assurance CPU, memory, running-task, and structured-error
  alarm states, plus email-HMAC projection failure/staleness alarm states;
- AMP and CloudWatch alert receiver smoke-test acknowledgements;
- the named operator, timestamp, Git SHA, and rollback digest.

Never store tokens, DSNs, authorization headers, or raw customer telemetry in
the evidence bundle.
