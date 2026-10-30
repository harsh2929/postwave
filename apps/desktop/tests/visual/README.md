# Visual regression tests

These tests boot the desktop app in a Chromium browser via Playwright and
screenshot key views in both themes. Pixel diffs against committed baselines
catch theme regressions (hardcoded colors that don't flip, shadow tokens
that drift, etc.) at PR time — much faster and cheaper than human review.

## How it works

`fixture.ts` stubs the bits the app expects from Tauri when running in a
real desktop shell:

1. **`window.__TAURI_INTERNALS__`** — a fake `invoke()` handler returns
   canned values for each Tauri command (see `tauriCommandStubs`). The
   `isTauri()` check in `lib/tauri.ts` then returns `true` and the
   `NotInTauri` boot gate is skipped.
2. **localStorage** — pre-seeded with `postwave_api_url`,
   `postwave_api_key`, and `postwave_session` so the Welcome / SignIn
   screens don't gate the boot.
3. **Network intercepts** — `page.route()` mocks every `/api/**` call. A
   handful of known endpoints return realistic JSON; everything else
   returns `{}` so no loader hangs.
4. **`setTheme(page, "system" | "dark" | "light")`** — sets
   `postwave_theme` in localStorage before the app reads it on boot. The System
   contract also emulates a live OS palette change and asserts the renderer
   follows it without reload.

Tests use the exported `test()` from `fixture.ts` rather than
`@playwright/test` directly — that's what wires the helpers in.

## Running locally

```bash
# Run once, see what fails:
pnpm test:visual

# First run on a clean checkout has no baselines — generate them:
pnpm test:visual:update

# Then commit the generated images:
git add tests/visual/*.spec.ts-snapshots
```

**Always review baselines visually before committing.** A bad baseline
locks in a real bug. Compare the rendered output (under
`test-results/<test-name>/`) against your design intent first.

## Adding a new view

Copy a `test()` block in `theme.spec.ts`. The pattern:

```ts
test(`some-view-${theme}`, async ({ page, bootApp, setTheme }) => {
  await setTheme(page, theme);
  await bootApp(page);
  await page.goto("/some/route");
  // Wait for a specific element instead of a fixed timeout when possible
  await page.locator(".some-distinct-class").waitFor({ state: "visible" });
  await expect(page).toHaveScreenshot(`some-view-${theme}.png`, {
    fullPage: true,
  });
});
```

If the view needs API data the dashboard doesn't already mock, add a
handler to `apiRouteStubs` in `fixture.ts` rather than mocking per-test
— shared stubs keep snapshots stable across additions.

## CI

`desktop-ci.yml` runs `test:renderer` on Ubuntu against optimized production
chunks. That gate deliberately excludes platform-specific pixel baselines but
includes the assertion-bearing route, populated-data, interaction, modal,
scroll, and tier-2/3 workflow suites. The macOS `test:visual` command remains
the local pixel-regression workflow because its reviewed baselines include
Darwin font rendering; update and review those images explicitly when visual
design changes are intentional.
