# Canonical infrastructure status

The sole Moosewave Cloud target is AWS ECS Fargate in `us-west-2`, with
`moosewave.com` as the public-domain contract and CloudFormation as the
infrastructure-as-code format. The authoritative ordered procedure is
[`aws/PRODUCTION_DEPLOY_RUNBOOK.md`](aws/PRODUCTION_DEPLOY_RUNBOOK.md).

Repository-ready does not mean production-certified. The templates, static
contracts, local recovery exercises and release workflows can be verified in
CI; account deployment, DNS/TLS ownership, signed-image promotion, provider
callbacks, destructive cloud recovery and alert acknowledgement need external
evidence from the actual staging and production accounts.

## Repository controls

| Control | Repository status | Required external evidence |
| --- | --- | --- |
| API, sidecars and migrator | Digest-only two-pass rollout contract | Successful staging change set, migrations, readiness and rollback |
| Metrics and alerts | Private authenticated five-target collector; governed dashboards/alarms | Grafana access, alarm delivery, acknowledgement and incident exercise |
| Backup and recovery | Pinned WAL-G image, local isolated PITR, RDS cross-region templates | Account-backed PITR/cross-region drill with measured RPO/RTO |
| Artifact supply chain | Multi-architecture build, SBOM/provenance, signing and verified ECR bridge | Immutable promoted digests and signature verification records |
| Data plane | Hardened RDS/S3/ECS modules and prerequisite validation | VPC/KMS/Redis/Listmonk/provider resources and Access Analyzer output |
| DNS and edge | Route 53/ACM origin contract; optional Cloudflare controls | Owned zone, issued certificate, origin restriction and monitored cutover |
| Web | AWS runbook and signed image workflow | Deployed digest, target health, CSP/browser smoke and rollback |

Run the repository gates before creating a change set:

```bash
pnpm audit:platform
pnpm audit:observability
pnpm audit:observability:collector:release
pnpm audit:backup-dr
```

## Non-production paths

- `infra/docker-compose*.yml` is local development/integration topology.
- `infra/mvp` is a quarantined historical experiment and contains no supported
  environment contract.
- `infra/terraform` is an archived Hetzner prototype. It is not an alternate
  Moosewave Cloud platform.
- `infra/cloudflare` is an optional edge layer after the canonical AWS origin
  passes qualification; it never replaces the application/data plane.

No document may claim that Moosewave is live or production-ready solely because
these source-side controls exist.
