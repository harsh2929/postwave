# ActiveCampaign Native Foundation

Status: Native / partial. The delegated migration path is implemented locally;
representative-account live certification is still pending.

Moosewave exposes `activecampaign` as a native marketing provider row while preserving the migration cutover tile as `activecampaign-migration`. The native row owns credential-reference setup, required account API URL capture, row-preserving pause/disconnect, provider-cleanup guidance, `marketing_sync_runs`, and `activecampaign_handoff` delegated cursor evidence. API v3 contact/list/tag/campaign import, automation source-definition preservation, rebuild-evidence archive, and changed-contact source-event polling still delegate to the migration adapter until native webhooks, writeback, cleanup automation, OAuth/public app install, and live account certification land.

## Current Surface

- Catalog slug: `activecampaign`
- Migration slug: `activecampaign-migration`
- Setup API: `/api/v1/marketing-integrations`
- Required settings: `credentials_ref`, `api_url`
- Optional settings: `account_id`, `migration_job_id`, `source_event_job_id`, `source_event_cursor`, `source_event_high_watermark`, `poll_interval_seconds`
- Delegated data plane: `activecampaign_migration_api_v3_source_events`

## Delegated Coverage

The delegated adapter imports email-addressable contacts, tags, list-backed segments, and completed campaign history where the ActiveCampaign account exposes them. Active membership in a known email list is preserved as the list segment's targeting tag independently of sendability, so the migrated segment is not silently empty; a non-active or conflicting status on that same list suppresses its tag. Contacts are still fail-closed: incomplete email-channel/exclusion evidence stays unconfirmed, list status and `sdate` are provenance rather than channel-specific consent proof, SMS-only membership cannot grant email sendability, and email-less/phone-only contacts are preserved for review rather than given fabricated email identities. ActiveCampaign can keep an address active on a list while excluding it separately, and API v3 does not expose a documented complete exclusion inventory, so the operator must reconcile exclusions and remove any affected targeting tags before activation.

Saved-segment summaries are read from `/audiences` and hydrated from `/segmentsV2/{id}`; raw predicates remain rebuild-only unless safely translatable. Sent campaigns are hydrated from campaign detail and linked message HTML/text. Automation summaries plus available blocks, goals, linked campaigns, and SMS relationships are preserved as rebuild definitions, never as live Moosewave automations. Message/template records, forms, deals, pipelines, available custom-object schemas and records, ecommerce connections/customers/orders/per-order products, and `/sms/broadcasts` inventory are read-only source archive evidence. SMS broadcasts are not imported as sendable campaigns. Custom-object relationship completeness, ecommerce catalogs/abandoned carts, and executable commerce triggers are not claimed and still require explicit parity review.

Base contacts use ascending ID pagination. Changed-contact replay fixes a lower
and upper update-time bound, drains that immutable window in ascending contact
ID order, and advances the durable high-water mark to the fixed upper bound
only after every page completes. ActiveCampaign documents `updated_after` and
`updated_before` as date values, so the adapter widens those provider-side UTC
date bounds and then filters every hydrated contact against the exact inclusive
timestamp window; conservative false positives advance the ID cursor but never
become events. Its resumable cursor is bound to the verified provider account
and carries the window bounds plus the last contact ID; it does not rely on
mutable update-time ordering or offset pagination. Native
`/sync` and `/backfill` record partial provider-row runs and return
`activecampaign_handoff:` cursor evidence for the delegated adapter.

Credential URLs use HTTPS/443 and `/api/3`. One-label account hosts under `api-us1.com` or `activehosted.com` are accepted by default; a deployment operator may authorize a different provider-issued Developer-tab hostname through the comma-separated `ACTIVECAMPAIGN_ALLOWED_API_HOSTS` exact-host allowlist. Entries cannot contain a scheme, port, path, wildcard, IP, localhost, or empty item, and unconfigured hosts remain rejected. `/users/me` establishes the account binding used by dry-run, reconnect, commit, shadow, delta, and source-event work. Built-in provider aliases share a fingerprint and limiter, while a configured custom hostname uses its exact canonical host for both identities.

Each owning migration-service process applies a five-request-per-second
limiter with burst capacity one for the normalized account, including supported
provider hostname aliases. Credential-bearing operations also acquire the
account-fingerprint execution lease across tenants, jobs, and production
replicas, then retain it for a conservative 200 ms request interval before
handoff. That interval prevents a newly owning replica's fresh in-memory bucket
from firing immediately behind the prior operation. Provider `429` responses
and retry guidance remain authoritative across the deployment.

## Cutover and Certification

An ActiveCampaign list status or list subscription date is not sufficient
cutover evidence. ActiveCampaign documents that an address can remain active
on a list while also appearing on an exclusion list, and API v3 does not expose
a documented complete exclusion-list read contract. The adapter therefore
keeps incomplete channel/exclusion evidence unconfirmed. It does not infer
email consent from SMS membership, and it archives phone-only contacts for
manual review.

Strict pilot certification requires the operator to complete the final delta,
reconcile email and SMS consent by channel, review ActiveCampaign exclusions
and email-less contacts, reconcile the previously imported source-ID-to-email
mapping and source-owned tag/list mapping against a reviewed final source
export/audit, disable destination identities whose source contact was removed
or whose prior email became stale, require exactly one current identity per
source ID, remove exclusion-covered targeting tags, and then record
`activecampaign_consent_exclusion_review` through the allow-listed cutover
evidence API. The live harness requires
`ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_REVIEW=1` together with a non-secret
`ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_EVIDENCE_REF`. That marker records a
human-reviewed artifact; it is not evidence that Moosewave read every exclusion
through the provider API.

Changed-contact polling is deliberately not presented as deletion detection.
A contact that is hard-deleted in ActiveCampaign may not appear in the changed
contact feed, and equal aggregate counts can hide a deletion behind a new
contact. The final shadow check blocks on a lower email-addressable inventory,
but the mandatory source-ID reconciliation remains the cutover control even
when counts match. A changed contact is replayed at its current email, but this
adapter does not automatically retire a prior destination email for the same
source ID; the same mandatory mapping review contains that boundary. For a
returned same-source contact, current tags, list-targeting tags, and custom
fields replace the prior provider-owned snapshot while local/different-source
data remains intact.

Source-event replay preserves phone-only/email-less contact changes as
intentionally unapplied `manual_review` rows. Pilot acceptance blocks until
each immutable result has reconciliation detail and a non-secret evidence
reference recorded through
`PATCH /api/v1/migrations/{job_id}/source-events/{event_id}/review`. Review
state is separate from `applied`, so Moosewave never claims that a phone-only
event became an email subscriber. Automatic subscriber replay failures cannot
be waived through this workflow; they must be fixed and replayed. A later
source mutation creates a new pending row, preventing stale review evidence
from clearing new work.

The repository has fixture, contract, and harness coverage for this path, but
it does not contain a successful credentialed run against a representative
ActiveCampaign account. Until that evidence is produced, automations remain
non-executable rebuild definitions, SMS/custom-object/ecommerce/CRM surfaces
remain read-only archive evidence, and the integration must stay partial and
conditional rather than production-certified.

## Disconnect

`DELETE /api/v1/marketing-integrations/{id}` marks the provider row disconnected, rejects further native sync/backfill, preserves run/source-event evidence, and stores operator cleanup guidance. API-token revocation, app cleanup, webhook cleanup, writeback cleanup, and duplicate account connection audits remain ActiveCampaign account actions. Strict migration live certification separately records channel-consent/exclusion reconciliation with `ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_REVIEW=1` plus a non-secret evidence reference, and records operator-held API-token/user reset evidence through `ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_REVIEW=1` plus `ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF`; both are proof capture, not automated provider cleanup.

## Promotion Blockers

- Certify OAuth/public app install or a provider-approved API-token lifecycle.
- Add native webhook subscription and verification.
- Add and live-certify native contact-deletion/email-change events or an automatic full-scan stale-source-ID/email-identity reconciliation path.
- Move delegated source-event polling into an active provider-row scheduler.
- Add writeback, managed cleanup automation, and live disconnect evidence.
- Live-certify channel-consent/exclusion and source-contact identity reconciliation, including phone-only review evidence.
- Live-certify API URL normalization, pagination, rate limits, reconnect, disconnect, and data-delete behavior.

## Provider Contract References

- [API authentication and account URL](https://developers.activecampaign.com/reference/authentication)
- [Contact filtering and ID pagination](https://developers.activecampaign.com/reference/list-all-contacts)
- [Saved-segment summaries](https://developers.activecampaign.com/reference/get_saved_segment_summaries) and [segment definitions](https://developers.activecampaign.com/reference/retrieve_segment)
- [Campaign detail](https://developers.activecampaign.com/reference/retrieve-a-campaign) and [message content](https://developers.activecampaign.com/reference/retrieve-a-message)
- [Automation inventory](https://developers.activecampaign.com/reference/list-all-automations)
- [SMS broadcast inventory](https://developers.activecampaign.com/reference/listbroadcasts)
- [Exclusion-list behavior](https://help.activecampaign.com/hc/en-us/articles/207362110-Exclusion-list-overview)
