/**
 * The two destructive deliverability controls that were only ever checked for
 * VISIBILITY — pressed, guarded and asserted.
 *
 *   1. app/(tabs)/custom-domains.tsx — the row's Remove action. Removing a
 *      domain makes every link already sent on it stop resolving, so it is the
 *      one control in the cluster that earns a TYPED confirmation. Nothing had
 *      ever proved the typing gate holds; the sibling suite only proves a
 *      viewer is not offered the row at all.
 *   2. ClearLimitsControl — "Remove all throttles". Its own header explains the
 *      five terms that decide whether it APPEARS, and the sibling suite pins
 *      three of them. What it never did was press it: the write behind it is
 *      revision-fenced, and a clear that dropped `expected_updated_at` would
 *      silently overwrite a policy somebody else changed a second earlier.
 *
 * Both are mounted under the REAL `ConfirmProvider` and `ToastProvider`.
 * `useConfirm()` outside a provider resolves `true`, so a render without them
 * cannot see either gate: delete the `await confirm(...)` and every other test
 * of these screens stays green.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";

// ---------------------------------------------------------------------------
// custom-domains
// ---------------------------------------------------------------------------

const mockDomains: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  refetch: jest.fn(async () => undefined),
};

const mockDeleteAsync = jest.fn(async (_id: string) => ({ ok: true }));

/**
 * SwipeableRow, reduced to the path a test can reach.
 *
 * The real component renders its actions inside `ReanimatedSwipeable`, which
 * the shared gesture-handler mock does not provide, so the shipped row's
 * actions render NOTHING here. This stub reproduces exactly what the real
 * action panel does on press — call `action.onPress()` under the action's own
 * label — and nothing else. The handler it invokes is the SCREEN's real
 * `onDelete`, which is what every assertion below is about.
 */
jest.mock("@/components/SwipeableRow", () => {
  const RN = jest.requireActual("react-native") as typeof import("react-native");
  const ReactLocal = jest.requireActual("react") as typeof import("react");
  return {
    SwipeableRow: ({
      children,
      accessibilityLabel,
      right,
    }: {
      children: React.ReactNode;
      accessibilityLabel?: string;
      right?: readonly { label: string; onPress: () => void }[];
    }) =>
      ReactLocal.createElement(
        RN.View,
        accessibilityLabel ? { accessibilityLabel } : {},
        children,
        ...(right ?? []).map((action) =>
          ReactLocal.createElement(
            RN.Pressable,
            {
              key: action.label,
              onPress: action.onPress,
              accessibilityRole: "button",
              accessibilityLabel: action.label,
            },
            ReactLocal.createElement(RN.Text, null, action.label),
          ),
        ),
      ),
  };
});

jest.mock("@/hooks/useDomainOps", () => ({
  useCustomDomains: () => mockDomains,
  useVerifyCustomDomain: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCreateCustomDomain: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDeleteCustomDomain: () => ({
    mutateAsync: mockDeleteAsync,
    isPending: false,
  }),
  CUSTOM_DOMAIN_PURPOSES: [{ value: "links", label: "Tracked links" }],
  normalizeDomainInput: (raw: string) => raw.trim().toLowerCase(),
}));

jest.mock("@/hooks/useDeliverability", () => ({
  useDnsHealth: () => ({
    data: undefined,
    isError: false,
    refetch: jest.fn(async () => undefined),
  }),
  useSenderReputation: () => ({
    data: undefined,
    isError: false,
    refetch: jest.fn(async () => undefined),
  }),
  useRunDnsCheck: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

// ---------------------------------------------------------------------------
// sending-settings (ClearLimitsControl)
// ---------------------------------------------------------------------------

const mockSettings: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  refetch: jest.fn(async () => undefined),
};

const mockUpdateAsync = jest.fn(
  async (
    input: Record<string, unknown>,
  ): Promise<{ kind: string; settings: Record<string, unknown> }> => ({
    kind: "applied",
    settings: {
      tenant_id: "11111111-1111-4111-8111-111111111111",
      ...input,
      updated_at: "2026-07-20T09:05:00Z",
    },
  }),
);

jest.mock("@/hooks/useSendingOps", () => ({
  useSendingSettings: () => mockSettings,
  useSendingStatus: () => ({
    data: undefined,
    isError: false,
    refetch: jest.fn(async () => undefined),
  }),
  useUpdateSendingSettings: () => ({
    mutateAsync: mockUpdateAsync,
    reconcileAsync: jest.fn(async () => ({ kind: "applied", settings: {} })),
    isPending: false,
  }),
  CLEARED_SENDING_SETTINGS: {
    max_sends_per_hour: null,
    quiet_hours_start: "",
    quiet_hours_end: "",
    quiet_hours_tz: "",
    quiet_hours_per_recipient: false,
  },
}));

// eslint-disable-next-line import/first
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import CustomDomains from "../app/(tabs)/custom-domains";
// eslint-disable-next-line import/first
import SendingSettings from "../app/(tabs)/sending-settings";

const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

/** Matches `CustomDomain` from src/lib/deliverabilityContracts.ts exactly. */
const DOMAIN = {
  id: "d1",
  domain: "mail.example.com",
  purpose: "links",
  verified: true,
  dnsRecords: [],
  createdAt: "2026-07-01T00:00:00Z",
  verifiedAt: "2026-07-02T00:00:00Z",
};

const THROTTLED = {
  max_sends_per_hour: 5000,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "America/New_York",
  quiet_hours_per_recipient: false,
  updated_at: "2026-07-20T09:00:00Z",
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </SafeAreaProvider>
  );
}

/** Let React commit what the last interaction queued (a macrotask, not a tick). */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The last control carrying `label`.
 *
 * Both screens publish the confirm's own verb on the control that OPENS it
 * ("Remove" on the row action and on the sheet's affirmative button), so a
 * bare `getByLabelText` throws "found 2 elements" while the sheet is open.
 * `ConfirmProvider` renders `{children}` then its host, so the sheet is last.
 */
function sheetControl(label: string) {
  const matches = screen.getAllByLabelText(label);
  const last = matches[matches.length - 1];
  if (!last) throw new Error(`no control labelled "${label}" is on screen`);
  return last;
}

afterEach(() => {
  mockDomains.data = undefined;
  mockDomains.isLoading = false;
  mockDomains.isError = false;
  mockDomains.error = null;
  mockSettings.data = undefined;
  mockSettings.isLoading = false;
  mockSettings.isError = false;
  gateHarness.__resetOnlineGateForTests();
});

describe("removing a custom domain — the typed gate", () => {
  it("names the domain and the links it breaks, and will not fire until the domain is typed", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockDomains.data = { value: [DOMAIN], fromSnapshot: false, capturedAt: null };
    await render(React.createElement(CustomDomains), { wrapper });

    const pending = fireEvent.press(screen.getByLabelText("Remove"));
    await flush();

    expect(screen.getByText("Remove this domain?")).toBeTruthy();
    expect(
      screen.getByText(
        "mail.example.com stops serving Moosewave links and its DNS records become inert.",
      ),
    ).toBeTruthy();
    // The consequence that outlives the deletion: mail already sent carries
    // links on this host, and they die with it.
    expect(
      screen.getByText(
        "Links already sent on this domain will stop resolving.",
      ),
    ).toBeTruthy();

    // The gate: the affirmative button is inert until the domain is typed.
    expect(
      sheetControl("Remove").props.accessibilityState?.disabled,
    ).toBe(true);
    await fireEvent.press(sheetControl("Remove"));
    await flush();
    expect(mockDeleteAsync).not.toHaveBeenCalled();

    // A near miss is still a miss — this is the whole point of the phrase.
    await fireEvent.changeText(
      screen.getByLabelText("Type mail.example.com to confirm"),
      "mail.example.co",
    );
    expect(
      sheetControl("Remove").props.accessibilityState?.disabled,
    ).toBe(true);
    await fireEvent.press(sheetControl("Remove"));
    await flush();
    expect(mockDeleteAsync).not.toHaveBeenCalled();

    await fireEvent.changeText(
      screen.getByLabelText("Type mail.example.com to confirm"),
      "mail.example.com",
    );
    expect(
      sheetControl("Remove").props.accessibilityState?.disabled,
    ).toBe(false);
    await fireEvent.press(sheetControl("Remove"));
    await flush();
    await pending;

    // The row's id, not its domain: the handler must address the record.
    expect(mockDeleteAsync).toHaveBeenCalledTimes(1);
    expect(mockDeleteAsync.mock.calls[0]?.[0]).toBe("d1");
    expect(screen.getByText("mail.example.com removed")).toBeTruthy();
  });

  it("dismissing the sheet removes nothing", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockDomains.data = { value: [DOMAIN], fromSnapshot: false, capturedAt: null };
    await render(React.createElement(CustomDomains), { wrapper });

    const pending = fireEvent.press(screen.getByLabelText("Remove"));
    await flush();
    await fireEvent.press(screen.getByLabelText("Cancel"));
    await flush();
    await pending;

    expect(mockDeleteAsync).not.toHaveBeenCalled();
    expect(screen.queryByText("Remove this domain?")).toBeNull();
    expect(screen.queryByText("mail.example.com removed")).toBeNull();
    // The domain is still listed.
    expect(screen.getAllByText("mail.example.com").length).toBeGreaterThan(0);
  });

  it("reports a refused removal instead of claiming the domain is gone", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockDomains.data = { value: [DOMAIN], fromSnapshot: false, capturedAt: null };
    mockDeleteAsync.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { status: 403 }),
    );
    await render(React.createElement(CustomDomains), { wrapper });

    const pending = fireEvent.press(screen.getByLabelText("Remove"));
    await flush();
    await fireEvent.changeText(
      screen.getByLabelText("Type mail.example.com to confirm"),
      "mail.example.com",
    );
    await fireEvent.press(sheetControl("Remove"));
    await flush();
    await pending;

    expect(mockDeleteAsync).toHaveBeenCalledTimes(1);
    // A refusal must never read as a completed removal…
    expect(screen.queryByText("mail.example.com removed")).toBeNull();
    // …and a 403 is answered with the next step, not the generic fallback.
    expect(
      screen.getByText("Your role can't make this change. Ask an admin."),
    ).toBeTruthy();
    expect(screen.queryByText(/Couldn't remove/u)).toBeNull();
    // The row is still there to try again from.
    expect(screen.getAllByText("mail.example.com").length).toBeGreaterThan(0);
  });
});

describe("removing every workspace throttle", () => {
  it("spells out that recipients can then be mailed overnight, and sends nothing if dismissed", async () => {
    mockSettings.data = {
      value: THROTTLED,
      fromSnapshot: false,
      capturedAt: null,
    };
    await render(React.createElement(SendingSettings), { wrapper });

    const pending = fireEvent.press(
      screen.getByLabelText("Remove all throttles"),
    );
    await flush();

    expect(screen.getByText("Remove workspace limits?")).toBeTruthy();
    expect(
      screen.getByText(
        "The workspace hourly cap and quiet hours will both be cleared. Provider, quota, and safety controls still apply.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "These workspace settings will no longer hold new sends, and recipients can receive mail at any hour, including overnight in their timezone.",
      ),
    ).toBeTruthy();
    expect(mockUpdateAsync).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText("Cancel"));
    await flush();
    await pending;

    expect(mockUpdateAsync).not.toHaveBeenCalled();
    // The throttles are still in place and still described as such.
    expect(screen.getByLabelText("Max sends per hour").props.value).toBe("5000");
    expect(screen.getByText("Cap 5,000/hr")).toBeTruthy();
  });

  it("confirming clears every field AND carries the revision fence", async () => {
    mockSettings.data = {
      value: THROTTLED,
      fromSnapshot: false,
      capturedAt: null,
    };
    await render(React.createElement(SendingSettings), { wrapper });

    const pending = fireEvent.press(
      screen.getByLabelText("Remove all throttles"),
    );
    await flush();
    await fireEvent.press(sheetControl("Remove"));
    await flush();
    await pending;

    expect(mockUpdateAsync).toHaveBeenCalledTimes(1);
    // Every throttle explicitly cleared — `null` for the cap, not 0, which
    // would mean "never send" — and fenced to the revision the form was
    // loaded from, so this cannot overwrite a policy changed a second ago.
    expect(mockUpdateAsync.mock.calls[0]?.[0]).toEqual({
      max_sends_per_hour: null,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "",
      quiet_hours_per_recipient: false,
      expected_updated_at: "2026-07-20T09:00:00Z",
    });

    // The rendered consequence: the form adopts the cleared server row rather
    // than leaving the old numbers on screen next to a success toast.
    expect(screen.getByLabelText("Max sends per hour").props.value).toBe("");
    expect(screen.getByLabelText("Quiet hours start").props.value).toBe("");
    expect(screen.getByText("Workspace limits removed and verified")).toBeTruthy();
    // Nothing left to clear, so the control withdraws itself.
    expect(
      screen.queryByLabelText("Remove all throttles"),
    ).toBeNull();
  });
});
