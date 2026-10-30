import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("desktop runtime compatibility floor", () => {
  const viteConfig = readFileSync(
    new URL("../../vite.config.ts", import.meta.url),
    "utf8",
  );
  const tauriConfig = JSON.parse(
    readFileSync(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  ) as { bundle: { macOS: { minimumSystemVersion: string } } };

  it("keeps an old-runtime parse floor for the compatibility screen", () => {
    expect(viteConfig).toContain('target: ["safari14", "chrome109"]');
    expect(viteConfig).toContain("runtime-compatibility.ts");
    expect(viteConfig).not.toContain('target: "esnext"');
    expect(tauriConfig.bundle.macOS.minimumSystemVersion).toBe("11.0");
  });
});
