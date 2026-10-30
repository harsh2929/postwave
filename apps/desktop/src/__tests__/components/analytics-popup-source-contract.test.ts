import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const DESKTOP = resolve(import.meta.dirname, "../../..");
const ROOT = resolve(DESKTOP, "../..");

function desktopSource(path: string): string {
  return readFileSync(resolve(DESKTOP, path), "utf8");
}

describe("DUX-023 analytics popup source contract", () => {
  it("keeps true menus on the shared top-layer interaction contract", () => {
    for (const path of [
      "src/components/analytics/ExportMenu.tsx",
      "src/components/analytics/GroupByMenu.tsx",
      "src/components/analytics/ChartActions.tsx",
    ]) {
      const source = desktopSource(path);
      expect(source, path).toContain("useMenuInteraction({");
      expect(source, path).toContain("useDialogStack(");
      expect(source, path).toContain("pushDialog(");
      expect(source, path).toContain("aria-controls=");
      expect(source, path).toContain('role="menu"');
      expect(source, path).toContain("onBlurCapture=");
    }
  });

  it("keeps unavailable Group By choices focusable and visibly described", () => {
    const source = desktopSource(
      "src/components/analytics/GroupByMenu.tsx",
    );
    expect(source).toContain("itemSelector: GROUP_ITEM_SELECTOR");
    expect(source).toContain("aria-disabled={isUnavail || undefined}");
    expect(source).toContain("aria-describedby={isUnavail ? reasonId : undefined}");
    expect(source).toContain("Unavailable: {unavailTitle}");
    expect(source).not.toContain("disabled={isUnavail}");
    expect(source).not.toContain("title={unavailTitle}");
  });

  it("keeps multi-action Saved Views and KPI Config out of menu semantics", () => {
    const saved = [
      "src/components/analytics/SavedViewsMenu.tsx",
      "src/components/analytics/SavedViewsPopover.tsx",
    ]
      .map(desktopSource)
      .join("\n");
    const kpi = desktopSource(
      "src/components/analytics/KpiConfigMenu.tsx",
    );
    for (const source of [saved, kpi]) {
      expect(source).toContain('aria-haspopup="dialog"');
      expect(source).toContain('role="dialog"');
      expect(source).toContain('aria-modal="false"');
      expect(source).toContain("aria-labelledby=");
      expect(source).toContain("aria-controls=");
      expect(source).toContain("onBlurCapture=");
      expect(source).not.toContain('role="menu"');
    }
    expect(saved).toContain("data-saved-view-action");
    expect(saved).toContain("pendingDeletedIndexRef");
    expect(kpi).toContain('role="status"');
    expect(kpi).toContain("moved to position");
    expect(kpi).not.toContain("browser's built-in list traversal");
  });

  it("clamps every popup and retains non-color focus/high-contrast cues", () => {
    const styles = desktopSource("src/styles-analytics-popups.css");
    expect(styles).toContain("calc(100vw - 16px)");
    expect(styles).toContain("calc(100dvh - 24px)");
    expect(styles).toContain("overscroll-behavior: contain");
    expect(styles).toContain("--analytics-popup-width: 216px");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain("outline-color: Highlight");
  });

  it("records the bounded evidence and installed qualification residuals", () => {
    const documentation = readFileSync(
      resolve(ROOT, "apps/desktop/docs/dux-023-analytics-popup-wave.md"),
      "utf8",
    );
    expect(documentation).toContain("Date Range is explicitly out of scope");
    expect(documentation).toContain("VoiceOver");
    expect(documentation).toContain("NVDA");
    expect(documentation).toContain("400% zoom");
    expect(documentation).toContain("installed qualification remains open");
  });
});
