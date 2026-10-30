/**
 * The unified pre-send verdict, at the one place a send is confirmed.
 *
 * WHAT THIS PINS, and why lib/presendVerdictGate's unit test is not enough.
 * The verdict's value on a phone is in WHERE its answer lands: a row that
 * prints "critical" in a card is information; the same answer inside the
 * send sheet's escalation ladder is the difference between a typed
 * confirmation and a thumb sending anyway. So the assertions are about the
 * COMPOSITION — the card is offered only to a role the endpoint serves, a
 * critical verdict escalates the send, and NOTHING ELSE the verdict can say
 * (warn, incomplete, a 502 from an absent sidecar) ever changes the button.
 *
 * THE AUTHORISATION THIS FILE PINS. POST /api/v1/presend/verdict is
 * `apikeys.RequireScope(write:campaigns)` at the mount site
 * (apps/api/internal/presend/verdict.go:116) AND `"session_minimum_role":
 * "editor"` in apps/api/internal/routeauth/manifest.json. Both floors are
 * editor, so a viewer must not be offered the button.
 *
 * TWO WAYS INTO THE MUTATION. The shared react-query mock returns a fixed
 * shape (data undefined, error null) and captures only the LAST `useMutation`
 * options. The LIFT — the card handing its reading to the sheet — is driven
 * through the captured `onSuccess`/`onError`, which IS the product logic. The
 * card's own rendered states (summary verbatim, pill, incomplete sentence,
 * the 502 notice) need `data`/`error` on the hook result, so those tests
 * spy on the mock module's `useMutation` for one render; `restoreMocks`
 * puts it back. The drift card mounts after this one and is stubbed so the
 * verdict card's options stay the last captured; its own composition is
 * pinned by voice-drift-presend.native.test.tsx.
 */
import { describe, expect, it, jest, afterEach } from "@jest/globals";
import { act, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as ReactQuery from "@tanstack/react-query";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";
import * as GateHooks from "@/hooks/useOnlineQueryGate";
import {
  readPresendVerdict,
  type PresendVerdictReading,
} from "@/lib/campaignVerdict";

import { CampaignSendModal } from "../src/components/campaigns/CampaignSendModal";

jest.mock("@/api/presendVerdictGate", () => ({
  __esModule: true,
  requestDraftPresendVerdict: jest.fn(async () => ({ data: null, error: null })),
}));

jest.mock("@/components/voice/VoiceDriftCard", () => ({
  __esModule: true,
  VoiceDriftCard: () => null,
}));

import { requestDraftPresendVerdict } from "@/api/presendVerdictGate";

const queryHarness = ReactQuery as unknown as {
  __getLastMutationOptionsForTests: () => {
    mutationFn: () => Promise<unknown>;
    onSuccess?: (value: PresendVerdictReading) => void;
    onError?: (err: unknown) => void;
  };
  __resetQueryResultForTests: () => void;
};

// The SAME module object the component requires (moduleNameMapper resolves
// requireActual to the shared mock), so a spy here is what the card sees.
const queryModule = jest.requireActual("@tanstack/react-query") as unknown as {
  useMutation: (options: unknown) => unknown;
};

/** One render where every mutation result carries `data`/`error`. */
function spyMutationResult(result: { data?: unknown; error?: unknown }): void {
  jest.spyOn(queryModule, "useMutation").mockImplementation(() => ({
    data: result.data,
    error: result.error ?? null,
    isError: Boolean(result.error),
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => ({})),
    reset: jest.fn(),
    variables: undefined,
  }));
}

const gateHarness = GateHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

const BODY = "<p>ACT NOW!!! LIMITED TIME MEGA BLOWOUT</p>";

/** verdict.go's wire body when placement is critical and voice is skipped. */
const CRITICAL_WIRE = {
  verdict: "critical",
  complete: false,
  summary:
    "Critical issues detected. Predicted Primary placement is below 30%. | Checks incomplete: voice_drift.",
  components: [
    { name: "eq_score", status: "ok", score: 72 },
    { name: "voice_drift", status: "skipped", message: "Voice drift check is not configured." },
    { name: "placement", status: "critical", score: 0.21, message: "Predicted Primary placement is below 30%." },
  ],
  computed_at: "2026-09-02T10:00:00Z",
};

/** The answer a local API gives with no voice sidecar: incomplete, not a fail. */
const INCOMPLETE_WIRE = {
  verdict: "incomplete",
  complete: false,
  summary: "Pre-send checks incomplete. Unavailable: voice_drift.",
  components: [
    { name: "eq_score", status: "ok", score: 88 },
    { name: "voice_drift", status: "skipped", message: "Voice drift check is not configured." },
    { name: "placement", status: "ok", score: 0.71 },
  ],
  computed_at: "2026-09-02T10:00:00Z",
};

const WARN_WIRE = {
  verdict: "warn",
  complete: true,
  summary:
    "Warnings: Pre-send EQ Score is below the recommended threshold; review content and sender authentication.",
  components: [
    { name: "eq_score", status: "warn", score: 58 },
    { name: "voice_drift", status: "ok", score: 81 },
    { name: "placement", status: "ok", score: 0.66 },
  ],
  computed_at: "2026-09-02T10:00:00Z",
};

function wire(body: unknown): PresendVerdictReading {
  const reading = readPresendVerdict(body);
  if (!reading) throw new Error("fixture must parse");
  return reading;
}

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
            fromLine="Acme News hello@acme.com"
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

describe("pre-send verdict in the send sheet", () => {
  it("offers the check to an editor, claiming nothing until it has run", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await renderSendModal();
    expect(screen.getByText("AI pre-send verdict")).toBeTruthy();
    expect(screen.getByLabelText("Run check")).toBeTruthy();
    expect(
      screen.getByText(
        "Run EQ score, voice drift and inbox placement together and get one verdict before this goes out.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/^Verdict:/)).toBeNull();
    expect(screen.getByText("Send now")).toBeTruthy();
  });

  it("does not offer it to a viewer — the endpoint's floor is editor", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    await renderSendModal();
    expect(screen.queryByText("AI pre-send verdict")).toBeNull();
    expect(screen.queryByLabelText("Run check")).toBeNull();
  });

  it("does not offer it with the online gate closed", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin", enabled: false });
    await renderSendModal();
    expect(screen.queryByText("AI pre-send verdict")).toBeNull();
  });

  it("asks the body-only question with the bare From address — no campaign identity", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await renderSendModal();
    const options = queryHarness.__getLastMutationOptionsForTests();
    (
      requestDraftPresendVerdict as unknown as {
        mockResolvedValueOnce: (value: unknown) => void;
      }
    ).mockResolvedValueOnce({ data: INCOMPLETE_WIRE, error: null });
    await options.mutationFn();
    expect(requestDraftPresendVerdict).toHaveBeenCalledWith({
      subject: "Huge news",
      html: BODY,
      from: "hello@acme.com",
    });
  });

  it("escalates the send to a typed confirmation on a critical verdict", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await renderSendModal();
    expect(screen.getByText("Send now")).toBeTruthy();

    const options = queryHarness.__getLastMutationOptionsForTests();
    await act(async () => {
      options.onSuccess?.(wire(CRITICAL_WIRE));
    });

    expect(screen.getByText("Send anyway…")).toBeTruthy();
    expect(
      screen.getByText(
        "The pre-send verdict found a critical issue. You'll be asked to confirm before this sends.",
      ),
    ).toBeTruthy();
  });

  it("lifts warn and incomplete without escalating — only critical does", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await renderSendModal();
    const options = queryHarness.__getLastMutationOptionsForTests();
    for (const body of [WARN_WIRE, INCOMPLETE_WIRE]) {
      await act(async () => {
        options.onSuccess?.(wire(body));
      });
      expect(screen.getByText("Send now")).toBeTruthy();
      expect(screen.queryByText("Send anyway…")).toBeNull();
    }
  });

  it("a 502 upstream_unavailable clears a previous critical — a failure is not a pass, nor a block", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await renderSendModal();
    const options = queryHarness.__getLastMutationOptionsForTests();
    await act(async () => {
      options.onSuccess?.(wire(CRITICAL_WIRE));
    });
    expect(screen.getByText("Send anyway…")).toBeTruthy();

    await act(async () => {
      options.onError?.(
        Object.assign(new Error("upstream service did not respond"), {
          status: 502,
          code: "upstream_unavailable",
        }),
      );
    });
    expect(screen.getByText("Send now")).toBeTruthy();
    expect(screen.queryByText("Send anyway…")).toBeNull();
  });

  describe("rendered states", () => {
    it("critical: the server's summary verbatim, the headline, and the failing leg", async () => {
      gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
      spyMutationResult({ data: wire(CRITICAL_WIRE) });
      await renderSendModal();
      expect(screen.getByText(CRITICAL_WIRE.summary)).toBeTruthy();
      expect(screen.getByText("Verdict: do not send as-is")).toBeTruthy();
      expect(screen.getByText("Critical")).toBeTruthy();
      expect(
        screen.getByText(/^Placement 21\/100 · critical — Predicted Primary placement is below 30%\.$/),
      ).toBeTruthy();
      expect(screen.getByLabelText("Re-check")).toBeTruthy();
    });

    it("incomplete (voice sidecar absent): named as such, never as a pass, button untouched", async () => {
      gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
      spyMutationResult({ data: wire(INCOMPLETE_WIRE) });
      await renderSendModal();
      expect(screen.getByText("Incomplete")).toBeTruthy();
      expect(screen.getByText(INCOMPLETE_WIRE.summary)).toBeTruthy();
      expect(
        screen.getByText(
          "Not every check could run. This doesn't block sending — but don't read it as a pass.",
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(/^Voice drift · skipped — Voice drift check is not configured\.$/),
      ).toBeTruthy();
      expect(screen.getByText("Send now")).toBeTruthy();
      expect(screen.queryByText("Passed")).toBeNull();
    });

    it("warn: review, not an escalation", async () => {
      gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
      spyMutationResult({ data: wire(WARN_WIRE) });
      await renderSendModal();
      expect(screen.getByText("Review")).toBeTruthy();
      expect(screen.getByText("Verdict: send with caution")).toBeTruthy();
      expect(screen.getByText("Send now")).toBeTruthy();
    });

    it("502 upstream_unavailable: a non-blocking notice that says the send proceeds", async () => {
      gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
      spyMutationResult({
        error: Object.assign(new Error("upstream service did not respond"), {
          status: 502,
          code: "upstream_unavailable",
        }),
      });
      await renderSendModal();
      expect(
        screen.getByText(
          "The pre-send checks couldn't reach a service they depend on. Sending will proceed without it.",
        ),
      ).toBeTruthy();
      expect(screen.getByText("Send now")).toBeTruthy();
      expect(screen.queryByText("Send anyway…")).toBeNull();
    });

    it("404: the deployment has no verdict service — said plainly, send proceeds", async () => {
      gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
      spyMutationResult({
        error: Object.assign(new Error("not found"), { status: 404 }),
      });
      await renderSendModal();
      expect(
        screen.getByText(
          "The pre-send verdict isn't available on this deployment. Sending will proceed without it.",
        ),
      ).toBeTruthy();
      expect(screen.getByText("Send now")).toBeTruthy();
    });
  });
});
