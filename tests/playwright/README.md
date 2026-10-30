# Moosewave Playwright Suite

Browser-driven end-to-end tests for the Moosewave web app. Complements the
Go-level journey tests under `tests/e2e/` by exercising the rendered UI on
desktop, phone, and tablet viewports across Chromium, Firefox, and WebKit.

## Layout

```
tests/playwright/
  package.json              # pinned Playwright + axe-core versions
  playwright.config.ts      # Chromium/Firefox/WebKit desktop + phone/tablet projects
  fixtures/
    test-data.ts            # seed data helpers, constants
  helpers/
    auth.ts                 # loginAsDemo via the dev-mode bypass
    wait.ts                 # waitForNonEmptyText, waitForApi, retry
  tests/
    auth.spec.ts
    dashboard.spec.ts
    campaigns.spec.ts
    template-editor-workflow.spec.ts
    migrations.spec.ts
    sequence-builder.spec.ts
    settings.spec.ts
    subscriber-drilldown.spec.ts
    tour.spec.ts
    status-page.spec.ts
    docs.spec.ts
    a11y.spec.ts
```

## Prerequisites

1. The base + full docker-compose overlays running the API dependencies, plus
   the web development server with local auth bypass:

   ```bash
   docker compose -f infra/docker-compose.yml -f infra/docker-compose.full.yml up -d --wait api
   API_URL=http://127.0.0.1:8080 POSTWAVE_API_URL=http://127.0.0.1:8080 \
     POSTWAVE_LOCAL_AUTH_BYPASS=1 pnpm --filter @postwave/web dev
   ```
2. Node 20+, pnpm 9+.
3. Playwright browsers installed: `pnpm install:browsers`.

## Running locally

From this directory:

```bash
pnpm install
pnpm install:browsers
pnpm test                     # all projects, headless
pnpm test:desktop             # chromium-desktop only
pnpm test:mobile              # chromium-mobile only
pnpm test:headed              # see what the browser is doing
pnpm test:debug               # step through with the inspector
pnpm report                   # open the last HTML report
```

Filter by file or grep:

```bash
pnpm test tests/auth.spec.ts
pnpm test --grep "magic-link"
```

Point at a disposable non-production stack that has the local-test auth
bypass enabled. Do **not** run the general suite against shared Moosewave
staging or production; many specs mutate tenant data.

```bash
POSTWAVE_E2E_URL=https://preview.moosewave.example.com pnpm test
```

### Authenticated staging template persistence

`staging-template-persistence.spec.ts` is an opt-in write smoke for the
disposable staging account. It is skipped unless all three environment
variables below are set; do not commit credentials or pass them in CI logs.
It creates/reopens/edits/duplicates a template and creates a campaign draft,
then deletes that exact draft and archives only its own templates. Archived
templates remain recoverable. The test does not send email.

```bash
export MOOSEWAVE_STAGING_TEST_EMAIL='your-disposable-staging-email'
export MOOSEWAVE_STAGING_TEST_PASSWORD='your-disposable-staging-password'
MOOSEWAVE_STAGING_WRITE_SMOKE=1 pnpm exec playwright test \
  tests/staging-template-persistence.spec.ts --project=chromium-desktop
```

Run `--project=chromium-mobile` for the phone journey. The read-only
`staging-template-release.spec.ts` remains safe to run separately without
enabling writes.

## Debugging tips

- A failed run drops traces under `test-results/` — `pnpm exec playwright show-trace <path>` to step through.
- Screenshots are taken on failure only. Set `PWDEBUG=1` to enable the inspector.
- `pnpm test:headed -- --slow-mo=200` slows down everything when something flickers.
- The dev-mode bypass uses a cookie + `X-Tenant-Slug` header. If a test mysteriously lands on the login page, confirm `POSTWAVE_LOCAL_AUTH_BYPASS=1` is set on the API container.

## Conventions

- Prefer role + accessible name selectors (`getByRole`, `getByLabel`) over CSS.
- Use `data-testid` only where role/label addressing is ambiguous.
- The tour helpers rely on `data-tour="<step>"` attributes the tour component already sets — never add new tour attributes from tests.
- A11y tests filter to `critical` + `serious` severity; `moderate` and `minor` violations are logged but not failed.
- Tests should be tenant-isolated. Seed data into the `demo` tenant via `seedSampleData()` rather than mutating production-shaped tables.
- `template-editor-workflow.spec.ts` tests the current editor on all configured
  browser projects: HTML file import and complete create payload, explicit
  mailbox rendering and stale-preview invalidation, and the MJML compile gate.
  Its MJML route is stubbed because `/api/mjml` correctly requires a real
  `pw_session`; `apps/web/src/__tests__/mjml-route.test.ts` covers the route
  boundary. The live save/reopen path additionally needs a current migrated
  local database and is exercised by the persistence journeys elsewhere in
  this suite. Do not point this tenant-bypass spec at staging.

## CI

`.github/workflows/playwright.yml` boots the API stack and web dev server,
seeds sample data, and runs Chromium desktop/mobile/tablet, Firefox desktop,
and WebKit desktop/mobile projects. Failures upload the HTML report + traces as
artifacts.
