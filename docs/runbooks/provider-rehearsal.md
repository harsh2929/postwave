# External Provider Rehearsal

This runbook is for staging/private-beta rehearsals only. Do not use production
customer data or production sending domains while exercising it.

No command in this runbook certifies a provider for generally available use.
The repository currently contains no target-account live certification
evidence. Until credentialed staging results and accountable approval are
attached to the release candidate, provider-dependent features must remain
unavailable, read-only, or conditional according to the production supported-
feature matrix. Merely setting credentials is not a promotion decision.

## Local Preflight

Run the non-strict preflight before every release candidate:

```sh
pnpm providers:preflight
```

It verifies that the repo documents every required provider secret. It does not
call third-party APIs and it does not require real credentials.

Run strict mode only in a credentialed staging shell:

```sh
node scripts/providers/rehearsal-preflight.mjs --strict
```

Strict mode validates that required values are present. It does not call the
providers or prove outage, rate-limit, webhook replay/signature, credential
revocation, reconciliation, or rollback behavior. Record those results
separately for the exact release candidate before any GA approval.

## Dodo Payments

Required values:

- `BILLING_PROVIDER=dodo`
- `DODO_PAYMENTS_ENVIRONMENT` (`test_mode` for rehearsal, `live_mode` for launch)
- `DODO_PAYMENTS_API_KEY`
- `DODO_PAYMENTS_WEBHOOK_KEY`
- `DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY`
- `DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY`
- `DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY`

The three Product IDs must be distinct. Configure the Dodo Payments webhook at
`/api/public/dodo/webhook`. The API creates hosted Checkout and Customer Portal
sessions; it does not consume static payment links.

> **Commercial-configuration blocker:** code and current public copy treat LTD
> as $349 one-time, Sending as $29/month, and Pro as $79/month. Exact live
> Products still have to be created and independently verified. The
> advertised per-1K overages also have no qualified metered-usage or
> invoice-item reporting path; implement and rehearse that path, or change the
> product policy/copy to block or top up at the included limit before launch. A
> `pdt_...` identifier alone cannot prove amount, recurrence, product, tax
> behavior, or live-mode ownership.

Rehearsal:

1. Start the local Docker stack.
2. Configure the test-mode webhook endpoint and subscribe it to payment,
   subscription, and refund lifecycle events.
3. Complete one-time and subscription checkouts, then exercise payment failed,
   renewal, plan change, cancellation, expiry, and refund events.
4. Open the authenticated Customer Portal and confirm Dodo Payments creates a
   customer-bound session; exercise each enabled billing action against a
   rehearsal customer.
5. Retrieve each live Product from Dodo Payments and record its active/live-mode
   state, currency, amount, tax behavior, and billing interval.
6. Confirm billing state, audit log rows, dunning behavior, and idempotent
   retries.

## Mailchimp

Required values:

- `MAILCHIMP_CLIENT_ID`
- `MAILCHIMP_CLIENT_SECRET`
- `OAUTH_REDIRECT_URI`
- `POSTWAVE_MIGRATION_SESSION_KEK`

Rehearsal:

1. Use a sandbox Mailchimp account with a synthetic audience only.
2. Start OAuth from the migration UI.
3. Confirm state validation, encrypted session storage, discover counts,
   dry-run report, commit, rollback, and retry idempotency.
4. Compare output to `packages/migrate/fixtures/mailchimp/audience.csv`.

## Kit/ConvertKit

Required values:

- `CONVERTKIT_CLIENT_ID`
- `CONVERTKIT_CLIENT_SECRET`
- `OAUTH_REDIRECT_URI`
- `POSTWAVE_MIGRATION_SESSION_KEK`

Rehearsal:

1. Use a sandbox Kit account with test subscribers, tags, forms, sequences, and
   at least one paid-subscription path through Stripe Connect.
2. Exercise OAuth, discover, dry-run, commit, rollback, and a second commit of
   the same data.
3. Compare output to `packages/migrate/fixtures/convertkit/subscribers.csv`.

## Beehiiv, MailerLite, Substack, CSV

Required values depend on the source:

- Beehiiv: source API key and publication ID in the migration session.
- MailerLite: source API key in the migration session.
- Substack: official ZIP export or an All-columns subscriber CSV. Rehearse
  Stripe/Apple billing as a separate publication-bound provider handoff; the
  file importer accepts no Stripe account reference.
- CSV: uploaded CSV fixture.

Rehearsal:

1. Run the adapter against the sanitized fixture that matches the source.
2. Confirm the verification report explains unsupported objects instead of
   silently dropping them.
3. Confirm assisted-beta sources are labeled as assisted-beta in the UI and
   migration report.

## Shopify

Required values:

- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_OAUTH_REDIRECT_URL`
- `SHOPIFY_STATE_SECRET`
- `SHOPIFY_WEBHOOK_SECRET`

Rehearsal:

1. Use a Shopify development store.
2. Complete OAuth, then verify signed webhook receipt for customers, products,
   orders, and uninstall events.
3. Confirm unsigned webhooks are rejected and replayed webhook IDs are
   idempotent.

## Deliverability AI, Rendering, and DMARC

Required values:

- `GEMINI_API_KEY`
- `DIAGNOSTICIAN_PROMPTS_PATH`
- `DIAGNOSTICIAN_EVAL_CASES_PATH`
- `HCTI_USER_ID`
- `HCTI_API_KEY`
- `DMARC_IMAP_HOST`, `DMARC_IMAP_USER`, and `DMARC_IMAP_PASSWORD` (or
  `DMARC_IMAP_PASSWORD_SECRET_NAME`) only in an isolated non-production
  parser/IMAP rehearsal; there is no separate legacy-ingestion toggle, so
  leave all of them unset everywhere else
- `SEEDLIST_CONNECTOR` (`imap` or `vendor`)
- `SEEDLIST_CONFIG_PATH` or `POSTWAVE_SEEDLIST_IMAP_JSON`
- `SEEDLIST_VENDOR_API_URL` when `SEEDLIST_CONNECTOR=vendor`

Rehearsal:

1. Run deliverability diagnosis against a synthetic campaign with no customer
   message body.
2. Generate render previews through HCTI.
3. Ingest a synthetic DMARC aggregate report from an isolated staging mailbox;
   record that this does not qualify tenant authority, external reporting
   authorization, report-email authentication, or production readiness.
4. Poll one seed-list mailbox with a synthetic `X-Postwave-Test-ID`
   message and confirm placement is written without logging credentials.
5. Confirm logs redact tokens, message bodies, and mailbox credentials.

## Email Sending

Required values:

- `POSTWAVE_MAILER`
- `POSTWAVE_AUTH_FROM_ADDRESS`
- `POSTMARK_ACCOUNT_TOKEN` or `AWS_SES_REGION`
- `DKIM_ROOT_DOMAIN`

Rehearsal:

1. Send verification, password-reset, and magic-link emails to seed inboxes.
2. Send one sandbox campaign and confirm bounce, complaint, unsubscribe, and
   suppression ingestion.
3. Confirm rate limits and plan send limits block overages with user-visible
   errors.

## SMS Pilot Sending

Required for all SMS rehearsals:

- `POSTWAVE_PUBLIC_BASE_URL`
- `SMS_DEFAULT_PROVIDER` (`twilio`, `telnyx`, or `bandwidth`)

Twilio required values:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER`
- `TWILIO_WEBHOOK_AUTH_TOKEN`
- `TWILIO_STATUS_CALLBACK_URL`

Telnyx required values:

- `TELNYX_API_KEY`
- `TELNYX_MESSAGING_PROFILE_ID` or `TELNYX_FROM_NUMBER`
- `TELNYX_PUBLIC_KEY`
- `TELNYX_WEBHOOK_URL`

Bandwidth required values:

- `BANDWIDTH_ACCOUNT_ID`
- `BANDWIDTH_API_USERNAME`
- `BANDWIDTH_API_PASSWORD`
- `BANDWIDTH_APPLICATION_ID` or `BANDWIDTH_FROM_NUMBER`
- `BANDWIDTH_WEBHOOK_TOKEN` or `BANDWIDTH_WEBHOOK_USERNAME` and `BANDWIDTH_WEBHOOK_PASSWORD`

Rehearsal:

1. Create one sender profile for the selected provider and verify the callback
   URL shown by `/api/v1/sms/setup`.
2. Run `pnpm sms:callbacks:replay -- --provider <provider> --fixture stop`,
   then repeat with `start`, `help`, `reply`, `delivered`, and `failed`.
3. Run `pnpm test:pilot:smoke` with `POSTWAVE_SMS_SENDER_ID` set for the exact
   sender profile.
4. Do not send a customer audience until
   `/api/v1/sms/senders/{id}/pilot-certification` returns `can_pilot=true`.
