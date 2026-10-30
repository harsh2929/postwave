# Moosewave

> Public source snapshot of Postwave / Moosewave. This repository starts with
> fresh history and preserves the existing AGPL-3.0-only application and MIT
> package licenses. Private configuration, tuned proprietary packs, internal
> evidence, and historical commits are excluded. See [PUBLIC-RELEASE.md](PUBLIC-RELEASE.md)
> for scope, credential setup, and verification details.

The marketing platform you own forever. Campaigns, lifecycle flows, segmentation, and multichannel sending — run by you or your agents. Move in 20 minutes. Land in inbox. Sound like yourself.

This repository contains the AGPL-3.0-only Moosewave application, MIT-licensed
package roots, and separately controlled assets that are excluded from public
and customer artifacts. Current architecture and
release decisions live in [the ADR log](docs/decisions.md),
[the technology inventory](docs/tech-stack-inventory.md), and
[the production audit](docs/audits/2026-07-14-production-readiness-and-desktop-audit.md).
`research.md` and `plan.md` are retained only as superseded historical records.
License posture is documented in [LICENSE-BOUNDARY.md](LICENSE-BOUNDARY.md).

## Current feature checkpoint: Sending Settings

Desktop Route 46 now provides an administrator-facing sending-policy workspace
with route-owned Overview, Limits & quiet hours, Frequency caps and Sending
identity tabs. A verified server baseline owns the editable draft; failed or
malformed reads do not become a blank policy, dirty work survives refresh, and
save/clear use the baseline revision for conflict detection. The server applies
strict cap and quiet-hour validation, transactional audit/attribution and
cap-cache invalidation.

The surface deliberately avoids stronger enforcement claims. Its live counter
is explicitly unavailable until the active Redis/LRU limiter can be inspected;
frequency caps are best-effort queue-admission filters rather than atomic
dispatch or delivery proof; the legacy fallback hour is preserved but is not
the canonical send-time-optimization model; and IP-pool assignment is only an
infrastructure projection. Route 46 is **IMPLEMENTED / RELEASE HELD** and
**AUDITED / NO-GO** in mutable source. Production remains **HOLD / NO-GO**
pending R46-01 through R46-14, including migrated-database and multi-replica
limiter proof, atomic frequency enforcement and privacy lifecycle, cross-client
schema convergence, installed visual/manual-AT evidence, clean broad gates and
an immutable candidate. See the
[Route 46 Sending Settings audit](docs/audits/2026-08-30-sending-settings-99p9-audit.md).

## Prior feature checkpoint: consent evidence

The desktop **Consent receipts** destination now provides an administrator-only,
read-only inspection workspace for bounded receipt/proof and consent-event
windows, with strict response contracts, truthful partial/stale/empty states,
signed insert-stable paging, responsive evidence review and an explicit
sensitive-data boundary. The paging boundary excludes later inserts but is not
a frozen cross-request snapshot across deletion or permitted redaction. It
deliberately provides no mutation, copy or export action.

This checkpoint is **HOLD / NO-GO** for production consent-ledger claims: it is
not yet a complete cross-channel history, current delivery-eligibility
authority, lifecycle-certified evidence store or standards-certified portable
export. A shared plaintext 30-day recipient URL capability also still spans
machine one-click unsubscribe and hosted preference read/write, with edge-log
and lifecycle work open; commercial dispatch can still fail soft on functional
opt-out creation and does not reliably enforce topic/cadence/pause choices. The
exact claim boundaries, findings and acceptance plan are in the
[Route 38 Consent Receipts audit](docs/audits/2026-08-20-consent-receipts-99p9-audit.md).

## Agent and MCP source checkpoint

The repository explores agent-driven marketing workflows across distinct
surfaces. Those surfaces do not currently have distribution or semantic parity:

- **MCP source candidate**: the mutable repository catalogue has 284
  definitions, while the independently observed immutable npm `0.1.0` artifact
  exposes 133 names. Production install, hosted service, working-key setup and
  cross-client compatibility are **release-held** under
  `mcp_distribution_release_held`; see
  [`packages/mcp-server`](packages/mcp-server) and the source inventory at
  [`apps/web/src/lib/mcp-tools.json`](apps/web/src/lib/mcp-tools.json).
- **TypeScript SDK**: `@postwave/sdk` — see [`packages/sdk-ts`](packages/sdk-ts).
- **REST + SSE**: see [`packages/openapi/openapi.yaml`](packages/openapi/openapi.yaml).

No Claude Code session or plugin setup is presented as runnable while this hold
is active. Catalogue names and UI transcripts are source fixtures only.

### An ordinary SDK read

```ts
import { PostwaveClient } from "@postwave/sdk";

const pw = new PostwaveClient({
  apiKey: process.env.POSTWAVE_API_KEY!,
  tenantId: "acme",
});

const page = await pw.subscribers.list({ per_page: 25 });
for (const subscriber of page.items) {
  console.log(subscriber.email, subscriber.status);
}
```

This is an ordinary REST-backed SDK read. It is not an agent-control loop or
evidence that MCP, approvals, sandboxing, budgets, audit, or event delivery are
coupled into one execution guarantee.

## Repo layout

```
postwave/
├── apps/
│   ├── web/              # Next.js 15 admin app + marketing site
│   └── api/              # Go: AGPL application-layer API gateway
├── services/
│   ├── migration/        # Pillar 1
│   ├── deliverability/   # Pillar 2
│   ├── voice/            # Pillar 3
│   └── automation/       # Wait/branch/send runtime (powers Pillar 3 + migrated journeys)
├── engine/               # Listmonk integration docs; deployments pin the upstream image
├── packages/             # Independently MIT-licensed package roots
│   ├── openapi/          # OpenAPI 3.1 spec + Scalar viewer
│   ├── schema/           # Canonical TS schema (mirrored to Go in packages/migrate)
│   ├── sdk-ts/           # @postwave/sdk — TypeScript SDK
│   ├── sdk-py/           # postwave — Python SDK (Poetry, outside JS workspace)
│   ├── mcp-server/       # Release-held MCP source candidate; no production setup
│   ├── cli/              # @postwave/cli — postwave command-line tool
│   └── migrate/          # Go module migration adapters
├── infra/
│   ├── docker-compose.yml
│   ├── aws/              # Canonical Moosewave Cloud deployment contract
│   └── terraform/        # Archived non-production Hetzner prototype
├── docs/
│   ├── decisions.md      # ADR log
│   └── runbooks/
├── research.md           # Superseded historical PRD research
├── plan.md               # Superseded historical V1 plan
├── LICENSE-BOUNDARY.md   # AGPL/MIT/proprietary path boundaries
└── THIRD_PARTY_LICENSES.md
```

## Local development

### Prerequisites

- Node 20+, pnpm 9+
- Go 1.26+ (the workspace and CI pin the Go 1.26.8 toolchain)
- Docker Desktop
- Git

### First-time setup

```bash
# 1. Install JS deps
pnpm install

# 2. Initialize Go workspace (already configured in go.work)
go work sync

# 3. Start Postgres + Redis + Listmonk locally
docker compose -f infra/docker-compose.yml up -d

# 4. Run dev servers
pnpm dev          # Next.js web app on :3000
go run ./apps/api # Moosewave API on :8080
```

Listmonk runs on `:9000` once docker compose is up. Default admin login is set in `infra/docker-compose.yml`.

## What you (the human) need to set up before we can ship

These cannot be automated and require accounts/keys. The codebase is structured so they slot in cleanly when ready.

| Service                        | Purpose                                                                     | When needed                   |
| ------------------------------ | --------------------------------------------------------------------------- | ----------------------------- |
| AWS organization/account       | Canonical isolated staging and production environments                      | Before staging                |
| Route 53 + ACM                 | Owned `moosewave.com` DNS and TLS validation                                 | Before staging cutover        |
| ECS, RDS, ElastiCache, S3, KMS | Canonical application/data plane described by the AWS runbook               | Before staging                |
| Listmonk deployment            | Private, pinned sending engine behind the service boundary                  | Before provider certification |
| Postmark                       | Managed sending tier (production sender)                                    | Phase 2                       |
| AWS SES                        | Failover sender + cheap bulk                                                | Phase 2                       |
| Anthropic API key              | Claude (Sonnet for Diagnostician + Voice gen, Haiku for Pre-Send Predictor) | Phase 1                       |
| OpenAI API key                 | text-embedding-3-small for voice fidelity scoring                           | Phase 2                       |
| HTMLCSStoImage                 | Cross-client rendering preview                                              | Phase 3                       |
| SenderScore (Validity)         | Reputation scoring                                                          | Phase 2                       |
| Stripe + Razorpay              | Payments                                                                    | Phase 1                       |
| Sentry                         | Error tracking                                                              | Phase 0                       |
| PostHog                        | Product analytics                                                           | Phase 0                       |

Copy `.env.local.example` to `.env.local` and fill only the credentials for
the services you are exercising. Production values belong in the configured
secret manager, never in a checked-in environment file.

## Operations

On-call runbooks live under [docs/runbooks/](docs/runbooks/). The
[runbooks index](docs/runbooks/README.md) lists every scenario we have
written response procedures for: deliverability incidents, account
bans, IP delistings, migration failures, automation-runtime stalls,
database outages / RLS bypasses, and GDPR/CCPA data exports.

Scale-test harnesses (k6 + Go) are in [scripts/scale-test/](scripts/scale-test/).
Run them against staging before each release; see
[scripts/scale-test/README.md](scripts/scale-test/README.md) for the
target SLOs.

## Production deploy

The sole Moosewave Cloud target is **AWS ECS Fargate in `us-west-2`**, using
`moosewave.com` and CloudFormation as the infrastructure contract. The ordered,
authoritative procedure is
[`infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md`](infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md).
That repository contract is not evidence that a live production environment
exists: deployment, DNS/TLS ownership, provider certification, signed-artifact
promotion, restore/failover and alert exercises must all produce linked
account-backed evidence before client traffic is allowed.

`infra/terraform`, `infra/mvp`, and Docker Compose are non-production
development or historical references. They are not alternate Moosewave Cloud
deployment paths. Cloudflare may be added as an edge control only after the
canonical AWS origin is healthy; it does not own the application data plane.

## Workflow

Current expensive-to-reverse decisions are recorded in
[`docs/decisions.md`](docs/decisions.md). Historical research and plans remain
available for provenance but are not implementation or release contracts.

## License — Open Core

Moosewave's checked-in source has four release boundaries:

1. **`engine/`** — upstream Listmonk integration documentation. Local development uses the version-tagged `listmonk/listmonk:v6.1.0` image; a release requires an approved immutable digest. This repository contains no Listmonk fork, source tree, or submodule.
2. **`packages/*`** — each immediate package root is MIT licensed. The license does not promise publication, a public mirror, registry availability, maintenance, or support.
3. **`apps/*` + `services/*` + `infra/`** — AGPL-3.0-only application source. Supported packaging, hosting, continuity, and SLAs are separate commercial commitments.
4. **`proprietary/`** — separately controlled tuned assets present only in private/internal checkouts and selected private Moosewave Cloud images. They must not enter public, customer, self-host, or corresponding-source artifacts. Redistributable MIT placeholders live in `proprietary-stubs/`.

See [LICENSE-BOUNDARY.md](LICENSE-BOUNDARY.md) for the authoritative source and
release boundary. © Moosewave 2026.
