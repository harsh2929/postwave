/**
 * Settings — the two claims the screen makes that nothing else can check.
 *
 * 1. PULL-TO-REFRESH MEANS THE SCREEN, NOT TWO SWITCHES. Settings hosts about
 *    twenty server-backed sections (workspace, notifications, retention,
 *    outbound webhooks, devices, passkeys, privacy requests, exports, plan),
 *    every one of them its own TanStack query. Its `onRefresh` re-read the push
 *    token and the telemetry opt-out and nothing else, so a deliberate pull
 *    refreshed two device values and left every row the operator was actually
 *    looking at exactly as stale as it was. The dashboard already settled the
 *    idiom (`refetchQueries({ type: "active" })`, hooks/useDashboardRefresh);
 *    this pins that Settings uses it too.
 *
 * 2. THE ROLE FLOOR IS THE SERVER'S. Every workspace-administration section is
 *    behind `canAccessMobileCapability(..., "admin")` because the endpoints
 *    are, so a viewer must see the explanation rather than controls that are a
 *    guaranteed 403 — and an admin must see the sections.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { act, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as AuthStore from "@/store/auth";

import Settings from "../app/(tabs)/settings";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __resetQueryResultForTests: () => void;
};
const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  authHarness.__resetAuthStateForTests();
});

interface HostLike {
  type: string;
  props: {
    refreshControl?: { props: { onRefresh: () => unknown } } | undefined;
  };
}

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

describe("the settings screen refresh gesture", () => {
  it("refetches the sections, not just the device switches", async () => {
    // The mocked module hands every caller one client object, so the screen's
    // own `useQueryClient()` and this one are the same instance.
    const client = ReactQuery.useQueryClient() as unknown as {
      refetchQueries: { mock: { calls: unknown[][] } };
    };
    client.refetchQueries.mock.calls.length = 0;

    const view = await render(<Settings />, { wrapper });

    // RNTL 14 dropped the UNSAFE_ queries, so the gesture is reached through
    // the host tree: exactly one element in Settings carries a refreshControl.
    const [scroll] = (
      view.root as unknown as {
        queryAll: (p: (el: HostLike) => boolean) => HostLike[];
      }
    ).queryAll((el) => Boolean(el.props?.refreshControl));
    // The handler flips `refreshing` on both edges, so the state updates it
    // schedules belong inside act or React warns and the assertion below runs
    // against a half-committed tree.
    await act(async () => {
      await scroll?.props.refreshControl?.props.onRefresh();
    });

    expect(client.refetchQueries.mock.calls.length).toBeGreaterThan(0);
    expect(client.refetchQueries.mock.calls[0]?.[0]).toEqual({
      type: "active",
    });
  });
});

describe("the settings workspace-administration floor", () => {
  it("hides workspace policy from a viewer and says why", async () => {
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: {
        email: "viewer@example.com",
        role: "viewer",
        effectiveRole: "viewer",
        tenantId: "t1",
        authProvider: "password",
        emailVerified: true,
      },
    });

    await render(<Settings />, { wrapper });

    expect(
      screen.getByText(/Administrative controls are hidden for this workspace/),
    ).toBeTruthy();
    expect(screen.queryByText("Outbound webhooks")).toBeNull();
    expect(screen.queryByText("Data retention")).toBeNull();
  });

  it("offers them to an admin", async () => {
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: {
        email: "admin@example.com",
        role: "admin",
        effectiveRole: "admin",
        tenantId: "t1",
        authProvider: "password",
        emailVerified: true,
      },
    });

    await render(<Settings />, { wrapper });

    expect(
      screen.queryByText(
        /Administrative controls are hidden for this workspace/,
      ),
    ).toBeNull();
    expect(screen.getByText("Outbound webhooks")).toBeTruthy();
    expect(screen.getByText("Data retention")).toBeTruthy();
  });
});
