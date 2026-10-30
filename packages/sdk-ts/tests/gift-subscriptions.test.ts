import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";
import type {
  GiftSubscription,
  GiftSubscriptionListPage,
  GiftSubscriptionListParams,
  GiftSubscriptionStats,
} from "../src/index.js";

const SAFE_GIFT_FIELDS = [
  "id",
  "label",
  "plan_label",
  "duration_months",
  "status",
  "created_at",
  "redeemed_at",
  "expires_at",
  "canceled_at",
  "message_recorded",
  "provider_invoice_linked",
  "gifter_member_linked",
  "recipient_member_linked",
] as const;

const SAFE_RECORD = {
  id: "00000000-0000-4000-8000-000000000001",
  label: "Gift record 00000000",
  plan_label: "Pro Annual",
  duration_months: 12,
  status: "redeemed",
  created_at: "2026-07-01T00:00:00Z",
  redeemed_at: "2026-07-02T00:00:00Z",
  expires_at: null,
  canceled_at: null,
  message_recorded: true,
  provider_invoice_linked: true,
  gifter_member_linked: false,
  recipient_member_linked: true,
} satisfies GiftSubscription;

const SAFE_PAGE = {
  items: [SAFE_RECORD],
  total: 1,
  limit: 100,
  offset: 10000,
  snapshot_at: "2026-07-27T12:00:00Z",
} satisfies GiftSubscriptionListPage;

const SAFE_STATS = {
  total: 8,
  pending: 1,
  paid: 1,
  granted: 3,
  canceled: 1,
  expired: 1,
  refunded: 1,
  conversionRate: 0.5,
  generated_at: "2026-07-27T12:00:00Z",
} satisfies GiftSubscriptionStats;

type ExpectedGiftKey = (typeof SAFE_GIFT_FIELDS)[number];
type UnexpectedGiftKey = Exclude<keyof GiftSubscription, ExpectedGiftKey>;
type MissingGiftKey = Exclude<ExpectedGiftKey, keyof GiftSubscription>;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("GiftSubscriptionsResource sanitized archive contract", () => {
  it("uses exactly the bounded list, aggregate, and encoded detail GETs", async () => {
    const seen: Array<{ method: string; url: string }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      seen.push({ method, url });
      if (url.endsWith("/stats")) return json(SAFE_STATS);
      if (new URL(url).pathname === "/api/v1/gift-subscriptions") {
        return json(SAFE_PAGE);
      }
      return json(SAFE_RECORD);
    });
    const client = new PostwaveClient({
      apiKey: "test",
      tenantId: "tenant",
      fetch,
      retries: 0,
    });

    const page = await client.giftSubscriptions.list({
      limit: 100,
      offset: 10000,
      q: "Gift record A1B2-C3D4",
      filter: "closed",
      sort: "status",
    });
    const stats = await client.giftSubscriptions.stats();
    const record = await client.giftSubscriptions.get(
      "A1B2C3D4-E5F6-7890-ABCD-EF0123456789",
    );

    expect(seen.map(({ method }) => method)).toEqual(["GET", "GET", "GET"]);
    const listUrl = new URL(seen[0]!.url);
    expect(listUrl.pathname).toBe("/api/v1/gift-subscriptions");
    expect(Object.fromEntries(listUrl.searchParams)).toEqual({
      limit: "100",
      offset: "10000",
      q: "a1b2c3d4",
      filter: "closed",
      sort: "status",
    });
    expect(seen[1]!.url).toBe(
      "https://api.moosewave.com/api/v1/gift-subscriptions/stats",
    );
    expect(seen[2]!.url).toBe(
      "https://api.moosewave.com/api/v1/gift-subscriptions/a1b2c3d4-e5f6-7890-abcd-ef0123456789",
    );
    expect(page).toEqual(SAFE_PAGE);
    expect(stats).toEqual(SAFE_STATS);
    expect(record).toEqual(SAFE_RECORD);
  });

  it("omits no-op defaults and ignores untyped extra query fields", async () => {
    const seen: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      seen.push(url);
      return json(SAFE_PAGE);
    });
    const client = new PostwaveClient({
      apiKey: "test",
      fetch,
      retries: 0,
    });

    await client.giftSubscriptions.list({
      q: "   ",
      filter: "all",
      sort: "newest",
      recipient_email: "must-not-forward@example.com",
    } as Parameters<typeof client.giftSubscriptions.list>[0] & {
      recipient_email: string;
    });

    expect(seen).toEqual([
      "https://api.moosewave.com/api/v1/gift-subscriptions",
    ]);
  });

  it("rejects identity-shaped search and invalid pagination before transport", () => {
    const fetch = vi.fn();
    const client = new PostwaveClient({ apiKey: "test", fetch, retries: 0 });
    const invalidParams: unknown[] = [
      { q: "person@example.com" },
      { q: "1234567" },
      { q: "f".repeat(33) },
      { q: 12345678 },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { offset: -1 },
      { offset: 10001 },
      { offset: Number.NaN },
    ];

    for (const params of invalidParams) {
      expect(() =>
        client.giftSubscriptions.list(params as GiftSubscriptionListParams),
      ).toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed detail identifiers before transport", () => {
    const fetch = vi.fn();
    const client = new PostwaveClient({ apiKey: "test", fetch, retries: 0 });
    const invalidIds: unknown[] = [
      "",
      "gift/part one",
      "a1b2c3d4e5f67890abcdef0123456789",
      "a1b2c3d4-e5f6-7890-abcd-ef012345678",
      " a1b2c3d4-e5f6-7890-abcd-ef0123456789",
      "person@example.com",
      null,
    ];

    for (const id of invalidIds) {
      expect(() => client.giftSubscriptions.get(id as string)).toThrow(
        /Gift history id/,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the public surface read-only and the record type exact", () => {
    const client = new PostwaveClient({ apiKey: "test", fetch: vi.fn() });
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(client.giftSubscriptions) as object,
    )
      .filter((name) => name !== "constructor")
      .sort();
    const noUnexpectedKeys: [UnexpectedGiftKey] extends [never] ? true : false =
      true;
    const noMissingKeys: [MissingGiftKey] extends [never] ? true : false = true;

    expect(methods).toEqual(["get", "list", "stats"]);
    expect(noUnexpectedKeys).toBe(true);
    expect(noMissingKeys).toBe(true);
    expect(Object.keys(SAFE_RECORD).sort()).toEqual(
      [...SAFE_GIFT_FIELDS].sort(),
    );
  });
});
