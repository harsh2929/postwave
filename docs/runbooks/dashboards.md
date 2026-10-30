# Production dashboards and telemetry

This runbook describes telemetry that is actually provisioned for the canonical
AWS production environment. It must stay aligned with
[`infra/aws/OBSERVABILITY_RUNBOOK.md`](../../infra/aws/OBSERVABILITY_RUNBOOK.md),
the dashboard JSON, alert rules, and CloudFormation templates.

There is no public `grafana.postwave.*` endpoint. Amazon Managed Grafana uses
IAM Identity Center and a restricted Grafana workspace VPC endpoint. Operators
must connect through the approved private network and obtain the workspace URL
from the `GrafanaWorkspaceEndpoint` output of `postwave-observability-prod`.

## Grafana release dashboard

Import
[`infra/grafana/dashboards/postwave-release-overview.json`](../../infra/grafana/dashboards/postwave-release-overview.json)
into the private workspace. Its AMP data source is the
`PrometheusEndpointUrl` stack output with SigV4 authentication in `us-west-2`.
Static AWS keys are forbidden.

The checked-in dashboard contains these governed panels:

- API 5xx request rate and p95 latency by route template;
- bounded rate-limiter LRU evictions;
- audit-sink consecutive failures;
- overdue privacy requests;
- API-key authentication-cache hit ratio;
- Tier-1 surface 5xx rate;
- automation recurrence-scanner age;
- automation queue depth and queue-inspection failures;
- deliverability reputation-provider failures.

In Grafana Explore, `up` must return value `1` for exactly these targets:

- `postwave-api`
- `postwave-migration`
- `postwave-deliverability`
- `postwave-voice`
- `postwave-automation`

An absent target is an incident even if the remaining dashboard panels look
healthy.

## AMP alerts

CloudFormation provisions the same rule contract recorded in
[`infra/grafana/alerts/release_core.yml`](../../infra/grafana/alerts/release_core.yml).
The current rules are:

- five target-missing pages, one for each governed service;
- `APIHigh5xxRate` and `APILatencyP95High`;
- `RateLimiterEvicting`;
- `AuditSinkConsecutiveFailures`;
- `PrivacyRequestOverdue`;
- `RecurrenceScannerStale`;
- `AutomationQueueBacklogHigh`;
- `AutomationQueueObservationFailing`;
- `ReputationProviderFailures`.

Do not create manually divergent copies in Grafana. Change the governed rule
file, the embedded AMP namespace, dashboard queries, emitter contract, and
tests in one reviewed change. `pnpm audit:observability` enforces this parity.

AMP alerts publish to the KMS-encrypted `PrometheusAlertsTopicArn` output.
Both the primary and backup on-call receiver must acknowledge the routing smoke
test in the observability runbook before a launch.

## Campaign Assurance

[`infra/grafana/dashboards/campaign-assurance.json`](../../infra/grafana/dashboards/campaign-assurance.json)
and [`infra/grafana/alerts/campaign_assurance.yml`](../../infra/grafana/alerts/campaign_assurance.yml).

Read the **SLO aggregate readable** stat first. Every other panel is a
threshold on a gauge, and an uncollected gauge renders as zero — which is
indistinguishable from perfect health. If that stat is 0, treat the whole
dashboard as unknown rather than green.

Three distinctions the panels encode, because acting on the wrong one wastes an
incident:

- **Blocked is not failed.** A blocked run means assurance worked and refused
  the send. That is the campaign owner's problem. Investigate the platform only
  if a deploy changed an analyzer or the Fact Contract and made the checks
  wrong — correlate with releases before telling customers to fix their
  campaigns. `CampaignAssuranceBlockRateElevated` is deliberately a warning,
  not a page: waking someone for a working gate teaches them to ignore it.
- **Incomplete is not a pass.** The run finished without the evidence it
  required. `CampaignAssuranceIncompleteRuns` fires when over a fifth of
  terminal runs land there, because at that point recent receipts are not
  trustworthy — check the model provider, image broker, and OCR/scanner
  sockets before believing any verdict.
- **A stuck run is worse than a refused one.** Orphaned runs and expired leases
  page, because the campaigns they gate silently never send and nothing
  surfaces to their owner.

Gate decision counts must be read alongside
`POSTWAVE_CAMPAIGN_ASSURANCE_GATE_ROLLOUT`. Below `block` the gate reports its
verdict but the legacy sender still runs, so a `block` status on the panel does
not yet mean a send was stopped.

Every series comes from the content-free SLO aggregate (migration 1938/1957)
and gate telemetry. No campaign content, recipient identity, or provider
payload reaches this dashboard; only a bounded error code does.

## CloudWatch dashboard and alarms

The `postwave-production` CloudWatch dashboard is created by
[`infra/aws/cloudwatch-alarms.yaml`](../../infra/aws/cloudwatch-alarms.yaml).
It contains:

- API ECS CPU and memory;
- ALB healthy/unhealthy hosts and target 5xx responses;
- RDS CPU, connections, free storage, and freeable memory;
- recent structured API `ERROR` and `FATAL` log events.

The same stack alarms on API resource pressure/running-task count, all four
sidecar running-task counts, ALB health/latency/5xx, RDS capacity, SES
reputation/rejects, SNS delivery failures, and API error logs. Collector task
and log alarms live in `observability-stack.yaml`; backup/restore alarms live
in the backup/DR stack.

Inspect state with:

```bash
aws cloudwatch describe-alarms --alarm-name-prefix postwave- \
  --query 'MetricAlarms[].{name:AlarmName,state:StateValue,reason:StateReason}' \
  --output table --region us-west-2
```

After the initial evaluation period, unexplained `INSUFFICIENT_DATA` is a
telemetry fault. Never change `TreatMissingData` merely to make the alarm list
green.

## Logs

Production ECS logs are retained for 90 days in these CloudFormation-managed
groups:

- `/ecs/postwave-api`
- `/ecs/postwave-db-migrator`
- `/ecs/postwave-voice`
- `/ecs/postwave-automation`
- `/ecs/postwave-deliverability`
- `/ecs/postwave-migration`
- `/ecs/postwave-observability-collector`

Tasks may create streams but may not create or silently replace log groups.
Useful first-response commands:

```bash
aws logs tail /ecs/postwave-api --since 30m --region us-west-2
aws logs tail /ecs/postwave-observability-collector --since 30m --region us-west-2
aws logs filter-log-events --log-group-name /ecs/postwave-api \
  --filter-pattern '{ $.level = "ERROR" || $.level = "FATAL" }' \
  --region us-west-2
```

Do not assume every log line contains a tenant, request, or event identifier;
inspect the structured event fields that are actually present. Never paste
subscriber data, credentials, authorization headers, or metrics tokens into an
incident ticket.

## Metrics retention and access

AMP retention defaults to 365 days and is configurable from 30 to 1,095 days
through `MetricsRetentionDays`. `/metrics` is not an anonymous diagnostics
endpoint: direct loopback is allowed, while every remote scrape requires the
dedicated high-entropy bearer token. Forwarded headers are ignored.

The public access check must return `403`:

```bash
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  https://api.moosewave.com/metrics)" = 403
```

Do not put the production bearer token into a local curl command or terminal
transcript. Validate successful collection through the collector logs and AMP
`up` series.

## Incident sequence

1. Acknowledge the page and identify whether it came from AMP or CloudWatch.
2. Check all five `up` series and ECS desired/running/pending counts.
3. Open the release dashboard and the relevant CloudWatch panel.
4. Correlate the first bad sample with deployment events and retained logs.
5. Use the linked domain runbook from the alert annotation.
6. Roll back only to a previously signed, scanned artifact and record the
   immutable digest.
7. Preserve the query, time range, stack/task events, and alert timestamps in
   the incident evidence without secrets or customer content.

## Optional systems and known external work

Sentry, PostHog, a public status page, external synthetic probes, hosted log
search, and real-user monitoring are not provisioned by these templates and
must not be represented to clients as live. If adopted, they require a
separate reviewed deployment, data-processing/privacy assessment, credential
rotation procedure, alert-route test, and an update to this runbook.

Before prospective-client access, deploy an independent external synthetic
monitor for at least `https://api.moosewave.com/api/ready` from multiple
failure domains and route it to the same staffed on-call service. A repository
configuration file alone is not evidence that the external monitor is active.

## Changing dashboards

Do not repair an incident by leaving an undocumented manual dashboard behind.
After immediate mitigation, update the checked-in dashboard or alert rule,
run the observability contract, deploy through the reviewed stack workflow,
and attach before/after evidence to the incident follow-up.
