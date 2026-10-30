// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd());
const source = (path: string): string =>
  readFileSync(resolve(ROOT, path), "utf8");

describe("root runtime lazy boundaries", () => {
  it("keeps optional runtime implementations out of root initial assets", () => {
    const layout = source("src/app/layout.tsx");
    const pwaLoader = source("src/components/pwa-registrar-loader.tsx");
    const telemetryLoader = source(
      "src/components/telemetry-provider-loader.tsx",
    );
    const webVitalsLoader = source(
      "src/components/seo/web-vitals-reporter-loader.tsx",
    );

    expect(layout).toContain(
      'import { PwaRegistrarLoader } from "@/components/pwa-registrar-loader"',
    );
    expect(layout).toContain(
      'import { TelemetryProviderLoader } from "@/components/telemetry-provider-loader"',
    );
    expect(layout).toContain(
      'import { WebVitalsReporterLoader } from "@/components/seo/web-vitals-reporter-loader"',
    );
    expect(layout).not.toContain('from "@/components/pwa-registrar"');
    expect(layout).not.toContain('from "@/components/telemetry-provider"');
    expect(layout).not.toContain('from "@/components/seo/web-vitals"');
    expect(layout).toContain("<PwaRegistrarLoader />");
    expect(layout).toContain("<TelemetryProviderLoader />");
    expect(layout).toContain("<WebVitalsReporterLoader />");

    for (const [loader, implementation] of [
      [pwaLoader, "@/components/pwa-registrar"],
      [telemetryLoader, "@/components/telemetry-provider"],
      [webVitalsLoader, "@/components/seo/web-vitals"],
    ] as const) {
      expect(loader).toContain('"use client"');
      expect(loader).toContain('import dynamic from "next/dynamic"');
      expect(loader).toContain(`import("${implementation}")`);
      expect(loader).toContain("ssr: false");
      expect(loader).not.toContain(`from "${implementation}"`);
    }
  });

  it("keeps the global toast host eager for lazy-runtime feedback", () => {
    const layout = source("src/app/layout.tsx");

    expect(layout).toContain(
      'import { ThemedToaster } from "@/components/themed-toaster"',
    );
    expect(layout).toContain("<ThemedToaster />");
    expect(layout).not.toContain('import("@/components/themed-toaster")');
  });
});
