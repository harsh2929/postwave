# Deliverability provider credential and lifecycle contract

Implementation date: 2026-07-16

Scope: the desktop Deliverability Hub provider card, the provider-config API,
suppression-mirror credential resolution, and inbound edge-token verification.

This contract replaces the former UI path that accepted a raw Mailchimp or
SendGrid API key into `tenant_deliverability_providers.config`. The API already
rejected raw sending credentials, so that path was both nonfunctional and an
unsafe storage model.

## Credential boundaries

The provider row can contain:

- `webhook_token_hash`: a one-way HMAC-SHA-256 digest of the operator-supplied
  edge receiver token. The plaintext is accepted only during an upsert and is
  removed before JSONB persistence.
- `credential_ref`: a non-secret, tenant-relative runtime-secret name for the
  Mailchimp or SendGrid suppression-read credential.
- non-secret provider metadata such as display name and active state.

New raw `api_key`, sending-token, SMTP-password, private-key, and client-secret
fields are rejected recursively. A legacy `config.api_key` remains readable so
existing mirror jobs do not fail abruptly; saving a valid `credential_ref`
deletes that legacy value in the same server-side merge.

## Tenant-bound runtime-secret resolution

The desktop asks for a relative name such as `deliverability/sendgrid`. The API
resolves it as:

```text
tenants/<authenticated-tenant-id>/deliverability/sendgrid
```

The renderer cannot select a different tenant namespace. The provider-config
validator rejects absolute `tenants/...` input, path traversal, empty segments,
whitespace, control/non-ASCII characters, raw-token signatures, ambiguous
unnamespaced values, and references over 512 bytes. The resolver also rejects a
cross-tenant absolute reference as defense in depth for legacy/direct database
state.

Production resolves the resulting name through the shared runtime secret
resolver (AWS Secrets Manager first under the deployed resolver chain). Local
environment resolution maps `/`, `-`, and `.` according to the shared
`packages/secrets` convention. The secret value can be either:

- the raw provider API key; or
- a bounded JSON object with `api_key`, `apiKey`, `token`, `key`, or
  `access_token`.

Missing, oversized, malformed, or keyless secrets return the typed
not-configured path. A transient runtime-vault failure remains an operational
error rather than silently falling through to another tenant credential.
`POSTWAVE_MIRROR_<PROVIDER>_API_KEY` remains an explicit process-wide fallback
for single-tenant/self-hosted deployments only.

## Edge receiver token

The UI accepts only a 32–512 character, whitespace-free printable-ASCII token
and offers a Web Crypto 256-bit generator. A generated value cannot be saved
until the operator either successfully copies it or explicitly acknowledges
secure storage. Clipboard writes are classified `secret`, request
clear-if-unchanged after 60 seconds, and never place the value in telemetry,
diagnostics, toast persistence, logs, titles, routes, or local storage.

The server stores only `webhook_token_hash`. Verification hashes the presented
token with the versioned domain separator and compares in constant time.
Existing plaintext receiver tokens are accepted for compatibility and are
converted to the digest representation on the next provider save.

## Desktop lifecycle and destructive actions

- Label, token, and runtime-secret-reference edits register an instance-scoped
  lifecycle owner from first edit until acknowledged server completion or
  explicit discard.
- Hide is safe; quit, restart, sign-out, workspace switch, and OS shutdown are
  blocked while a draft or provider mutation is active.
- Discard zeroizes every typed value. Switching providers while dirty requires
  a separate explicit discard decision.
- Save and remove are same-tick single-flight and release in `finally` after
  returned errors or thrown transport failures. A failed save retains the
  retryable draft.
- Provider removal requires an in-app destructive confirmation and explains
  that provider-console webhooks, credentials, domains, and other remote
  resources are not removed automatically.
- Existing redacted secrets are never echoed. The server merges sparse input
  over stored configuration, preserving omitted values and skipping a redacted
  sentinel.

## Release evidence and remaining qualification

Automated evidence includes provider-helper and lifecycle behavior tests,
source contracts, API provider-config tests, suppression-mirror credential
tests, the full desktop TypeScript build, scoped zero-warning ESLint, and the
complete API `go test ./...` suite.

Before release, run the signed macOS and Windows matrix with:

- generated, manually entered, copied, acknowledged, invalid, and abandoned
  receiver tokens;
- focused/unfocused/denied clipboard access and clipboard-history warning;
- runtime secret present, missing, malformed, rotated, permission-denied, and
  transiently unavailable;
- legacy raw-key and plaintext-token migration using production-like rows;
- save/remove rejection, timeout, rapid double activation, close/quit/sign-out/
  workspace-switch/update-restart/OS-shutdown during each phase; and
- VoiceOver/Narrator, keyboard-only, forced-colors, 200–400% zoom, and narrow
  supported-window layouts.

Record artifact hash, OS/build, architecture, runtime-secret fixture name
(never value), tenant fixture, operator, timestamps, result, evidence, and
defect ID. Source tests do not upgrade this contract to installed verification.
