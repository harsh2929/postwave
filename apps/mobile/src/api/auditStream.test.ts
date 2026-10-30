/**
 * The audit tail's stream, at the transport boundary.
 *
 * The one behaviour that must never regress: a frame carries no payload out of
 * this module. The server's stream is tenant-wide and applies none of the
 * screen's actor/window filters, so the moment a row from it reaches a render
 * path the count on screen and the list under it disagree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchCall = { url: string };
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
  fetch: (url: string) => {
    fetchCalls.push({ url });
    return Promise.resolve(asStreamResponse(nextResponse()));
  },
}));

/**
 * `connectSse` refuses to read a 200 whose `Content-Type` is not
 * `text/event-stream` — a JSON answer from a proxy is a failed attempt, not a
 * stream (`sseNonStreamResponse.test.ts`). Every SSE route in apps/api sets the
 * header (here, internal/handlers/audit_extras.go), but the fixtures below
 * describe status + body only, so it is supplied once here instead of being
 * repeated on each. A fixture that sets its own `headers` is left as written.
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

describe("connectAuditStream", () => {
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

  it("opens the audit stream route", async () => {
    const { connectAuditStream } = await import("./auditStream");
    const stop = connectAuditStream({ onActivity: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls[0]?.url).toContain("/api/v1/audit/stream");
    stop();
  });

  it("signals once per row frame", async () => {
    const { connectAuditStream } = await import("./auditStream");
    let hits = 0;
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: bodyOf([
        'event: hello\ndata: {"sinceId":42}\n\n',
        'event: audit\ndata: {"id":43,"action":"campaign.sent"}\n\n',
        'event: audit\ndata: {"id":44,"action":"list.created"}\n\n',
      ]),
    });

    const stop = connectAuditStream({ onActivity: () => (hits += 1) });
    await vi.advanceTimersByTimeAsync(0);
    // Two rows, and NOT the `hello` cursor seed.
    expect(hits).toBe(2);
    stop();
  });

  it("does not signal on the connect cursor seed alone", async () => {
    const { connectAuditStream } = await import("./auditStream");
    let hits = 0;
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: bodyOf(['event: hello\ndata: {"sinceId":42}\n\n']),
    });

    const stop = connectAuditStream({ onActivity: () => (hits += 1) });
    await vi.advanceTimersByTimeAsync(0);
    expect(hits).toBe(0);
    stop();
  });

  it("drops the row the tail's own probe just wrote", async () => {
    // THE FEEDBACK LOOP. `GET /api/v1/audit` — the probe this stream exists to
    // trigger — is itself audited as `audit.read.list`, and the stream's row
    // query has no action filter, so the probe's own row comes back as
    // `event: audit`. Acting on it made the tail re-fire itself every 3s on a
    // completely idle tenant, ~20 requests/min and ~20 self-generated rows in
    // the compliance table, per device, for as long as the screen was open.
    const { connectAuditStream } = await import("./auditStream");
    let hits = 0;
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: bodyOf([
        'event: audit\ndata: {"id":43,"action":"audit.read.list"}\n\n',
        'event: audit\ndata: {"id":44,"action":"audit.read.stream_open"}\n\n',
        'event: audit\ndata: {"id":45,"action":"http.request"}\n\n',
        'event: audit\ndata: {"id":46,"action":"campaign.sent"}\n\n',
      ]),
    });

    const stop = connectAuditStream({ onActivity: () => (hits += 1) });
    await vi.advanceTimersByTimeAsync(0);
    // Only the one row that is real workspace activity.
    expect(hits).toBe(1);
    stop();
  });

  it("signals nothing and STOPS on a 403 — the role cannot open this route", async () => {
    // `GET /api/v1/audit/stream` is mounted behind
    // RequireAllScopes(audit:read, audit:read_pii) and a stream token carries
    // [admin] only for owner/admin. For every other reader this route is a
    // permanent 403 — and a retry mints a brand new token with exactly the
    // same scopes, so backing off does not reduce the load, it paces it.
    const { connectAuditStream } = await import("./auditStream");
    let hits = 0;
    const statuses: string[] = [];
    nextResponse = () => ({ ok: false, status: 403, statusText: "Forbidden" });

    const stop = connectAuditStream({
      onActivity: () => (hits += 1),
      onStatus: (s) => statuses.push(s),
      random: () => 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls).toHaveLength(1);
    // Two minutes of wall clock: not one further attempt, not one further
    // stream-token mint.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(hits).toBe(0);
    expect(fetchCalls).toHaveLength(1);
    // And no further stream-token mint. `buildRequest` runs per attempt, so
    // an unbounded retry is also an unbounded credential mint.
    expect(
      (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock
        .calls,
    ).toHaveLength(1);
    expect(statuses.at(-1)).toBe("closed");
    stop();
  });

  it("retries a 401 — a failed token mint is transient — but not forever", async () => {
    // `mintStreamToken` returns null on ANY failure and the caller then
    // connects with no token, which a credentialed route answers 401. Killing
    // the stream on the first one would end the live tail for the rest of the
    // screen's life over one flaky radio moment. Killing it on the twentieth
    // is the whole point.
    const { connectAuditStream } = await import("./auditStream");
    const { SSE_UNAUTHORIZED_RETRY_BUDGET } = await import("./sseAuthPolicy");
    nextResponse = () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    const stop = connectAuditStream({ onActivity: () => {}, random: () => 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchCalls).toHaveLength(2);
    // Well past the 1s→30s backoff ramp: it settles, it does not run on.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchCalls).toHaveLength(SSE_UNAUTHORIZED_RETRY_BUDGET);
    stop();
  });

  it("gives the 401 budget back after a connection that worked", async () => {
    // The budget is about a credential being refused OVER AND OVER. A stream
    // that reconnects fine in between has not exhausted anything.
    const { connectAuditStream } = await import("./auditStream");
    const { SSE_UNAUTHORIZED_RETRY_BUDGET } = await import("./sseAuthPolicy");
    let n = 0;
    nextResponse = () => {
      n += 1;
      // Refuse up to one short of the budget, then serve one real (empty)
      // stream, then refuse forever.
      if (n === SSE_UNAUTHORIZED_RETRY_BUDGET) {
        return { ok: true, status: 200, statusText: "OK", body: bodyOf([]) };
      }
      return { ok: false, status: 401, statusText: "Unauthorized" };
    };

    const stop = connectAuditStream({ onActivity: () => {}, random: () => 1 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600_000);
    // Without the reset it would have stopped at the budget. With it, the
    // good open buys a fresh one.
    expect(fetchCalls.length).toBe(SSE_UNAUTHORIZED_RETRY_BUDGET * 2);
    stop();
  });

  it("keeps retrying a failure that is not an authorization refusal", async () => {
    // The terminal branch must stay narrow: a 503 is a deploy, not a decision.
    const { connectAuditStream } = await import("./auditStream");
    nextResponse = () => ({
      ok: false,
      status: 503,
      statusText: "Unavailable",
    });

    const stop = connectAuditStream({
      onActivity: () => {},
      random: () => 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
    stop();
  });
});

describe("connectInvestigationStream", () => {
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

  it("opens the per-investigation stream route, id-encoded", async () => {
    const { connectInvestigationStream } = await import("./auditStream");
    const stop = connectInvestigationStream("inv/1", { onActivity: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls[0]?.url).toContain(
      "/api/v1/audit/investigations/inv%2F1/stream",
    );
    stop();
  });

  it("signals per transition frame and never on the connect hello", async () => {
    const { connectInvestigationStream } = await import("./auditStream");
    let hits = 0;
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: bodyOf([
        'event: hello\ndata: {"id":"inv-1"}\n\n',
        'event: status\ndata: {"id":"inv-1","status":"approved"}\n\n',
        'event: status\ndata: {"id":"inv-1","status":"executed"}\n\n',
      ]),
    });
    const stop = connectInvestigationStream("inv-1", {
      onActivity: () => (hits += 1),
    });
    await vi.advanceTimersByTimeAsync(0);
    // Two transitions; the hello handshake is not a transition.
    expect(hits).toBe(2);
    stop();
  });

  it("treats an authorization refusal as terminal, exactly like the tail", async () => {
    const { connectInvestigationStream } = await import("./auditStream");
    let hits = 0;
    nextResponse = () => ({ ok: false, status: 403, statusText: "Forbidden" });
    const stop = connectInvestigationStream("inv-1", {
      onActivity: () => (hits += 1),
      random: () => 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(hits).toBe(0);
    expect(fetchCalls).toHaveLength(1);
    stop();
  });
});
