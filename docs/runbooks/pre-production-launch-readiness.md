# Pre-Production Launch Readiness

Date: May 12, 2026

Scope: checks to complete before any public launch or production deploy. This
runbook intentionally stops before AWS deployment. It is for local Docker,
staging, CI, and human approval gates.

## Non-Negotiable Rule

No feature may silently substitute demo, mock, or placeholder behavior in a
production environment. If a provider credential or operator choice is missing,
the system must fail closed with a clear setup error.

## 1. Provider Decisions

| Area            | Required before public launch                                                                           | Current guard                                       |
| --------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Auth            | `POSTWAVE_AUTH_HMAC_PEPPER`, `POSTWAVE_MAILER=ses`, verified `POSTWAVE_AUTH_FROM_ADDRESS`               | authenticated `/api/internal/ops/readiness` report  |
| Email sending   | Postmark account token or SES region/credentials, DKIM root domain                                      | readiness sending group                             |
| Billing         | Live Stripe key, webhook secret, and distinct approved LTD/Sending/Pro Price IDs                        | readiness billing group + AWS deployment contract   |
| Migration OAuth | Mailchimp and Kit/ConvertKit client IDs/secrets when one-click OAuth is offered                         | migration-sidecar task/Secrets Manager contract     |
| Commerce        | Shopify app credentials, redirect URL, webhook secret                                                   | readiness commerce group                            |
| AI/rendering    | `GEMINI_API_KEY`, HCTI credentials, seed-list config, DMARC IMAP config where deliverability is offered | deliverability-sidecar startup/deployment contracts |

## 2. Local Verification Commands

Run these from the repo root before tagging a release candidate:

```sh
pnpm gate:prelaunch:local
pnpm audit:openapi
pnpm audit:sdk-parity
```

The gate runs route parity, OpenAPI YAML/JSON sync, production-readiness
static checks, fail-closed production dependency-audit fixtures and the live
registry audit, tenant/abuse hardening checks, provider rehearsal preflight,
SDK parity checks, launch-decision register validation, the core Go service
test slice, Python SDK contract tests, web typecheck, and docs build. It does
not deploy or touch AWS.

Use Docker for full-stack smoke tests:

```sh
pnpm test:e2e:docker:release
pnpm test:load:local
```

For a credentialed staging shell and a true public-launch checklist, run the
strict gates:

```sh
pnpm providers:preflight:strict
pnpm launch:decisions:strict
```

The strict provider and launch-decision gates are intentionally not part of the
default local prelaunch gate because they require live provider credentials and
founder/business sign-off. They are mandatory but not sufficient for a real
public launch: provider preflight checks configuration presence, not live
behavior. The exact release candidate also needs credentialed staging evidence
for success, outage, throttling, signed/replayed webhooks, revocation,
reconciliation, and rollback. Without it, the applicable feature remains
unavailable/read-only/conditional and may not be marketed as GA.

## 3. UI/UX Release Gate

- Dashboard menus must navigate only to routes that exist.
- Demo write actions must be hidden or disabled unless an explicit local/demo
  flag is set.
- Any chart using estimated, sampled, synthetic, or mock data must label that
  status next to the chart, not only in tooltip copy.
- Migration pages must distinguish production-supported, assisted beta, and
  unsupported sources.
- Store/mobile/desktop builds must include current privacy, support, and
  deletion links.

## 4. API/SDK Contract Gate

- `pnpm audit:openapi` must report zero spec-only routes and
  every gateway-only route must be classified in
  `packages/openapi/route-contracts.json`.
- OpenAPI YAML and JSON must be in sync.
- TypeScript SDK methods must target live gateway routes or return explicit
  unsupported/setup errors.
- Python SDK must expose every TypeScript SDK resource namespace; run
  `pnpm audit:sdk-parity` whenever either SDK adds a resource file.
- New stream endpoints must use the short-lived stream-token/SSE contract and
  tenant context only; never trust tenant IDs in query strings.

## 5. Migration Compatibility Gate

For each source platform promised on the pricing/marketing surface:

- Run a dry-run against at least one real export/account fixture.
- Verify subscriber counts, suppression counts, custom fields, tags/groups,
  campaign archive count, and automation translation warnings.
- Confirm idempotency by retrying the same job and checking duplicate counts.
- Confirm rollback status and audit log entries.
- Document known unsupported objects in the migration report.
- Keep sanitized launch fixtures current in `packages/migrate/fixtures`; the
  adapter fixture test is part of `go test ./packages/migrate/...`.

## 6. Deliverability Gate

- Verify DKIM/SPF/DMARC/BIMI/PTR checks against a real customer-owned domain.
- Confirm `DELIVERABILITY_SERVICE_URL` is not the localhost default in
  production readiness output.
- Confirm `GEMINI_API_KEY`, `HCTI_USER_ID`, and `HCTI_API_KEY` are present in
  the deliverability task's secret set—not the API task—for environments that
  offer Inbox Reality.
- Keep `DMARC_IMAP_HOST`, `DMARC_IMAP_USER`, `DMARC_IMAP_PASSWORD` and
  `DMARC_IMAP_PASSWORD_SECRET_NAME` absent from every production task; there
  is no legacy-ingestion toggle, so their presence is the only thing that
  enables IMAP polling. DMARC aggregate reporting remains unavailable until a
  trusted SMTP-recipient and authentication-verdict transport, external
  reporting authorization, opaque domain-bound recipients, and end-to-end
  readiness evidence exist. IMAP credentials alone do not satisfy this gate.
- Confirm bounce/complaint/list-unsubscribe events land in suppressions.
- Confirm seed-list credentials are absent in local dev and present only in
  secrets management for staging/production.
- Confirm verbose logs do not include message bodies, OAuth tokens, API keys,
  or raw webhook secrets.

## 7. Release Packaging Gate

- Desktop updater must stay disabled unless the updater public key and signed
  manifest process are finalized.
- Mobile builds must include store-ready privacy labels and delete-account
  paths before submission.
- Package releases must pin the exact git SHA in release notes.
- Backend deploy artifacts must be image-digest or SHA-tag based; never rely on
  `latest` for production rollback.

## 8. Observability Gate

- Grafana release overview dashboard exists at
  `infra/grafana/dashboards/postwave-release-overview.json`.
- Core alert rules exist at `infra/grafana/alerts/release_core.yml`.
- On-call runbooks must cover API 5xx, latency, outbox backlog, send-loop
  silence, billing webhook dead-lettering, migration failures, and outbound
  webhook failures.

## 9. Human Approval Still Required

- Final pricing and lifetime-plan policy.
- Provider account creation and credential rotation ownership.
- Legal review of ToS, Privacy Policy, DPA, sub-processors, and store labels.
- Choice of assisted-beta versus public promise for Substack, Beehiiv, and
  MailerLite.
- Public launch date and support coverage window.
