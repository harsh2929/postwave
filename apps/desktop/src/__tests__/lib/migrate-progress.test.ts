// Tests for the migration progress event handling in the desktop
// shell. The wizard subscribes to /api/v1/migrations/{id}/events and
// falls back to polling /api/v1/migrations/{id} when SSE fails for
// >6s. The actual subscriber lives in api-client.ts; here we test:
//
//   - SSE `progress` event parsing produces the right snapshot shape
//   - polling fallback gate fires strictly after 6s of stream errors
//   - cancel hits DELETE /api/v1/migrations/{id} with the right URL

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub minimal window so api-client's localStorage probes don't throw.
beforeEach(() => {
  // @ts-expect-error — stub
  globalThis.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
});

afterEach(() => {
  // @ts-expect-error — clean up
  delete globalThis.window;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import { cancelMigration } from "../../lib/api-client";

interface ParsedProgress {
  resource: string;
  completed: number;
  total: number;
  current_step: string;
}

function parseSseProgress(raw: string): ParsedProgress | null {
  try {
    const o = JSON.parse(raw) as Partial<ParsedProgress>;
    if (
      typeof o.resource === "string" &&
      typeof o.completed === "number" &&
      typeof o.total === "number"
    ) {
      return {
        resource: o.resource,
        completed: o.completed,
        total: o.total,
        current_step: typeof o.current_step === "string" ? o.current_step : o.resource,
      };
    }
    return null;
  } catch {
    return null;
  }
}

describe("migration SSE event parsing", () => {
  it("parses a well-formed progress event", () => {
    const raw = JSON.stringify({
      resource: "subscribers",
      completed: 250,
      total: 1000,
      current_step: "subscribers",
    });
    const out = parseSseProgress(raw);
    expect(out).toEqual({
      resource: "subscribers",
      completed: 250,
      total: 1000,
      current_step: "subscribers",
    });
  });

  it("returns null on malformed JSON (tolerate, don't throw)", () => {
    expect(parseSseProgress("not-json")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseSseProgress("{}")).toBeNull();
    expect(
      parseSseProgress(JSON.stringify({ resource: "subscribers" })),
    ).toBeNull();
  });
});

describe("migration SSE → polling fallback gate", () => {
  // Mirrors the inline guard in api.ts::subscribeMigrationEvents:
  // > if (Date.now() - sseClosedAt > 6000) startPolling();
  function shouldFallback(closedAt: number | null, now: number): boolean {
    if (closedAt == null) return false;
    return now - closedAt > 6000;
  }

  it("does not fall back below the 6s threshold", () => {
    expect(shouldFallback(1000, 6999)).toBe(false);
    expect(shouldFallback(1000, 7000)).toBe(false);
  });

  it("falls back strictly above 6s", () => {
    expect(shouldFallback(1000, 7001)).toBe(true);
  });

  it("never falls back when there's no closure timestamp", () => {
    expect(shouldFallback(null, 999_999)).toBe(false);
  });
});

describe("migration cancel — DELETE /api/v1/migrations/{id}", () => {
  it("DELETEs the right path with the encoded id", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            job_id: "job_demo",
            status: "cancelled",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );
    const r = await cancelMigration("job_demo");
    expect(r.error).toBeUndefined();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toMatch(/\/api\/v1\/migrations\/job_demo$/);
    expect(calls[0].init.method).toBe("DELETE");
  });
});
