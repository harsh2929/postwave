/**
 * The pre-send voice-fidelity check, at the one place a send is confirmed.
 *
 * WHAT THIS PINS, and why the pure unit test of lib/voiceDrift is not enough.
 * The drift scorer's value on a phone is entirely in WHERE it is offered: a
 * card that renders on the Voice tab tells an operator something interesting;
 * the same card inside the send confirmation is the difference between
 * catching off-brand copy and mailing it. So the assertions here are about the
 * COMPOSITION — that the card is offered only to a role the endpoint will
 * actually serve, that a critical verdict escalates the send to the typed
 * confirmation, and that the verdict does not survive a change of copy.
 *
 * THE AUTHORISATION THIS FILE PINS. POST /api/v1/voice/drift is
 * `apikeys.RequireScope(write:campaigns)` at the mount site (apps/api/main.go
 * :4146) AND `"session_minimum_role": "editor"` in
 * apps/api/internal/routeauth/manifest.json, which routeauth.Middleware
 * evaluates independently. Both floors are editor, so a viewer must not be
 * offered the button — that is the "viewer" case below, and it is the reason
 * the gate override sets `effectiveRole` explicitly rather than leaning on the
 * default fixture.
 *
 * WHY THE MUTATION CALLBACK IS INVOKED DIRECTLY. The shared react-query mock
 * returns a fixed mutation shape, so a `mutate()` never resolves into `data`.
 * Reaching for the captured `onSuccess` is not a shortcut around the product
 * logic — it IS the product logic under test: the card lifts its reading to
 * the send sheet through that callback, and everything the sheet then decides
 * (override ladder, button label, warning copy) hangs off the lifted value.
 */
import { describe, expect, it, jest, afterEach } from "@jest/globals";
import { act, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as ReactQuery from "@tanstack/react-query";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";
import * as GateHooks from "@/hooks/useOnlineQueryGate";
import { readVoiceDrift, type VoiceDriftReading } from "@/lib/voiceDrift";

import { CampaignSendModal } from "../src/components/campaigns/CampaignSendModal";

jest.mock("@/api/voiceDrift", () => ({
  __esModule: true,
  runVoiceDriftCheck: jest.fn(async () => ({ data: null, error: null })),
}));

import { runVoiceDriftCheck } from "@/api/voiceDrift";

const queryHarness = ReactQuery as unknown as {
  __getLastMutationOptionsForTests: () => {
    mutationFn: () => Promise<unknown>;
    onSuccess?: (value: VoiceDriftReading) => void;
    onError?: (err: unknown) => void;
  };
  __resetQueryResultForTests: () => void;
};

const gateHarness = GateHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

/** The wire body drift.go returns when the copy is far off voice. */
const CRITICAL_WIRE = {
  score: 21,
  severity: "critical",
  critical: true,
  warn: true,
  breakdown: {
    embedding_similarity: 0.5,
    stylistic_distance: 0.18,
    vocabulary_overlap: 0.04,
    structural_match: 0.22,
    combined: 0.21,
  },
  authored_adjustment: -20,
  suggestions: ["Shorten or tighten."],
};

const BODY = "<p>ACT NOW!!! LIMITED TIME MEGA BLOWOUT</p>";

async function renderSendModal(): Promise<void> {
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <ToastProvider>
        <ConfirmProvider>
          <CampaignSendModal
            visible
            onClose={jest.fn()}
            campaignId="c-1"
            campaignName="Spring launch"
            subject="Huge news"
            bodyHtml={BODY}
          />
        </ConfirmProvider>
      </ToastProvider>
    </SafeAreaProvider>,
  );
}

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
  queryHarness.__resetQueryResultForTests();
});

describe("pre-send voice drift", () => {
  it("offers the check to an editor", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await renderSendModal();
    expect(screen.getByText("Voice fidelity")).toBeTruthy();
    expect(screen.getByLabelText("Check voice")).toBeTruthy();
    // Nothing has been scored, so nothing is claimed.
    expect(
      screen.getByText(
        "Score this draft against your workspace's measured brand voice before it goes out.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("21/100")).toBeNull();
  });

  it("does not offer it to a viewer — the endpoint's floor is editor", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    await renderSendModal();
    expect(screen.queryByText("Voice fidelity")).toBeNull();
    expect(screen.queryByLabelText("Check voice")).toBeNull();
  });

  it("does not offer it with the online gate closed", async () => {
    gateHarness.__setOnlineGateForTests({
      effectiveRole: "admin",
      enabled: false,
    });
    await renderSendModal();
    expect(screen.queryByText("Voice fidelity")).toBeNull();
  });

  it("sends the campaign body and subject to the drift endpoint", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await renderSendModal();
    const options = queryHarness.__getLastMutationOptionsForTests();
    (
      runVoiceDriftCheck as unknown as {
        mockResolvedValueOnce: (value: unknown) => void;
      }
    ).mockResolvedValueOnce({
      data: readVoiceDrift(CRITICAL_WIRE),
      error: null,
    });
    await options.mutationFn();
    expect(runVoiceDriftCheck).toHaveBeenCalledWith({
      bodyHtml: BODY,
      subject: "Huge news",
    });
  });

  it("escalates the send to a typed confirmation on a critical verdict", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await renderSendModal();

    // Before the check runs, nothing is being escalated.
    expect(screen.getByText("Send now")).toBeTruthy();

    const options = queryHarness.__getLastMutationOptionsForTests();
    await act(async () => {
      options.onSuccess?.(readVoiceDrift(CRITICAL_WIRE));
    });

    expect(screen.getByText("Send anyway…")).toBeTruthy();
    expect(
      screen.getByText(
        "This draft scored far below your workspace's measured brand voice. You'll be asked to confirm before this sends.",
      ),
    ).toBeTruthy();
  });

  it("does not escalate on the no-voice-profile answer, which arrives as a 200 scoring 100", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await renderSendModal();
    const options = queryHarness.__getLastMutationOptionsForTests();
    await act(async () => {
      options.onSuccess?.(
        readVoiceDrift({
          score: 100,
          severity: "ok",
          suggestions: ["No voice profile yet — drift check is inactive."],
        }),
      );
    });
    expect(screen.getByText("Send now")).toBeTruthy();
    expect(screen.queryByText("Send anyway…")).toBeNull();
  });

  it("clears a previous verdict when the check fails — a failed check is not a pass", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await renderSendModal();
    const options = queryHarness.__getLastMutationOptionsForTests();
    await act(async () => {
      options.onSuccess?.(readVoiceDrift(CRITICAL_WIRE));
    });
    expect(screen.getByText("Send anyway…")).toBeTruthy();
    await act(async () => {
      options.onError?.(new Error("voice service down"));
    });
    expect(screen.getByText("Send now")).toBeTruthy();
  });
});
