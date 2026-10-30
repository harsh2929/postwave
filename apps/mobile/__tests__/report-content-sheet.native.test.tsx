/**
 * ReportContentSheet — the in-app "report this" control, rendered for real.
 *
 * WHY THIS FILE EXISTS. The report path is a condition of distribution (Apple
 * Guideline 1.2, Google Play's UGC and generative-AI policies), and until now
 * the only test near it was a source scan: the ai-chat suite mounts the sheet
 * with a null target, so the send / sent / error branches never ran. That is
 * how an editor reporting harmful model output came to be told "Try again —
 * your report is still here" on every retry of a 403 that no retry can clear.
 *
 * Only `../src/api/sdkClient` is mocked, so the REAL rawRequest → sdkResult →
 * checkedApiResult → errorCopy chain runs between the button and the fake
 * transport, and every rejection below is SDK-shaped with the exact body
 * apps/api writes.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { DeviceEventEmitter, Platform, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { REPORT_GROUNDS, type ReportGround } from "../src/api/contentReports";
import {
  ReportContentSheet,
  type ReportTarget,
} from "../src/components/ReportContentSheet";
import { ReportForm } from "../src/components/ReportContentSheetViews";

const mockRequest = jest.fn<(...args: unknown[]) => Promise<unknown>>();

// jest.routes.config.cjs maps the `@/api/sdkClient` SPECIFIER, but
// src/api/request.ts reaches the client through `./sdkClient`, which the mapper
// never sees. Mocking the resolved module routes every importer to this one fn.
jest.mock("../src/api/sdkClient", () => ({
  getClient: () => ({ client: { request: mockRequest } }),
}));

const RETRY_COPY = /Try again — your report is still here/;
// RNTL resolves `accessibilityLabelledBy` before `accessibilityLabel`, so the
// field answers to its visible heading.
const EXPLANATION_FIELD = "Tell us more";
const TYPED = "The reply told me to harass a named person at work.";

const AI_TARGET: ReportTarget = {
  kind: "ai_output",
  ref: "msg-42",
  label: "Here is a welcome email…",
};
const THREAD_TARGET: ReportTarget = {
  kind: "inbound_message",
  ref: "conv-7",
  label: "Re: your order",
};

/** routeauth.writeRouteRoleDenial (denials.go), which every viewer/editor
 * session receives today: the generated manifest fails the route closed to
 * `admin`. */
const ROLE_DENIAL = {
  error: {
    subject: "route",
    reason: "role",
    code: "insufficient_role",
    message: "your role does not have permission for this route",
  },
};
const INVALID_REPORT = {
  error: {
    code: "invalid_report",
    message: "contentreports: explanation must substantiate the report",
  },
};

function sdkError(status: number, body: { error: { code: string; message: string } }) {
  return Object.assign(new Error(body.error.message), {
    status,
    code: body.error.code,
    payload: body,
  });
}

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

async function open(target: ReportTarget = AI_TARGET) {
  return render(<ReportContentSheet target={target} onClose={jest.fn()} />, {
    wrapper,
  });
}

async function type(text: string) {
  await fireEvent.changeText(screen.getByLabelText(EXPLANATION_FIELD), text);
}

function sendButton() {
  return screen.getByLabelText("Send report");
}

beforeEach(() => {
  mockRequest.mockReset();
});

describe("what reaches the server", () => {
  it("model output is filed in the generative-AI bucket with the trimmed explanation", async () => {
    mockRequest.mockResolvedValueOnce({
      reference: "PWR-7Q2K",
      received_at: "2026-09-14T10:00:00Z",
    });
    await open(AI_TARGET);

    await type(`  ${TYPED}\n`);
    await fireEvent.press(sendButton());

    await screen.findByText("Report sent");
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith("POST", "/api/v1/content-reports", {
      body: {
        origin: "in_app_ai_output",
        subject_kind: "ai_output",
        subject_ref: "msg-42",
        reason_category: "ai_output_harmful",
        explanation: TYPED,
      },
    });
  });

  it("a stranger's message is filed as UGC, pre-selected as harassment", async () => {
    mockRequest.mockResolvedValueOnce({ reference: "PWR-8M3N", received_at: "x" });
    await open(THREAD_TARGET);

    await type(TYPED);
    await fireEvent.press(sendButton());

    await screen.findByText("Report sent");
    expect(mockRequest).toHaveBeenCalledWith("POST", "/api/v1/content-reports", {
      body: {
        origin: "in_app_ugc",
        subject_kind: "inbound_message",
        subject_ref: "conv-7",
        reason_category: "harassment_or_hate",
        explanation: TYPED,
      },
    });
  });
});

describe("sent", () => {
  it("a 201 confirms and shows the reference the reporter can quote", async () => {
    mockRequest.mockResolvedValueOnce({
      reference: "PWR-7Q2K",
      received_at: "2026-09-14T10:00:00Z",
    });
    await open();

    await type(TYPED);
    await fireEvent.press(sendButton());

    expect(await screen.findByText("Report sent")).toBeTruthy();
    expect(screen.getByText(/Reference PWR-7Q2K\./)).toBeTruthy();
    expect(screen.queryByLabelText("Send report")).toBeNull();
  });

  it("a 2xx without a top-level reference still confirms, and prints no empty reference", async () => {
    mockRequest.mockResolvedValueOnce({ data: { reference: "PWR-7Q2K" } });
    await open();

    await type(TYPED);
    await fireEvent.press(sendButton());

    expect(await screen.findByText("Report sent")).toBeTruthy();
    expect(screen.getByText(/A person reviews every report/)).toBeTruthy();
    expect(screen.queryByText(/Reference/)).toBeNull();
  });
});

describe("refused", () => {
  it("a role denial says so, offers no retry, and keeps what was typed", async () => {
    mockRequest.mockRejectedValueOnce(sdkError(403, ROLE_DENIAL));
    await open();

    await type(TYPED);
    await fireEvent.press(sendButton());

    expect(await screen.findByText(/role/i)).toBeTruthy();
    expect(screen.queryByText(RETRY_COPY)).toBeNull();
    expect(screen.queryByText("Report sent")).toBeNull();
    expect(screen.getByDisplayValue(TYPED)).toBeTruthy();
  });

  it("a 400 is a validation sentence — no retry copy, never the raw server message", async () => {
    mockRequest.mockRejectedValueOnce(sdkError(400, INVALID_REPORT));
    await open();

    await type(TYPED);
    await fireEvent.press(sendButton());

    expect(
      await screen.findByText(
        "This report couldn't be accepted as written. The explanation needs 20 to 10,000 characters.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(RETRY_COPY)).toBeNull();
    expect(screen.queryByText(/contentreports:/)).toBeNull();
    expect(screen.getByDisplayValue(TYPED)).toBeTruthy();
  });

  it("a dropped connection keeps the report in the field and offers the retry", async () => {
    mockRequest.mockRejectedValueOnce(new TypeError("Network request failed"));
    await open();

    await type(TYPED);
    await fireEvent.press(sendButton());

    expect(await screen.findByText(RETRY_COPY)).toBeTruthy();
    expect(screen.queryByText("Report sent")).toBeNull();
    expect(screen.getByDisplayValue(TYPED)).toBeTruthy();
    expect(sendButton().props.accessibilityState).toMatchObject({ disabled: false });
  });
});

describe("the Send gate counts what the server counts", () => {
  it("ten emoji are ten characters, not twenty: Send stays off and nothing is sent", async () => {
    await open();

    await type("\u{1F92C}".repeat(10));

    expect(sendButton().props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(sendButton());
    expect(mockRequest).not.toHaveBeenCalled();
    expect(screen.getByText("10 more characters so we can act on it.")).toBeTruthy();
  });

  it("over 10,000 characters: Send stays off, nothing is sent, and no negative count", async () => {
    await open();

    // fireEvent.changeText bypasses maxLength, which is the paste-past-the-cap
    // case the gate still has to hold for.
    await type("x".repeat(10001));

    expect(sendButton().props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(sendButton());
    expect(mockRequest).not.toHaveBeenCalled();
    expect(screen.queryByText(/-\d+ more character/)).toBeNull();
    expect(screen.getByText("Keep it to 10,000 characters or fewer.")).toBeTruthy();
  });

  it("the field itself stops at the server's cap", async () => {
    await open();

    expect(screen.getByLabelText(EXPLANATION_FIELD).props.maxLength).toBe(10000);
  });
});

type HostLike = {
  type: unknown;
  props: Record<string, unknown>;
  parent: HostLike | null;
};

/** The KeyboardAvoidingView's host: `behavior="padding"` renders a View with
 * its own `onLayout` and a style composed as `[style, {paddingBottom: n}]`. */
function keyboardAvoider(): HostLike | null {
  let node = (sendButton() as unknown as HostLike).parent;
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

describe("the keyboard", () => {
  it("lifts the card, Send button included, when the keyboard opens", async () => {
    await open();

    const avoider = keyboardAvoider();
    if (!avoider) throw new Error("no keyboard-avoiding ancestor above Send report");
    expect(StyleSheet.flatten(avoider.props.style as never)).toMatchObject({
      paddingBottom: 0,
    });

    // A full-height sheet, then an iOS keyboard whose top edge sits 300pt up
    // from the bottom of an 844pt screen.
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
      expect(StyleSheet.flatten(keyboardAvoider()!.props.style as never)).toMatchObject({
        paddingBottom: 300,
      });
    });
  });

  it("a tap on Send lands while the keyboard is up", async () => {
    const view = await open();

    const scrollers = (
      view.root as unknown as {
        queryAll: (p: (el: HostLike) => boolean) => HostLike[];
      }
    ).queryAll((el) => el.type === "RCTScrollView");
    // Vacuity floor: the sheet has to have rendered its scroll body at all.
    expect(scrollers.length).toBeGreaterThan(0);
    for (const scroller of scrollers) {
      // RN's default, "never", spends the first tap dismissing the keyboard —
      // so Send, Cancel and the grounds each need two taps while it is open.
      expect(scroller.props.keyboardShouldPersistTaps).toBe("handled");
    }
  });
});

/**
 * The ground chips, as a screen reader meets them.
 *
 * They declared `accessibilityRole="radio"` with `accessibilityState={{
 * selected }}`. React Native's iOS trait table maps `radio` to
 * UIAccessibilityTraitNone, and it builds the "checked"/"unchecked" value only
 * from `accessibilityState.checked` — so VoiceOver never said a chip could be
 * tapped, nor which ground was chosen, and TalkBack read the chosen one as
 * "radio button, not checked". SegmentedControl made the same repair for `tab`:
 * the role is picked per platform at render time.
 */
describe("the ground chips", () => {
  const realOS = Platform.OS;
  function runningOn(os: "ios" | "android") {
    Object.defineProperty(Platform, "OS", { configurable: true, value: os });
  }
  afterEach(() => {
    Object.defineProperty(Platform, "OS", { configurable: true, value: realOS });
  });

  async function renderGrounds(ground: ReportGround) {
    return render(
      <ReportForm
        ground={ground}
        onGroundChange={() => undefined}
        explanation=""
        onExplanationChange={() => undefined}
        state={{ status: "idle" }}
        ready={false}
        remaining={20}
        onSend={() => undefined}
        onCancel={() => undefined}
      />,
    );
  }

  // `toEqual`, not `toMatchObject`: a `selected` kept beside `checked` makes
  // both platforms say "checked … selected" for one chip.
  it("on iOS every ground is a button, and only the chosen one reads as checked", async () => {
    runningOn("ios");
    const view = await renderGrounds("harassment_or_hate");

    expect(view.queryAllByRole("radio")).toHaveLength(0);
    for (const g of REPORT_GROUNDS) {
      expect(view.getByRole("button", { name: g.label }).props.accessibilityState).toEqual({
        checked: g.value === "harassment_or_hate",
      });
    }
  });

  it("on Android every ground is a radio button, checked the same way", async () => {
    runningOn("android");
    const view = await renderGrounds("ai_output_harmful");

    expect(view.getAllByRole("radio")).toHaveLength(REPORT_GROUNDS.length);
    for (const g of REPORT_GROUNDS) {
      expect(view.getByRole("radio", { name: g.label }).props.accessibilityState).toEqual({
        checked: g.value === "ai_output_harmful",
      });
    }
  });

  it("choosing another ground moves the check, and that ground is what is filed", async () => {
    runningOn("ios");
    mockRequest.mockResolvedValueOnce({ reference: "PWR-9P4R", received_at: "x" });
    await open(THREAD_TARGET);

    await fireEvent.press(screen.getByRole("button", { name: "Spam" }));

    expect(screen.getByRole("button", { name: "Spam" }).props.accessibilityState).toEqual({
      checked: true,
    });
    expect(
      screen.getByRole("button", { name: "Harassment, threats or hate speech" }).props
        .accessibilityState,
    ).toEqual({ checked: false });

    await type(TYPED);
    await fireEvent.press(sendButton());
    await screen.findByText("Report sent");
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/content-reports",
      expect.objectContaining({
        body: expect.objectContaining({ reason_category: "spam_or_unsolicited" }),
      }),
    );
  });
});
