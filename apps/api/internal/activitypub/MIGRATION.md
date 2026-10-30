# ActivityPub Federation — Deferred Implementation Recipe (Phase 3 XL)

`archive-activitypub-federation` is the multi-week effort that takes the
retained design scaffold (migrations `0287` + `0348`, package files `activitypub.go`,
`delivery.go`, `signatures.go`, `remote_actors.go`) and turns it into a
production-grade ActivityPub server interoperable with Mastodon, Threads
(via the Meta bridge), Bluesky (via Bridgy Fed), and WordPress (native).

This document explains what is retained, what is intentionally deferred,
and how a human engineer should pick the work up.

## Inbound Follow attack surface and release containment

**SECURITY-CRITICAL: this release mounts no ActivityPub routes and has no
configuration switch that can add them.**

WebFinger, actor JSON-LD, inbox, outbox, follower, and admin endpoints are all
absent from the runtime router and OpenAPI contract. The desktop fediverse card
and client wrapper are also absent. ActivityPub tables and package primitives
remain reserved implementation scaffolding only; no remote network fetcher,
delivery dispatcher, or archive-publish hook is registered.

### Threat model: unsigned-Follow SSRF amplifier

The following is the threat that a future implementation must prevent; these
steps are not possible through the current runtime because the routes do not
exist:

1. Attacker enumerates Moosewave tenants via WebFinger.
2. Attacker POSTs an unsigned Follow envelope to
   `https://<tenant>/api/public/activitypub/users/<slug>/inbox` with
   ```json
   { "type": "Follow", "actor": "https://attacker.example/evil-inbox",
     "object": "<our-actor-url>" }
   ```
3. Without verification, the v1 handler persists a follower row keyed by
   `actor_url=https://attacker.example/evil-inbox`,
   `inbox_url=https://attacker.example/evil-inbox`, `state='accepted'`.
4. Once the delivery worker (`delivery.go`, deferred) ships, every
   tenant publish triggers an outbound POST of the `Create{Article}`
   envelope to `https://attacker.example/evil-inbox`. The attacker
   chose that URL — it may be:
   - An RFC 1918 internal address (`http://10.0.0.1/admin?delete=*`) →
     SSRF into the cluster's internal network.
   - A cloud-metadata endpoint
     (`http://169.254.169.254/latest/meta-data/iam/security-credentials/`)
     → IAM credential exfiltration on EC2/GCE.
   - A high-traffic third-party service with a destructive side-effect
     on POST (`https://api.example.com/v1/users/123/delete`) → write-
     amplification denial of service against the third party.
   - A slow-loris endpoint that holds the connection open → exhaust the
     delivery worker's HTTP pool.
5. The platform also issues an outbound `Accept{Follow}` POST to the
   attacker URL (deferred but planned), giving them a second
   amplification vector per tenant.

The attack requires zero authentication, zero prior trust, and bypasses
every existing tenant scope — the `/inbox` is public per the AP spec.

### Contract required before introducing an inbox route

Inbound federation must land as one reviewed capability, not as an operator
toggle over partial components. Do not register or document an inbox operation
until all of the following are true:

1. `signatures.go` — `Verifier.Verify` implementation that:
   - Parses the `Signature:` header (keyId, algorithm, headers,
     signature).
   - Fetches remote actor JSON-LD through an SSRF-safe, redirect-revalidating
     transport and extracts `publicKey.publicKeyPem`.
   - Reconstructs the canonical signing string from the named headers +
     `(request-target)`.
   - Validates `Digest:` matches SHA-256 of the body.
   - Verifies the base64 RSA-SHA256 signature against the public key.
   - Rejects with `sig_state='invalid'` + HTTP 401 on any failure.
2. A bounded inbox handler verifies the signature, digest, timestamp, replay
   nonce, actor/object relationship, and tenant actor target before any write;
   it stores `sig_state='verified'` only after all checks pass.
3. A worker that flips `activitypub_followers.state='pending'` →
   `'accepted'` for rows whose `follow_activity_id` matches a verified
   inbox row, AND issues the outbound `Accept{Follow}` POST through
   the delivery worker (which is itself signed via (1)).
4. An admin UI surface that shows `state='pending'` rows distinct from
   `state='accepted'` so the operator can spot abuse spikes.
5. A rate limit on `/inbox` per source IP / per actor URL — the
   verifier still costs CPU even when it rejects, so a flood of bad
   sigs is a cheap DoS vector.

The pull request that introduces the route must also add interoperability,
replay, DNS-rebinding, redirect, private-address, and cross-tenant tests plus
the OpenAPI operation. Until then, every former ActivityPub URL is
intentionally a router 404 rather than a partial or placeholder capability.

## Target architecture sketch (not mounted today)

Every Moosewave publication is exposed as a fediverse `Service` actor.
The actor's `id` URL is anchored at either the platform domain
(`https://<platform>/api/public/activitypub/users/<slug>`) or the
tenant's custom archive domain. Mastodon caches `id` forever, so the
domain choice at provision time is permanent.

The complete future release requires three surfaces:

1. **Public federation surface** — WebFinger at `/.well-known/webfinger`,
   actor JSON-LD at `/api/public/activitypub/users/{slug}`, `outbox`,
   and `followers`. Read endpoints serve cached `Cache-Control` bodies.
   Public reads run **without** a
   tenant GUC (caller IS the public) and rely on `actor_public_lookup` +
   `outbox_public_lookup` PERMISSIVE policies.

2. **Outbound delivery worker** — singleton goroutine (`Worker` in
   `delivery.go`) takes a platform-global lease (row in
   `activitypub_delivery_worker_state`), walks `activitypub_delivery_queue`
   in `next_attempt_at` order, signs each POST with the tenant's RSA key
   from `activitypub_signature_keys`, and POSTs to the follower's inbox
   URL (or `shared_inbox_url` when multiple followers share one host).
   Exponential backoff on 4xx/5xx, terminal `state='failed'` at
   `MaxAttempts`.

3. **Admin surface** — `/api/v1/activitypub/...` for actor provision /
   profile edit / inbox / outbox / followers listing. Tenant-scoped via
   `apikeys.ScopeAdmin` + the standard tenant GUC.

The future publish hook should call `BuildArticleEnvelope` +
`Repo.PublishArticle` only after the signed delivery worker is production-ready.
No such hook is registered today.

## What is retained (not a supported runtime capability)

- `activitypub_actors` + RLS (migration `0287`).
- `activitypub_followers` + RLS (migration `0287`).
- `activitypub_outbox` + RLS + `Create{Article}` builder
  (`BuildArticleEnvelope`).
- `activitypub_inbox` + RLS + admin inbox surface.
- Repository and protocol-builder code for future implementation work.
- Unmounted handler functions that are not reachable from the API router.
- No publish hook and no delivery queue seeding in the running application.
- No public, admin, desktop, OpenAPI, or generated-SDK contract.

## What migration `0348` adds (scaffolding for the deferred path)

- `activitypub_remote_actors` table — remote actor JSON-LD cache.
- `activitypub_signature_keys` table — per-tenant signing key rotation log.
- `activitypub_delivery_worker_state` singleton — lease + metrics.
- `activitypub_inbox.linked_campaign_id` + `linked_comment_id` — two-way
  join from `Create{Note inReplyTo=...}` back into the archive UI.
- `activitypub_outbox.signature_state` + `signed_at` — observability of
  the signing pipeline.
- `activitypub_delivery_queue.signature_header` + `last_status_code` —
  per-delivery byte-identical retry envelope + status capture.

## Deferred work (multi-week)

### 1. HTTP Signatures (the critical path)

**File scaffold**: `signatures.go` (Signer / Verifier interfaces,
canonical signing-string builder, parser, formatter).

**What's missing**:

- The actual `crypto/rsa` signing — load private key from
  `activitypub_signature_keys.private_key_ciphertext` via `byok`
  decryption, SHA-256 the canonical signing string, sign with the
  key, base64-encode, set `Signature:` header.
- SHA-256 of the body for the `Digest:` header (currently a placeholder
  string).
- The inverse verification path: parse incoming `Signature:` header,
  fetch the remote actor's public key through the reviewed fetch subsystem,
  verify the rsa-sha256 of the canonical signing string.
- Parity tests against real Mastodon traffic — there are edge cases
  around header normalisation (case, trailing whitespace, multi-value
  headers) where Mastodon's strict parser disagrees with naive Go
  `Header.Get` semantics.

**Estimated effort**: 1 week. Parallelisable with the delivery worker.

### 2. Delivery worker drain

**File scaffold**: `delivery.go` (`Worker.tick` acquires the lease,
records empty metrics, releases).

**What's missing**:

- The actual queue walk (the `DEFERRED` comment block in `tick`).
- HTTP client tuning + connection pooling for fan-out at ~thousands of
  followers per outbox row.
- `shared_inbox_url` coalescing — group queue rows by `inbox_url`,
  build one POST per host.
- Exponential backoff stamping into `next_attempt_at` (function
  `nextBackoff` is already exported).
- Terminal `state='failed'` at `MaxAttempts`.
- Sentry breadcrumbs on delivery failure + a sustained-failure
  alert (e.g. > 50% of fanouts to a host fail for 1h → warn the admin
  that the host is unreachable).

**Estimated effort**: 1–2 weeks. Depends on (1).

### 3. Remote actor fetch

**Reserved persistence**: `remote_actors.go` contains Repo CRUD on
`activitypub_remote_actors`; it exposes no network adapter or runtime route.

**What's missing**:

- An SSRF-safe remote actor fetch subsystem — signed GET (uses (1)), parse
  JSON-LD actor doc, populate `inbox_url`, `shared_inbox_url`,
  `display_name`, `handle`, `icon_url`, `summary`, `public_key_pem`,
  `public_key_id`.
- Background refresh worker — query
  `activitypub_remote_actors_stale_idx`, fetch in batches, respect
  `MaxRemoteActorFetchFailures` soft-fail cap.
- Verified inbox integration: after persisting a verified inbox row, enqueue a
  refresh for the validated actor URL.

**Estimated effort**: 3–5 days. Parallelisable with (2).

### 4. Inbox → archive comments linking

**Migration**: `0348` adds `activitypub_inbox.linked_campaign_id` +
`linked_comment_id`.

**What's missing**:

- Worker that walks unlinked `activitypub_inbox` rows with `kind='Create'`,
  parses the embedded `object.inReplyTo`, matches against
  `activitypub_outbox.activity_url` to find the campaign, optionally
  threads the Note text into `archive_comments` (treating the remote
  actor as a pseudo-subscriber).
- UI surface on the archive issue page that shows fediverse replies
  inline with archive_comments.

**Estimated effort**: 1 week. Independent of (1)/(2)/(3).

### 5. Signing-key rotation

**Migration**: `0348` adds `activitypub_signature_keys`.

**What's missing**:

- Admin endpoint to mint a new key (RSA-2048, mark `state='active'`,
  flip the prior `active` row to `retired`).
- Worker that retires `retired` keys older than 30 days
  (Mastodon's max cache TTL is ~7d; 30d is conservative).
- Signer implementation that prefers `state='active'` but accepts
  `state='retired'` for incoming Verify (some Mastodon instances may
  still have the old key cached).

**Estimated effort**: 3 days. Independent.

### 6. Outbound `Accept{Follow}` POST

**What's missing**:

- The current release has no inbox handler. A future verified handler must
  persist Follow state and POST an `Accept{Follow}` to the validated remote
  inbox as one atomic, auditable workflow; otherwise Mastodon will retry.
- The Accept envelope is straightforward (it's just `{ type: "Accept",
  actor: <our actor>, object: <the original Follow> }`); the work is
  the delivery + signing path, which depends on (1) + (2).

**Estimated effort**: rolled into (1)+(2). No additional engineering
beyond the activity envelope builder.

## Parallel-execution plan

- **Track A** (one engineer, 1w): HTTP Signatures.
- **Track B** (one engineer, 1w): Remote actor fetch (mock signed-GET
  with a Track-A helper until A lands).
- **Track C** (one engineer, 1w): Delivery worker drain. Pairs with A
  for signing; pairs with B for `inbox_url` / `shared_inbox_url`.
- **Track D** (one engineer, 1w): Inbox → archive_comments linking +
  signing-key rotation admin UX. Fully independent.

Critical path is A → C; B/D are parallel.

## Inspired by

- **Ghost 6.0** — built-in ActivityPub server, every publication is a
  fediverse actor followable from Mastodon. See
  <https://activitypub.ghost.org/>.
- **Substack Notes** — in-platform federation variant (Substack-hosted
  Notes federate as ActivityStreams `Note` objects).

## References

- Migration `0287` — initial five-table scaffold.
- Migration `0348` — this migration; remote actors, key rotation,
  worker state, two-way linking.
- `apps/api/internal/activitypub/activitypub.go` — unmounted handler primitives +
  repo.
- `apps/api/internal/activitypub/delivery.go` — worker scaffold.
- `apps/api/internal/activitypub/signatures.go` — signing scaffold.
- `apps/api/internal/activitypub/remote_actors.go` — remote actor cache.
- No archive publish-time callsite is registered in the current runtime.
