import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import SubscriberDuplicatesRoute, {
  ErrorBoundary as DuplicatesErrorBoundary,
} from "../app/(tabs)/subscriber-duplicates";
import { ConfirmProvider } from "../src/components/ConfirmSheet";
import { ToastProvider } from "../src/components/Toast";
import { DuplicatesScreen } from "../src/components/duplicates/DuplicatesScreen";
import { normalizeDuplicateMergePlan } from "../src/lib/duplicateMergePlan";
import { normalizeDuplicateScanPage } from "../src/lib/duplicateScan";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");

jest.mock("@/hooks/useSubscriberDuplicates", () =>
  require("./mocks/queryHooks.cjs"),
);

/**
 * The duplicate queue has five states a "does it render" test never reaches,
 * and each one is a place where the app could state something false or destroy
 * the wrong person's record:
 *
 *   ROLE    — the READS are viewer-level (RequireScope(ScopeReadReports) plus
 *             `session_minimum_role: viewer`) while `POST /api/v1/merge/apply`
 *             is owner/admin once routeauth.Middleware evaluates the manifest.
 *             An editor must get the whole queue and NO merge button.
 *   409     — a scan is serialized per tenant by an advisory lock, so
 *             `duplicate_scan_in_progress` is a fact about the workspace, not
 *             a fault, and must not render as an error.
 *   STALE   — `stale` is computed at read time; such a pair can only ever be
 *             refused, so no plan is requested and no button appears.
 *   SURVIVOR— the scan's `primary_id` is the OLDER row, a suggestion. The API
 *             accepts either direction, so the choice must be real and the
 *             confirmation must follow it.
 *   CONFIRM — the sheet has to NAME the survivor and the loser, and say the
 *             loser is closed rather than deleted, because that is what
 *             apply.go actually does.
 */

const SCAN_ID = "11111111-1111-4111-8111-111111111111";
const PRIMARY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const DUPLICATE_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const FINGERPRINT = `sha256:${"a".repeat(64)}`;

function pairWire(over: Record<string, unknown> = {}) {
  return {
    primary_id: PRIMARY_ID,
    primary_email: "ada@example.com",
    duplicate_id: DUPLICATE_ID,
    duplicate_email: "Ada@example.com",
    primary_updated_at: "2026-07-20T00:00:00Z",
    duplicate_updated_at: "2026-07-21T00:00:00Z",
    kind: "case_diff",
    confidence: 1,
    evidence: [
      {
        kind: "case_diff",
        confidence: 1,
        reason:
          "The stored email addresses normalize to the same case-insensitive value.",
      },
    ],
    stale: false,
    ...over,
  };
}

function scanWire(over: Record<string, unknown> = {}) {
  return {
    scan_id: SCAN_ID,
    status: "complete",
    subscriber_count: 4210,
    candidate_count: 1,
    created_at: "2026-07-25T09:00:00Z",
    completed_at: "2026-07-25T09:00:04Z",
    expires_at: "2099-01-01T00:00:00Z",
    complete: true,
    ...over,
  };
}

const PLAN = normalizeDuplicateMergePlan({
  primary_id: PRIMARY_ID,
  duplicate_id: DUPLICATE_ID,
  dry_run: true,
  plan: {
    tags: ["vip"],
    custom_fields: { plan: "pro" },
    status: "blocklisted",
    consent_timestamp: "2024-03-01T00:00:00Z",
    gdpr_permissions: [],
    conflicts: [
      {
        field: "status",
        primary_value: "enabled",
        duplicate_value: "blocklisted",
        resolution: "most_restrictive_wins",
      },
    ],
    preserved_on_duplicate: ["email and profile identifiers"],
  },
  events_moved: 0,
  suppressions_moved: 0,
  loser_soft_deleted: false,
  primary_updated_at: "2026-07-20T00:00:00Z",
  duplicate_updated_at: "2026-07-21T00:00:00Z",
  plan_fingerprint: FINGERPRINT,
});

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    hasNextPage: false,
    fetchNextPage: async () => undefined,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function loadScan(over: Record<string, unknown> = {}, pairs = [pairWire()]) {
  queryHooks.__setHookResultForTests(
    "useDuplicateScan",
    queryResult({
      data: normalizeDuplicateScanPage({
        scan: scanWire(over),
        pairs,
        count: pairs.length,
        complete: true,
      }),
    }),
  );
  queryHooks.__setHookResultForTests(
    "useDuplicatePairPages",
    queryResult({ data: { pages: [] } }),
  );
}

function loadPlan(plan: unknown = PLAN) {
  queryHooks.__setHookResultForTests(
    "useDuplicateMergePlan",
    queryResult({ data: plan }),
  );
}

function renderScreen(Component: React.ComponentType = DuplicatesScreen) {
  return render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(ConfirmProvider, null, React.createElement(Component)),
    ),
    {
      wrapper: ({ children }) => (
        <SafeAreaProvider
          initialMetrics={{
            frame: { height: 844, width: 390, x: 0, y: 0 },
            insets: { bottom: 34, left: 0, right: 0, top: 47 },
          }}
        >
          {children}
        </SafeAreaProvider>
      ),
    },
  );
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  authStore.__resetAuthStateForTests();
});

describe("subscriber-duplicates route file", () => {
  it("mounts the default export the router actually loads", async () => {
    loadScan();
    const result = await renderScreen(SubscriberDuplicatesRoute);
    expect(result.getByText("Duplicates")).toBeTruthy();
  });

  it("exports a route-scoped ErrorBoundary", () => {
    expect(typeof DuplicatesErrorBoundary).toBe("function");
  });
});

describe("duplicate scan header", () => {
  it("states the candidate total as a WORKSPACE total, not a sample", async () => {
    loadScan();
    const result = await renderScreen();
    expect(
      result.getByText(
        "1 candidate pair across 4,210 people. Every pair is listed — this is not a sample.",
      ),
    ).toBeTruthy();
    expect(result.getByLabelText("4,210 People scanned")).toBeTruthy();
  });

  it("renders an em-dash, not a zero, for a count the server never sent", async () => {
    loadScan({ subscriber_count: null });
    const result = await renderScreen();
    expect(result.queryByLabelText("0 People scanned")).toBeNull();
    expect(
      result.getByLabelText(
        "The server did not report how many people were scanned, People scanned",
      ),
    ).toBeTruthy();
  });

  it("says a scan is EXPIRED rather than offering merges it will refuse", async () => {
    loadScan({ expires_at: "2020-01-01T00:00:00Z" });
    const result = await renderScreen();
    expect(result.getByLabelText("This scan has expired")).toBeTruthy();
  });
});

describe("duplicate queue states", () => {
  it("treats a concurrent scan as a workspace fact, not an error", async () => {
    queryHooks.__setHookResultForTests(
      "useDuplicateScan",
      queryResult({
        isError: true,
        error: { status: 409, code: "duplicate_scan_in_progress" },
      }),
    );
    const result = await renderScreen();
    expect(result.getByText("A scan is already running")).toBeTruthy();
    expect(result.queryByText("No duplicate candidates")).toBeNull();
  });

  it("explains a 403 instead of claiming the workspace has no duplicates", async () => {
    queryHooks.__setHookResultForTests(
      "useDuplicateScan",
      queryResult({ isError: true, error: { status: 403 } }),
    );
    const result = await renderScreen();
    expect(
      result.getByText("Your session cannot read the duplicate scan"),
    ).toBeTruthy();
    expect(result.queryByText("No duplicate candidates")).toBeNull();
  });

  it("states an empty manifest as a total, because candidate_count is one", async () => {
    loadScan({ candidate_count: 0 }, []);
    const result = await renderScreen();
    expect(result.getByText("No duplicate candidates")).toBeTruthy();
  });

  it("shows the server's own reason on every row", async () => {
    loadScan();
    const result = await renderScreen();
    expect(
      result.getByText(
        "The stored email addresses normalize to the same case-insensitive value.",
      ),
    ).toBeTruthy();
  });
});

describe("merge authorization", () => {
  it("gives an EDITOR the queue and no merge control", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "editor" } });
    loadScan();
    loadPlan();
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText(/ada@example\.com and Ada@example\.com/u),
    );
    expect(
      result.getByText(
        /Merging needs an owner or admin session on this server/u,
      ),
    ).toBeTruthy();
    expect(result.queryByLabelText(/^Merge /u)).toBeNull();
  });

  it("gives an OWNER the plan and the button", async () => {
    loadScan();
    loadPlan();
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText(/ada@example\.com and Ada@example\.com/u),
    );
    expect(result.getByText("Exact server plan")).toBeTruthy();
    expect(
      result.getByLabelText("Merge Ada@example.com into ada@example.com"),
    ).toBeTruthy();
  });

  it("offers nothing for a stale pair — the server can only refuse it", async () => {
    loadScan({}, [pairWire({ stale: true })]);
    loadPlan();
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText(/ada@example\.com and Ada@example\.com/u),
    );
    expect(
      result.getByText(/changed after the scan ran, so the server will refuse/u),
    ).toBeTruthy();
    expect(result.queryByText("Exact server plan")).toBeNull();
    expect(result.queryByLabelText(/^Merge /u)).toBeNull();
  });

  it("hides the button when the plan has no replayable fingerprint", async () => {
    loadScan();
    loadPlan(
      normalizeDuplicateMergePlan({
        primary_id: PRIMARY_ID,
        duplicate_id: DUPLICATE_ID,
        dry_run: true,
        plan: { tags: [], custom_fields: {}, status: "enabled", conflicts: [], preserved_on_duplicate: [], gdpr_permissions: [] },
        primary_updated_at: "2026-07-20T00:00:00Z",
        duplicate_updated_at: "2026-07-21T00:00:00Z",
        plan_fingerprint: "",
      }),
    );
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText(/ada@example\.com and Ada@example\.com/u),
    );
    expect(
      result.getByText(/did not return a replayable plan fingerprint/u),
    ).toBeTruthy();
    expect(result.queryByLabelText(/^Merge /u)).toBeNull();
  });

  it("offers nothing under an EXPIRED scan, whose merges the server refuses", async () => {
    loadScan({ expires_at: "2020-01-01T00:00:00Z" });
    loadPlan();
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText(/ada@example\.com and Ada@example\.com/u),
    );
    expect(result.getByText(/This scan has expired/u)).toBeTruthy();
    expect(result.queryByText("Exact server plan")).toBeNull();
    expect(result.queryByLabelText(/^Merge /u)).toBeNull();
  });

  it("never offers a merge offline — it is not a queueable write", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false, isOnline: false });
    loadScan();
    loadPlan();
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText(/ada@example\.com and Ada@example\.com/u),
    );
    expect(result.queryByLabelText(/^Merge /u)).toBeNull();
  });
});

describe("the plan and the confirmation", () => {
  it("renders the resolved conflict with the survivor's value", async () => {
    loadScan();
    loadPlan();
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText(/ada@example\.com and Ada@example\.com/u),
    );
    expect(
      result.getByLabelText(
        "status: ada@example.com has enabled, Ada@example.com has blocklisted. Resolved by the stricter value wins.",
      ),
    ).toBeTruthy();
  });

  it("NAMES the survivor and says the loser is closed, not deleted", async () => {
    loadScan();
    loadPlan();
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText(/ada@example\.com and Ada@example\.com/u),
    );
    await fireEvent.press(
      result.getByLabelText("Merge Ada@example.com into ada@example.com"),
    );
    await waitFor(() =>
      expect(result.getByText("Merge these two records?")).toBeTruthy(),
    );
    const consequence = result.getByText(
      /ada@example\.com survives and keeps its address and id/u,
    );
    expect(consequence).toBeTruthy();
    expect(
      result.getByText(/kept for audit, not deleted/u),
    ).toBeTruthy();
    expect(result.getByText(/does not move back/u)).toBeTruthy();
  });

  it("sends the caller's survivor choice, not the scan's suggestion", async () => {
    const mutate = jest.fn();
    queryHooks.__setHookResultForTests("useApplyDuplicateMerge", {
      mutate,
      mutateAsync: async () => undefined,
      isPending: false,
      reset: () => undefined,
    });
    loadScan();
    loadPlan();
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText(/ada@example\.com and Ada@example\.com/u),
    );
    // Override the scan's suggestion: the SECOND record survives.
    await fireEvent.press(
      result.getByLabelText(/^Ada@example\.com survives instead/u),
    );
    expect(
      result.getByText(/You have overridden the scan's suggestion/u),
    ).toBeTruthy();
    await fireEvent.press(
      result.getByLabelText("Merge ada@example.com into Ada@example.com"),
    );
    await waitFor(() =>
      expect(result.getByText("Merge these two records?")).toBeTruthy(),
    );
    await fireEvent.press(result.getByLabelText("Merge"));
    await waitFor(() => expect(mutate).toHaveBeenCalled());
    const [payload] = mutate.mock.calls[0] as [Record<string, unknown>];
    expect(payload.survivorId).toBe(DUPLICATE_ID);
    expect(payload.loserId).toBe(PRIMARY_ID);
    expect(payload.survivorUpdatedAt).toBe("2026-07-21T00:00:00Z");
    expect(payload.loserUpdatedAt).toBe("2026-07-20T00:00:00Z");
    expect(payload.planFingerprint).toBe(FINGERPRINT);
    expect(payload.scanId).toBe(SCAN_ID);
  });

  it("sends nothing when the confirmation is cancelled", async () => {
    const mutate = jest.fn();
    queryHooks.__setHookResultForTests("useApplyDuplicateMerge", {
      mutate,
      mutateAsync: async () => undefined,
      isPending: false,
      reset: () => undefined,
    });
    loadScan();
    loadPlan();
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText(/ada@example\.com and Ada@example\.com/u),
    );
    await fireEvent.press(
      result.getByLabelText("Merge Ada@example.com into ada@example.com"),
    );
    await waitFor(() =>
      expect(result.getByText("Merge these two records?")).toBeTruthy(),
    );
    await fireEvent.press(result.getByLabelText("Cancel"));
    await waitFor(() => expect(mutate).not.toHaveBeenCalled());
  });

  it("says NOTHING WAS MERGED, with the reason, when the server refuses", async () => {
    const mutate = jest.fn(
      (
        _input: unknown,
        opts: { onError?: (error: unknown) => void } = {},
      ) => {
        opts.onError?.({ status: 409, code: "stale_review" });
      },
    );
    queryHooks.__setHookResultForTests("useApplyDuplicateMerge", {
      mutate,
      mutateAsync: async () => undefined,
      isPending: false,
      reset: () => undefined,
    });
    loadScan();
    loadPlan();
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText(/ada@example\.com and Ada@example\.com/u),
    );
    await fireEvent.press(
      result.getByLabelText("Merge Ada@example.com into ada@example.com"),
    );
    await waitFor(() =>
      expect(result.getByText("Merge these two records?")).toBeTruthy(),
    );
    await fireEvent.press(result.getByLabelText("Merge"));
    await waitFor(() =>
      expect(
        result.getByText(
          "One of these records changed while you were reviewing. Nothing was merged — re-run the scan and review the new plan.",
        ),
      ).toBeTruthy(),
    );
  });

  it("marks the row merged from the server's answer, and stops offering it", async () => {
    const applied = normalizeDuplicateMergePlan({
      primary_id: PRIMARY_ID,
      duplicate_id: DUPLICATE_ID,
      dry_run: false,
      plan: {
        tags: [],
        custom_fields: {},
        status: "blocklisted",
        conflicts: [],
        preserved_on_duplicate: [],
        gdpr_permissions: [],
      },
      events_moved: 12,
      suppressions_moved: 1,
      loser_soft_deleted: true,
      primary_updated_at: "2026-07-20T00:00:00Z",
      duplicate_updated_at: "2026-07-21T00:00:00Z",
      plan_fingerprint: FINGERPRINT,
    });
    const mutate = jest.fn(
      (
        _input: unknown,
        opts: { onSuccess?: (data: unknown) => void } = {},
      ) => {
        opts.onSuccess?.(applied);
      },
    );
    queryHooks.__setHookResultForTests("useApplyDuplicateMerge", {
      mutate,
      mutateAsync: async () => undefined,
      isPending: false,
      reset: () => undefined,
    });
    loadScan();
    loadPlan();
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText(/ada@example\.com and Ada@example\.com/u),
    );
    await fireEvent.press(
      result.getByLabelText("Merge Ada@example.com into ada@example.com"),
    );
    await waitFor(() =>
      expect(result.getByText("Merge these two records?")).toBeTruthy(),
    );
    await fireEvent.press(result.getByLabelText("Merge"));
    await waitFor(() =>
      expect(
        result.getByText("Merged into ada@example.com. 12 events moved."),
      ).toBeTruthy(),
    );
    // The row is now closed for business, and it says so rather than silently
    // vanishing — a rescan is a full workspace walk and is not worth one row.
    expect(
      result.getByLabelText(/already merged in this session/u),
    ).toBeTruthy();
  });
});

describe("paging honesty", () => {
  it("discloses the denominator when everything is loaded", async () => {
    loadScan();
    const result = await renderScreen();
    expect(
      result.getByText("Showing all 1 of 1 candidate pairs."),
    ).toBeTruthy();
  });

  it("offers more pages with the count so far, never a bare 'load more'", async () => {
    queryHooks.__setHookResultForTests(
      "useDuplicateScan",
      queryResult({
        data: normalizeDuplicateScanPage({
          scan: scanWire({ candidate_count: 40 }),
          pairs: [pairWire()],
          count: 40,
          next_cursor: "1",
        }),
      }),
    );
    queryHooks.__setHookResultForTests(
      "useDuplicatePairPages",
      queryResult({ data: { pages: [] }, hasNextPage: true }),
    );
    const result = await renderScreen();
    expect(result.getByText("Load more — 1 of 40")).toBeTruthy();
  });

  /**
   * A mounted `useInfiniteQuery` fetches its first page eagerly, so the pager
   * is not mounted until the reader asks. The FIRST press must therefore mount
   * it (which does the fetch) rather than call `fetchNextPage` on a query that
   * has no pages — which in TanStack v5 is a no-op and would look like a dead
   * button.
   */
  it("mounts the pager on the first press instead of calling fetchNextPage", async () => {
    const fetchNextPage = jest.fn(async () => undefined);
    queryHooks.__setHookResultForTests(
      "useDuplicateScan",
      queryResult({
        data: normalizeDuplicateScanPage({
          scan: scanWire({ candidate_count: 40 }),
          pairs: [pairWire()],
          count: 40,
          next_cursor: "1",
        }),
      }),
    );
    queryHooks.__setHookResultForTests(
      "useDuplicatePairPages",
      queryResult({ data: { pages: [] }, hasNextPage: false, fetchNextPage }),
    );
    const result = await renderScreen();
    await fireEvent.press(result.getByText("Load more — 1 of 40"));
    expect(fetchNextPage).not.toHaveBeenCalled();
    // And having asked, the control now follows the pager's own answer — which
    // in this fixture is "no more pages", so the denominator takes over.
    expect(
      result.getByText("Showing all 1 of 40 candidate pairs."),
    ).toBeTruthy();
  });
});
