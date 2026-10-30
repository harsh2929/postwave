// SPDX-License-Identifier: MIT
import { defineConfig } from "tsup";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: false,
  banner: { js: "#!/usr/bin/env node" },
  onSuccess: async () => {
    // Copy the dev preview UI bundle alongside the compiled output so
    // src/dev/server.ts can read it via the resolved __dirname at runtime.
    const src = resolve("src/dev/ui/index.html");
    const dst = resolve("dist/dev/ui/index.html");
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  },
});
