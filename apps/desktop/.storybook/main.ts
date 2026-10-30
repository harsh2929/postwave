/**
 * Storybook config for the Moosewave desktop app.
 *
 * Uses the Vite builder so stories share the exact same toolchain as
 * the app: same JSX runtime, same module resolution, same env vars.
 *
 * Scope is deliberately narrow:
 *   - Only `src/stories/` is glob-matched. We do NOT colocate stories
 *     beside components — that would scatter Storybook-only deps and
 *     pull every component (and its transitive imports) into the
 *     Storybook bundle, which slows boot to a crawl on a desktop app
 *     this size.
 *   - Stories cover the design-system primitives that other surfaces
 *     compose against: Modal/ConfirmModal/SlideoverShell, the three
 *     chart primitives (LineChart/Sparkline/Heatmap), Toast, SaveBar.
 *     Adding stories for app pages is a non-goal.
 *
 * No addons are configured. We don't want a11y/docs/controls add-ons
 * pinning extra peer-deps; the stories exist primarily as a visual-
 * regression harness (.github/workflows/visual-regression.yml) and a
 * design playground. The default essentials addon is opt-in only.
 */
import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/stories/**/*.stories.@(ts|tsx)"],
  addons: [],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  // Storybook 8 turns on the docgen plugin by default. It walks every
  // TS file with the TypeScript compiler at boot, which on this repo's
  // generated API client is multi-second. Stories use plain JSDoc for
  // documentation anyway, so the auto-extracted props table isn't
  // worth the boot cost.
  typescript: {
    reactDocgen: false,
  },
};

export default config;
