# Desktop design-system convergence

Last reviewed: 2026-07-16

Tracking item: DUX-038

Status: **IN PROGRESS**

This document is the migration contract for the desktop app’s shared
`Notice`, `Banner`, `Card`, and `Skeleton` primitives. It replaces the former
line-number checklist, which was stale: several listed sites had already moved
or been split into feature components, the primitive stories were not actually
registered in the visual-regression harness, and no source gate prevented new
legacy patterns.

## Public contracts

| Primitive | Contract | Accessibility behavior |
| --- | --- | --- |
| `Notice` | `tone`, `title`, `action`, and `announcement`; semantic paint cannot be supplied through `style` | `danger` is assertive, `warning`/`success` are polite, and `info`/`neutral` are non-live notes under `announcement="auto"`. A caller can explicitly choose `off`, `polite`, or `assertive` when the state’s timing requires it. |
| `Banner` | Composes `Notice`; optional icon/action; `onDismiss` is a typed pair with required `dismissLabel` | No empty trailing-action wrapper. Dismissal is named in context rather than exposed as a repeated “Dismiss” control. Domain banners keep their data and recovery state machines but delegate chrome and announcement semantics here. |
| `Card` | `variant`, `padding`, optional semantic title, and `as="div"|"section"|"li"` | Defaults to a neutral `div`; an explicit section is labelled from its generated heading id. There is deliberately no `onClick` or `role` escape hatch: interactive cards must contain a real, named control instead of becoming a pseudo-button around nested controls. |
| `Skeleton` | `variant`, dimensions, and optional grouped `lines` | Visual placeholders are `aria-hidden` by default. Supplying one `aria-label`, or labelling the owning loading container, creates one announcement rather than one per placeholder/cell. |

All four export their prop types. Their `style` prop is
`PrimitiveLayoutStyle`: positioning, sizing, spacing, and layout remain
available, while colors, backgrounds, borders, radii, shadows, transforms,
animations, and transitions remain owned by typed variants and CSS tokens.

## Token, color, and motion rules

- Primitive color, surface, radius, spacing, typography, shadow, and duration
  values come from `--pw-*` tokens. Primitive sources may not introduce hex,
  RGB, or HSL literals.
- Layout styles such as `display`, `gap`, `width`, `minHeight`, and margins are
  valid domain concerns. Inline `background`, `border*`, `borderRadius`,
  `boxShadow`, and `color` in governed sources are rejected unless an exact,
  bounded exception records why the property represents data, selection, a
  structural separator, or a code surface rather than replacement primitive
  chrome.
- `styles/design-system.css` makes `.pw-notice`, `.pw-banner`, `.pw-card`, and
  `.skel` visible in Windows forced colors. Skeleton shimmer becomes a static
  token surface under reduced motion and a system-color block in forced colors.
- Domain CSS can still describe true domain controls and data encodings. It
  must not recreate generic notice/card/skeleton tone, border, radius, and
  elevation combinations.

## Enforced source guardrail

`design-system-guardrails.json` and
`scripts/design-system-guardrails.mjs` form a checked migration dashboard.

The gate currently does all of the following:

1. Holds exact repository-wide ratchets for raw `.notice`, `.alert`,
   `.callout`, `.card`, and `.skel` JSX patterns. A new occurrence fails; a
   reduction also fails until the manifest is deliberately ratcheted down.
   A raw Card promoted to `role="button"` fails outright.
2. Requires every governed source to have zero legacy patterns and zero
   unreviewed inline semantic-paint properties.
3. Bounds each true domain exception by source, exact line fragment, maximum
   occurrence count, and non-empty review reason.
4. Confirms each primitive uses the layout-only style type, contains no
   hard-coded color literal, and retains a Storybook story.
5. Requires every production Skeleton either to name its own single loading
   announcement or belong to a reviewed group owner with explicit status/busy
   evidence.
6. Has focused positive and negative Node tests proving that domain layout is
   accepted while new paint forks and undefined legacy patterns are rejected.

Run it with:

```sh
cd apps/desktop
pnpm check:design-system
```

`check:source-size` invokes this command, so desktop CI and release CI cannot
silently bypass the ratchet.

The ratchets are debt accounting, not approval of the remaining legacy count.
They prevent regression while subsequent waves reduce the inventory without a
risky whole-repository autofix.

## Migrated checkpoint

| Owner | Current checkpoint |
| --- | --- |
| `pages/Compliance.tsx` | Catalogue error, Article 50 status, checklist groupings, AIVS export, retention warning, HIPAA prohibition, readiness state, and retry errors use typed primitives. Dynamic readiness no longer hand-paints its success/warning border. |
| `pages/AuditSinks.tsx` and `components/audit/AuditSinkTables.tsx` | Page and detail warnings/errors use `Notice`; the pre-existing split circuit legend uses `Card`; table placeholders use `Skeleton`, one loading caption, and `aria-busy` instead of repeated announcements. Code-surface and form-divider exceptions are documented. |
| `pages/Settings.tsx` | One-time webhook secret is a warning `Banner` with explicit acknowledgement; load failure is a retryable danger `Notice`; create form uses `Card`. Tour/onboarding state was outside this wave. |
| `pages/MCP.tsx` | Catalogue and execution errors use `Notice`; tool rows, KPI tiles, Sparkline shell, quota, top-tool/key, and status shells use `Card`. DUX-025 chart/data colors remain reviewed data-encoding exceptions. |
| `pages/Forms.tsx` | Load failure, loading cards, selection toolbar, form tiles, and template tiles use primitives. The whole form tile is no longer a `role="button"` around a checkbox and three buttons; a real named title button opens details. Loading cards announce once. |
| `pages/Templates.tsx` | The template tile no longer promotes a raw Card to `role="button"` around its favorite button. Canonical `Card` owns the container and the template name is the explicit open control; domain metadata attributes are forwarded without reopening Card’s click/role API. |
| Domain banners | `WinnerBanner`, `UnsupportedFeatureBanner`, all four `MigrationErrorBanners`, and `AutoDisabledBanner` now compose `Banner`. Recovery/data logic stays in the domain owner. |

The following similarly named components are intentional exclusions from this
bounded chrome wave:

- `SubscribersNewBanner` and the audit SSE equivalent are sticky “new rows”
  command pills, not tonal banners.
- `OfflineBanner` is persistent shell/queue status with tray ownership.
- `InboxRealityBanner`, `SendTimeOptBanner`, `VoiceDriftBanner`,
  `BlockedProductsBanner`, and `DmarcSuggestionsBanner` are compound data or
  multi-record surfaces. They need separate interaction/data migrations before
  generic chrome composition would be safe.
- Modal/slideover shells own overlay chrome and are not Cards.

## Stories and verification

The primitive stories now cover announcement overrides, contextual dismissal,
named Card sections, and one-owner/decorative Skeleton patterns. Representative
Notice, Banner, Card, and Skeleton stories are registered in
`tests/storybook/stories.spec.ts` with committed Chromium baselines.

Focused verification:

```sh
cd apps/desktop
pnpm check:design-system
pnpm test:styles-entry
pnpm exec vitest run \
  src/__tests__/components/dux-038-design-system-primitives.test.tsx \
  src/__tests__/components/dux-038-design-system-types.test.tsx
pnpm exec playwright test -c playwright-storybook.config.ts \
  --grep 'primitives-(notice|banner|card|skeleton)'
pnpm typecheck
pnpm typecheck:renderer-tests
```

## Remaining before DUX-038 can be complete

- Reduce and ultimately remove the repository-wide legacy-class ratchets; the
  current checkpoint still has hundreds of pre-existing raw JSX patterns.
- Expand governed-source coverage beyond this safe high-priority wave and
  resolve compound banner/data-surface ownership one domain at a time.
- Establish a generated-token consumption and drift check against
  `@postwave/design-tokens`; this wave uses the existing canonical desktop
  variables but does not claim the generated-token acceptance item.
- Add lint/AST coverage for semantic paint in CSS modules, not only governed
  TSX inline styles, while retaining an explicit data-visualization exception
  vocabulary.
- Qualify the installed app in dark/light themes, Windows forced colors,
  reduced motion, 200–400% zoom/text scaling, and VoiceOver/Narrator. Storybook
  screenshots and source assertions are regression evidence, not substitutes
  for that signed platform matrix.

There are no stash receipts or deferred “pop this later” instructions. The
dashboard and source tree are the migration truth.
