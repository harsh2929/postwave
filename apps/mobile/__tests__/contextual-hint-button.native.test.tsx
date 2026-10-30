/**
 * The shared hint contract, rendered on mobile at last.
 *
 * Jest maps @postwave/onboarding-schema to a hand-maintained stub (the package
 * is ESM), so this suite does not reach for the real CONTEXTUAL_HINTS — that
 * binding is asserted under vitest in src/lib/contextualHints.test.ts, against
 * the real schema. Here the registry is mocked with a fixture and the
 * component's own promises are what is tested: the trigger is named by the
 * hint's title, the sheet shows title and body verbatim, the learn-more link
 * appears only for an https URL, and an unknown key renders nothing so a
 * dropped hint cannot strand a "?".
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";

const mockHints: Record<string, { id: string; anchorKey: string; title: string; body: string; learnMoreUrl?: string }> = {
  "sending-identity.dkim": {
    id: "sending-identity.dkim",
    anchorKey: "field.dkim-record",
    title: "What's a DKIM record?",
    body: "A DNS TXT record that cryptographically signs your mail.",
    learnMoreUrl: "https://docs.moosewave.com/deliverability/dkim",
  },
  "campaign.send-window": {
    id: "campaign.send-window",
    anchorKey: "field.send-window",
    title: "Send-time optimization",
    body: "Holds each recipient's send until their most-likely-to-open hour.",
  },
  "trap.http": {
    id: "trap.http",
    anchorKey: "field.x",
    title: "Plain-http link",
    body: "Body.",
    learnMoreUrl: "http://docs.moosewave.com/insecure",
  },
};

jest.mock("@/lib/contextualHints", () => ({
  contextualHint: (key: string) => mockHints[key] ?? null,
}));

// eslint-disable-next-line import/first
import { ContextualHintButton } from "../src/components/onboarding/ContextualHintButton";

describe("ContextualHintButton", () => {
  it("is named by the hint's own title, and opens the shared title, body and link", async () => {
    await render(<ContextualHintButton hintKey="sending-identity.dkim" />);
    await fireEvent.press(screen.getByLabelText("What's a DKIM record?"));
    expect(screen.getByRole("header", { name: "What's a DKIM record?" })).toBeTruthy();
    expect(screen.getByText("A DNS TXT record that cryptographically signs your mail.")).toBeTruthy();
    expect(screen.getByLabelText("Learn more about What's a DKIM record?")).toBeTruthy();
  });

  it("renders nothing for a key the schema does not know", async () => {
    const { toJSON } = await render(<ContextualHintButton hintKey="no-such-hint" />);
    expect(toJSON()).toBeNull();
  });

  it("omits the learn-more link when the hint has no URL", async () => {
    await render(<ContextualHintButton hintKey="campaign.send-window" />);
    await fireEvent.press(screen.getByLabelText("Send-time optimization"));
    expect(screen.getByText("Holds each recipient's send until their most-likely-to-open hour.")).toBeTruthy();
    expect(screen.queryByLabelText(/^Learn more about/u)).toBeNull();
  });

  it("refuses to offer a plain-http learn-more link", async () => {
    await render(<ContextualHintButton hintKey="trap.http" />);
    await fireEvent.press(screen.getByLabelText("Plain-http link"));
    expect(screen.queryByLabelText(/^Learn more about/u)).toBeNull();
  });
});
