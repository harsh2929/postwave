import { describe, expect, it } from "vitest";

import type { DecodedApproval } from "../../lib/approvals-helpers";
import { decodeApprovalDetail } from "../../lib/approvals-helpers";
import { serializeDesktopRoute } from "../../lib/desktop-router";
import {
  approvalDetailRouteId,
  approvalRouteViewFromRoute,
  normalizedApprovalId,
  routeWithApprovalDetail,
  routeWithApprovalView,
  routeWithoutApprovalDetail,
} from "../../pages/approvals/approvals-route";
import {
  approvalResourceSummary,
  canRejectApproval,
  decodedApprovalAsRow,
  deriveApprovalWindowStats,
  formatApprovalInstant,
  formatApprovalRelative,
  visibleApprovalRows,
} from "../../pages/approvals/approvals-view-model";

function row(
  id: string,
  status: DecodedApproval["status"],
  overrides: Partial<DecodedApproval> = {},
): DecodedApproval {
  const resourceType = overrides.resourceType ?? "campaign";
  const labels: Record<DecodedApproval["status"], string> = {
    pending: "Pending review",
    approved: "Approved",
    rejected: "Rejected",
    expired: "Expired",
    unverified: "Status unverified",
  };
  return {
    id,
    resourceType,
    resourceId: `resource-${id}`,
    resourceLabel:
      overrides.resourceLabel ??
      (resourceType === "unverified" ? "Resource" : "Campaign"),
    status,
    statusLabel: labels[status],
    actionable: status === "pending" && resourceType !== "unverified",
    requestedAt: "2026-08-10T10:00:00Z",
    ...overrides,
  };
}

describe("approval route contract", () => {
  it("normalizes URL-backed tab, query, status, and sort without leaking invalid values", () => {
    expect(
      approvalRouteViewFromRoute({
        section: "approvals",
        tab: "history",
        query: `  launch\n${"x".repeat(180)}  `,
        filters: [
          { key: "irrelevant", value: "secret-filter-canary" },
          { key: "status", value: "rejected" },
        ],
        sort: { field: "requested", direction: "asc" },
      }),
    ).toEqual({
      tab: "history",
      query: `launch ${"x".repeat(113)}`,
      status: "rejected",
      sort: "oldest",
    });
    expect(
      approvalRouteViewFromRoute({
        section: "approvals",
        tab: "unsafe-tab",
        filters: [{ key: "status", value: "server-status-canary" }],
        sort: { field: "server-sort-canary", direction: "desc" },
      }),
    ).toEqual({ tab: "pending", query: "", status: "all", sort: "newest" });
    expect(
      approvalRouteViewFromRoute({
        section: "approvals",
        filters: [{ key: "status", value: "rejected" }],
        sort: { field: "status", direction: "asc" },
      }),
    ).toEqual({ tab: "pending", query: "", status: "all", sort: "newest" });
  });

  it("writes one canonical URL while preserving the selected workspace", () => {
    const next = routeWithApprovalView(
      { section: "approvals", tab: "history" },
      { query: "  Acme   launch  ", status: "rejected", sort: "oldest" },
    );
    expect(next).toEqual({
      section: "approvals",
      tab: "history",
      query: "Acme launch",
      filters: [{ key: "status", value: "rejected" }],
      sort: { field: "requested", direction: "asc" },
    });
    expect(serializeDesktopRoute(next)).toBe(
      "/app/approvals?tab=history&q=Acme+launch&sort=requested&dir=asc&f.status=rejected",
    );
    expect(
      routeWithApprovalView(next, {
        query: "",
        status: "all",
        sort: "newest",
      }),
    ).toEqual({
      section: "approvals",
      tab: "history",
      query: undefined,
      filters: undefined,
      sort: undefined,
    });
  });

  it("bounds search by complete Unicode characters and stays normalization-idempotent", () => {
    const emojiQuery = ` ${"a".repeat(119)}💥 `;
    const first = routeWithApprovalView(
      { section: "approvals" },
      { query: emojiQuery },
    );
    const firstQuery = first.query ?? "";
    expect(Array.from(firstQuery)).toHaveLength(120);
    expect(firstQuery.endsWith("💥")).toBe(true);
    expect(() => encodeURIComponent(firstQuery)).not.toThrow();

    const trailingBoundary = routeWithApprovalView(
      { section: "approvals" },
      { query: `${"b".repeat(119)} c` },
    );
    expect(trailingBoundary.query).toBe("b".repeat(119));
    expect(routeWithApprovalView(trailingBoundary, {}).query).toBe(
      trailingBoundary.query,
    );
  });

  it("opens and clears only a bounded approval-detail overlay", () => {
    const base = {
      section: "approvals" as const,
      tab: "history",
      query: "launch",
    };
    const detail = routeWithApprovalDetail(base, "approval:one@example.test");
    expect(detail).toEqual({
      ...base,
      overlay: {
        name: "approval-detail",
        resourceId: "approval:one@example.test",
      },
    });
    expect(detail && approvalDetailRouteId(detail)).toBe(
      "approval:one@example.test",
    );
    expect(detail && routeWithoutApprovalDetail(detail)).toEqual(base);
    expect(routeWithApprovalDetail(base, " approval-1 ")).toBeNull();
    expect(normalizedApprovalId("a".repeat(129))).toBeNull();
    expect(
      routeWithoutApprovalDetail({
        ...base,
        overlay: { name: "another-overlay", resourceId: "approval-1" },
      }),
    ).toMatchObject({
      overlay: { name: "another-overlay", resourceId: "approval-1" },
    });
  });
});

describe("approval bounded-window view model", () => {
  const rows = [
    row("pending-new", "pending", {
      requestedAt: "2026-08-11T10:00:00Z",
      resourceId: "campaign-zulu",
      requestedByActorLabel: "Zoë",
      notes: "Final audience review",
    }),
    row("pending-old", "pending", {
      requestedAt: "2026-08-09T10:00:00Z",
      resourceId: "campaign-alpha",
      requestedByActorLabel: "Alice",
    }),
    row("approved", "approved", {
      requestedAt: "2026-08-08T10:00:00Z",
      decidedAt: "2026-08-10T10:00:00Z",
      resourceId: "campaign-beta",
      requestedByActorLabel: "Bruno",
    }),
    row("rejected", "rejected", {
      requestedAt: "2026-08-07T10:00:00Z",
      decidedAt: "2026-08-09T10:00:00Z",
      resourceId: "campaign-charlie",
      requestedByActorLabel: "Charlie",
      notes: "Audience is not approved",
    }),
    row("expired", "expired", {
      requestedAt: "2026-08-06T10:00:00Z",
      resourceId: "campaign-delta",
    }),
    row("unknown", "unverified", {
      requestedAt: "2026-08-05T10:00:00Z",
      resourceType: "unverified",
      resourceLabel: "Resource",
      resourceId: "future-resource",
      actionable: false,
    }),
  ];

  it("separates pending/history and applies URL-backed search, status, and sort", () => {
    const pending = visibleApprovalRows(rows, "pending", {
      tab: "pending",
      query: "audience",
      status: "all",
      sort: "oldest",
    });
    expect(pending.map(({ id }) => id)).toEqual(["pending-new"]);

    const history = visibleApprovalRows(rows, "history", {
      tab: "history",
      query: "not approved",
      status: "rejected",
      sort: "status",
    });
    expect(history.map(({ id }) => id)).toEqual(["rejected"]);
    expect(
      visibleApprovalRows(rows, "history", {
        tab: "history",
        query: "",
        status: "all",
        sort: "resource",
      }).map(({ id }) => id),
    ).toEqual(["approved", "rejected", "expired", "unknown"]);
    expect(
      visibleApprovalRows(rows, "governance", {
        tab: "governance",
        query: "",
        status: "all",
        sort: "newest",
      }),
    ).toEqual([]);
  });

  it("formats exact and relative past/future times deterministically", () => {
    const now = Date.parse("2026-08-11T10:00:00Z");
    expect(formatApprovalRelative("2026-08-11T12:00:00Z", now)).toBe(
      "in 2 hours",
    );
    expect(formatApprovalRelative("2026-08-11T08:00:00Z", now)).toBe(
      "2 hours ago",
    );
    expect(formatApprovalRelative("2026-08-11T10:00:20Z", now)).toBe(
      "in a few seconds",
    );
    expect(formatApprovalRelative("invalid", now)).toBe("Time unavailable");

    const instant = "2026-08-11T12:00:00Z";
    expect(formatApprovalInstant(instant)).toBe(
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(Date.parse(instant)),
    );
    expect(formatApprovalInstant(undefined)).toBe("Unavailable");
  });

  it("derives only loaded-window statistics with bounded time rules", () => {
    const now = Date.parse("2026-08-11T10:00:00Z");
    const stats = deriveApprovalWindowStats(
      [
        row("pending-expiring", "pending", {
          expiresAt: "2026-08-12T09:59:59Z",
        }),
        row("pending-expired", "pending", {
          expiresAt: "2026-08-11T09:59:59Z",
        }),
        row("approved-window", "approved", {
          requestedAt: "2026-08-10T08:00:00Z",
          decidedAt: "2026-08-10T10:00:00Z",
        }),
        row("rejected-window", "rejected", {
          requestedAt: "2026-08-09T09:00:00Z",
          decidedAt: "2026-08-09T10:00:00Z",
        }),
        row("approved-old", "approved", {
          requestedAt: "2026-07-01T09:00:00Z",
          decidedAt: "2026-07-01T10:00:00Z",
        }),
        row("future-decision", "rejected", {
          requestedAt: "2026-08-11T09:00:00Z",
          decidedAt: "2026-08-12T10:00:00Z",
        }),
      ],
      now,
    );
    expect(stats).toEqual({
      approvedSevenDays: 1,
      rejectedSevenDays: 1,
      averageDecisionMinutes: 80,
    });
  });

  it("requires an exact future expiry before a pending rejection is eligible", () => {
    const now = Date.parse("2026-08-11T10:00:00Z");
    expect(
      canRejectApproval(
        row("future", "pending", { expiresAt: "2026-08-11T10:00:01Z" }),
        now,
      ),
    ).toBe(true);
    expect(canRejectApproval(row("missing", "pending"), now)).toBe(false);
    expect(
      canRejectApproval(
        row("elapsed", "pending", { expiresAt: "2026-08-11T10:00:00Z" }),
        now,
      ),
    ).toBe(false);
  });

  it("keeps unknown status/resource values local and non-actionable", () => {
    const statusCanary = "future_status_canary";
    const resourceCanary = "future_resource_canary";
    const decoded = decodeApprovalDetail({
      id: "approval-unknown",
      status: statusCanary,
      resourceType: resourceCanary,
      resourceId: "resource-unknown",
      requestedAt: "2026-08-11T10:00:00Z",
      metadata: { secret: "metadata-canary" },
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.data).toMatchObject({
      status: "unverified",
      resourceType: "unverified",
      statusLabel: "Status unverified",
      resourceLabel: "Resource",
      actionable: false,
    });
    expect(approvalResourceSummary(decoded.data)).toBe(
      "Resource · resource-unknown",
    );
    expect(decodedApprovalAsRow(decoded.data)).not.toHaveProperty("metadata");
    expect(JSON.stringify(decodedApprovalAsRow(decoded.data))).not.toContain(
      "canary",
    );
  });
});
