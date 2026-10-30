# MailerLite Migration Source

Status: assisted-beta migration adapter. A representative live MailerLite
workspace rehearsal is still required before GA promotion.

MailerLite also has a separate `mailerlite` native-foundation row for provider
lifecycle and delegated handoff evidence. The `mailerlite-migration` tile is the
Connect API import surface; it is not a native two-way integration.

## Authentication

Generate a dedicated token in MailerLite under **Integrations → MailerLite API →
Generate new token**. Moosewave sends it as `Authorization: Bearer …` to
`https://connect.mailerlite.com/api`.

The adapter validates the token with the documented
`GET /subscribers?limit=0` endpoint. MailerLite does not document `/me` or
another token-to-account identity endpoint, so use a migration-specific token,
freeze the intended account during the final snapshot, and revoke the token
after verification. MailerLite Classic API credentials are not supported.

## Coverage and fidelity

- Subscribers: all cursor pages, with active/unsubscribed/unconfirmed/bounced/
  junk status preserved. Bounced and junk records become blocklisted.
- Consent: `opted_in_at` is the only timestamp promoted to portable opt-in
  evidence. `subscribed_at` is ingestion time and is not treated as consent.
  API/import origin remains provenance; unconfirmed records stay unconfirmed.
  Raw source, opt-in IP, and subscriber lifecycle timestamps are retained in
  namespaced migration fields. An unparseable `opted_in_at` is preserved but is
  never promoted to double-opt-in evidence.
- Fields and groups: custom-field keys, names, and types are inventoried and
  source-preserved, including definitions with no populated value. Subscriber
  values are copied, and reads explicitly request `include=groups`. Group names
  become tags and executable tag-backed Moosewave segments.
- Saved segments: names and counts are preserved for rebuild/review. The
  documented API does not expose their dynamic predicates, so Moosewave does not
  invent executable rules.
- Automations: available trigger and step payloads are retained in the source
  definition as rebuild evidence. Provider-specific graph semantics and
  rendered automation-email bodies are not activated automatically.
- Campaigns and reports: sent, draft, and ready inventories are counted. Sent
  campaigns archive subject, plain text when available, preview reference,
  sent time, aggregate sent/open/click totals, and metadata for every
  API-visible A/B or multivariate email variant. Draft and ready campaign
  metadata is source-preserved for rebuild. The documented campaign read API
  does not expose rendered HTML.
- Forms and ecommerce: popup, embedded, and promotion form metadata plus
  ecommerce shop metadata are retained as source-archive evidence. Capture UI,
  consent settings, embeds, catalogs, customers, purchases, attribution, and
  triggers must be rebuilt or reconnected.
- Sites, landing pages, and reusable templates: the documented Connect API has
  no inventory/read endpoint. A durable manual-review checklist makes this gap
  explicit.

## Operational contract

MailerLite’s documented global limit is 120 requests per minute. The adapter
uses the provider’s cursor pagination for subscribers, page pagination for
groups/segments/automations/campaigns/forms/shops, and surfaces `429
Retry-After` to the job retry path.

Before cutover:

1. Freeze subscriber, field, group, segment, automation, form, and campaign
   changes.
2. Run a fresh dry run and inspect all saved-segment and automation rebuild
   warnings.
3. Confirm subscriber totals, suppressions, custom-field definitions, group-tag
   membership, sent/draft/ready campaign counts, and source-archive counts.
4. Rebuild/test forms, sites, dynamic segments, automations, templates, and
   commerce dependencies or record an explicit retirement decision.
5. Commit the authoritative snapshot, run a controlled test send, retain the
   rollback window, then revoke the MailerLite token.

This tile does not claim native MailerLite webhooks, source-event polling,
writeback, provider-side cleanup automation, automatic final-delta capture, or
live workspace certification.
