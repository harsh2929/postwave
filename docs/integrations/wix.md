# Wix Forms and Contacts Native Integration

Moosewave's Wix lead/CMS connector is a self-managed Wix app integration for Wix Forms and Wix Contacts. It supports app-instance OAuth token minting, cursor-paginated REST backfill, scheduled bounded backfills with retry cursors, signed JWT webhook ingest, install/remove lifecycle handling, ID-only webhook fetch fallback, contact-delete evidence, shared-secret bridge payloads for tests, durable webhook idempotency, and unified Integrations facade health/contract metadata. The local native runtime is complete; `RuntimeAvailable` still requires live Wix dev-site certification evidence.

## Runtime Endpoints

- Public webhook callback: `/api/public/lead-integrations/wix/webhooks`
- Admin create/update: `/api/v1/lead-integrations`
- Manual sync: `/api/v1/lead-integrations/{id}/sync`
- Backfill: `/api/v1/lead-integrations/{id}/backfill`
- Pause: `/api/v1/lead-integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/lead-integrations/{id}`

## Wix App Setup

1. Create or open the Moosewave Wix app in the Wix app dashboard.
2. Capture the app OAuth values: app ID, app secret, and the installed app `instanceId`.
3. In the Wix app dashboard Webhooks section, copy the public key and store it in the Moosewave secret vault.
4. Subscribe the app to the lead and lifecycle events Moosewave handles:
   - `wix.app.v1.instance.installed`
   - `wix.app.v1.instance.removed`
   - `wix.forms.v4.submission.created`
   - `wix.forms.v4.submission.updated`
   - `wix.contacts.v4.contact.created`
   - `wix.contacts.v4.contact.updated`
   - `wix.contacts.v4.contact.deleted`
5. Configure every subscribed webhook callback URL as:
   - `https://<postwave-public-host>/api/public/lead-integrations/wix/webhooks`
6. Grant the app permissions for Contacts read access, Forms read access, Forms submissions read access, Manage Your App, and webhook delivery.
7. Store credentials in a secret reference, not in integration settings.

Example credential secret:

```json
{
  "client_id": "WIX_APP_ID",
  "client_secret": "WIX_APP_SECRET",
  "instance_id": "WIX_APP_INSTANCE_ID",
  "app_id": "WIX_APP_ID"
}
```

Example integration payload:

```json
{
  "provider": "wix",
  "name": "Wix primary site",
  "status": "connected",
  "credentials_ref": "vault://integrations/wix/primary",
  "settings": {
    "site_id": "WIX_SITE_ID",
    "instance_id": "WIX_APP_INSTANCE_ID",
    "credentials_ref": "vault://integrations/wix/primary",
    "webhook_public_key_ref": "vault://integrations/wix/webhook-public-key",
    "form_id": "optional-form-id",
    "namespace": "wix.form_app.form"
  }
}
```

## Validation Checklist

- Install the Wix app on a dev site and confirm the `instanceId` is stored on the Moosewave integration.
- Run an empty backfill request and confirm submissions are imported first, followed by contacts.
- Confirm the scheduled `wix-lead-backfill-worker` picks up stale `connected` or `error` integrations and records scheduled sync runs.
- Force a Wix `429` or `5xx` response with `Retry-After` and confirm Moosewave stores a `wix_retry:` cursor with attempts, next attempt time, last status, and last error; confirm manual empty `/sync` and `/backfill` skip not-due retry cursors, resume due retry cursors, and store provider/sync failure retry state.
- Disconnect the row and confirm manual `/sync` and `/backfill` return `409 integration_disconnected`; scheduled continuation should skip provider calls and stale run recording should not revive the disconnected row.
- Submit a Wix form and confirm a signed JWT webhook creates exactly one lead event.
- Replay the same webhook and confirm Moosewave returns `200` without ingesting a duplicate event.
- Update a contact and confirm ID-only webhook payloads fetch the full contact before upsert.
- Delete a contact and confirm Moosewave verifies and dedupes the signed delivery as provider evidence without attempting to upsert a partial profile.
- Confirm the Wix Forms app is installed on the site before relying on Form Submission API pulls.
- Uninstall the app and confirm Moosewave moves the integration to `needs_auth`.
- Reinstall the app and confirm the signed app-installed lifecycle webhook moves the integration back to `connected`.
- Rotate the Wix webhook public key in the vault and repeat webhook delivery.
- Open `/api/v1/integrations/wix/health` and confirm the unified facade reports `native_runtime_complete_live_certification_pending` through the contract, with Wix app uninstall and contact-delete evidence surfaced in the privacy/data-delete metadata.

## Source Notes

Wix documents app REST authentication through app ID, app secret, and app instance ID at `POST https://www.wixapis.com/oauth2/token`; Moosewave accepts both direct token responses and Wix gateway-style `body` wrappers. The Forms API documents namespace-based form submission querying and individual submission retrieval, and notes that the Form Submission API works with the Wix Forms app. The Contacts V4 API documents contact query/get endpoints and contact lifecycle events. Wix self-managed webhooks are delivered as signed JWT payloads and must be verified with the app dashboard public key. Wix documents duplicate and resent webhook delivery behavior, so Moosewave claims each webhook in `lead_webhook_events` before ingest.
