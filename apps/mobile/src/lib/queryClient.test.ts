import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { Mutation, Query } from "@tanstack/react-query";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

// eslint-disable-next-line import/first
import {
  RECONNECT_REFETCH_QUERY_ROOTS,
  invalidatePrimaryDataOnReconnect,
  isReconnectRefetchQuery,
  offlineSafeMutationMeta,
  queryPersistOptions,
  shouldPersistMutation,
  shouldPersistQuery,
} from "./queryClient";

function q(key: unknown[]): Query {
  return { queryKey: key, state: { status: "success" } } as unknown as Query;
}

function qWithStatus(key: unknown[], status: string): Query {
  return { queryKey: key, state: { status } } as unknown as Query;
}

/**
 * A mutation as the dehydrator sees it: `options.meta` decides eligibility and
 * `state.isPaused` decides whether the write still has to happen.
 */
function m(input: {
  offlineSafe?: boolean;
  isPaused: boolean;
  status?: string;
  context?: unknown;
}): Mutation {
  return {
    options: {
      mutationKey: ["subscriber.update"],
      meta: input.offlineSafe ? offlineSafeMutationMeta : undefined,
    },
    state: {
      status: input.status ?? (input.isPaused ? "pending" : "success"),
      isPaused: input.isPaused,
      variables: { id: "sub-1", email: "person@example.com" },
      // The rollback snapshot an optimistic write stashes in onMutate: a full
      // copy of the cached list it is about to overwrite.
      context: input.context,
    },
  } as unknown as Mutation;
}

describe("mobile query persistence policy", () => {
  it("invalidates older persisted query caches after narrowing offline scope", () => {
    expect(queryPersistOptions.buster).toBe("postwave-mobile-encrypted-v5");
    expect(queryPersistOptions.maxAge).toBe(2 * 60 * 60 * 1000);
  });

  it("never persists server query responses in the generic cache", () => {
    expect(shouldPersistQuery(q(["custom-domains", "tenant-1"]))).toBe(false);
    expect(shouldPersistQuery(q(["lists", "tenant-1"]))).toBe(false);
    expect(shouldPersistQuery(q(["tags", "tenant-1"]))).toBe(false);
  });

  it("does not persist sensitive subscriber or audit data", () => {
    expect(shouldPersistQuery(q(["subs", "tenant-1", ""]))).toBe(false);
    expect(shouldPersistQuery(q(["sub", "tenant-1", "subscriber-1"]))).toBe(
      false,
    );
    expect(shouldPersistQuery(q(["audit", "tenant-1", 50]))).toBe(false);
    // Dashboard stats embeds recent audit actor labels and inbox health.
    expect(shouldPersistQuery(q(["dashboard-stats", "tenant-1"]))).toBe(false);
    expect(
      shouldPersistQuery(q(["discount-redemptions", "tenant-1", "VIP20"])),
    ).toBe(false);
    expect(shouldPersistQuery(q(["campaigns", "tenant-1"]))).toBe(false);
    expect(shouldPersistQuery(q(["campaign", "tenant-1", "campaign-1"]))).toBe(
      false,
    );
    expect(
      shouldPersistQuery(q(["campaign-report", "tenant-1", "campaign-1"])),
    ).toBe(false);
    expect(shouldPersistQuery(q(["sequences", "tenant-1"]))).toBe(false);
    expect(shouldPersistQuery(q(["sequence", "tenant-1", "seq-1"]))).toBe(
      false,
    );
    expect(shouldPersistQuery(q(["voice-profile", "tenant-1"]))).toBe(false);
    expect(shouldPersistQuery(q(["voice-drafts", "tenant-1"]))).toBe(false);
    expect(shouldPersistQuery(q(["integrations", "tenant-1"]))).toBe(false);
  });

  it("does not persist loading or failed query states", () => {
    expect(
      shouldPersistQuery(
        qWithStatus(["dashboard-stats", "tenant-1"], "pending"),
      ),
    ).toBe(false);
    expect(
      shouldPersistQuery(qWithStatus(["dashboard-stats", "tenant-1"], "error")),
    ).toBe(false);
  });
});

/**
 * The encrypted Keychain blob exists for ONE job: carry writes that could not
 * reach the server across a process death. A mutation that already succeeded
 * online has no work left to resume, so persisting it buys nothing and costs a
 * chunked SecureStore write of its variables AND its `onMutate` rollback
 * context — which on this app is a snapshot of the cached list being
 * overwritten, i.e. subscriber rows, addresses and audit labels.
 */
describe("offline mutation persistence policy", () => {
  it("persists an offline-safe mutation that is PAUSED", () => {
    expect(shouldPersistMutation(m({ offlineSafe: true, isPaused: true }))).toBe(
      true,
    );
  });

  it("does NOT persist a successful online mutation, rollback snapshot and all", () => {
    expect(
      shouldPersistMutation(
        m({
          offlineSafe: true,
          isPaused: false,
          status: "success",
          context: { previous: [{ id: "sub-1", email: "person@example.com" }] },
        }),
      ),
    ).toBe(false);
  });

  it("does NOT persist an in-flight online mutation", () => {
    // Not paused means the request is on the wire right now; it will settle in
    // this process or fail visibly, and a resumed duplicate is worse than a
    // lost retry (mutations are configured retry: 0 for the same reason).
    expect(
      shouldPersistMutation(
        m({ offlineSafe: true, isPaused: false, status: "pending" }),
      ),
    ).toBe(false);
  });

  it("still refuses a paused mutation that was never marked offline-safe", () => {
    expect(shouldPersistMutation(m({ isPaused: true }))).toBe(false);
  });

  it("is the predicate the persister actually dehydrates with", () => {
    expect(queryPersistOptions.dehydrateOptions.shouldDehydrateMutation).toBe(
      shouldPersistMutation,
    );
  });
});

describe("reconnect refetch scope", () => {
  it("targets only the primary visible data domains", () => {
    // Reconnect must NOT blanket-refetch the whole app. The roots are
    // the at-a-glance domains the user is likely looking at when the
    // network returns: dashboard, campaigns, subscribers, sequences, lists.
    // `dashboard-anomalies` and `approvals` are here because both are READ ON
    // THE DASHBOARD — and the approvals count is mirrored to the home-screen
    // widget, so leaving it stale after an outage is visible outside the app.
    expect([...RECONNECT_REFETCH_QUERY_ROOTS].sort()).toEqual(
      [
        "approvals",
        "campaigns",
        "dashboard",
        "dashboard-anomalies",
        "dashboard-goals",
        "dashboard-stats",
        "lists",
        "sequences",
        "subs",
      ].sort(),
    );
  });

  it("matches the primary-domain query roots used by the app's hooks", () => {
    expect(isReconnectRefetchQuery(q(["dashboard-stats", "tenant-1"]))).toBe(
      true,
    );
    expect(isReconnectRefetchQuery(q(["dashboard", "tenant-1"]))).toBe(true);
    expect(isReconnectRefetchQuery(q(["campaigns", "tenant-1"]))).toBe(true);
    expect(isReconnectRefetchQuery(q(["subs", "tenant-1", ""]))).toBe(true);
    expect(isReconnectRefetchQuery(q(["sequences"]))).toBe(true);
    expect(isReconnectRefetchQuery(q(["lists", "tenant-1"]))).toBe(true);
  });

  it("does NOT match secondary / detail / settings query roots", () => {
    // Detail screens, audit, settings, ops and integration screens are
    // refetched on their own focus — reconnect should not stampede them.
    expect(isReconnectRefetchQuery(q(["campaign", "tenant-1", "c-1"]))).toBe(
      false,
    );
    expect(
      isReconnectRefetchQuery(q(["campaign-report", "tenant-1", "c-1"])),
    ).toBe(false);
    expect(isReconnectRefetchQuery(q(["sub", "tenant-1", "s-1"]))).toBe(false);
    expect(isReconnectRefetchQuery(q(["sequence", "tenant-1", "seq-1"]))).toBe(
      false,
    );
    expect(isReconnectRefetchQuery(q(["audit", "tenant-1", 100]))).toBe(false);
    expect(isReconnectRefetchQuery(q(["integrations", "tenant-1"]))).toBe(
      false,
    );
    expect(isReconnectRefetchQuery(q(["sending-settings", "tenant-1"]))).toBe(
      false,
    );
    expect(isReconnectRefetchQuery(q(["mobile-migrations", "tenant-1"]))).toBe(
      false,
    );
  });

  it("invalidates ONLY the primary roots — never a blanket refetch", () => {
    const calls: { predicate?: (query: Query) => boolean }[] = [];
    const fakeClient = {
      invalidateQueries: vi.fn(
        (opts: { predicate?: (q: Query) => boolean }) => {
          calls.push(opts);
          return Promise.resolve();
        },
      ),
    };

    void invalidatePrimaryDataOnReconnect(fakeClient as never);

    // Exactly one invalidate call, and it MUST carry a predicate (i.e. a
    // filter) rather than the no-arg "invalidate everything" form.
    expect(fakeClient.invalidateQueries).toHaveBeenCalledTimes(1);
    const opts = calls[0];
    expect(opts).toBeDefined();
    expect(typeof opts?.predicate).toBe("function");

    const predicate = opts!.predicate!;
    expect(predicate(q(["dashboard-stats", "tenant-1"]))).toBe(true);
    expect(predicate(q(["campaigns", "tenant-1"]))).toBe(true);
    // A non-primary domain must be left alone.
    expect(predicate(q(["audit", "tenant-1", 100]))).toBe(false);
    expect(predicate(q(["integrations", "tenant-1"]))).toBe(false);
  });
});

/**
 * DASHBOARD-V#4 — a query mounted on the dashboard that is NOT in the
 * reconnect allowlist comes back from airplane mode stale AND unmarked, sitting
 * beside five tiles that just refreshed. This walks the screen's own hook calls
 * rather than restating a list, so ADDING a query to the dashboard forces a
 * decision here instead of silently inheriting the wrong one.
 */
describe("dashboard reconnect coverage", () => {
  /** Roots deliberately left out, each with the reason it is safe. */
  const EXEMPT = new Map<string, string>([
    [
      "audit",
      "Fallback only: the stats payload carries recent_audit, so this query " +
        "does not run on a current deployment. When it does, it refetches on " +
        "screen focus — and re-fetching teammate identities on every radio " +
        "flip is a cost with no reader.",
    ],
    [
      "onboarding-progress",
      "First-run checklist. Its answer changes when the USER completes a " +
        "setup step, not when the network returns.",
    ],
    [
      "dashboard-layout",
      "Per-user card ORDER, read-only on mobile (hooks/useDashboardLayout). " +
        "It changes when somebody drags a card on desktop, not when the radio " +
        "comes back, and it is cached for 30 minutes for that reason. Nothing " +
        "on screen is stale-looking if it lags a reconnect: the tiles it " +
        "orders each refetch on their own. Pull-to-refresh refetches every " +
        "active query, so a deliberate refresh still picks up a new order.",
    ],
  ]);

  it("covers every query root the dashboard screen mounts", () => {
    const screen = readFileSync(
      resolve(process.cwd(), "app/(tabs)/dashboard.tsx"),
      "utf8",
    );
    // Per-FUNCTION, not per-file: hooks/useApprovals.ts alone defines six
    // queries, only one of which the dashboard mounts. A file-wide scan would
    // demand reconnect coverage for approval-agent-run and campaign-report,
    // which no dashboard reader ever sees.
    const bodies = new Map<string, string>();
    for (const file of sourceTree(resolve(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/export function (use[A-Z]\w+)/g)) {
        if (match[1]) bodies.set(match[1], functionBody(source, match.index));
      }
    }

    // Transitive, because the dashboard reads `usePendingApprovalsCount`,
    // which is a projection of `usePendingApprovals` one level down — and it
    // is that inner query whose key has to be covered.
    const roots = new Set<string>();
    const seen = new Set<string>();
    const queue = Array.from(
      screen.matchAll(/\b(use[A-Z]\w+)\s*\(/g),
      (m) => m[1] ?? "",
    );
    while (queue.length > 0) {
      const name = queue.shift();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const body = bodies.get(name);
      if (body === undefined) continue;
      for (const key of body.matchAll(/queryKey:\s*\[\s*"([^"]+)"/g)) {
        if (key[1]) roots.add(key[1]);
      }
      for (const call of body.matchAll(/\b(use[A-Z]\w+)\s*\(/g)) {
        if (call[1]) queue.push(call[1]);
      }
    }

    // The scan must find something, or a refactor has quietly defanged it.
    expect(roots.has("dashboard-stats")).toBe(true);
    expect(roots.has("approvals")).toBe(true);
    expect(roots.size).toBeGreaterThan(3);

    const uncovered = [...roots]
      .filter((root) => !RECONNECT_REFETCH_QUERY_ROOTS.has(root))
      .filter((root) => !EXEMPT.has(root))
      .sort();
    expect(uncovered).toEqual([]);
  });
});

/**
 * Source text of the function starting at `from`, by brace balance.
 *
 * The parameter list is skipped by PAREN balance first: several of these hooks
 * destructure an options object, so the first `{` after the name belongs to the
 * signature (`useDashboardStatsQuery({ range = "30d" }: Options = {})`) and
 * balancing from there returns the parameters instead of the body.
 */
function functionBody(source: string, from: number): string {
  const paren = source.indexOf("(", from);
  if (paren < 0) return "";
  let parens = 0;
  let afterParams = -1;
  for (let i = paren; i < source.length; i += 1) {
    if (source[i] === "(") parens += 1;
    else if (source[i] === ")") {
      parens -= 1;
      if (parens === 0) {
        afterParams = i;
        break;
      }
    }
  }
  if (afterParams < 0) return "";
  const open = source.indexOf("{", afterParams);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function sourceTree(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceTree(path);
    if (!/\.tsx?$/.test(path) || /\.(test|spec)\.tsx?$/.test(path)) return [];
    return [path];
  });
}
