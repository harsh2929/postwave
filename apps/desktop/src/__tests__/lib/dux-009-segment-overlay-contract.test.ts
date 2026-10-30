import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../..");
const OWNERS = {
  "components/audiences/LookalikeModal.tsx": 'size="md"',
  "components/segments/SegmentHoldoutConfigModal.tsx": 'size="sm"',
  "components/segments/SegmentPerformanceComparison.tsx": 'size="xl"',
  "components/segments/SegmentCompareView.tsx": 'size="xl"',
} as const;

function source(relativePath: string): string {
  return readFileSync(resolve(SRC, relativePath), "utf8");
}

describe("DUX-009/022 segment overlay convergence", () => {
  for (const [relativePath, size] of Object.entries(OWNERS)) {
    it(`${relativePath} delegates dialog ownership to Modal`, () => {
      const contents = source(relativePath);
      expect(contents).toContain("<Modal");
      expect(contents).toContain(size);
      expect(contents).toContain("title=");
      expect(contents).toContain("description=");
      expect(contents).toContain("closeOnBackdrop=");
      expect(contents).toContain("closeOnEscape=");
      expect(contents).toContain("closeDisabled=");
      expect(contents).not.toMatch(/role=["'](?:dialog|presentation)["']/u);
      expect(contents).not.toContain("aria-modal=");
      expect(contents).not.toContain('className="modal-backdrop"');
      expect(contents).not.toContain('position: "fixed"');
      expect(contents).not.toContain('maxWidth: "95vw"');
      expect(contents).not.toContain('maxHeight: "90vh"');
      expect(contents).not.toContain("zIndex: 1000");
      expect(contents).not.toContain("onMouseDown=");
    });
  }

  it("inherits composition-safe Escape handling from Modal", () => {
    const contents = source("components/Modal.tsx");
    expect(contents).toContain("e.isComposing || e.keyCode === 229");
    expect(contents).toContain('e.key === "Escape"');
    expect(contents).toContain("!isTop || !closeOnEscape");
  });

  it("inherits compact viewport, zoom, reduced-motion, and forced-color bounds", () => {
    const surfaces = source("styles/content-surfaces.css");
    const layers = source("styles/overlay-layers.css");
    const overlays = source("styles/shared-overlays.css");
    expect(surfaces).toMatch(/\.modal-card\s*\{[^}]*width:\s*100%/su);
    expect(surfaces).toMatch(/\.modal-body\s*\{[^}]*overflow-y:\s*auto/su);
    expect(surfaces).toMatch(/\.pw-modal-xl\s*\{[^}]*calc\(100vw - 64px\)/su);
    expect(layers).toContain("--pw-modal-top-offset: clamp(12px, 10vh, 96px)");
    expect(layers).toContain("padding: var(--pw-modal-top-offset) 12px 12px");
    expect(layers).toContain("overflow-y: auto");
    expect(layers).toMatch(/\.modal-card\s*\{[^}]*100dvh/su);
    expect(overlays).toMatch(/prefers-reduced-motion:\s*reduce/su);
    expect(overlays).toMatch(/forced-colors:\s*active[\s\S]*\.modal-card/su);
    expect(overlays).toMatch(
      /forced-colors:\s*active[\s\S]*\.modal-backdrop/su,
    );
  });

  it("names grouped choices without nesting sibling actions", () => {
    for (const relativePath of [
      "components/segments/SegmentHoldoutConfigModal.tsx",
      "components/segments/SegmentPerformanceComparison.tsx",
      "components/segments/SegmentCompareView.tsx",
    ]) {
      const contents = source(relativePath);
      expect(contents).toContain('role="group"');
      expect(contents).toContain("aria-pressed=");
    }
  });
});
