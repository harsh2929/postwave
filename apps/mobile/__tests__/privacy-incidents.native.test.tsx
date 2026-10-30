import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react-native";
import React from "react";
import {
  AccessibilityInfo,
  DeviceEventEmitter,
  Dimensions,
  StyleSheet,
} from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import PrivacyIncidentsRoute, {
  ErrorBoundary as PrivacyIncidentsErrorBoundary,
} from "../app/(tabs)/privacy-incidents";
import { INCIDENT_DECLARE_OFFLINE_NOTICE } from "../src/components/privacy-incidents/DeclareIncidentSheet";
import { IncidentDetailSheet } from "../src/components/privacy-incidents/IncidentDetailSheet";
import { PrivacyIncidentsScreen } from "../src/components/privacy-incidents/PrivacyIncidentsScreen";
import { ToastProvider } from "../src/components/Toast";
import { INCIDENT_TRANSITION_OFFLINE_NOTICE } from "../src/lib/privacyIncidentPolicy";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");

jest.mock("@/hooks/usePrivacyIncidents", () =>
  require("./mocks/queryHooks.cjs"),
);

// jest-expo stubs expo-crypto's native module, so `randomUUID()` yields
// undefined — which would let the declare test pass without a real key.
jest.mock("expo-crypto", () => ({
  randomUUID: () => "11111111-2222-4333-8444-555555555555",
}));

/**
 * The breach register has four states that a "does it render" test never
 * reaches, and every one of them is a place where the app could state
 * something untrue about a legally significant record:
 *
 *   403 / non-admin — EVERY route in the group is behind
 *     `RequireScope(ScopeAdmin)` (server/tenant_governance.go:112-116), so an
 *     editor legitimately cannot enumerate incidents. "No breach incidents"
 *     there would be an all-clear the app has no basis for.
 *   the CLOCK — a legacy operational target must not be called a legal
 *     deadline. A missing target is a dash, never a zero.
 *   the CLOSE GUARD — closure is release-held. The control is disabled WITH
 *     its reason, not hidden.
 *   the JURISDICTION HOLD — detail returns recognition-only metadata. Nothing
 *     may infer duties, recipients, or deadlines from it.
 */

function incident(over: Record<string, unknown> = {}) {
  return {
    id: "inc-1",
    severity: "high" as const,
    severityRaw: "high",
    status: "open" as const,
    statusRaw: "open",
    summary: "Vendor exposed a subscriber export",
    detectedAt: "2026-07-24T09:00:00Z",
    discoveredAt: "2026-07-24T09:00:00Z",
    clockStartedAt: "2026-07-24T09:00:00Z",
    deadlineAt: "2026-07-27T09:00:00Z",
    counselSignoffAt: "",
    signoffBy: "",
    affectedRegions: ["GDPR"],
    affectedDataCategories: ["email"],
    jurisdictions: ["GDPR"],
    affectedSubjectCount: null,
    templateVersion: "2026-06",
    createdAt: "2026-07-24T09:00:05Z",
    updatedAt: "2026-07-24T09:00:05Z",
    ...over,
  };
}

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function withRegister(
  incidents: Record<string, unknown>[],
  over: Record<string, unknown> = {},
) {
  queryHooks.__setHookResultForTests(
    "usePrivacyIncidents",
    queryResult({
      data: { incidents, nextCursor: "", truncated: false, ...over },
    }),
  );
}

function screenElement(
  Component: React.ComponentType = PrivacyIncidentsScreen,
) {
  return React.createElement(
    ToastProvider,
    null,
    React.createElement(Component),
  );
}

function mutationWith(mutate: unknown) {
  return {
    data: undefined,
    error: null,
    isPending: false,
    mutate,
    mutateAsync: jest.fn(async () => ({})),
    reset: jest.fn(),
    variables: undefined,
  };
}

/**
 * VoiceOver's channel. jest-expo renders as iOS, where a newly mounted
 * alert-role node joins the reading order but is NOT spoken (lib/a11y.ts), so
 * `announce()` is the only thing a VoiceOver user hears (A11Y-3).
 */
let speech: { mockRestore: () => void } | null = null;
function listenForSpeech() {
  const spy = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
  speech = spy;
  return spy;
}

type SheetHost = {
  props: Record<string, unknown>;
  parent: SheetHost | null;
};

/** The declare sheet's own subtree. The register header repeats the offline
 * notice, so "somewhere on screen" would not prove the SHEET said it. */
function declareSheet(result: { getByLabelText: (label: string) => unknown }) {
  let node = result.getByLabelText("Incident summary") as SheetHost | null;
  while (node && node.props.accessibilityViewIsModal !== true) {
    node = node.parent;
  }
  if (!node) throw new Error("the declare sheet is not open");
  return within(node as never);
}

function renderScreen(Component: React.ComponentType = PrivacyIncidentsScreen) {
  return render(screenElement(Component), {
    wrapper: ({ children }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        {children}
      </SafeAreaProvider>
    ),
  });
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  authStore.__resetAuthStateForTests();
  speech?.mockRestore();
  speech = null;
});

describe("privacy-incidents route file", () => {
  /**
   * Renders the ROUTE ENTRY POINT, not just the inner component. Expo Router
   * mounts the default export of app/(tabs)/privacy-incidents.tsx; a screen
   * that renders in isolation while the route file is broken is a screen
   * nobody can open.
   */
  it("mounts the default export the router actually loads", async () => {
    withRegister([incident()]);
    const result = await renderScreen(PrivacyIncidentsRoute);
    expect(result.getByText("Breach incidents")).toBeTruthy();
  });

  it("exports a route-scoped ErrorBoundary", () => {
    expect(typeof PrivacyIncidentsErrorBoundary).toBe("function");
  });
});

describe("breach register", () => {
  it("leads a row with its clock, in words, and never with colour alone", async () => {
    withRegister([incident({ deadlineAt: "2026-07-20T09:00:00Z" })]);
    const result = await renderScreen();
    // The exact overdue magnitude is a function of the wall clock, so the
    // assertion is on the SHAPE of the claim rather than a frozen number.
    expect(result.getByText(/over$/)).toBeTruthy();
    expect(result.getByText(/legacy 72-hour operational target/)).toBeTruthy();
  });

  it("says how many are open beside the total, never a bare count", async () => {
    withRegister([
      incident({ id: "a" }),
      incident({ id: "b", status: "closed", statusRaw: "closed" }),
    ]);
    const result = await renderScreen();
    expect(result.getByText("1 open of 2 incidents")).toBeTruthy();
  });

  it("is an empty STATE, not a silent list, when the register is clean", async () => {
    withRegister([]);
    const result = await renderScreen();
    expect(result.getByText("No breach incidents")).toBeTruthy();
    // A clean register still says what it is not: the subtitle must not be a
    // dash, because the fetch succeeded.
    expect(result.getByText("0 open of 0 incidents")).toBeTruthy();
  });

  it("never renders 'no incidents' for a response-contract failure", async () => {
    queryHooks.__setHookResultForTests(
      "usePrivacyIncidents",
      queryResult({
        isError: true,
        error: {
          status: 0,
          code: "invalid_privacy_incident_response_contract",
        },
      }),
    );
    const result = await renderScreen();
    expect(result.queryByText("No breach incidents")).toBeNull();
    // The counters are unknowable, so they are a dash rather than a zero.
    expect(result.getByText("— open")).toBeTruthy();
  });

  it("treats a restored malformed page as failed, never as an empty register", async () => {
    // `page?.incidents ?? []` is a NULLISH guard, and `orderIncidents` opens
    // with `[...rows]` — the exact spread that shipped "Invalid attempt to
    // spread non-iterable instance" on api-keys. A live payload is normalised
    // by the queryFn; a restored one from an older build's shape is not.
    queryHooks.__setHookResultForTests(
      "usePrivacyIncidents",
      queryResult({
        data: { incidents: {}, nextCursor: "", truncated: false },
      }),
    );
    const result = await renderScreen();
    // The register renders, but makes no counted or empty-state claim.
    expect(result.getByText("Breach incidents")).toBeTruthy();
    expect(result.getByText("— open")).toBeTruthy();
    expect(result.queryByText("No breach incidents")).toBeNull();
    expect(result.queryByText("0 open of 0 incidents")).toBeNull();
  });

  it("explains a 403 instead of claiming the workspace has no incidents", async () => {
    queryHooks.__setHookResultForTests(
      "usePrivacyIncidents",
      queryResult({ isError: true, error: { status: 403 } }),
    );
    const result = await renderScreen();
    expect(result.getByText("The server refused this read")).toBeTruthy();
    expect(result.queryByText("No breach incidents")).toBeNull();
    // ...and the HEADER must not quietly contradict the body. A 403 is not a
    // count: "0 open of 0 incidents" is the same all-clear the empty state was
    // forbidden from making, said in the one place a glance actually lands.
    expect(result.queryByText("0 open of 0 incidents")).toBeNull();
    expect(result.getByText("— open")).toBeTruthy();
  });

  it("hides cached incident rows and countdowns while offline", async () => {
    withRegister([
      incident({
        summary: "Cached incident must stay hidden",
        deadlineAt: "2026-07-20T09:00:00Z",
      }),
    ]);
    queryHooks.__setIsOnlineForTests(false);
    const result = await renderScreen();
    expect(result.queryByText("Cached incident must stay hidden")).toBeNull();
    expect(result.queryByText(/over$/)).toBeNull();
    expect(
      result.getByText(/Connect to your workspace to load the breach register/),
    ).toBeTruthy();
  });

  it("hides cached incident rows when the authenticated query gate closes", async () => {
    withRegister([incident({ summary: "Cached gate-disabled incident" })]);
    queryHooks.__setOnlineGateForTests({ enabled: false });
    const result = await renderScreen();
    expect(result.queryByText("Cached gate-disabled incident")).toBeNull();
    expect(result.getByText("— open")).toBeTruthy();
    expect(
      result.getByText(/Connect to your workspace to load the breach register/),
    ).toBeTruthy();
  });

  it("labels cached rows and countdowns while a live refresh is pending", async () => {
    queryHooks.__setHookResultForTests(
      "usePrivacyIncidents",
      queryResult({
        data: {
          incidents: [incident({ summary: "Pending verification" })],
          nextCursor: "",
          truncated: false,
        },
        isFetching: true,
      }),
    );
    const result = await renderScreen();
    expect(result.getByText("Pending verification")).toBeTruthy();
    expect(
      result.getByText(
        /shown rows and countdowns are from the last successful read/,
      ),
    ).toBeTruthy();
    expect(result.getByText("— open")).toBeTruthy();
  });

  it("labels cached rows stale after a non-authorization refresh failure", async () => {
    queryHooks.__setHookResultForTests(
      "usePrivacyIncidents",
      queryResult({
        data: {
          incidents: [incident({ summary: "Stale protected row" })],
          nextCursor: "",
          truncated: false,
        },
        isError: true,
        error: { status: 500 },
      }),
    );
    const result = await renderScreen();
    expect(result.getByText("Stale protected row")).toBeTruthy();
    expect(
      result.getByText(
        /shown rows and countdowns are stale and may be out of date/,
      ),
    ).toBeTruthy();
  });

  it("clears cached protected rows when the server returns 403", async () => {
    queryHooks.__setHookResultForTests(
      "usePrivacyIncidents",
      queryResult({
        data: {
          incidents: [incident({ summary: "Must disappear after refusal" })],
          nextCursor: "",
          truncated: false,
        },
        isError: true,
        error: { status: 403 },
      }),
    );
    const result = await renderScreen();
    expect(result.queryByText("Must disappear after refusal")).toBeNull();
    expect(result.getByText("The server refused this read")).toBeTruthy();
  });

  it("offers the Declare verb to an online admin", async () => {
    withRegister([incident()]);
    const result = await renderScreen();
    const declare = result.getByLabelText(
      "Declare a preliminary breach incident",
    );
    expect(declare.props.accessibilityState).toEqual({ disabled: false });
    // And no read-only banner: the write path is live for this session.
    expect(result.queryByText("State changes paused")).toBeNull();
  });

  it("declares through the sheet: local refusal first, then a keyed mutate", async () => {
    const mutate = jest.fn();
    queryHooks.__setHookResultForTests("useDeclarePrivacyIncident", {
      data: undefined,
      error: null,
      isPending: false,
      mutate,
      mutateAsync: jest.fn(async () => ({})),
      reset: jest.fn(),
      variables: undefined,
    });
    withRegister([incident()]);
    const result = await renderScreen();
    // The header verb actually OPENS the declare sheet — if the sheet is
    // unwired, the submit control below simply does not exist.
    await fireEvent.press(
      result.getByLabelText("Declare a preliminary breach incident"),
    );
    const submit = result.getByLabelText(
      "Declare the preliminary incident record",
    );
    // An empty summary is refused locally: no request may leave the phone.
    await fireEvent.press(submit);
    expect(mutate).not.toHaveBeenCalled();
    expect(result.getByText("A summary is required.")).toBeTruthy();
    await fireEvent.changeText(
      result.getByLabelText("Incident summary"),
      "  Export bucket left public overnight.  ",
    );
    await fireEvent.press(submit);
    expect(mutate).toHaveBeenCalledTimes(1);
    const vars = mutate.mock.calls[0]?.[0] as {
      severity: string;
      summary: string;
      idempotencyKey: string;
    };
    // The honest default grade, the trimmed narrative, and a real
    // Idempotency-Key — the duplicate-record protection — all travel.
    expect(vars.severity).toBe("investigating");
    expect(vars.summary).toBe("Export bucket left public overnight.");
    expect(typeof vars.idempotencyKey).toBe("string");
    expect(vars.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("speaks the declare sheet's local refusal, not only paints it (A11Y-3)", async () => {
    const mutate = jest.fn();
    queryHooks.__setHookResultForTests(
      "useDeclarePrivacyIncident",
      mutationWith(mutate),
    );
    withRegister([incident()]);
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText("Declare a preliminary breach incident"),
    );
    const spoken = listenForSpeech();
    await fireEvent.press(
      result.getByLabelText("Declare the preliminary incident record"),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(spoken).toHaveBeenCalledWith("A summary is required.");
  });

  it("refuses a declaration in-sheet when the connection drops after opening (A11Y-5)", async () => {
    // The sheet opened online. A declaration pressed after the drop must not
    // be paused and replayed on reconnect: that would record the moment of
    // knowledge as whenever the phone found a signal again.
    const mutate = jest.fn();
    queryHooks.__setHookResultForTests(
      "useDeclarePrivacyIncident",
      mutationWith(mutate),
    );
    withRegister([incident()]);
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText("Declare a preliminary breach incident"),
    );
    // Vacuity floor: online, the sheet says nothing about the connection.
    expect(
      declareSheet(result).queryByText(INCIDENT_DECLARE_OFFLINE_NOTICE),
    ).toBeNull();

    queryHooks.__setIsOnlineForTests(false);
    await result.rerender(screenElement());
    await fireEvent.changeText(
      result.getByLabelText("Incident summary"),
      "Export bucket left public overnight.",
    );
    await fireEvent.press(
      result.getByLabelText("Declare the preliminary incident record"),
    );

    expect(mutate).not.toHaveBeenCalled();
    expect(
      declareSheet(result).getByText(INCIDENT_DECLARE_OFFLINE_NOTICE),
    ).toBeTruthy();
    // The rail's sentence is about a state move and its reason; a declaration
    // has neither, so the sheet does not borrow it.
    expect(
      declareSheet(result).queryByText(INCIDENT_TRANSITION_OFFLINE_NOTICE),
    ).toBeNull();
    expect(
      result.getByLabelText("Declare the preliminary incident record").props
        .accessibilityState,
    ).toMatchObject({ disabled: true });

    // Back online, the same draft goes out — once, by the operator's press.
    queryHooks.__setIsOnlineForTests(true);
    await result.rerender(screenElement());
    expect(
      declareSheet(result).queryByText(INCIDENT_DECLARE_OFFLINE_NOTICE),
    ).toBeNull();
    await fireEvent.press(
      result.getByLabelText("Declare the preliminary incident record"),
    );
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      summary: "Export bucket left public overnight.",
    });
  });

  it("keeps a closed declare sheet silent, and lets an open one speak its gate (A11Y-3)", async () => {
    // The sheet is always mounted and reads the screen's live gate. Closed, it
    // has nothing on screen to speak for: its sentence used to land just after
    // the register's own offline message and cut it off, on every offline
    // visit.
    const spoken = listenForSpeech();
    withRegister([incident()]);
    queryHooks.__setIsOnlineForTests(false);
    const result = await renderScreen();
    expect(result.queryByLabelText("Incident summary")).toBeNull();
    const saidClosed = spoken.mock.calls.map(([text]) => text);
    // Vacuity floor: the spy does hear this screen, so the silence is real.
    expect(saidClosed).toContainEqual(
      expect.stringMatching(
        /^Connect to your workspace to load the breach register/u,
      ),
    );
    expect(saidClosed).not.toContain(INCIDENT_TRANSITION_OFFLINE_NOTICE);
    expect(saidClosed).not.toContain(INCIDENT_DECLARE_OFFLINE_NOTICE);

    // Opened online, then the connection drops under it: now the sentence is
    // on screen, so it is spoken, in the sheet's own words.
    queryHooks.__setIsOnlineForTests(true);
    await result.rerender(screenElement());
    await fireEvent.press(
      result.getByLabelText("Declare a preliminary breach incident"),
    );
    spoken.mockClear();
    queryHooks.__setIsOnlineForTests(false);
    await result.rerender(screenElement());
    expect(
      declareSheet(result).getByText(INCIDENT_DECLARE_OFFLINE_NOTICE),
    ).toBeTruthy();
    expect(spoken).toHaveBeenCalledWith(INCIDENT_DECLARE_OFFLINE_NOTICE);
    expect(spoken).not.toHaveBeenCalledWith(INCIDENT_TRANSITION_OFFLINE_NOTICE);
  });

  it("never tells an operator whose role is still resolving that the connection is down (A11Y-3)", async () => {
    // A gate closed for no stated reason leaves the submit inert without
    // inventing one. The old fallback showed and spoke "State changes need a
    // live connection" to an operator who was online.
    const mutate = jest.fn();
    queryHooks.__setHookResultForTests(
      "useDeclarePrivacyIncident",
      mutationWith(mutate),
    );
    withRegister([incident()]);
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText("Declare a preliminary breach incident"),
    );
    await fireEvent.changeText(
      result.getByLabelText("Incident summary"),
      "Export bucket left public overnight.",
    );
    const spoken = listenForSpeech();
    authStore.__setAuthStateForTests({ session: { effectiveRole: null } });
    await result.rerender(screenElement());

    const submit = result.getByLabelText(
      "Declare the preliminary incident record",
    );
    // Vacuity floor: the gate really is closed for this session.
    expect(submit.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(submit);
    expect(mutate).not.toHaveBeenCalled();
    expect(declareSheet(result).queryByText(/live connection/u)).toBeNull();
    const said = spoken.mock.calls.map(([text]) => String(text));
    expect(said.filter((text) => /live connection/u.test(text))).toEqual([]);
  });

  it("pauses writes offline, with the no-replay reason said out loud", async () => {
    withRegister([incident()]);
    queryHooks.__setIsOnlineForTests(false);
    const result = await renderScreen();
    expect(result.getByText("State changes paused")).toBeTruthy();
    expect(result.getByText(INCIDENT_TRANSITION_OFFLINE_NOTICE)).toBeTruthy();
    // The verb stays discoverable but inert — a write is never queued.
    expect(
      result.getByLabelText(/Declare a preliminary breach incident\. Needs a/)
        .props.accessibilityState,
    ).toEqual({ disabled: true });
  });

  it("discloses that the page is a sample when the server offered more", async () => {
    withRegister([incident()], { nextCursor: "eyJrIjoi", truncated: true });
    const result = await renderScreen();
    expect(
      result.getByText(
        "These counts cover the 1 most recent incident only — older history is on the web admin.",
      ),
    ).toBeTruthy();
    // And the subtitle stops claiming a workspace total it does not have.
    expect(result.getByText("1 open in the newest 1 incident")).toBeTruthy();
  });

  it("states the live verbs and the still-release-held boundaries", async () => {
    withRegister([incident()]);
    const result = await renderScreen();
    expect(
      result.getByText(
        /Declare a preliminary record and record non-closure state changes here/,
      ),
    ).toBeTruthy();
    expect(
      result.getByText(/incident closure are release-held in every client/),
    ).toBeTruthy();
  });

  /**
   * EVERY route in this group — the list included — is behind
   * `RequireScope(ScopeAdmin)`, which on the session path is an owner|admin
   * role check. There is no read-only tier to degrade to, so a non-admin gets
   * the refusal and nothing else. Rendering the register's empty state here
   * would tell somebody who cannot see the breaches that there are none.
   */
  it("refuses the whole screen for a non-admin without claiming it is empty", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "editor" } });
    withRegister([]);
    const result = await renderScreen();
    expect(
      result.getByText("Breach incidents need an owner or admin role"),
    ).toBeTruthy();
    expect(result.queryByText("No breach incidents")).toBeNull();
    expect(result.queryByText("0 open of 0 incidents")).toBeNull();
  });

  it("renders no verdict at all while the session role is still unknown", async () => {
    // `read.known` false — a screen that guessed here would flash a refusal at
    // an owner during hydration.
    authStore.__setAuthStateForTests({ session: null, mode: null });
    withRegister([]);
    const result = await renderScreen();
    expect(
      result.queryByText("Breach incidents need an owner or admin role"),
    ).toBeNull();
  });
});

/**
 * The detail sheet, rendered directly.
 *
 * Three claims live only here, and all three are places where the app could
 * assert something about a sensitive record that nobody established:
 *   - jurisdiction metadata may NEVER be rendered as an obligation;
 *   - "Close incident" is offered DISABLED with its reason, never hidden;
 *   - a failed ledger read is not an incident with no activity.
 */
describe("incident detail sheet", () => {
  function sheet(over: Record<string, unknown> = {}) {
    const row = incident();
    return render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <ToastProvider>
          <IncidentDetailSheet
            incident={row}
            detail={null}
            detailLoading
            detailFailed={false}
            events={[]}
            eventsLoading
            eventsFailed={false}
            onClose={() => undefined}
            canTransition
            transitionNotice={null}
            onFreshReadNeeded={() => undefined}
            now={Date.UTC(2026, 6, 25, 12, 0, 0)}
            {...over}
          />
        </ToastProvider>
      </SafeAreaProvider>,
    );
  }

  it("offers non-closure moves live and keeps the closure hold spoken", async () => {
    const result = await sheet();
    expect(
      result.getByLabelText("Mark contained").props.accessibilityState,
    ).toEqual({ disabled: false });
    expect(
      result.getByLabelText("Move to notifying").props.accessibilityState,
    ).toEqual({ disabled: false });
    const close = result.getByLabelText(
      /^Close incident\. Incident closure is release-held/,
    );
    expect(close.props.accessibilityState).toEqual({ disabled: true });
  });

  it("keeps every move inert when the session cannot write", async () => {
    const result = await sheet({
      canTransition: false,
      transitionNotice: INCIDENT_TRANSITION_OFFLINE_NOTICE,
    });
    expect(
      result.getByLabelText("Mark contained").props.accessibilityState,
    ).toEqual({ disabled: true });
    expect(result.getByText(INCIDENT_TRANSITION_OFFLINE_NOTICE)).toBeTruthy();
  });

  it("keeps close held when a legacy sign-off field exists", async () => {
    const result = await sheet({
      incident: incident({ counselSignoffAt: "2026-07-25T09:00:00Z" }),
    });
    const close = result.getByLabelText(
      /^Close incident\. Incident closure is release-held/,
    );
    expect(close.props.accessibilityState).toEqual({ disabled: true });
  });

  it("demands a reason and a verified state before recording a move", async () => {
    const mutate = jest.fn();
    queryHooks.__setHookResultForTests("useTransitionPrivacyIncident", {
      data: undefined,
      error: null,
      isPending: false,
      mutate,
      mutateAsync: jest.fn(async () => ({})),
      reset: jest.fn(),
      variables: undefined,
    });
    const onFreshReadNeeded = jest.fn();
    const result = await sheet({
      // The verified detail read has landed: expected_from is assertable.
      detail: incident(),
      detailLoading: false,
      onFreshReadNeeded,
    });
    await fireEvent.press(result.getByLabelText("Mark contained"));
    // Picking a move re-reads the record before anything is asserted.
    expect(onFreshReadNeeded).toHaveBeenCalled();
    // An empty reason is refused locally — the endpoint requires one.
    await fireEvent.press(result.getByLabelText("Confirm contained"));
    expect(mutate).not.toHaveBeenCalled();
    expect(result.getByText("A reason is required.")).toBeTruthy();
    await fireEvent.changeText(
      result.getByLabelText("Reason for the state change"),
      "Vendor rotated the leaked key; export access revoked.",
    );
    await fireEvent.press(result.getByLabelText("Confirm contained"));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: "inc-1",
        to: "contained",
        reason: "Vendor rotated the leaked key; export access revoked.",
        expectedFrom: "open",
      }),
      expect.anything(),
    );
  });

  it("speaks the transition rail's local refusal, not only paints it (A11Y-3)", async () => {
    const mutate = jest.fn();
    queryHooks.__setHookResultForTests(
      "useTransitionPrivacyIncident",
      mutationWith(mutate),
    );
    const result = await sheet({ detail: incident(), detailLoading: false });
    await fireEvent.press(result.getByLabelText("Mark contained"));
    const spoken = listenForSpeech();
    await fireEvent.press(result.getByLabelText("Confirm contained"));
    expect(mutate).not.toHaveBeenCalled();
    expect(spoken).toHaveBeenCalledWith("A reason is required.");
  });

  it("withholds the confirm while the fresh re-read is still in flight", async () => {
    const result = await sheet({ detail: null, detailLoading: true });
    await fireEvent.press(result.getByLabelText("Mark contained"));
    expect(
      result.getByText(/Verifying the record's current state/),
    ).toBeTruthy();
    expect(
      result.getByLabelText("Confirm contained").props.accessibilityState,
    ).toEqual({ disabled: true });
  });

  it("never states an obligation before the detail release hold has landed", async () => {
    const result = await sheet();
    expect(
      result.getByLabelText("Loading jurisdiction release-hold status"),
    ).toBeTruthy();
    expect(result.queryByText(/No jurisdiction in the matrix/)).toBeNull();
  });

  it("shows recognition metadata only under an explicit release hold", async () => {
    const result = await sheet({
      detail: {
        ...incident(),
        jurisdictionResolution: {
          status: "release_held",
          releaseHoldCode: "jurisdiction_rules_release_hold",
          recognized: [{ code: "GDPR", name: "European Union / EEA" }],
          unknown: ["ZZ"],
        },
      },
      detailLoading: false,
    });
    expect(
      result.getByText(/Legal obligation guidance is release-held/),
    ).toBeTruthy();
    expect(
      result.getByText(/Recognized selection metadata: GDPR/),
    ).toBeTruthy();
    expect(result.getByText(/Unrecognized codes: ZZ/)).toBeTruthy();
  });

  it("distinguishes a failed ledger read from an incident with no activity", async () => {
    const result = await sheet({ eventsLoading: false, eventsFailed: true });
    expect(
      result.getByText(/not the same as an incident with no activity/),
    ).toBeTruthy();
    expect(result.queryByText(/Nothing has been recorded/)).toBeNull();
  });

  it("gates cached detail and ledger evidence during reopen verification", async () => {
    const result = await sheet({
      detail: {
        ...incident({ summary: "Cached detail title" }),
        jurisdictionResolution: {
          status: "release_held",
          releaseHoldCode: "jurisdiction_rules_release_hold",
          recognized: [{ code: "GDPR", name: "European Union / EEA" }],
          unknown: [],
        },
      },
      detailLoading: true,
      events: [
        {
          eventId: "event-1",
          source: "incident_state_transitions",
          schemaVersion: 1,
          kind: "transition",
          at: "2026-07-25T09:00:00Z",
          fromState: "open",
          toState: "contained",
          reason: "Cached event must stay hidden",
        },
      ],
      eventsLoading: true,
    });
    expect(result.queryByText("Cached detail title")).toBeNull();
    expect(
      result.queryByText(/Recognized selection metadata: GDPR/),
    ).toBeNull();
    expect(result.queryByText(/Cached event must stay hidden/)).toBeNull();
    expect(
      result.getByLabelText("Loading jurisdiction release-hold status"),
    ).toBeTruthy();
    expect(result.getByLabelText("Loading the incident ledger")).toBeTruthy();
  });

  it("shows an em-dash for an unrecorded subject count, never a zero", async () => {
    const result = await sheet();
    expect(
      result.getByLabelText("People affected: Affected people not recorded"),
    ).toBeTruthy();
  });

  it("says the sheet has no move left once the incident is closed", async () => {
    const result = await sheet({
      incident: incident({ status: "closed", statusRaw: "closed" }),
    });
    expect(result.getByText(/no move left from here/)).toBeTruthy();
    expect(result.queryByLabelText("Mark contained")).toBeNull();
  });

  /**
   * The reason field, its alert and Cancel/Confirm live in the footer BELOW
   * the scroll body, in a pageSheet modal — a view controller presented over
   * the route, so nothing on the presenting route can lift it. Without an
   * avoider in the sheet the iOS keyboard covers the very field the operator
   * is typing into, and the only control that records the move.
   *
   * And the avoider has to know WHERE the sheet is (A11Y-2): on an iPhone the
   * card starts ~54pt below the top of the same window the keyboard's
   * coordinates are measured in.
   */
  describe("the keyboard", () => {
    type HostLike = {
      type: unknown;
      props: Record<string, unknown>;
      parent: HostLike | null;
    };

    async function composing() {
      const result = await sheet({ detail: incident(), detailLoading: false });
      await fireEvent.press(result.getByLabelText("Mark contained"));
      return result;
    }

    /** The KeyboardAvoidingView's host: `behavior="padding"` renders a View
     * with its own `onLayout` and a style composed as
     * `[style, {paddingBottom: n}]`. */
    function keyboardAvoider(from: unknown): HostLike | null {
      let node = (from as HostLike).parent;
      while (node) {
        const style = node.props.style;
        if (
          typeof node.type === "string" &&
          typeof node.props.onLayout === "function" &&
          Array.isArray(style) &&
          style.length === 2 &&
          style[1] !== null &&
          typeof style[1] === "object" &&
          "paddingBottom" in style[1]
        ) {
          return node;
        }
        node = node.parent;
      }
      return null;
    }

    /** The outermost host inside the Modal. A pageSheet's modal root is
     * exactly as big as the card, so this is where the SHEET's own size lands
     * on a device. */
    function sheetRoot(from: unknown): HostLike {
      let node = from as HostLike | null;
      while (node?.parent && node.parent.type !== "Modal") node = node.parent;
      if (!node?.parent) throw new Error("no Modal above this node");
      return node;
    }

    /** Native layout: dispatched only to a view that asked for it, and it
     * never bubbles — so no fireEvent, which would walk to an ancestor. */
    async function layOut(
      node: HostLike,
      layout: { x: number; y: number; width: number; height: number },
    ) {
      const onLayout = node.props.onLayout;
      if (typeof onLayout !== "function") return;
      await act(async () => {
        (onLayout as (e: unknown) => void)({
          nativeEvent: { layout },
          persist: () => {},
        });
      });
    }

    async function keyboardRisesTo(screenY: number, height: number) {
      await act(async () => {
        DeviceEventEmitter.emit("keyboardWillShow", {
          duration: 0,
          easing: "keyboard",
          isEventFromThisApp: true,
          startCoordinates: {
            screenX: 0,
            screenY: screenY + height,
            width: 390,
            height,
          },
          endCoordinates: { screenX: 0, screenY, width: 390, height },
        });
      });
    }

    async function expectAvoiderPadding(
      result: { getByLabelText: (label: string) => unknown },
      paddingBottom: number,
    ) {
      await waitFor(() => {
        const lifted = keyboardAvoider(
          result.getByLabelText("Reason for the state change"),
        );
        expect(StyleSheet.flatten(lifted!.props.style as never)).toMatchObject(
          { paddingBottom },
        );
      });
    }

    it("lifts the reason field and Confirm above the keyboard", async () => {
      const result = await composing();
      const reason = result.getByLabelText("Reason for the state change");
      const avoider = keyboardAvoider(reason);
      if (!avoider) {
        throw new Error("no keyboard-avoiding ancestor above the reason field");
      }
      // Confirm rides the same avoider — lifting the field alone would still
      // bury the only control that records the move.
      expect(
        keyboardAvoider(result.getByLabelText("Confirm contained")),
      ).toBe(avoider);
      expect(StyleSheet.flatten(avoider.props.style as never)).toMatchObject({
        paddingBottom: 0,
      });

      // A full-height sheet, then an iOS keyboard whose top edge sits 300pt
      // up from the bottom of an 844pt screen.
      await act(async () => {
        (avoider.props.onLayout as (e: unknown) => void)({
          nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } },
          persist: () => {},
        });
      });
      await act(async () => {
        DeviceEventEmitter.emit("keyboardWillShow", {
          duration: 0,
          easing: "keyboard",
          isEventFromThisApp: true,
          startCoordinates: { screenX: 0, screenY: 844, width: 390, height: 300 },
          endCoordinates: { screenX: 0, screenY: 544, width: 390, height: 300 },
        });
      });

      await waitFor(() => {
        const lifted = keyboardAvoider(
          result.getByLabelText("Reason for the state change"),
        );
        expect(StyleSheet.flatten(lifted!.props.style as never)).toMatchObject(
          { paddingBottom: 300 },
        );
      });
    });

    it("counts the sheet's drop below the window top into the lift (A11Y-2)", async () => {
      const result = await composing();
      const { width, height: windowHeight } = Dimensions.get("window");
      // An iPhone pageSheet: a card whose top edge sits 54pt below the top of
      // the window and whose bottom is the window's bottom. The avoider fills
      // it above a 34pt home-indicator inset — its onLayout frame is relative
      // to the card, so it reports y=0 however far down the card starts.
      const sheetTop = 54;
      const sheetHeight = windowHeight - sheetTop;
      const avoider = keyboardAvoider(
        result.getByLabelText("Reason for the state change"),
      );
      if (!avoider) throw new Error("no keyboard-avoiding ancestor");
      await layOut(sheetRoot(avoider), {
        x: 0,
        y: 0,
        width,
        height: sheetHeight,
      });
      await layOut(
        keyboardAvoider(result.getByLabelText("Reason for the state change"))!,
        { x: 0, y: 0, width, height: sheetHeight - 34 },
      );
      // A 336pt keyboard, in SCREEN coordinates like every iOS keyboard frame.
      await keyboardRisesTo(windowHeight - 336, 336);

      // The avoider's bottom is 34pt above the window bottom and the
      // keyboard's top edge 336pt above it: the footer must rise 302pt. Read
      // parent-relative, the frame says 248 — and the missing 54pt is the
      // Cancel/Confirm row.
      await expectAvoiderPadding(result, 302);
    });

    it("adds nothing when the sheet fills the window (A11Y-2 control)", async () => {
      const result = await composing();
      const { width, height: windowHeight } = Dimensions.get("window");
      const avoider = keyboardAvoider(
        result.getByLabelText("Reason for the state change"),
      );
      if (!avoider) throw new Error("no keyboard-avoiding ancestor");
      // Full-screen presentation (iPhone landscape, Android): the card IS the
      // window, so there is no drop to add and nothing may be counted twice.
      await layOut(sheetRoot(avoider), {
        x: 0,
        y: 0,
        width,
        height: windowHeight,
      });
      await layOut(
        keyboardAvoider(result.getByLabelText("Reason for the state change"))!,
        { x: 0, y: 0, width, height: windowHeight },
      );
      await keyboardRisesTo(windowHeight - 300, 300);

      await expectAvoiderPadding(result, 300);
    });

    it("lets a tap on the sheet body land while the keyboard is up", async () => {
      const result = await composing();
      const scrollers = (
        result.root as unknown as {
          queryAll: (p: (el: HostLike) => boolean) => HostLike[];
        }
      ).queryAll((el) => el.type === "RCTScrollView");
      // Vacuity floor: the sheet has to have rendered its scroll body at all.
      expect(scrollers.length).toBeGreaterThan(0);
      for (const scroller of scrollers) {
        // RN's default, "never", spends the first tap dismissing the keyboard.
        expect(scroller.props.keyboardShouldPersistTaps).toBe("handled");
      }
    });
  });
});
