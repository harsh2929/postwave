import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/webhook.ts"],
  format: ["esm", "cjs"],
  target: "es2022",
  sourcemap: true,
  clean: true,
  dts: true,
  splitting: false,
  treeshake: true,
  outDir: "dist",
});
