/**
 * PlatformConfigSection's affordances — which card offers which sheet to
 * whom. The sheets' own contracts live in their tests; here what is pinned is
 * the wiring: an admin is offered every editor and each opens the sheet on
 * the card's own row; a viewer is offered only the firewall's activity (its
 * reads are viewer on the server) and nothing that would 403.
 *
 * `usePlatformConfig` is mocked with settled rows so the cards are loaded;
 * the write hooks are mocked to inert shapes so the opened sheets render.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as AuthStore from "@/store/auth";

const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

function mockSettled(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isLoading: false,
    refetch: async () => undefined,
  };
}

jest.mock("@/hooks/usePlatformConfig", () => ({
  isHiddenPlatformError: () => false,
  useTenantRegionQuery: () =>
    mockSettled({ dataRegion: "eu-north-1", deploymentRegion: "eu-north-1", matches: true }),
  useFeatureFlagsQuery: () =>
    mockSettled([
      { key: "new_composer", value: "on", note: "", enabled: true, isDefault: false },
    ]),
  useFirewallSettingsQuery: () =>
    mockSettled({
      attackModeEnabled: false,
      autoAttackMode: true,
      fingerprintRequired: false,
      attackModeThreshold: 50,
      surgeMultiplier: 5,
      surgeMinPerHour: 50,
      autoEnabledAt: null,
    }),
  useIdentifierTransformsQuery: () =>
    mockSettled({
      emailNormalizeDots: false,
      emailNormalizePlus: true,
      phoneE164Format: false,
      phoneDefaultRegion: "",
    }),
}));

const mockMutation = { isPending: false, mutate: () => undefined };

jest.mock("@/hooks/useFirewallAdmin", () => ({
  FIREWALL_EVENTS_LIMIT: 20,
  useFirewallStatsQuery: () => mockSettled(undefined),
  useFirewallEventsQuery: () => mockSettled([]),
  useSaveFirewallSettings: () => mockMutation,
  useRunFirewallDetect: () => mockMutation,
}));
jest.mock("@/hooks/useIdentifierTransformsEdit", () => ({
  useUpdateIdentifierTransforms: () => mockMutation,
  useIdentifierTransformPreview: () => mockSettled(undefined),
}));
jest.mock("@/hooks/useFeatureFlagOverrides", () => ({
  useUpsertFeatureFlag: () => mockMutation,
  useDeleteFeatureFlagOverride: () => mockMutation,
}));

// eslint-disable-next-line import/first -- must follow the hook mocks.
import { PlatformConfigSection } from "@/components/settings/PlatformConfigSection";

function wrapper({ children }: { children: React.ReactNode }) {
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
  authHarness.__resetAuthStateForTests();
});

describe("PlatformConfigSection actions", () => {
  it("offers an admin every editor, each opening its sheet on the card's row", async () => {
    await render(<PlatformConfigSection />, { wrapper });
    expect(screen.getByLabelText("Manage firewall")).toBeTruthy();
    expect(screen.getByLabelText("Edit rules and preview")).toBeTruthy();
    expect(screen.getByLabelText("Add an override")).toBeTruthy();
    expect(screen.getByLabelText("Edit flag new_composer")).toBeTruthy();
    // Closed sheets render nothing.
    expect(screen.queryByLabelText("Close signup firewall")).toBeNull();
    expect(screen.queryByLabelText("Close identifier transforms")).toBeNull();
    expect(screen.queryByLabelText("Close feature flag")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Edit rules and preview"));
    expect(screen.getByLabelText("Close identifier transforms")).toBeTruthy();
    expect(screen.getByLabelText("Drop “+tag” sub-addresses").props.value).toBe(true);

    await fireEvent.press(screen.getByLabelText("Manage firewall"));
    expect(screen.getByLabelText("Close signup firewall")).toBeTruthy();
    expect(screen.getByLabelText("Block score").props.value).toBe("50");

    await fireEvent.press(screen.getByLabelText("Edit flag new_composer"));
    expect(screen.getByLabelText("Close feature flag")).toBeTruthy();
    expect(screen.getByLabelText("Value").props.value).toBe("on");
    expect(screen.getByLabelText("Remove override")).toBeTruthy();
  });

  it("offers a viewer the firewall's activity and nothing that would 403", async () => {
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: { role: "viewer", effectiveRole: "viewer" },
    });
    await render(<PlatformConfigSection />, { wrapper });
    expect(screen.getByLabelText("Recent activity")).toBeTruthy();
    expect(screen.queryByLabelText("Manage firewall")).toBeNull();
    expect(screen.queryByLabelText("Edit rules and preview")).toBeNull();
    expect(screen.queryByLabelText("Add an override")).toBeNull();
    expect(screen.queryByLabelText("Edit flag new_composer")).toBeNull();
    // The state itself is still shown — a viewer came to SEE it.
    expect(screen.getByText("new_composer")).toBeTruthy();
    expect(screen.getByText("on · workspace override")).toBeTruthy();
    // The activity sheet opens for the viewer and carries no write.
    await fireEvent.press(screen.getByLabelText("Recent activity"));
    expect(screen.getByLabelText("Close signup firewall")).toBeTruthy();
    expect(screen.queryByLabelText("Save settings")).toBeNull();
    expect(screen.queryByLabelText("Check for surge now")).toBeNull();
  });
});
