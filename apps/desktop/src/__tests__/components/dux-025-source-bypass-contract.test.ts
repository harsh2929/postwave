import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../..");

function productionTsxFiles(directory = SRC): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "stories"].includes(entry.name)) continue;
      files.push(...productionTsxFiles(path));
    } else if (extname(entry.name) === ".tsx") {
      files.push(path);
    }
  }
  return files;
}

function source(path: string): string {
  return readFileSync(resolve(SRC, path), "utf8");
}

describe("DUX-025 visualization bypass contract", () => {
  it("keeps role=img on the qualified shared SVG primitives only", () => {
    const allowed = new Set([
      "components/charts/BarChart.tsx",
      "components/charts/Donut.tsx",
      "components/charts/LineChart.tsx",
      "components/charts/MultiLineChart.tsx",
      "components/charts/Sparkline.tsx",
    ]);
    const bypasses = productionTsxFiles()
      .filter((path) => /role=["']img["']/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path))
      .filter((path) => !allowed.has(path));
    expect(bypasses).toEqual([]);
  });

  it("keeps residual quantitative SVGs supplemental to semantic data", () => {
    for (const path of [
      "components/segments/SegmentGrowthReport.tsx",
      "components/segments/SegmentOverlapCard.tsx",
      "components/subscribers/SubscriberDetailPresentation.tsx",
      "components/webhooks/WebhookHealthCard.tsx",
    ]) {
      const value = source(path);
      expect(value, path).toContain("<svg");
      expect(value, path).toMatch(/<svg[\s\S]*?aria-hidden(?:="true")?/);
      expect(value, path).toMatch(
        /AccessibleChartData|CategoricalDistributionChart|role="meter"/,
      );
    }
  });

  it("retains one image-only canvas exporter and no competing CSV path", () => {
    const canvasOwners = productionTsxFiles()
      .filter((path) =>
        /<canvas\b|createElement\(["']canvas["']\)/.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) => relative(SRC, path));
    expect(canvasOwners).toEqual(["components/analytics/ChartActions.tsx"]);

    const actions = source("components/analytics/ChartActions.tsx");
    expect(actions).not.toContain("Download CSV");
    expect(actions).not.toContain("matrixToCsv");
    expect(actions).not.toContain("buildCsv");
    expect(actions).toContain("Download PNG");
    expect(actions).toContain("Copy link");
  });

  it("locks responsive, reduced-motion, and forced-color fallbacks", () => {
    const styles = source("styles/chart-accessibility.css");
    expect(styles).toContain("container-type: inline-size");
    expect(styles).toContain("@container (max-width: 480px)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain("CanvasText");
    expect(styles).toContain("outline-color: Highlight");
  });
});
