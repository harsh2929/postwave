/**
 * AI sequence drafting — the review gate's render contract (AUTOMATION#15).
 *
 * WHY A RENDER TEST AND NOT ONLY THE PURE ONES. `lib/sequenceDraft` and
 * `lib/sequenceDraftSave` already pin the rules in the node environment. What
 * they cannot prove is that the rules REACH THE SCREEN — and on this surface
 * every one of them is a safety property, not a nicety:
 *
 *   - a model wrote this text, and the Article 50 sentence must be on screen
 *     before the first email rather than merely importable;
 *   - a step the drafting endpoint happily returns (body, no subject) must be
 *     stopped HERE, with a message on the offending card, instead of becoming
 *     one opaque 400 after the operator has read five emails;
 *   - the emails are EDITABLE — a review surface you cannot act on is a
 *     preview, which is what this cluster shipped before;
 *   - a wait the model did not give must never render as "Sends immediately".
 *
 * The sheet takes its draft as a PROP, so it is driven with genuinely
 * draft-shaped payloads here without going anywhere near the react-query
 * harness (whose single shared result would otherwise hand this component
 * somebody else's data — house rule 10).
 */
import { describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import { SequenceDraftReview } from "@/components/sequences/SequenceDraftReview";
import { normalizeSequenceDraft } from "@/lib/sequenceDraft";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

/** A response shaped exactly like `SequenceDraft` on the wire, decoded through
 *  the real normaliser so the fixture cannot drift from the decoder. */
function plan(overrides?: { steps?: unknown[] }) {
  const decoded = normalizeSequenceDraft({
    name: "Winback series",
    rationale: "Three touches: reminder, proof, offer.",
    steps: overrides?.steps ?? [
      { position: 1, subject: "We miss you", body: "It has been a while.", delay_hours: 0 },
      { position: 2, subject: "", body: "Here is what changed.", delay_hours: 48 },
      { position: 3, subject: "15% off", body: "Your usual roast.", delay_hours: 24 },
    ],
  });
  if (!decoded) throw new Error("fixture did not decode");
  return decoded;
}

async function renderReview(props?: {
  onSave?: (input: { name: string; emails: readonly unknown[] }) => void;
  steps?: unknown[];
}) {
  const onSave = props?.onSave ?? jest.fn();
  const onDiscard = jest.fn();
  await render(
    <SequenceDraftReview
      visible
      plan={plan(props?.steps ? { steps: props.steps } : undefined)}
      saving={false}
      error={null}
      onDiscard={onDiscard}
      onSave={onSave as never}
    />,
    { wrapper },
  );
  return { onSave, onDiscard };
}

describe("AI sequence draft review", () => {
  it("states that a model wrote this, in the gateway's own words", async () => {
    await renderReview();
    // Verbatim, not paraphrased: @postwave/ai-disclosure mirrors the Go
    // constant byte-for-byte, and a per-surface rewording defeats that.
    expect(screen.getByText(AI_DISCLOSURE_TEXT)).toBeTruthy();
    expect(
      screen.getByText(/Nothing is saved or sent yet/u),
    ).toBeTruthy();
    // The model's own reasoning, labelled as the model's.
    expect(screen.getByText(/Three touches: reminder, proof, offer\./u)).toBeTruthy();
  });

  it("blocks the save on a step the DRAFT endpoint returns and the SAVE refuses", async () => {
    await renderReview();
    // Step 2 came back with a body and no subject — legal for
    // parseSequenceDraftJSON, fatal for validateEmailConfig.
    expect(screen.getByText("Add a subject line.")).toBeTruthy();
    expect(
      screen.getByLabelText("Save as draft").props.accessibilityState.disabled,
    ).toBe(true);
  });

  it("is genuinely editable: typing the missing subject unblocks the save", async () => {
    const { onSave } = await renderReview();
    // React 19 + RNTL 14: an event's re-render is flushed by `act`, not by
    // the event call, so asserting straight after fireEvent reads the PREVIOUS
    // render and passes vacuously.
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText("Subject line for email 2"),
        "What changed since you left",
      );
    });
    expect(screen.queryByText("Add a subject line.")).toBeNull();
    const save = screen.getByLabelText("Save as draft");
    expect(save.props.accessibilityState.disabled).toBe(false);

    await act(async () => {
      fireEvent.press(save);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    const call = (onSave as jest.Mock).mock.calls[0]?.[0] as {
      name: string;
      emails: { subject: string; delayHours: number | null }[];
    };
    expect(call.name).toBe("Winback series");
    expect(call.emails.map((e) => e.subject)).toEqual([
      "We miss you",
      "What changed since you left",
      "15% off",
    ]);
  });

  it("drops an email the operator removes, and only that one", async () => {
    const { onSave } = await renderReview({
      steps: [
        { position: 1, subject: "Keep me", body: "a", delay_hours: 0 },
        { position: 2, subject: "Cut me", body: "b", delay_hours: 24 },
      ],
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Remove email 2"));
    });
    expect(screen.queryByDisplayValue("Cut me")).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Save as draft"));
    });
    const call = (onSave as jest.Mock).mock.calls[0]?.[0] as {
      emails: { subject: string }[];
    };
    expect(call.emails.map((e) => e.subject)).toEqual(["Keep me"]);
  });

  it("refuses to save an empty draft rather than creating a shell nobody asked for", async () => {
    const { onSave } = await renderReview({
      steps: [{ position: 1, subject: "Only one", body: "a", delay_hours: 0 }],
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Remove email 1"));
    });
    expect(
      screen.getByText("Keep at least one email, or discard the draft."),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Save as draft").props.accessibilityState.disabled,
    ).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("never renders a wait the model did not give as an immediate send", async () => {
    await renderReview({
      steps: [
        { position: 1, subject: "First", body: "a", delay_hours: 0 },
        // No `delay_hours` at all — ABSENCE IS NOT ZERO.
        { position: 2, subject: "Second", body: "b" },
      ],
    });
    expect(screen.getByText("Sends immediately")).toBeTruthy();
    expect(
      screen.getByText("No wait given — follows immediately"),
    ).toBeTruthy();
  });
});
