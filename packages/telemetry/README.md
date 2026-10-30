# @postwave/telemetry

One telemetry contract for every Moosewave client — closing the audit's split-consent, missing-breadcrumb-redaction, and divergent-event-name findings.

## What it provides

- **SDK-free Sentry redaction** — `redactEvent` (body/cookies/sensitive-headers/query/url) and `redactBreadcrumb` (the fetch/navigation URL fields **web + mobile were not redacting**, only desktop was). Pure functions, unit-tested in plain Node; wire into `beforeSend` / `beforeBreadcrumb`.
- **Uniform consent** — `TELEMETRY_CONSENT_DEFAULT` is `denied` and `shouldCapture(consent)` only returns true on an explicit `granted`. The audit found consent defaulted opt-IN on web but opt-OUT on desktop/mobile, with no web consent surface (a GDPR liability); this makes the gate identical everywhere.
- **Canonical event taxonomy** — `EVENTS` + `isKnownEvent`, replacing inline string literals so PostHog event names can't diverge or double-emit across web/desktop/mobile/api.

```ts
import { redactEvent, redactBreadcrumb, shouldCapture, EVENTS } from "@postwave/telemetry";

Sentry.init({ beforeSend: redactEvent, beforeBreadcrumb: redactBreadcrumb });
if (shouldCapture(consent)) posthog.capture(EVENTS.CAMPAIGN_SENT, { ... });
```

## Adoption

Each client's `sentry.ts` re-exports `redactEvent`/`redactBreadcrumb` from here (web + mobile gain breadcrumb redaction); PostHog init reads `shouldCapture`; capture sites import names from `EVENTS`.
