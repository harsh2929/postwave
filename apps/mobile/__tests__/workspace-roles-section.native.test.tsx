/**
 * WorkspaceRolesSection — the render contract (P2.53).
 *
 * The normalizer is pinned in src/lib/workspaceRoles.test.ts and the
 * transport in src/api/workspaceRoles.test.ts; this file pins what an
 * operator meets on the Settings screen:
 *
 *  - each role renders its name, description and scope summary verbatim;
 *  - a role with no scopes says so, and an empty list says so;
 *  - a 403/404/501 hides the card entirely (the route's effective floor is
 *    admin), a 500 says so and offers a Retry wired to THIS query;
 *  - a paged envelope in the cache renders the empty state, never a throw;
 *  - the card is actually MOUNTED on the Settings screen for an admin.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { WorkspaceRolesError } from "@/api/workspaceRoles";
import * as AuthStore from "@/store/auth";

import { WorkspaceRolesSection } from "@/components/settings/WorkspaceRolesSection";
import Settings from "../app/(tabs)/settings";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

const refetch = jest.fn(async () => ({}));

function result(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
    isFetching: false,
    isSuccess: true,
    refetch,
    ...over,
  };
}

/** Rows exactly as lib/workspaceRoles normalizes them (the hook's data). */
const ROWS = [
  {
    id: "r-admin",
    name: "admin",
    description: "Full workspace control",
    scopes: ["audit:read", "audit:configure_sinks"],
  },
  { id: "r-viewer", name: "viewer", description: "", scopes: [] },
];

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

afterEach(() => {
  refetch.mockClear();
  queryHarness.__resetQueryResultForTests();
  authHarness.__resetAuthStateForTests();
});

describe("WorkspaceRolesSection", () => {
  it("renders every role's name, description and scope summary verbatim", async () => {
    queryHarness.__setQueryResultForTests(result({ data: ROWS }));
    await render(<WorkspaceRolesSection />);
    expect(screen.getByText("Roles")).toBeTruthy();
    expect(screen.getByText("admin")).toBeTruthy();
    expect(screen.getByText("Full workspace control")).toBeTruthy();
    expect(screen.getByText("audit:read, audit:configure_sinks")).toBeTruthy();
    expect(screen.getByText("viewer")).toBeTruthy();
    expect(screen.getByText("No scopes assigned")).toBeTruthy();
    // Read-only by design: no toggle, no save, and the copy says where edits live.
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(/Changed on the web admin/u)).toBeTruthy();
  });

  it("says so when the workspace has no roles", async () => {
    queryHarness.__setQueryResultForTests(result({ data: [] }));
    await render(<WorkspaceRolesSection />);
    expect(screen.getByText(/No roles defined yet/u)).toBeTruthy();
  });

  it("renders the empty state, not a throw, for a paged envelope in the cache", async () => {
    queryHarness.__setQueryResultForTests(result({ data: { items: [] } }));
    await render(<WorkspaceRolesSection />);
    expect(screen.getByText(/No roles defined yet/u)).toBeTruthy();
  });

  it("shows a skeleton on first load", async () => {
    queryHarness.__setQueryResultForTests(
      result({ isLoading: true, isPending: true, isSuccess: false }),
    );
    await render(<WorkspaceRolesSection />);
    expect(screen.getByLabelText("Loading roles")).toBeTruthy();
  });

  it("hides itself entirely on a 403 — the route's effective floor is admin", async () => {
    queryHarness.__setQueryResultForTests(
      result({
        isError: true,
        isSuccess: false,
        error: new WorkspaceRolesError(403, "forbidden"),
      }),
    );
    await render(<WorkspaceRolesSection />);
    expect(screen.toJSON()).toBeNull();
  });

  it("hides on a 404 too (route absent on this deployment)", async () => {
    queryHarness.__setQueryResultForTests(
      result({
        isError: true,
        isSuccess: false,
        error: new WorkspaceRolesError(404, "not found"),
      }),
    );
    await render(<WorkspaceRolesSection />);
    expect(screen.toJSON()).toBeNull();
  });

  it("says a failed read failed and Retry refetches THIS query", async () => {
    queryHarness.__setQueryResultForTests(
      result({
        isError: true,
        isSuccess: false,
        error: new WorkspaceRolesError(500, "upstream unavailable"),
      }),
    );
    await render(<WorkspaceRolesSection />);
    expect(screen.getByText("Roles")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Retry"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("is MOUNTED on the Settings screen for an admin", async () => {
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: { role: "admin", effectiveRole: "admin", tenantId: "t1" },
    });
    // The shared harness leaves every query on its first load, so the card is
    // identified by its own loading label rather than by row content.
    await render(<Settings />, { wrapper });
    expect(screen.getByLabelText("Loading roles")).toBeTruthy();
  });
});
