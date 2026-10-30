# Runbook — Customer Data Export (GDPR / CCPA Subject Access Request)

When a customer (or one of their subscribers via the customer) requests a
copy of all data we hold about them, per GDPR Article 15, CCPA §1798.100,
or equivalent. SOP for the on-call DPO + ops engineer.

Two distinct request types — handle them differently:
1. **Account holder export** — our customer requests *their tenant*'s data.
2. **Subscriber export** — our customer's *subscriber* asks our customer
   to provide their data, and our customer asks us. We only export to
   the account holder; the subscriber relationship is theirs.

---

## Symptoms / Detection

- Email to `privacy@moosewave.com` (forwarded into the privacy operations queue).
- In-app "Request my data" button on `/settings/privacy`; it records a
  tenant-scoped `privacy.export_requested` audit entry with the legal region
  and estimated fulfillment target.
- Regulator inquiry routed to legal.

## Severity / SLA

| Region | Statutory deadline | Internal SLA |
|---|---|---|
| EU/UK (GDPR) | 30 days | 14 days |
| California (CCPA) | 45 days | 21 days |
| Brazil (LGPD) | 15 days | 10 days |
| Other | 30 days default | 21 days |

Severity matrix:

| Condition | Severity |
|---|---|
| Standard request, no special circumstances | SEV4 (workflow, not incident) |
| Request from a regulator | SEV3 |
| Request from an account our security team has flagged | SEV2 (legal review before any export) |
| Court order / subpoena | SEV1 (legal handles entirely) |

---

## Immediate response

P0 (any request):
1. **Acknowledge in writing within 72 hours.** Use the acknowledgment
   template below.
2. **Verify identity.**
   - Account holder: must initiate from the email on file, or pass
     password + 2FA + the security-question challenge.
   - If signature is suspect, require a video call with photo ID for
     EU residents per ICO guidance.
3. **Locate the tenant.**
   ```sql
   SELECT id, name, plan, region, created_at
   FROM tenants
   WHERE owner_email = $1;
   ```
   If multiple, list them in the export request and confirm which.

## Standard operating procedure

### Step 1 — Open the export job
The in-app button creates the auditable request record. For local/private-beta
fulfillment, use the audited request id to download the tenant-scoped ZIP:

```bash
curl -H "Authorization: Bearer <admin_api_key>" \
  -H "X-Tenant-Slug: <tenant_slug>" \
  -o postwave-export.zip \
  "https://api.moosewave.com/api/v1/privacy/export-requests/<request_id>/download"
```

The endpoint:
- Reads tenant-scoped tables inside an RLS-bound transaction
- Writes one JSON file per exported table under `tables/`
- Bundles `manifest.json` with table names, row counts, generation timestamp,
  and the max rows per table
- Excludes transient OAuth/session secrets and idempotency rows
- Appends `privacy.export_fulfilled` to `audit_log`

### Step 2 — Package and audit
1. Verify the manifest counts match spot-check `SELECT count(*)` queries for
   high-risk tables such as `subscribers`, `campaign_archive`, and `audit_log`.
   Discrepancies are immediate stop-and-investigate.
2. Encrypt the ZIP before sending it outside the authenticated app session.
3. Store the encrypted artifact in the ticketing system or secure handoff
   location approved for the request.

### Step 3 — Deliver
1. Send the download URL via the email on file (separate channel from
   the passphrase, which goes via SMS or the in-product secure inbox).
2. Confirmation template below.
3. Track download via the webhook. If not downloaded after 5 days, send
   reminder. After 7 days, URL expires; require re-issue.

### Step 4 — Aftercare
- Mark the request `fulfilled` in Linear.
- Post-fulfillment audit: did the export include any data we should not
  have collected? If so, retention policy needs review.

## What's included by default

| Resource | File | Notes |
|---|---|---|
| Account profile | `account.json` | name, email, phone, plan, billing |
| Tenant settings | `tables/tenants.json` | workspace metadata |
| Subscribers | `tables/subscribers.json` | every column incl. custom fields |
| Lists / segments | `tables/topics.json`, `tables/segments.json` | segment AST as JSON |
| Campaigns | `tables/campaigns.json`, `tables/campaign_archive.json` | campaign metadata and archive rows |
| Sequences | `tables/voice_sequences.json` | full sequence records + generated content |
| Voice profile | `tables/voice_profiles.json` | voice profile + ingested sources index |
| Voice samples | `tables/voice_items.json` | original ingested text rows |
| Inbox Reality | deliverability report tables when configured | aggregated reports |
| Audit log | `tables/audit_log.json` | every action ever taken on this tenant |
| Stripe (paid subs) | `tables/migration_paid_subscriptions.json` | mirrored subscription registry only |
| Listmonk-side data | exported through Moosewave mirror tables where present | direct Listmonk admin export is optional support-only evidence |
| Manifest | `manifest.json` | table counts, generation timestamp, export format version |

## What is NOT included

- Other tenants' data (RLS prevents this; verified by the export job
  running as a non-superuser role).
- Internal Moosewave audit trails (DPO-only access).
- Aggregated/anonymized telemetry that has been de-identified per our
  privacy policy.
- Backups (we cannot extract a single tenant's data from a full DB
  backup; if a regulator requires this, escalate to legal).

## Investigation (red flags)

- The request comes from an unverified email → verify identity first.
- The export job logs `RLS bypass attempted` → STOP. Treat as
  `database-incident.md` Class C.
- Hash mismatch on manifest → STOP. Re-run the job.

---

## Post-mortem template (only for SLA breaches)

```
## Subject Access Request — <request_id>
**Region:** <region>     **SLA:** <days>     **Actual time:** <days>

### Why we missed (or nearly missed) SLA

### Process improvements
- [ ] Pre-built export endpoint per resource (avoid one-off scripts)
- [ ] Identity-verification flow not interrupting the response timer
- [ ] DPO bench depth (cover when on-call is OOO)
```

## Communication templates

Acknowledgment (within 72h):

> Subject: We've received your data request
>
> Hi <name>, this is to confirm we received your request to export the
> data we hold about <tenant>. We'll deliver this to you by <date> (your
> region's statutory deadline is <date>; we aim to be faster).
>
> If your request was made on behalf of one of your subscribers, please
> note that we hold subscriber data on your instruction; we will export
> it to you, the account holder, who can then forward to your subscriber.
>
> If you have questions in the meantime: privacy@moosewave.com.

Delivery:

> Subject: Your Moosewave data export is ready
>
> We've prepared your data export. Download it here:
> <one-time URL — expires <date>>.
>
> The file is encrypted. You'll receive the passphrase by SMS to <num>
> shortly (separate channel for security).
>
> Inside the bundle you'll find a `manifest.json` listing every file
> and its row counts. If anything looks off, reply to this email.

Identity verification (when needed):

> Before we can export data tied to <tenant>, we need to confirm you're
> authorized. Please reply to this email from <email-on-file>, OR
> complete a 2FA challenge at <url>, OR (for EU residents whose email
> is shared) book a 5-minute video verification: <calendly>.
>
> This step is required by GDPR Article 12(6) when we have reasonable
> doubt about identity.
