# Public form upload security contract

Public form attachments are untrusted until the complete server-side pipeline
marks them `clean`.

1. The public presign handler accepts only JPEG, PNG, WebP, PDF and plain text,
   with an exact declared size from 1 byte through 25 MiB. S3 signs the content
   length, content type and SSE-KMS headers.
2. Before a URL is issued, Postgres reserves the bytes under a per-tenant
   advisory lock. The default tenant budget is 1 GiB and the default maximum
   number of pending/quarantined reservations is 100. Quotas therefore remain
   correct across API replicas.
3. Objects are written below the private `quarantine/tenant/<tenant>/form/<form>`
   prefix. Submission linking requires the same tenant and form; an upload ID
   from another form cannot be attached.
4. A linked object is claimed by the bounded scanner worker. The worker opens
   the private object, detects its MIME from bytes, enforces the exact reserved
   byte count, and streams it to clamd using INSTREAM. Only an explicit `OK`
   verdict becomes `clean`. MIME/size mismatches become `rejected`; malware
   becomes `infected`; both objects are deleted. Scanner/storage failures retry
   with a lease and backoff, then become terminal `error` and are also deleted.
   Every non-clean state is deny-only.
5. Unlinked reservations are reclaimed by the existing orphan sweeper. The
   RLS scanner policy can see only linked quarantine rows, never clean customer
   attachments.

Production requires `POSTWAVE_FORM_UPLOAD_CLAMAV_ADDR`. API startup probes the
endpoint and `/api/ready` reports a required failure when the setting is absent.
The repository defines the client, worker, state machine and ECS address
contract; the infrastructure account must still deploy a private, signature-
updated clamd service at `clamav.postwave.internal:3310`, restrict port 3310 to
the API security group, and add availability/definition-age monitoring before
promotion. Until that external service is deployed and reachable, production
correctly refuses traffic instead of accepting unscanned files.
