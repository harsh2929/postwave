import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("DUX-041 large-data source contract", () => {
  it("keeps windowing bounded, position-aware, focus-retaining, and keyboard-scrollable", () => {
    const component = source("components/virtualization/WindowedList.tsx");
    expect(component).toContain("overscan");
    expect(component).toContain("focusedKey");
    expect(component).toContain("aria-posinset");
    expect(component).toContain("aria-setsize");
    expect(component).toContain("tabIndex={0}");
    expect(component).toContain("data-windowed-count");
  });

  it("renders each bounded Audit API page without fixed-height clipping", () => {
    const component = source("pages/audit/AuditListView.tsx");
    expect(component).toContain("visibleRows.map(renderRow)");
    expect(component).toContain('maxHeight: "70vh"');
    expect(component).toContain("<DataTableLoadMore");
    expect(component).not.toContain("<WindowedList");
  });

  it("pins containment, stable scrollbars, and high-contrast focus styling", () => {
    const styles = source("styles/large-data.css");
    expect(styles).toContain("contain: strict");
    expect(styles).toContain("scrollbar-gutter: stable");
    expect(styles).toContain("overscroll-behavior: contain");
    expect(styles).toContain("@media (forced-colors: active)");
  });
});
