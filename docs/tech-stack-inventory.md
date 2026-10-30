# Moosewave Tech Stack And Architecture Inventory

Date: May 11, 2026

Status: Decision-support documentation. No infrastructure was created, changed, or deployed while preparing this document.

Accuracy pass: May 11, 2026. Cross-checked against repo manifests, Docker Compose files, service READMEs, OpenAPI/MCP package metadata, and the AWS deployment/cost docs. Known residual caveat: the MCP package has conflicting internal published counts, documented in the client/agent section below.

Companion document: [operating-economics-rationale.md](./operating-economics-rationale.md)

Related source documents:

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [aws-deployment-runbook.md](./aws-deployment-runbook.md)
- [aws-cost-economics-report.md](./aws-cost-economics-report.md)
- [LICENSE-BOUNDARY.md](../LICENSE-BOUNDARY.md)
- [README.md](../README.md)

## Executive Summary

Moosewave is a multi-service email and newsletter platform, not a single web app. The current repository contains:

- A Next.js web dashboard and marketing site.
- A Go API gateway.
- Four Go sidecar services for migrations, deliverability, voice AI, and automation.
- A standalone Listmonk process used only over HTTP.
- Postgres for tenant-scoped durable state.
- Redis/Valkey for queueing and delayed automation work.
- First-party SDK, OpenAPI, MCP, CLI, desktop, and mobile clients.
- Local Docker composition that runs the full product without AWS.
- AWS deployment documentation targeting ECS Fargate, RDS, ElastiCache Valkey, SES, S3, CloudWatch, WAF, Route 53, Secrets Manager, and KMS.

The key architectural decision is to keep Moosewave's application logic outside Listmonk while using Listmonk as the battle-tested sending and subscriber engine. That lets Moosewave own migrations, AI workflows, billing, agent tooling, forms, automation, mobile, desktop, and tenant-level governance without importing Listmonk code directly.

## Product Scope

Moosewave exists to move newsletter and lifecycle-marketing users from ActiveCampaign, HubSpot, Mailchimp, ConvertKit, Brevo, Beehiiv, MailerLite, Sendy CSV exports, Substack, and CSV into a lower-cost, AI-assisted platform with:

- Subscriber and campaign management, plus US/Canada SMS source/draft,
  consent, suppression, and bounded inbox presentation. Hosted SMS provider
  effects are **HOLD / NO-GO**.
- Source-platform migration with dry-run verification and rollback.
- Inbox Reality deliverability analysis.
- Pre-send placement prediction.
- Voice-trained email sequence generation.
- Behavioral automations and ActiveCampaign-style parity inventory, with HubSpot bridge support when CRM remains outside Moosewave.
- Forms and double opt-in.
- Stripe-backed billing state.
- Agent-first operations through MCP, SDKs, REST, and SSE.

The project has three core product pillars:

| Pillar         | Owner                                               | Main Runtime              |
| -------------- | --------------------------------------------------- | ------------------------- |
| Migration      | Import users from other ESPs safely                 | `services/migration`      |
| Deliverability | Inbox placement, auth checks, reputation, rendering | `services/deliverability` |
| Voice AI       | Voice profile build and sequence generation         | `services/voice`          |

Automation is the runtime layer that powers migrated journeys and future behavioral flows.

## Repository Map

| Path                          | Purpose                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                    | Next.js 15 dashboard, marketing site, docs-like public pages, forms UI, billing UI, migration UI, campaign UI, voice UI.                             |
| `apps/api`                    | Go API gateway, auth, tenancy, Listmonk proxy/client, billing webhooks, subscribers, campaigns, forms, webhooks, sending, status, settings.          |
| `apps/mobile`                 | Expo React Native app for iOS and Android.                                                                                                           |
| `apps/desktop`                | Tauri desktop shell and bundled frontend handoff.                                                                                                    |
| `services/migration`          | Migration service and adapters for ActiveCampaign, HubSpot, Mailchimp, ConvertKit, Brevo, Substack, Beehiiv, MailerLite, Sendy CSV exports, and CSV. |
| `services/deliverability`     | Inbox Reality reports, auth checks, reputation aggregation, prediction, cross-client render previews, AI Diagnostician.                              |
| `services/voice`              | Voice source ingestion, voice profile build, template library, sequence generation, fidelity scoring.                                                |
| `services/automation`         | Asynq-backed wait/branch/send/action journey runtime.                                                                                                |
| `packages/openapi`            | OpenAPI 3.1 spec and static viewer.                                                                                                                  |
| `packages/sdk-ts`             | First-party TypeScript SDK.                                                                                                                          |
| `packages/sdk-py`             | First-party Python SDK.                                                                                                                              |
| `packages/mcp-server`         | Model Context Protocol server for Claude Code, Claude Desktop, Cursor, Continue, Zed, and HTTP/SSE clients.                                          |
| `packages/cli`                | Command-line interface.                                                                                                                              |
| `packages/migrate`            | MIT-licensed migration adapter package.                                                                                                              |
| `packages/schema`             | Canonical shared schema.                                                                                                                             |
| `packages/email-react`        | Email component/rendering package.                                                                                                                   |
| `packages/claude-code-plugin` | Claude Code plugin.                                                                                                                                  |
| `packages/vscode-extension`   | VS Code extension.                                                                                                                                   |
| `packages/zapier`             | Zapier integration package.                                                                                                                          |
| `infra`                       | Local Docker, AWS notes, Terraform/Cloudflare placeholders, migrations, backup and load-test docs.                                                   |
| `docs`                        | Architecture, cost, runbooks, privacy, release, self-hosting, disaster recovery, and audit docs.                                                     |
| `engine`                      | Upstream Listmonk integration documentation; no source tree, fork, or submodule is present.                                                          |
| `proprietary`                 | Private/internal Moosewave Cloud asset packs excluded from public and customer artifacts.                                                            |

## System Topology

```text
----------------------+        +----------------------+
| Web dashboard       |        | Mobile / desktop     |
| Next.js / React     |        | Expo / Tauri         |
+----------+-----------+        +----------+-----------+
           |                               |
           | HTTPS, cookies, API keys      |
           v                               v
        +--------------------------------------+
        | Go API gateway                       |
        | apps/api                             |
        | auth, RLS binding, billing, public   |
        | API, Listmonk client, service proxy  |
        +----+-----------+-----------+---------+
             |           |           |
             | internal HTTP + token |
             v           v           v
 +-----------+--+  +-----+---------+ +---------+------+
 | Migration    |  | Deliverability| | Voice AI       |
 | service      |  | service       | | service        |
 +--------------+  +---------------+ +----------------+
             \           |           /
              \          |          /
               v         v         v
             +--------------------------+
             | Postgres                 |
             | tenant RLS, jobs, audit, |
             | outbox, mirrors, billing |
             +-----------+--------------+
                         |
                         v
             +--------------------------+
             | Redis / Valkey           |
             | Asynq queue and delays   |
             +--------------------------+
                         |
                         v
             +--------------------------+
             | Listmonk                 |
             | standalone HTTP process  |
             | subscribers, campaigns,  |
             | transactional sends      |
             +--------------------------+
```

## Runtime Services

### Web App

Location: `apps/web`

Stack:

- Next.js 15.
- React 19.
- TypeScript.
- Tailwind CSS.
- Radix UI primitives.
- shadcn-style local components.
- TipTap editor dependencies.
- GrapesJS and MJML for email editing/rendering surfaces.
- Sentry integration.
- PostHog integration.
- `sonner` toast notifications.
- `lucide-react` icons.

Responsibilities:

- Public marketing site.
- Dashboard shell.
- Subscriber UI.
- Campaign UI.
- Migration source picker and wizard.
- Inbox Reality UI.
- Voice sequence UI.
- Template browser and authoring UI.
- Forms builder and public hosted form pages.
- Billing and upgrade flows.
- Settings for sender, domain, team, API keys, webhooks, notifications, privacy.

Important route groups:

| Route Group           | Meaning                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `src/app/(marketing)` | Public pages, pricing, comparisons, docs, changelog, legal.      |
| `src/app/(dashboard)` | Authenticated app surface.                                       |
| `src/app/(public)`    | Public status, forms, llms.txt, and other public utility routes. |

API pattern:

- Web calls go through typed clients under `apps/web/src/lib`.
- Dashboard uses API routes proxied to the Go gateway.
- Local Docker sets `POSTWAVE_LOCAL_AUTH_BYPASS=1` for development only.

### API Gateway

Location: `apps/api`

Stack:

- The API module declares Go 1.26.0; the workspace and CI pin Go 1.26.8.
- `chi` HTTP router.
- `pgx`/`pgxpool` for Postgres.
- RLS-aware transaction helpers.
- Service clients for migration, deliverability, voice, automation, and Listmonk.
- Stripe webhook handling.
- Transactional outbox.

Responsibilities:

- Public API.
- Session/auth and API key handling.
- Tenant context binding.
- Subscriber and campaign mirror tables.
- Listmonk HTTP client.
- Forms and double opt-in.
- Billing and Stripe webhooks.
- Sending state and warmup.
- Webhook subscriptions and delivery.
- Status endpoint.
- Audit endpoint.
- Cost/budget primitives.
- Integration and settings endpoints.

Core route groups:

| Area          | Examples                                              |
| ------------- | ----------------------------------------------------- |
| Health        | `GET /api/health`, `GET /api/listmonk/health`         |
| Subscribers   | `GET/POST/PATCH/DELETE /api/v1/subscribers`           |
| Campaigns     | `GET/POST/PATCH/DELETE /api/v1/campaigns`, test sends |
| Forms         | Admin form CRUD and public submission endpoints       |
| Billing       | Stripe webhook, plan state, checkout/portal URLs      |
| Sending       | Provisioning state, warmup schedule, sending settings |
| Webhooks      | Tenant outbound webhook subscriptions and deliveries  |
| Auth          | Session, magic link, TOTP, OAuth, logout              |
| Service proxy | Migration, deliverability, voice, automation calls    |

### Migration Service

Location: `services/migration`

Stack:

- Go module currently declares Go 1.25.0.
- HTTP server.
- Canonical migration schema.
- Source adapters.
- Postgres job/session store.
- Encrypted source sessions.
- Listmonk HTTP writer.

Supported sources:

| Source         | Auth                    | Subscribers | Segments        | Automations                | Campaign Archive | Paid Subs  |
| -------------- | ----------------------- | ----------- | --------------- | -------------------------- | ---------------- | ---------- |
| ActiveCampaign | API token + API URL     | yes         | partial         | source definition + review | yes              | no         |
| HubSpot        | Private app token       | yes         | yes (list tags) | no                         | no               | no         |
| Mailchimp      | OAuth2                  | yes         | yes             | yes                        | yes              | no         |
| ConvertKit     | OAuth2                  | yes         | yes             | yes                        | yes              | via Stripe |
| Brevo          | API key                 | yes         | yes             | yes                        | yes              | no         |
| Substack       | Official ZIP/CSV upload | yes         | no              | no                         | sent email only  | tier metadata; billing handoff |
| Beehiiv        | API key                 | yes         | partial         | rebuild review             | yes              | tier metadata; billing handoff |
| MailerLite     | API token               | yes         | groups runtime; saved rules rebuild | rebuild review only        | sent metadata/plain text/variants + reports; drafts/ready preserved; no rendered HTML | no         |
| Sendy          | CSV upload              | yes         | no              | no                         | no               | no         |
| CSV            | Upload                  | yes         | n/a             | n/a                        | n/a              | n/a        |

Key properties:

- Dry-run before commit.
- Verification report after dry-run and commit.
- Cursor-paginated pulls.
- Restart-resumable jobs when Postgres is configured.
- Seven-day rollback window after commit.
- Idempotent rollback.
- Source sessions encrypted with `POSTWAVE_MIGRATION_SESSION_KEK`.

### Deliverability Service

Location: `services/deliverability`

Stack:

- Go module currently declares Go 1.25.0.
- DNS resolver abstraction.
- Gemini client over REST.
- HCTI client for render previews.
- Provider adapters for reputation sources.
- In-memory local fallbacks for dev.

Five layers:

| Layer                     | Function                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Seedlist                  | Poll seed inboxes and categorize placement.                                                                            |
| Seedlist vendor connector | Optional `SEEDLIST_VENDOR_API_URL` adapter for GlockApps/MailReach-style APIs before self-provisioned mailboxes exist. |
| Reputation                | DNSBL, Google Postmaster, Microsoft SNDS, SenderScore adapters.                                                        |
| Auth validation           | SPF, DKIM, DMARC, BIMI, PTR, DMARC report parsing.                                                                     |
| Content analysis          | Spam score, link checks, HTML quality, structural issues.                                                              |
| Diagnostician             | Gemini-powered ranked fixes with eval harness and validator.                                                           |

Cross-client rendering:

- Uses HTMLCSStoImage when configured.
- Falls back to mock render URLs in local/dev.
- Target environments include Outlook desktop, Outlook web, Apple Mail macOS/iOS, Gmail web/iOS, Yahoo web, and Proton Mail web.
- Caches renders for 24 hours in memory today.
- Production should move cache state to Redis/Valkey if render volume matters.

AI models:

- Diagnostician: `gemini-3.1-pro-preview`.
- Predictor optional blend: `gemini-3-flash-preview`.

### Voice Service

Location: `services/voice`

Stack:

- Go module currently declares Go 1.25.0.
- Gemini client over REST.
- OpenAI embeddings for fidelity scoring.
- Postgres-backed sources, profiles, templates, sequences.
- Embedded template JSON.

Responsibilities:

- Ingest source material.
- Build a writer voice profile.
- Generate multi-email sequences from templates.
- Regenerate individual emails.
- Score fidelity with embeddings plus heuristics.
- Expose voice profile, source, template, and sequence endpoints.

Ingestion sources:

| Source             | Status                             |
| ------------------ | ---------------------------------- |
| Blog RSS           | wired                              |
| Paste-in text      | wired                              |
| Twitter archive    | wired                              |
| Newsletter archive | wired when Postgres archive exists |
| Podcast transcript | reserved, not registered           |
| LinkedIn export    | reserved, not registered           |

Voice profile fields:

- Stylistic shape.
- Vocabulary and recurring phrases.
- Structural patterns.
- Tonal scores.
- Persona signals.
- Representative samples.
- Source summary.

AI models:

- Generation: `gemini-3-flash-preview`.
- Optional higher-quality profile/tone path: `gemini-3.1-pro-preview`.
- Fidelity embeddings: OpenAI `text-embedding-3-small`.

### Automation Service

Location: `services/automation`

Stack:

- Go module currently declares Go 1.25.0.
- Asynq.
- Redis/Valkey.
- Postgres state store.
- Listmonk transactional HTTP API.

Node semantics:

| Node         | Behavior                                    |
| ------------ | ------------------------------------------- |
| Trigger      | Start an automation for a subscriber.       |
| Wait         | Schedule successor with delayed queue.      |
| Send email   | Call Listmonk transactional API.            |
| Branch       | Evaluate subscriber attributes and route.   |
| Action       | Add/remove tags, move list, unsubscribe.    |
| Pause/resume | Re-enqueue paused executions until resumed. |

Durability:

- Execution IDs are deterministic.
- Redis delayed tasks survive process restart.
- Postgres tracks execution state.
- Asynq handles task queueing and worker lifecycle.

### Listmonk Engine

Location: standalone container, `engine/` boundary

Purpose:

- Subscriber engine.
- List engine.
- Campaign engine.
- Transactional email API.
- Core sending workflow.

Rules:

- Moosewave never imports Listmonk Go packages.
- Moosewave talks to Listmonk over HTTP only.
- Listmonk is AGPL and may be upstream image or a public fork when patches are needed.
- The Listmonk admin interface should not be public in production.

## Data Stores

### Postgres

Local image: `postgres:16-alpine`

Production target: Amazon RDS for PostgreSQL.

Role:

- Primary application database.
- Multi-tenant RLS enforcement.
- Migration jobs and sessions.
- Voice profiles and sequences.
- Automation state.
- Subscriber and campaign mirrors.
- Outbox events.
- Webhooks and webhook deliveries.
- Billing and plan state.
- Audit log.
- Forms and submissions.
- Sending state and warmup counters.

RLS posture:

- Business tables carry `tenant_id`.
- Policies bind to `current_setting('app.tenant_id', true)`.
- Many tenant tables enable row-level security today; high-risk compatibility, migration, and commerce tables also use `FORCE ROW LEVEL SECURITY`.
- Before a public production launch, run a full RLS audit and either enforce `FORCE ROW LEVEL SECURITY` consistently or document the intentional exceptions.
- Workers that need cross-tenant reads should re-bind tenant context before writes.

### Redis / Valkey

Local image: `redis:7-alpine`

Production target: Amazon ElastiCache for Valkey.

Role:

- Automation delayed jobs.
- Asynq queues.
- Future cache target for render previews and short-lived service cache.

### Listmonk Database

Local:

- Same local Postgres container provisions a separate `listmonk` database and role.

Production:

- Same RDS instance can host separate Moosewave and Listmonk databases initially.
- Separate roles should be used.
- Separate RDS instance is only needed if load, isolation, or restore requirements justify it.

### Object Storage

Production target:

- S3 for uploads, exports, imports, migration artifacts, backups, and public assets.
- CloudFront optional for static/media delivery.

Cost controls:

- Lifecycle rules for temporary migration artifacts.
- Expiry for exports.
- Separate prefixes by environment and tenant.
- Avoid logging request bodies.

## Local Docker Stack

Command:

```text
docker compose -f infra/docker-compose.yml -f infra/docker-compose.full.yml up -d --build
```

Services:

| Service        |         Local Port | Image/Build                                               |
| -------------- | -----------------: | --------------------------------------------------------- |
| Web            |             `3000` | `apps/web/Dockerfile`                                     |
| API            |             `8080` | `Dockerfile.go`, `SERVICE_PATH=./apps/api`                |
| Migration      |             `8081` | `Dockerfile.go`, `SERVICE_PATH=./services/migration`      |
| Deliverability |             `8082` | `Dockerfile.go`, `SERVICE_PATH=./services/deliverability` |
| Voice          |             `8083` | `Dockerfile.go`, `SERVICE_PATH=./services/voice`          |
| Automation     |             `8084` | `Dockerfile.go`, `SERVICE_PATH=./services/automation`     |
| Listmonk       |             `9000` | `listmonk/listmonk:v6.1.0` by default                     |
| Postgres       | `5432` or override | `postgres:16-alpine`                                      |
| Redis          | `6379` or override | `redis:7-alpine`                                          |

Local-only toggles:

| Variable                                 | Purpose                      |
| ---------------------------------------- | ---------------------------- |
| `POSTWAVE_LOCAL_AUTH_BYPASS=1`           | Local web auth bypass.       |
| `POSTWAVE_DEV_TENANT_SLUG_HEADER=1`      | Allow dev tenant header.     |
| `POSTWAVE_DEV_ADMIN_ROLE_HEADER=1`       | Allow dev admin role header. |
| `POSTWAVE_DEV_LISTMONK_WEBHOOK_BYPASS=1` | Local webhook bypass.        |
| `POSTWAVE_DEV_SHOPIFY_WEBHOOK_BYPASS=1`  | Local webhook bypass.        |
| `POSTWAVE_MIGRATION_DEMO_MODE=1`         | Local/demo migration mode.   |

Production rule:

- All local bypass flags must be disabled in AWS or any customer-facing deployment.

## AWS Target Stack

The AWS-first target stack is:

| Layer              | AWS Service                                          |
| ------------------ | ---------------------------------------------------- |
| Containers         | ECS on Fargate, ARM/Graviton where images support it |
| Images             | ECR                                                  |
| Public ingress     | Application Load Balancer plus ACM TLS               |
| Internal discovery | ECS Service Connect or Cloud Map service discovery   |
| Database           | RDS PostgreSQL                                       |
| Cache/queue        | ElastiCache Valkey                                   |
| Sending            | SES, or BYO/customer sender for beta                 |
| Artifacts/uploads  | S3                                                   |
| Edge/static        | CloudFront when useful                               |
| Secrets            | Secrets Manager                                      |
| Encryption         | KMS customer-managed keys where needed               |
| Logs/metrics       | CloudWatch Logs, metrics, alarms, dashboards         |
| DNS                | Route 53 if AWS manages zone                         |
| Web security       | WAF when public traffic/abuse justifies it           |
| Budgets            | AWS Budgets and Cost Anomaly Detection               |

Initial AWS service split:

| Service        |     Beta Count | Production Count |
| -------------- | -------------: | ---------------: |
| Web            |              1 |                2 |
| API            |              1 |                2 |
| Listmonk       |              1 |                1 |
| Migration      | 1 or on-demand |                1 |
| Deliverability |              1 |                1 |
| Voice          |              1 |                1 |
| Automation     |              1 |                1 |

Initial Fargate sizing:

| Service        |    Beta CPU/Memory |         Production CPU/Memory |
| -------------- | -----------------: | ----------------------------: |
| Web            |    0.5 vCPU / 1 GB |    0.5 vCPU / 1 GB, two tasks |
| API            |    0.5 vCPU / 1 GB |    0.5 vCPU / 1 GB, two tasks |
| Listmonk       |    0.5 vCPU / 1 GB | 1 vCPU / 2 GB if volume grows |
| Migration      | 0.25 vCPU / 0.5 GB |      0.25-0.5 vCPU / 0.5-1 GB |
| Deliverability | 0.25 vCPU / 0.5 GB |      0.25-0.5 vCPU / 0.5-1 GB |
| Voice          | 0.25 vCPU / 0.5 GB |      0.25-0.5 vCPU / 0.5-1 GB |
| Automation     | 0.25 vCPU / 0.5 GB |      0.25-0.5 vCPU / 0.5-1 GB |

## AI And External Services

| Service                      | Used By                  | Purpose                                                                                                                                                                                                                                                                                        | Required For Production?         |
| ---------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Gemini API                   | Voice and deliverability | Sequence generation, voice profile analysis, Diagnostician, optional predictor blend                                                                                                                                                                                                           | Yes for AI features              |
| OpenAI API                   | Voice                    | `text-embedding-3-small` fidelity scoring                                                                                                                                                                                                                                                      | Yes for full fidelity scoring    |
| HTMLCSStoImage               | Deliverability           | Cross-client email render previews                                                                                                                                                                                                                                                             | Yes for real preview screenshots |
| Stripe                       | API gateway              | Billing, checkout, portal, webhooks, paid subscription state                                                                                                                                                                                                                                   | Yes for paid SaaS                |
| SES or BYO sender            | Sending/Listmonk         | Outbound email sending                                                                                                                                                                                                                                                                         | Yes for real email               |
| Twilio, Telnyx, or Bandwidth | API gateway/SMS worker   | Source models and bounded tenant-bound presentation only. Hosted dispatch, A2P submit/poll, callbacks/clicks, financial/MMS evidence, and outbound auto-replies are structurally release-held. Canonical AWS supplies no process-global provider credentials; tenant-owned vault/account resolution is still required. | **No — SMS HOLD / NO-GO** |
| Google Postmaster Tools      | Deliverability           | Reputation source                                                                                                                                                                                                                                                                              | Optional but valuable            |
| Microsoft SNDS               | Deliverability           | Reputation source                                                                                                                                                                                                                                                                              | Optional but valuable            |
| Validity SenderScore         | Deliverability           | Reputation source                                                                                                                                                                                                                                                                              | Optional but valuable            |
| Sentry                       | Web/API                  | Error reporting                                                                                                                                                                                                                                                                                | Recommended                      |
| PostHog                      | Web                      | Product analytics                                                                                                                                                                                                                                                                              | Recommended                      |

Repository note:

- Some older docs mention Anthropic. Current service READMEs show Gemini as the active production AI dependency, with `ANTHROPIC_API_KEY` accepted temporarily as a legacy fallback.

## Client And Agent Surfaces

| Surface            | Location                           | Audience                              |
| ------------------ | ---------------------------------- | ------------------------------------- |
| Web dashboard      | `apps/web`                         | Human operators and customers         |
| Mobile app         | `apps/mobile`                      | Operators on iOS/Android              |
| Desktop app        | `apps/desktop`                     | Desktop users, hosted dashboard shell |
| REST API           | `apps/api` plus `packages/openapi` | Integrations and first-party clients  |
| TypeScript SDK     | `packages/sdk-ts`                  | Developers                            |
| Python SDK         | `packages/sdk-py`                  | Developers                            |
| MCP server         | `packages/mcp-server`              | AI agents and IDE agents              |
| CLI                | `packages/cli`                     | Terminal users                        |
| Zapier             | `packages/zapier`                  | No-code automations                   |
| Claude Code plugin | `packages/claude-code-plugin`      | Claude Code workflows                 |
| VS Code extension  | `packages/vscode-extension`        | IDE workflow                          |

MCP is a broad 100+ tool agent surface. The current source tree contains 133 registered tool definitions under `packages/mcp-server/src/tools`; package metadata says 129 tools, while older README prose still says 53. Reconcile those published counts before release, but for architecture/economics decisions treat MCP as a large first-party integration surface rather than a small demo wrapper.

## Security Model

Important controls already represented in the architecture:

- Tenant isolation through Postgres RLS.
- API key auth with hashed-at-rest keys.
- Cookie/session auth for web/mobile flows.
- TOTP/MFA support in auth flow.
- Local-only bypasses gated by explicit env vars.
- Internal service calls protected by `POSTWAVE_INTERNAL_API_TOKEN`.
- HMAC webhook signatures for outbound webhooks.
- Stripe webhook signature verification.
- Transactional outbox for reliable side effects.
- Idempotency for unsafe operations where relevant.
- Source migration sessions encrypted at rest.
- Sender credentials encrypted before persistence.
- SSRF guards in public/agent-facing URL handling.
- reCAPTCHA and honeypot support for public forms.
- Public form rate limits.
- Listmonk admin not exposed publicly in production.

Production hard requirements:

- Disable local bypasses.
- Store secrets in Secrets Manager or equivalent.
- Rotate API keys and webhook secrets.
- Enforce HTTPS only.
- Apply CloudWatch alarm coverage before public traffic.
- Set AWS Budgets before any AWS deployment.
- Use WAF/rate limiting once sign-up/forms are public.
- Review logs for PII leakage and body logging.

## Observability And Operations

Current and planned operations surfaces:

- `/api/health` for API health.
- Downstream health checks for sidecar services.
- Listmonk health probe.
- CloudWatch Logs target in AWS.
- Status page backend.
- Service health rollups.
- Runbooks under `docs/runbooks`.
- Disaster recovery doc.
- Backup verification scripts.
- Scale-test harness under `scripts/scale-test`.
- Playwright smoke/e2e tests.
- Go tests for services.
- Vitest for web package.
- TypeScript typechecking through Turbo.

Minimum production observability:

- Per-service log groups.
- 14-30 day log retention for beta.
- Error-rate alarms.
- ECS restart alarms.
- RDS CPU/storage/connections alarms.
- Valkey memory/eviction alarms.
- ALB 5xx alarms.
- SES bounce/complaint alarms.
- Budget and anomaly alerts.

## Testing Stack

| Test Layer                 | Tooling                                      |
| -------------------------- | -------------------------------------------- |
| Go unit/integration        | `go test ./...` in apps/services/packages    |
| Web unit                   | Vitest                                       |
| Web/browser                | Playwright                                   |
| E2E                        | `tests/e2e` Go module and Playwright suites  |
| Migrations live validation | `pnpm test:migrations:live`                  |
| Scale/load                 | k6 and Go harness under `scripts/scale-test` |
| Production readiness       | `pnpm audit:prod`                            |
| JS audit                   | `pnpm audit:js`                              |

Local tests should avoid real external network calls unless explicit live credentials are set.

## License And Boundary Model

Per [LICENSE-BOUNDARY.md](../LICENSE-BOUNDARY.md):

| Layer              | Path                           | License                                  |
| ------------------ | ------------------------------ | ---------------------------------------- |
| Engine             | `engine/`                      | AGPL-3.0 Listmonk boundary               |
| Public packages    | `packages/*`                   | MIT                                      |
| Application        | `apps/`, `services/`, `infra/` | AGPL-3.0-only source; no supported distribution implied |
| Proprietary assets | `proprietary/`                 | Closed                                   |

Hard rules:

- Do not import Listmonk packages in Moosewave app/service/package code.
- Use HTTP for Listmonk interaction.
- Do not embed proprietary assets into AGPL or MIT code.
- Packages must not import from apps or services.
- AI assets are runtime-loaded or stubbed, not bundled into public artifacts.

## Major Technical Tradeoffs

| Choice             | Why It Exists                                        | Cost                                             |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------ |
| Listmonk over HTTP | Mature email engine without rewriting core sending   | Need HTTP translation and mirror tables          |
| Go services        | Efficient always-on services, simple static binaries | More service boundaries to operate               |
| Next.js dashboard  | Fast product/UI iteration                            | Separate web runtime and Node dependency surface |
| Postgres RLS       | Strong tenant safety                                 | Requires disciplined transaction binding         |
| Redis/Asynq        | Durable delayed workflows                            | Another stateful service                         |
| ECS Fargate        | Managed containers without EC2 ops                   | Higher floor than one VPS                        |
| RDS                | Managed backups and operations                       | More expensive than self-hosted Postgres         |
| SES                | Lowest sending cost at scale                         | Deliverability setup and sandbox approval burden |
| Gemini/OpenAI/HCTI | Differentiated AI and rendering features             | Must be metered by plan                          |
| MCP/SDK/OpenAPI    | Agent-first and integration-friendly                 | More surfaces to keep in sync                    |

## Decision Guidance

Use local Docker when:

- Testing features.
- Running internal demos.
- Debugging migrations.
- Auditing UI/UX.
- No public webhooks or real users are needed.

Use lean AWS beta when:

- External testers need public access.
- Stripe/SES/OAuth callbacks must be reachable.
- 5-10 users are ready to pay.
- Spend is capped and reliability expectations are beta-grade.

Use small production when:

- Public self-serve launch is happening.
- There are 20-30 committed customers at $20, or fewer at higher ARPA.
- Web/API need at least two tasks.
- Managed backups, TLS, DNS, and observability are required.

Use HA production when:

- 50+ paying customers exist.
- A customer requires SLA.
- The revenue protected by reliability exceeds the extra $350-$800/month.
- Operational maturity is in place.
