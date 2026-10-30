// SPDX-License-Identifier: MIT
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { extension: "src/extension.ts" },
  format: ["cjs"],
  target: "es2022",
  platform: "node",
  // Production/default builds must be package-safe. `pnpm dev` opts into
  // source maps explicitly for local watch-mode debugging.
  sourcemap: false,
  clean: true,
  dts: false,
  splitting: false,
  treeshake: true,
  outDir: "out",
  external: ["vscode"],
});
