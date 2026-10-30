import { describe, expect, it } from "vitest";

import {
  isSnapshotableView,
  projectSubscriberListSnapshot,
  snapshotAsPage,
  SNAPSHOT_MAX_ROWS,
  SUBSCRIBER_LIST_OFFLINE_MESSAGE,
} from "./subscriberListSnapshot";

const DEFAULT_VIEW = {
  query: "",
  status: undefined,
  sortToken: "updated_at:desc",
  defaultSortToken: "updated_at:desc",
  page: 1,
};

describe("isSnapshotableView", () => {
  it("accepts only the unfiltered first page in default order", () => {
    expect(isSnapshotableView(DEFAULT_VIEW)).toBe(true);
  });

  it("refuses a search, a filter, another order, or a later page", () => {
    expect(isSnapshotableView({ ...DEFAULT_VIEW, query: "ada" })).toBe(false);
    expect(isSnapshotableView({ ...DEFAULT_VIEW, status: "enabled" })).toBe(false);
    expect(
      isSnapshotableView({ ...DEFAULT_VIEW, sortToken: "email:asc" }),
    ).toBe(false);
    expect(isSnapshotableView({ ...DEFAULT_VIEW, page: 2 })).toBe(false);
  });

  it("treats a whitespace-only query as unfiltered", () => {
    expect(isSnapshotableView({ ...DEFAULT_VIEW, query: "   " })).toBe(true);
  });
});

describe("projectSubscriberListSnapshot", () => {
  it("returns null for a payload that is not a page", () => {
    // A transient bad response must not overwrite a good snapshot with an
    // empty one.
    expect(projectSubscriberListSnapshot(null, 1)).toBeNull();
    expect(projectSubscriberListSnapshot("nope", 1)).toBeNull();
    expect(projectSubscriberListSnapshot({ total: 4 }, 1)).toBeNull();
  });

  it("keeps only the fields the row renders", () => {
    const snap = projectSubscriberListSnapshot(
      {
        items: [
          {
            id: "s1",
            email: "a@b.co",
            status: "enabled",
            first_name: "Ada",
            engagement_score: 71,
            rating: 4,
            tags: ["vip", "beta", "eu", "extra"],
            custom_fields: { secret: "value" },
            merge_fields: { FNAME: "Ada" },
            consent_evidence: "a very long attestation",
          },
        ],
        total: 100,
      },
      1234,
    );
    const row = snap!.items[0]!;
    expect(row).toEqual({
      id: "s1",
      email: "a@b.co",
      status: "enabled",
      first_name: "Ada",
      engagement_score: 71,
      rating: 4,
      tags: ["vip", "beta", "eu"],
    });
    expect("custom_fields" in row).toBe(false);
    expect("consent_evidence" in row).toBe(false);
    expect(snap!.capturedAt).toBe(1234);
    expect(snap!.hasMore).toBe(true);
  });

  it("drops a row with no address — it cannot be rendered or routed to", () => {
    const snap = projectSubscriberListSnapshot(
      { items: [{ id: "x" }, { email: "ok@b.co" }] },
      0,
    );
    expect(snap!.items).toHaveLength(1);
    expect(snap!.items[0]!.email).toBe("ok@b.co");
  });

  it("caps at one page's worth of rows", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      email: `a${i}@b.co`,
    }));
    expect(projectSubscriberListSnapshot({ items }, 0)!.items).toHaveLength(
      SNAPSHOT_MAX_ROWS,
    );
  });

  it("omits scores the server did not send rather than storing zero", () => {
    const row = projectSubscriberListSnapshot(
      { items: [{ email: "a@b.co", engagement_score: null, rating: "x" }] },
      0,
    )!.items[0]!;
    expect("engagement_score" in row).toBe(false);
    expect("rating" in row).toBe(false);
  });

  it("stringifies a numeric id so routing keeps working", () => {
    const row = projectSubscriberListSnapshot(
      { items: [{ id: 42, email: "a@b.co" }] },
      0,
    )!.items[0]!;
    expect(row.id).toBe("42");
  });

  it("reports hasMore false when the server sent no total", () => {
    const snap = projectSubscriberListSnapshot({ items: [{ email: "a@b.co" }] }, 0);
    expect(snap!.hasMore).toBe(false);
    expect(snap!.total).toBeUndefined();
  });
});

describe("snapshotAsPage", () => {
  it("never invents a total from the row count", () => {
    const page = snapshotAsPage({
      items: [{ email: "a@b.co" }],
      capturedAt: 0,
      hasMore: false,
    });
    expect("total" in page).toBe(false);
  });

  it("preserves a real total", () => {
    const page = snapshotAsPage({
      items: [{ email: "a@b.co" }],
      total: 900,
      capturedAt: 0,
      hasMore: true,
    });
    expect(page.total).toBe(900);
    expect(page.page).toBe(1);
  });
});

describe("copy", () => {
  it("says exactly what is and is not available offline", () => {
    expect(SUBSCRIBER_LIST_OFFLINE_MESSAGE).toMatch(/unfiltered first page/i);
    expect(SUBSCRIBER_LIST_OFFLINE_MESSAGE).toMatch(/searches, filters/i);
  });
});
