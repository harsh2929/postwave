# Migration operator playbook

This playbook covers the source-adapter and hosted migration lifecycle. `packages/migrate` normalizes provider data; `services/migration` owns tenant-scoped jobs, encrypted sessions, dry-run/commit orchestration, destination writes, verification, and rollback.

Runtime adapter capabilities from `GET /api/v1/migrations/sources` are authoritative. Do not infer authentication or coverage from an old client build or this document alone.

## Mailchimp runbook

### 1. Prepare an isolated destination

For certification, use a dedicated tenant plus isolated Postgres/Listmonk resources. Record baseline subscriber, list/tag, template, segment, automation, and archive state so commit and rollback can be reconciled.

Shared Listmonk mode is fail-closed, not a live-commit target. A Mailchimp commit is accepted only when `LISTMONK_TENANT_MODE=dedicated` and `LISTMONK_DEDICATED_TENANT_ID` exactly equals the authenticated migration tenant ID. Independent tenants can coexist with the same email only through correctly routed tenant-dedicated Listmonk deployments.

### 2. Connect with OAuth

Start `POST /api/v1/migrations/mailchimp/oauth/start`, open the returned authorization URL, and complete the callback. Customer-facing Mailchimp migration does not use pasted Mailchimp credentials.

Mailchimp OAuth follows the approving user's role and does not present a granular migration-scope picker. Use a user that can read all intended audiences and account-wide archive surfaces. Retain the returned `job_id`.

### 3. Discover and select audiences

Call:

```http
POST /api/v1/migrations/mailchimp/discover
Content-Type: application/json

{"job_id":"<job_id>"}
```

Review `warnings` and every audience in the response. Choose one or more IDs explicitly, then repeat scoped discovery with:

```json
{
  "job_id": "<job_id>",
  "selected_audience_ids": ["<audience_id>"]
}
```

The selection scopes audience-bound members and merge data, groups/interests, segments, signup-form and audience-schema evidence, list-triggered Classic Automations, campaigns, and reports. Templates, landing pages, and ecommerce evidence are account-wide; other source-archive guidance is account-global or non-detected. The dry-run must label every such surface before approval.

Do not interpret a zero count as an empty source when the corresponding discovery call warned or failed.

### 4. Dry-run the exact scope

Send the same body to `POST /api/v1/migrations/mailchimp/dry-run`. Poll `GET /api/v1/migrations/{job_id}` or consume `/events` until the job returns to `awaiting_confirmation` with a report.

Review:

- source totals versus report and progress totals;
- consent-known/unknown and suppression counts;
- duplicate subscriber merges and field conflicts;
- saved-segment warnings;
- Classic Automation imports and Customer Journey manual-review gaps;
- template, campaign archive, and source archive warnings;
- every resource-completeness row.

Dry-run translation counts are not proof of targeting equivalence. Test representative segment membership and ensure automation template references resolve.

### 5. Commit the same scope

Send the identical `job_id` and `selected_audience_ids` to `POST /api/v1/migrations/mailchimp/commit`. Watch all progress families: subscribers, segments, automations, paid subscriptions, archive, templates, and source archive.

The currently validated Classic `welcomeSeries` subset becomes executable Moosewave runtime records but remains paused until reviewed and activated. Other Classic workflows remain source-archive/manual-review evidence because their semantics cannot be represented safely. The Marketing API cannot list or export Customer Journey / Automation Flow graphs, so its single generic, non-detected gap is not an inventory; operators must inventory Journeys in Mailchimp and attach rebuild or waiver evidence.

### 6. Destination verification

Verify through normal Moosewave product paths, not only the migration report:

1. subscribers and list/audience membership are tenant-visible;
2. consent, suppression, tags, and custom fields match sampled source contacts;
3. static and saved segments include expected sample subscribers;
4. templates render with destination IDs;
5. paused Classic Automation runtime records reference the intended templates;
6. archive and rebuild-review evidence is accessible and correctly labeled.

### 7. Rollback rehearsal and cleanup

During the displayed window, start `POST /api/v1/migrations/{job_id}/rollback` and poll `/rollback-status`. Before mutation, rollback verifies the exact recorded after-image and ownership of every tracked resource. Any later edit, ownership change, missing proof, or ambiguity stops the whole rollback with a conflict. The write ledger then removes resources created by the job and restores before-images for pre-existing records updated by the job. It must never delete a pre-existing destination subscriber merely because commit upserted it.

Failed or operator-cancelled commits with tracked partial writes can also be eligible for rollback inside the window. Rollback does not change Mailchimp, DNS, sends, or external billing. Append-only consent/audit history remains with compensating rollback evidence. After certification, revoke the Mailchimp app if no further source access is needed.

## Failure handling

- **OAuth rejected or revoked:** reconnect the same job with `POST /api/v1/migrations/mailchimp/oauth/start?job_id={job_id}` and complete the callback. Confirm it returns the same job ID.
- **HTTP 429:** Mailchimp limits simultaneously processing requests. The hosted job pauses according to `Retry-After` when present. Do not describe this as a calls-per-second quota.
- **Truncation warning:** stop cutover. Every paginated resource must reach its terminal cursor or report an explicit incomplete collection.
- **Saved-segment warning:** compare the source predicate with fields actually present on destination subscribers. Leave unsupported behavior as manual rebuild work.
- **Customer Journey found:** retain evidence and rebuild manually; do not create or activate a guessed graph.
- **Rollback failure:** preserve the job ID, rollback-status body, and destination baseline. Do not perform ad-hoc deletes that bypass tenant scope or destroy before-images.

## Live certification gates

Mailchimp is not self-serve certified until real OAuth proves:

- shared-mode live-commit rejection without mutation, exact dedicated-tenant ID matching, and dedicated-mode same-email coexistence;
- safe update and rollback of a pre-existing destination subscriber;
- pagination beyond 1,000 records and more than 10 Classic Automation emails;
- scoped-discovery preview labeling, authoritative dry-run scope persistence, exact dry-run-to-commit audience-scope equality, and account-global surfaces labeled before approval;
- same-job OAuth reconnect and revoked-session behavior;
- idempotent retry/resume without duplicate templates or inflated progress;
- destination visibility and rollback reconciliation across every supported resource.

## Other sources

For non-Mailchimp adapters, use the runtime `auth_method`, source-specific guide, and verification completeness states. API-key, OAuth, and file-upload flows are not interchangeable. Controlled-cutover sources such as ActiveCampaign and HubSpot add their own source-event, final-delta, shadow-check, acceptance, and credential-cleanup gates.

## Adding an adapter

1. Add `packages/migrate/<source>` and implement `adapter.Adapter`.
2. Register the canonical source and advertise truthful capabilities, including `automation_mode`.
3. Implement cursor-based pagination or explicit bounded-collection warnings for every resource.
4. Add mapper, pagination, error, idempotency, and end-to-end tests.
5. Add tenant-scoped destination and rollback certification before advertising hosted commit support.
