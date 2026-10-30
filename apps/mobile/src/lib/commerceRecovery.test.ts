import { describe, expect, it } from "vitest";

import {
  awaitingNotice,
  longestWaitMs,
  normalizeRecoveryPage,
  recoverySummary,
  shortRef,
} from "./commerceRecovery";

describe("normalizeRecoveryPage", () => {
  it("maps the three closed status vocabularies onto one display class", () => {
    const carts = normalizeRecoveryPage("carts", {
      items: [
        { id: "c1", status: "active" },
        { id: "c2", status: "converted" },
        { id: "c3", status: "disabled" },
        { id: "c4", status: "expired" },
      ],
    });
    expect(carts.items.map((row) => row.statusClass)).toEqual([
      "open",
      "converted",
      "closed",
      "closed",
    ]);

    const bis = normalizeRecoveryPage("back-in-stock", {
      items: [
        { id: "b1", status: "waiting" },
        { id: "b2", status: "eligible" },
        { id: "b3", status: "notified" },
        { id: "b4", status: "cancelled" },
      ],
    });
    expect(bis.items.map((row) => row.statusClass)).toEqual([
      "open",
      "eligible",
      "notified",
      "closed",
    ]);

    // `watching`, not `waiting` — the price-drop table's own initial word.
    const pdw = normalizeRecoveryPage("price-drops", {
      items: [{ id: "p1", status: "watching" }],
    });
    expect(pdw.items[0]?.statusClass).toBe("open");
  });

  it("keeps an unknown status verbatim and classes it `other`", () => {
    const page = normalizeRecoveryPage("back-in-stock", {
      items: [{ id: "b1", status: "quarantined" }],
    });
    expect(page.items[0]?.status).toBe("quarantined");
    expect(page.items[0]?.statusClass).toBe("other");
  });

  it("reads the per-kind start timestamp, not a single shared field", () => {
    const cart = normalizeRecoveryPage("carts", {
      items: [
        { id: "c1", status: "active", created_at: "2026-07-01T00:00:00Z" },
      ],
    });
    expect(cart.items[0]?.startedAt).toBe("2026-07-01T00:00:00Z");

    const bis = normalizeRecoveryPage("back-in-stock", {
      items: [
        { id: "b1", status: "waiting", requested_at: "2026-07-02T00:00:00Z" },
      ],
    });
    expect(bis.items[0]?.startedAt).toBe("2026-07-02T00:00:00Z");

    const pdw = normalizeRecoveryPage("price-drops", {
      items: [
        { id: "p1", status: "watching", watched_at: "2026-07-03T00:00:00Z" },
      ],
    });
    expect(pdw.items[0]?.startedAt).toBe("2026-07-03T00:00:00Z");
  });

  it("drops rows without an id rather than inventing a key", () => {
    const page = normalizeRecoveryPage("carts", {
      items: [{ status: "active" }, { id: "c2", status: "active" }, null, 7],
    });
    expect(page.items.map((row) => row.id)).toEqual(["c2"]);
    expect(page.sampled).toBe(1);
  });

  it("treats a missing price as null, never as zero", () => {
    const page = normalizeRecoveryPage("price-drops", {
      items: [
        {
          id: "p1",
          status: "watching",
          original_price_cents: 2500,
          currency: "eur",
        },
      ],
    });
    const row = page.items[0];
    expect(row?.originalPriceCents).toBe(2500);
    expect(row?.targetPriceCents).toBeNull();
    expect(row?.minDropPercent).toBeNull();
    expect(row?.currency).toBe("EUR");
  });

  it("does not carry price fields onto non-watcher rows", () => {
    const page = normalizeRecoveryPage("back-in-stock", {
      items: [
        { id: "b1", status: "waiting", original_price_cents: 999, currency: "usd" },
      ],
    });
    expect(page.items[0]?.originalPriceCents).toBeNull();
    expect(page.items[0]?.currency).toBe("");
  });

  it("reports hasMore from next_cursor and survives a non-object payload", () => {
    expect(
      normalizeRecoveryPage("carts", {
        items: [{ id: "c1", status: "active" }],
        next_cursor: "abc",
      }).hasMore,
    ).toBe(true);
    expect(normalizeRecoveryPage("carts", { items: [] }).hasMore).toBe(false);
    expect(normalizeRecoveryPage("carts", null).items).toEqual([]);
    expect(normalizeRecoveryPage("carts", "nope").sampled).toBe(0);
  });

  it("rejects an unparseable timestamp instead of passing it through", () => {
    const page = normalizeRecoveryPage("back-in-stock", {
      items: [{ id: "b1", status: "eligible", eligible_at: "not-a-date" }],
    });
    expect(page.items[0]?.eligibleAt).toBe("");
  });
});

describe("awaitingNotice / longestWaitMs", () => {
  const page = normalizeRecoveryPage("back-in-stock", {
    items: [
      { id: "b1", status: "eligible", eligible_at: "2026-07-20T00:00:00Z" },
      { id: "b2", status: "eligible", eligible_at: "2026-07-22T00:00:00Z" },
      { id: "b3", status: "notified", eligible_at: "2026-01-01T00:00:00Z" },
      { id: "b4", status: "waiting" },
    ],
  });

  it("counts only rows the server judged eligible and never notified", () => {
    expect(awaitingNotice(page.items)).toBe(2);
  });

  it("measures from the OLDEST eligible row", () => {
    const now = Date.parse("2026-07-23T00:00:00Z");
    expect(longestWaitMs(page.items, now)).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("returns null — not zero — when nothing is eligible", () => {
    const quiet = normalizeRecoveryPage("back-in-stock", {
      items: [{ id: "b1", status: "notified" }],
    });
    expect(longestWaitMs(quiet.items, Date.now())).toBeNull();
  });

  it("returns null when an eligible row carries no eligible_at", () => {
    const unmeasured = normalizeRecoveryPage("back-in-stock", {
      items: [{ id: "b1", status: "eligible" }],
    });
    expect(awaitingNotice(unmeasured.items)).toBe(1);
    expect(longestWaitMs(unmeasured.items, Date.now())).toBeNull();
  });
});

describe("recoverySummary", () => {
  it("says nothing at all for an empty list", () => {
    expect(recoverySummary(normalizeRecoveryPage("carts", { items: [] }))).toBe(
      "",
    );
  });

  it("distinguishes a truncated page from a complete one", () => {
    const truncated = normalizeRecoveryPage("back-in-stock", {
      items: [
        { id: "b1", status: "eligible" },
        { id: "b2", status: "waiting" },
      ],
      next_cursor: "more",
    });
    expect(recoverySummary(truncated)).toBe(
      "1 of the newest 2 is waiting to be told.",
    );

    const complete = normalizeRecoveryPage("back-in-stock", {
      items: [
        { id: "b1", status: "eligible" },
        { id: "b2", status: "eligible" },
      ],
    });
    expect(recoverySummary(complete)).toBe(
      "2 of all 2 rows are waiting to be told.",
    );
  });

  it("states the quiet case positively rather than as a zero", () => {
    const quiet = normalizeRecoveryPage("carts", {
      items: [{ id: "c1", status: "converted" }],
    });
    expect(recoverySummary(quiet)).toBe(
      "Nothing is waiting to be told, across the only row.",
    );
  });
});

describe("shortRef", () => {
  it("keeps a short reference whole and tails a long opaque id", () => {
    expect(shortRef("cart_42")).toBe("cart_42");
    expect(shortRef("018f8a1e-3c4d-7a11-9f2b-abcdef123456")).toBe("…ef123456");
    expect(shortRef("  ")).toBe("");
  });
});
