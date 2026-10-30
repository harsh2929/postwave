# Campaign Monitor Migration Source

Status: Migration-only adapter with delegated native-foundation handoff support.

Campaign Monitor also has a separate `campaign-monitor` native-foundation row for provider lifecycle and run evidence. This `campaign-monitor-migration` tile remains the CSV export migration surface.

## Coverage

The migration adapter imports Campaign Monitor subscriber CSV exports into Moosewave profiles and list evidence through the shared resumable export importer.

## Boundaries

This tile does not claim Campaign Monitor API import, native webhooks, source-event polling, writeback, or provider-side cleanup automation.
