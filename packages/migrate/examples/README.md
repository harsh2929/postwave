# Examples

Each subdirectory is a standalone Go program demonstrating one use of `github.com/postwave/migrate`. They are illustrative only and intentionally minimal — you can copy any of them and adapt to your own pipeline.

## Programs

| Path | What it does | Required env |
|---|---|---|
| `mailchimp_export/` | Reads up to 100 subscribers from a Mailchimp account and prints them as canonical JSON. | `MAILCHIMP_OAUTH_TOKEN`, `MAILCHIMP_DC` |
| `csv_universal/` | Runs the heuristic CSV importer on any file, prints the detected column mapping plus the first ten subscribers. | `CSV_PATH` |
| `migrate_to_listmonk/` | Reads from any source via env-selected adapter and writes to a self-hosted Listmonk instance over HTTP. Demonstrates the destination side without depending on Moosewave Cloud. | varies |

## Run

```bash
cd examples/mailchimp_export
go run .
```

Each example has a short comment block at the top with the variables it expects.

## License

These examples are MIT-licensed, same as the rest of the module.
