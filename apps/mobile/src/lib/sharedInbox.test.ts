import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  data: new Map<string, string>(),
  failRemoveKey: null as string | null,
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

vi.mock("@bacons/apple-targets", () => ({
  ExtensionStorage: class {
    set(key: string, value: string) {
      native.data.set(key, value);
    }
    get(key: string) {
      return native.data.get(key) ?? null;
    }
    remove(key: string) {
      if (native.failRemoveKey === key) {
        native.failRemoveKey = null;
        throw new Error("remove failed");
      }
      native.data.delete(key);
    }
    static reloadWidget() {}
  },
}));

// eslint-disable-next-line import/first
import {
  SHARED_INBOX_POLICY,
  actionForSharedItem,
  clearSharedInbox,
  clearSharedInboxStrict,
  parseSharedItems,
  restoreSharedInboxItem,
  takeSharedInboxItem,
  type SharedItem,
} from "./sharedInbox";

const NOW = 2_000_000_000;
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

function item(
  value: string,
  kind: SharedItem["kind"] = "email",
  createdAt = NOW,
): SharedItem {
  return { kind, value, createdAt };
}

beforeEach(() => {
  native.data.clear();
  native.failRemoveKey = null;
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseSharedItems", () => {
  it("returns [] for empty, malformed, non-array, and oversized queues", () => {
    expect(parseSharedItems(null, NOW)).toEqual([]);
    expect(parseSharedItems("{not json", NOW)).toEqual([]);
    expect(parseSharedItems('{"kind":"email"}', NOW)).toEqual([]);
    expect(
      parseSharedItems("x".repeat(SHARED_INBOX_POLICY.maxQueueBytes + 1), NOW),
    ).toEqual([]);
  });

  it("accepts only the minimal v2 entity/email schema", () => {
    const raw = JSON.stringify([
      item(" person@example.com "),
      item("moosewave://campaign/cam_1?secret=discard#fragment", "entity"),
      { url: "https://example.com", createdAt: NOW },
      { text: "arbitrary note", createdAt: NOW },
      { kind: "email", value: "not an email", createdAt: NOW },
      null,
    ]);

    expect(parseSharedItems(raw, NOW)).toEqual([
      item("person@example.com"),
      item("moosewave://campaign/cam_1", "entity"),
    ]);
  });

  it("rejects stale and excessively future-skewed records at the boundary", () => {
    const policy = SHARED_INBOX_POLICY;
    const raw = JSON.stringify([
      item("live@example.com", "email", NOW - policy.maxAgeSeconds),
      item("stale@example.com", "email", NOW - policy.maxAgeSeconds - 1),
      item("current@example.com", "email", NOW + policy.maxFutureSkewSeconds),
      item(
        "too-far@example.com",
        "email",
        NOW + policy.maxFutureSkewSeconds + 1,
      ),
    ]);

    expect(parseSharedItems(raw, NOW)).toEqual([
      item("live@example.com", "email", NOW - policy.maxAgeSeconds),
      item("current@example.com", "email", NOW + policy.maxFutureSkewSeconds),
    ]);
  });

  it("keeps only the newest bounded queue entries", () => {
    const raw = JSON.stringify(
      Array.from({ length: 12 }, (_, index) =>
        item(`person${index}@example.com`),
      ),
    );

    const parsed = parseSharedItems(raw, NOW);
    expect(parsed).toHaveLength(SHARED_INBOX_POLICY.maxQueueItems);
    expect(parsed[0]?.value).toBe("person4@example.com");
    expect(parsed.at(-1)?.value).toBe("person11@example.com");
  });

  it("rejects generic URLs instead of retaining arbitrary navigation data", () => {
    expect(
      parseSharedItems(
        JSON.stringify([item("https://example.com/private?q=1", "entity")]),
        NOW,
      ),
    ).toEqual([]);
    expect(
      parseSharedItems(
        JSON.stringify([
          item(
            "https://user:secret@app.moosewave.com/app/campaigns/cam_1",
            "entity",
          ),
        ]),
        NOW,
      ),
    ).toEqual([]);
  });

  it("rejects an individually oversized record even when its action is valid", () => {
    const raw = JSON.stringify([
      {
        ...item("person@example.com"),
        ignoredPadding: "x".repeat(SHARED_INBOX_POLICY.maxItemBytes),
      },
    ]);

    expect(parseSharedItems(raw, NOW)).toEqual([]);
  });
});

describe("actionForSharedItem", () => {
  it("navigates a bare email to pre-searched Subscribers", () => {
    const action = actionForSharedItem(item("person@example.com"));
    expect(action?.type).toBe("navigate");
    const href = (
      action as { href: { pathname: string; params: Record<string, string> } }
    ).href;
    expect(href.pathname).toBe("/(tabs)/subscribers");
    expect(href.params.q).toBe("person@example.com");
  });

  it("routes a canonical Moosewave entity and rejects kind confusion", () => {
    expect(
      actionForSharedItem(item("moosewave://campaign/cam_1", "entity")),
    ).toEqual({
      type: "navigate",
      href: "/(tabs)/campaigns/cam_1",
    });
    expect(
      actionForSharedItem(item("https://example.com", "entity")),
    ).toBeNull();
    expect(
      actionForSharedItem(item("person@example.com", "entity")),
    ).toBeNull();
  });

  it("routes conversation shares and fails ticket or non-UUID identities closed", () => {
    expect(
      actionForSharedItem(
        item(`moosewave://helpdesk-conversation/${CONVERSATION_ID}`, "entity"),
      ),
    ).toEqual({
      type: "navigate",
      href: `/(tabs)/helpdesk/${CONVERSATION_ID}`,
    });
    expect(
      actionForSharedItem(
        item(`moosewave://helpdesk-ticket/${CONVERSATION_ID}`, "entity"),
      ),
    ).toBeNull();
    expect(
      actionForSharedItem(
        item("moosewave://helpdesk-conversation/ticket_123", "entity"),
      ),
    ).toBeNull();
  });

  it("rejects an expired item even when called outside the queue reader", () => {
    expect(
      actionForSharedItem(
        item(
          "person@example.com",
          "email",
          NOW - SHARED_INBOX_POLICY.maxAgeSeconds - 1,
        ),
      ),
    ).toBeNull();
  });
});

describe("shared inbox queue", () => {
  it("takes the newest live item and deterministically rewrites the remainder", () => {
    native.data.set(
      "pw_shared_items_v2",
      JSON.stringify([
        item("first@example.com"),
        item(
          "expired@example.com",
          "email",
          NOW - SHARED_INBOX_POLICY.maxAgeSeconds - 1,
        ),
        item("second@example.com"),
      ]),
    );
    native.data.set(
      "pw_shared_items",
      JSON.stringify([{ text: "legacy arbitrary text" }]),
    );

    expect(takeSharedInboxItem()).toEqual(item("second@example.com"));
    expect(
      parseSharedItems(native.data.get("pw_shared_items_v2") ?? null, NOW),
    ).toEqual([item("first@example.com")]);
    expect(native.data.has("pw_shared_items")).toBe(false);
  });

  it("does not process an item when committing the take fails", () => {
    native.data.set(
      "pw_shared_items_v2",
      JSON.stringify([item("person@example.com")]),
    );
    native.failRemoveKey = "pw_shared_items_v2";

    expect(takeSharedInboxItem()).toBeNull();
    expect(native.data.has("pw_shared_items_v2")).toBe(true);
  });

  it("restores a failed item without refreshing its age", () => {
    const original = item("moosewave://subscriber/sub_1", "entity", NOW - 100);

    expect(restoreSharedInboxItem(original)).toBe(true);
    expect(takeSharedInboxItem()).toEqual(original);
  });

  it("drops rather than restores an item after its TTL", () => {
    const original = item("person@example.com");
    vi.setSystemTime((NOW + SHARED_INBOX_POLICY.maxAgeSeconds + 1) * 1000);

    expect(restoreSharedInboxItem(original)).toBe(false);
    expect(native.data.has("pw_shared_items_v2")).toBe(false);
  });

  it("clears v1 and v2 queues on account teardown", () => {
    native.data.set("pw_shared_items_v2", JSON.stringify([item("a@b.com")]));
    native.data.set("pw_shared_items", "legacy");

    expect(clearSharedInbox()).toBe(true);

    expect(native.data.has("pw_shared_items_v2")).toBe(false);
    expect(native.data.has("pw_shared_items")).toBe(false);
  });

  it("surfaces cleanup failure through the strict account-cleanup API", async () => {
    native.data.set("pw_shared_items_v2", JSON.stringify([item("a@b.com")]));
    native.failRemoveKey = "pw_shared_items_v2";

    await expect(clearSharedInboxStrict()).rejects.toThrow(
      "Share inbox App Group cleanup is incomplete",
    );
  });
});
