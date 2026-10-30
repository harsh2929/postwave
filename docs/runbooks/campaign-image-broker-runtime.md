# Campaign Assurance image broker and OCR runtime

This runtime produces bounded image evidence for **Predicted Agent
Comprehension**. It does not observe Gmail, Gemini, Apple Mail, Outlook, or a
recipient inbox. It defaults off and is independently gated from both the
deterministic and modeled Campaign Assurance suites.

## Startup contract

The API never starts this runtime. Production uses a dedicated assurance task
with four image-side roles:

```text
worker -> authenticated UDS -> image broker -> authenticated UDS -> OCR sandbox
                                      image broker -> authenticated UDS -> scanner
                                      image broker -> allowlisted HTTPS + versioned S3/KMS
```

Set `POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_IMAGE_BROKER=true` only on the worker
and image broker after migration 1933 is applied. OCR/scanner commands are
always fail-closed services and have no feature flag. All values below are
exact:

| Variable | Contract |
|---|---|
| `POSTWAVE_CAMPAIGN_IMAGE_ALLOWED_HOSTS` | Comma-separated lowercase DNS hostnames. No wildcard, suffix rule, IP literal, port, path, whitespace, or trailing dot. Every configured campaign image CDN must be named explicitly. |
| `POSTWAVE_CAMPAIGN_IMAGE_OCR_UNIX_SOCKET` | Absolute, clean Unix-domain socket path owned by the local workload boundary. TCP/HTTP endpoints and symlinks are rejected. |
| `POSTWAVE_CAMPAIGN_IMAGE_OCR_ENGINE` | Exact lowercase OCR engine identity returned by readiness and every recognition response. |
| `POSTWAVE_CAMPAIGN_IMAGE_OCR_VERSION` | Executable-derived `<tesseract-semver>-eng.sha256.<64-lowercase-hex-traineddata-digest>`. The fixed path is `/usr/share/tessdata/eng.traineddata`; only the canonical English model is accepted. |
| `POSTWAVE_CAMPAIGN_IMAGE_OCR_CLIENT_UID` | Numeric UID allowed to call the OCR socket. Production pins the image broker UID. |
| `POSTWAVE_CAMPAIGN_IMAGE_OCR_CONCURRENCY` | `1..16`; production defaults to two bounded calls. |
| `POSTWAVE_CAMPAIGN_IMAGE_SCANNER_UNIX_SOCKET` | Absolute Unix-domain socket for the mandatory content scanner. |
| `POSTWAVE_CAMPAIGN_IMAGE_SCANNER_ENGINE` | Exact scanner identity. |
| `POSTWAVE_CAMPAIGN_IMAGE_SCANNER_VERSION` | Executable-derived `<clamav-semver>-db.<numeric-daily-database-revision>`. Every release architecture must report the same frozen revision. |
| `POSTWAVE_CAMPAIGN_IMAGE_SCANNER_CLIENT_UID` | Numeric UID allowed to call the scanner socket. Production pins the image broker UID. |
| `POSTWAVE_CAMPAIGN_IMAGE_SCANNER_CONCURRENCY` | `1..16`; production defaults to two bounded calls. |
| `POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_BUCKET` | Private general-purpose S3 bucket with versioning **Enabled**. Suspended/unversioned buckets fail readiness. |
| `POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_PREFIX` | Dedicated relative object prefix. Objects are additionally namespaced under `tenants/{tenant_id}`. |
| `POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_KMS_KEY_ID` | Dedicated full KMS key ARN. Aliases are discouraged because `HeadObject` must return the exact configured key identity. |
| `POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_RETENTION` | `1h..720h`; default and maximum 30 days. This is frozen into the broker policy hash. |
| `POSTWAVE_CAMPAIGN_IMAGE_OCR_CACHE_RETENTION` | `1h..720h`; default 14 days. Expired entries are never hits. |
| `POSTWAVE_CAMPAIGN_IMAGE_IPC_TIMEOUT` | `100ms..1m`; default 10 seconds and shared by readiness/scan/OCR calls. |

Feature-off worker startup acquires no image capability. Feature-on broker and
worker startup must prove forced-RLS tables under the non-bypass application
role, S3 bucket versioning/encryption, exact OCR/scanner identities and
data-only sandbox profiles, authenticated socket ownership, and the dedicated
KMS identity. Any missing or mismatched dependency fails startup; no permissive
stub is injected.

## Isolation boundary

The broker is the only component that receives reviewed image URLs. It accepts
HTTPS/443 only, disables proxy and compression behavior, re-resolves DNS at
dial time, rejects any mixed or non-public answer, bounds redirects, and
requires each rendered image to match the frozen semantic node and exact
normalized URL.

OCR and scanning use `postwave.campaign-image-ipc.v1` over disjoint fixed Unix-domain
sockets. Each call is a four-byte big-endian JSON-header length, a bounded
strict JSON header, and the declared binary payload. The OCR payload is one
canonical PNG plus hashes, dimensions, and a language hint. The request schema
contains no URL, HTTP client, browser, tool, shell, token, credential, callback,
or arbitrary operation. Unknown response fields, trailing JSON, oversized
frames, identity drift, and undeclared status values are rejected.

The OCR service readiness response must explicitly attest:

```json
{
  "protocol": "postwave.campaign-image-ipc.v1",
  "operation": "ready",
  "status": "ready",
  "engine": "<exact configured engine>",
  "version": "<exact configured version>",
  "sandbox_profile": "postwave.ocr.data-only.v1",
  "network": false,
  "browser": false,
  "tools": false,
  "shell": false
}
```

That attestation is a protocol check, not the sandbox itself. The OCR and
scanner binaries reject every known application/cloud/provider credential,
sanitize child-process environments, and install a process-wide Linux seccomp
filter denying AF_INET/AF_INET6 before any executable probe or listener. ECS
also supplies a read-only root, non-root UID, dropped capabilities, bounded
CPU/memory/concurrency, private mode-0700 socket directories, and mode-0600
sockets. Although Fargate containers share the task network namespace, these
processes cannot create internet or task-credential-network sockets. Neither
mounts the worker, broker, model, or provider socket.

The scanner readiness response uses the same closed fields with sandbox profile
`postwave.scanner.data-only.v1`. Both services authenticate `SO_PEERCRED`/the
platform peer credential plus socket UID/mode, reject symlinked or group/world
writable directories, accept one bounded request per connection, and reject
duplicate JSON keys, trailing frames, identity drift, and total-deadline
overruns before spawning a tool.

## Raster evidence and exact deletion

The evidence adapter accepts only the exact canonical PNG whose SHA-256 is in
the content-addressed broker key. It writes with `If-None-Match: *`, SHA-256
checksum enforcement, SSE-KMS, bucket keys, a private tenant-prefixed key, and
no ACL. A `HeadObject` recheck must prove checksum, byte length, media type,
KMS identity, and nonempty S3 version ID before migration-1933 metadata can be
recorded. The assurance receipt exposes only an opaque
`campaign-image-raster/{evidence_id}` reference.

The retention worker discovers only expired evidence without a deletion
receipt. It sends `DeleteObject` with the exact recorded `VersionId`, rejects a
different response version, then appends one immutable deletion receipt. An
explicit `NoSuchVersion`/`NoSuchKey` is safe for replay and still records that
the requested exact version is absent. A database trigger refuses early,
wrong-version, wrong-object, non-worker, update, and delete attempts. Evidence
metadata and receipts remain audit records until tenant erasure.

S3 lifecycle is defense in depth, not the primary receipt path. Configure it
to remove abandoned noncurrent versions after the approved maximum plus an
operator buffer, and alert on lifecycle/ledger divergence. Never use an
unversioned bucket or a shared public asset bucket.

## OCR cache and retention schedule

Cache identity is the exact tuple of tenant, asset SHA-256, canonical raster
SHA-256, OCR runtime version, engine, engine version, and language hint. Values
are immutable. A conflicting result for an existing identity is an error, not
an overwrite. Other tenants and expired entries cannot hit. A worker-scoped
bounded sweep is the only application-role delete path, and the database
trigger permits it only after `expires_at`.

The dedicated image-broker command starts `Runtime.RunRetention(ctx, observer)`
beside its authenticated broker server. Its
package policy is fixed at one serialized batch of at most 1,000 immediately
and every hour; callers cannot widen either bound. It reports every
result/error through the required observer and stops on context cancellation.
`Runtime.SweepRetention` remains the bounded one-batch seam for operator
recovery and focused tests.
Monitor cache deletions, exact evidence-version deletions, failures, oldest
expired undeleted evidence, IPC readiness/latency, scanner failures, OCR error
codes, image fetch rejections, and S3/KMS errors. Never log image bytes, OCR
text, source URLs, socket payloads, KMS identifiers, or provider error bodies.

## Rollout, rollback, and certification

1. Apply migration 1933 and verify the API connects as `postwave_app` with
   neither superuser nor `BYPASSRLS`.
2. Keep the feature false while deploying the versioned private bucket,
   dedicated KMS policy, scanner, and networkless OCR workload.
3. Run the race/fuzz/forced-RLS suite and a credentialed staging corpus across
   every approved CDN hostname, language pack, animation policy, malformed
   image family, DNS-rebinding case, scanner verdict, and retention replay.
4. Archive the exact host list, broker policy hash, engine/model/scanner
   versions, corpus manifest and hashes, latency/error distribution, KMS/bucket
   policy review, deletion receipts, and operator approval.
5. Enable advisory-only for selected internal tenants. An image/OCR unavailable
   result must remain unavailable; it must never become a green score.

The published `campaign-assurance-core` image has only the six assurance Go
binaries and no OCR/scanner packages. `campaign-assurance-image-services`
inherits that core and adds only version-pinned Tesseract/English traineddata
and ClamAV scanner/frozen signed definitions. Docker Push runs both amd64 and
arm64 images, proves role separation, requires the locked ClamAV database
revision, compares executable-derived identities across architectures, and
archives the exact identities. ECS uses the tools image only for OCR/scanner;
all other assurance containers use the minimal core digest.

To stop new acquisition/OCR while deterministic/model work continues, register
a new assurance task with
`POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_IMAGE_BROKER=false` on the worker. Keep the
broker's own required startup flag true: with no worker client it remains idle,
whereas setting it false deliberately terminates the essential broker
container and rolls the whole assurance service back. For an active broker
security incident, scale the complete assurance service to zero and keep the
API runtime/gate off. Do not mutate a running task or delete the evidence
bucket.
Existing immutable cache/evidence/deletion records remain governed by their
retention paths. Removing the worker capability does not delete audit evidence
or change prior assurance receipts.

The offline implementation and tests are not a live CDN, S3/KMS, scanner, or
OCR certification. Production promotion still requires the named credentialed
corpus evidence and security review above.

See [`infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md`](../../infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md)
for the canonical two-image render, exact secret/IAM boundary, worker-first
startup, identity artifact ingestion, and staged rollout checks.
