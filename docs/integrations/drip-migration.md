# Drip Migration Source

Status: Migration-only adapter with delegated native-foundation handoff support.

Drip also has a separate `drip` native-foundation row for provider lifecycle and run evidence. This `drip-migration` tile remains the CSV export migration surface.

## Coverage

The migration adapter imports Drip people CSV exports into Moosewave profiles and tag/list evidence through the shared resumable export importer.

## Boundaries

This tile does not claim Drip API import, native webhooks, source-event polling, writeback, or provider-side cleanup automation.
