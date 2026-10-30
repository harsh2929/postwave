import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("DUX-024 qualified table source contract", () => {
  it("keeps native semantics, controlled sort state, selection, overflow, and forced-colors support in one primitive", () => {
    const component = source("components/table/DataTable.tsx");
    const styles = source("styles/data-table.css");
    expect(component).toContain("<table aria-label={caption}>");
    expect(component).toContain("<caption");
    expect(component).toContain('scope="col"');
    expect(component).toContain("aria-sort");
    expect(component).toContain("indeterminate");
    expect(component).toContain("DataTablePagination");
    expect(component).toContain('aria-live="polite"');
    expect(component).toContain("pw-data-table__scroll");
    expect(component).toContain("tabIndex={0}");
    expect(styles).toContain("overflow: auto");
    expect(styles).toContain("scrollbar-gutter: stable");
    expect(styles).toContain("@media (forced-colors: active)");
  });

  it.each([
    "components/deliverability/BlocklistHitsTable.tsx",
    "components/deliverability/WebhookErrorsTable.tsx",
    "components/deliverability/DnsHealthTable.tsx",
    "components/dmarc/DmarcTopSourcesTable.tsx",
    "components/analytics/RevenueAttributionCards.tsx",
    "components/privacy/DoubleOptinPendingTable.tsx",
    "components/deliverability/IspBreakdownCard.tsx",
    "components/deliverability/PlacementReportCard.tsx",
    "components/deliverability/AuthChecksMatrixCard.tsx",
    "components/playground/PlaygroundHeaders.tsx",
    "components/compliance/ActivationExclusionsPanel.tsx",
    "components/ai/ModelChangelogPanel.tsx",
  ])("migrates %s away from visual-only list-header grids", (path) => {
    const component = source(path);
    expect(component).toContain("<DataTable");
    expect(component).not.toContain('className="list-header"');
    expect(component).not.toContain('className="list-row"');
  });

  it("migrates Segments away from unlabeled ad-hoc pagination", () => {
    const component = source("pages/Segments.tsx");
    expect(component).toContain("<DataTablePagination");
    expect(component).not.toContain('className="pagination"');
  });

  it("uses additive cursor controls for the audit log instead of fake page navigation", () => {
    const component = source("pages/audit/AuditListView.tsx");
    expect(component).toContain("<DataTableLoadMore");
    expect(component).not.toContain('className="pagination"');
  });
});
