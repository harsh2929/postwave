# Storybook visual regression

Pixel-diff tests for the desktop design-system primitives, driven by the
static Storybook bundle (`apps/desktop/.storybook/`). Sibling to
`tests/visual/` — that one screenshots the running app shell, this one
screenshots individual stories in isolation.

## Why split from `tests/visual/`

- **Determinism.** Stories use hard-coded synthetic data (no `new Date()`,
  no `Math.random`). The app-shell tests need network stubs and tend to
  flap on layout changes that have nothing to do with the primitive
  itself.
- **Speed.** Storybook bundle is ~50× smaller than the app bundle and
  needs no docker stack — the workflow finishes in ~3 minutes vs ~8.
- **Granularity.** When the Sparkline color token drifts, the failing
  diff lands on _the Sparkline story_ — not on a Dashboard view that
  happens to embed one.

## How it works

The Playwright config (`apps/desktop/playwright-storybook.config.ts`)
serves the built `storybook-static/` directory via `http-server` on port
6007 and navigates Chromium to
`/iframe.html?id=<story-id>&viewMode=story` for each story registered in
`stories.spec.ts`. The iframe URL renders the story without the
Storybook sidebar / addons panel, so the snapshot contains _only_ the
component.

`#storybook-root` is the readiness signal — Storybook injects that node
once a story has mounted. Overlay components (Modal, Slideover) render
into portal siblings, but `#storybook-root` still exists by the time
they're visible.

## Running locally

```bash
cd apps/desktop

# 1. Build the static Storybook bundle (once per change to stories or
#    components):
pnpm build-storybook

# 2. Generate baselines on a clean checkout:
pnpm test:stories:update

# 3. Future runs diff against committed baselines:
pnpm test:stories
```

Always review the generated PNGs in `tests/storybook/__screenshots__/`
visually before committing. A bad baseline locks in a real bug.

## Adding a new story

1. Drop a `Component.stories.tsx` file in `apps/desktop/src/stories/`.
2. Add a corresponding entry to the `STORIES` array in
   `stories.spec.ts`. The story ID slug is the lower-case title path
   joined with dashes, plus the export name dasherised. Example:
   `Primitives/Modal` + `Plain` → `primitives-modal--plain`.
3. Rebuild Storybook and run `pnpm test:stories:update` to capture the
   baseline.

## CI

`.github/workflows/visual-regression.yml` runs `pnpm test:stories` on
every PR that touches the stories, the components they cover, or the
shared stylesheet. Failures upload the diff PNGs as workflow artifacts.
