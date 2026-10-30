/// <reference types="vitest" />
//
// Vitest config for the desktop shell. The DEFAULT environment is `node`,
// because the great majority of tests under src/__tests__/ are pure-logic and
// booting a DOM for them costs startup time for nothing.
//
// A file that needs a DOM opts in with a `@vitest-environment happy-dom`
// docblock, which 374 of them already do — 362 render components with
// react-dom/client. The note that used to sit here said "none of those packages
// are in the workspace today"; happy-dom is a declared devDependency and the
// pattern is the house default. The comment was not merely stale, it was cited
// as the reason a component test could not be written.
//
// Per-file opt-in rather than a global switch: a DOM in every test would let a
// pure-logic module start depending on `window` without anything noticing.

import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // tsconfig.json sets jsx:"preserve" (Vite owns JSX at app build time),
  // which makes Vite's transformer leave JSX untransformed — fine for the
  // production build, but it breaks importing a .tsx component into a
  // test. Vite 8 transforms with oxc, so we override the jsx mode here to
  // React 19's automatic runtime; this lets the component tests under
  // src/__tests__/components import real .tsx components and render them
  // via react-dom/server. No-op for the pure-logic .ts tests (no JSX),
  // and the node-only test environment is untouched.
  oxc: {
    jsx: "react-jsx",
  },
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts", "src/__tests__/**/*.test.tsx"],
    globals: false,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/__tests__/**",
        "src/**/*.d.ts",
        "src/**/*.stories.{ts,tsx}",
      ],
      thresholds: {
        // Initial full-source floor (2026-07-15): 13.93 / 13.25 / 11.10 /
        // 13.57. These are regression ratchets, not a claim of adequate
        // behavior coverage; raise them as UI/controller tests are added.
        statements: 13,
        branches: 13,
        functions: 11,
        lines: 13,
      },
    },
    // Vite picks up tsconfig.json paths automatically via vite-tsconfig-
    // paths in larger projects, but to keep deps light we hard-code the
    // alias here. Mirrors apps/desktop/tsconfig.json.
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
