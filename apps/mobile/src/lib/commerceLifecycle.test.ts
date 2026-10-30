import { describe, expect, it } from "vitest";

import {
  lifecycleErrorMessage,
  lifecycleEvaluateConfirmCopy,
  lifecycleEvaluationOutcomeCopy,
  lifecycleReportIsEmpty,
  lifecycleReportMatches,
  offersLifecycleEvaluation,
  parseCommerceLifecycleReport,
  parseLifecycleEvaluation,
} from "./commerceLifecycle";

const REPORT = {
  integration_id: "int_1",
  generated_at: "2026-09-03T10:00:00Z",
  cart_recovery: { total: 4, by_status: { pending: 3, recovered: 1 } },
  back_in_stock: { total: 12, by_status: { eligible: 2, waiting: 10 } },
  price_drop: { total: 1, by_status: { waiting: 1 } },
  events_last_30_days: { "commerce.back_in_stock.eligible": 2 },
  eligible_last_30_days: 5,
  notified_pending: 2,
};

describe("parseCommerceLifecycleReport", () => {
  it("keeps the server's status vocabulary verbatim, sorted for stability", () => {
    const report = parseCommerceLifecycleReport(REPORT);
    expect(report).not.toBeNull();
    const backInStock = report?.queues.find((q) => q.kind === "back_in_stock");
    expect(backInStock?.total).toBe(12);
    expect(backInStock?.byStatus).toEqual([
      { key: "eligible", count: 2 },
      { key: "waiting", count: 10 },
    ]);
    expect(report?.eventsLast30Days).toEqual([
      { key: "commerce.back_in_stock.eligible", count: 2 },
    ]);
  });

  it("renders a status this build has never seen rather than dropping it", () => {
    const report = parseCommerceLifecycleReport({
      ...REPORT,
      price_drop: { total: 3, by_status: { quarantined_by_a_future_build: 3 } },
    });
    expect(
      report?.queues.find((q) => q.kind === "price_drop")?.byStatus,
    ).toEqual([{ key: "quarantined_by_a_future_build", count: 3 }]);
  });

  it("keeps an absent count null instead of calling it zero", () => {
    const report = parseCommerceLifecycleReport({
      integration_id: "int_1",
      cart_recovery: {},
    });
    expect(report?.eligibleLast30Days).toBeNull();
    expect(report?.notifiedPending).toBeNull();
    expect(report?.queues[0]?.total).toBeNull();
    expect(report?.queues[0]?.byStatus).toEqual([]);
  });

  it("refuses a non-object body", () => {
    expect(parseCommerceLifecycleReport(null)).toBeNull();
    expect(parseCommerceLifecycleReport([REPORT])).toBeNull();
    expect(parseCommerceLifecycleReport("report")).toBeNull();
  });
});

describe("lifecycleReportMatches", () => {
  it("rejects a report that belongs to another store", () => {
    const report = parseCommerceLifecycleReport(REPORT);
    expect(lifecycleReportMatches(report, "int_1")).toBe(true);
    expect(lifecycleReportMatches(report, "int_2")).toBe(false);
    expect(lifecycleReportMatches(report, null)).toBe(false);
    expect(lifecycleReportMatches(null, "int_1")).toBe(false);
  });

  it("accepts a report that names no store, which cannot contradict anything", () => {
    const report = parseCommerceLifecycleReport({
      ...REPORT,
      integration_id: "",
    });
    expect(lifecycleReportMatches(report, "int_1")).toBe(true);
  });
});

describe("lifecycleReportIsEmpty", () => {
  it("is empty only when every queue, event and figure is empty", () => {
    expect(
      lifecycleReportIsEmpty(
        parseCommerceLifecycleReport({
          integration_id: "int_1",
          cart_recovery: { total: 0, by_status: {} },
          back_in_stock: { total: 0, by_status: {} },
          price_drop: { total: 0, by_status: {} },
          events_last_30_days: {},
          eligible_last_30_days: 0,
          notified_pending: 0,
        }),
      ),
    ).toBe(true);
    expect(lifecycleReportIsEmpty(parseCommerceLifecycleReport(REPORT))).toBe(
      false,
    );
  });

  it("is not empty when only the pending-notification figure is non-zero", () => {
    expect(
      lifecycleReportIsEmpty(
        parseCommerceLifecycleReport({
          integration_id: "int_1",
          cart_recovery: { total: 0 },
          back_in_stock: { total: 0 },
          price_drop: { total: 0 },
          notified_pending: 7,
        }),
      ),
    ).toBe(false);
  });
});

describe("offersLifecycleEvaluation", () => {
  it("needs the admin role AND a connection", () => {
    expect(offersLifecycleEvaluation({ canAdmin: true, online: true })).toBe(
      true,
    );
    expect(offersLifecycleEvaluation({ canAdmin: false, online: true })).toBe(
      false,
    );
    expect(offersLifecycleEvaluation({ canAdmin: true, online: false })).toBe(
      false,
    );
  });
});

describe("lifecycleEvaluateConfirmCopy", () => {
  it("quotes the report's own counts and says eligible is not notified", () => {
    const copy = lifecycleEvaluateConfirmCopy(
      "acme.myshopify.com",
      parseCommerceLifecycleReport(REPORT),
    );
    expect(copy.title).toContain("acme.myshopify.com");
    expect(copy.message).toContain("12 back-in-stock subscriptions");
    expect(copy.message).toContain("1 price-drop watcher");
    expect(copy.consequence).toContain("Eligible is not notified");
    expect(copy.confirmLabel).toBe("Run evaluation");
  });

  it("invents no number when the report gave none", () => {
    const copy = lifecycleEvaluateConfirmCopy("acme", null);
    expect(copy.message).toContain("did not give a count");
    expect(copy.message).not.toMatch(/\d/);
  });
});

describe("lifecycleEvaluationOutcomeCopy", () => {
  it("reports the server's two counters and denies delivery", () => {
    const copy = lifecycleEvaluationOutcomeCopy(
      parseLifecycleEvaluation({
        back_in_stock_eligible: 2,
        price_drop_eligible: 1,
        evaluated_at: "2026-09-03T10:05:00Z",
      }),
    );
    expect(copy).toContain("2 back-in-stock subscriptions");
    expect(copy).toContain("1 price-drop watcher are now eligible to notify");
    expect(copy).toContain("Nothing has been sent.");
  });

  it("refuses to claim success when the acknowledgement has no counters", () => {
    for (const summary of [
      null,
      parseLifecycleEvaluation({ back_in_stock_eligible: 2 }),
      parseLifecycleEvaluation("ok"),
    ]) {
      expect(lifecycleEvaluationOutcomeCopy(summary)).toContain(
        "counters could not be read",
      );
    }
  });
});

describe("lifecycleErrorMessage", () => {
  it("separates the role, the missing store and the disconnected store", () => {
    expect(lifecycleErrorMessage({ status: 403 }, "evaluate")).toContain(
      "owner or admin",
    );
    expect(lifecycleErrorMessage({ status: 403 }, "read")).toContain(
      "lifecycle report",
    );
    expect(lifecycleErrorMessage({ status: 404 }, "read")).toContain(
      "no longer exists",
    );
    expect(lifecycleErrorMessage({ status: 409 }, "evaluate")).toContain(
      "disconnected",
    );
  });

  it("prefers the server's own sentence over a generic one", () => {
    const err = Object.assign(new Error("provider cursor is stale"), {
      status: 500,
    });
    expect(lifecycleErrorMessage(err, "evaluate")).toBe(
      "provider cursor is stale",
    );
    expect(lifecycleErrorMessage({ status: 500 }, "evaluate")).toBe(
      "Couldn't run the evaluation.",
    );
  });
});
