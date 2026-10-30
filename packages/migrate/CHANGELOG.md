# Changelog

All notable changes to `github.com/postwave/migrate` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v0.1.0] — 2026-XX-XX (planned)

### Added

- Canonical schema (`canonical` package): `Subscriber`, `Segment`, `SegmentNode` AST, `Automation`, `AutomationNode`, `AutomationEdge`, `PaidSub`, `CampaignArchive`, `MigrationJob`, `VerificationReport`, `AdapterCapabilities`.
- Adapter framework (`adapter` package): `Adapter` interface, `Registry`, `Credentials`, `Session`, `DiscoveryReport`, typed errors, token-bucket rate limiter.
- Mailchimp adapter: OAuth2, complete paginated audience-member and sent-campaign archive reads, supported segment translation, and a validated Classic `welcomeSeries` automation subset. Other Classic workflows and Customer Journeys remain explicit manual-review gaps.
- ConvertKit (Kit) adapter: OAuth2, full surface; paid-subs flagged for Stripe Connect path.
- Substack adapter: safe official ZIP/CSV ingestion, subscriber/status/tier provenance, post metadata-to-HTML archive joining, aggregate delivery/open evidence, and explicit consent/billing/ecosystem parity records. Live paid-subscription mutation is not claimed.
- Beehiiv adapter: API-key auth, full surface including premium subscribers.
- MailerLite adapter: API-key auth, cursor pagination, workflows as automations.
- CSV universal importer with heuristic column detection.
- Examples: standalone Go programs for each adapter under `examples/`.

[Unreleased]: https://github.com/postwave/migrate/compare/v0.1.0...HEAD
[v0.1.0]: https://github.com/postwave/migrate/releases/tag/v0.1.0
