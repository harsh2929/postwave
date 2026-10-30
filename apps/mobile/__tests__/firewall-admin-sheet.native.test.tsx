/**
 * Signup-firewall administration — the render contract for the sheet. The
 * transport seam is pinned in src/api/firewallAdmin.test.ts; what is pinned
 * here is what an operator answering an off-hours attack sees and can do:
 *
 *  1. THE COUNTS AND EVENTS ARE THE SERVER'S. Rejected leads each window, the
 *     action badge is the server's word, the empty sentence is desktop's.
 *  2. ONLY THE CHANGED FIELD TRAVELS, and a value the server would refuse is
 *     refused here with the bound named — never coerced past it.
 *  3. ARMING ATTACK MODE IS GATED behind the deliverability card's own
 *     consequence sentence, and the surge sweep reports `{flipped}` verbatim.
 *
 * Below admin the form is disabled with the rule stated; the activity, which
 * is viewer on the server, still renders.
 *
 * `useFirewallAdmin` is mocked explicitly: it exports two queries and two
 * mutations, which the queryHooks proxy would hand back in one shape.
 *
 * The sheet's footer ("Save settings", "Check for surge now", "Close signup
 * firewall") never shares a label with the ConfirmSheet's ("Cancel", "Save",
 * "Turn on", "Turn off"), so every getByLabelText below is unambiguous.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ADMIN_ONLY_NOTE } from "@/hooks/usePlatformConfigRole";
import {
  normalizeFirewallEvents,
  normalizeFirewallStats,
  surgeResultCopy,
} from "@/lib/firewallAdmin";
import type { FirewallSettingsView } from "@/lib/platformConfig";
import { attackModeConsequence } from "@/lib/reputationResponse";
import * as AuthStore from "@/store/auth";

const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

const SERVER: FirewallSettingsView = {
  attackModeEnabled: false,
  autoAttackMode: true,
  fingerprintRequired: false,
  attackModeThreshold: 50,
  surgeMultiplier: 5,
  surgeMinPerHour: 50,
  autoEnabledAt: null,
};

const STATS = normalizeFirewallStats({
  last_24h: { accepted: 10, rejected: 3, observed: 1 },
  last_7d: { accepted: 90, rejected: 20, observed: 4 },
});

const EVENTS = normalizeFirewallEvents({
  events: [
    {
      id: "e1",
      form_id: "f1",
      risk_score: 72,
      action: "rejected",
      ip: "203.0.113.4",
      at: "2026-09-01T10:00:00Z",
    },
    { id: "e2", risk_score: 5, action: "accepted", at: "2026-09-01T09:00:00Z" },
  ],
});

type Query = {
  data: unknown;
  error: unknown;
  isError: boolean;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
};

function query(data: unknown, over: Partial<Query> = {}): Query {
  return {
    data,
    error: null,
    isError: false,
    isLoading: false,
    refetch: async () => undefined,
    ...over,
  };
}

const mockStats: { current: Query } = { current: query(STATS) };
const mockEvents: { current: Query } = { current: query(EVENTS) };
const mockSaveCalls: unknown[] = [];
const mockDetectCalls: number[] = [];
const mockDetect = {
  flipped: true,
  isPending: false,
  mutate: (
    _vars: unknown,
    opts?: { onSuccess?: (r: { flipped: boolean }) => void },
  ) => {
    mockDetectCalls.push(1);
    opts?.onSuccess?.({ flipped: mockDetect.flipped });
  },
};
const mockSave = {
  isPending: false,
  mutate: (vars: unknown, opts?: { onSuccess?: () => void }) => {
    mockSaveCalls.push(vars);
    opts?.onSuccess?.();
  },
};

jest.mock("@/hooks/useFirewallAdmin", () => ({
  FIREWALL_EVENTS_LIMIT: 20,
  useFirewallStatsQuery: () => mockStats.current,
  useFirewallEventsQuery: () => mockEvents.current,
  useSaveFirewallSettings: () => mockSave,
  useRunFirewallDetect: () => mockDetect,
}));

// eslint-disable-next-line import/first -- must follow the hook mock.
import { FirewallAdminSheet } from "@/components/settings/platform-config/FirewallAdminSheet";

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ConfirmProvider>{children}</ConfirmProvider>
    </SafeAreaProvider>
  );
}

const noop = () => undefined;

async function renderSheet(server: FirewallSettingsView = SERVER) {
  await render(<FirewallAdminSheet visible server={server} onClose={noop} />, {
    wrapper,
  });
}

/** Let React commit what the last interaction queued (macrotask, not microtask). */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function saveDisabled() {
  return screen.getByLabelText("Save settings").props.accessibilityState?.disabled;
}

afterEach(() => {
  authHarness.__resetAuthStateForTests();
  mockStats.current = query(STATS);
  mockEvents.current = query(EVENTS);
  mockSaveCalls.length = 0;
  mockDetectCalls.length = 0;
  mockDetect.flipped = true;
  mockDetect.isPending = false;
  mockSave.isPending = false;
});

describe("FirewallAdminSheet", () => {
  it("shows the saved settings, the server's counts and the events verbatim", async () => {
    await renderSheet();
    expect(screen.getByLabelText("Attack mode").props.value).toBe(false);
    expect(screen.getByLabelText("Automatic escalation").props.value).toBe(true);
    expect(screen.getByLabelText("Block score").props.value).toBe("50");
    expect(screen.getByText("3 rejected · 10 accepted · 1 observed")).toBeTruthy();
    expect(screen.getByText("20 rejected · 90 accepted · 4 observed")).toBeTruthy();
    expect(screen.getByText("rejected")).toBeTruthy();
    expect(screen.getByText("risk 72 · 203.0.113.4 · form f1")).toBeTruthy();
    expect(screen.getByText("accepted")).toBeTruthy();
    expect(screen.getByText("risk 5")).toBeTruthy();
    expect(saveDisabled()).toBe(true);
  });

  it("names the bound a typed value breaks and blocks the save until it is fixed", async () => {
    await renderSheet();
    await fireEvent.changeText(screen.getByLabelText("Block score"), "101");
    expect(
      screen.getByText("Block score must be a whole number between 0 and 100."),
    ).toBeTruthy();
    expect(saveDisabled()).toBe(true);
    await fireEvent.changeText(screen.getByLabelText("Surge multiplier"), "abc");
    expect(screen.getByText("Surge multiplier must be a whole number.")).toBeTruthy();
    expect(saveDisabled()).toBe(true);
    await fireEvent.changeText(screen.getByLabelText("Surge multiplier"), "5");
    await fireEvent.changeText(screen.getByLabelText("Block score"), "70");
    expect(screen.queryByText(/must be a whole number/u)).toBeNull();
    expect(saveDisabled()).toBe(false);
  });

  it("sends ONLY the changed threshold once confirmed", async () => {
    await renderSheet();
    await fireEvent.changeText(screen.getByLabelText("Block score"), "70");
    await fireEvent.press(screen.getByLabelText("Save settings"));
    await flush();
    expect(screen.getByText("Save firewall settings?")).toBeTruthy();
    expect(screen.getByText("Block score: 70")).toBeTruthy();
    expect(mockSaveCalls).toEqual([]);
    await fireEvent.press(screen.getByLabelText("Save"));
    await flush();
    expect(mockSaveCalls).toEqual([{ attack_mode_threshold: 70 }]);
  });

  it("gates arming attack mode behind the deliverability card's own consequence", async () => {
    await renderSheet();
    await fireEvent(screen.getByLabelText("Attack mode"), "valueChange", true);
    await fireEvent.press(screen.getByLabelText("Save settings"));
    await flush();
    expect(screen.getByText("Turn on attack mode?")).toBeTruthy();
    expect(screen.getByText(attackModeConsequence(true))).toBeTruthy();
    expect(mockSaveCalls).toEqual([]);
    await fireEvent.press(screen.getByLabelText("Cancel"));
    await flush();
    expect(mockSaveCalls).toEqual([]);
    await fireEvent.press(screen.getByLabelText("Save settings"));
    await flush();
    await fireEvent.press(screen.getByLabelText("Turn on"));
    await flush();
    expect(mockSaveCalls).toEqual([{ attack_mode_enabled: true }]);
  });

  it("reports the surge sweep's answer in desktop's sentence, verbatim", async () => {
    await renderSheet();
    await fireEvent.press(screen.getByLabelText("Check for surge now"));
    await flush();
    expect(mockDetectCalls).toHaveLength(1);
    expect(screen.getByText(surgeResultCopy(true))).toBeTruthy();
    expect(screen.queryByText(surgeResultCopy(false))).toBeNull();
  });

  it("reserves the empty sentence for a read that returned nothing, and says a failed read failed", async () => {
    mockEvents.current = query([]);
    await renderSheet();
    expect(screen.getByText("No firewall events recorded yet.")).toBeTruthy();
    await screen.unmount();
    mockEvents.current = query(undefined, {
      isError: true,
      error: Object.assign(new Error("HTTP 500"), { status: 500 }),
    });
    await renderSheet();
    expect(screen.queryByText("No firewall events recorded yet.")).toBeNull();
    expect(screen.getAllByLabelText("Retry").length).toBeGreaterThan(0);
  });

  it("lets a viewer read the settings and the activity but offers no write", async () => {
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: { role: "viewer", effectiveRole: "viewer" },
    });
    await renderSheet();
    expect(screen.getByText(ADMIN_ONLY_NOTE)).toBeTruthy();
    expect(screen.queryByLabelText("Save settings")).toBeNull();
    expect(screen.queryByLabelText("Check for surge now")).toBeNull();
    expect(
      screen.getByLabelText("Attack mode").props.accessibilityState?.disabled,
    ).toBe(true);
    expect(screen.getByLabelText("Block score").props.editable).toBe(false);
    expect(screen.getByText("3 rejected · 10 accepted · 1 observed")).toBeTruthy();
    expect(screen.getByText("risk 72 · 203.0.113.4 · form f1")).toBeTruthy();
  });
});
