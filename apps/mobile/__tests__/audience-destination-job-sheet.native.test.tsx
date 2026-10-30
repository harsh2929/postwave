/**
 * P2.41 / P2.42 — the two GESTURES the destination sync-history sheet exists
 * for, exercised as presses rather than as rendered labels.
 *
 * The sibling suite (audience-destinations.native.test.tsx) pins that the
 * tap-through is OFFERED on a failed job and that an opened job renders the
 * provider's verdict; what it never pressed is the row itself. A button whose
 * handler forgot the job id would pass every one of those assertions and open
 * nothing. Likewise sync-now was asserted present, never pressed through the
 * panel where the offline refusal and the outcome sentence actually live.
 *
 * The panel renders inside a real ToastProvider here because the two things
 * a sync-now press produces are toasts: the pre-confirm refusal, and the
 * outcome read off the returned status (never off the promise resolving).
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ToastProvider } from "@/components/Toast";
import { AudienceDestinationsPanel } from "@/components/integrations/AudienceDestinationsPanel";
import {
  DestinationSyncJobsSheet,
  type DestinationSyncJobsSheetProps,
} from "@/components/integrations/DestinationSyncJobsSheet";
import * as Online from "@/hooks/useIsOnline";
import * as Gate from "@/hooks/useOnlineQueryGate";
import { diagnosticsErrorMessage } from "@/lib/audienceDestinationJobSheet";
import type {
  AudienceDestination,
  DestinationSyncJob,
} from "@/lib/audienceDestinationRows";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};
const onlineHarness = Online as unknown as {
  __setIsOnlineForTests: (value: boolean) => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  // Also clears the useIsOnline override — same proxy module.
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
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
  );
}

function destination(
  overrides: Partial<AudienceDestination> = {},
): AudienceDestination {
  return {
    id: "d1",
    provider: "meta",
    status: "error",
    listId: "l1",
    segmentId: null,
    externalAudienceId: "ext-9",
    lastSyncedAt: "2026-08-18T10:00:00Z",
    updatedAt: null,
    ...overrides,
  };
}

function job(overrides: Partial<DestinationSyncJob> = {}): DestinationSyncJob {
  return {
    id: "j1",
    status: "failed",
    error: "429 from provider",
    membersSynced: 0,
    startedAt: "2026-08-18T10:00:00Z",
    finishedAt: "2026-08-18T10:00:09Z",
    ...overrides,
  };
}

const NOW = new Date("2026-08-18T10:05:00Z").getTime();

function sheetQuery(overrides: Record<string, unknown> = {}) {
  return {
    isError: false,
    isLoading: false,
    isFetching: false,
    isSuccess: true,
    error: null,
    ...overrides,
  };
}

function sheetProps(
  overrides: Partial<DestinationSyncJobsSheetProps> = {},
): DestinationSyncJobsSheetProps {
  return {
    destination: destination(),
    jobs: [job()],
    jobsQuery: sheetQuery(),
    gate: { enabled: true },
    now: NOW,
    onClose: () => undefined,
    syncNow: undefined,
    preview: {
      requested: false,
      onRequest: jest.fn(),
      data: null,
      query: sheetQuery(),
    },
    diagnostics: {
      openJobId: null,
      onToggleJob: jest.fn(),
      data: null,
      query: sheetQuery(),
      errorMessage: null,
    },
    ...overrides,
  };
}

function settled(value: unknown) {
  return {
    data: value,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: value })),
  };
}

function panelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1",
    provider: "meta",
    status: "error",
    listId: "l1",
    segmentId: null,
    externalAudienceId: "ext-9",
    lastSyncedAt: "2026-08-18T10:00:00Z",
    updatedAt: null,
    ...overrides,
  };
}

function session(role: string, online: boolean) {
  gateHarness.__setOnlineGateForTests({
    enabled: true,
    tenantId: "t1",
    effectiveRole: role,
  });
  onlineHarness.__setIsOnlineForTests(online);
}

describe("P2.42 — tap-through from a failed job row", () => {
  it("a press on a failed job asks for THAT job's diagnostics", async () => {
    const onToggleJob = jest.fn();
    await render(
      <DestinationSyncJobsSheet
        {...sheetProps({
          jobs: [job(), job({ id: "j2", error: "provider 500" })],
          diagnostics: {
            openJobId: null,
            onToggleJob,
            data: null,
            query: sheetQuery(),
            errorMessage: null,
          },
        })}
      />,
      { wrapper },
    );
    const asks = screen.getAllByLabelText("Ask the provider why");
    expect(asks).toHaveLength(2);
    fireEvent.press(asks[1]!);
    expect(onToggleJob).toHaveBeenCalledTimes(1);
    expect(onToggleJob).toHaveBeenCalledWith("j2");
  });

  it("the open job offers to hide, and that press names the same job", async () => {
    const onToggleJob = jest.fn();
    await render(
      <DestinationSyncJobsSheet
        {...sheetProps({
          diagnostics: {
            openJobId: "j1",
            onToggleJob,
            data: null,
            query: sheetQuery(),
            errorMessage: null,
          },
        })}
      />,
      { wrapper },
    );
    expect(screen.queryByLabelText("Ask the provider why")).toBeNull();
    fireEvent.press(screen.getByLabelText("Hide provider diagnostics"));
    expect(onToggleJob).toHaveBeenCalledWith("j1");
  });

  it("says it is still asking while the provider has not answered", async () => {
    await render(
      <DestinationSyncJobsSheet
        {...sheetProps({
          diagnostics: {
            openJobId: "j1",
            onToggleJob: jest.fn(),
            data: null,
            query: sheetQuery({ isSuccess: false, isLoading: true }),
            errorMessage: null,
          },
        })}
      />,
      { wrapper },
    );
    expect(screen.getByText("Asking the provider…")).toBeTruthy();
  });

  it("an unclassified failure gets the ordinary presentation, never a blank", async () => {
    // The panel builds this sentence with lib/audienceDestinationJobSheet;
    // the literal is errorCopy's generic 5xx line, pinned here so a regression
    // to "" (which the sheet would render as an empty answer) is caught.
    const error = Object.assign(new Error("boom"), { status: 500 });
    await render(
      <DestinationSyncJobsSheet
        {...sheetProps({
          diagnostics: {
            openJobId: "j1",
            onToggleJob: jest.fn(),
            data: null,
            query: sheetQuery({ isError: true, isSuccess: false, error }),
            errorMessage: diagnosticsErrorMessage(error),
          },
        })}
      />,
      { wrapper },
    );
    expect(
      screen.getByText(
        "The server had a problem with this request. Please try again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("boom")).toBeNull();
  });
});

describe("P2.41 — sync-now pressed through the panel", () => {
  it("an offline press is refused with the reason before any confirm", async () => {
    session("editor", false);
    queryHarness.__setQueryResultForTests(settled([panelRow()]));
    await render(<AudienceDestinationsPanel />, { wrapper });
    fireEvent.press(screen.getByLabelText("Sync history for meta"));
    const syncNow = await screen.findByLabelText("Sync now");
    // The press runs an async handler that ends in a toast state update, so
    // it is flushed inside act — same as commerce-connection-actions does.
    await act(async () => {
      fireEvent.press(syncNow);
    });
    expect(
      await screen.findByText(/You're offline, so meta can't be pushed/u),
    ).toBeTruthy();
    // No outcome sentence: nothing was sent and nothing was reported as sent.
    expect(screen.queryByText(/The push to meta/u)).toBeNull();
  });

  it("an online press reaches the mutation and reports the RETURNED status", async () => {
    // The harness's mutateAsync resolves to `{}` — an HTTP-level success with
    // no status. That must read as a failure, never as a delivery: the promise
    // resolving is not the outcome.
    session("editor", true);
    queryHarness.__setQueryResultForTests(settled([panelRow()]));
    await render(<AudienceDestinationsPanel />, { wrapper });
    fireEvent.press(screen.getByLabelText("Sync history for meta"));
    const syncNow = await screen.findByLabelText("Sync now");
    await act(async () => {
      fireEvent.press(syncNow);
    });
    expect(await screen.findByText("The push to meta failed.")).toBeTruthy();
    expect(screen.queryByText(/Pushed .* to meta/u)).toBeNull();
    expect(screen.queryByText(/You're offline/u)).toBeNull();
  });
});
