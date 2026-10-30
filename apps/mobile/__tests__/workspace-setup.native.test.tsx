/**
 * SHELL#24 — the Slack workspace grant and the sample-data seeder in Settings.
 *
 * What these assert is not "it renders". It is the three things that are wrong
 * on every first version of a status card:
 *
 *   1. a role gate that mirrors the Go handler, so a viewer is never shown a
 *      control whose only possible answer is 403;
 *   2. absence rendered as absence — a connection with no default channel and
 *      a seed marker with no counts are both real server responses, and "#"
 *      or "0" would each be a lie;
 *   3. a failed availability probe reported as "couldn't check", never as
 *      "your deployment has no Slack app", which would send an operator to
 *      change env vars for no reason.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * The shared react-query mock returns ONE global result for every useQuery, so
 * a screen with two independent reads (the connection and the availability
 * probe) cannot be exercised through it. This one runs the real queryFn per
 * key, which is what makes the api-module mock below the actual seam.
 */
jest.mock("@tanstack/react-query", () => {
  const react = require("react") as typeof import("react");
  return {
    useQuery: ({
      queryKey,
      queryFn,
      enabled,
    }: {
      queryKey: unknown[];
      queryFn: () => Promise<unknown>;
      enabled?: boolean;
    }) => {
      const [state, setState] = react.useState<{
        data: unknown;
        isLoading: boolean;
        isError: boolean;
        error: unknown;
      }>({ data: undefined, isLoading: true, isError: false, error: null });
      const key = JSON.stringify(queryKey);
      react.useEffect(() => {
        if (enabled === false) return;
        let alive = true;
        void Promise.resolve()
          .then(queryFn)
          .then(
            (data) => {
              if (alive) {
                setState({ data, isLoading: false, isError: false, error: null });
              }
            },
            (error) => {
              if (alive) {
                setState({
                  data: undefined,
                  isLoading: false,
                  isError: true,
                  error,
                });
              }
            },
          );
        return () => {
          alive = false;
        };
      }, [key, enabled]);
      return {
        ...state,
        isFetching: false,
        isSuccess: !state.isLoading && !state.isError,
        refetch: jest.fn(),
      };
    },
    useQueryClient: () => ({
      invalidateQueries: jest.fn(async () => undefined),
    }),
    useMutation: () => ({
      isPending: false,
      mutate: jest.fn(),
      mutateAsync: jest.fn(async () => ({})),
    }),
  };
});

type Result = { data?: unknown; error?: unknown };

const api: {
  connection: Result;
  availability: Result;
  sample: Result;
  disconnected: number;
  seeded: number;
  removed: number;
} = {
  connection: { data: { connected: false } },
  availability: { data: { requires_session: true, configured: true } },
  sample: { data: { seeded: false } },
  disconnected: 0,
  seeded: 0,
  removed: 0,
};

jest.mock("@/api/workspaceSetup", () => ({
  getSlackWorkspaceConnection: async () => api.connection,
  getSlackAvailability: async () => api.availability,
  getSampleDataStatus: async () => api.sample,
  disconnectSlackWorkspace: async () => {
    api.disconnected += 1;
    return { data: { ok: true, deleted: true } };
  },
  seedSampleData: async () => {
    api.seeded += 1;
    return { data: { seeded: true, counts: {} } };
  },
  removeSampleData: async () => {
    api.removed += 1;
    return { data: { removed: true, counts: {} } };
  },
}));

import { WorkspaceSetupSection } from "@/components/settings/WorkspaceSetupSection";

/** The auth-store mock's role lever. Required through the mock's own path
 *  because the real module has no test hooks to declare. */
const authStore = require("./mocks/authStore.cjs") as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

function wrap(node: React.ReactElement) {
  return render(node, {
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

beforeEach(() => {
  authStore.__resetAuthStateForTests();
  api.connection = { data: { connected: false } };
  api.availability = { data: { requires_session: true, configured: true } };
  api.sample = { data: { seeded: false } };
  api.disconnected = 0;
  api.seeded = 0;
  api.removed = 0;
});

describe("Slack workspace card", () => {
  it("shows the workspace, its channel and a revoke verb when connected", async () => {
    api.connection = {
      data: {
        connected: true,
        slack_team_id: "T0123",
        slack_team_name: "Acme HQ",
        default_channel_name: "approvals",
        created_at: "2026-05-04T09:00:00Z",
      },
    };
    await wrap(<WorkspaceSetupSection />);

    expect(await screen.findByText("Acme HQ")).toBeTruthy();
    expect(screen.getByText("#approvals")).toBeTruthy();
    expect(screen.getByTestId("slack-workspace-disconnect")).toBeTruthy();
  });

  it("renders a missing default channel as an em-dash, never as '#'", async () => {
    // The Go query COALESCEs both channel columns to '', so this is what a
    // connection with no default channel actually looks like on the wire.
    api.connection = {
      data: {
        connected: true,
        slack_team_name: "Acme HQ",
        default_channel_id: "",
        default_channel_name: "",
      },
    };
    await wrap(<WorkspaceSetupSection />);

    expect(await screen.findByText("Acme HQ")).toBeTruthy();
    expect(screen.queryByText("#")).toBeNull();
    // Channel AND connected-at are both unknown here.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("revokes the grant through the DELETE route", async () => {
    api.connection = { data: { connected: true, slack_team_name: "Acme HQ" } };
    await wrap(<WorkspaceSetupSection />);

    await fireEvent.press(
      await screen.findByTestId("slack-workspace-disconnect"),
    );
    expect(api.disconnected).toBe(1);
  });

  it("offers a browser hand-off rather than a Connect button that cannot work", async () => {
    await wrap(<WorkspaceSetupSection />);

    expect(await screen.findByText(/signed-in browser/i)).toBeTruthy();
    expect(
      screen.getByLabelText("Connect Slack on the web admin"),
    ).toBeTruthy();
    expect(screen.queryByTestId("slack-workspace-disconnect")).toBeNull();
  });

  it("never turns a failed availability probe into 'no Slack app configured'", async () => {
    api.availability = { error: { status: 503, message: "unavailable" } };
    await wrap(<WorkspaceSetupSection />);

    expect(await screen.findByText(/Couldn't check whether Slack/i)).toBeTruthy();
    expect(screen.queryByText(/on any device/i)).toBeNull();
  });

  it("says no device can connect when the deployment has no Slack app", async () => {
    api.availability = { data: { requires_session: true, configured: false } };
    await wrap(<WorkspaceSetupSection />);

    expect(await screen.findByText(/on any device/i)).toBeTruthy();
  });
});

describe("sample data card", () => {
  it("distinguishes a marker with no counts from a seed that created nothing", async () => {
    api.sample = { data: { seeded: true } };
    await wrap(<WorkspaceSetupSection />);

    expect(await screen.findByText("Sample data loaded")).toBeTruthy();
    expect(screen.getByText("Rows seeded")).toBeTruthy();
    // The count is unknown, so it is a dash — "0 rows seeded" would claim the
    // seeder produced nothing.
    expect(screen.queryByText("0")).toBeNull();
  });

  it("lists what was actually seeded and offers the remove verb", async () => {
    api.sample = {
      data: {
        seeded: true,
        seeded_at: "2026-07-01T12:00:00Z",
        counts: {
          subscribers: 50,
          lists: 0,
          segments: 2,
          campaigns: 3,
          sequences: 1,
        },
      },
    };
    await wrap(<WorkspaceSetupSection />);

    expect(await screen.findByText("56")).toBeTruthy();
    expect(screen.getByText("Subscribers")).toBeTruthy();
    // A resource with zero rows is not listed at all.
    expect(screen.queryByText("Lists")).toBeNull();

    await fireEvent.press(screen.getByTestId("sample-data-action"));
    expect(api.removed).toBe(1);
    expect(api.seeded).toBe(0);
  });

  it("seeds an empty workspace from the same single button", async () => {
    await wrap(<WorkspaceSetupSection />);

    const button = await screen.findByTestId("sample-data-action");
    expect(button).toHaveTextContent("Load sample data");
    await fireEvent.press(button);
    expect(api.seeded).toBe(1);
  });
});

describe("role gating mirrors the Go handlers", () => {
  it("hides the whole Slack card from a viewer, because both its verbs are admin", async () => {
    // collaboration_integrations.go:42-43 wraps GET *and* DELETE in
    // RequireScope(ScopeAdmin) — a viewer would only ever see a 403.
    authStore.__setAuthStateForTests({ session: { effectiveRole: "viewer" } });
    await wrap(<WorkspaceSetupSection />);

    expect(await screen.findByText("Sample data")).toBeTruthy();
    expect(screen.queryByText("Slack workspace")).toBeNull();
  });

  it("shows a viewer the sample-data truth but no button that would 403", async () => {
    // GET /api/v1/onboarding/sample-data is mounted with no scope wrapper
    // (main.go:4398); POST and DELETE are ScopeAdmin.
    authStore.__setAuthStateForTests({ session: { effectiveRole: "viewer" } });
    api.sample = { data: { seeded: true, counts: { subscribers: 4 } } };
    await wrap(<WorkspaceSetupSection />);

    expect(await screen.findByText("Sample data loaded")).toBeTruthy();
    expect(screen.getByText(/needs an owner or admin/i)).toBeTruthy();
    expect(screen.queryByTestId("sample-data-action")).toBeNull();
  });

  it("treats an api-key session as a viewer, because a key's scopes are unknowable here", async () => {
    authStore.__setAuthStateForTests({ mode: "api_key" });
    await wrap(<WorkspaceSetupSection />);

    expect(await screen.findByText("Sample data")).toBeTruthy();
    expect(screen.queryByText("Slack workspace")).toBeNull();
    expect(screen.queryByTestId("sample-data-action")).toBeNull();
  });
});
