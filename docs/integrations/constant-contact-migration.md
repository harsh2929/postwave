# Constant Contact Migration Source

Status: Migration-only adapter with delegated native-foundation handoff support.

Constant Contact also has a separate `constant-contact` native-foundation row for provider lifecycle and run evidence. This `constant-contact-migration` tile remains the CSV export migration surface.

## Coverage

The migration adapter imports Constant Contact contact CSV exports into Moosewave profiles and list evidence through the shared resumable export importer.

## Boundaries

This tile does not claim Constant Contact OAuth/API import, native webhooks, source-event polling, writeback, or provider-side cleanup automation.
