import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * The DMARC drill-down cluster and the domain reputation trend.
 *
 *  - FAILING SOURCES: a row is a real tap-through when a handler is provided
 *    and stays an inert list when none is — no dead affordance either way.
 *  - SOURCE SHEET: renders the forwarder-vs-spoofing evidence, and reports a
 *    failed read as a failure.
 *  - POLICY ADVISOR: every branch carries the observation-only boundary — the
 *    p= value came from a REPORT, not live DNS.
 *  - REPUTATION TREND: armed by row expansion; a failed read must never
 *    render as "no history".
 */
const mockSourceDetail: {
  data: unknown;
  isError: boolean;
  isPending: boolean;
} = { data: undefined, isError: false, isPending: true };

const mockHistory: {
  data: unknown;
  isError: boolean;
  isPending: boolean;
} = { data: undefined, isError: false, isPending: true };

jest.mock("@/hooks/useDmarcSourceDetail", () => ({
  useDmarcSourceDetail: () => mockSourceDetail,
}));
jest.mock("@/hooks/useCustomDomainReputation", () => ({
  useCustomDomainReputationHistory: () => mockHistory,
}));

// eslint-disable-next-line import/first
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import { DmarcPolicyAdvisorCard } from "@/components/deliverability/DmarcPolicyAdvisorCard";
// eslint-disable-next-line import/first
import { DmarcSourceSheet } from "@/components/deliverability/DmarcSourceSheet";
// eslint-disable-next-line import/first
import { DomainReputationTrend } from "@/components/deliverability/DomainReputationTrend";
// eslint-disable-next-line import/first
import { FailingSourcesCard } from "@/components/deliverability/FailingSourcesCard";

const gateHarness = QueryHooks as unknown as {
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
  mockSourceDetail.data = undefined;
  mockSourceDetail.isError = false;
  mockSourceDetail.isPending = true;
  mockHistory.data = undefined;
  mockHistory.isError = false;
  mockHistory.isPending = true;
});

const SOURCES = [
  {
    sourceIp: "203.0.113.9",
    messages: 120,
    alignedPct: 0.1,
    primaryDisposition: "quarantine",
  },
];

function withSafeArea(children: React.ReactElement) {
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

describe("FailingSourcesCard tap-through", () => {
  it("hands the pressed IP to the parent", async () => {
    const onOpenSource = jest.fn();
    const screen = await render(
      <FailingSourcesCard sources={SOURCES as never} onOpenSource={onOpenSource} />,
    );
    fireEvent.press(
      screen.getByLabelText(/203\.0\.113\.9.*Open source detail/),
    );
    expect(onOpenSource).toHaveBeenCalledWith("203.0.113.9");
  });

  it("renders an inert list — no button role — when no handler is given", async () => {
    const screen = await render(<FailingSourcesCard sources={SOURCES as never} />);
    expect(screen.getByText("203.0.113.9")).toBeTruthy();
    expect(screen.queryByLabelText(/Open source detail/)).toBeNull();
  });
});

describe("DmarcSourceSheet", () => {
  it("renders the forwarder-vs-spoofing evidence for a loaded source", async () => {
    mockSourceDetail.isPending = false;
    mockSourceDetail.data = {
      sourceIp: "203.0.113.9",
      periodDays: 30,
      domain: "a.com",
      hasMore: false,
      summary: {
        messages: 120,
        dkimPass: 110,
        spfPass: 10,
        alignedPct: 12.5,
        primaryDisposition: "quarantine",
      },
      perReport: [
        {
          reportId: "r1",
          orgName: "google.com",
          dateBegin: "t0",
          dateEnd: "t1",
          messages: 60,
          alignedPct: 10,
          primaryDisposition: "quarantine",
        },
      ],
    };
    const screen = await render(
      withSafeArea(
        <DmarcSourceSheet ip="203.0.113.9" days={30} domain="a.com" onClose={jest.fn()} />,
      ),
    );
    expect(screen.getByText(/DKIM passed on 110/)).toBeTruthy();
    expect(screen.getByText("google.com")).toBeTruthy();
  });

  it("reports a failed detail read as a failure", async () => {
    mockSourceDetail.isPending = false;
    mockSourceDetail.isError = true;
    const screen = await render(
      withSafeArea(
        <DmarcSourceSheet ip="203.0.113.9" days={30} domain="" onClose={jest.fn()} />,
      ),
    );
    expect(screen.getByText(/couldn't be loaded/)).toBeTruthy();
  });
});

describe("DmarcPolicyAdvisorCard", () => {
  it("always renders the observation-only boundary with the advice", async () => {
    const screen = await render(
      <DmarcPolicyAdvisorCard latestPolicy="none" domain="a.com" />,
    );
    expect(screen.getByText(/Review legitimate unaligned sources/)).toBeTruthy();
    expect(screen.getByText(/not a live DNS lookup/)).toBeTruthy();
  });

  it("names an evidence gap rather than concluding about DNS", async () => {
    const screen = await render(
      <DmarcPolicyAdvisorCard latestPolicy="" domain="a.com" />,
    );
    expect(screen.getByText(/evidence gap/)).toBeTruthy();
  });
});

describe("DomainReputationTrend", () => {
  it("renders nothing until the row is expanded", async () => {
    const screen = await render(
      <DomainReputationTrend domain="a.com" armed={false} />,
    );
    expect(screen.toJSON()).toBeNull();
  });

  it("renders the day bars once the history arrives", async () => {
    mockHistory.isPending = false;
    mockHistory.data = [
      { day: "2026-08-27", score: 40, sends: 10, bounceRatePct: 5, complaintRatePct: 0 },
      { day: "2026-08-28", score: 90, sends: 10, bounceRatePct: 0.5, complaintRatePct: 0.1 },
    ];
    const screen = await render(<DomainReputationTrend domain="a.com" armed />);
    expect(
      screen.getByLabelText(/Reputation trend for a\.com: 2 days, from 40 to 90/),
    ).toBeTruthy();
  });

  it("says a failed read FAILED instead of implying no history", async () => {
    mockHistory.isPending = false;
    mockHistory.isError = true;
    const screen = await render(<DomainReputationTrend domain="a.com" armed />);
    expect(screen.getByText(/couldn't be loaded/)).toBeTruthy();
    expect(screen.queryByText(/no reputation trend/)).toBeNull();
  });
});
