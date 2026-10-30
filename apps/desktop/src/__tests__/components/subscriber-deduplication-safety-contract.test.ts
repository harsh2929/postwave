import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../components/subscribers/DuplicatesModal.tsx", import.meta.url),
  "utf8",
);

describe("subscriber deduplication destructive-scope contract", () => {
  it("does not expose a batch path that can execute pairs outside one reviewed plan", () => {
    expect(source).not.toContain("Auto-merge high-confidence");
    expect(source).not.toContain("doAutoMergeHighConfidence");
    expect(source).not.toContain("Per-pair plan review is skipped");
    expect(source).toContain("one version-bound review per merge");
    expect(source).toContain('typeToConfirm="MERGE"');
  });

  it("gates a destructive apply on the currently reviewed dry-run plan", () => {
    expect(source).toContain(
      "if (!pending || !plan || !scan || applying) return;",
    );
    expect(source).toContain("dry_run: true");
    expect(source).toContain("dry_run: false");
    expect(source).toContain(
      "expected_plan_fingerprint: plan.plan_fingerprint",
    );
    expect(source).toContain("expected_primary_updated_at");
    expect(source).toContain("scan_id: scan.scan_id");
  });

  it("never presents a sampled client result as a complete scan", () => {
    expect(source).toContain("This scan is complete, not sampled.");
    expect(source).toContain("startSubscriberDuplicateScan");
    expect(source).toContain("listSubscriberDuplicateScanPairs");
    expect(source).not.toContain("limit: 100");
  });
});
