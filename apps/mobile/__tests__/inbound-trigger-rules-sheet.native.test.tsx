/**
 * Inbound trigger rules — the render contract for the per-endpoint sheet
 * (P2.36). The transport seam is not exercised here; what is pinned is what
 * an ADMIN sees and can do, and the three ways this surface could be quietly
 * wrong:
 *
 *  1. THE STATE IS A WORD AND THE TOGGLE IS THE ACTION. "Paused"/"Active" in
 *     the row; "Pause"/"Resume" on the control. A control that restated the
 *     state would send a hurried operator the wrong way round.
 *  2. A WRITE IN FLIGHT LOCKS EVERY CONTROL, so two rules cannot race.
 *  3. DELETE IS GATED. Under the real ConfirmProvider the press parks on the
 *     sheet, shows the desktop's consequence copy, and issues NOTHING until
 *     the confirming button is pressed. Cancel issues nothing at all.
 *
 * Below admin the whole surface is one caption — the rule, not a 403 — and
 * the query hook is never asked for the endpoint.
 *
 * `useInboundWebhookTriggers` is mocked explicitly (not via the queryHooks
 * proxy) because the module also exports mutations, which the proxy would
 * hand back in the query shape.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import {
  normalizeTriggerRule,
  triggerDeleteConfirmCopy,
  type InboundTriggerRule,
} from "@/lib/inboundTriggerRules";

const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

const ENDPOINT = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Stripe live",
  slug: "stripe-live-payments-eu",
};

const PAUSED = normalizeTriggerRule({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  webhook_id: ENDPOINT.id,
  name: "Paid customer → onboarding",
  active: false,
  match_jsonpath: "$.type",
  match_operator: "equals",
  match_value: "payment_intent.succeeded",
  email_jsonpath: "$.data.object.receipt_email",
  action_type: "add_to_sequence",
  action_target_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  fired_count: 12,
  last_fired_at: "2026-09-02T09:00:00Z",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
}) as InboundTriggerRule;

const ACTIVE = normalizeTriggerRule({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  webhook_id: ENDPOINT.id,
  name: "Refund → tag",
  active: true,
  match_jsonpath: "$.type",
  match_operator: "contains",
  match_value: "refund",
  email_jsonpath: "$.data.object.receipt_email",
  action_type: "add_tag",
  action_target_id: "refunded",
  fired_count: 0,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
}) as InboundTriggerRule;

type Query = {
  data: unknown;
  error: unknown;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
};

function query(data: unknown, over: Partial<Query> = {}): Query {
  return {
    data,
    error: null,
    isLoading: false,
    isError: false,
    refetch: async () => undefined,
    ...over,
  };
}

const mockRules: { current: Query } = { current: query([PAUSED, ACTIVE]) };
const mockQueryCalls: [string | null, boolean][] = [];
const setActiveCalls: unknown[] = [];
const removeCalls: unknown[] = [];
const saveCalls: unknown[] = [];
const mockPending = { setActive: false, remove: false, save: false };

jest.mock("@/hooks/useInboundWebhookTriggers", () => ({
  useInboundWebhookTriggers: (endpointId: string | null, open: boolean) => {
    mockQueryCalls.push([endpointId, open]);
    return mockRules.current;
  },
  useInboundTriggerRuleActions: () => ({
    save: {
      get isPending() {
        return mockPending.save;
      },
      mutate: (
        vars: unknown,
        opts?: { onSuccess?: () => void; onError?: (e: unknown) => void },
      ) => {
        saveCalls.push(vars);
        opts?.onSuccess?.();
      },
    },
    setActive: {
      get isPending() {
        return mockPending.setActive;
      },
      mutateAsync: async (vars: unknown) => {
        setActiveCalls.push(vars);
        return {};
      },
    },
    remove: {
      get isPending() {
        return mockPending.remove;
      },
      mutateAsync: async (vars: unknown) => {
        removeCalls.push(vars);
      },
    },
  }),
}));

// eslint-disable-next-line import/first -- must follow the hook mock.
import { InboundTriggerRulesSheet } from "@/components/inbound-webhooks/InboundTriggerRulesSheet";

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

/** The same sheet under the real ConfirmProvider, as app/_layout mounts it. */
function confirmWrapper({ children }: { children: React.ReactNode }) {
  return wrapper({ children: <ConfirmProvider>{children}</ConfirmProvider> });
}

const noop = () => undefined;

async function renderSheet(withConfirm = false) {
  return render(<InboundTriggerRulesSheet endpoint={ENDPOINT} onClose={noop} />, {
    wrapper: withConfirm ? confirmWrapper : wrapper,
  });
}

/** Let React commit what the last interaction queued (macrotask, not microtask). */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
  mockRules.current = query([PAUSED, ACTIVE]);
  mockQueryCalls.length = 0;
  setActiveCalls.length = 0;
  removeCalls.length = 0;
  saveCalls.length = 0;
  mockPending.setActive = false;
  mockPending.remove = false;
  mockPending.save = false;
});

describe("InboundTriggerRulesSheet", () => {
  it("lists each rule with its condition, action, fired count and state as WORDS", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderSheet();
    expect(screen.getByText("Stripe live")).toBeTruthy();
    expect(screen.getByText("2 rules · 1 paused")).toBeTruthy();
    expect(screen.getByText("Paid customer → onboarding")).toBeTruthy();
    expect(
      screen.getByText('When $.type equals "payment_intent.succeeded"'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Email from $.data.object.receipt_email → Enroll in sequence …cccccccc",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Fired 12 times · last /u)).toBeTruthy();
    expect(screen.getByText("Never fired")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    // The query was asked for THIS endpoint, and only because an admin opened it.
    expect(mockQueryCalls).toContainEqual([ENDPOINT.id, true]);
  });

  it("offers the ACTION as the toggle label and sends the flipped flag", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderSheet();
    const resume = screen.getByLabelText(/^Resume Paid customer → onboarding/u);
    const pause = screen.getByLabelText(/^Pause Refund → tag/u);
    expect(resume).toBeTruthy();
    expect(pause).toBeTruthy();
    await fireEvent.press(resume);
    await flush();
    expect(setActiveCalls).toEqual([
      { endpointId: ENDPOINT.id, triggerId: PAUSED.id, active: true },
    ]);
    await fireEvent.press(pause);
    await flush();
    expect(setActiveCalls[1]).toEqual({
      endpointId: ENDPOINT.id,
      triggerId: ACTIVE.id,
      active: false,
    });
  });

  it("locks every control while a write is in flight", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockPending.setActive = true;
    await renderSheet();
    for (const label of [
      /^Resume Paid customer → onboarding/u,
      "Edit the rule Refund → tag",
      "Delete the rule Refund → tag",
      "Add a trigger rule",
    ]) {
      expect(
        screen.getByLabelText(label).props.accessibilityState?.disabled,
      ).toBe(true);
    }
  });

  it("withholds the whole surface below admin with the rule, not a 403", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await renderSheet();
    expect(
      screen.getByText(/read and changed by admins only/u),
    ).toBeTruthy();
    expect(screen.queryByText("Paid customer → onboarding")).toBeNull();
    expect(screen.queryByLabelText("Add a trigger rule")).toBeNull();
    // The read is gated too: the hook is told the sheet is not open for it.
    expect(mockQueryCalls.every(([, open]) => open === false)).toBe(true);
  });

  it("says a failed read FAILED instead of 'No routing rules yet'", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockRules.current = query(undefined, {
      isError: true,
      error: Object.assign(new Error("HTTP 500"), { status: 500 }),
    });
    await renderSheet();
    expect(screen.queryByText("No routing rules yet")).toBeNull();
    expect(screen.getAllByLabelText("Retry").length).toBeGreaterThan(0);
  });

  it("reserves the empty copy for a read that genuinely returned nothing", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockRules.current = query([]);
    await renderSheet();
    expect(screen.getByText("No routing rules yet")).toBeTruthy();
    expect(screen.getByText("No rules yet")).toBeTruthy();
  });

  it("gates delete behind the confirm sheet, and a cancelled sheet issues nothing", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderSheet(true);
    const copy = triggerDeleteConfirmCopy(PAUSED);
    // NOT awaited: the handler is parked on `await confirm(...)` until the
    // sheet is settled below; awaiting here would wait for an answer only
    // the assertions can give.
    const pending = fireEvent.press(
      screen.getByLabelText("Delete the rule Paid customer → onboarding"),
    ) as unknown as Promise<unknown>;
    await flush();
    expect(screen.getByText(copy.title)).toBeTruthy();
    expect(screen.getByText(copy.message)).toBeTruthy();
    expect(removeCalls).toEqual([]);
    await fireEvent.press(screen.getByLabelText("Cancel"));
    await flush();
    await pending;
    expect(removeCalls).toEqual([]);
  });

  it("sends the DELETE only once the confirming button is pressed", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderSheet(true);
    const copy = triggerDeleteConfirmCopy(PAUSED);
    const pending = fireEvent.press(
      screen.getByLabelText("Delete the rule Paid customer → onboarding"),
    ) as unknown as Promise<unknown>;
    await flush();
    expect(removeCalls).toEqual([]);
    await fireEvent.press(screen.getByLabelText(copy.confirmLabel));
    await flush();
    await pending;
    expect(removeCalls).toEqual([
      { endpointId: ENDPOINT.id, triggerId: PAUSED.id },
    ]);
  });

  it("refuses to create a draft the server would 400, then sends a valid one", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderSheet();
    await fireEvent.press(screen.getByLabelText("Add a trigger rule"));
    // Untouched form: no wall of red yet.
    expect(screen.queryByText("Enter a rule name.")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Create rule"));
    expect(saveCalls).toEqual([]);
    expect(screen.getByText("Enter a rule name.")).toBeTruthy();
    expect(screen.getByText("Choose the target for this action.")).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText("Rule name"), " Paid → onboarding ");
    await fireEvent.changeText(screen.getByLabelText("Match JSONPath"), "$.type");
    await fireEvent.changeText(
      screen.getByLabelText("Comparison value"),
      "payment_intent.succeeded",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Subscriber email JSONPath"),
      "$.data.object.receipt_email",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Sequence ID"),
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
    await fireEvent.press(screen.getByLabelText("Create rule"));
    expect(saveCalls).toEqual([
      {
        endpointId: ENDPOINT.id,
        triggerId: null,
        input: {
          name: "Paid → onboarding",
          match_jsonpath: "$.type",
          match_operator: "equals",
          match_value: "payment_intent.succeeded",
          email_jsonpath: "$.data.object.receipt_email",
          action_type: "add_to_sequence",
          action_target_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        },
      },
    ]);
    // Saved → the form closes and the Add control is back.
    expect(screen.getByLabelText("Add a trigger rule")).toBeTruthy();
  });

  it("seeds Edit from the rule and sends the whole input against its id", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderSheet();
    await fireEvent.press(screen.getByLabelText("Edit the rule Refund → tag"));
    expect(screen.getByLabelText("Rule name").props.value).toBe("Refund → tag");
    expect(screen.getByLabelText("Tag name").props.value).toBe("refunded");
    // Unchanged → Save is a no-op the server would still write; it stays off.
    expect(
      screen.getByLabelText("Save rule").props.accessibilityState?.disabled,
    ).toBe(true);
    await fireEvent.changeText(screen.getByLabelText("Tag name"), "refunded-2026");
    await fireEvent.press(screen.getByLabelText("Save rule"));
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]).toMatchObject({
      endpointId: ENDPOINT.id,
      triggerId: ACTIVE.id,
      input: { action_type: "add_tag", action_target_id: "refunded-2026" },
    });
  });
});
