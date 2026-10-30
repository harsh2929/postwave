import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { AuditRow } from "../../lib/api-client";
import {
  auditRowMatchesFilters,
  categoryToActionParam,
  createAuditFilterArgs,
  filterAuditRows,
  formatAuditRefreshAge,
  mergeUniqueAuditRows,
  pickAuditRows,
  sinceISO,
} from "../../pages/audit/audit-page-utils";

function row(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: overrides.id ?? "row-1",
    action: overrides.action ?? "subscriber.delete",
    actorType: overrides.actorType ?? "human",
    at: overrides.at ?? "2026-07-15T10:30:00.000Z",
    ...overrides,
  };
}

describe("audit page controller boundaries", () => {
  it("keeps unsafe evidence and governance workflows structurally unmounted", () => {
    const header = readFileSync(
      new URL("../../pages/audit/AuditPageHeader.tsx", import.meta.url),
      "utf8",
    );
    const filters = readFileSync(
      new URL("../../pages/audit/AuditFilterPanels.tsx", import.meta.url),
      "utf8",
    );
    const overlays = readFileSync(
      new URL("../../pages/audit/AuditPageOverlays.tsx", import.meta.url),
      "utf8",
    );
    const presentation = readFileSync(
      new URL("../../pages/audit/AuditPagePresentation.tsx", import.meta.url),
      "utf8",
    );
    const styles = readFileSync(
      new URL("../../styles-audit.css", import.meta.url),
      "utf8",
    );

    expect(header).toContain("AuditReleaseHolds");
    expect(header).toContain("PII projection is not server-verified");
    expect(header).not.toContain("PII masked");
    for (const unsafeOwner of [
      "RetentionEditor",
      "exportCsv",
      "setAsyncExportOpen",
      "setEvidenceSchedulesOpen",
      "openInvestigations",
      "setPortalSessionOpen",
    ]) {
      expect(header).not.toContain(unsafeOwner);
    }

    expect(filters).not.toContain("AuditNLQBar");
    expect(filters).not.toContain("AuditNLQSummary");
    expect(filters).not.toContain("AuditInsightsRow");
    expect(overlays).toContain("releaseContained");
    expect(overlays).not.toContain("AuditExportProgress");
    expect(overlays).not.toContain("AuditPortalSessionModal");
    expect(overlays).not.toContain("EvidencePackSchedulesModal");
    expect(presentation).toContain("<AuditReleaseHolds />");
    expect(presentation).toContain("<AuditViewReleaseHold");
    expect(presentation).not.toContain("AuditFacetChips");
    expect(styles).toContain(".audit-privacy-boundary");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("@media (forced-colors: active)");
  });

  it("keeps category and explicit-action filter precedence exact", () => {
    expect(categoryToActionParam("destructive")).toBe("delete");
    expect(categoryToActionParam("auth")).toBe("login");
    expect(categoryToActionParam("export")).toBe("export");
    expect(categoryToActionParam("one_click")).toBe("one_click");
    expect(categoryToActionParam("meta_audit")).toBe("audit.read");
    expect(categoryToActionParam("all")).toBeUndefined();
    expect(
      createAuditFilterArgs({
        actorType: "any",
        actorLabel: "  alice@example.com  ",
        actionQuery: "  campaign.pause  ",
        resourceType: "campaign",
        resourceId: "  campaign-42  ",
        days: 0,
        category: "destructive",
      }),
    ).toEqual({
      actorType: undefined,
      actorLabel: "alice@example.com",
      action: "campaign.pause",
      resourceType: "campaign",
      resourceId: "campaign-42",
      since: undefined,
    });
  });

  it("snaps date windows to UTC midnight", () => {
    expect(sinceISO(7, Date.parse("2026-07-16T18:45:00.000Z"))).toBe(
      "2026-07-09T00:00:00.000Z",
    );
    expect(sinceISO(0, 0)).toBeUndefined();
  });

  it("mirrors list filtering for SSE rows, including meta-row exclusion", () => {
    const candidate = row({
      action: "Campaign.Delete",
      actorLabel: "alice",
      resourceType: "campaign",
      resourceId: "Campaign-42-variant",
    });
    expect(
      auditRowMatchesFilters(candidate, {
        actorType: "human",
        actorLabel: "alice",
        action: "campaign.delete",
        resourceType: "campaign",
        resourceId: "campaign-42",
        since: "2026-07-15T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(auditRowMatchesFilters(row({ action: "audit.read.list" }), {})).toBe(
      false,
    );
    expect(auditRowMatchesFilters(candidate, { actorLabel: "bob" })).toBe(
      false,
    );
    expect(
      auditRowMatchesFilters(row({ at: "invalid" }), {
        since: "2026-07-15T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("unwraps every supported list envelope defensively", () => {
    const rows = [row()];
    expect(pickAuditRows(rows)).toEqual({ rows, nextCursor: undefined });
    expect(pickAuditRows({ rows, nextCursor: "next" })).toEqual({
      rows,
      nextCursor: "next",
    });
    expect(pickAuditRows({ items: rows })).toEqual({
      rows,
      nextCursor: undefined,
    });
    expect(pickAuditRows({ data: rows })).toEqual({
      rows,
      nextCursor: undefined,
    });
    expect(pickAuditRows({ rows: "invalid", nextCursor: 42 })).toEqual({
      rows: [],
      nextCursor: undefined,
    });
    expect(pickAuditRows(null)).toEqual({ rows: [], nextCursor: undefined });
  });

  it("fails closed on ambiguous, duplicate, and invalid list evidence", () => {
    const rows = [row()];
    expect(pickAuditRows({ rows, items: rows })).toEqual({
      rows: [],
      nextCursor: undefined,
    });
    expect(pickAuditRows({ rows: [row(), row()] })).toEqual({
      rows: [],
      nextCursor: undefined,
    });
    expect(
      pickAuditRows({ rows: [row({ at: "2026-02-30T00:00:00Z" })] }),
    ).toEqual({
      rows: [],
      nextCursor: undefined,
    });
  });

  it("applies exclusion and UTC drill-down facets without mutating rows", () => {
    const rows = [
      row({ id: "one", actorLabel: "alice", ip: "10.0.0.1" }),
      row({
        id: "two",
        actorLabel: "bob",
        resourceId: "campaign-2",
        at: "2026-07-16T12:15:00.000Z",
      }),
      row({ id: "bad", at: "invalid" }),
    ];
    expect(
      filterAuditRows(rows, [{ field: "actor", value: "alice" }], {
        kind: "day",
        dateIso: "2026-07-16",
      })?.map((item) => item.id),
    ).toEqual(["two"]);
    expect(
      filterAuditRows(rows, [], { kind: "dowHour", dow: 4, hour: 12 })?.map(
        (item) => item.id,
      ),
    ).toEqual(["two"]);
    expect(filterAuditRows(rows, [], null)).toBe(rows);
  });

  it("deduplicates buffered live rows while preserving newest-first order", () => {
    const existing = [row({ id: "two" }), row({ id: "one" })];
    const merged = mergeUniqueAuditRows(
      [row({ id: "three" }), row({ id: "two" })],
      existing,
    );
    expect(merged.rows.map((item) => item.id)).toEqual(["three", "two", "one"]);
    expect(merged.added).toBe(1);
  });

  it("keeps refresh labels and the thin-shell boundary explicit", () => {
    expect(formatAuditRefreshAge(2_000)).toBe("just now");
    expect(formatAuditRefreshAge(45_000)).toBe("45s ago");
    expect(formatAuditRefreshAge(120_000)).toBe("2m ago");
    expect(formatAuditRefreshAge(7_200_000)).toBe("2h ago");

    const page = readFileSync(
      new URL("../../pages/Audit.tsx", import.meta.url),
      "utf8",
    );
    expect(page).toContain("useAuditPageController");
    expect(page).toContain("AuditPagePresentation");
    expect(page).not.toContain("useState(");
    expect(page).not.toContain("api.");

    const budgets = readFileSync(
      new URL(
        "../../../scripts/function-quality-budgets.json",
        import.meta.url,
      ),
      "utf8",
    );
    expect(budgets).not.toContain('"src/pages/Audit.tsx"');
  });
});
