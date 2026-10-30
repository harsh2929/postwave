# Sendy Migration Source

Status: Migration-only adapter with delegated native-foundation handoff support.

Sendy also has a separate `sendy` native-foundation row for provider lifecycle and delegated handoff evidence. This `sendy-migration` tile remains the CSV export migration surface.

## Coverage

The migration adapter imports Sendy subscriber CSV exports, consent state, list evidence, and source identifiers through the resumable CSV importer.

## Boundaries

This tile does not claim complete Sendy API export, native webhooks, source-event polling, writeback, or provider-side cleanup automation.
