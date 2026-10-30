# OpenAPI → TypeScript codegen migration

> Status: Batch 1 shipped. ~40 surfaces deferred.

This doc tracks the migration of every surface in `apps/desktop` away
from the hand-written types in `apps/desktop/src/lib/api-client.ts`
(16 868 LoC at the time of writing) toward generated types sourced
from this package's OpenAPI spec.

## How the pipeline works

```
packages/openapi/surfaces/openapi.yaml  ← source of truth (per surface)
                  │
                  │  pnpm openapi:codegen
                  ▼
packages/openapi/dist/types.ts          ← generated, committed
                  │
                  │  import type { components } from "@postwave/openapi/types"
                  ▼
apps/desktop/src/lib/api-types.ts       ← semantic re-exports
                  │
                  │  import { Subscriber } from "../lib/api-types"
                  ▼
apps/desktop/src/pages/*.tsx            ← call sites
```

### Commands

| Command                              | What it does                                                                |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `pnpm openapi:codegen`               | Regenerate `dist/types.ts` from `surfaces/openapi.yaml`.                    |
| `pnpm openapi:codegen:check`         | CI drift gate — fails if the committed `dist/types.ts` is stale.            |
| `pnpm audit:openapi`                 | Runs `sync-json:check`, `codegen:check`, and the route + subscriber parity. |
| `pnpm --filter @postwave/openapi …` | Lower-level access to the same scripts.                                     |

### CI guardrail

`.github/workflows/ci.yml` → job **openapi-lint** → step **OpenAPI codegen drift check**
runs `node packages/openapi/scripts/codegen.mjs --check`. The job fails when
`surfaces/openapi.yaml` is edited and `dist/types.ts` was not regenerated.

## Batch 1 — shipped

Five surfaces are now sourced from generated types via
`apps/desktop/src/lib/api-types.ts`:

| #   | Surface         | Schemas                                                                                                                            | Paths in `surfaces/openapi.yaml`                                                                       |
| --- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `subscribers`   | `Subscriber`, `SubscriberInput`, `SubscriberPage`, `SubscriberStatus`, `ConsentSource`                                             | `/api/v1/subscribers`, `/api/v1/subscribers/{id}`, `/api/v1/subscribers/search`, `…/suppress`         |
| 2   | `lists`         | `List`, `ListPage`, `ListCreateInput`, `ListUpdateInput`, `ListVisibility`, `ListOptin`                                            | `/api/v1/lists`, `/api/v1/lists/{id}`                                                                  |
| 3   | `campaigns`     | `Campaign`, `CampaignPage`, `CampaignCreateInput`, `CampaignUpdateInput`, `CampaignSendInput`, `CampaignReport`, `CampaignStatus`, `SendTimeStrategy` | `/api/v1/campaigns`, `/api/v1/campaigns/{id}`, `/api/v1/campaigns/{id}/send`, `/api/v1/campaigns/{id}/report` |
| 4   | `archive`       | `ArchiveEntry`, `ArchivePage`, `PublicArchiveIndex`, `PublicArchiveEntry`                                                          | `/api/v1/archive`, `/api/public/archive/{tenant_slug}`, `/api/public/archive/{tenant_slug}/{campaign_slug}` |
| 5   | `send_time_opt` | `SendTimeOptSettings`, `SendTimeOptSettingsInput`, `SendTimeOptHeatmap`, `SendTimeOptHeatmapCell`                                  | `/api/v1/send-time-opt`, `/api/v1/send-time-opt/heatmap`                                               |

> Note: the hand-written types in `api-client.ts` for the five surfaces
> are still in place. The new re-exports in `api-types.ts` shadow them
> by giving call sites a second, opt-in import path. Deleting the
> hand-written types in a single sweep would touch hundreds of files
> and conflict with in-flight work — the per-surface deletion lands
> as the call sites are migrated (see "Cutover sequence" below).

## Backlog — deferred (≈ 40 surfaces)

Each entry is one PR-sized unit of work. Order is loose; pick the
next-cheapest one first.

### Priority A — proxy / list-management surfaces (high call-volume, simple shapes)

- `segments` — `Segment`, `SegmentNode`, `SegmentUpdateInput`. Schemas already exist in parent `openapi.yaml`.
- `tags` — `Tag`, `TagGroup`. (~9 660 in `api-client.ts`.)
- `templates` — `Template`, `TemplateCreateInput`.
- `forms` — `Form`, `FormSubmission`, `FormCreateInput`. Path stubs exist; schemas need extraction.
- `submissions` — public + admin form-submission shapes.
- `assets` — `Asset`, `AssetUploadResponse`, usage referrers.

### Priority B — engagement + lifecycle surfaces

- `automations` — journey trigger / pause / resume / executions.
- `automation_journeys` — `AutomationJourney`, `AutomationJourneyInput`.
- `sequences` (Voice) — generation jobs, regeneration, templates.
- `conversions` — keys + events.
- `topics` — subscribe / unsubscribe per subscriber.
- `paid_members` — `PaidMember`, `PaidMemberInput`.

### Priority C — admin + observability

- `audit` — `AuditEvent`, `AuditRow`, `AuditListResponse`, `AuditCount`, redaction policy. (Largest single block in `api-client.ts`.)
- `dashboard` — `DashboardStatsResponse`, `DashboardPreviousWindow`. (Already partially typed.)
- `approvals` — `ApprovalRow`, `ApprovalDelegation`, `ApprovalEscalationPolicy`.
- `api_keys` — `ApiKeyRow`, `CreateApiKeyResponse`, rotation.
- `webhooks` — outbound webhooks + deliveries + replay.
- `security_settings` — admin tenant settings.

### Priority D — SMS / channels

- `sms_conversations`, `sms_messages`, `sms_campaigns`, `sms_compliance`, `sms_pilot_readiness`. Schemas already exist in parent `openapi.yaml`.

### Priority E — integrations / migrations

- `integrations_slack`, `integrations_discord`, `integrations_teams`.
- `landing_pages`.
- `migrations` (every `/api/v1/migrations/*` route — already has rich schemas in parent spec).
- `mcp` (`MCPExecution`, `MCPStats`, `MCPCatalogEntry`, …).

### Priority F — public + auxiliary

- `inbox_reality`, `predict`, `diagnose`, `render`, `reputation`, `auth_checks`.
- `sending_state`, `sending_warmup`, `sending_controls`, `sending_provision`, `sending_readiness`.
- `dlq`, `archive_views` (already partially covered).
- `compat` (Mailchimp-compat shims).

## Cutover sequence (per surface)

For each surface in the backlog:

1. **Extract** the path operations into `surfaces/openapi.yaml`. Reuse
   schemas from the parent `openapi.yaml` where they exist and are
   trustworthy; otherwise hand-author them against the Go handler
   (`apps/api/internal/<surface>/…`) and add an `x-postwave-source`
   pointer.
2. Run `pnpm openapi:codegen` and commit `dist/types.ts`.
3. Add the named re-exports to `apps/desktop/src/lib/api-types.ts`.
4. Migrate `apps/desktop/src/pages/<Surface>*.tsx` and any
   sub-components to import from `../lib/api-types` instead of
   `../lib/api-client`.
5. Delete the hand-written types from `apps/desktop/src/lib/api-client.ts`
   (function signatures can stay; only the type aliases / interfaces
   move).
6. Verify with `cd apps/desktop && npx tsc -b`. Land the PR.

## Why this shape (FAQ)

**Why a separate `surfaces/openapi.yaml` instead of the parent file?**
The parent `openapi.yaml` is auto-generated by `scripts/regenerate.go`
to keep route parity with the Go gateway. Most of its 380 KB consists
of path stubs without typed schemas, and at least one path has a
broken `$ref` that breaks `openapi-typescript`. A separate curated
file lets us ship real types for the migrated surfaces today without
waiting for the parent to be audited line-by-line. The parent file
remains the source of truth for *route* parity; the surfaces file
is the source of truth for *type* parity.

**Why not delete the hand-written types in `api-client.ts` in one
shot?** That touches hundreds of files across many sub-features and
would conflict with the half-dozen audit / sequences / SMS
work-streams currently in flight. The opt-in shim in `api-types.ts`
gives callers a no-risk migration path; the hand-written types stay
until the matching call sites are migrated.

**Why `openapi-typescript` and not `openapi-fetch` / `kiota` / a
runtime client?** The codegen target is just types — runtime
fetch behavior lives in `api-client.ts` (with offline replay,
idempotency keys, secure-vault credentials, etc.) which we don't
want to throw away. A pure type generator is the smallest possible
shim that gives us drift detection between spec and TypeScript
without disturbing the runtime layer.

**Why pin `openapi-typescript@7.13.0`?** Reproducible builds.
Upgrades are explicit; bump the pin in
`packages/openapi/scripts/codegen.mjs`, run `pnpm openapi:codegen`,
review the diff in `dist/types.ts`, and commit both.
