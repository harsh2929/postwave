/**
 * SubscriberChannelConsentsCard — per-channel permission, reviewed on write.
 *
 * The lib rules (absent-row honesty, verb selection) and the transport's
 * If-Match discipline are node-tested. What only a rendered test can pin:
 *
 *  - the card presents ALL FIVE channels, and a channel with no server row
 *    reads "No consent recorded" — never "Opted out";
 *  - the write verbs exist exactly when `canMutate` (editor+, online, live
 *    session) — absent for a viewer, not disabled;
 *  - pressing a verb opens the CONSENT REVIEW, and the review refuses to
 *    submit a half-filled envelope — the mutation must not fire until the
 *    evidence is whole (the same sheet the profile Resubscribe flow uses,
 *    so this pins that gate for both surfaces);
 *  - a completed review submits the draft with the row's channel and the
 *    ledger-correct next status.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

// Only the WRITE is stubbed; the read hook runs for real against the suite's
// react-query harness, so the query's own shape stays under test.
jest.mock("@/hooks/useSubscriberChannelConsents", () => {
  const actual = jest.requireActual(
    "@/hooks/useSubscriberChannelConsents",
  ) as Record<string, unknown>;
  const mutate = jest.fn();
  return {
    ...actual,
    __mutate: mutate,
    useSetSubscriberChannelConsent: () => ({
      isPending: false,
      error: null,
      mutate,
    }),
  };
});

import { SubscriberChannelConsentsCard } from "@/components/subscriber/sections/SubscriberChannelConsentsCard";

const writeHarness = jest.requireMock(
  "@/hooks/useSubscriberChannelConsents",
) as { __mutate: jest.Mock };

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

afterEach(() => {
  writeHarness.__mutate.mockClear();
  queryHarness.__resetQueryResultForTests();
});

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

/** The card's parsed row shape — one recorded opt-in, four absent channels. */
function loaded() {
  queryHarness.__setQueryResultForTests({
    data: [
      {
        channel: "sms",
        status: "opted_in",
        consentTimestamp: "2026-08-01T09:00:00Z",
        consentSource: "preference_center",
        frequencyCapUntil: null,
      },
    ],
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: [] })),
  });
}

async function drawOpen(canMutate: boolean) {
  loaded();
  await render(
    <SubscriberChannelConsentsCard
      subscriberId="sub-1"
      email="ada@acme.dev"
      canMutate={canMutate}
    />,
    { wrapper },
  );
  await act(async () => {
    fireEvent.press(screen.getByA11yHint(/Per-channel marketing permission/));
  });
}

describe("channel consents on the subscriber profile", () => {
  it("shows all five channels; an absent row is 'No consent recorded', never a refusal", async () => {
    await drawOpen(true);
    for (const label of ["Email", "SMS", "Push", "WhatsApp", "RCS"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("Opted in")).toBeTruthy();
    // email/push/whatsapp/rcs have no row — unrecorded, not opted out.
    expect(screen.getAllByText("No consent recorded")).toHaveLength(4);
    expect(screen.queryByText("Opted out")).toBeNull();
  });

  it("gives a viewer NO write verbs — absent, not disabled", async () => {
    await drawOpen(false);
    expect(screen.queryByText("Opt in")).toBeNull();
    expect(screen.queryByText("Opt out")).toBeNull();
  });

  it("refuses to record a half-filled evidence envelope", async () => {
    await drawOpen(true);
    // The recorded opt-in offers the revoke; absent rows offer the grant.
    await act(async () => {
      fireEvent.press(screen.getByLabelText(/Opt out of SMS/));
    });
    expect(screen.getByText("Opt out: SMS")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText("Record opt-out"));
    });
    expect(writeHarness.__mutate).not.toHaveBeenCalled();
    // The first unmet requirement is spoken, not a generic failure.
    expect(
      screen.getByText(/Choose the reviewed opt-in record/),
    ).toBeTruthy();
  });

  it("submits a WHOLE envelope with the row's channel and the ledger-correct next status", async () => {
    await drawOpen(true);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(/Opt out of SMS/));
    });
    await act(async () => {
      fireEvent.press(
        screen.getByLabelText("Evidence source: Preference center"),
      );
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Legal basis: Consent"));
    });
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("Jurisdiction"), "EU");
    });
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText("Reason"),
        "Asked to stop SMS on the support call",
      );
    });
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("Policy version"), "2026-05");
    });
    await act(async () => {
      fireEvent.press(screen.getByText("Record opt-out"));
    });

    expect(writeHarness.__mutate).toHaveBeenCalledTimes(1);
    const [vars] = writeHarness.__mutate.mock.calls[0] as [
      {
        subscriberId: string;
        channel: string;
        nextStatus: string;
        draft: { source: string; jurisdiction: string };
      },
    ];
    expect(vars.subscriberId).toBe("sub-1");
    expect(vars.channel).toBe("sms");
    expect(vars.nextStatus).toBe("opted_out");
    expect(vars.draft.source).toBe("preference_center");
    expect(vars.draft.jurisdiction).toBe("EU");
  });
});
