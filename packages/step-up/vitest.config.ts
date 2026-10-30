/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, deliberately: this package must never need a DOM. If a change here
    // starts reaching for `window` or `CustomEvent`, these tests fail — which
    // is the only automated guard that keeps it consumable by React Native.
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
  },
});
