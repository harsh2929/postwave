/**
 * AudienceSyncExclusionSection — the render contract for the consent firewall's
 * two read surfaces inside the sync sheet.
 *
 * WHAT THIS FILE EXISTS TO CATCH. The costly failure here is a CONFIDENT ZERO:
 * the server answers -1 for every count when it could not resolve the source,
 * and a screen that renders that as "0 withheld" tells an operator the firewall
 * let everyone through. Second: the receipt lists subscriber emails and is
 * admin-only server-side, so a non-admin must be told why rather than handed a
 * button that 403s. Third: the preview is press-driven by design — it walks the
 * whole audience server-side — so it must not fire on mount.
 *
 * The sentences are pinned in lib/audienceSyncExclusions.test.ts; this file
 * proves they reach the sheet and that the gates are wired to them.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AudienceSyncExclusionSection } from "@/components/audience-syncs/AudienceSyncExclusionSection";
import * as Gate from "@/hooks/useOnlineQueryGate";
import { parseSyncExclusionPreview } from "@/lib/audienceSyncExclusions";
import {
  parseSync,
  parseSyncRunList,
  type AudienceSync,
  type AudienceSyncRun,
} from "@/lib/audienceSyncs";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
  __getQueryOptionsForTests: () => Array<{
    kind: string;
    options: { enabled?: boolean; queryKey?: unknown };
  }>;
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
    destination: { type: "meta_custom_audience" },
    schedule: "daily",
    enabled: true,
  })!;
}

function runs(excludedCount: number): readonly AudienceSyncRun[] {
  return parseSyncRunList({
    items: [
      {
        id: "run-9",
        sync_id: "s-1",
        status: "success",
        excluded_count: excludedCount,
        started_at: "2026-09-01T03:00:00Z",
        finished_at: "2026-09-01T03:00:20Z",
      },
    ],
  });
}

function settled(value: unknown) {
  return {
    data: value,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: () => Promise.resolve({ data: value }),
  };
}

describe("AudienceSyncExclusionSection", () => {
  it("does not ask the firewall until the reader asks — the query stays disabled", async () => {
    await render(
      <AudienceSyncExclusionSection sync={sync()} runs={runs(0)} online />,
      { wrapper },
    );
    expect(screen.getByLabelText("Preview who would be withheld")).toBeTruthy();
    const previewQuery = queryHarness
      .__getQueryOptionsForTests()
      .find((entry) =>
        JSON.stringify(entry.options.queryKey ?? []).includes(
          "audience-sync-exclusion-preview",
        ),
      );
    expect(previewQuery?.options.enabled).toBe(false);
  });

  it("renders the counts, labelled as a forecast, once asked", async () => {
    queryHarness.__setQueryResultForTests(
      settled(
        parseSyncExclusionPreview({
          audience_count: 1200,
          excluded_consent: 40,
          excluded_suppression: 8,
          excluded_total: 48,
          purpose: "marketing",
          computed_at: "2026-09-01T10:00:00Z",
        }),
      ),
    );
    await render(
      <AudienceSyncExclusionSection sync={sync()} runs={runs(0)} online />,
      { wrapper },
    );
    fireEvent.press(screen.getByLabelText("Preview who would be withheld"));
    expect(await screen.findByText(/48 withheld in total/)).toBeTruthy();
    expect(screen.getByText(/forecast for the next run/)).toBeTruthy();
  });

  it("says 'could not resolve' rather than rendering the -1 sentinel as zero", async () => {
    queryHarness.__setQueryResultForTests(
      settled(
        parseSyncExclusionPreview({
          audience_count: -1,
          excluded_consent: -1,
          excluded_suppression: -1,
          excluded_total: -1,
          purpose: "marketing",
          computed_at: "2026-09-01T10:00:00Z",
        }),
      ),
    );
    await render(
      <AudienceSyncExclusionSection sync={sync()} runs={runs(0)} online />,
      { wrapper },
    );
    fireEvent.press(screen.getByLabelText("Preview who would be withheld"));
    expect(await screen.findByText(/could not resolve/)).toBeTruthy();
    expect(screen.queryByText(/withheld in total/)).toBeNull();
  });

  it("offers the receipt to an admin when a run actually withheld someone", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await render(
      <AudienceSyncExclusionSection sync={sync()} runs={runs(12)} online />,
      { wrapper },
    );
    expect(screen.getByLabelText("Share the exclusion receipt")).toBeTruthy();
  });

  it("tells an editor why the receipt is missing instead of showing nothing", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await render(
      <AudienceSyncExclusionSection sync={sync()} runs={runs(12)} online />,
      { wrapper },
    );
    expect(screen.queryByLabelText("Share the exclusion receipt")).toBeNull();
    expect(screen.getByText(/needs an admin role/i)).toBeTruthy();
  });

  it("offers no receipt when no run withheld anyone — an empty CSV is not evidence", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    await render(
      <AudienceSyncExclusionSection sync={sync()} runs={runs(0)} online />,
      { wrapper },
    );
    expect(screen.queryByLabelText("Share the exclusion receipt")).toBeNull();
    expect(screen.getByText(/no receipt to share/i)).toBeTruthy();
  });

  it("refuses the preview offline rather than pretending it can be queued", async () => {
    await render(
      <AudienceSyncExclusionSection
        sync={sync()}
        runs={runs(0)}
        online={false}
      />,
      { wrapper },
    );
    expect(
      screen.getByLabelText("Preview who would be withheld").props
        .accessibilityState.disabled,
    ).toBe(true);
    expect(screen.getByText(/Reconnect to run the preview/)).toBeTruthy();
  });
});
