# Substack Migration Source

Status: Migration-only adapter with delegated native-foundation handoff support.

Substack also has a separate `substack` native-foundation row for provider lifecycle, run history, and delegated handoff evidence. This `substack-migration` tile remains the cutover surface for the official export ZIP or subscriber CSV, post archive, optional aggregate archive stats, and explicit billing/consent parity evidence.

## Coverage

The migration adapter imports a de-duplicated subscriber snapshot, source status and tier provenance, post/campaign archive rows joined to official HTML fragments, optional aggregate stats, and a durable export/checklist archive. Signup dates are not consent timestamps; source-active rows remain unconfirmed pending reviewed destination permission. Paid/founding/gift/comp tiers remain membership metadata and no live Stripe or Apple subscription is imported or mutated.

## Boundaries

No native Substack webhooks, source-event polling, writeback, provider cleanup automation, ongoing provider API sync, or automatic billing/entitlement continuity is claimed by this tile.
