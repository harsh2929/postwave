# Loops Migration Source

Status: Migration-only adapter with delegated native-foundation handoff support.

Loops also has a separate `loops` native-foundation row for provider lifecycle and run evidence. This `loops-migration` tile remains the CSV export migration surface.

## Coverage

The migration adapter imports Loops contact CSV exports into Moosewave profiles and list evidence through the shared resumable export importer.

## Boundaries

This tile does not claim Loops API import, native webhooks, source-event polling, writeback, or provider-side cleanup automation.
