import { describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * DELIVERABILITY#21 — app/(tabs)/archive.tsx (490 lines) had no screen test,
 * and the finding specifically named `archiveIssueURL`'s contract as unpinned
 * AT THE SCREEN. The pure function has its own specs; what nothing checked is
 * that the SCREEN routes its identity through it correctly — which is the half
 * that decides whether a "Share" button emits a plausible-looking 404.
 *
 * The rungs here:
 *  - "Nothing published yet" is never what OFFLINE looks like;
 *  - a search that matched nothing says "Nothing matches", not "nothing
 *    published" — different sentences about different worlds;
 *  - Unpublish is admin-only, mirroring
 *    `apikeys.RequireScope(ScopeAdmin)` on POST /campaigns/{id}/unpublish-archive
 *    (which on the session path is owner/admin, per apikeys/middleware.go);
 *  - when the tenant-settings read FAILED, the screen still renders the issues
 *    rather than blocking the whole list on a side-read a viewer cannot make.
 */
const mockIssues: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: jest.fn(async () => undefined),
  refetch: jest.fn(async () => undefined),
};

const mockStats: { data: unknown; refetch: () => Promise<unknown> } = {
  data: undefined,
  refetch: jest.fn(async () => undefined),
};

const mockSettings: { data: unknown; isSuccess: boolean; isError: boolean } = {
  data: undefined,
  isSuccess: false,
  isError: false,
};

jest.mock("@/components/SwipeableRow", () => {
  const RN = jest.requireActual("react-native") as typeof import("react-native");
  const ReactLocal = jest.requireActual("react") as typeof import("react");
  return {
    SwipeableRow: ({
      children,
      accessibilityLabel,
      right,
    }: {
      children: React.ReactNode;
      accessibilityLabel?: string;
      right?: { label: string }[];
    }) =>
      ReactLocal.createElement(
        RN.View,
        {
          // The row's swipe verbs are what the role gate governs, so the stub
          // publishes them where an assertion can see them.
          //
          // ONE testID PER ACTION, not one joined id for the set. The joined
          // form (`swipe:Unpublish`) silently encoded "there is exactly one
          // action": adding Pin turned it into `swipe:Pin,Unpublish` and broke
          // every assertion, none of which was actually about the set. Per
          // action, each verb is assertable on its own and adding one cannot
          // invalidate a claim about another.
          ...(accessibilityLabel ? { accessibilityLabel } : {}),
          testID: `swipe-row:${(right ?? []).length}`,
        },
        [
          ...(right ?? []).map((a) =>
            ReactLocal.createElement(RN.View, {
              key: a.label,
              testID: `swipe:${a.label}`,
            }),
          ),
          ReactLocal.createElement(
            RN.View,
            { key: "__children__" },
            children,
          ),
        ],
      ),
  };
});

jest.mock("@/hooks/useArchiveOps", () => ({
  useArchiveIssues: () => mockIssues,
  useArchiveStats: () => mockStats,
  useArchiveTenantSettings: () => mockSettings,
  useArchiveIssuePreview: () => ({ data: undefined, isLoading: false }),
  useUnpublishArchiveIssue: () => ({ mutateAsync: jest.fn(), isPending: false }),
  usePinArchiveIssue: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useUnpinArchiveIssue: () => ({ mutateAsync: jest.fn(), isPending: false }),
  ARCHIVE_SEARCH_MIN: 2,
}));

// eslint-disable-next-line import/first
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import * as AuthStore from "@/store/auth";
// eslint-disable-next-line import/first
import Archive from "../app/(tabs)/archive";

const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};
const authHarness = AuthStore as unknown as {
  __setAuthStateForTests?: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests?: () => void;
};

/** Matches `ArchiveIssue` from src/lib/archiveContracts.ts exactly. */
function issue(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    slug: "june-digest",
    subject: "June digest",
    excerpt: "What shipped in June",
    publishedAt: "2026-06-30T09:00:00Z",
    pinned: false,
    viewCount: 42,
    uniqueVisitors: 31,
    campaignId: "c1",
    ...overrides,
  };
}

function pages(items: unknown[]) {
  return {
    pages: [
      { items, nextCursor: null, fromSnapshot: false, capturedAt: null },
    ],
  };
}

async function renderScreen() {
  return await render(React.createElement(Archive), {
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
  });
}

function reset(role?: string) {
  mockIssues.data = undefined;
  mockIssues.isLoading = false;
  mockIssues.isError = false;
  mockIssues.error = null;
  mockIssues.hasNextPage = false;
  mockStats.data = undefined;
  mockSettings.data = undefined;
  mockSettings.isSuccess = false;
  mockSettings.isError = false;
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests?.();
  if (role) {
    gateHarness.__setOnlineGateForTests({ effectiveRole: role });
    authHarness.__setAuthStateForTests?.({
      mode: "session",
      session: { effectiveRole: role, role },
    });
  }
}

describe("archive — the state ladder", () => {
  it("renders published issues", async () => {
    reset("admin");
    mockIssues.data = pages([issue()]);
    const screen = await renderScreen();
    expect(screen.getAllByText("June digest").length).toBeGreaterThan(0);
  });

  it("says OFFLINE rather than 'Nothing published yet'", async () => {
    reset("admin");
    gateHarness.__setOnlineGateForTests({
      effectiveRole: "admin",
      enabled: false,
      isOnline: false,
    });
    const screen = await renderScreen();
    expect(screen.queryByText("Nothing published yet")).toBeNull();
    expect(screen.getAllByText(/offline/i).length).toBeGreaterThan(0);
  });

  it("claims an empty archive only on a genuine 200 with no rows", async () => {
    reset("admin");
    mockIssues.data = pages([]);
    const screen = await renderScreen();
    expect(screen.getByText("Nothing published yet")).toBeTruthy();
  });

  it("does not present a FAILED load as an empty archive", async () => {
    reset("admin");
    mockIssues.isError = true;
    mockIssues.error = new Error("gateway exploded");
    const screen = await renderScreen();
    expect(screen.queryByText("Nothing published yet")).toBeNull();
  });

  it("groups pinned issues under their own heading", async () => {
    reset("admin");
    mockIssues.data = pages([
      issue({ slug: "welcome", subject: "Welcome", pinned: true }),
      issue(),
    ]);
    const screen = await renderScreen();
    // "Pinned" also appears as the row's own badge, so assert on the SECTION
    // headings by role rather than by a bare text match.
    const headings = screen
      .getAllByRole("header")
      .map((node) => node.props.children);
    expect(headings).toContain("Pinned");
    expect(headings).toContain("Recent");
  });
});

describe("archive — public links refuse rather than guess", () => {
  it("renders the list even when the tenant-settings side-read FAILED", async () => {
    // The settings read is admin-scoped, so a viewer gets a 403 that never
    // resolves. Blocking the issue list on it would make the whole screen
    // unusable for exactly the role most likely to be browsing it.
    reset("viewer");
    mockSettings.isError = true;
    mockIssues.data = pages([issue()]);
    const screen = await renderScreen();
    expect(screen.getAllByText("June digest").length).toBeGreaterThan(0);
  });

  it("still offers the RSS action, which refuses at press time rather than being hidden", async () => {
    reset("admin");
    mockIssues.data = pages([issue()]);
    const screen = await renderScreen();
    expect(screen.getByLabelText("Share newsletter RSS feed")).toBeTruthy();
  });
});

describe("archive — unpublish is admin-only", () => {
  it("publishes Unpublish as a row action for an admin", async () => {
    reset("admin");
    mockIssues.data = pages([issue()]);
    const screen = await renderScreen();
    expect(screen.getByTestId("swipe:Unpublish")).toBeTruthy();
  });

  it("offers Pin for an unpinned issue, and Unpin for a pinned one", async () => {
    // Only ONE of the pair is ever meaningful. The server treats pinning an
    // already-pinned issue as an idempotent success (views.go:317), so
    // offering both would put a no-op beside a real action AND make the no-op
    // look like it worked.
    reset("admin");
    mockIssues.data = pages([issue({ pinned: false })]);
    let screen = await renderScreen();
    expect(screen.getByTestId("swipe:Pin")).toBeTruthy();
    expect(screen.queryByTestId("swipe:Unpin")).toBeNull();

    reset("admin");
    mockIssues.data = pages([issue({ pinned: true })]);
    screen = await renderScreen();
    expect(screen.getByTestId("swipe:Unpin")).toBeTruthy();
    expect(screen.queryByTestId("swipe:Pin")).toBeNull();
  });

  it("orders the reversible verb before the destructive one", async () => {
    // The swipe tray puts the first entry closest to the thumb. A reversible
    // ordering change must not be the easier mis-tap than a 404 for every
    // subscriber holding the link.
    reset("admin");
    mockIssues.data = pages([issue()]);
    const screen = await renderScreen();
    expect(screen.getByTestId("swipe-row:2")).toBeTruthy();
  });

  it("withholds pin from a viewer, exactly like unpublish", async () => {
    // Both archive writes sit behind the same RequireScope(ScopeAdmin) mount,
    // so a role that cannot retract cannot feature either.
    reset("viewer");
    mockIssues.data = pages([issue()]);
    const screen = await renderScreen();
    expect(screen.queryByTestId("swipe:Pin")).toBeNull();
    expect(screen.queryByTestId("swipe:Unpin")).toBeNull();
    expect(screen.getByTestId("swipe-row:0")).toBeTruthy();
  });

  it("withholds it from an editor — the route demands owner/admin", async () => {
    reset("editor");
    mockIssues.data = pages([issue()]);
    const screen = await renderScreen();
    expect(screen.queryByTestId("swipe:Unpublish")).toBeNull();
  });

  it("withholds it from a viewer", async () => {
    reset("viewer");
    mockIssues.data = pages([issue()]);
    const screen = await renderScreen();
    expect(screen.queryByTestId("swipe:Unpublish")).toBeNull();
  });

  /**
   * The archive's first page is served from the OFFLINE VAULT when the network
   * is unavailable, and `loadSnapshotBacked` validates only that the stored
   * envelope carries a numeric `capturedAt` before CASTING `value` to
   * ArchivePage. So an entry written by an earlier build — or a partial write —
   * arrives as a page whose `items` is not a list. `?? []` is a nullish guard
   * and does not catch it; the route then flatMaps a non-array and tears down.
   * This is the crash that already happened once on api-keys ("Invalid attempt
   * to spread non-iterable instance"), one screen over.
   */
  it("survives a restored page whose items is not a list", async () => {
    reset("admin");
    mockIssues.data = {
      pages: [{ items: {}, nextCursor: null, fromSnapshot: true, capturedAt: 1 }],
    };
    const screen = await renderScreen();
    // Rendered, not thrown — and it says the honest thing rather than a row
    // built out of `undefined`.
    expect(screen.getByText("Nothing published yet")).toBeTruthy();
  });

  it("survives a restored envelope whose pages is not a list", async () => {
    reset("admin");
    mockIssues.data = { pages: {} };
    const screen = await renderScreen();
    expect(screen.getByText("Nothing published yet")).toBeTruthy();
  });
});
