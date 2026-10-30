import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deliverabilityHubApi } from "../../lib/api-client";

const localStorageStub: Storage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

beforeEach(() => {
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
  // @ts-expect-error minimal renderer window for the transport contract
  globalThis.window = {
    localStorage: localStorageStub,
    crypto: webcrypto as unknown as Crypto,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
});

afterEach(() => {
  // @ts-expect-error test renderer cleanup
  delete globalThis.window;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deliverability repair-override transport", () => {
  it("does not replay a committed-but-fenced 503 and preserves its proof", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      expect(init.body).toBe("{}");
      expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
      return new Response(
        JSON.stringify({
          error: {
            code: "sending_cap_convergence_pending",
            message:
              "the override was cleared while cap coordination remains conservatively fenced",
          },
          ok: true,
          cleared: true,
          cap_coordination_outcome: "committed-conservatively-fenced",
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "1",
            "X-Postwave-Sending-Cap-Outcome": "committed-conservatively-fenced",
          },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverabilityHubApi.repairOverride();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error).toMatchObject({
      status: 503,
      details: {
        ok: true,
        cleared: true,
        cap_coordination_outcome: "committed-conservatively-fenced",
      },
    });
    expect(result.responseMetadata).toEqual({
      status: 503,
      sendingCapOutcome: "committed-conservatively-fenced",
    });
  });

  it("refuses offline execution instead of journaling the cap mutation", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverabilityHubApi.repairOverride();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.error).toMatchObject({ kind: "network", code: "offline" });
  });
});
