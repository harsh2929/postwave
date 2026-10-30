# @postwave/web

Moosewave admin app — Next.js 15 + React 19 + Tailwind + shadcn/ui.

Licensed as part of Moosewave's AGPL-3.0-only application layer. See the root
`LICENSE` and `LICENSE-BOUNDARY.md`.

## What this is

The admin/dashboard surface for Moosewave: subscribers, campaigns, migrations,
Inbox Reality, voice sequences, settings. Talks to the Moosewave Go API
(`apps/api`), which communicates with the separately running upstream
Listmonk process over HTTP. See the current ADR in `docs/decisions.md` and the
path policy in `LICENSE-BOUNDARY.md`; `plan.md` is historical.

## Dev commands

```bash
pnpm install         # from repo root
pnpm --filter @postwave/web dev        # http://localhost:3000
pnpm --filter @postwave/web dev:qa     # bounded local QA, http://127.0.0.1:3000
pnpm --filter @postwave/web build
pnpm --filter @postwave/web start
pnpm --filter @postwave/web lint
pnpm --filter @postwave/web typecheck
pnpm --filter @postwave/web test
pnpm --filter @postwave/web env:check
```

Use `dev:qa` for long manual QA sessions. It sets a 2 GiB JavaScript heap
budget, limits Webpack compilation parallelism to four, and disables Node's
source-map processing. The QA configuration releases inactive page entries
after ten seconds and lets the filesystem cache reclaim oversized buffers.
Next's development worker can restart when its heap approaches the budget;
reload the current page if a restart interrupts a request. Total process RAM
also includes native buffers, so the heap budget is not a 2 GiB RSS limit.
On macOS and Linux the launcher also checks the RAM used by its own process
tree every ten seconds. Two consecutive samples above 3.5 GiB recycle that
server. After three recycles within five minutes, another breach stops the
server with an error instead of repeatedly restarting a route that cannot fit.
The QA launcher also forces real API mode (`NEXT_PUBLIC_USE_MOCKS=0`), even
when `.env.local` enables fixtures. Use the local database's sample workspace
for demo content so campaign edits persist and planner/report IDs agree.

The app browser talks to same-origin `/api/*`. The Next API proxy forwards
those requests to `API_URL` or `POSTWAVE_API_URL` on the server side
(default `http://localhost:8080`). Copy `.env.example` to `.env.local` to
override local server-only origins.

## Env flags

- `API_URL` / `POSTWAVE_API_URL` — server-only Go API base URL used by the
  Next `/api/*` proxy and server-side public page fetchers.
- `NEXT_PUBLIC_API_URL` — legacy/public archive URL escape hatch only. Do not
  set this for app browser builds; authenticated browser calls must stay
  same-origin through `/api/*`.
- `POSTWAVE_TENANT_SLUG` / `NEXT_PUBLIC_TENANT_SLUG` /
  `NEXT_PUBLIC_POSTWAVE_TENANT_SLUG` — optional dev tenant slug sent as
  `X-Tenant-Slug` when the API enables `POSTWAVE_DEV_TENANT_SLUG_HEADER=1`.
- `NEXT_PUBLIC_API_TIMEOUT_MS`, `POSTWAVE_API_PROXY_TIMEOUT_MS`,
  `POSTWAVE_API_STREAM_TIMEOUT_MS`, `POSTWAVE_API_EXPORT_TIMEOUT_MS`,
  `POSTWAVE_API_PROXY_MAX_BODY_BYTES`, and
  `POSTWAVE_PUBLIC_PAGE_TIMEOUT_MS` / `NEXT_PUBLIC_PUBLIC_PAGE_TIMEOUT_MS` —
  request timeout and proxy body-limit tuning. Workspace-export downloads use
  the dedicated 30-minute lane so the ordinary JSON timeout cannot truncate a
  large authenticated ZIP. Empty values use the code defaults from
  `.env.example`.
- `NEXT_PUBLIC_USE_MOCKS=1` — force mock-backed API clients to skip the network
  and serve local development fixtures. This is an explicit, development-only
  mode: clients do not fall back to mocks when a real backend request fails,
  and `env:check` rejects the flag in CI and production.
- `NEXT_PUBLIC_ENABLE_COMPAT_DEMO_ACTIONS=1` — enables compatibility demo
  writes in local/demo environments only. `env:check` rejects this and the
  old production-demo escape hatch in production-like environments.
- `SENTRY_DSN_WEB` / `NEXT_PUBLIC_SENTRY_DSN_WEB` — server/edge and browser
  Sentry DSNs. `SENTRY_ORG`, `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN` are
  optional CI-only source-map upload credentials.
- `POSTWAVE_PUBLIC_RELEASE_APPROVAL` — server-only public-publication gate.
  Empty or malformed values keep the entire site `noindex`, remove the sitemap,
  and keep draft legal/comparison routes unavailable. Set
  `approved:<release-record-reference>` only after the referenced release
  record approves legal, product, provider, and operational publication.
- `NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY` (a public, tenant-bound `pwk_` key)
  plus `NEXT_PUBLIC_POSTWAVE_API_BASE_URL` — optional for local development,
  but required by the canonical production image so cookie choices cannot be
  applied locally while silently skipping the server evidence ledger.
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` — optional Web Push client fallback; backend
  VAPID config wins when present.
- `POSTWAVE_APPLE_TEAM_ID`, `POSTWAVE_IOS_BUNDLE_ID`,
  `POSTWAVE_ANDROID_PACKAGE_NAME`, and
  `POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS` — mobile universal/app link
  association metadata; team ID and Android fingerprints are required by
  `env:check` for production deployments.
- `POSTWAVE_AUTH_BYPASS=1` / `POSTWAVE_LOCAL_AUTH_BYPASS=1` — dev-only auth
  shortcuts. `env:check` rejects these in CI/production.

`env:check` validates the current environment and `.env.example` against the
shared schema in `scripts/env-schema.mjs`; add new runtime env vars there first.

## Routes

The app has two top-level route groups:

- `(marketing)` — public, no auth, marketing-shell layout (header + footer).
- `(dashboard)` — authenticated app, sidebar + top-bar layout.

### Marketing (public)

| Path                        | Purpose                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `/`                         | Landing page (hero, three pillars, pricing compare)          |
| `/features`                 | Per-pillar feature deep-dive                                 |
| `/pricing`                  | Three-tier comparison + add-ons + 12-FAQ accordion           |
| `/migrations`               | Migration overview + per-source cards                        |
| `/migrations/[from]`        | Per-source landing (mailchimp, substack, beehiiv,            |
|                             | convertkit, mailerlite)                                      |
| `/about`                    | Minimal about page                                           |
| `/legal/terms`              | Terms of Service — 19-section working draft, pending counsel |
| `/legal/privacy`            | Privacy Policy — 13-section working draft, pending counsel   |
| `/legal/dpa`                | DPA (incl. 4 annexes) — working draft, pending counsel       |
| `/legal/account-deletion`   | Account deletion request path for store compliance           |
| `/legal/affiliate-terms`    | Closed-status notice; no affiliate terms are in force        |
| `/affiliates`               | Closed-status notice; applications and tracking unavailable  |

### Dashboard (auth)

| Path                            | Purpose                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `/app`                          | Live overview counts, activity, onboarding, and system status  |
| `/subscribers`                  | Subscriber list/search/create/suppress                         |
| `/campaigns`                    | Campaign drafts, editor, test sends                            |
| `/migrations`                   | Source picker + recent migrations list                         |
| `/migrations/new/[source]`      | 5-step migration wizard                                        |
| `/migrations/oauth/callback`    | OAuth redirect handler                                         |
| `/inbox-reality`                | Reputation + auth + recent campaigns                           |
| `/inbox-reality/campaigns/[id]` | Inbox Reality Report + AI Diagnostician                        |
| `/inbox-reality/predict`        | Pre-send predictor (paste HTML + subject)                      |
| `/sequences`                    | Voice sequences list (Active / Drafts)                         |
| `/sequences/new`                | Template picker (filterable grid)                              |
| `/sequences/new/[templateId]`   | 3-step generation flow                                         |
| `/sequences/[id]`               | Sequence editor (left rail + editor)                           |
| `/sequences/voice-profile`      | Voice profile + sources                                        |
| `/templates`                    | Template browser                                               |
| `/templates/[id]`               | Template preview                                               |
| `/templates/new`                | Author a template (V1 form)                                    |
| `/forms`                        | Forms list (Phase 3)                                           |
| `/forms/new`                    | Create a new form                                              |
| `/forms/[id]`                   | Builder + Settings tabs                                        |
| `/forms/[id]/submissions`       | Submissions table + CSV export                                 |
| `/forms/[id]/embed`             | iframe / popup / inline embed snippets                         |
| `/billing`                      | Current plan, usage, invoices, Stripe portal                   |
| `/billing/upgrade`              | Three-tier comparison + checkout                               |
| `/affiliates`                   | Fail-closed affiliate-operations status; loads no records       |
| `/affiliates/[id]`              | Fail-closed stale-link notice; performs no record lookup         |
| `/settings`                     | General (workspace + locale + reply-to)                        |
| `/settings/sender`              | Sender identity + DKIM/SPF/DMARC preview                       |
| `/settings/domain`              | Add-domain workflow + verified domains                         |
| `/settings/team`                | Members table + invite + permission map                        |
| `/settings/api`                 | API keys with scoped permissions                               |
| `/settings/webhooks`            | Webhook URLs + event subs + signing key                        |
| `/settings/notifications`       | Per-category channel preferences                               |
| `/settings/privacy`             | Retention policy + GDPR export + delete                        |

Public hosted form pages live OUTSIDE the dashboard route group:

| Path                            | Purpose                            |
| ------------------------------- | ---------------------------------- |
| `/forms/[slug]`                 | Public hosted form (no auth)       |
| `/forms/[slug]/confirm/[token]` | Double opt-in confirmation landing |
| `/forms/success`                | Generic post-submit success page   |

The `apps/web/public/embed.js` script is loaded by third-party sites for
inline + popup embed modes (see Embed page in the dashboard for snippets).

## Migration wizard

Five steps, all client-rendered (state machine in the page component):

1. **Connect** — OAuth, API key, or CSV upload depending on
   `AdapterCapabilities.auth_method`.
2. **Discover** — calls `discover()`, shows a count snapshot of
   subscribers / segments / automations / archive / paid subs.
3. **Dry-run review** — renders `VerificationReport`: data fidelity %, custom
   field mapping table, unsupported automations, segment warnings.
4. **Importing** — `pollJob()` ticks every 2s; per-resource progress bars
   plus a friendly status line.
5. **Done** — success card with a "View subscribers" CTA and a 7-day
   "Rollback" secondary action.

## Code map

```
src/
  app/
    layout.tsx                     # root + <Toaster />
    (marketing)/
      layout.tsx                   # public marketing shell (header + footer)
      page.tsx                     # / — landing
      pricing/page.tsx             # 3-tier compare + add-ons + 12-FAQ
      features/page.tsx            # 3-pillar deep dive
      migrations/page.tsx          # migrations overview
      migrations/[from]/page.tsx   # mailchimp / substack / beehiiv / convertkit / mailerlite
      about/page.tsx
      legal/{terms,privacy,dpa}/page.tsx
    (dashboard)/
      layout.tsx                   # sidebar (collapsible, active route) + top bar
      app/page.tsx                 # /app — overview (was at /, moved so marketing owns /)
      billing/page.tsx             # plan + usage + invoices
      billing/upgrade/page.tsx
      settings/layout.tsx          # left-rail tabs
      settings/page.tsx            # General
      settings/{sender,domain,team,api,webhooks,notifications,privacy}/page.tsx
      migrations/
        page.tsx                   # source picker (RSC)
        new/[source]/page.tsx      # 5-step wizard
        oauth/callback/page.tsx
      subscribers|campaigns|inbox-reality|sequences|settings/page.tsx
  components/
    ui/                            # shadcn primitives (button, card, badge,
                                   #   progress, dialog, input, label,
                                   #   separator, skeleton, alert, tabs, sonner)
    migration/
      stepper.tsx
  lib/
    api.ts                         # app API transport, errors, retry, offline queue
    migration-api.ts               # typed endpoints + explicit dev mock mode
    migration-mocks.ts             # in-memory fakes
    inbox-reality-api.ts
    voice-api.ts
    billing-api.ts                 # billing endpoints + Stripe checkout/portal
    billing-mocks.ts               # tier descriptors + usage / invoice fakes
    types.ts                       # migration domain types (mirror of @postwave/schema)
    utils.ts                       # cn()
```

API boundary rules:

- Authenticated app browser calls stay same-origin through `/api/*`, usually
  via `lib/api.ts` or a domain client built on it.
- Server-only upstream fetches may use `API_URL` / `POSTWAVE_API_URL`.
- Public/marketing exceptions include telemetry, cookie consent, public
  archive assets/RSS/pixel URLs, hosted public pages, and generated embed or
  popup scripts.
- Local generated scripts and the MJML route may call same-origin public
  endpoints directly when that is the feature boundary.

## Marketing site polish

The public-facing marketing surface lives under `src/app/(marketing)/` and
shares a single shell (`(marketing)/layout.tsx`) — sticky header with product
mega-menu, mobile disclosure nav, account CTAs, 5-column footer (Product /
Compare / Resources / Legal / Company), skip-to-content link, and the cookie
banner.

Routes polished in this pass (5-section flow, copy guidelines, no banned
words):

| Route                    | Notes                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `/`                      | 5-section flow: hero / 3 pillars / pricing teaser / vs Mailchimp / founder closer                              |
| `/pricing`               | Hero + 3-tier cards + add-ons + 6-row competitor compare table + 12-FAQ accordion                              |
| `/features`              | 3 pillar deep-dives at `#migration`, `#deliverability`, `#voice-ai` (10 bullets each, 3 screenshot slots each) |
| `/about`                 | Founder story + What we're building + What we promise + Who it's for + What we won't build + signed closer     |
| `(marketing)/layout.tsx` | Cleaner header, 5-col footer, skip link, focus-visible rings throughout                                        |

Several marketing pages still use CSS-rendered product illustrations. Prefer
real, inspection-friendly screenshots for product-evaluation contexts when
production screenshots are available.

## SEO and feeds

The marketing surface ships with a small SEO+feeds toolkit, all routed through
the Next.js App Router:

| Route            | File                             | Notes                                                                                                                                                                    |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/sitemap.xml`   | `src/app/sitemap.ts`             | All marketing routes, `lastModified` pinned to 2026-04-30, change-freq tuned per route family.                                                                           |
| `/robots.txt`    | `src/app/robots.ts`              | Allow `/` except `/app/*` and `/api/*`. AI crawlers (GPTBot, Google-Extended, CCBot, anthropic-ai, ClaudeBot, PerplexityBot) are disallowed from `/legal/*` and `/vs/*`. |
| `/og`            | `src/app/og/route.tsx`           | Dynamic 1200x630 PNG via `next/og` on the edge runtime. Query params: `title` (required), `subtitle`, `eyebrow`.                                                         |
| `/changelog.xml` | `src/app/changelog.xml/route.ts` | Minimal valid Atom 1.0 feed with the 5 changelog entries.                                                                                                                |

### `pageMetadata` helper

Marketing pages should compose their `metadata` export through
`src/lib/marketing-metadata.ts`:

```ts
import type { Metadata } from "next";
import { pageMetadata } from "@/lib/marketing-metadata";

export const metadata: Metadata = pageMetadata({
  title: "Moosewave — The newsletter platform you own forever",
  description: "Move in 20 minutes. Land in inbox. Sound like yourself.",
  path: "/",
});
```

The helper:

- builds `/og?title=…&subtitle=…&eyebrow=…` and URL-encodes inputs,
- sets `alternates.canonical`, `openGraph`, and Twitter card,
- prefixes URLs with `NEXT_PUBLIC_SITE_URL` (default `https://moosewave.com`).

For comparison pages, pass an `eyebrow` (e.g. `"vs Mailchimp"`) to render the
small teal accent line in the OG image.

### Env

- `NEXT_PUBLIC_SITE_URL` — absolute base URL for canonical / OG / sitemap /
  robots / Atom feed. Default `https://moosewave.com`. Set in the deploy
  environment; not required for local dev.
- `NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL` — exact public HTTPS CDN/base accepted
  for sanitized campaign-template previews. The production container build
  requires it, and it must match the API's
  `POSTWAVE_ASSETS_PUBLIC_BASE_URL`/equivalent R2 public base.

## Editor (V1)

The block editor lives in `src/components/editor/` and is composed of:

- `EditorShell` — tabs that switch between Writer (Tiptap markdown), Blocks
  (GrapesJS + grapesjs-mjml), and Clients (live cross-client preview).
  Mode is persisted per-document in localStorage.
- `BlockEditor` — GrapesJS shell. Loaded dynamically (the package touches
  `document` at import time, so it cannot live in an RSC). MJML source is
  compiled to HTML via `POST /api/mjml`, debounced 350ms after the last edit.
  The right pane is a sandboxed `<iframe srcDoc>` preview supporting
  desktop / mobile + light / dark.
- `MarkdownEditor` — Tiptap StarterKit + Link + Placeholder, serialized to
  markdown via Turndown on every transaction.
- `CrossClientPreview` — Phase 3: live cross-client renders. Calls
  `POST /v1/render` via `lib/render-api.ts`, grids 10 mailbox
  environments (Outlook 2019/365/macOS, Apple Mail macOS light/dark and
  iOS, Gmail Web Promotions and iOS, Yahoo Web, ProtonMail Web). Each
  card carries breaking/warning issue badges from the static-check
  pass; clicking opens a full-size dialog with the issue list.

The MJML compile route lives at `src/app/api/mjml/route.ts` and is forced to
`runtime = 'nodejs'` because `mjml` is a Node-only library.

## Accessibility

We aim for WCAG 2.1 AA on the dashboard surface. The accessibility
investments live in three places:

**Global landmarks + skip-link** — `app/(dashboard)/layout.tsx` declares:

- A visually-hidden "Skip to main content" link, becomes visible on focus
  (WCAG 2.4.1 Bypass Blocks). Targets `#main-content`.
- `<nav role="navigation" aria-label="Primary">` for the sidebar; the nav
  is a `<ul>` of links so screen readers report position-in-set.
- `<header role="banner">` for the top bar; `<main id="main-content"
tabIndex={-1}>` so the skip-link can move focus into it.
- Active sidebar items carry `aria-current="page"` and an additional
  `(current page)` sr-only suffix.

**Sidebar keyboard navigation** — Arrow Up / Arrow Down / Home / End move
focus between sidebar items without leaving the nav. Tab still escapes
to the rest of the page.

**Focus visibility** — every interactive element uses Tailwind's
`focus-visible:` ring (`ring-2 ring-ring`) so keyboard focus is
unambiguous; the ring is suppressed on mouse interactions.

**Editor** — `EditorShell` uses Radix `Tabs` (built-in `role="tablist"`,
`role="tab"`, `aria-selected`, arrow-key navigation). `EditorToolbar`:

- The bar is `role="toolbar"` with `aria-label="Editor toolbar"`.
- Undo / Redo announce their action via an `aria-live="polite"` region
  ("Undid last change", "Redid last change") that briefly populates an
  sr-only span.
- Preview-mode and theme toggles use `role="radiogroup"` + `role="radio"`
  with `aria-checked`, since they're mutually-exclusive choices.
- Every icon-only button has an `aria-label`.

**Dialog** — All dialogs use shadcn's Radix-backed `Dialog`, which
provides focus trap, Esc-to-close, focus-return on close, and proper
`aria-labelledby` / `aria-describedby` via `<DialogTitle>` and
`<DialogDescription>`. The cross-client full-size preview uses both.

**Color is never the sole signal** — issue badges combine icon + text +
color so users with color-vision deficiencies still get the severity.

Outstanding follow-ups tracked separately: an axe-core CI gate (Phase 4),
and a documented "press / to focus the GrapesJS block panel" hint
because GrapesJS itself is not fully keyboard-navigable upstream.

## Sequences flow

The voice service is fronted in the UI through `src/lib/voice-api.ts`. With the
explicit development-only `NEXT_PUBLIC_USE_MOCKS=1` flag, the substantive mocks
in `voice-mocks.ts` take over — 30 named templates, a sample 7-email welcome
sequence with realistic copy, and a built voice profile. Production and normal
development requests surface real backend errors; they never fail over to these
fixtures.

1. **List** (`/sequences`) — Active / Drafts / Templates tabs. Active and
   Drafts show a table with name, template, fidelity badge (green ≥80, amber
   60–79, red <60), status, updated.
2. **Pick a template** (`/sequences/new`) — filterable grid by category with a
   search box.
3. **Generate** (`/sequences/new/[templateId]`) — 3 steps: variables form
   (auto-rendered from the template's `Variables`), style sliders (humor /
   directness / length / formality), voice profile preview. "Generate"
   `POST`s to `/v1/voice/sequences`, polls until `state=ready`, then
   redirects to the editor.
4. **Edit** (`/sequences/[id]`) — left rail shows every email in the
   sequence with its fidelity chip; right pane is the `EditorShell`. Subject
   and per-email delay live above the editor. The voice-fidelity breakdown
   (embedding / stylistic / vocab / structural) is an expandable card under
   the editor. Regenerate-this-email opens a dialog with a hint textarea +
   style sliders; Regenerate-all walks every position.
5. **Voice profile** (`/sequences/voice-profile`) — sources list with
   add/reingest/remove, plus an SVG bar chart of stylistic features, an SVG
   tonal radar, a vocab tag cloud sized by weight, and a samples accordion.

## Code map (additions)

```
src/
  app/api/mjml/route.ts            # POST → server-side MJML compile
  app/(dashboard)/
    sequences/
      page.tsx                     # list (RSC)
      _components/row-actions.tsx
      new/page.tsx                 # template picker (RSC)
      new/_components/template-picker.tsx
      new/[templateId]/page.tsx    # 3-step generation flow
      [id]/page.tsx                # sequence editor
      voice-profile/page.tsx
    templates/
      page.tsx
      [id]/page.tsx
      new/page.tsx
      _components/browser.tsx
  components/editor/
    block-editor.tsx
    editor-toolbar.tsx
    editor-shell.tsx
    markdown-editor.tsx
    preview-pane.tsx
    cross-client-preview.tsx
  components/ui/                  # +textarea, +slider
  lib/
    voice-api.ts
    voice-mocks.ts
    voice-types.ts
```
