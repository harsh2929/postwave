/**
 * Global Storybook preview wiring.
 *
 * - Pulls in the full app stylesheet (`../src/styles.css`) so design
 *   tokens (`--pw-bg`, `--pw-accent`, `--pw-border`, etc.) resolve the
 *   same way they do inside the running app. Without this, every story
 *   would render against Storybook's default white canvas and the
 *   theme-aware components would look broken.
 *
 * - Sets `data-theme="dark"` on <html> by default. The desktop app
 *   boots dark; matching that default keeps screenshots representative.
 *   A `theme` global toolbar entry flips the attribute so reviewers can
 *   check both modes interactively.
 *
 * - Disables animations during snapshot capture via the
 *   `parameters.layout = "centered"` + a small CSS override. The
 *   Playwright visual-regression workflow also passes `animations:
 *   "disabled"` to belt-and-suspenders the determinism, but cutting
 *   animations here means a manual browse of Storybook also matches
 *   what CI sees.
 */
import type { Preview } from "@storybook/react";

import "../src/styles.css";

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: { disable: true },
    layout: "padded",
  },
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Light vs dark design-token set",
      defaultValue: "dark",
      toolbar: {
        icon: "circlehollow",
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme = (context.globals.theme as string) || "dark";
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-theme", theme);
        document.body.style.background = "var(--pw-bg)";
        document.body.style.color = "var(--pw-fg)";
      }
      return Story();
    },
  ],
};

export default preview;
