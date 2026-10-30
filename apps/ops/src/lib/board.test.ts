// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

const nextHeaders = vi.hoisted(() => ({ headers: vi.fn() }));
vi.mock("next/headers", () => ({ headers: nextHeaders.headers }));

import { fetchBoard, formatAge, isBoardResponse } from "./board";

const SESSION = `${"a".repeat(22)}.${"b".repeat(43)}`;
const card = {
  id: "billing.dlq-depth",
  why: "Customers may be charged without receiving service.",
  kind: "evaluated",
  severity: "critical",
  status: "red",
  remediation: "Replay the bounded dead-letter batch.",
  first_red_at: "2026-07-15T10:00:00Z",
  action: {
    id: "billing.replay-dlq",
    label: "Replay dead letters",
    danger: "type_to_confirm",
  },
} as const;

const board = {
  generated_at: "2026-07-15T10:05:00Z",
  coverage: { declared: 1, watched: 1 },
  lanes: [
    { name: "ON FIRE", cards: [card], count: 1 },
    { name: "NEEDS YOU", count: 0 },
    { name: "BLOCKED", count: 0 },
    { name: "UNWATCHED", count: 0 },
    { name: "CLOCKS", count: 0 },
    { name: "AUTOMATIONS", count: 0 },
    { name: "SNOOZED", count: 0 },
    { name: "GREEN", count: 0 },
  ],
} as const;

function stubProductionEnv() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("OPS_API_ORIGIN", "https://internal-api.postwave.example");
  vi.stubEnv("OPS_API_ALLOWED_HOSTS", "internal-api.postwave.example");
  vi.stubEnv("OPS_PUBLIC_ORIGIN", "https://ops.postwave.example");
  vi.stubEnv("OPS_RUNBOOK_BASE_URL", "https://runbooks.postwave.example/production/");
}

function mockCookie() {
  nextHeaders.headers.mockResolvedValue(new Headers({ cookie: `pw_session=${SESSION}` }));
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withLane(lane: { name: string } & Record<string, unknown>) {
  return { ...board, lanes: board.lanes.map((l) => (l.name === lane.name ? lane : l)) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  nextHeaders.headers.mockReset();
});

describe("isBoardResponse", () => {
  it("accepts the exact six-lane schema", () => {
    expect(isBoardResponse(board)).toBe(true);
  });

  it("rejects broadened, inconsistent, duplicate, and invalid-time data", () => {
    expect(isBoardResponse({ ...board, internal: "secret" })).toBe(false);
    expect(isBoardResponse({
      ...board,
      lanes: [{ ...board.lanes[0], count: 2 }, ...board.lanes.slice(1)],
    })).toBe(false);
    // A duplicated lane necessarily drops a canonical one, so at the pinned
    // length of 6 this trips the all-lanes-present guard; the top-level name
    // dedup cannot be isolated from it. The within-lane id dedup that IS
    // independently meaningful is exercised by the AUTOMATIONS/GREEN cases below.
    expect(isBoardResponse({
      ...board,
      lanes: [board.lanes[0], board.lanes[0], ...board.lanes.slice(2)],
    })).toBe(false);
    expect(isBoardResponse({ ...board, generated_at: "2026-02-31T10:05:00Z" })).toBe(false);
    expect(isBoardResponse({
      ...board,
      lanes: [
        { ...board.lanes[0], cards: [{ ...card, status: "unknown" }] },
        ...board.lanes.slice(1),
      ],
    })).toBe(false);
  });
});

describe("fetchBoard", () => {
  it("forwards only the session, refuses redirects, and parses JSON strictly", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPS_API_ORIGIN", "https://api.internal.example");
    vi.stubEnv("OPS_API_ALLOWED_HOSTS", "api.internal.example");
    vi.stubEnv("OPS_PUBLIC_ORIGIN", "https://ops.example.com");
    vi.stubEnv("OPS_RUNBOOK_BASE_URL", "https://runbooks.example.com/production/");
    nextHeaders.headers.mockResolvedValue(
      new Headers({ cookie: `analytics=secret; pw_session=${SESSION}; private=secret` }),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(board), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(fetchBoard()).resolves.toEqual({ ok: true, board });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.redirect).toBe("error");
    const forwarded = new Headers(init?.headers);
    expect(forwarded.get("cookie")).toBe(`pw_session=${SESSION}`);
    expect(forwarded.get("accept")).toBe("application/json");
  });
});

describe("fetchBoard fail-loud", () => {
  it("reports unsafe config and never touches the network", async () => {
    // NODE_ENV=production without OPS_API_ORIGIN → loadOpsRuntimeConfig throws.
    // The CI job exports OPS_API_ORIGIN for the build steps, so the absence
    // this test depends on is stubbed explicitly rather than inherited.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPS_API_ORIGIN", "");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(fetchBoard()).resolves.toEqual({
      ok: false,
      status: undefined,
      message: "the ops console is not configured safely",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails loud, not green, on a non-2xx upstream", async () => {
    stubProductionEnv();
    mockCookie();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(board, 503));
    await expect(fetchBoard()).resolves.toEqual({
      ok: false,
      status: 503,
      message: "the ops service is unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the operator-auth message on 401", async () => {
    stubProductionEnv();
    mockCookie();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(board, 401));
    await expect(fetchBoard()).resolves.toEqual({
      ok: false,
      status: 401,
      message: "operator authentication is required",
    });
  });

  it("rejects a 200 that fails the board schema", async () => {
    stubProductionEnv();
    mockCookie();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...board, lanes: board.lanes.slice(0, 5) }, 200),
    );
    await expect(fetchBoard()).resolves.toEqual({
      ok: false,
      status: 200,
      message: "the ops service returned invalid data",
    });
  });

  it("fails loud when the upstream is unreachable", async () => {
    stubProductionEnv();
    mockCookie();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("connection refused"));
    await expect(fetchBoard()).resolves.toEqual({
      ok: false,
      status: undefined,
      message: "the ops service is unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a card whose runbook link is not allowlisted", async () => {
    stubProductionEnv();
    mockCookie();
    const poisoned = {
      ...board,
      lanes: [
        { name: "ON FIRE", cards: [{ ...card, runbook: "javascript:alert(1)" }], count: 1 },
        ...board.lanes.slice(1),
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(poisoned, 200));
    await expect(fetchBoard()).resolves.toEqual({
      ok: false,
      status: 200,
      message: "the ops service returned an invalid runbook link",
    });
  });
});

describe("isBoardResponse AUTOMATIONS and GREEN invariants", () => {
  it("accepts a consistent AUTOMATIONS lane and rejects each broken invariant", () => {
    expect(isBoardResponse(withLane({
      name: "AUTOMATIONS", count: 3, alive: 1, stale: 2,
      stale_ids: ["billing.dlq-depth", "billing.webhook-lag"],
    }))).toBe(true);
    // alive + stale !== count
    expect(isBoardResponse(withLane({
      name: "AUTOMATIONS", count: 4, alive: 1, stale: 2,
      stale_ids: ["billing.dlq-depth", "billing.webhook-lag"],
    }))).toBe(false);
    // stale_ids.length !== stale
    expect(isBoardResponse(withLane({
      name: "AUTOMATIONS", count: 3, alive: 1, stale: 2,
      stale_ids: ["billing.dlq-depth"],
    }))).toBe(false);
    // a stale id is not a valid check id
    expect(isBoardResponse(withLane({
      name: "AUTOMATIONS", count: 3, alive: 1, stale: 2,
      stale_ids: ["billing.dlq-depth", "BILLING.INVALID"],
    }))).toBe(false);
    // duplicate stale id
    expect(isBoardResponse(withLane({
      name: "AUTOMATIONS", count: 3, alive: 1, stale: 2,
      stale_ids: ["billing.dlq-depth", "billing.dlq-depth"],
    }))).toBe(false);
  });

  it("accepts a consistent GREEN lane and rejects count mismatch and a duplicate id", () => {
    expect(isBoardResponse(withLane({
      name: "GREEN", count: 2, ids: ["billing.dlq-depth", "billing.webhook-lag"],
    }))).toBe(true);
    // ids.length !== count
    expect(isBoardResponse(withLane({
      name: "GREEN", count: 3, ids: ["billing.dlq-depth", "billing.webhook-lag"],
    }))).toBe(false);
    // duplicate id
    expect(isBoardResponse(withLane({
      name: "GREEN", count: 2, ids: ["billing.dlq-depth", "billing.dlq-depth"],
    }))).toBe(false);
  });
});

describe("formatAge boundaries", () => {
  const base = "2026-07-15T10:00:00Z";

  it("renders minutes, then hours, then days across the boundaries", () => {
    expect(formatAge(base, base)).toBe("0m");
    expect(formatAge(base, "2026-07-15T10:59:00Z")).toBe("59m");
    expect(formatAge(base, "2026-07-15T11:00:00Z")).toBe("1h");
    expect(formatAge(base, "2026-07-17T09:00:00Z")).toBe("47h");
    expect(formatAge(base, "2026-07-17T10:00:00Z")).toBe("2d");
    expect(formatAge(base, "2026-07-23T10:00:00Z")).toBe("8d");
  });

  it("is symmetric because it measures absolute distance", () => {
    expect(formatAge("2026-07-17T09:00:00Z", base)).toBe(formatAge(base, "2026-07-17T09:00:00Z"));
    expect(formatAge("2026-07-23T10:00:00Z", base)).toBe("8d");
  });
});

// ---------------------------------------------------------------------------
// Coverage + the two honesty lanes.
//
// These lanes exist to stop the board lying by omission, so their validators
// have to be at least as strict as a Card's: a malformed UNWATCHED row that
// were dropped rather than refused would render as an empty coverage gap,
// which reads as full coverage — the exact lie, restored.
// ---------------------------------------------------------------------------

const unwatchedRow = {
  id: "growth",
  label: "Signups, activation & retention",
  why: "A broken signup path presents as a quiet week, not an error.",
  owner: "growth",
  reason: "no_check",
} as const;

describe("board coverage contract", () => {
  it("accepts a board carrying coverage and populated honesty lanes", () => {
    const withCoverage = {
      ...board,
      coverage: { declared: 2, watched: 1 },
      lanes: board.lanes.map((l) =>
        l.name === "UNWATCHED" ? { name: "UNWATCHED", count: 1, domains: [unwatchedRow] } : l,
      ),
    };
    expect(isBoardResponse(withCoverage)).toBe(true);
  });

  it("refuses a board with no coverage at all", () => {
    const noCoverage: Record<string, unknown> = { ...board };
    delete noCoverage.coverage;
    expect(isBoardResponse(noCoverage)).toBe(false);
  });

  it("refuses coverage that claims more surfaces watched than declared", () => {
    expect(isBoardResponse({ ...board, coverage: { declared: 1, watched: 2 } })).toBe(false);
  });

  it("refuses an UNWATCHED lane whose count disagrees with its rows", () => {
    // The count is what the statbar renders. A lane claiming 0 while carrying a
    // real gap is precisely the silent-green failure, so it must be refused
    // rather than reconciled.
    expect(
      isBoardResponse(
        withLane({ name: "UNWATCHED", count: 0, domains: [unwatchedRow] }),
      ),
    ).toBe(false);
  });

  it("refuses an unwatched row with an unknown reason", () => {
    expect(
      isBoardResponse(
        withLane({
          name: "UNWATCHED",
          count: 1,
          domains: [{ ...unwatchedRow, reason: "probably_fine" }],
        }),
      ),
    ).toBe(false);
  });

  it("refuses an unwatched row with no owner", () => {
    const ownerless: Record<string, unknown> = { ...unwatchedRow };
    delete ownerless.owner;
    expect(
      isBoardResponse(withLane({ name: "UNWATCHED", count: 1, domains: [ownerless] })),
    ).toBe(false);
  });

  it("refuses duplicate unwatched domains, which would double-count the gap", () => {
    expect(
      isBoardResponse(
        withLane({ name: "UNWATCHED", count: 2, domains: [unwatchedRow, unwatchedRow] }),
      ),
    ).toBe(false);
  });

  it("accepts a blocked card and its blocker metadata", () => {
    const blockedCard = {
      ...card,
      id: "sending.ses-production-access",
      status: "blocked",
      blocked: {
        reason: "SES production access denied in eu-north-1",
        owner: "founder",
        tracking: "https://runbooks.postwave.example/production/ses.md",
      },
    };
    expect(
      isBoardResponse(withLane({ name: "BLOCKED", count: 1, cards: [blockedCard] })),
    ).toBe(true);
  });

  it("refuses a blocked card whose blocker names nobody who can clear it", () => {
    const blockedCard = {
      ...card,
      status: "blocked",
      blocked: { reason: "SES production access denied" },
    };
    expect(
      isBoardResponse(withLane({ name: "BLOCKED", count: 1, cards: [blockedCard] })),
    ).toBe(false);
  });

  it("still refuses a board that drops one of the eight lanes", () => {
    const short = { ...board, lanes: board.lanes.filter((l) => l.name !== "UNWATCHED") };
    expect(isBoardResponse(short)).toBe(false);
  });
});
