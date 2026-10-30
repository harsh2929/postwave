import { describe, expect, it } from "vitest";

import { decodeSmsConversationsPage } from "./smsConversation";
import {
  decodeSmsSearchPage,
  mergeSmsSearchPages,
  smsSearchQueryError,
} from "./smsInboxSearch";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT = "2026-08-21T10:00:00Z";

function summary(over: Record<string, unknown> = {}) {
  return {
    phoneE164: "+15552345678",
    identityAmbiguous: false,
    lastMessagePreview: "Order 1042 refund please",
    lastMessageAt: "2026-08-21T09:00:00Z",
    lastDirection: "inbound",
    messageCount: 4,
    unreadCount: 0,
    ...over,
  };
}

function page(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    conversations: [summary()],
    snapshotAt: SNAPSHOT,
    ...over,
  };
}

describe("smsSearchQueryError", () => {
  it("requires 3 to 128 safe code points", () => {
    expect(smsSearchQueryError("ab")).toContain("at least 3");
    expect(smsSearchQueryError("  ab  ")).toContain("at least 3");
    expect(smsSearchQueryError("a".repeat(129))).toContain("128");
    expect(smsSearchQueryError("refund")).toBeNull();
    // 3 astral characters — counted by code points, not UTF-16 units.
    expect(smsSearchQueryError("\u{1D482}\u{1D483}\u{1D484}")).toBeNull();
  });

  it("rejects control and invisible format characters like the server", () => {
    expect(smsSearchQueryError("ab\u0007c")).toContain("control");
    expect(smsSearchQueryError("ab\u202ec")).toContain("control");
  });
});

describe("decodeSmsSearchPage", () => {
  it("decodes rows and carries stateUpdatedAt for bulk CAS", () => {
    const decoded = decodeSmsSearchPage(
      page({
        conversations: [
          summary({ stateUpdatedAt: "2026-08-20T10:00:00Z" }),
          summary({
            phoneE164: "+15552345679",
            lastMessageAt: "2026-08-21T08:00:00Z",
          }),
        ],
        nextCursor: "cursor-1",
      }),
      { tenantId: TENANT },
    );
    expect(decoded.conversations).toHaveLength(2);
    expect(decoded.conversations[0]?.stateUpdatedAt).toBe(
      "2026-08-20T10:00:00Z",
    );
    expect(decoded.conversations[1]?.stateUpdatedAt).toBeUndefined();
    expect(decoded.nextCursor).toBe("cursor-1");
    expect(decoded.snapshotAt).toBe(SNAPSHOT);
  });

  it("refuses another tenant's envelope", () => {
    expect(() =>
      decodeSmsSearchPage(page(), {
        tenantId: "99999999-9999-4999-8999-999999999999",
      }),
    ).toThrow(/another tenant/);
  });

  it("refuses rows out of recency order", () => {
    expect(() =>
      decodeSmsSearchPage(
        page({
          conversations: [
            summary({
              phoneE164: "+15552345679",
              lastMessageAt: "2026-08-21T08:00:00Z",
            }),
            summary(),
          ],
        }),
        { tenantId: TENANT },
      ),
    ).toThrow(/recency order/);
  });

  it("refuses duplicate phones and unknown envelope keys", () => {
    expect(() =>
      decodeSmsSearchPage(page({ conversations: [summary(), summary()] }), {
        tenantId: TENANT,
      }),
    ).toThrow(/duplicates/);
    expect(() =>
      decodeSmsSearchPage(page({ unreadTotal: 3 }), { tenantId: TENANT }),
    ).toThrow(/not part of the contract/);
  });

  it("refuses a row newer than the response cutoff", () => {
    expect(() =>
      decodeSmsSearchPage(
        page({
          conversations: [summary({ lastMessageAt: "2026-08-21T11:00:00Z" })],
        }),
        { tenantId: TENANT },
      ),
    ).toThrow(/response cutoff/);
  });
});

describe("mergeSmsSearchPages", () => {
  const decoded = (over: Record<string, unknown> = {}) =>
    decodeSmsSearchPage(page(over), { tenantId: TENANT });

  it("flattens continuation pages in order", () => {
    const merged = mergeSmsSearchPages([
      decoded({ nextCursor: "c1" }),
      decoded({
        conversations: [
          summary({
            phoneE164: "+15552345679",
            lastMessageAt: "2026-08-21T08:00:00Z",
          }),
        ],
      }),
    ]);
    expect(merged.conversations.map((row) => row.phoneE164)).toEqual([
      "+15552345678",
      "+15552345679",
    ]);
    expect(merged.hasMore).toBe(false);
    expect(merged.snapshotAt).toBe(SNAPSHOT);
  });

  it("refuses overlap and a different response cutoff", () => {
    expect(() => mergeSmsSearchPages([decoded(), decoded()])).toThrow(
      /overlap/,
    );
    expect(() =>
      mergeSmsSearchPages([
        decoded(),
        decoded({ snapshotAt: "2026-08-21T10:00:01Z" }),
      ]),
    ).toThrow(/another response cutoff/);
  });
});

describe("decodeSmsConversationsPage stateUpdatedAt", () => {
  it("accepts and carries the lifecycle CAS token the server now sends", () => {
    const decoded = decodeSmsConversationsPage(
      {
        tenantId: TENANT,
        conversations: [summary({ stateUpdatedAt: "2026-08-20T10:00:00Z" })],
        snapshotAt: SNAPSHOT,
        unreadTotal: 0,
        unknownTotal: 1,
        totalConversations: 1,
        activeTotal: 1,
        snoozedTotal: 0,
        archivedTotal: 0,
      },
      {
        tenantId: TENANT,
        query: { filter: "all", sort: "recent", status: "active" },
      },
    );
    expect(decoded.conversations[0]?.stateUpdatedAt).toBe(
      "2026-08-20T10:00:00Z",
    );
  });
});
