// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Next preserves JSX in tsconfig; Vitest needs to lower it when server-side
  // rendering real components in the node test environment.
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
