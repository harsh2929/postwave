/**
 * Transport seam for the Compliance evidence reads — given exactly the
 * `{data, error}` envelope rawRequest resolves to (and, for the binary
 * bundle, exactly the Response expo/fetch hands back), do the right requests
 * leave and do the right bytes come back?
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchAgentAuditStats,
  AIVS_BUNDLE_TIMEOUT_MESSAGE,
  fetchAivsBundle,
  fetchRetentionActivity,
} from "./complianceEvidence";

const { rawRequest, expoFetch, getState } = vi.hoisted(() => ({
  rawRequest: vi.fn(),
  expoFetch: vi.fn(),
  getState: vi.fn(),
}));
vi.mock("@/api/request", () => ({ rawRequest }));
vi.mock("expo/fetch", () => ({ fetch: expoFetch }));
vi.mock("@/store/auth", () => ({ useAuthStore: { getState } }));
// The MFA interceptor is pass-through here; its own behaviour is pinned in
// api/auth tests. Mocking it keeps this seam test off the Zustand gate.
vi.mock("./auth", () => ({
  interceptMfaRequiredResponse: async (res: unknown) => res,
}));

function cookieSession() {
  return {
    apiKey: null,
    baseUrl: "https://api.example.com",
    mode: "session",
    tenantId: "11111111-1111-4111-8111-111111111111",
    session: { workspaceSlug: "acme" },
  };
}

function bundleResponse(over: Record<string, unknown> = {}) {
  const headers = new Map<string, string>([
    ["content-disposition", 'attachment; filename="aivs-sess-1.tar.gz"'],
    ["content-length", "4"],
  ]);
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    text: async () => "",
    body: undefined,
    ...over,
  };
}

beforeEach(() => {
  rawRequest.mockReset();
  expoFetch.mockReset();
  getState.mockReset();
  getState.mockReturnValue(cookieSession());
});

describe("retention-activity transport", () => {
  it("GETs the bounded route and parses the wire shape", async () => {
    rawRequest.mockResolvedValue({
      data: { events: [], count: 0, total_purged_last_30d: 0 },
      error: null,
    });
    const activity = await fetchRetentionActivity();
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/audit/retention-activity?limit=100",
      undefined,
    );
    expect(activity).toEqual({ events: [], totalPurgedLast30d: 0 });
  });

  it("throws with status on an envelope error — never an empty trail", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "forbidden" },
    });
    await expect(fetchRetentionActivity()).rejects.toMatchObject({
      status: 403,
    });
  });

  it("treats an unparseable payload as a failure, not an empty answer", async () => {
    rawRequest.mockResolvedValue({ data: { nonsense: true }, error: null });
    await expect(fetchRetentionActivity()).rejects.toThrow(
      /could not be read/,
    );
  });
});

describe("agent audit-stats transport", () => {
  it("scopes the stats read to agent actors since the window start", async () => {
    rawRequest.mockResolvedValue({ data: { total_events: 3 }, error: null });
    const raw = await fetchAgentAuditStats("2026-07-30T00:00:00.000Z");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/audit/stats?actor_type=agent&since=2026-07-30T00%3A00%3A00.000Z",
      undefined,
    );
    expect(raw).toEqual({ total_events: 3 });
  });
});

describe("AIVS bundle transport", () => {
  it("fetches the bundle bytes through the session with the native headers", async () => {
    expoFetch.mockResolvedValue(bundleResponse());
    const bundle = await fetchAivsBundle("sess-1");
    expect(expoFetch).toHaveBeenCalledTimes(1);
    const [url, init] = expoFetch.mock.calls[0] as [
      string,
      {
        method: string;
        credentials?: string;
        headers: Record<string, string>;
      },
    ];
    expect(url).toBe(
      "https://api.example.com/api/v1/audit/ai-session/sess-1/aivs-bundle",
    );
    expect(init.method).toBe("GET");
    // Cookie mode: the session travels as credentials, not a bearer.
    expect(init.credentials).toBe("include");
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers["X-Tenant-Slug"]).toBe("acme");
    expect(bundle.filename).toBe("aivs-sess-1.tar.gz");
    expect(Array.from(bundle.bytes)).toEqual([1, 2, 3, 4]);
  });

  it("path-encodes the session id — it is a path segment, not a suggestion", async () => {
    expoFetch.mockResolvedValue(bundleResponse());
    await fetchAivsBundle("s%2f1");
    const [url] = expoFetch.mock.calls[0] as [string];
    expect(url).toContain("/ai-session/s%252f1/aivs-bundle");
  });

  it("carries a bearer (pw_-prefixed) instead of cookies in api_key mode", async () => {
    getState.mockReturnValue({
      ...cookieSession(),
      apiKey: "abc",
      mode: "api_key",
      session: null,
    });
    expoFetch.mockResolvedValue(bundleResponse());
    await fetchAivsBundle("sess-1");
    const [, init] = expoFetch.mock.calls[0] as [
      string,
      { credentials?: string; headers: Record<string, string> },
    ];
    expect(init.headers.Authorization).toBe("Bearer pw_abc");
    expect(init.credentials).toBeUndefined();
  });

  it("keeps status AND code from a refusal body so 403/no_agent_events stay distinct", async () => {
    expoFetch.mockResolvedValue(
      bundleResponse({
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({ error: { message: "none", code: "no_agent_events" } }),
        headers: { get: () => null },
      }),
    );
    await expect(fetchAivsBundle("sess-1")).rejects.toMatchObject({
      status: 404,
      code: "no_agent_events",
    });
  });

  it("refuses an over-cap or empty body instead of holding it in memory", async () => {
    expoFetch.mockResolvedValue(
      bundleResponse({
        headers: { get: (n: string) => (n === "content-length" ? String(64 * 1024 * 1024) : null) },
      }),
    );
    await expect(fetchAivsBundle("sess-1")).rejects.toThrow(/export cap/);

    expoFetch.mockResolvedValue(
      bundleResponse({
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    );
    await expect(fetchAivsBundle("sess-1")).rejects.toThrow(/empty bundle/);
  });

  it("refuses to fetch with no session at all", async () => {
    getState.mockReturnValue({ ...cookieSession(), baseUrl: "" });
    await expect(fetchAivsBundle("sess-1")).rejects.toThrow(/Sign in/);
    expect(expoFetch).not.toHaveBeenCalled();
  });
});

/**
 * The bundle export is `press → setBusy(true) → await`, and its button is
 * DISABLED while busy (components/compliance/Article50ReadinessCard.tsx). A
 * request with no deadline therefore does not merely take a long time — it
 * leaves the control unusable for the life of the screen. These pin the two
 * halves of the budget: that one EXISTS, and that it is not so tight it kills a
 * large transfer that is working.
 */
describe("AIVS bundle time budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands the request an abort signal at all", async () => {
    expoFetch.mockResolvedValue(bundleResponse());
    await fetchAivsBundle("sess-1");
    const [, init] = expoFetch.mock.calls[0] as [
      string,
      { signal?: AbortSignal },
    ];
    expect(
      init.signal,
      "the bundle fetch went out with no signal, so nothing can ever stop it",
    ).toBeInstanceOf(AbortSignal);
  });

  it("gives up on a server that never answers, with a sentence worth reading", async () => {
    // A half-open socket: the fetch settles only when it is aborted.
    expoFetch.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const pending = fetchAivsBundle("sess-1");
    const settled = expect(pending).rejects.toThrow(
      AIVS_BUNDLE_TIMEOUT_MESSAGE,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
  });

  it("does not kill a slow body with the deadline meant for the response", async () => {
    // Headers arrive at once; the 32 MB of bytes take another 60s — longer
    // than the RESPONSE budget, well inside the BODY budget. The body read
    // OBSERVES the signal, exactly as a real transfer does, so a response
    // deadline still running here shows up as a cancelled download.
    expoFetch.mockImplementation(
      async (_url: string, init: { signal: AbortSignal }) =>
        bundleResponse({
          arrayBuffer: () =>
            new Promise((resolve, reject) => {
              const done = setTimeout(
                () => resolve(new Uint8Array([9, 9]).buffer),
                60_000,
              );
              init.signal.addEventListener("abort", () => {
                clearTimeout(done);
                const err = new Error("Aborted");
                err.name = "AbortError";
                reject(err);
              });
            }),
        }),
    );
    const pending = fetchAivsBundle("sess-1");
    await vi.advanceTimersByTimeAsync(60_000);
    const bundle = await pending;
    expect(
      Array.from(bundle.bytes),
      "the response deadline was still running during the body read, so a healthy large download was cancelled",
    ).toEqual([9, 9]);
  });

  it("still bounds a body that never finishes arriving", async () => {
    expoFetch.mockImplementation(
      async (_url: string, init: { signal: AbortSignal }) =>
        bundleResponse({
          arrayBuffer: () =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => {
                const err = new Error("Aborted");
                err.name = "AbortError";
                reject(err);
              });
            }),
        }),
    );
    const pending = fetchAivsBundle("sess-1");
    const settled = expect(pending).rejects.toThrow(
      AIVS_BUNDLE_TIMEOUT_MESSAGE,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    await settled;
  });
});
