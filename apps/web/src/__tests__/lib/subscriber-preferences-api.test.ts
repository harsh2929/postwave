// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  listSubscriberTopics,
  setSubscriberTopics,
} from "@/lib/preferences-api";

const TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOPIC_ID = "11111111-1111-4111-8111-11111111111a";
const TOPIC_ID_2 = "22222222-2222-4222-8222-222222222222";

function row(overrides: Record<string, unknown> = {}) {
  return {
    topic: {
      id: TOPIC_ID,
      tenantId: TENANT_ID,
      slug: "product-updates",
      name: "Product updates",
      description: "Major releases.",
      defaultOptIn: false,
      displayOrder: 1,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-30T00:00:00Z",
    },
    optedIn: false,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("subscriber preference topic contracts", () => {
  it("loads a fresh, bounded, strictly decoded subscriber topic inventory", async () => {
    mocks.get.mockResolvedValue([row()]);

    await expect(
      listSubscriberTopics(" Ada+tag@Example.COM "),
    ).resolves.toMatchObject([{ optedIn: false }]);
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/subscribers/ada%2Btag%40example.com/topics",
      {
        signal: undefined,
        requireOnline: true,
        maxAttempts: 1,
        cache: "no-store",
      },
    );
  });

  it("rejects malformed, duplicated, unsorted, and cross-tenant inventories", async () => {
    mocks.get.mockResolvedValue([{ ...row(), unexpected: true }]);
    await expect(listSubscriberTopics("ada@example.com")).rejects.toThrow();

    mocks.get.mockResolvedValue([row(), row()]);
    await expect(listSubscriberTopics("ada@example.com")).rejects.toThrow();

    mocks.get.mockResolvedValue([
      row({
        topic: {
          ...row().topic,
          id: TOPIC_ID_2,
          slug: "second",
          displayOrder: 2,
        },
      }),
      row(),
    ]);
    await expect(listSubscriberTopics("ada@example.com")).rejects.toThrow();

    mocks.get.mockResolvedValue([
      row(),
      row({
        topic: {
          ...row().topic,
          id: TOPIC_ID_2,
          tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          slug: "second",
          displayOrder: 2,
        },
      }),
    ]);
    await expect(listSubscriberTopics("ada@example.com")).rejects.toThrow();
  });

  it("sends one canonical, non-queueable update and requires an exact acknowledgement", async () => {
    mocks.put.mockResolvedValue({ ok: true });

    await expect(
      setSubscriberTopics("Ada@Example.com", [
        { topicId: TOPIC_ID, optedIn: true },
      ]),
    ).resolves.toEqual({ ok: true });
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/v1/subscribers/ada%40example.com/topics",
      { topics: [{ topicId: TOPIC_ID, optedIn: true }] },
      { signal: undefined, requireOnline: true, maxAttempts: 1 },
    );

    mocks.put.mockResolvedValue({ ok: true, guessed: true });
    await expect(
      setSubscriberTopics("ada@example.com", [
        { topicId: TOPIC_ID, optedIn: false },
      ]),
    ).rejects.toThrow(/not acknowledged/u);
  });

  it("rejects invalid email, non-canonical IDs, duplicate choices, and empty writes before transport", async () => {
    await expect(
      setSubscriberTopics("not-an-email", [
        { topicId: TOPIC_ID, optedIn: true },
      ]),
    ).rejects.toThrow(/valid email/u);
    await expect(
      setSubscriberTopics("ada@example.com", [
        { topicId: TOPIC_ID.toUpperCase(), optedIn: true },
      ]),
    ).rejects.toThrow(/invalid or duplicated/u);
    await expect(
      setSubscriberTopics("ada@example.com", [
        { topicId: TOPIC_ID, optedIn: true },
        { topicId: TOPIC_ID, optedIn: false },
      ]),
    ).rejects.toThrow(/invalid or duplicated/u);
    await expect(setSubscriberTopics("ada@example.com", [])).rejects.toThrow(
      /between one and 1,000/u,
    );
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
