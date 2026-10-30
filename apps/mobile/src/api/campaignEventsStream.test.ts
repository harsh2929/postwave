/**
 * The live-send stream, end to end through the shared SSE connector.
 *
 * The point of these is the DEGRADATION, not the happy path: the whole design
 * of layering this stream under an existing poll is that no failure it can
 * suffer is allowed to reach a surface. So the assertions are mostly about
 * what is NOT delivered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchCall = { url: string; init: { signal: AbortSignal } };
const fetchCalls: FetchCall[] = [];
let nextResponse: () => unknown = () => ({ ok: true, status: 200, body: null });

vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: () => true }));

vi.mock("@/store/auth", () => ({
  useAuthStore: {
    getState: () => ({
      mode: "session",
      tenantId: null,
      session: { workspaceSlug: "acme" },
      apiKey: null,
      baseUrl: "https://api.test.example",
    }),
  },
}));

vi.mock("expo/fetch", () => ({
  fetch: (url: string, init: FetchCall["init"]) => {
    fetchCalls.push({ url, init });
    return Promise.resolve(asStreamResponse(nextResponse()));
  },
}));

/**
 * `connectSse` refuses to read a 200 whose `Content-Type` is not
 * `text/event-stream` — a JSON answer from a proxy is a failed attempt, not a
 * stream (`sseNonStreamResponse.test.ts`). Every SSE route in apps/api sets the
 * header (here, internal/analytics/sse.go), but the fixtures below describe
 * status + body only, so it is supplied once here instead of being repeated on
 * each. A fixture that sets its own `headers` is left as written.
 */
function asStreamResponse(res: unknown): unknown {
  const value = res as { headers?: unknown };
  if (value.headers) return res;
  return {
    ...value,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "text/event-stream" : null,
    },
  };
}

vi.mock("./auth", () => ({
  interceptMfaRequiredResponse: (res: unknown) => Promise.resolve(res),
}));

function bodyOf(chunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: () =>
        Promise.resolve(
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined },
        ),
      cancel: () => Promise.resolve(),
    }),
  };
}

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const REPORT = { campaign_id: "c1", sent: 120, delivered: 118 };

describe("connectCampaignEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00Z"));
    fetchCalls.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => null },
          body: null,
          text: () => Promise.resolve(JSON.stringify({ token: "pws_tok" })),
        }),
      ),
    );
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("opens the campaign's SSE route with a minted stream token", async () => {
    const { connectCampaignEvents } = await import("./campaignEventsStream");
    const stop = connectCampaignEvents("c1", { onReport: () => {} });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain("/api/v1/campaigns/c1/events");
    // The route is `exposure: credentialed` — the token is not optional.
    expect(fetchCalls[0]!.url).toContain("stream_token=pws_tok");
    stop();
  });

  it("delivers snapshot and delta reports in order", async () => {
    const { connectCampaignEvents } = await import("./campaignEventsStream");
    const reports: number[] = [];
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: bodyOf([
        sse("snapshot", REPORT),
        sse("delta", { ...REPORT, sent: 200 }),
      ]),
    });

    const stop = connectCampaignEvents("c1", {
      onReport: (r) => reports.push(Number(r.sent)),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toEqual([120, 200]);
    stop();
  });

  it("never delivers an anomaly frame as a report", async () => {
    const { connectCampaignEvents } = await import("./campaignEventsStream");
    const reports: unknown[] = [];
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: bodyOf([sse("anomaly", { campaign_id: "c1", anomalies: [{}] })]),
    });

    const stop = connectCampaignEvents("c1", {
      onReport: (r) => reports.push(r),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toEqual([]);
    stop();
  });

  it("never delivers another campaign's report", async () => {
    const { connectCampaignEvents } = await import("./campaignEventsStream");
    const reports: unknown[] = [];
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: bodyOf([sse("delta", { ...REPORT, campaign_id: "other" })]),
    });

    const stop = connectCampaignEvents("c1", {
      onReport: (r) => reports.push(r),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toEqual([]);
    stop();
  });

  it("reports the server's error frame without touching onReport", async () => {
    const { connectCampaignEvents } = await import("./campaignEventsStream");
    const reports: unknown[] = [];
    const errors: { code: string }[] = [];
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: bodyOf([
        sse("error", { code: "analytics_stream_unavailable", message: "x" }),
      ]),
    });

    const stop = connectCampaignEvents("c1", {
      onReport: (r) => reports.push(r),
      onStreamError: (e) => errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toEqual([]);
    expect(errors.map((e) => e.code)).toEqual(["analytics_stream_unavailable"]);
    stop();
  });

  it("delivers nothing and keeps retrying when the route 401s", async () => {
    // The credentialed route rejects a request whose token failed to mint.
    // The poll underneath is what keeps the screen correct; this must simply
    // not deliver a wrong value.
    const { connectCampaignEvents } = await import("./campaignEventsStream");
    const reports: unknown[] = [];
    nextResponse = () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    const stop = connectCampaignEvents("c1", {
      onReport: (r) => reports.push(r),
      random: () => 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
    expect(reports).toEqual([]);
    stop();
  });

  it("stops on disconnect", async () => {
    const { connectCampaignEvents } = await import("./campaignEventsStream");
    nextResponse = () => ({
      ok: false,
      status: 503,
      statusText: "Unavailable",
    });
    const stop = connectCampaignEvents("c1", {
      onReport: () => {},
      random: () => 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchCalls).toHaveLength(1);
  });
});
