# Moosewave Sigma Rule Pack

Detection content for the Moosewave audit log when streamed through an
OCSF 1.8 sink.

## Why this exists

OCSF 1.8 (Linux Foundation, March 2026) is the lingua franca for SIEM
ingestion. Splunk, Datadog Cloud SIEM, Microsoft Sentinel Data Lake,
AWS Security Lake, Google SecOps, and SentinelOne all consume OCSF
natively. Without a rule pack, detection engineers have to roll their
own — which they will refuse to do for "yet another SaaS." This pack
short-circuits the customer's detection backlog with five canonical
rules covering the highest-signal scenarios.

## Rules in this pack

| File | Severity | Covers | OCSF class |
|------|----------|--------|------------|
| `mass_subscriber_delete.yml` | High | Bulk delete bursts | 3004 Entity Management |
| `off_hours_admin_action.yml` | Medium | Destructive admin ops outside business hours | 3001 / 3004 |
| `failed_auth_burst.yml` | High | Credential stuffing / brute force | 3002 Authentication |
| `export_large_audience.yml` | High | Bulk subscriber export (precursor to exfiltration) | 3004 Entity Management |
| `api_key_rotation_burst.yml` | Medium | API-key churn — persistence indicator | 3001 Account Change |

All rules ship as stable; they reference OCSF field names so any
pySigma backend that targets OCSF (Splunk, Sentinel KQL, Datadog,
Chronicle YARA-L) will compile them out of the box.

## Installation

### pySigma (any backend)

```bash
pip install pysigma pysigma-backend-splunk pysigma-backend-elasticsearch
sigma convert -t splunk docs/sigma/postwave/rules/*.yml > postwave.spl
```

### Datadog Cloud SIEM

Upload the rule pack via the **Detection Rules → Import** UI; Datadog's
OCSF parser handles the field mapping automatically.

### Microsoft Sentinel

```bash
sigma convert -t microsoft365defender docs/sigma/postwave/rules/*.yml > postwave.kql
```

Import the resulting KQL queries as **Analytics → Scheduled rules**.

### AWS Security Lake / OpenSearch

```bash
sigma convert -t opensearch docs/sigma/postwave/rules/*.yml > postwave.os.json
```

## Versioning

This pack is versioned alongside the audit-log API. Each rule's `id`
field is stable (UUIDv4) — never rewrite it. Bump `modified` on every
change, and add an entry to `CHANGELOG.md` at the root of the pack
when published.

## Field reference

See `docs/audit/ocsf-mapping.md` for the full Moosewave audit row →
OCSF field translation table. Detection content here assumes the
flattened OCSF event shape (class fields lifted to the envelope).

## Support matrix

| SIEM | Status | Notes |
|------|--------|-------|
| Splunk Cloud SIEM | Tested | Requires OCSF 1.8 add-on |
| Datadog Cloud SIEM | Tested | Native OCSF parser, no add-on |
| Microsoft Sentinel | Tested | Use the OCSF data connector |
| Google SecOps (Chronicle) | Tested | Use the YARA-L backend |
| AWS Security Lake | Tested | Native ingest |
| Elastic SIEM | Best-effort | Map via ECS conversion |

## License

The Sigma rules in this pack are released under the Detection Rule
License v1.1 (DRL 1.1).
