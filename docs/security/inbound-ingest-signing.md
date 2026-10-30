# Signed inbound ingestion contract

Moosewave's custom webhook and inbound-email receivers fail closed. A sender
must authenticate the exact raw request bytes, provide a fresh timestamp, and
provide a stable event identity. Body-only HMAC, empty endpoint secrets, and
requests without replay identity are rejected before persistence or actions.

## Custom inbound webhooks

For `POST /api/public/inbound/{slug}`, send all three headers:

- `X-Postwave-Timestamp`: current Unix seconds;
- `X-Postwave-Event-Id`: a stable provider delivery/event identifier (known
  provider headers `X-Event-Id`, `X-GitHub-Delivery`, `X-Linear-Delivery`, and
  `X-Stripe-Event-Id` are accepted instead);
- `X-Postwave-Signature`: `v2=<hex HMAC-SHA256>`, where the signed input is
  exactly
  `v2:<timestampByteLen>:<timestamp>:<eventIdByteLen>:<eventId>:<rawBody>`.
  Moosewave trims surrounding whitespace from the timestamp and selected event
  id first; lengths are decimal UTF-8 byte lengths of those normalized values.
  Send header values without surrounding whitespace to avoid ambiguity.

The timestamp must be within five minutes of API time. The normalized stable
event identity is part of the authenticated frame: changing it without
re-signing fails authentication. Moosewave hashes that identity before storage
and atomically claims it in `inbound_events` before automation fanout or
trigger execution. A byte-identical retry receives `202` with
`duplicate=true`; reusing the event identity with a different transformed
payload receives `409 event_id_conflict` and executes nothing.

Legacy raw-hex v1 signatures over `timestamp + "." + raw_body` are disabled
by default because they do not authenticate the replay identity. A
self-hosted deployment may temporarily enable
`POSTWAVE_ALLOW_LEGACY_INBOUND_SIGNATURE_V1=true` for a bounded sender
migration only; production senders should emit v2.

## Inbound email

For `POST /api/public/inbound-email/{slug}`, send:

- `X-Postwave-Inbound-Timestamp`: current Unix seconds;
- `X-Postwave-Inbound-Event-Id`: a stable provider delivery id. A signed
  payload `MessageID`/`Message-ID` is accepted when the header is absent;
- `X-Postwave-Inbound-Signature`: hexadecimal
  `HMAC-SHA256(endpoint_secret, timestamp + "." + raw_body)`.

The same five-minute window applies. The database claim is unique per tenant.
An exact retry is acknowledged without route matching, forwarding, webhook
actions, automation fanout, classification, or helpdesk mirroring. Reusing an
identity with different raw bytes receives `409 event_id_conflict`.

Signing secrets are stored only as platform envelope ciphertext. `GET
/api/v1/inbound-emails/endpoint` returns metadata (`secretConfigured`,
`rotationRequired`, and rotation time) and never loads or decrypts the key.
`POST /api/v1/inbound-emails/endpoint/rotate` creates an endpoint when absent or
rotates the existing key, and reveals the new plaintext exactly once after the
encrypted write commits. If KMS/envelope encryption is unavailable, creation,
rotation, and ingest fail closed.

Direct providers that cannot set these headers require a small signing proxy.
That proxy must preserve the raw bytes it signs, generate the timestamp at
forward time, and map the provider's immutable delivery id into the event-id
header. Do not use a random id per retry: it defeats deduplication.

## SMS provider callbacks

Twilio callbacks require Twilio signature verification, Telnyx callbacks
require a fresh Ed25519-signed timestamp, and Bandwidth callbacks require the
configured token or Basic credentials (plus the configured source-CIDR
allowlist when present). `POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS` is accepted only
when the runtime is explicitly labelled local/development/test. Production and
staging readiness fail when the variable is present, production startup exits,
and callback verification independently refuses the bypass in protected or
unlabelled runtimes.

Inbound callbacks must carry the provider's stable message id. The first
delivery atomically claims `(tenant, provider, provider_message_id)`; exact
retries return the original message without re-running consent, keyword,
auto-reply, mirror, or metric side effects. Reusing that id for a different
sender, body, or sender profile receives `409 provider_replay_conflict`.
Bandwidth token rotation may temporarily configure the old value in
`BANDWIDTH_WEBHOOK_TOKEN_SECONDARY`; clear it immediately after the bounded
provider retry window.

## Referral attribution

Production requires a dedicated `POSTWAVE_REFERRAL_COOKIE_SECRET` of at least
32 bytes. New `pw_ref` cookies use the v2 signed payload and bind referral code,
tenant id, referrer subscriber id, and expiry. Unsigned plain-code and former
v1 cookies are expired when signing is configured. Conversion creation then
re-resolves the code owner, compares both signed identities, verifies the
referee belongs to the request tenant, and relies on the existing unique
`(tenant_id, referrer_subscriber_id, referee_subscriber_id)` ledger key for
idempotency.

## Rotation and rollout

Custom webhook secret rotation retains the prior key only for its existing
bounded grace window; timestamp and event identity remain mandatory under both
keys. Inbound-email rotation is immediate. Before deploying this contract,
use this order:

1. Apply `1715_inbound_email_replay_identity.sql` before the new API binary and
   verify `inbound_emails_tenant_ingest_key_uniq` is valid in `pg_index`. If a
   concurrent build failed, drop its invalid shell, rerun the migration, and do
   not deploy the receiver until the unique index is valid:

   ```sql
   DROP INDEX CONCURRENTLY inbound_emails_tenant_ingest_key_uniq;
   ```

2. Apply `1734_inbound_email_secret_envelopes.sql`. It deliberately destroys
   every legacy plaintext value, marks those endpoints `rotationRequired`, and
   replaces the SECURITY DEFINER lookup with a search-path-locked ciphertext
   projection. This is a security cutover: legacy endpoints reject ingest until
   an admin rotates them.
3. Rotate every legacy inbound-email endpoint, copy each one-shot secret into
   its signing proxy, and synchronize proxy clocks. A database backup may retain
   historical plaintext and must remain encrypted, access-controlled, and
   expire under the backup-retention policy.
4. Replay a fixed event id twice and verify the second request is acknowledged
   without duplicate side effects; reuse it once with changed bytes and verify
   the request receives `409 event_id_conflict`.
5. Deploy the API and monitor rejection response rates plus the authentication,
   replay-identity, conflict, duplicate, and rotation-grace ingest counters.
   Remove the previous custom-webhook key after its bounded grace period.

Legacy body-only senders are intentionally incompatible unless the explicit
temporary inbound-signature v1 migration flag is enabled. Existing unsigned
or v1 referral cookies also lose attribution safely after the dedicated v2
cookie secret is enabled; they are never upgraded by trusting their old
contents.
