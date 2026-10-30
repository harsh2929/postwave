/**
 * Lookalike audiences — the render contract for the list, the row and the sheet.
 *
 * WHAT THIS FILE EXISTS TO CATCH. This surface makes exactly one claim that
 * would be dangerous if it regressed silently: whether a modeled audience is
 * FINISHED and USABLE. Two of its states — `pending`/`running` and an
 * unrecognised status — carry a `member_count` that nobody has written yet, and
 * a screen that prints that count beside a confident label tells an operator
 * their audience matched nobody, or matched 4,000 people, when neither is a
 * measurement. The pure precedence rules are pinned in
 * src/lib/lookalikeHealth.test.ts; this file proves they reach the screen.
 *
 * THE SECOND THING IT PINS IS THE PII BOUNDARY. `GetLookalike` withholds member
 * identities unless `include_pii=true` (subscribers/lookalike.go:262), and this
 * sheet keeps that default: nothing is requested until somebody presses the
 * button. A regression that pre-revealed the list would put real subscriber
 * addresses on a phone screen as a side effect of looking at a size.
 *
 * WHY THE ROW AND SHEET ARE RENDERED DIRECTLY RATHER THAN REACHED BY A TAP. The
 * `@tanstack/react-query` harness sets ONE result for every `useQuery` in the
 * module graph, so a test that opened the sheet would hand the member query the
 * audience array and the segments query the same — the mock-shape mismatch that
 * makes a suite pass while asserting nothing (house rule 10). Both components
 * take their data as props, so they are driven with genuinely correctly-shaped
 * payloads here and the route keeps genuinely audience-shaped ones.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import { LookalikeDetailSheet } from "@/components/lookalike/LookalikeDetailSheet";
import { LookalikeRow } from "@/components/lookalike/LookalikeRow";
import {
  parseLookalikeAudience,
  parseLookalikeMemberPage,
  type LookalikeAudience,
} from "@/lib/lookalikeAudiences";

import Lookalike from "../app/(tabs)/lookalike";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** The exact shape `useLookalikeAudiences` resolves to: `LookalikeAudience[]`. */
function loaded(audiences: readonly LookalikeAudience[]) {
  return {
    data: audiences,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: audiences })),
  };
}

function model(overrides: Record<string, unknown> = {}): LookalikeAudience {
  return parseLookalikeAudience({
    id: "look-1",
    name: "High-value buyers lookalike",
    seed_segment_id: "seg-1",
    size_requested: 5000,
    member_count: 5000,
    seed_count: 800,
    confidence_threshold: null,
    model_version: "first-party-v1",
    status: "ready",
    exported_destination_id: null,
    payload: {
      candidate_count: 40_000,
      scored: 5000,
      feature_dims: ["email_domain", "signup_source", "engagement", "retention"],
      bands: { high: 3000, medium: 1500, low: 500 },
      data_use_notice_version: "first-party-lookalike-v1",
    },
    error: "",
    created_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    updated_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    ...overrides,
  })!;
}

describe("the lookalike list", () => {
  it("renders a bounded first frame while the catalogue is still loading", async () => {
    const view = await render(<Lookalike />, { wrapper });

    expect(view.toJSON()).not.toBeNull();
    // The header proves the route module — not an error boundary — rendered.
    expect(screen.getAllByText("Lookalike audiences").length).toBeGreaterThan(0);
  });

  it("offers the two questions worth opening a phone for", async () => {
    await render(<Lookalike />, { wrapper });

    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.getByText("Needs a look")).toBeTruthy();
    expect(screen.getByText("Stale")).toBeTruthy();
  });

  it("shows a loaded model with what it matched against what was asked for", async () => {
    queryHarness.__setQueryResultForTests(loaded([model()]));

    await render(<Lookalike />, { wrapper });

    expect(screen.getByText("High-value buyers lookalike")).toBeTruthy();
    expect(screen.getByText(/of 5K asked for/)).toBeTruthy();
  });

  it("says on the LIST that a model matched nobody — no tap required", async () => {
    queryHarness.__setQueryResultForTests(loaded([model({ member_count: 0 })]));

    await render(<Lookalike />, { wrapper });

    expect(
      screen.getByLabelText(
        "Empty: the model finished but matched nobody, so sending to this audience reaches no one.",
      ),
    ).toBeTruthy();
  });

  it("REFUSES to print a member count for a model that has not finished", async () => {
    // `member_count` defaults to 0 and is only written at the end, so "0 of 5K"
    // beside "Building" would be a confident lie about an unwritten number.
    queryHarness.__setQueryResultForTests(
      loaded([model({ status: "running", member_count: 0 })]),
    );

    await render(<Lookalike />, { wrapper });

    expect(screen.getByText("— of 5K asked for")).toBeTruthy();
    expect(screen.queryByText("0 of 5K asked for")).toBeNull();
    expect(
      screen.getByLabelText(
        "Still building: its member count is not final yet, so nothing here is the finished audience.",
      ),
    ).toBeTruthy();
  });

  it("treats a status it does not recognise as unrecognised, never as ready", async () => {
    queryHarness.__setQueryResultForTests(
      loaded([model({ status: "materialising", member_count: 4000 })]),
    );

    await render(<Lookalike />, { wrapper });

    expect(screen.getByText("— of 5K asked for")).toBeTruthy();
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("flags a majority-weak audience even though it filled the ask", async () => {
    queryHarness.__setQueryResultForTests(
      loaded([model({ payload: { bands: { high: 200, medium: 300, low: 4500 } } })]),
    );

    await render(<Lookalike />, { wrapper });

    expect(screen.getByText("Weak match")).toBeTruthy();
  });

  it("warns that an old model is a frozen snapshot, with the threshold named", async () => {
    queryHarness.__setQueryResultForTests(
      loaded([
        model({ created_at: new Date(Date.now() - 90 * DAY_MS).toISOString() }),
      ]),
    );

    await render(<Lookalike />, { wrapper });

    expect(screen.getByText(/Built more than 30 days ago/)).toBeTruthy();
    expect(screen.getByText(/frozen snapshot/)).toBeTruthy();
  });

  it("reads an offline session as offline, never as an empty catalogue", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false });
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<Lookalike />, { wrapper });

    expect(screen.getByText(/You're offline/)).toBeTruthy();
    expect(screen.queryByText("No lookalike audiences yet")).toBeNull();
  });

  it("renders the genuinely-empty catalogue as empty, and says where models come from", async () => {
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<Lookalike />, { wrapper });

    expect(screen.getByText("No lookalike audiences yet")).toBeTruthy();
    expect(screen.getByText(/generated on desktop/)).toBeTruthy();
  });

  it("renders a failed fetch as an error, never as 'no models'", async () => {
    queryHarness.__setQueryResultForTests({
      data: undefined,
      error: new Error("boom"),
      isError: true,
      isFetching: false,
      isLoading: false,
      isPending: false,
      isRefetching: false,
      isSuccess: false,
      refetch: jest.fn(async () => ({ data: undefined })),
    });

    await render(<Lookalike />, { wrapper });

    // The five-state ladder's error rung, with a retry — not a "nothing here".
    expect(screen.getByText(/Something went wrong loading this/)).toBeTruthy();
    expect(screen.getByLabelText("Retry")).toBeTruthy();
    expect(screen.queryByText("No lookalike audiences yet")).toBeNull();
  });
});

describe("one model's row", () => {
  const rowProps = {
    audience: model(),
    onPress: jest.fn(),
    now: Date.now(),
  };

  it("names the seed segment when the catalogue resolved it", async () => {
    await render(
      <LookalikeRow {...rowProps} seedName="High value customers" />,
      { wrapper },
    );

    expect(screen.getByText(/High value customers/)).toBeTruthy();
  });

  it("says the seed is UNRESOLVED rather than inventing one or showing a uuid", async () => {
    await render(<LookalikeRow {...rowProps} seedName={null} />, { wrapper });

    expect(screen.getByText(/Seed segment not resolved/)).toBeTruthy();
    expect(screen.queryByText(/seg-1/)).toBeNull();
  });
});

describe("the model detail sheet", () => {
  const SETTLED_MEMBERS = {
    isError: false,
    isLoading: false,
    isFetching: false,
    isSuccess: true,
  };

  /** The exact shape `useLookalikeMembers` resolves to. */
  const PAGE = parseLookalikeMemberPage({
    audience: null,
    members: [
      {
        subscriber_id: "s-1",
        email: "ada@example.test",
        similarity_score: 0.9412,
        rank: 1,
        features: {
          "domain:example.test": 1,
          "source:checkout": 1,
          engagement: 0.88,
          retention: 0.74,
        },
      },
    ],
    page: 1,
    per_page: 25,
    pii_included: true,
  });

  function sheetProps(overrides: Record<string, unknown> = {}) {
    return {
      audience: model(),
      seedName: "High value customers",
      onClose: jest.fn(),
      revealed: false,
      onReveal: jest.fn(),
      members: [],
      membersQuery: SETTLED_MEMBERS,
      piiIncluded: false,
      gate: { enabled: true },
      online: true,
      ...overrides,
    };
  }

  it("shows the similarity breakdown, which is the whole reason it exists", async () => {
    await render(<LookalikeDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText("Similarity to the seed")).toBeTruthy();
    expect(screen.getByText(/Strong \(similarity 0.8 and above\)/)).toBeTruthy();
    expect(screen.getByText(/Weak \(below 0.5\)/)).toBeTruthy();
  });

  it("says a MISSING histogram is missing, never draws it as three zeroes", async () => {
    await render(
      <LookalikeDetailSheet
        {...sheetProps({ audience: model({ payload: { candidate_count: 10 } }) })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/It is not zero — it is\s+missing/)).toBeTruthy();
  });

  it("says a model that filled the ask exactly stopped at its ceiling", async () => {
    await render(<LookalikeDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText(/stopped at the ceiling/)).toBeTruthy();
  });

  it("says a model that fell short ran out of eligible people", async () => {
    // The opposite reading from the ceiling case, off two numbers that look
    // identical at a glance.
    await render(
      <LookalikeDetailSheet
        {...sheetProps({ audience: model({ member_count: 3000 }) })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/short of the 5,000 asked for/)).toBeTruthy();
    expect(screen.getByText(/eligible pool ran out/)).toBeTruthy();
  });

  it("warns that a capped candidate pool never saw part of the workspace", async () => {
    await render(
      <LookalikeDetailSheet
        {...sheetProps({
          audience: model({ payload: { candidate_count: 50_000 } }),
        })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/never scored/)).toBeTruthy();
  });

  it("says an association with a destination is NOT a delivery", async () => {
    await render(
      <LookalikeDetailSheet
        {...sheetProps({
          audience: model({ exported_destination_id: "dest-77" }),
        })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/not a delivery/)).toBeTruthy();
  });

  it("says a model with no confidence floor kept everyone the ranker scored", async () => {
    await render(<LookalikeDetailSheet {...sheetProps()} />, { wrapper });

    expect(
      screen.getByLabelText(
        "Confidence floor: No confidence floor was set, so everyone the ranker scored was eligible regardless of how weakly they matched.",
      ),
    ).toBeTruthy();
  });

  it("holds identities back until somebody asks, and says so", async () => {
    const onReveal = jest.fn();
    await render(<LookalikeDetailSheet {...sheetProps({ onReveal })} />, {
      wrapper,
    });

    expect(screen.getByText(/does not pull real addresses onto your/)).toBeTruthy();
    expect(screen.queryByText("ada@example.test")).toBeNull();

    fireEvent.press(screen.getByLabelText("Show the 25 most similar members"));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("cannot request identities offline, and says they are never cached", async () => {
    await render(<LookalikeDetailSheet {...sheetProps({ online: false })} />, {
      wrapper,
    });

    expect(
      screen.getByLabelText("Show the 25 most similar members").props
        .accessibilityState.disabled,
    ).toBe(true);
    expect(screen.getByText(/never cached to this device/)).toBeTruthy();
  });

  it("shows WHY the model picked a revealed member, not just that it did", async () => {
    await render(
      <LookalikeDetailSheet
        {...sheetProps({
          revealed: true,
          members: PAGE.members,
          piiIncluded: true,
        })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/ada@example.test/)).toBeTruthy();
    // Four decimals: the stored numeric(5,4) precision, not a rounded percent.
    expect(screen.getByText(/Similarity 0.9412/)).toBeTruthy();
    expect(
      screen.getByText(/Shares domain example.test and signup via checkout/),
    ).toBeTruthy();
  });

  it("distinguishes 'members withheld' from 'this audience is empty'", async () => {
    await render(
      <LookalikeDetailSheet
        {...sheetProps({ revealed: true, members: [], piiIncluded: false })}
      />,
      { wrapper },
    );

    expect(screen.getByText("Identities withheld")).toBeTruthy();
    expect(screen.getByText(/not an empty audience/)).toBeTruthy();
  });

  it("renders a failed member fetch as an error, never as 'no members'", async () => {
    await render(
      <LookalikeDetailSheet
        {...sheetProps({
          revealed: true,
          members: [],
          membersQuery: { ...SETTLED_MEMBERS, isError: true, isSuccess: false },
        })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/Something went wrong loading this/)).toBeTruthy();
    expect(screen.queryByText("Identities withheld")).toBeNull();
    expect(screen.queryByText("No members returned")).toBeNull();
  });

  it("offers no ranked list at all for a model that has not finished", async () => {
    await render(
      <LookalikeDetailSheet
        {...sheetProps({ audience: model({ status: "pending", member_count: 0 }) })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/no ranked list behind\s+it yet/)).toBeTruthy();
    expect(screen.queryByLabelText("Show the 25 most similar members")).toBeNull();
  });

  it("surfaces the server's own reason a model failed", async () => {
    await render(
      <LookalikeDetailSheet
        {...sheetProps({
          audience: model({
            status: "failed",
            error: "seed segment needs at least 50 live members (found 12)",
          }),
        })}
      />,
      { wrapper },
    );

    expect(
      screen.getByText("seed segment needs at least 50 live members (found 12)"),
    ).toBeTruthy();
  });

  it("says plainly that generating and discarding stay on desktop", async () => {
    await render(<LookalikeDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText(/Generating a lookalike stays on desktop/)).toBeTruthy();
  });
});
