/**
 * DELIVERABILITY#14 — the archive-comment moderation queue on a phone.
 *
 * The failure modes worth pinning here are failures of HONESTY and of
 * AUTHORISATION, not of rendering:
 *
 *   DEFAULT TAB   `PublicPost` inserts with status "visible"
 *                 (archive_comments.go:763) and there is no pre-moderation
 *                 flag, so nothing ever reaches Pending. A queue that opened
 *                 on Pending would show a reassuring empty screen while spam
 *                 sat live on a published page.
 *   ROLE          the WHOLE surface — the list read included — is mounted
 *                 behind `apikeys.RequireScope(apikeys.ScopeAdmin)`
 *                 (main.go:2924-2927), which on the session path admits
 *                 owner|admin only. A viewer must be told that, not shown an
 *                 empty queue that is really a 403.
 *   ISSUE NAMES   the moderation projection carries a campaign UUID and no
 *                 title. A truncated id must be labelled as a fallback, never
 *                 passed off as the issue's name.
 *   CAP           `ListForModeration` clamps to 200 rows with no cursor, so
 *                 "showing 200 of 640" is a real, statable condition.
 *   OFFLINE       a failed/absent fetch is an error or offline state, never
 *                 "no comments".
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import ArchiveCommentsRoute, {
  ErrorBoundary as ArchiveCommentsErrorBoundary,
} from "../app/(tabs)/archive-comments";

const queryHooks = require("./mocks/queryHooks.cjs");

jest.mock("@/hooks/useArchiveComments", () =>
  require("./mocks/queryHooks.cjs"),
);

const OWNER_GATE = {
  effectiveRole: "owner",
  tenantId: "11111111-1111-4111-8111-111111111111",
};

function comment(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    campaignId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    parentId: "",
    subscriberId: "",
    displayName: "Dana",
    body: "Buy cheap watches at example.test",
    pinned: false,
    status: "visible",
    upvotes: 0,
    downvotes: 3,
    createdAt: "2026-07-20T10:00:00Z",
    ...over,
  };
}

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

/**
 * The three verbs are MUTATIONS. The shared proxy answers the query shape for
 * anything starting with "use", whose permanent `isPending: true` would
 * disable every control on the screen and make each assertion below a test of
 * the mock. (House rule 10.)
 */
function mutationResult() {
  return {
    data: undefined,
    error: null,
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => undefined),
    reset: jest.fn(),
    variables: undefined,
  };
}

function withQueue(
  over: { items?: unknown[]; total?: number | null; titles?: Map<string, string> } = {},
) {
  queryHooks.__setOnlineGateForTests(OWNER_GATE);
  queryHooks.__setHookResultForTests("useModerateArchiveComment", mutationResult());
  queryHooks.__setHookResultForTests("usePinArchiveComment", mutationResult());
  queryHooks.__setHookResultForTests("useDeleteArchiveComment", mutationResult());
  queryHooks.__setHookResultForTests("useArchiveIssueTitles", {
    titles: over.titles ?? new Map<string, string>(),
    hasIndex: over.titles !== undefined,
  });
  queryHooks.__setHookResultForTests(
    "useArchiveCommentQueue",
    queryResult({
      data: {
        items: over.items ?? [comment()],
        total: over.total === undefined ? 1 : over.total,
      },
    }),
  );
}

function renderScreen() {
  return render(React.createElement(ArchiveCommentsRoute), {
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

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("archive-comments route file", () => {
  it("mounts the default export the router actually loads", async () => {
    withQueue();
    const screen = await renderScreen();
    expect(screen.getAllByText("Comments").length).toBeGreaterThan(0);
  });

  it("exports a route-scoped ErrorBoundary", () => {
    expect(typeof ArchiveCommentsErrorBoundary).toBe("function");
  });

  it("opens on LIVE, not Pending, and offers all four buckets", async () => {
    withQueue();
    const screen = await renderScreen();
    for (const label of ["Live", "Pending", "Hidden", "Spam"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    // The segment that is selected is the one holding public text.
    expect(screen.getByLabelText("Comment status")).toBeTruthy();
  });

  it("states that comments publish themselves — there is no approval step", async () => {
    withQueue();
    const screen = await renderScreen();
    expect(
      screen.getByText(
        /Comments publish the moment they are posted — there is no approval step yet/,
      ),
    ).toBeTruthy();
  });
});

describe("the row tells a moderator what they need before tapping", () => {
  it("names the author, quotes the text and flags an anonymous guest", async () => {
    withQueue();
    const screen = await renderScreen();
    expect(screen.getByText("Dana")).toBeTruthy();
    expect(
      screen.getByText("Buy cheap watches at example.test"),
    ).toBeTruthy();
    expect(screen.getByText("Guest")).toBeTruthy();
  });

  it("says Subscriber when the comment carries a subscriber id", async () => {
    withQueue({ items: [comment({ subscriberId: "sub-9" })] });
    const screen = await renderScreen();
    expect(screen.getByText("Subscriber")).toBeTruthy();
    expect(screen.queryByText("Guest")).toBeNull();
  });

  it("uses the archive index's title when the index has that issue", async () => {
    withQueue({
      titles: new Map([
        ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "Issue 42 — ducks"],
      ]),
    });
    const screen = await renderScreen();
    expect(screen.getByText("Issue 42 — ducks")).toBeTruthy();
  });

  it("labels a truncated id as a fallback rather than passing it off as a title", async () => {
    withQueue();
    const screen = await renderScreen();
    expect(screen.getByText("Issue aaaaaa…eeeeee")).toBeTruthy();
    expect(
      screen.getByText(
        "Issue names come from your archive index, which hasn't loaded — rows show the issue id instead.",
      ),
    ).toBeTruthy();
  });

  it("speaks the compacted vote score in full", async () => {
    withQueue();
    const screen = await renderScreen();
    expect(
      screen.getByLabelText(/-3 · 0 up, 3 down/),
    ).toBeTruthy();
  });
});

describe("authorization", () => {
  it("names the missing role instead of rendering an empty queue over a 403", async () => {
    // The whole surface is ScopeAdmin, so a viewer cannot even LIST.
    withQueue();
    queryHooks.__setOnlineGateForTests({ effectiveRole: "viewer" });
    const screen = await renderScreen();
    expect(screen.getByText("Needs an owner or admin session")).toBeTruthy();
    expect(
      screen.getByText(
        "Comment moderation is admin-only on the server, so this queue can't be loaded or acted on with your role.",
      ),
    ).toBeTruthy();
  });

  it("says nothing about roles for an owner", async () => {
    withQueue();
    const screen = await renderScreen();
    expect(screen.queryByText("Needs an owner or admin session")).toBeNull();
  });
});

describe("honesty about what the server returned", () => {
  it("states the 200-row cap when the total is bigger than the page", async () => {
    withQueue({ items: [comment()], total: 640 });
    const screen = await renderScreen();
    expect(
      screen.getByText(/Showing the 1 newest of 640/),
    ).toBeTruthy();
  });

  it("makes no claim about the cap when the envelope carried no total", async () => {
    withQueue({ items: [comment()], total: null });
    const screen = await renderScreen();
    expect(screen.queryByText(/Showing the/)).toBeNull();
  });

  it("distinguishes offline from 'no comments on your issues'", async () => {
    queryHooks.__setOnlineGateForTests({
      ...OWNER_GATE,
      enabled: false,
      isOnline: false,
    });
    queryHooks.__setHookResultForTests(
      "useArchiveCommentQueue",
      queryResult({}),
    );
    queryHooks.__setHookResultForTests("useArchiveIssueTitles", {
      titles: new Map<string, string>(),
      hasIndex: false,
    });
    const screen = await renderScreen();
    expect(screen.queryByText("No comments on your issues yet")).toBeNull();
    expect(
      screen.getByText(/taking a comment down wouldn't reach your published issue/),
    ).toBeTruthy();
  });

  it("renders a real empty state when the workspace genuinely has none", async () => {
    withQueue({ items: [], total: 0 });
    const screen = await renderScreen();
    expect(screen.getByText("No comments on your issues yet")).toBeTruthy();
  });

  it("keeps a failed read an error, never an empty list", async () => {
    queryHooks.__setOnlineGateForTests(OWNER_GATE);
    queryHooks.__setHookResultForTests("useArchiveIssueTitles", {
      titles: new Map<string, string>(),
      hasIndex: false,
    });
    queryHooks.__setHookResultForTests(
      "useArchiveCommentQueue",
      queryResult({ isError: true, error: { status: 500 } }),
    );
    const screen = await renderScreen();
    expect(screen.queryByText("No comments on your issues yet")).toBeNull();
  });
});
