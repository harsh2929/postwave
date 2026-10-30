/**
 * The WORKSPACE SEND KILL SWITCH, actually pressed.
 *
 * `SendingKillSwitchCard` halts every campaign, automation and transactional
 * send in the workspace. Until this file its only coverage was
 * write-controls.native.test.tsx, which asserts `expect(() => render(...))
 * .not.toThrow()` and that an absent control renders nothing. Nothing had ever
 * pressed the verb, so every rule the component's own header states was
 * unprotected:
 *
 *   1. a VIEWER sees the state and is offered no control;
 *   2. the copy never claims sending "stopped" — the flag gates FUTURE sends;
 *   3. a REASON is required even though the server accepts an empty one.
 *
 * Mounted under the REAL `ConfirmProvider` and `ToastProvider`, as
 * app/_layout mounts them for every real session. `useConfirm()` outside a
 * provider resolves `true`, which is exactly why the sibling smoke test cannot
 * see the gate at all: delete the `await confirm(...)` and it stays green.
 *
 * Only the two DATA hooks are replaced (the network boundary). The card's own
 * handler — haptics, the confirm gate, the `{paused, reason}` payload, the
 * success/error toast, the cleared reason field — runs for real.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";
import { SendingKillSwitchCard } from "@/components/deliverability/SendingKillSwitchCard";
import type { SendingControl } from "@/lib/sendingKillSwitch";

const queryHooks = require("./mocks/queryHooks.cjs");

jest.mock("@/hooks/useSendingKillSwitch", () =>
  require("./mocks/queryHooks.cjs"),
);

const REASON_FIELD = "Reason for holding all email sending";
const HOLD = "Hold all sending";
const RESUME = "Resume sending";

interface PausedVars {
  paused: boolean;
  reason: string;
}
interface MutateCallbacks {
  onSuccess?: (next: SendingControl) => void;
  onError?: (err: unknown) => void;
}

const ACTIVE: SendingControl = {
  paused: false,
  reason: "",
  changedAt: "",
  changedBy: "",
  source: "",
};

const HELD: SendingControl = {
  paused: true,
  reason: "bad link in the 09:00 send",
  changedAt: "2026-09-04T09:02:00Z",
  changedBy: "ops@example.com",
  source: "manual",
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

/**
 * Load the control read and hand back the `mutate` the card will call.
 *
 * The stub answers the way the server does — echoing back the state that was
 * asked for — so the card's own `onSuccess` (clear the reason, toast the new
 * state) runs for real rather than being skipped.
 */
function load(control: SendingControl, fail?: Error) {
  queryHooks.__setHookResultForTests("useSendingControls", {
    data: control,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: control })),
  });
  const mutate = jest.fn((vars: PausedVars, callbacks?: MutateCallbacks) => {
    if (fail) {
      callbacks?.onError?.(fail);
      return;
    }
    callbacks?.onSuccess?.({
      paused: vars.paused,
      reason: vars.reason,
      changedAt: "2026-09-04T09:02:00Z",
      changedBy: "ops@example.com",
      source: "manual",
    });
  });
  queryHooks.__setHookResultForTests("useSetSendingPaused", {
    data: undefined,
    error: null,
    isError: false,
    isPending: false,
    mutate,
    mutateAsync: jest.fn(async () => undefined),
    reset: jest.fn(),
    variables: undefined,
  });
  return mutate;
}

/** Let React commit what the last interaction queued (a macrotask, not a tick). */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A control inside the open confirm sheet.
 *
 * The sheet's affirmative button carries the SAME accessibility label as the
 * card's own — `copy.confirmLabel` feeds both — so a bare `getByLabelText`
 * throws "found 2 elements" the moment the sheet opens. `ConfirmProvider`
 * renders `{children}` and then its host, so the sheet's copy is the last one.
 */
function sheetControl(label: string) {
  const matches = screen.getAllByLabelText(label);
  const last = matches[matches.length - 1];
  if (!last) throw new Error(`no control labelled "${label}" is on screen`);
  return last;
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("holding all workspace sending", () => {
  it("will not even open the confirm without a reason, and opens it once there is one", async () => {
    const mutate = load(ACTIVE);
    await render(<SendingKillSwitchCard effectiveRole="admin" />, { wrapper });

    // Rule 3: the server accepts an empty reason; this client does not, because
    // a workspace-wide halt with no note cannot be handed over at shift change.
    expect(
      screen.getByLabelText(HOLD).props.accessibilityState?.disabled,
    ).toBe(true);
    await fireEvent.press(screen.getByLabelText(HOLD));
    await flush();
    expect(screen.queryByText("Hold all email sending?")).toBeNull();
    expect(mutate).not.toHaveBeenCalled();

    await fireEvent.changeText(
      screen.getByLabelText(REASON_FIELD),
      "  wrong link in the 09:00 send  ",
    );
    expect(
      screen.getByLabelText(HOLD).props.accessibilityState?.disabled,
    ).toBe(false);
  });

  it("names the whole workspace in the confirm, and never claims sending stopped", async () => {
    const mutate = load(ACTIVE);
    await render(<SendingKillSwitchCard effectiveRole="admin" />, { wrapper });
    await fireEvent.changeText(
      screen.getByLabelText(REASON_FIELD),
      "wrong link in the 09:00 send",
    );

    const pending = fireEvent.press(screen.getByLabelText(HOLD));
    await flush();

    expect(screen.getByText("Hold all email sending?")).toBeTruthy();
    // The blast radius, stated: not "this campaign".
    expect(
      screen.getByText(/stops NEW email for the entire workspace/u),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Every campaign, automation and transactional send in this workspace.",
      ),
    ).toBeTruthy();
    // Rule 2: a batch already handed to the provider is NOT recalled, and the
    // sheet says so rather than letting the operator stand down.
    expect(
      screen.getByText(/already handed to the provider may still deliver/u),
    ).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();

    await fireEvent.press(sheetControl("Cancel"));
    await flush();
    await pending;

    // Dismissal performs nothing at all.
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.queryByText("Hold all email sending?")).toBeNull();
    // …and the operator's typed reason survives the change of mind.
    expect(screen.getByLabelText(REASON_FIELD).props.value).toBe(
      "wrong link in the 09:00 send",
    );
  });

  it("confirming halts the workspace with the typed reason, then reports it back", async () => {
    const mutate = load(ACTIVE);
    await render(<SendingKillSwitchCard effectiveRole="admin" />, { wrapper });
    await fireEvent.changeText(
      screen.getByLabelText(REASON_FIELD),
      "wrong link in the 09:00 send",
    );

    const pending = fireEvent.press(screen.getByLabelText(HOLD));
    await flush();
    await fireEvent.press(sheetControl(HOLD));
    await flush();
    await pending;

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      paused: true,
      reason: "wrong link in the 09:00 send",
    });
    // The consequence the operator sees: the state is announced, and the
    // reason box is emptied so the next hold cannot inherit a stale note.
    expect(
      screen.getByText("Email sending is held for the workspace."),
    ).toBeTruthy();
    expect(screen.getByLabelText(REASON_FIELD).props.value).toBe("");
  });

  it("reports the server's own refusal rather than a generic failure", async () => {
    const mutate = load(ACTIVE, new Error("sending controls are locked by SSO"));
    await render(<SendingKillSwitchCard effectiveRole="admin" />, { wrapper });
    await fireEvent.changeText(screen.getByLabelText(REASON_FIELD), "incident");

    const pending = fireEvent.press(screen.getByLabelText(HOLD));
    await flush();
    await fireEvent.press(sheetControl(HOLD));
    await flush();
    await pending;

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("sending controls are locked by SSO")).toBeTruthy();
    // A failed hold must not look like a successful one.
    expect(
      screen.queryByText("Email sending is held for the workspace."),
    ).toBeNull();
    // The reason is NOT cleared: the operator has to be able to retry.
    expect(screen.getByLabelText(REASON_FIELD).props.value).toBe("incident");
  });
});

describe("resuming a held workspace", () => {
  it("asks for no justification, and resumes with an empty reason", async () => {
    const mutate = load(HELD);
    await render(<SendingKillSwitchCard effectiveRole="admin" />, { wrapper });

    // Resuming needs no note, so the field is not even offered.
    expect(screen.queryByLabelText(REASON_FIELD)).toBeNull();

    const pending = fireEvent.press(screen.getByLabelText(RESUME));
    await flush();

    expect(screen.getByText("Resume email sending?")).toBeTruthy();
    expect(
      screen.getByText(/including anything queued while sending was held/u),
    ).toBeTruthy();
    // Resuming is not destructive, so it carries no consequence callout.
    expect(
      screen.queryByText(
        "Every campaign, automation and transactional send in this workspace.",
      ),
    ).toBeNull();

    await fireEvent.press(sheetControl(RESUME));
    await flush();
    await pending;

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual({ paused: false, reason: "" });
    expect(screen.getByText("Email sending resumed.")).toBeTruthy();
  });

  it("dismissing the resume leaves the workspace held", async () => {
    const mutate = load(HELD);
    await render(<SendingKillSwitchCard effectiveRole="admin" />, { wrapper });

    const pending = fireEvent.press(screen.getByLabelText(RESUME));
    await flush();
    await fireEvent.press(sheetControl("Cancel"));
    await flush();
    await pending;

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.queryByText("Email sending resumed.")).toBeNull();
    expect(screen.getByText("Held")).toBeTruthy();
  });
});

describe("who may press it", () => {
  it("shows a viewer the state and the reason, and offers no verb", async () => {
    const mutate = load(HELD);
    await render(<SendingKillSwitchCard effectiveRole="viewer" />, { wrapper });

    // Rule 1: hiding the state would leave a viewer filing a bug about a
    // campaign that "isn't going out".
    expect(screen.getByText("Held")).toBeTruthy();
    expect(
      screen.getByText(
        /New email sends are held for the whole workspace by ops@example.com — bad link in the 09:00 send/u,
      ),
    ).toBeTruthy();

    expect(screen.queryByLabelText(RESUME)).toBeNull();
    expect(screen.queryByLabelText(HOLD)).toBeNull();
    expect(screen.queryByLabelText(REASON_FIELD)).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("offers no verb before the session's role has resolved", async () => {
    load(ACTIVE);
    await render(<SendingKillSwitchCard effectiveRole={null} />, { wrapper });

    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.queryByLabelText(HOLD)).toBeNull();
  });
});
