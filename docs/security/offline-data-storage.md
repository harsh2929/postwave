# Offline customer-data storage

This document is the production security contract for Moosewave's web and
desktop offline mutation queues and client query caches. It records the
remediation for audit finding H-01 and the related desktop cache findings.
It is intentionally narrower than a complete inventory of local UI
preferences, diagnostics, or operator-authored convenience history.

Status: implemented and regression-tested on 2026-07-14.

## Security objective and threat boundary

Customer mutation bodies and authenticated API responses must not be written
as plaintext to browser storage, IndexedDB, or desktop WebView storage.
Persisted data must be identity-scoped, bounded, short-lived, and purged at
authentication boundaries.

Desktop encryption protects data at rest from inspection of the WebView
profile or a copied application-data directory without access to the
operating-system credential vault. It does not claim to protect plaintext
already rendered in a live, authenticated process from an active renderer or
endpoint compromise. On web, there is no browser-only secret that is outside
the same origin and script boundary as the ciphertext. Moosewave therefore
does not manufacture an adjacent browser encryption key: customer cache and
outbox data are tab-memory-only.

The web service worker is `NetworkOnly` for authenticated API requests and
authenticated/auth-flow navigations. It caches static assets, public archive
responses, and public navigations only, so it is not a second durable store
for authenticated customer responses.

## Current storage contract

| Surface | Data | At-rest representation | Scope | Maximum retention | Bounds |
|---|---|---|---|---|---|
| Desktop | Explicit mutation outbox | AES-256-GCM envelope in WebView localStorage | Resolved user/tenant or native API-key workspace identity | 8 hours | 200 records and 256 KiB serialized queue |
| Desktop | Narrow offline response cache (`/api/v1/dashboard/stats`) | AES-256-GCM envelope in WebView localStorage | Same identity as outbox | 1 hour | 480 KiB including entry data, with envelope headroom |
| Desktop | TanStack query snapshot | AES-256-GCM envelope in IndexedDB | App version plus user/tenant or native API-key workspace identity | 8-hour snapshot restore limit and inactive-query GC | Native vault rejects plaintext above 512 KiB; failure is a safe cache miss |
| Web | Explicit mutation outbox | Current-tab memory only | Server-resolved user and tenant | 4 hours or tab reload/close, whichever comes first | 200 records and 256 KiB serialized queue |
| Web | Narrow offline response cache (`/api/v1/dashboard/stats`) | Current-tab memory only | Same identity as outbox | 30 minutes or tab reload/close | 512 KiB per entry |
| Web | TanStack query snapshot | Current-tab module memory only | App version plus server-resolved user and tenant | 30-minute inactive-query GC or tab reload/close; active views live for the tab session | Governed by TanStack garbage collection |

The desktop allowlist permits bounded edits to forms, segments, templates,
lists, tags, subscriber profiles, and campaign drafts. Send/schedule actions,
bulk subscriber operations, deletes, billing, authentication, API-key,
privacy, OAuth, migration, and other high-risk mutations remain online-only.
The web allowlist is narrower: form and segment creates/edits only. Stored
headers are reduced to conflict metadata (`If-Match`); authorization, cookie,
and arbitrary request headers are never copied into an outbox record.

## Desktop cryptographic design

- Rust generates a random 256-bit key on first use and stores it under the
  `com.moosewave.desktop` service in the operating-system credential vault.
- The key never crosses the Tauri IPC boundary. The renderer can request
  `vault_seal`, `vault_open`, or key purge, but it cannot read or export the
  key or call a generic secret API.
- AES-GCM uses a fresh 96-bit random nonce per seal. The serialized identity,
  schema version, timestamps, paths, mutation bodies, and cache data are all
  inside the authenticated ciphertext. The non-secret logical storage key may
  expose the identity partition, but the same identity is repeated and
  verified inside the authenticated envelope before hydration.
- Native IPC accepts vault calls only from the bundled main window and
  trusted origin. Plaintext is capped at 512 KiB and envelopes at 768 KiB.
- A malformed, foreign-key, wrong-identity, expired, or unsupported-version
  envelope is a cache miss and is never replayed as customer data.

Non-Tauri browser development builds use a process-memory WebCrypto key. That
fallback never writes a key to storage and therefore cannot recover ciphertext
after reload; it is not the desktop production key lifecycle.

## Identity, expiry, and purge lifecycle

At desktop startup, the offline store hydrates only the encrypted partition
for the remembered identity before the authenticated shell can replay or
render it. Cookie sessions use user and tenant IDs. Native API-key workspaces
use a broker-derived identity that includes the configured API origin, rather
than sharing an anonymous partition.

Every record carries an absolute expiry that is capped again during
sanitization. Expired records are removed from memory and rewritten out of
the encrypted envelope. Queue limits evict oldest records first and the UI
reports dropped changes. Both stores schedule an active timer for the next
outbox/cache expiry rather than waiting for a later read.

Purge boundaries are:

- Full desktop sign-out clears the in-memory outbox/cache, every encrypted
  vault item, the IndexedDB query snapshot, and identity metadata, then asks
  the OS credential vault to delete the vault key. Ciphertext removal happens
  even if the external keychain service is temporarily unavailable.
- Desktop workspace switch first writes and verifies a bounded, validated
  pending-switch journal and raises an API identity-generation barrier. It
  parks the source identity's encrypted offline partition, clears the shared
  query snapshot and private session state, then commits native credential,
  API URL, and active-workspace metadata as separately verified stages. A
  successful commit reloads while the barrier remains closed. If any stage
  fails, dispatch resumes only after a verified rollback to the recorded
  source; the source offline partition is retained for later restoration, not
  deleted.
- On startup, secure credential hydration reconciles any pending switch before
  React or application requests start. Recovery rolls every recorded crash
  phase back to the journaled source. An invalid, mismatched, storage-denied,
  or incompletely rolled-back journal remains durable and keeps URL resync and
  API dispatch fail-closed for operator recovery.
- Web logout, session expiry, account/workspace identity change, and provider
  unmount clear both customer-data memory stores. Reload or crash inherently
  clears them as well.
- Anonymous callers cannot enqueue or cache customer data on either surface.

## Upgrade and plaintext cleanup

Plaintext is not migrated into the new stores. A safe cache miss is preferable
to carrying sensitive legacy state across the security boundary.

- Desktop removes `postwave.desktop.offline-mutations.v1` and every
  `postwave.desktop.offline-cache.v1:*` key on first offline-store access.
- Desktop query-cache hydration recognizes only a structured AES-GCM
  envelope. A legacy raw TanStack JSON snapshot is deleted from IndexedDB.
  Structurally valid ciphertext is retained when the OS keychain is
  temporarily unavailable so a transient vault outage does not destroy it.
- Web removes the prior v1 and v2 localStorage outbox/cache namespaces on
  authenticated provider setup, cleanup, and logout.
- Web deletes the legacy `tanstack-query-cache` IndexedDB record at provider
  startup and every query-state purge. New releases never read or write that
  record.

## Failure behavior

The storage boundary fails closed. Desktop vault or quota failure leaves new
offline changes in process memory only and shows a persistent queue warning
that closing Moosewave will lose them. Query persistence failure never falls
back to plaintext; online data is refetched when possible. Web users are told
in the offline banner, queue tray, and settings that they must keep the tab
open and that reload, sign-out, or workspace switch discards queued changes.

## Verification evidence

The regression suites assert all of the following:

- sensitive mutation bodies and TanStack query data are absent from physical
  localStorage/IndexedDB values;
- desktop AES-GCM round trips, native delegation, size limits, corruption,
  keychain-outage behavior, and full key/ciphertext purge;
- authenticated crash recovery and rejection of wrong-identity envelopes;
- 8-hour/1-hour desktop and 4-hour/30-minute web expiry boundaries;
- legacy plaintext cleanup, logout purge, workspace-switch purge, anonymous
  rejection, queue bounds, and visible persistence-failure state;
- web reload/crash behavior is a safe miss and never touches durable storage.

Primary test files:

- `apps/desktop/src/__tests__/lib/offline-store.test.ts`
- `apps/desktop/src/__tests__/lib/query-client-storage-security.test.ts`
- `apps/desktop/src/__tests__/lib/secure-vault.test.ts`
- `apps/desktop/src/__tests__/lib/query-client-buster.test.ts`
- `apps/desktop/src/__tests__/lib/workspaces.test.ts`
- `apps/web/src/__tests__/offline-store.test.ts`
- `apps/web/src/__tests__/query-client-storage-security.test.ts`
- `apps/web/src/__tests__/components/query-provider-identity.test.tsx`

Any future change that adds a durable authenticated web cache, broadens an
outbox allowlist, increases retention, exposes a generic native secret API, or
moves the desktop key into renderer-accessible storage requires a security
review and new artifact-level no-plaintext tests before release.
