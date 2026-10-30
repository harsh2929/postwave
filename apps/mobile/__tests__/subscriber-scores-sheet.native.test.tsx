/**
 * SubscriberScoresSheet — what only a rendered test can pin:
 *
 *  - the distribution renders one row per decile and drilling stays wired;
 *  - the scored rows read email + score;
 *  - the rules section: weights are read-only text for a non-admin (no
 *    inputs, no Save), editable + savable for an admin;
 *  - NO recompute affordance exists anywhere — the server holds that verb,
 *    and the sheet prints the reason instead.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const query = (data: unknown) => ({
  data,
  error: null,
  isError: false,
  isFetching: false,
  isLoading: false,
  isPending: false,
  isSuccess: true,
  refetch: jest.fn(async () => ({ data: undefined })),
});

jest.mock("@/hooks/useSubscriberEngagement", () => {
  const save = jest.fn();
  return {
    __save: save,
    useScoreDistribution: () =>
      query([
        { range: "0..9", min: 0, max: 9, count: 40 },
        { range: "10..19", min: 10, max: 19, count: 8 },
      ]),
    useScoredSubscribers: () =>
      query({
        items: [{ id: "s1", email: "ada@acme.dev", score: 82 }],
        page: 1,
        total: 1,
      }),
    useScoringRules: () =>
      query({
        rules: [
          {
            eventType: "email_open",
            label: "Opened an email",
            weight: 1,
            note: "",
          },
        ],
        usingDefaults: true,
        version: "v-abc",
        windowDays: 180,
      }),
    useSaveScoringRules: () => ({
      isPending: false,
      error: null,
      mutate: save,
    }),
  };
});

import { SubscriberScoresSheet } from "@/components/subscriber/SubscriberScoresSheet";

afterEach(() => {
  (
    jest.requireMock("@/hooks/useSubscriberEngagement") as {
      __save: jest.Mock;
    }
  ).__save.mockClear();
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

async function draw(canEditRules: boolean) {
  await render(
    <SubscriberScoresSheet
      visible
      canEditRules={canEditRules}
      onClose={jest.fn()}
    />,
    { wrapper },
  );
}

describe("the engagement-score explorer sheet", () => {
  it("renders the deciles, the scored rows, and the defaults caption", async () => {
    await draw(false);
    expect(
      screen.getByLabelText("Scores 0..9: 40 subscribers. Shows them below."),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("ada@acme.dev, score 82. Opens the profile."),
    ).toBeTruthy();
    expect(
      screen.getByText(/runs the default weights/),
    ).toBeTruthy();
    expect(screen.getByText(/Events count for 180 days/)).toBeTruthy();
  });

  it("gives a non-admin the weights as text — no inputs, no Save", async () => {
    await draw(false);
    expect(
      screen.getByLabelText("Opened an email weight 1"),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Weight for Opened an email")).toBeNull();
    expect(screen.queryByText("Save rule set")).toBeNull();
  });

  it("gives an admin editable weights and the whole-set Save", async () => {
    await draw(true);
    expect(screen.getByLabelText("Weight for Opened an email")).toBeTruthy();
    expect(screen.getByText("Save rule set")).toBeTruthy();
  });

  it("offers NO recompute verb and states the server hold instead", async () => {
    await draw(true);
    expect(screen.queryByText(/recompute now/i)).toBeNull();
    expect(
      screen.getByText(/Manual recompute is held server-side/),
    ).toBeTruthy();
  });
});
