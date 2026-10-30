/**
 * The profile's tracking / frequency / demographics cards — what only a
 * rendered test can pin:
 *
 *  - the frequency SENTENCE is the truth: a future paused_until reads as
 *    Paused even while the stored preference says weekly, and a viewer gets
 *    the sentence with NO dead controls (absent, not disabled);
 *  - the frequency verbs submit the lib-built bodies (pause_days preset,
 *    frequency_preference choice) — never ad-hoc keys;
 *  - the tracking card keeps GPC visible and un-overridable, offers the
 *    explicit-evidence verbs only to canMutate, and binds a toggle to the
 *    ETag of the state the operator was LOOKING AT;
 *  - the demographics card renders value·confidence pairs and renders an
 *    absent trait as nothing.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

jest.mock("@/hooks/useSubscriberFrequency", () => {
  const mutate = jest.fn();
  return {
    __freqMutate: mutate,
    useSubscriberFrequencyWrite: () => ({
      isPending: false,
      error: null,
      mutate,
    }),
  };
});

jest.mock("@/hooks/useSubscriberTracking", () => {
  const actual = jest.requireActual(
    "@/hooks/useSubscriberTracking",
  ) as Record<string, unknown>;
  const mutate = jest.fn();
  return {
    ...actual,
    __trackMutate: mutate,
    useSetSubscriberTracking: () => ({
      isPending: false,
      error: null,
      mutate,
    }),
  };
});

import { SubscriberDemographicsCard } from "@/components/subscriber/sections/SubscriberDemographicsCard";
import { SubscriberFrequencyCard } from "@/components/subscriber/sections/SubscriberFrequencyCard";
import { SubscriberTrackingCard } from "@/components/subscriber/sections/SubscriberTrackingCard";

const freqHarness = jest.requireMock("@/hooks/useSubscriberFrequency") as {
  __freqMutate: jest.Mock;
};
const trackHarness = jest.requireMock("@/hooks/useSubscriberTracking") as {
  __trackMutate: jest.Mock;
};
const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

afterEach(() => {
  freqHarness.__freqMutate.mockClear();
  trackHarness.__trackMutate.mockClear();
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

const FUTURE = "2030-01-15T00:00:00Z";

describe("send-frequency card", () => {
  it("tells the send-time truth: a future pause silences a weekly preference", async () => {
    await render(
      <SubscriberFrequencyCard
        subscriberId="sub-1"
        subscriber={{ frequency_preference: "weekly", paused_until: FUTURE }}
        canMutate={false}
      />,
      { wrapper },
    );
    expect(
      screen.getByText(/^Paused — excluded from every send until /),
    ).toBeTruthy();
    expect(screen.queryByText(/Capped at one send per week/)).toBeNull();
  });

  it("gives a viewer the sentence and NO controls — absent, not disabled", async () => {
    await render(
      <SubscriberFrequencyCard
        subscriberId="sub-1"
        subscriber={{}}
        canMutate={false}
      />,
      { wrapper },
    );
    expect(screen.queryByLabelText("Send frequency preference")).toBeNull();
    expect(screen.queryByText("Pause 30d")).toBeNull();
  });

  it("submits the lib-built bodies for a cadence choice and a pause preset", async () => {
    await render(
      <SubscriberFrequencyCard
        subscriberId="sub-1"
        subscriber={{}}
        canMutate
      />,
      { wrapper },
    );
    await act(async () => {
      fireEvent.press(screen.getByText("Monthly"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Pause all sends for 30 days"));
    });
    const calls = freqHarness.__freqMutate.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { id: "sub-1", body: { frequency_preference: "monthly" } },
      { id: "sub-1", body: { pause_days: 30 } },
    ]);
  });
});

function trackingLoaded() {
  queryHarness.__setQueryResultForTests({
    data: {
      prefs: {
        subscriberId: "sub-1",
        openOptOutAt: null,
        clickOptOutAt: null,
        effectiveOpenOptOut: true,
        effectiveClickOptOut: false,
        gpc: true,
        source: "gpc",
      },
      etag: '"v7"',
    },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: undefined })),
  });
}

async function drawTracking(canMutate: boolean) {
  trackingLoaded();
  await render(
    <SubscriberTrackingCard subscriberId="sub-1" canMutate={canMutate} />,
    { wrapper },
  );
  await act(async () => {
    fireEvent.press(
      screen.getByA11yHint(/Open.click tracking consent/),
    );
  });
}

describe("tracking-preferences card", () => {
  it("keeps GPC visible and un-overridable, with the layered per-dimension truth", async () => {
    await drawTracking(true);
    expect(
      screen.getByText(/browser sends Global Privacy Control\. It\s+cannot be overridden from here\./),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Open tracking is off by Global Privacy Control. Recording an explicit opt-out is allowed; overriding GPC is not.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Click tracking is on for this subscriber."),
    ).toBeTruthy();
  });

  it("gives a viewer NO verbs — absent, not disabled", async () => {
    await drawTracking(false);
    expect(screen.queryByText("Record opt-out")).toBeNull();
    expect(screen.queryByText("Clear opt-out")).toBeNull();
  });

  it("binds an explicit opt-out to the ETag of the state on screen", async () => {
    await drawTracking(true);
    await act(async () => {
      fireEvent.press(
        screen.getByLabelText(
          "Record an explicit open-tracking opt-out for this subscriber",
        ),
      );
    });
    expect(trackHarness.__trackMutate).toHaveBeenCalledTimes(1);
    expect(trackHarness.__trackMutate.mock.calls[0]![0]).toEqual({
      subscriberId: "sub-1",
      dimension: "open",
      nextOptOut: true,
      etag: '"v7"',
    });
  });
});

describe("demographics card", () => {
  it("renders value·confidence pairs and nothing for absent traits", async () => {
    queryHarness.__setQueryResultForTests({
      data: [
        {
          key: "gender",
          label: "Gender",
          value: "female",
          confidence: "62% confidence",
          source: "model_v3",
        },
      ],
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      isPending: false,
      isSuccess: true,
      refetch: jest.fn(async () => ({ data: undefined })),
    });
    await render(<SubscriberDemographicsCard subscriberId="sub-1" />, {
      wrapper,
    });
    await act(async () => {
      fireEvent.press(screen.getByA11yHint(/Model-inferred attributes/));
    });
    expect(screen.getByText("female · 62% confidence")).toBeTruthy();
    // age_group / interests were never inferred → no rows, no "unknown".
    expect(screen.queryByText("Age group")).toBeNull();
    expect(screen.queryByText(/unknown/i)).toBeNull();
  });
});
