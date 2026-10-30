/// <reference types="vitest" />
//
// Vitest config for the Next.js web app. Node remains the default because
// most tests are pure logic. Component tests opt into happy-dom per file with
// `// @vitest-environment happy-dom` so DOM/focus/form coverage can grow
// without slowing the whole suite.
//
// The `@/...` alias mirrors apps/web/tsconfig.json so test imports
// match what production code uses.

import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";

const OPENAPI_BASE64_QUERY = "?base64";

export default defineConfig({
  plugins: [
    {
      name: "postwave-openapi-base64",
      enforce: "pre",
      load(id) {
        if (
          !id.endsWith(`/openapi.json${OPENAPI_BASE64_QUERY}`) &&
          !id.endsWith(`\\openapi.json${OPENAPI_BASE64_QUERY}`)
        ) {
          return null;
        }
        const sourcePath = id.slice(0, -OPENAPI_BASE64_QUERY.length);
        const encoded = readFileSync(sourcePath).toString("base64");
        return `export default ${JSON.stringify(`data:application/json;base64,${encoded}`)};`;
      },
    },
    react(),
  ],
  test: {
    environment: "node",
    // See vitest.setup.storage.ts: Node's inert experimental Web Storage
    // global shadows happy-dom's real one, leaving window.localStorage
    // undefined in every DOM test.
    setupFiles: ["./vitest.setup.storage.ts"],
    include: ["src/__tests__/**/*.test.ts", "src/__tests__/**/*.test.tsx"],
    globals: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Workspace packages publish from dist, which can be stale during a
      // focused local run. Tests must certify the source in this checkout.
      "@postwave/design-tokens": path.resolve(
        __dirname,
        "../../packages/design-tokens/src/index.ts",
      ),
    },
  },
});
