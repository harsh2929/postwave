// SPDX-License-Identifier: MIT
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "es2022",
  sourcemap: true,
  clean: true,
  dts: true,
  splitting: false,
  treeshake: true,
  outDir: "dist",
});
