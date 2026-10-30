/**
 * The two places the shared hints are MOUNTED. lib/contextualHints.test.ts
 * proves the registry matches the schema and contextual-hint-button proves
 * the renderer; this proves the anchors exist — that the DKIM record card,
 * and only the DKIM one, carries its hint, and that the best-time header
 * carries its hint OUTSIDE the switch group so VoiceOver still reaches both.
 * Remove either mount and this goes red.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import React from "react";

const mockHints: Record<string, { id: string; anchorKey: string; title: string; body: string }> = {
  "sending-identity.dkim": { id: "sending-identity.dkim", anchorKey: "field.dkim-record", title: "What's a DKIM record?", body: "b" },
  "campaign.send-window": { id: "campaign.send-window", anchorKey: "field.send-window", title: "Send-time optimization", body: "b" },
};
jest.mock("@/lib/contextualHints", () => {
  const actual = jest.requireActual<typeof import("../src/lib/contextualHints")>("../src/lib/contextualHints");
  return { ...actual, contextualHint: (key: string) => mockHints[key] ?? null };
});
// The trend fetches history once a row is expanded; not this suite's concern.
jest.mock("@/components/deliverability/DomainReputationTrend", () => ({
  DomainReputationTrend: () => null,
}));

/* eslint-disable import/first */
import { BestTimeScheduleCard } from "../src/components/campaigns/BestTimeScheduleCard";
import { DomainRowCard } from "../src/components/deliverability/DomainRowCard";
/* eslint-enable import/first */

type Row = Parameters<typeof DomainRowCard>[0]["row"];

const row = {
  id: "d1",
  domain: "mail.example.com",
  purpose: "links",
  verified: false,
  dnsRecords: [
    { type: "TXT", name: "mail.example.com", value: "v=spf1 include:_spf.moosewave.com ~all" },
    { type: "TXT", name: "pw1._domainkey.mail.example.com", value: "v=DKIM1; k=rsa; p=MIIB…" },
    { type: "TXT", name: "_dmarc.mail.example.com", value: "v=DMARC1; p=none" },
  ],
  createdAt: "2026-07-01T00:00:00Z",
  verifiedAt: null,
} as unknown as Row;

describe("contextual hint mounts", () => {
  it("puts the DKIM hint on the DKIM record card, and on no other record", async () => {
    await render(
      <DomainRowCard
        row={row}
        health={undefined}
        healthUnknown
        reputation={undefined}
        expanded
        onToggleRecords={jest.fn()}
        onVerify={jest.fn()}
        verifying={false}
        onShareRecord={jest.fn()}
        now={Date.parse("2026-09-05T00:00:00Z")}
      />,
    );
    expect(screen.getAllByLabelText("What's a DKIM record?")).toHaveLength(1);
    // Three records rendered, so the count above is a real selection, not "all".
    expect(screen.getAllByLabelText(/^Share the whole TXT record/u)).toHaveLength(3);
  });

  it("puts the send-window hint beside the best-time switch, leaving the switch reachable", async () => {
    await render(
      <BestTimeScheduleCard
        enabled={false}
        onToggle={jest.fn()}
        withinDays={3}
        onWithinDaysChange={jest.fn()}
        preview={null}
        loading={false}
        problem={null}
        retryable={false}
        onRetry={jest.fn()}
      />,
    );
    expect(screen.getByLabelText("Send-time optimization")).toBeTruthy();
    expect(screen.getByLabelText("Send at each recipient's best time")).toBeTruthy();
  });
});
