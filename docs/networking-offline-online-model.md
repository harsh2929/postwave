# Moosewave Networking, Offline, And Live-Update Model

Date: May 11, 2026

Scope: web app, Tauri desktop app, Expo mobile app, and Go API gateway behavior for network failures, offline startup, cached reads, and server-sent event streams.

## Goals

- Keep authenticated users inside the product when the network drops.
- Queue only safe, reversible editorial mutations while preserving online-only
  guarantees for high-risk operations.
- Never leak long-lived API keys through stream query strings.
- Make transient upstream failures diagnosable without exposing raw internal errors to users.
- Persist only low-risk mobile cache data by default.

## Connectivity States

| State | Meaning | Product Behavior |
| --- | --- | --- |
| Online | API health and authenticated requests are reachable | Full read/write functionality, live streams enabled |
| Degraded | Shell is usable, but some API calls or streams fail | Keep cached UI visible, show per-action retry/error states |
| Offline | Device/browser reports no network, or startup cannot reach API | Cached views where available; safe draft/editorial writes are queued; destructive or externally visible actions are blocked |
| Reconnecting | Network has returned and clients are refreshing | Revalidate cached state, replay safe queued writes, reconnect streams, resume normal polling |

## Backend Contract

The API issues short-lived signed stream tokens through:

```text
POST /api/v1/streams/token
```

Tokens are HMAC signed, expire quickly, and are accepted only on stream routes:

- `/api/v1/events`
- `/api/v1/dashboard/live`
- `/api/v1/campaigns/{id}/events`
- `/api/v1/migrations/{id}/events`

Clients should use `stream_token` for EventSource or fetch-based stream URLs. Long-lived API keys in stream query strings are retained only as a legacy/local fallback for older API builds.

## Web App

The web API client classifies failures as:

- `offline`
- `timeout`
- `aborted`
- `network`
- `parse`
- `http`

Browser-side requests short-circuit when `navigator.onLine === false`. The Next.js API proxy uses upstream request timeouts and returns structured `502` or `504` error envelopes without exposing raw upstream exception text.

The web app registers a service worker, exposes a manifest, serves an offline
fallback page, caches the app shell, and keeps low-risk dashboard-style GETs
available through a stale-while-revalidate cache. It also persists a pending
mutation ledger in local storage for safe writes.

## Desktop App

The desktop shell keeps the authenticated app mounted after startup even if the network drops. It should not throw users into a global offline blocker once a remembered session exists.

Desktop live updates use short-lived stream tokens for:

- Event bus updates
- Campaign event streams
- Migration event streams
- Dashboard live streams

Desktop requests include credentials so session-cookie authentication works inside the Tauri webview.

Desktop also keeps an encrypted local vault for sensitive read caches. The
vault encrypts payloads with AES-GCM in the webview; the vault key is stored in
the OS credential manager through Tauri.

## Mobile App

Mobile integrates device connectivity and app foreground state into React Query:

- NetInfo drives online/offline state.
- AppState drives foreground/background focus.
- SecureStore session hydration no longer blocks startup on a network call.
- Session revalidation happens in the background.
- Stream connections wait until the device is probably online.

Mobile persists low-risk query caches by default:

- dashboard stats
- campaign summaries/reports
- sequence/list/tag/domain/sending-setting metadata
- selected integration and voice draft metadata

Mobile stores selected sensitive read caches in the OS-backed secure store:

- subscriber detail records
- recent audit rows
- suppressions list snapshots
- inbound webhook list snapshots

Mobile still does not persist high-risk control material:

- billing or API key material

## Offline Action Policy

Allowed offline:

- Viewing already cached low-risk dashboard and campaign summaries on mobile.
- Keeping the desktop/web shell open with explicit error states.
- Retrying failed reads when the network returns.
- Queuing safe editorial changes such as draft subjects, sequence drafts,
  workspace notification preferences, and non-send campaign copy edits.

Not allowed offline:

- Sending campaigns.
- Deleting subscribers, campaigns, suppressions, or domains.
- Billing or subscription changes.
- OAuth starts/callbacks.
- Imports, migrations, exports, and large file uploads.
- API key creation, rotation, or reveal.
- Compliance/privacy actions such as erasure, consent export, or DSAR workflows.

Future offline write queues must use idempotency keys, clear user-visible pending state, conflict resolution, and server-side replay protection before being enabled.

Current offline write queues attach idempotency keys and preserve base revision
headers when available. Replays that return `409 Conflict` or
`412 Precondition Failed` remain in the pending-action ledger as conflicts
instead of being dropped.

## Resumable Imports

Migration uploads support chunked resumable PUTs through the migration service:

```text
PUT /api/v1/migrations/{source}/uploads/{upload_id}
POST /api/v1/migrations/{source}/uploads/{upload_id}/complete
```

The browser sends `Content-Range` for each chunk and stores a local upload id
by file identity, so retrying the same file continues the same upload session.
The service validates final size before creating a migration job.
