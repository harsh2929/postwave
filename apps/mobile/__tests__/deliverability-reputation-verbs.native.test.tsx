/**
 * The three "our reputation is on fire" verbs, actually pressed.
 *
 * `ReputationResponseCard` renders three server-mutating controls and, until
 * this file, not one of them had ever been pressed by a test — the only
 * coverage was write-controls.native.test.tsx proving the card survives a
 * hostile blocklist payload. The three differ in KIND, and the difference is
 * the behaviour worth pinning:
 *
 *   - SUPPRESS NOW is irreversible from this screen and stops mail leaving a
 *     listed IP or domain right now, so it carries the fullest confirmation:
 *     what is listed, where, and whether anything else would have caught it.
 *   - ATTACK MODE OFF has a side effect that OUTLIVES the tap — the server
 *     stamps a 24-hour cooldown so the automatic detector cannot re-arm. A
 *     confirmation that did not say so would leave the operator unable to tell
 *     whether their override took.
 *   - THE SWEEP is a check, not a change, so it deliberately has NO confirm.
 *     That asymmetry is asserted here too: it is a design decision, not an
 *     oversight, and a later "let's confirm everything" pass should have to
 *     break a test to change it.
 *
 * Mounted under the REAL `ConfirmProvider` and `ToastProvider`. Only the data
 * hooks are replaced; the card's handlers, the confirm copy built by
 * `lib/reputationResponse`, and the toast sentences all run for real.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";
import { ReputationResponseCard } from "@/components/deliverability/ReputationResponseCard";
import type {
  BlocklistSubjectLike,
  FirewallSettingsLike,
} from "@/lib/reputationResponse";

const queryHooks = require("./mocks/queryHooks.cjs");

jest.mock("@/hooks/useReputationResponse", () =>
  require("./mocks/queryHooks.cjs"),
);

const SUPPRESS_CONTROL = "Stop sending from 203.0.113.9";
const SWEEP_CONTROL = "Run the spam-trap sweep now";

/** A tier-1 listing on a dedicated IP: the emergency this card exists for. */
const LISTED: BlocklistSubjectLike = {
  subject_type: "ip",
  subject: "203.0.113.9",
  listed_zones: ["zen.spamhaus.org", "b.barracudacentral.org"],
  tier1_hit: true,
  listed_count: 2,
  total_zones: 5,
  would_auto_suppress: false,
  last_checked: "2026-09-04T08:00:00Z",
};

const ATTACK_ON: FirewallSettingsLike = {
  attackModeEnabled: true,
  autoAttackMode: true,
};

const ATTACK_OFF: FirewallSettingsLike = {
  attackModeEnabled: false,
  autoAttackMode: true,
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

function settled(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data })),
  };
}

function mutationWith(mutateAsync: unknown) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isPending: false,
    mutate: jest.fn(),
    mutateAsync,
    reset: jest.fn(),
    variables: undefined,
  };
}

interface Verbs {
  setMode: ReturnType<typeof jest.fn>;
  suppress: ReturnType<typeof jest.fn>;
  sweep: ReturnType<typeof jest.fn>;
}

/**
 * Load the two reads and hand back the three write handles.
 *
 * Each write is only replaced at its NETWORK boundary — the card's own
 * confirm gate, payload shaping and toast copy run unmocked above them.
 */
function load(options: {
  settings?: FirewallSettingsLike | null;
  listed?: BlocklistSubjectLike[];
  suppressResult?: { added: boolean } | Error;
  sweepResult?: { blocklisted: number; completed_at: string } | Error;
  attackModeResult?: FirewallSettingsLike | Error;
}): Verbs {
  queryHooks.__setHookResultForTests(
    "useFirewallSettings",
    settled(options.settings ?? null),
  );
  queryHooks.__setHookResultForTests(
    "useBlocklistStatus",
    settled(options.listed ?? []),
  );

  const setMode = jest.fn(async (_enabled: boolean) => {
    const result = options.attackModeResult ?? null;
    if (result instanceof Error) throw result;
    return result;
  });
  const suppress = jest.fn(
    async (_input: { subjectType: string; subject: string }) => {
      const result = options.suppressResult ?? { added: true };
      if (result instanceof Error) throw result;
      return result;
    },
  );
  const sweep = jest.fn(async () => {
    const result = options.sweepResult ?? {
      blocklisted: 0,
      completed_at: "2026-09-04T08:30:00Z",
    };
    if (result instanceof Error) throw result;
    return result;
  });

  queryHooks.__setHookResultForTests("useSetAttackMode", mutationWith(setMode));
  queryHooks.__setHookResultForTests(
    "useSuppressBlocklistSubject",
    mutationWith(suppress),
  );
  queryHooks.__setHookResultForTests(
    "useRunSpamTrapSweep",
    mutationWith(sweep),
  );
  return { setMode, suppress, sweep };
}

/** Let React commit what the last interaction queued (a macrotask, not a tick). */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("suppressing a blocklisted subject — the brake", () => {
  it("states what is listed, where, and that nothing else will stop it", async () => {
    const { suppress } = load({ listed: [LISTED] });
    await render(<ReputationResponseCard />, { wrapper });

    const pending = fireEvent.press(screen.getByLabelText(SUPPRESS_CONTROL));
    await flush();

    expect(screen.getByText("Stop sending from 203.0.113.9?")).toBeTruthy();
    // The zones by name, and the tier-1 escalation spelled out: a nuisance
    // listing and an emergency must not read identically.
    expect(
      screen.getByText(
        "Listed on 2 of 5 zones (zen.spamhaus.org, b.barracudacentral.org). This is a tier-1 zone that most receivers act on.",
      ),
    ).toBeTruthy();
    // `would_auto_suppress: false` changes the MEANING of the act: this is the
    // brake, not a belt-and-braces second stop.
    expect(
      screen.getByText(
        "Sending from 203.0.113.9 stops immediately, and it is not undone from this screen. Automatic suppression is off for this workspace, so nothing else is going to stop it.",
      ),
    ).toBeTruthy();
    expect(suppress).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText("Cancel"));
    await flush();
    await pending;

    // Dismissal sends nothing.
    expect(suppress).not.toHaveBeenCalled();
    expect(screen.queryByText("Stop sending from 203.0.113.9?")).toBeNull();
  });

  it("confirming sends the subject's own type and value, and says it landed", async () => {
    const { suppress } = load({ listed: [LISTED] });
    await render(<ReputationResponseCard />, { wrapper });

    const pending = fireEvent.press(screen.getByLabelText(SUPPRESS_CONTROL));
    await flush();
    await fireEvent.press(screen.getByLabelText("Suppress now"));
    await flush();
    await pending;

    expect(suppress).toHaveBeenCalledTimes(1);
    expect(suppress.mock.calls[0]?.[0]).toEqual({
      subjectType: "ip",
      subject: "203.0.113.9",
    });
    expect(screen.getByText("203.0.113.9 suppressed.")).toBeTruthy();
  });

  it("does not claim an action that did not happen when it was already suppressed", async () => {
    // A 409 means the intent is already satisfied — not a failure, but saying
    // "suppressed" would report an act the server did not perform.
    const { suppress } = load({
      listed: [LISTED],
      suppressResult: { added: false },
    });
    await render(<ReputationResponseCard />, { wrapper });

    const pending = fireEvent.press(screen.getByLabelText(SUPPRESS_CONTROL));
    await flush();
    await fireEvent.press(screen.getByLabelText("Suppress now"));
    await flush();
    await pending;

    expect(suppress).toHaveBeenCalledTimes(1);
    expect(screen.getByText("203.0.113.9 was already suppressed.")).toBeTruthy();
    expect(screen.queryByText("203.0.113.9 suppressed.")).toBeNull();
  });

  it("surfaces the server's classified refusal instead of a generic failure", async () => {
    const { suppress } = load({
      listed: [LISTED],
      suppressResult: Object.assign(new Error("forbidden"), { status: 403 }),
    });
    await render(<ReputationResponseCard />, { wrapper });

    const pending = fireEvent.press(screen.getByLabelText(SUPPRESS_CONTROL));
    await flush();
    await fireEvent.press(screen.getByLabelText("Suppress now"));
    await flush();
    await pending;

    expect(suppress).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        "You don't have access to this. Ask a workspace administrator if you need it.",
      ),
    ).toBeTruthy();
    // A refused suppression must never read as a completed one.
    expect(screen.queryByText("203.0.113.9 suppressed.")).toBeNull();
  });

  it("offers no suppression for a subject the handler would 400 on", async () => {
    // Only `ip` and `domain` are suppressible; anything else is offered as a
    // read, because a control that can only fail is worse than none.
    load({
      listed: [{ ...LISTED, subject_type: "pool", subject: "shared-pool-2" }],
    });
    await render(<ReputationResponseCard />, { wrapper });

    expect(screen.getByText("shared-pool-2")).toBeTruthy();
    expect(screen.queryByLabelText("Stop sending from shared-pool-2")).toBeNull();
  });
});

describe("attack mode — the tap whose effect outlives it", () => {
  it("turning it OFF names the 24-hour cooldown before anything is sent", async () => {
    const { setMode } = load({ settings: ATTACK_ON });
    await render(<ReputationResponseCard />, { wrapper });

    const toggle = screen.getByLabelText("Attack mode");
    expect(toggle.props.accessibilityState?.checked).toBe(true);

    const pending = fireEvent(toggle, "valueChange", false);
    await flush();

    expect(screen.getByText("Turn off attack mode?")).toBeTruthy();
    expect(
      screen.getByText(
        "Signup checks return to normal. The automatic detector is then held off for 24 hours, so it will not immediately turn attack mode back on — that pause is deliberate, and it is how your override sticks.",
      ),
    ).toBeTruthy();
    expect(setMode).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText("Cancel"));
    await flush();
    await pending;

    // Dismissing leaves the workspace exactly as it was — including the
    // switch, which must not have optimistically flipped itself.
    expect(setMode).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("Attack mode").props.accessibilityState?.checked,
    ).toBe(true);
    expect(screen.getByText(/Attack mode is ON, turned on manually/u)).toBeTruthy();
  });

  it("confirming OFF sends exactly `false`, and the toast repeats the cooldown", async () => {
    const { setMode } = load({
      settings: ATTACK_ON,
      attackModeResult: {
        attackModeEnabled: false,
        autoAttackMode: true,
        attackModeAutoCooldownUntil: "2026-09-05T08:30:00Z",
      },
    });
    await render(<ReputationResponseCard />, { wrapper });

    const pending = fireEvent(
      screen.getByLabelText("Attack mode"),
      "valueChange",
      false,
    );
    await flush();
    await fireEvent.press(screen.getByLabelText("Turn off"));
    await flush();
    await pending;

    expect(setMode).toHaveBeenCalledTimes(1);
    expect(setMode.mock.calls[0]?.[0]).toBe(false);
    expect(
      screen.getByText("Attack mode off. The detector is held off for 24 hours."),
    ).toBeTruthy();
  });

  it("turning it ON warns about the subscribers it will turn away", async () => {
    const { setMode } = load({ settings: ATTACK_OFF });
    await render(<ReputationResponseCard />, { wrapper });

    const pending = fireEvent(
      screen.getByLabelText("Attack mode"),
      "valueChange",
      true,
    );
    await flush();

    expect(screen.getByText("Turn on attack mode?")).toBeTruthy();
    expect(
      screen.getByText(/Legitimate subscribers may be turned away/u),
    ).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Turn on"));
    await flush();
    await pending;

    expect(setMode).toHaveBeenCalledTimes(1);
    expect(setMode.mock.calls[0]?.[0]).toBe(true);
    expect(screen.getByText("Attack mode on.")).toBeTruthy();
  });
});

describe("the spam-trap sweep — a check, not a change", () => {
  it("runs immediately with no confirmation, and reads back a CLEAN result", async () => {
    const { sweep } = load({ settings: ATTACK_OFF });
    await render(<ReputationResponseCard />, { wrapper });

    await fireEvent.press(screen.getByLabelText(SWEEP_CONTROL));
    await flush();

    // Deliberately un-gated: it changes nothing, and an incident is the worst
    // moment to add a tap. If a future change adds a confirm, this fails.
    expect(screen.queryByLabelText("Cancel")).toBeNull();
    expect(sweep).toHaveBeenCalledTimes(1);
    // "We checked, you are clean" is a real answer; an empty success toast
    // would leave the operator unsure the run happened at all.
    expect(
      screen.getByText("Sweep finished — no new spam-trap hits were found."),
    ).toBeTruthy();
  });

  it("reports what the sweep actually found", async () => {
    const { sweep } = load({
      settings: ATTACK_OFF,
      sweepResult: { blocklisted: 3, completed_at: "2026-09-04T08:30:00Z" },
    });
    await render(<ReputationResponseCard />, { wrapper });

    await fireEvent.press(screen.getByLabelText(SWEEP_CONTROL));
    await flush();

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Sweep finished — 3 addresses blocklisted."),
    ).toBeTruthy();
  });

  it("does not report a sweep that failed as a sweep that finished", async () => {
    const { sweep } = load({
      settings: ATTACK_OFF,
      sweepResult: Object.assign(new Error("upstream down"), { status: 503 }),
    });
    await render(<ReputationResponseCard />, { wrapper });

    await fireEvent.press(screen.getByLabelText(SWEEP_CONTROL));
    await flush();

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Sweep finished/u)).toBeNull();
    expect(
      screen.getByText(
        "The server had a problem with this request. Please try again.",
      ),
    ).toBeTruthy();
  });
});

describe("who may press them", () => {
  it("shows a viewer the listing and withholds all three verbs", async () => {
    queryHooks.__setOnlineGateForTests({ effectiveRole: "viewer" });
    const { setMode, suppress, sweep } = load({
      settings: ATTACK_ON,
      listed: [LISTED],
    });
    await render(<ReputationResponseCard />, { wrapper });

    // Knowing the workspace is listed on Spamhaus is worth having even when
    // fixing it is not yours to do.
    expect(screen.getByText("203.0.113.9")).toBeTruthy();
    expect(screen.getByText(/tier-1 zone that most receivers act on/u)).toBeTruthy();
    expect(screen.getByText(/Attack mode is ON/u)).toBeTruthy();

    expect(screen.queryByLabelText(SUPPRESS_CONTROL)).toBeNull();
    expect(screen.queryByLabelText("Attack mode")).toBeNull();
    expect(screen.queryByLabelText(SWEEP_CONTROL)).toBeNull();
    expect(setMode).not.toHaveBeenCalled();
    expect(suppress).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });
});
