# AWeber Migration Source

Status: Migration-only adapter with delegated native-foundation handoff support.

AWeber also has a separate `aweber` native-foundation row for provider lifecycle and run evidence. This `aweber-migration` tile remains the CSV export migration surface.

## Coverage

The migration adapter imports AWeber subscriber CSV exports into Moosewave profiles and list evidence through the shared resumable export importer.

## Boundaries

This tile does not claim AWeber OAuth/API import, native webhooks, source-event polling, writeback, or provider-side cleanup automation.
