/**
 * AudienceSyncDeleteAction — the render contract for the one irreversible verb
 * on the audience-syncs surface.
 *
 * WHAT THIS FILE EXISTS TO CATCH. Three things, each of which would be silent:
 * a viewer offered a control the server will 403 (or, worse, told nothing about
 * why it is missing); an offline press that appears to work; and a delete whose
 * cache invalidation forgets the RUN HISTORY, which cascades server-side and
 * would otherwise outlive the rows it describes in the persisted query cache.
 * The sentences themselves are pinned in lib/audienceSyncDelete.test.ts; this
 * file proves they reach a screen and that the gates are wired to them.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AudienceSyncDeleteAction } from "@/components/audience-syncs/AudienceSyncDeleteAction";
import * as Gate from "@/hooks/useOnlineQueryGate";
import { parseSync, type AudienceSync } from "@/lib/audienceSyncs";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __resetQueryResultForTests: () => void;
  __getLastMutationOptionsForTests: () => {
    onSettled?: (data: unknown, error: unknown, variables: unknown) => void;
  } | undefined;
  __getQueryClientForTests: () => {
    invalidateQueries: { mock: { calls: unknown[][] } };
  };
};
const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
});

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

function sync(): AudienceSync {
  return parseSync({
    id: "s-1",
    name: "Warehouse mirror",
    source: { segment_id: "seg-1" },
    destination: {
      type: "webhook",
      url: "https://in.example.test/postwave",
      secret_set: true,
    },
    schedule: "daily",
    enabled: true,
    last_run_at: "2026-09-01T03:00:00Z",
    last_run_status: "failed",
  })!;
}

describe("AudienceSyncDeleteAction", () => {
  it("offers the delete to an editor, and says what goes with it", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await render(
      <AudienceSyncDeleteAction
        sync={sync()}
        runCount={3}
        online
        onDeleted={jest.fn()}
      />,
      { wrapper },
    );
    expect(screen.getByLabelText("Delete sync")).toBeTruthy();
    expect(
      screen.getByText(/every run it recorded are deleted together/i),
    ).toBeTruthy();
  });

  it("tells a viewer why the control is missing rather than showing nothing", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    await render(
      <AudienceSyncDeleteAction
        sync={sync()}
        runCount={null}
        online
        onDeleted={jest.fn()}
      />,
      { wrapper },
    );
    expect(screen.queryByLabelText("Delete sync")).toBeNull();
    expect(screen.getByText(/needs an editor role/i)).toBeTruthy();
  });

  it("disables the press offline and says a delete is never queued", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    await render(
      <AudienceSyncDeleteAction
        sync={sync()}
        runCount={0}
        online={false}
        onDeleted={jest.fn()}
      />,
      { wrapper },
    );
    expect(
      screen.getByLabelText("Delete sync").props.accessibilityState.disabled,
    ).toBe(true);
    expect(screen.getByText(/never queued/i)).toBeTruthy();
  });

  it("closes the sheet only after the server accepted the delete", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    const onDeleted = jest.fn();
    await render(
      <AudienceSyncDeleteAction
        sync={sync()}
        runCount={2}
        online
        onDeleted={onDeleted}
      />,
      { wrapper },
    );
    expect(onDeleted).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText("Delete sync"));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  it("invalidates the RUN HISTORY as well as the list — the runs cascade", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    await render(
      <AudienceSyncDeleteAction
        sync={sync()}
        runCount={2}
        online
        onDeleted={jest.fn()}
      />,
      { wrapper },
    );
    const options = queryHarness.__getLastMutationOptionsForTests();
    options?.onSettled?.(undefined, null, { syncId: "s-1" });
    const keys = queryHarness
      .__getQueryClientForTests()
      .invalidateQueries.mock.calls.map((call) =>
        JSON.stringify((call[0] as { queryKey: unknown }).queryKey),
      );
    expect(keys.some((key) => key.includes("audience-syncs"))).toBe(true);
    expect(
      keys.some((key) => key.includes("audience-sync-runs") && key.includes("s-1")),
    ).toBe(true);
  });
});
