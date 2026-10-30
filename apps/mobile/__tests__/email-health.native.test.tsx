import { afterEach, describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";

import * as ReactQuery from "@tanstack/react-query";
import { SubscriberEmailHealthCard } from "@/components/subscriber/sections/SubscriberEmailHealthCard";

const queryHarness = ReactQuery as unknown as {
  __setQueryResultForTests: (value: Record<string, unknown>) => void;
  __resetQueryResultForTests: () => void;
};

const NOW = "2026-08-13T09:00:00.000Z";

function health(grade: "A" | "B" | "D" | "F" = "A") {
  const hardStop = grade === "F";
  const reasonCode =
    grade === "A"
      ? "verification_valid_30d"
      : grade === "B"
        ? "event_delivered"
        : grade === "D"
          ? "event_bounced_hard"
          : "suppression_hard_bounce";
  const evidence =
    grade === "B"
      ? [
          {
            kind: "delivered",
            at: NOW,
            source: "subscriber_events",
            reason_code: reasonCode,
          },
        ]
      : grade === "D"
        ? [
            {
              kind: "hard_bounce",
              at: NOW,
              source: "subscriber_events",
              reason_code: reasonCode,
            },
          ]
        : grade === "F"
          ? [
              {
                kind: "hard_stop",
                at: NOW,
                source: "send_eligibility",
                reason_code: reasonCode,
              },
            ]
          : [];
  return {
    email: "person@example.com",
    grade,
    recommendation:
      grade === "D" ? "do_not_send" : hardStop ? "blocked" : "send",
    hard_stop: hardStop,
    send_eligible: grade === "A" || grade === "B",
    evidence_complete: true,
    reason_codes: [reasonCode],
    evidence,
    evidence_at: NOW,
    ...(grade === "A" ? { status: "valid", checked_at: NOW } : {}),
    model_version: "postwave-email-health-v1",
    computed_at: "2026-08-13T09:01:00.000Z",
  } as const;
}

afterEach(() => queryHarness.__resetQueryResultForTests());

describe("SubscriberEmailHealthCard", () => {
  it("shows grade, recommendation, and hard-stop precedence without raw sources", async () => {
    queryHarness.__setQueryResultForTests({
      data: health("F"),
      error: null,
      isPending: false,
      isError: false,
      refetch: async () => ({ data: health("F") }),
    });
    const screen = await render(
      <SubscriberEmailHealthCard
        email="person@example.com"
        subscriberId="subscriber-1"
      />,
    );

    expect(screen.getByLabelText("Email health grade F")).toBeTruthy();
    expect(screen.getByText("Blocked from sending")).toBeTruthy();
    expect(screen.getByText(/Active hard-bounce suppression/u)).toBeTruthy();
    expect(
      screen.getByText(/An invalid, spam-trap, abuse, or do-not-mail result/u),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /hard stop takes precedence over every positive signal/u,
      ),
    ).toBeTruthy();
    expect(screen.queryByText("subscriber_events")).toBeNull();
  });

  it("describes B as first-party positive activity", async () => {
    queryHarness.__setQueryResultForTests({
      data: health("B"),
      error: null,
      isPending: false,
      isError: false,
      refetch: async () => ({ data: health("B") }),
    });
    const screen = await render(
      <SubscriberEmailHealthCard
        email="person@example.com"
        subscriberId="subscriber-1"
      />,
    );

    expect(screen.getByLabelText("Email health grade B")).toBeTruthy();
    expect(
      screen.getByText(
        /A recent first-party delivery, human-classified click, or human reply/u,
      ),
    ).toBeTruthy();
  });

  it("shows the validation date attached to grade A", async () => {
    queryHarness.__setQueryResultForTests({
      data: { ...health("A"), evidence_at: "2026-08-14T09:00:00.000Z" },
      error: null,
      isPending: false,
      isError: false,
      refetch: async () => ({ data: health("A") }),
    });
    const screen = await render(
      <SubscriberEmailHealthCard
        email="person@example.com"
        subscriberId="subscriber-1"
      />,
    );

    expect(screen.getByText(/Validated Aug 13, 2026/u)).toBeTruthy();
  });

  it("describes a recent historical hard bounce as recoverable grade D", async () => {
    queryHarness.__setQueryResultForTests({
      data: health("D"),
      error: null,
      isPending: false,
      isError: false,
      refetch: async () => ({ data: health("D") }),
    });
    const screen = await render(
      <SubscriberEmailHealthCard
        email="person@example.com"
        subscriberId="subscriber-1"
      />,
    );

    expect(screen.getByLabelText("Email health grade D")).toBeTruthy();
    expect(screen.getByText("Do not send")).toBeTruthy();
    expect(
      screen.getByText(
        /has not been superseded by newer first-party positive activity/u,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/active hard stop/u)).toBeNull();
  });

  it("shows the fail-closed state when evidence could not be loaded", async () => {
    queryHarness.__setQueryResultForTests({
      data: {
        ...health("F"),
        grade: "U",
        recommendation: "caution",
        hard_stop: false,
        send_eligible: false,
        evidence_complete: false,
        reason_codes: ["health_evidence_unavailable"],
        evidence: [],
      },
      error: null,
      isPending: false,
      isError: false,
      refetch: async () => ({ data: health("F") }),
    });
    const screen = await render(
      <SubscriberEmailHealthCard
        email="person@example.com"
        subscriberId="subscriber-1"
      />,
    );

    expect(
      screen.getByText("Sending paused — evidence unavailable"),
    ).toBeTruthy();
    expect(screen.getByText(/remains ineligible/u)).toBeTruthy();
  });

  it("stays absent when an older deployment lacks the endpoint", async () => {
    queryHarness.__setQueryResultForTests({
      data: undefined,
      error: { status: 404 },
      isPending: false,
      isError: true,
      refetch: async () => ({ data: undefined }),
    });
    const screen = await render(
      <SubscriberEmailHealthCard
        email="person@example.com"
        subscriberId="subscriber-1"
      />,
    );
    expect(screen.queryByLabelText("Email health")).toBeNull();
  });
});
