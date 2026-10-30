# Engagement classifier v2 shadow rollout

This runbook operates Track B F01. It classifies canonical engagement evidence
as `human`, `machine`, or `unknown`; it does not prove that a person read an
email and it does not change customer-facing metrics while rollout mode is
`shadow`.

## Preconditions

1. Apply the full migration chain through
   `2035_engagement_machine_registry_snapshot_seal.sql` with the normal
   migration service and verify the API role is `postwave_app` without
   `BYPASSRLS`. The v2 manifest must have provenance state `sealed_snapshot`,
   and its entry count and whole-snapshot hash must match the registry rows.
2. Generate a dedicated secret containing at least 32 bytes. Do not reuse an
   auth pepper, API-key pepper, webhook secret, sending KEK, or model key.
3. Assign a stable, non-secret key id. Rotation creates a new correlation
   boundary; retain the old id in evidence and do not relabel historical rows.
4. Keep the bootstrap registry in shadow until calibration includes both a
   controlled-machine corpus and an adequately sized labeled-human corpus.

The
[2026-08-31 clean 958-migration registry-seal receipt](../2026-frontier/evidence/engagement-machine-registry-v2-seal-postgres-verification-2026-08-31.md)
is the current repository-local known-good example for precondition 1. It does
not substitute for checking the target deployment's migration ledger, roles,
manifest, rows, grants, or runtime load, and it is not production calibration
or cutover evidence.

Configure one API deployment first:

```text
POSTWAVE_ENABLE_ENGAGEMENT_CLASSIFIER_V2=true
POSTWAVE_ENGAGEMENT_IDENTITY_HMAC_KEY=<dedicated secret, >=32 bytes>
POSTWAVE_ENGAGEMENT_IDENTITY_HMAC_KEY_ID=engagement-hmac-2026-08
POSTWAVE_ENGAGEMENT_OBSERVATION_RETENTION=8760h
POSTWAVE_ENGAGEMENT_RECLASSIFICATION_LEASE_TTL=2m
POSTWAVE_ENGAGEMENT_RECLASSIFICATION_WORKER_ID=<stable pod/process label>
POSTWAVE_ENGAGEMENT_RETENTION_SWEEP_INTERVAL=1m
```

Startup is the readiness gate. It must load and validate the exact
`postwave.machine-source-registry.v2` rows through the restricted application
role. A missing migration, empty or malformed registry, short key, invalid key
id, or out-of-range retention/lease value stops the process.

## Evidence checks

For a new signed Listmonk event, verify one row exists in each of
`subscriber_events`, `subscriber_event_observations`, and
`event_classifications`, all sharing the exact `(id, at)` event identity.
Provider replay must leave those counts at one. In the observation:

- `recipient_identity_hmac` is 64 lowercase hexadecimal characters and
  `recipient_key_id` is the configured id;
- the recipient address does not appear in `ordered_headers` or
  `provider_signals`;
- Listmonk evidence has `ordered_headers=[]` and
  `ordered_headers_complete=false`;
- `privacy_expiry_at - ingested_at` equals the configured total retention,
  which must extend beyond the 90-day full-fidelity tier; and
- classification provenance names the exact classifier, methodology, registry,
  and configuration hash.

Monitor coverage and unknown share from
`subscriber_event_classification_shadow_v1`. Only an explicit `human` decision
sets `human_signal=true`; missing evidence and `unknown` remain unknown.

## Reclassification recovery

`Repo.ReclassifyWindow` is request-idempotent. A live lease cannot be stolen.
If a process dies, wait for `lease_expires_at`, then retry the same request id,
window, and exact classifier configuration from another worker. The attempt
increments by one and receives a new token. Do not mutate the run row manually.
The reclaimed worker replays the uncommitted page safely and advances the
cursor only after every event in the page has committed.

## Disable and incident response

Set `POSTWAVE_ENABLE_ENGAGEMENT_CLASSIFIER_V2=false` and restart to remove the
hook. New Listmonk events return to ordinary tenant transaction scope; existing
observations, classifications, calibration reports, and run lineage remain
intact. Because event/classification persistence is one transaction, a
classifier outage returns a retryable Listmonk ingest failure instead of
committing an unclassified canonical event.

At 90 days, the retention worker clears ordered headers, IP, and TLS/JA4 while
retaining ASN and immutable classification provenance so the event remains
reclassifiable. Only after the separately configured total observation
retention expires are inline raw observations removed through
`Repo.PurgeExpiredObservation`, which writes the hash-only deletion receipt
before deletion. Never delete or update observation/classification rows
directly. The supervised runtime walks at most 100 tenants and 100 inline
observations per tick. A full observation batch retains the prior tenant cursor
so that tenant is drained before the cursor advances; the tenant keyspace wraps
after its final page.

Object-backed raw evidence is not operational in this runtime. Provider input
with `RawObjectRef` or `RawObjectVersionID` fails closed. The sweep leaves any
legacy object-backed row in place, reports only the aggregate number of blocked
tenants, and SQL independently rejects a direct purge. Do not remove the row or
pointer until an adapter has deleted the exact object version and written a
durable deletion receipt. Disabling the hook is not a substitute for the
retention sweep.
