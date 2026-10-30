// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_PENDING_PUBLIC_CONSENT_BYTES,
  MAX_PENDING_PUBLIC_CONSENT_DECISIONS,
  PUBLIC_CONSENT_DELIVERY_TIMEOUT_MS,
  PUBLIC_CONSENT_PENDING_STORAGE_KEY,
  PUBLIC_CONSENT_GPC_ENFORCED_EVENT,
  PUBLIC_CONSENT_SYNC_STATE_EVENT,
  cancelPendingPublicConsentTimer,
  createConsentDecisionId,
  discardUnrecoverablePublicConsentDecisions,
  enqueuePublicConsentDecision,
  flushPendingPublicConsentDecisions,
  readPendingPublicConsentDecisions,
} from "@/lib/public-consent-sync";

const config = {
  siteKey: "pwk_test_site",
  endpoint: "https://api.example.test",
};

const prefs = {
  essential: true as const,
  analytics: true,
  marketing: false,
};

function enqueue(
  input: Omit<Parameters<typeof enqueuePublicConsentDecision>[0], "config">,
): boolean {
  return enqueuePublicConsentDecision({ ...input, config });
}

function itemStorageKey(): string {
  const key = Array.from({ length: window.localStorage.length }, (_, index) =>
    window.localStorage.key(index),
  ).find((candidate) =>
    candidate?.startsWith(`${PUBLIC_CONSENT_PENDING_STORAGE_KEY}.item.`),
  );
  if (!key) throw new Error("pending decision was not retained");
  return key;
}

function totalPendingBytes(): number {
  let total = 0;
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(`${PUBLIC_CONSENT_PENDING_STORAGE_KEY}.item.`)) {
      total += new TextEncoder().encode(
        window.localStorage.getItem(key) ?? "",
      ).byteLength;
    }
  }
  return total;
}

function acceptedResponse(idempotencyKey: string, gpc = false): Response {
  return new Response(
    JSON.stringify({
      schema_version: 1,
      ok: true,
      idempotency_key: idempotencyKey,
      decision_id: "11111111-1111-8111-8111-111111111111",
      event_ids: {
        essential: "22222222-2222-4222-8222-222222222222",
        analytics: "33333333-3333-4333-8333-333333333333",
        marketing: "44444444-4444-4444-8444-444444444444",
      },
      written: 3,
      last_id: "44444444-4444-4444-8444-444444444444",
      gpc,
      source: gpc ? "gpc" : "cookie_banner",
      idempotent: true,
    }),
    {
      status: 202,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    },
  );
}

function acceptedResponseForRequest(gpc = false) {
  return (_input: unknown, init?: RequestInit): Response => {
    const idempotencyKey = new Headers(init?.headers).get("Idempotency-Key");
    if (!idempotencyKey) throw new Error("missing test Idempotency-Key");
    return acceptedResponse(idempotencyKey, gpc);
  };
}

function requestHeaders(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const init = fetchMock.mock.calls[index][1] as RequestInit;
  return init.headers as Record<string, string>;
}

afterEach(() => {
  cancelPendingPublicConsentTimer();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("durable public consent producer", () => {
  it("persists before send and clears only after an exact 202 identity", async () => {
    const fetchMock = vi.fn().mockImplementation(acceptedResponseForRequest());
    vi.stubGlobal("fetch", fetchMock);

    expect(
      enqueue({
        visitorId: "0123456789abcdef",
        choice: "custom",
        prefs,
        policyVersion: "v1",
      }),
    ).toBe(true);
    const pending = readPendingPublicConsentDecisions();
    expect(pending).toHaveLength(1);
    const originalKey = pending[0].idempotencyKey;

    await flushPendingPublicConsentDecisions(config);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.example.test/api/public/consent",
    );
    expect(requestHeaders(fetchMock, 0)["Idempotency-Key"]).toBe(originalKey);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      keepalive: true,
      credentials: "omit",
    });
    expect(readPendingPublicConsentDecisions()).toEqual([]);
    expect(
      window.localStorage.getItem(PUBLIC_CONSENT_PENDING_STORAGE_KEY),
    ).toBeNull();
  });

  it("retries a lost response with the identical key and body", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockImplementation(acceptedResponseForRequest());
    vi.stubGlobal("fetch", fetchMock);

    enqueue({
      visitorId: "0123456789abcdef",
      choice: "accept",
      prefs: { ...prefs, marketing: true },
      policyVersion: "v1",
    });
    await flushPendingPublicConsentDecisions(config);

    const retained = readPendingPublicConsentDecisions();
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ status: "pending", attempts: 1 });
    const firstKey = requestHeaders(fetchMock, 0)["Idempotency-Key"];
    const firstBody = (fetchMock.mock.calls[0][1] as RequestInit).body;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestHeaders(fetchMock, 1)["Idempotency-Key"]).toBe(firstKey);
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(firstBody);
    expect(readPendingPublicConsentDecisions()).toEqual([]);
  });

  it("resumes a retained decision after module reload with the same key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("response was lost"))
      .mockImplementation(acceptedResponseForRequest());
    vi.stubGlobal("fetch", fetchMock);

    enqueue({
      visitorId: "fedcba9876543210",
      choice: "reject",
      prefs: { ...prefs, analytics: false },
      policyVersion: "v1",
    });
    await flushPendingPublicConsentDecisions(config);
    const firstKey = requestHeaders(fetchMock, 0)["Idempotency-Key"];
    cancelPendingPublicConsentTimer();

    // A real reload naturally reaches the retry time. Make that explicit in
    // the fixture, then import a fresh module runtime over the same storage.
    const storageKey = itemStorageKey();
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) throw new Error("pending decision was not retained");
    const stored = JSON.parse(raw) as { retryAt: number };
    stored.retryAt = 0;
    window.localStorage.setItem(storageKey, JSON.stringify(stored));

    vi.resetModules();
    const reloaded = await import("@/lib/public-consent-sync");
    await reloaded.flushPendingPublicConsentDecisions(config);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestHeaders(fetchMock, 1)["Idempotency-Key"]).toBe(firstKey);
    expect(reloaded.readPendingPublicConsentDecisions()).toEqual([]);
    reloaded.cancelPendingPublicConsentTimer();
  });

  it("retains and surfaces a 409 without minting a replacement identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "idempotency_key_conflict",
            message: "request conflicts with current state",
          },
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const observed: Array<Record<string, unknown>> = [];
    const listener = (event: Event): void => {
      observed.push((event as CustomEvent<Record<string, unknown>>).detail);
    };
    window.addEventListener(PUBLIC_CONSENT_SYNC_STATE_EVENT, listener);

    enqueue({
      visitorId: "0123456789abcdef",
      choice: "custom",
      prefs,
      policyVersion: "v1",
    });
    const originalKey = readPendingPublicConsentDecisions()[0].idempotencyKey;
    await flushPendingPublicConsentDecisions(config);
    await flushPendingPublicConsentDecisions(config);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readPendingPublicConsentDecisions()).toEqual([
      expect.objectContaining({
        idempotencyKey: originalKey,
        status: "conflict",
        attempts: 1,
      }),
    ]);
    const conflict = observed.find((detail) => detail.state === "conflict");
    expect(conflict).toEqual({ state: "conflict" });
    expect(JSON.stringify(observed)).not.toContain(originalKey);
    window.removeEventListener(PUBLIC_CONSENT_SYNC_STATE_EVENT, listener);
  });

  it("does not clear on a malformed 202 and retries under the same identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    let call = 0;
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async (_input: unknown, init?: RequestInit): Promise<Response> => {
          const idempotencyKey = new Headers(init?.headers).get(
            "Idempotency-Key",
          );
          if (!idempotencyKey) throw new Error("missing test Idempotency-Key");
          call += 1;
          if (call === 1) {
            const malformedBody = (await acceptedResponse(
              idempotencyKey,
            ).json()) as Record<string, unknown>;
            malformedBody.idempotent = false;
            malformedBody.unreviewed_extra = true;
            return new Response(JSON.stringify(malformedBody), {
              status: 202,
              headers: { "Content-Type": "application/json" },
            });
          }
          return acceptedResponse(idempotencyKey);
        },
      );
    vi.stubGlobal("fetch", fetchMock);

    enqueue({
      visitorId: "0123456789abcdef",
      choice: "accept",
      prefs,
      policyVersion: "v1",
    });
    await flushPendingPublicConsentDecisions(config);
    const key = readPendingPublicConsentDecisions()[0].idempotencyKey;
    expect(readPendingPublicConsentDecisions()[0].attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(requestHeaders(fetchMock, 0)["Idempotency-Key"]).toBe(key);
    expect(requestHeaders(fetchMock, 1)["Idempotency-Key"]).toBe(key);
    expect(readPendingPublicConsentDecisions()).toEqual([]);
  });

  it("retains a decision when a valid 202 is bound to a different request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const wrongKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const fetchMock = vi.fn().mockResolvedValue(acceptedResponse(wrongKey));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      enqueue({
        visitorId: "0123456789abcdef",
        choice: "custom",
        prefs,
        policyVersion: "v1",
      }),
    ).toBe(true);
    const actualKey = readPendingPublicConsentDecisions()[0].idempotencyKey;
    expect(actualKey).not.toBe(wrongKey);

    await flushPendingPublicConsentDecisions(config);

    expect(readPendingPublicConsentDecisions()).toEqual([
      expect.objectContaining({
        idempotencyKey: actualKey,
        attempts: 1,
        status: "pending",
      }),
    ]);
  });

  it("cancels an unadvertised oversized response before buffering it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const cancelled = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(17 * 1024));
      },
      cancel: cancelled,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(oversized, {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    expect(
      enqueue({
        visitorId: "0123456789abcdef",
        choice: "reject",
        prefs: { ...prefs, analytics: false },
        policyVersion: "v1",
      }),
    ).toBe(true);
    await flushPendingPublicConsentDecisions(config);

    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(readPendingPublicConsentDecisions()).toEqual([
      expect.objectContaining({ attempts: 1, status: "pending" }),
    ]);
  });

  it("times out a fetch that never resolves and schedules the same key for retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const fetchMock = vi.fn().mockImplementation(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(
      enqueue({
        visitorId: "0123456789abcdef",
        choice: "reject",
        prefs: { ...prefs, analytics: false },
        policyVersion: "v1",
      }),
    ).toBe(true);
    const key = readPendingPublicConsentDecisions()[0].idempotencyKey;

    const flushing = flushPendingPublicConsentDecisions(config);
    await vi.advanceTimersByTimeAsync(PUBLIC_CONSENT_DELIVERY_TIMEOUT_MS);
    await flushing;

    expect(requestHeaders(fetchMock, 0)["Idempotency-Key"]).toBe(key);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(
      true,
    );
    expect(readPendingPublicConsentDecisions()).toEqual([
      expect.objectContaining({ idempotencyKey: key, attempts: 1 }),
    ]);
  });

  it("times out and cancels a bounded response body that never closes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const cancelled = vi.fn();
    const hangingBody = new ReadableStream<Uint8Array>({ cancel: cancelled });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(hangingBody, {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    expect(
      enqueue({
        visitorId: "0123456789abcdef",
        choice: "reject",
        prefs: { ...prefs, analytics: false },
        policyVersion: "v1",
      }),
    ).toBe(true);

    const flushing = flushPendingPublicConsentDecisions(config);
    await vi.advanceTimersByTimeAsync(PUBLIC_CONSENT_DELIVERY_TIMEOUT_MS);
    await flushing;

    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(readPendingPublicConsentDecisions()).toEqual([
      expect.objectContaining({ attempts: 1, status: "pending" }),
    ]);
  });

  it("bounds the durable queue and rejects send when persistence fails", () => {
    const states: string[] = [];
    const listener = (event: Event): void => {
      states.push((event as CustomEvent<{ state: string }>).detail.state);
    };
    window.addEventListener(PUBLIC_CONSENT_SYNC_STATE_EVENT, listener);

    for (
      let index = 0;
      index < MAX_PENDING_PUBLIC_CONSENT_DECISIONS;
      index += 1
    ) {
      expect(
        enqueue({
          visitorId: `visitor_${String(index).padStart(16, "0")}`,
          choice: "custom",
          prefs,
          policyVersion: "v1",
        }),
      ).toBe(true);
    }
    expect(
      enqueue({
        visitorId: "visitor_queue_is_full",
        choice: "custom",
        prefs,
        policyVersion: "v1",
      }),
    ).toBe(false);
    expect(readPendingPublicConsentDecisions()).toHaveLength(
      MAX_PENDING_PUBLIC_CONSENT_DECISIONS,
    );
    expect(totalPendingBytes()).toBeLessThanOrEqual(
      MAX_PENDING_PUBLIC_CONSENT_BYTES,
    );
    expect(states).toContain("queue_full");

    window.localStorage.clear();
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });
    expect(
      enqueue({
        visitorId: "0123456789abcdef",
        choice: "reject",
        prefs,
        policyVersion: "v1",
      }),
    ).toBe(false);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(states).toContain("storage_unavailable");
    setItem.mockRestore();
    window.removeEventListener(PUBLIC_CONSENT_SYNC_STATE_EVENT, listener);
  });

  it("fails closed when Web Crypto cannot create evidence identities", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY", config.siteKey);
    vi.stubEnv("NEXT_PUBLIC_POSTWAVE_API_BASE_URL", config.endpoint);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("crypto unavailable");
    });
    vi.spyOn(window.crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("crypto unavailable");
    });

    expect(createConsentDecisionId()).toBe("");
    expect(
      enqueue({
        visitorId: "0123456789abcdef",
        choice: "accept",
        prefs,
        policyVersion: "v1",
      }),
    ).toBe(false);

    vi.resetModules();
    const banner = await import("@/components/marketing/cookie-banner");
    banner.postConsentToServer("accept", prefs);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem(PUBLIC_CONSENT_PENDING_STORAGE_KEY),
    ).toBeNull();
  });

  it("quarantines corrupt per-item evidence until explicit recovery", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const corruptKey = `${PUBLIC_CONSENT_PENDING_STORAGE_KEY}.item.11111111-1111-4111-8111-111111111111`;
    window.localStorage.setItem(
      corruptKey,
      "x".repeat(MAX_PENDING_PUBLIC_CONSENT_BYTES + 1),
    );

    expect(readPendingPublicConsentDecisions()).toEqual([]);
    await flushPendingPublicConsentDecisions(config);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(corruptKey)).not.toBeNull();
    expect(discardUnrecoverablePublicConsentDecisions()).toBe(1);
    expect(window.localStorage.getItem(corruptKey)).toBeNull();
  });

  it("binds a pending decision to its exact site and endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      enqueue({
        visitorId: "0123456789abcdef",
        choice: "custom",
        prefs,
        policyVersion: "v1",
      }),
    ).toBe(true);

    await flushPendingPublicConsentDecisions({
      siteKey: "pwk_rotated_site",
      endpoint: "https://rotated-api.example.test",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingPublicConsentDecisions()).toEqual([
      expect.objectContaining({
        siteKey: config.siteKey,
        endpoint: config.endpoint,
        status: "configuration_mismatch",
      }),
    ]);

    fetchMock.mockImplementation(acceptedResponseForRequest());
    expect(
      enqueuePublicConsentDecision({
        visitorId: "fedcba9876543210",
        choice: "reject",
        prefs: { ...prefs, analytics: false },
        policyVersion: "v1",
        config: {
          siteKey: "pwk_rotated_site",
          endpoint: "https://rotated-api.example.test",
        },
      }),
    ).toBe(true);
    await flushPendingPublicConsentDecisions({
      siteKey: "pwk_rotated_site",
      endpoint: "https://rotated-api.example.test",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readPendingPublicConsentDecisions()).toEqual([
      expect.objectContaining({ status: "configuration_mismatch" }),
    ]);
  });

  it("rejects cleartext non-loopback endpoints before persisting", () => {
    expect(
      enqueuePublicConsentDecision({
        visitorId: "0123456789abcdef",
        choice: "reject",
        prefs: { ...prefs, analytics: false },
        policyVersion: "v1",
        config: {
          siteKey: config.siteKey,
          endpoint: "http://api.example.test",
        },
      }),
    ).toBe(false);
    expect(readPendingPublicConsentDecisions()).toEqual([]);
  });

  it("keeps legacy unbound evidence quarantined without deadlocking v2", async () => {
    window.localStorage.setItem(
      "postwave.public-consent.pending.v1",
      JSON.stringify({ schema_version: 1, items: [] }),
    );
    const fetchMock = vi.fn().mockImplementation(acceptedResponseForRequest());
    vi.stubGlobal("fetch", fetchMock);

    expect(
      enqueue({
        visitorId: "0123456789abcdef",
        choice: "custom",
        prefs,
        policyVersion: "v1",
      }),
    ).toBe(true);
    await flushPendingPublicConsentDecisions(config);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      window.localStorage.getItem("postwave.public-consent.pending.v1"),
    ).not.toBeNull();
    expect(discardUnrecoverablePublicConsentDecisions()).toBe(1);
  });

  it("surfaces a server GPC override before clearing the durable item", async () => {
    const events: string[] = [];
    const listener = (): void => {
      events.push("gpc");
    };
    window.addEventListener(PUBLIC_CONSENT_GPC_ENFORCED_EVENT, listener);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(acceptedResponseForRequest(true)),
    );
    expect(
      enqueue({
        visitorId: "0123456789abcdef",
        choice: "accept",
        prefs: { ...prefs, marketing: true },
        policyVersion: "v1",
      }),
    ).toBe(true);

    await flushPendingPublicConsentDecisions(config);

    expect(events).toEqual(["gpc"]);
    expect(readPendingPublicConsentDecisions()).toEqual([]);
    window.removeEventListener(PUBLIC_CONSENT_GPC_ENFORCED_EVENT, listener);
  });

  it("surfaces a verified server GPC override even when queue deletion fails", async () => {
    const events: string[] = [];
    const listener = (): void => {
      events.push("gpc");
    };
    window.addEventListener(PUBLIC_CONSENT_GPC_ENFORCED_EVENT, listener);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(acceptedResponseForRequest(true)),
    );
    expect(
      enqueue({
        visitorId: "0123456789abcdef",
        choice: "accept",
        prefs: { ...prefs, marketing: true },
        policyVersion: "v1",
      }),
    ).toBe(true);
    vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
      throw new DOMException("storage unavailable", "SecurityError");
    });

    await flushPendingPublicConsentDecisions(config);

    expect(events).toEqual(["gpc"]);
    expect(readPendingPublicConsentDecisions()).toEqual([
      expect.objectContaining({ status: "pending" }),
    ]);
    window.removeEventListener(PUBLIC_CONSENT_GPC_ENFORCED_EVENT, listener);
  });

  it("replaces a malformed stored visitor identity and verifies the durable write", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY", config.siteKey);
    vi.stubEnv("NEXT_PUBLIC_POSTWAVE_API_BASE_URL", config.endpoint);
    window.localStorage.setItem("moosewave.visitor_id.v1", "corrupt visitor id");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":{"code":"invalid_input"}}', {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();

    const banner = await import("@/components/marketing/cookie-banner");
    expect(banner.postConsentToServer("reject", prefs)).toBe(true);
    const visitorId = window.localStorage.getItem("moosewave.visitor_id.v1");
    expect(visitorId).toMatch(/^[0-9a-f]{32}$/u);
    expect(visitorId).not.toBe("corrupt visitor id");
    expect(readPendingPublicConsentDecisions()[0].visitorId).toBe(visitorId);

    await vi.waitFor(() => {
      expect(readPendingPublicConsentDecisions()).toEqual([
        expect.objectContaining({ visitorId, status: "failed" }),
      ]);
    });
  });

  it("wires the banner producer to a distinct persisted UUID per decision", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY", config.siteKey);
    vi.stubEnv("NEXT_PUBLIC_POSTWAVE_API_BASE_URL", config.endpoint);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":{"code":"invalid_input"}}', {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();

    const banner = await import("@/components/marketing/cookie-banner");
    banner.postConsentToServer("accept", {
      essential: true,
      analytics: true,
      marketing: true,
    });
    banner.postConsentToServer("custom", prefs);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(readPendingPublicConsentDecisions()).toEqual([
        expect.objectContaining({ status: "failed" }),
        expect.objectContaining({ status: "failed" }),
      ]);
    });

    const first = requestHeaders(fetchMock, 0)["Idempotency-Key"];
    const second = requestHeaders(fetchMock, 1)["Idempotency-Key"];
    const uuidV4 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(first).toMatch(uuidV4);
    expect(second).toMatch(uuidV4);
    expect(second).not.toBe(first);
  });
});
