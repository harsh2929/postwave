# Inbound request-body resource policy

Status: enforced in code, CI, and the local prelaunch gate.

This document is the production contract for request-body memory, disk, and
parser cost in the Go API. The canonical implementation is
`apps/api/internal/httpbody`; handlers must not create an independent raw
`json.Decoder`, `io.ReadAll`, or silently truncating `io.LimitReader` over an
HTTP request body.

## Default boundaries

| Boundary                       |  Limit | Enforcement                                                   |
| ------------------------------ | -----: | ------------------------------------------------------------- |
| Ordinary request body          |  8 MiB | Process-wide middleware, including chunked bodies             |
| Ordinary JSON body             |  1 MiB | Route decoder; many handlers use smaller named limits         |
| Request headers                | 64 KiB | Both API HTTP server constructors                             |
| API-call observability capture |  4 KiB | Streaming tee; oversized bodies store only a constant summary |

Known oversized `Content-Length` values are rejected before a handler runs.
Unknown-length/chunked bodies are wrapped with `http.MaxBytesReader`, and the
route decoder or streaming reader converts quota violations to HTTP 413 with
the stable `payload_too_large` error code.

## JSON contract

`httpbody.DecodeJSON` and `DecodeJSONWith` enforce all of the following:

- a positive route-local byte ceiling;
- `application/json` or a registered `+json` media type;
- UTF-8 when a charset is supplied;
- exactly one top-level JSON value, with trailing data rejected;
- unknown struct fields rejected by default;
- an empty body rejected unless the route explicitly opts in; and
- stable 400, 413, and 415 response mappings without parser-detail leakage.

Every relaxation is represented by a named `httpbody.Options` field at the
call site. `ReadJSONAtMost` plus `DecodeJSONValue` is the equivalent two-stage
flow for a signed webhook: retain exact bounded bytes, verify the signature,
then apply strict JSON parsing.

Intentional compatibility exceptions are:

- SCIM accepts unknown resource attributes because RFC 7643 extension schemas
  are open-ended. Size, `application/scim+json`, syntax, and trailing-data
  checks remain strict.
- Pipedrive uninstall decoding uses `json.Number` so provider identifiers do
  not lose precision.
- POST actions whose input object is genuinely optional opt into an empty
  body; a present body is still strict JSON.

## Audited global-limit overrides

Only these request paths may exceed the ordinary 8 MiB process ceiling. The
handler still applies its tighter file, row, expected-size, or semantic quota.

| Method and path                           | Gateway ceiling | Reason                                              |
| ----------------------------------------- | --------------: | --------------------------------------------------- |
| `POST /api/v1/assets`                     |          20 MiB | 10 MiB asset plus JSON/base64 or multipart overhead |
| `POST /api/v1/subscribers/import`         |          32 MiB | Bounded subscriber CSV import                       |
| `POST /api/v1/subscriber-imports/preview` |          50 MiB | Migration preview CSV                               |
| `POST /api/v1/lists/{id}/import`          |          32 MiB | Bounded list CSV import                             |
| `POST /api/v1/suppressions/import`        |          25 MiB | Suppression CSV import                              |
| `POST /api/v1/suppressions/bulk-import`   |          16 MiB | Bounded JSON batch                                  |
| `POST /api/v1/suppressions/bulk-delete`   |          16 MiB | Bounded JSON batch                                  |
| `POST /api/v1/suppressions/bulk-action`   |          16 MiB | Bounded JSON batch                                  |
| `POST /api/v1/emails`                     |          35 MiB | Transactional email with base64 attachments         |
| `POST /api/v1/emails/batch`               |          40 MiB | Bounded transactional email batch                   |
| `PUT /api/internal/uploads/*`             |          25 MiB | Development-only presigned upload target            |

Each override is declared in `httpbody.ProductionRouteLimits` with a non-empty
reason. Its test rejects duplicate, invalid, or default-sized exceptions.

## Streaming, multipart, and signed-byte readers

These flows cannot use the ordinary one-shot JSON decoder, but remain bounded:

- Local presigned uploads stream directly to disk with the signed expected
  size and `httpbody.CopyAtMost`; an extra byte is a 413 and the partial file
  is removed.
- Translation dictionary imports allow a 5 MiB CSV file. Multipart framing
  receives a separate 1 MiB allowance, and both the total request and file
  size are checked.
- Signed JSON webhooks retain exact raw bytes under named limits before HMAC
  or signature verification, including affiliate Stripe (1 MiB), inbound
  webhooks (5 MiB), SMS providers (1 MiB), TikTok (256 KiB), subscriber GPP,
  and the commerce, CRM, analytics, support, feedback, and ActivityPub provider
  families. Provider-owned open schemas may allow unknown fields or a missing
  or mislabeled media type, but malformed or trailing JSON is still rejected.
- Reply-provider webhooks are capped at 5 MiB. Mailgun form/multipart and SNS
  compatibility require provider-specific content types, so this shared raw
  reader intentionally does not impose the ordinary JSON media-type rule.
- RFC 8058 one-click unsubscribe accepts its required URL-encoded/raw marker,
  including legacy senders with no media type, under a 1 KiB ceiling.
- Public tracking, web-vitals, and browser `sendBeacon` endpoints retain their
  legacy browser media-type compatibility under small named limits; none may
  bypass the process ceiling or buffer an unbounded payload. Web-vitals is
  additionally capped at 20 metrics per 64 KiB request and charges its bounded
  client-IP limiter for every submitted metric, not merely once per batch.
- Authentication rate limiting peeks at no more than 32 KiB to derive a hashed
  account key and restores the exact stream, including the unread tail.
- API-call logging wraps the live stream and retains at most 4 KiB. It never
  drains or duplicates the full request; incomplete captures are discarded
  and oversized captures store no raw prefix.

## Regression gate

Run the production scanner directly or through the repository script:

```sh
pnpm audit:request-bodies
# equivalent:
go -C apps/api run ./cmd/checkrequestbodies --root .
```

The scanner rejects production handlers that decode request JSON directly,
read/copy a request body without the canonical quota helpers, use a silently
truncating `io.LimitReader`, or parse multipart data without first assigning a
`http.MaxBytesReader` cap. It runs in `.github/workflows/ci.yml` and
`scripts/prelaunch-local-gate.mjs`.

Adversarial tests cover known-length and chunked 413 responses, unsupported
media types, unknown fields, multiple JSON values, trailing garbage, exact
limits, stream restoration, signed-byte media validation, and copy quotas.
