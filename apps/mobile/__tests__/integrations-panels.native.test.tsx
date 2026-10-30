import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * The four self-hiding panels on the integrations tab, pinned at the one place
 * their honesty rule lives.
 *
 * Each panel is written to disappear when it has no rows, which is right: a
 * workspace with no CRM connection should not be shown an empty heading. But
 * every one of them derived "no rows" from `query.data ?? []` — and that is
 * ALSO what a failed fetch leaves behind. So a 500 removed the whole section
 * from the screen, and an operator who opened the tab to check whether a sync
 * was paused read the absence as the answer: there are none.
 *
 * These tests assert the three-way split each panel must now make:
 *   FAILED  → a visible, named failure notice.
 *   EMPTY   → nothing at all (the panel genuinely has no rows).
 *   LOADED  → the rows.
 */

const idleMutation = () => ({
  isPending: false,
  mutate: jest.fn(),
  mutateAsync: jest.fn(),
});
/** A settled, empty read — enough for a panel that only mounts the hook. */
const idleQuery = () => ({
  data: [],
  error: null,
  isError: false,
  isFetching: false,
  isLoading: false,
  isPending: false,
  isSuccess: true,
  refetch: jest.fn(),
});
/**
 * A DISABLED read, which is the honest resting shape for the two press-driven
 * destination queries: neither the membership preview nor a job's diagnostics
 * runs until the reader opens the sheet and asks, so `enabled` is false on the
 * render these tests exercise. TanStack v5 reports a never-run query as
 * pending with no data — copying `idleQuery`'s settled/`isSuccess` shape here
 * would tell the panel a preview had come back empty, which is a different
 * claim from "not asked for yet".
 */
const disabledQuery = () => ({
  data: undefined,
  error: null,
  isError: false,
  isFetching: false,
  isLoading: false,
  isPending: true,
  isSuccess: false,
  refetch: jest.fn(),
});

jest.mock("@/hooks/useChatIntegrations", () => ({
  useChatChannels: jest.fn(),
  useTestChatChannel: jest.fn(() => ({ isPending: false, mutate: jest.fn() })),
  useSetChatChannelActive: jest.fn(() => ({
    isPending: false,
    mutate: jest.fn(),
  })),
}));
jest.mock("@/hooks/useCrmIntegrations", () => ({
  useCrmIntegrations: jest.fn(),
  useRunCrmVerb: jest.fn(() => ({ isPending: false, mutate: jest.fn() })),
}));
jest.mock("@/hooks/useConnectionFamily", () => ({
  useConnectionFamily: jest.fn(),
  useRunConnectionVerb: jest.fn(() => ({ isPending: false, mutate: jest.fn() })),
}));
jest.mock("@/hooks/useAudienceDestinations", () => ({
  useAudienceDestinations: jest.fn(),
  useSetDestinationStatus: jest.fn(() => ({
    isPending: false,
    mutate: jest.fn(),
  })),
  useDisconnectDestination: jest.fn(() => ({
    isPending: false,
    mutate: jest.fn(),
  })),
  // Mounted unconditionally by the panel (hooks cannot sit behind its early
  // returns), so it must answer even in the tests that never open the sheet.
  useDestinationSyncJobs: jest.fn(),
  // Same rule, three later arrivals: the panel calls all three on every render
  // even though the preview and the diagnostics only FETCH once the sheet is
  // open and the reader asks.
  useDestinationPreview: jest.fn(),
  useDestinationJobDiagnostics: jest.fn(),
  useSyncDestinationNow: jest.fn(),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const chatHooks = require("@/hooks/useChatIntegrations");
const crmHooks = require("@/hooks/useCrmIntegrations");
const familyHooks = require("@/hooks/useConnectionFamily");
const destinationHooks = require("@/hooks/useAudienceDestinations");

// `clearMocks: true` wipes call history before every test; the verb hooks must
// still hand back a usable mutation object or the panels throw on render.
beforeEach(() => {
  chatHooks.useTestChatChannel.mockImplementation(idleMutation);
  chatHooks.useSetChatChannelActive.mockImplementation(idleMutation);
  crmHooks.useRunCrmVerb.mockImplementation(idleMutation);
  familyHooks.useRunConnectionVerb.mockImplementation(idleMutation);
  destinationHooks.useSetDestinationStatus.mockImplementation(idleMutation);
  destinationHooks.useDisconnectDestination.mockImplementation(idleMutation);
  destinationHooks.useDestinationSyncJobs.mockImplementation(idleQuery);
  destinationHooks.useDestinationPreview.mockImplementation(disabledQuery);
  destinationHooks.useDestinationJobDiagnostics.mockImplementation(
    disabledQuery,
  );
  destinationHooks.useSyncDestinationNow.mockImplementation(idleMutation);
});

// eslint-disable-next-line import/first
import { ConfirmProvider } from "@/components/ConfirmSheet";
// eslint-disable-next-line import/first
import { ToastProvider } from "@/components/Toast";
// eslint-disable-next-line import/first
import { AudienceDestinationsPanel } from "@/components/integrations/AudienceDestinationsPanel";
// eslint-disable-next-line import/first
import { ChatChannelPanel } from "@/components/integrations/ChatChannelPanel";
// eslint-disable-next-line import/first
import { ConnectionFamilyPanel } from "@/components/integrations/ConnectionFamilyPanel";
// eslint-disable-next-line import/first
import { CrmLifecyclePanel } from "@/components/integrations/CrmLifecyclePanel";

/** The real useQuery result shape, so every branch a panel reads exists. */
function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    refetch: jest.fn(),
    ...over,
  };
}

function wrap(node: React.ReactElement) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <ConfirmProvider>{node}</ConfirmProvider>
      </ToastProvider>
    </SafeAreaProvider>,
  );
}

describe("a failed panel read is never rendered as an absence", () => {
  it("ChatChannelPanel names the failure instead of vanishing", async () => {
    chatHooks.useChatChannels.mockReturnValue(
      queryResult({ isError: true, error: new Error("500") }),
    );
    const screen = await wrap(<ChatChannelPanel />);
    expect(screen.getByText(/Couldn't load alert channels/)).toBeTruthy();
    // The heading survives, so the section is still findable on the screen.
    expect(screen.getByText("Alert channels")).toBeTruthy();
  });

  it("CrmLifecyclePanel names the failure instead of vanishing", async () => {
    crmHooks.useCrmIntegrations.mockReturnValue(
      queryResult({ isError: true, error: new Error("500") }),
    );
    const screen = await wrap(<CrmLifecyclePanel />);
    expect(screen.getByText(/Couldn't load CRM connections/)).toBeTruthy();
  });

  it("ConnectionFamilyPanel names the failure instead of vanishing", async () => {
    familyHooks.useConnectionFamily.mockReturnValue(
      queryResult({ isError: true, error: new Error("500") }),
    );
    const screen = await wrap(<ConnectionFamilyPanel family="writeback" />);
    expect(screen.getByText(/Couldn't load /)).toBeTruthy();
  });

  it("AudienceDestinationsPanel names the failure instead of vanishing", async () => {
    destinationHooks.useAudienceDestinations.mockReturnValue(
      queryResult({ isError: true, error: new Error("500") }),
    );
    const screen = await wrap(<AudienceDestinationsPanel />);
    expect(screen.getByText(/Couldn't load audience destinations/)).toBeTruthy();
  });
});

describe("a genuinely empty panel still renders nothing", () => {
  it("ChatChannelPanel stays hidden on a SUCCESSFUL empty read", async () => {
    chatHooks.useChatChannels.mockReturnValue(queryResult({ data: [] }));
    const screen = await wrap(<ChatChannelPanel />);
    expect(screen.queryByText("Alert channels")).toBeNull();
    // And it must not have invented a failure either.
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("CrmLifecyclePanel stays hidden on a SUCCESSFUL empty read", async () => {
    crmHooks.useCrmIntegrations.mockReturnValue(queryResult({ data: [] }));
    const screen = await wrap(<CrmLifecyclePanel />);
    expect(screen.queryByText("CRM connections")).toBeNull();
  });

  it("AudienceDestinationsPanel stays hidden on a SUCCESSFUL empty read", async () => {
    destinationHooks.useAudienceDestinations.mockReturnValue(
      queryResult({ data: [] }),
    );
    const screen = await wrap(<AudienceDestinationsPanel />);
    expect(screen.queryByText("Audience destinations")).toBeNull();
  });
});

describe("loaded rows still render", () => {
  it("ChatChannelPanel renders a channel once the read succeeds", async () => {
    chatHooks.useChatChannels.mockReturnValue(
      queryResult({
        data: [
          { id: "c1", provider: "slack", name: "#alerts", active: true },
        ],
      }),
    );
    const screen = await wrap(<ChatChannelPanel />);
    expect(screen.getByText("#alerts")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("CrmLifecyclePanel renders a connection once the read succeeds", async () => {
    crmHooks.useCrmIntegrations.mockReturnValue(
      queryResult({
        data: [{ id: "h1", name: "HubSpot", status: "active" }],
      }),
    );
    const screen = await wrap(<CrmLifecyclePanel />);
    expect(screen.getByText("HubSpot")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });
});
