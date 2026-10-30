# Migration Fixture Library

These fixtures are sanitized, deterministic samples used to rehearse source
compatibility without touching live customer accounts. They are intentionally
small, but each source includes enough variation to exercise status mapping,
suppression handling, custom fields, tags/groups, consent provenance, and known
adapter gaps.

Rules:

- Fixture email addresses must use reserved example domains.
- Do not commit production exports, screenshots, tokens, cookies, or webhook
  payloads here.
- Every promised import source must appear in `manifest.json` and have at least
  one file on disk.
- When a source cannot expose a Mailchimp-equivalent object, document that in
  `known_gaps` instead of silently omitting it from launch testing.

Run the manifest guard from the repo root:

```sh
go test ./packages/migrate/adapter
```
