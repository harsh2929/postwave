# Omnisend Migration Source

Status: Migration-only adapter with delegated native-foundation handoff support.

Omnisend also has a separate `omnisend` native-foundation row for provider lifecycle and run evidence. This `omnisend-migration` tile remains the CSV export migration surface.

## Coverage

The migration adapter imports Omnisend contact CSV exports into Moosewave profiles and segment/list evidence through the shared resumable export importer.

## Boundaries

This tile does not claim Omnisend API import, native webhooks, source-event polling, writeback, or provider-side cleanup automation.
