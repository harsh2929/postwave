// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The local recovery authority behind the webhook simulator's fire fence.
// Port of desktop's __tests__/lib/webhook-playground-fire-recovery.test.ts,
// against sessionStorage instead of the desktop's encrypted vault.
//
// The property under test: a new fire identity can be minted only when this
// tab PROVABLY holds no unresolved one. Every unreadable, foreign, or
// mismatched state must hold the fence rather than guess.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWebhookPlaygroundFireRecoveryAuthority,
  webhookPlaygroundFireRecovery,
  webhookPlaygroundFireRecoveryHoldDetail,
  webhookPlaygroundFireRecoveryKey,
  type WebhookPlaygroundFireRecoveryAuthority,
  type WebhookPlaygroundFireSnapshot,
} from "@/lib/webhook-playground-fire-recovery";

const TENANT = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const FIRE = "0190f5c2-7b1a-7c3d-8e4f-5a6b7c8d9e0f";
const WEBHOOK = "7f3c2e10-1b2a-4c3d-8e4f-5a6b7c8d9e0f";

function authority(
  tenantId = TENANT,
  userId = USER,
): WebhookPlaygroundFireRecoveryAuthority {
  const value = createWebhookPlaygroundFireRecoveryAuthority({
    tenant_id: tenantId,
    user_id: userId,
  });
  if (!value) throw new Error("authority was not created");
  return value;
}

function snapshot(
  overrides: Partial<WebhookPlaygroundFireSnapshot> = {},
): WebhookPlaygroundFireSnapshot {
  return {
    fireId: FIRE,
    idempotencyKey: `webhook-playground:${FIRE}`,
    webhookId: WEBHOOK,
    expectedWebhookConfigVersion: 7,
    eventType: "campaign.sent",
    payloadJSON: '{"campaign_id":"campaign-42","nested":{"live":true}}',
    ...overrides,
  };
}

/**
 * A Map-backed Storage whose every method is a spy, installed as
 * `window.sessionStorage`. happy-dom's own Storage does not route through
 * `Storage.prototype`, so prototype spies would silently observe nothing.
 */
class FakeStorage implements Storage {
  readonly values = new Map<string, string>();
  readonly getItem = vi.fn((key: string) => this.values.get(key) ?? null);
  readonly setItem = vi.fn((key: string, value: string) => {
    this.values.set(key, String(value));
  });
  readonly removeItem = vi.fn((key: string) => {
    this.values.delete(key);
  });
  readonly clear = vi.fn(() => this.values.clear());
  readonly key = vi.fn((index: number) => [...this.values.keys()][index] ?? null);
  get length(): number {
    return this.values.size;
  }
}

let store: FakeStorage;
const realSessionStorage = Object.getOwnPropertyDescriptor(
  window,
  "sessionStorage",
);

beforeEach(() => {
  store = new FakeStorage();
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    get: () => store,
  });
  window.localStorage.clear();
});

afterEach(() => {
  if (realSessionStorage) {
    Object.defineProperty(window, "sessionStorage", realSessionStorage);
  } else {
    delete (window as { sessionStorage?: Storage }).sessionStorage;
  }
  vi.restoreAllMocks();
});

describe("webhook playground fire recovery (web)", () => {
  it("round-trips one exact checkpoint, byte-for-byte, in session storage only", () => {
    const recovery = authority();
    const exactPayloadJSON = `{
  "large_integer": 9007199254740993,
  "campaign_id": "campaign-42"
}`;
    const input = snapshot({ payloadJSON: exactPayloadJSON });

    expect(webhookPlaygroundFireRecovery.prepare(recovery, input)).toEqual({
      status: "ready",
      snapshot: input,
    });
    const key = webhookPlaygroundFireRecoveryKey(recovery);
    expect(key).toBe(
      `postwave:webhook-playground-fire-recovery:v1:${TENANT}:${USER}`,
    );
    expect(JSON.parse(window.sessionStorage.getItem(key) ?? "null")).toEqual({
      version: 1,
      scope: `${TENANT}:${USER}`,
      snapshot: input,
    });
    // Durable cross-session storage never receives the payload text.
    expect(window.localStorage.length).toBe(0);

    const loaded = webhookPlaygroundFireRecovery.load(recovery);
    expect(loaded).toEqual({ status: "ready", snapshot: input });
    if (loaded.status !== "ready") throw new Error("checkpoint not loaded");
    // Re-serialising would have rounded this integer and changed the bytes the
    // server hashed under the Idempotency-Key.
    expect(loaded.snapshot.payloadJSON).toBe(exactPayloadJSON);
    expect(loaded.snapshot.payloadJSON).toContain("9007199254740993");
  });

  it("refuses an unverified identity and a forged authority", () => {
    expect(createWebhookPlaygroundFireRecoveryAuthority(null)).toBeNull();
    expect(
      createWebhookPlaygroundFireRecoveryAuthority({ tenant_id: TENANT }),
    ).toBeNull();
    expect(
      createWebhookPlaygroundFireRecoveryAuthority({
        tenant_id: "tenant:with:colons",
        user_id: USER,
      }),
    ).toBeNull();
    const forged = { ...authority(), scope: `${TENANT}:someone-else` };

    expect(webhookPlaygroundFireRecovery.load(null)).toEqual({
      status: "held",
      reason: "identity-unresolved",
    });
    expect(webhookPlaygroundFireRecovery.prepare(forged, snapshot())).toEqual({
      status: "held",
      reason: "identity-unresolved",
    });
    expect(webhookPlaygroundFireRecovery.settle(forged, snapshot())).toEqual({
      status: "held",
      reason: "identity-unresolved",
    });
    expect(window.sessionStorage.length).toBe(0);
  });

  it("isolates identities and holds an envelope placed under the wrong scope without deleting it", () => {
    const first = authority();
    const second = authority(TENANT, "33333333-3333-4333-8333-333333333333");
    webhookPlaygroundFireRecovery.prepare(first, snapshot());

    // Another signed-in user in the same tab never adopts the checkpoint.
    expect(webhookPlaygroundFireRecovery.load(second)).toEqual({
      status: "clear",
    });

    // An envelope that claims a different scope than its key is corrupt.
    const planted = JSON.stringify({
      version: 1,
      scope: first.scope,
      snapshot: snapshot(),
    });
    window.sessionStorage.setItem(
      webhookPlaygroundFireRecoveryKey(second),
      planted,
    );
    expect(webhookPlaygroundFireRecovery.load(second)).toEqual({
      status: "held",
      reason: "checkpoint-corrupt",
    });
    expect(
      window.sessionStorage.getItem(webhookPlaygroundFireRecoveryKey(second)),
    ).toBe(planted);
  });

  it("holds both an existing exact checkpoint and a differing one without overwrite", () => {
    const recovery = authority();
    const first = snapshot();
    webhookPlaygroundFireRecovery.prepare(recovery, first);
    expect(store.setItem).toHaveBeenCalledTimes(1);
    const setItem = store.setItem;
    setItem.mockClear();

    expect(webhookPlaygroundFireRecovery.prepare(recovery, first)).toEqual({
      status: "held",
      reason: "checkpoint-exists",
    });
    expect(
      webhookPlaygroundFireRecovery.prepare(
        recovery,
        snapshot({ eventType: "subscriber.added" }),
      ),
    ).toEqual({ status: "held", reason: "checkpoint-conflict" });
    expect(setItem).not.toHaveBeenCalled();
    expect(webhookPlaygroundFireRecovery.load(recovery)).toEqual({
      status: "ready",
      snapshot: first,
    });
  });

  it("fails closed when session storage cannot be read or written", () => {
    const recovery = authority();
    store.getItem.mockImplementation(() => {
      throw new Error("storage denied");
    });
    expect(webhookPlaygroundFireRecovery.load(recovery)).toEqual({
      status: "held",
      reason: "storage-unavailable",
    });
    expect(webhookPlaygroundFireRecovery.prepare(recovery, snapshot())).toEqual(
      { status: "held", reason: "storage-unavailable" },
    );
    expect(webhookPlaygroundFireRecovery.settle(recovery, snapshot())).toEqual({
      status: "held",
      reason: "storage-unavailable",
    });
    expect(store.setItem).not.toHaveBeenCalled();
    expect(store.removeItem).not.toHaveBeenCalled();
    store.getItem.mockImplementation((key: string) => store.values.get(key) ?? null);

    store.setItem.mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(webhookPlaygroundFireRecovery.prepare(recovery, snapshot())).toEqual(
      { status: "held", reason: "storage-unavailable" },
    );

    // A write that silently does nothing is not a checkpoint.
    store.setItem.mockImplementation(() => undefined);
    expect(webhookPlaygroundFireRecovery.prepare(recovery, snapshot())).toEqual(
      { status: "held", reason: "storage-unavailable" },
    );
  });

  it("fails closed when the session storage accessor itself throws", () => {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    const recovery = authority();
    expect(webhookPlaygroundFireRecovery.load(recovery)).toEqual({
      status: "held",
      reason: "storage-unavailable",
    });
    expect(webhookPlaygroundFireRecovery.prepare(recovery, snapshot())).toEqual(
      { status: "held", reason: "storage-unavailable" },
    );
  });

  it("preserves an unreadable checkpoint as evidence and refuses to replace or remove it", () => {
    const recovery = authority();
    const key = webhookPlaygroundFireRecoveryKey(recovery);
    window.sessionStorage.setItem(key, "{not json");

    expect(webhookPlaygroundFireRecovery.load(recovery)).toEqual({
      status: "held",
      reason: "checkpoint-corrupt",
    });
    expect(webhookPlaygroundFireRecovery.prepare(recovery, snapshot())).toEqual(
      { status: "held", reason: "checkpoint-corrupt" },
    );
    expect(webhookPlaygroundFireRecovery.settle(recovery, snapshot())).toEqual({
      status: "held",
      reason: "checkpoint-corrupt",
    });
    expect(window.sessionStorage.getItem(key)).toBe("{not json");
  });

  it("holds a stored envelope whose snapshot is malformed", () => {
    const recovery = authority();
    const key = webhookPlaygroundFireRecoveryKey(recovery);
    for (const stored of [
      { version: 2, scope: recovery.scope, snapshot: snapshot() },
      { version: 1, scope: recovery.scope, snapshot: snapshot(), extra: true },
      {
        version: 1,
        scope: recovery.scope,
        snapshot: { ...snapshot(), fireId: FIRE.toUpperCase() },
      },
    ]) {
      window.sessionStorage.setItem(key, JSON.stringify(stored));
      expect(webhookPlaygroundFireRecovery.load(recovery)).toEqual({
        status: "held",
        reason: "checkpoint-corrupt",
      });
    }
  });

  it.each([
    ["non-canonical fire UUID", snapshot({ fireId: FIRE.toUpperCase() })],
    ["non-UUID webhook id", snapshot({ webhookId: "webhook-1" })],
    ["blank idempotency key", snapshot({ idempotencyKey: "" })],
    ["trimmed idempotency key", snapshot({ idempotencyKey: " key" })],
    ["control-bearing idempotency key", snapshot({ idempotencyKey: "k\u0000v" })],
    ["oversized idempotency key", snapshot({ idempotencyKey: "k".repeat(256) })],
    ["zero webhook revision", snapshot({ expectedWebhookConfigVersion: 0 })],
    ["fractional webhook revision", snapshot({ expectedWebhookConfigVersion: 1.5 })],
    [
      "unsafe webhook revision",
      snapshot({ expectedWebhookConfigVersion: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    ["invalid event token", snapshot({ eventType: "subscriber/created" })],
    ["trimmed event token", snapshot({ eventType: " subscriber.created" })],
    ["oversized event token", snapshot({ eventType: "a".repeat(201) })],
    ["empty payload JSON", snapshot({ payloadJSON: "   " })],
    ["malformed payload JSON", snapshot({ payloadJSON: '{"broken":' })],
    ["array payload JSON", snapshot({ payloadJSON: "[]" })],
    ["primitive payload JSON", snapshot({ payloadJSON: "42" })],
    ["ill-formed payload text", snapshot({ payloadJSON: `{"v":"${"\ud800"}"}` })],
    ["oversized payload text", snapshot({ payloadJSON: `${" ".repeat(262_143)}{}` })],
    [
      "unknown snapshot field",
      { ...snapshot(), retryAutomatically: true } as WebhookPlaygroundFireSnapshot,
    ],
  ])("rejects a %s before touching storage", (_label, invalid) => {
    expect(webhookPlaygroundFireRecovery.prepare(authority(), invalid)).toEqual({
      status: "held",
      reason: "snapshot-invalid",
    });
    expect(store.getItem).not.toHaveBeenCalled();
    expect(store.setItem).not.toHaveBeenCalled();
    expect(store.values.size).toBe(0);
  });

  it("accepts the exact payload byte ceiling and a future canonical event token", () => {
    const recovery = authority();
    const atCeiling = snapshot({
      eventType: "future.catalog-event_v2",
      payloadJSON: `${" ".repeat(262_142)}{}`,
    });
    expect(webhookPlaygroundFireRecovery.prepare(recovery, atCeiling)).toEqual({
      status: "ready",
      snapshot: atCeiling,
    });
    expect(webhookPlaygroundFireRecovery.load(recovery)).toEqual({
      status: "ready",
      snapshot: atCeiling,
    });
  });

  it("removes only a checkpoint matching the complete exact snapshot", () => {
    const recovery = authority();
    const exact = snapshot();
    webhookPlaygroundFireRecovery.prepare(recovery, exact);

    expect(
      webhookPlaygroundFireRecovery.settle(
        recovery,
        snapshot({ payloadJSON: '{"campaign_id":"changed"}' }),
      ),
    ).toEqual({ status: "held", reason: "checkpoint-mismatch" });
    expect(webhookPlaygroundFireRecovery.load(recovery)).toEqual({
      status: "ready",
      snapshot: exact,
    });

    expect(webhookPlaygroundFireRecovery.settle(recovery, exact)).toEqual({
      status: "cleared",
    });
    expect(
      window.sessionStorage.getItem(webhookPlaygroundFireRecoveryKey(recovery)),
    ).toBeNull();
    expect(webhookPlaygroundFireRecovery.load(recovery)).toEqual({
      status: "clear",
    });
    expect(webhookPlaygroundFireRecovery.settle(recovery, exact)).toEqual({
      status: "clear",
    });
  });

  it("keeps a matching checkpoint held when removal throws or falsely succeeds", () => {
    const recovery = authority();
    const exact = snapshot();
    webhookPlaygroundFireRecovery.prepare(recovery, exact);

    store.removeItem.mockImplementation(() => {
      throw new Error("storage denied");
    });
    expect(webhookPlaygroundFireRecovery.settle(recovery, exact)).toEqual({
      status: "held",
      reason: "storage-unavailable",
    });
    store.removeItem.mockImplementation(() => undefined);
    expect(webhookPlaygroundFireRecovery.settle(recovery, exact)).toEqual({
      status: "held",
      reason: "storage-unavailable",
    });
    expect(store.removeItem).toHaveBeenCalledTimes(2);
    expect(webhookPlaygroundFireRecovery.load(recovery)).toEqual({
      status: "ready",
      snapshot: exact,
    });
  });

  it("names every hold with an operator sentence", () => {
    for (const reason of [
      "identity-unresolved",
      "snapshot-invalid",
      "storage-unavailable",
      "checkpoint-corrupt",
      "checkpoint-exists",
      "checkpoint-conflict",
      "checkpoint-mismatch",
    ] as const) {
      expect(webhookPlaygroundFireRecoveryHoldDetail(reason).length).toBeGreaterThan(
        30,
      );
    }
  });
});
