// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// commerce-48 — referral leaderboard window chips (30d / 90d / 365d) and
// Retry. The host (referrals/page-client.tsx) is another session's WIP, so
// the card is driven directly. Assertions: the exact query each chip sends
// (GET /api/v1/referrals/leaderboard with window + limit), that the ranking
// shown belongs to the selected window (never the previous one), the
// server's own window_days in the heading, and that Retry re-sends the
// failed window's read.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReferralLeaderboardCard } from "@/components/commerce/ReferralLeaderboardCard";

const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: { ...actual.api, get: mocks.apiGet } };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const KEY_BASE = ["referrals", "tenant-1", "owner", "user-1", "durable-mode"];

function board(windowDays: number, email: string) {
  return {
    window_days: windowDays,
    items: [
      { rank: 1, referrer_email_masked: email, conversions: 7, milestone: 5 },
    ],
  };
}

let failures: Record<string, number>;

beforeEach(() => {
  failures = {};
  mocks.apiGet.mockImplementation(
    (
      path: string,
      opts?: { query?: Record<string, string | number> },
    ): Promise<unknown> => {
      if (path !== "/api/v1/referrals/leaderboard") {
        return Promise.reject(new Error(`Unexpected GET ${path}`));
      }
      const windowValue = String(opts?.query?.window ?? "");
      if ((failures[windowValue] ?? 0) > 0) {
        failures[windowValue] -= 1;
        return Promise.reject(
          new Error("Leaderboard temporarily unavailable."),
        );
      }
      if (windowValue === "30d")
        return Promise.resolve(board(30, "t***@thirty.test"));
      if (windowValue === "365d")
        return Promise.resolve(board(365, "y***@year.test"));
      return Promise.resolve(board(90, "n***@ninety.test"));
    },
  );
});

let root: Root | null = null;

function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  act(() => {
    root = createRoot(container);
    root.render(createElement(QueryClientProvider, { client }, node));
  });
  return container;
}

async function flush() {
  for (let turn = 0; turn < 8; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function chip(scope: ParentNode, days: number): HTMLButtonElement {
  const node = scope.querySelector<HTMLButtonElement>(
    `button[aria-label="Show conversions from the last ${days} days"]`,
  );
  if (!node) throw new Error(`missing chip ${days}`);
  return node;
}

function readsSent() {
  return mocks.apiGet.mock.calls.map(([path, opts]) => ({
    path,
    query: (opts as { query?: unknown } | undefined)?.query,
  }));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("ReferralLeaderboardCard", () => {
  it("loads the default 90-day window with the overview row limit", async () => {
    const scope = render(
      <ReferralLeaderboardCard keyBase={KEY_BASE} enabled />,
    );
    await flush();
    expect(readsSent()).toEqual([
      {
        path: "/api/v1/referrals/leaderboard",
        query: { window: "90d", limit: 20 },
      },
    ]);
    expect(chip(scope, 90).getAttribute("aria-pressed")).toBe("true");
    expect(scope.textContent).toContain("n***@ninety.test");
    expect(scope.textContent).toContain("ranked over the last 90 days");
  });

  it("re-queries the server for each chip and shows only that window's ranking", async () => {
    const scope = render(
      <ReferralLeaderboardCard keyBase={KEY_BASE} enabled />,
    );
    await flush();

    await act(async () => {
      chip(scope, 30).click();
    });
    await flush();
    expect(readsSent().at(-1)).toEqual({
      path: "/api/v1/referrals/leaderboard",
      query: { window: "30d", limit: 20 },
    });
    expect(chip(scope, 30).getAttribute("aria-pressed")).toBe("true");
    expect(chip(scope, 90).getAttribute("aria-pressed")).toBe("false");
    expect(scope.textContent).toContain("t***@thirty.test");
    expect(scope.textContent).not.toContain("n***@ninety.test");
    expect(scope.textContent).toContain("ranked over the last 30 days");

    await act(async () => {
      chip(scope, 365).click();
    });
    await flush();
    expect(readsSent().at(-1)?.query).toEqual({ window: "365d", limit: 20 });
    expect(scope.textContent).toContain("y***@year.test");
  });

  it("reports a failed window as an error, never an empty board, and Retry re-sends it", async () => {
    failures = { "30d": 1 };
    const scope = render(
      <ReferralLeaderboardCard keyBase={KEY_BASE} enabled />,
    );
    await flush();
    await act(async () => {
      chip(scope, 30).click();
    });
    await flush();

    expect(scope.textContent).toContain(
      "Leaderboard could not be loaded for the last 30 days",
    );
    expect(scope.textContent).toContain("Leaderboard temporarily unavailable.");
    expect(scope.textContent).not.toContain("No referrers");
    const before = readsSent().filter(
      (read) => (read.query as { window?: string })?.window === "30d",
    ).length;

    const retry = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "Retry",
    )!;
    await act(async () => {
      retry.click();
    });
    await flush();

    expect(
      readsSent().filter(
        (read) => (read.query as { window?: string })?.window === "30d",
      ).length,
    ).toBe(before + 1);
    expect(scope.textContent).toContain("t***@thirty.test");
  });

  it("sends nothing until the host enables it", async () => {
    render(<ReferralLeaderboardCard keyBase={KEY_BASE} enabled={false} />);
    await flush();
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });
});
