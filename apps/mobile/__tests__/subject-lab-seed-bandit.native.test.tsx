/**
 * Subject Lab, arrived at FROM a campaign (P2.8) — the two things the deep
 * link has to do that a direct open of the tab never does:
 *
 *   1. Seed the campaign's subject into BOTH boxes. The generator alone is
 *      not enough: `/variants` is the flag-gated LLM endpoint, off by default,
 *      and "Score these" only fires once variants exist — so a seed that only
 *      reached the generator would strand behind an entitlement refusal and
 *      the person would retype it into the scorer. That retype is the exact
 *      copy-paste the link exists to remove.
 *
 *   2. Arm the lab → bandit handoff. Under a ranked reading, and only when
 *      `?campaignId` named a campaign, "Run top N as a bandit" creates the
 *      A/B test on THAT campaign's audience with desktop's exact
 *      delivery_settings (useCampaignCreation.ts runBandit). Without the
 *      param there is no audience to test against, so there is no button.
 *
 * The screen is rendered for real; only the two data hooks it reads and the
 * one API call it makes are replaced, so the assertions cover the wiring
 * (params → panels → row → payload) rather than the mocks.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as ExpoRouter from "expo-router";
import { router } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import { readSubjectBuckets, readSubjectLabScore } from "@/lib/subjectLab";

import SubjectLab from "../app/(tabs)/subject-lab";

// The two data hooks the screen reads, controllable per test.
let mockBucketsResult: Record<string, unknown> = {};
let mockScoreResult: Record<string, unknown> = {};
jest.mock("@/hooks/useSubjectLab", () => ({
  useSubjectBuckets: () => mockBucketsResult,
  useScoreSubjects: () => mockScoreResult,
}));

// The one write the bandit row makes.
const mockCreateABTest = jest.fn<(input: unknown) => Promise<unknown>>();
jest.mock("@/api/abTests", () => ({
  createABTestCampaign: (input: unknown) => mockCreateABTest(input),
}));

const routerHarness = ExpoRouter as unknown as {
  __setSearchParamsForTests: (over: Record<string, unknown>) => void;
};
const hooksHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
  __setHookResultForTests: (name: string, value: unknown) => void;
  __resetHookResultsForTests: () => void;
};

const SEED = "Your April report is ready";
const SEED_FIELD = "Subject line to generate variants from";
const SCORE_FIELD = "Subject lines to score, one per line";

const CAMPAIGN = {
  id: "cmp_1",
  name: "April",
  subject: SEED,
  status: "draft",
  body_html: "<p>hi</p>",
  from_name: "Acme Team",
  list_id: "list_1",
};

function loadedQuery(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

function idleMutation(data?: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => ({})),
    reset: jest.fn(),
    variables: undefined,
  };
}

/** Four scored variants so the top-3 cut is observable. */
const SCORED_WIRE = {
  baseline_open: 0.184,
  window_days: 180,
  variants: [
    { text: SEED, predicted_open: 0.231, ci_low: 0.198, ci_high: 0.264, matched_n: 14, low_confidence: false },
    { text: "ACT NOW!!!", predicted_open: 0.101, ci_low: 0.062, ci_high: 0.14, matched_n: 7, low_confidence: false },
    { text: "A quiet one", predicted_open: 0.19, ci_low: 0.04, ci_high: 0.34, matched_n: 2, low_confidence: true },
    { text: "Fourth option", predicted_open: 0.15, ci_low: 0.12, ci_high: 0.18, matched_n: 9, low_confidence: false },
  ],
};

async function renderScreen(): Promise<void> {
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <SubjectLab />
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  hooksHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
  mockBucketsResult = loadedQuery(
    readSubjectBuckets({ window_days: 180, campaigns_total: 0, buckets: [] }),
  );
  mockScoreResult = idleMutation();
  mockCreateABTest.mockResolvedValue({
    data: { parent: { id: "cmp_parent" }, children: [] },
    error: null,
  });
});

afterEach(() => {
  routerHarness.__setSearchParamsForTests({});
  hooksHarness.__resetOnlineGateForTests();
  hooksHarness.__resetHookResultsForTests();
});

describe("arriving with ?seed", () => {
  it("seeds BOTH the generator and the scorer with the campaign's subject", async () => {
    routerHarness.__setSearchParamsForTests({ seed: SEED, campaignId: "cmp_1" });
    await renderScreen();
    expect(screen.getByLabelText(SEED_FIELD).props.value).toBe(SEED);
    expect(screen.getByLabelText(SCORE_FIELD).props.value).toBe(SEED);
    // One candidate is scoreable on its own — no generation, no flag needed.
    expect(screen.getByLabelText("Score").props.accessibilityState).toEqual({
      disabled: false,
    });
  });

  it("leaves both boxes empty on a direct open", async () => {
    await renderScreen();
    expect(screen.getByLabelText(SEED_FIELD).props.value).toBe("");
    expect(screen.getByLabelText(SCORE_FIELD).props.value).toBe("");
  });
});

describe("lab → bandit handoff", () => {
  it("runs the ranked top three as a bandit on the campaign's audience", async () => {
    routerHarness.__setSearchParamsForTests({ seed: SEED, campaignId: "cmp_1" });
    hooksHarness.__setHookResultForTests("useCampaign", loadedQuery(CAMPAIGN));
    mockScoreResult = idleMutation(readSubjectLabScore(SCORED_WIRE));
    await renderScreen();

    const button = screen.getByLabelText("Run top 3 as a bandit");
    expect(button.props.accessibilityState).toEqual({ disabled: false, busy: false });
    await fireEvent.press(button);

    expect(mockCreateABTest).toHaveBeenCalledTimes(1);
    const payload = mockCreateABTest.mock.calls[0]?.[0] as Record<string, unknown>;
    // The panel's own ranking: confident rows by predicted open, the
    // low-confidence row last — so "A quiet one" (0.19, low) is cut.
    expect(payload.subject_variants).toEqual([SEED, "Fourth option", "ACT NOW!!!"]);
    expect(payload.delivery_settings).toEqual({
      ab_test: { bandit: true, policy: "thompson_opens", explore_floor: 0.1 },
    });
    expect(payload.audience_list_id).toBe("list_1");
    expect(payload.body_html).toBe("<p>hi</p>");
    // A bandit reallocates traffic itself; a fixed split would contradict it.
    expect("split_percentage" in payload).toBe(false);

    // Lands on the new parent's detail screen, where it gets scheduled.
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith({
        pathname: "/(tabs)/campaigns/[id]",
        params: { id: "cmp_parent" },
      }),
    );
  });

  it("offers no bandit when the lab was opened without a campaign", async () => {
    routerHarness.__setSearchParamsForTests({ seed: SEED });
    hooksHarness.__setHookResultForTests("useCampaign", loadedQuery(CAMPAIGN));
    mockScoreResult = idleMutation(readSubjectLabScore(SCORED_WIRE));
    await renderScreen();
    // The reading itself still renders — only the handoff is withheld.
    expect(screen.getByText("Fourth option")).toBeTruthy();
    expect(screen.queryByLabelText(/as a bandit/)).toBeNull();
  });

  it("renders the missing-audience refusal as a sentence, not a button", async () => {
    routerHarness.__setSearchParamsForTests({ seed: SEED, campaignId: "cmp_1" });
    hooksHarness.__setHookResultForTests(
      "useCampaign",
      loadedQuery({ ...CAMPAIGN, list_id: undefined }),
    );
    mockScoreResult = idleMutation(readSubjectLabScore(SCORED_WIRE));
    await renderScreen();
    expect(screen.queryByLabelText(/as a bandit/)).toBeNull();
    expect(
      screen.getByText(/This campaign has no list or segment yet/),
    ).toBeTruthy();
    expect(mockCreateABTest).not.toHaveBeenCalled();
  });

  it("says so when the campaign it was opened from cannot be read", async () => {
    routerHarness.__setSearchParamsForTests({ seed: SEED, campaignId: "cmp_1" });
    hooksHarness.__setHookResultForTests("useCampaign", {
      ...loadedQuery(undefined),
      error: new Error("boom"),
      isError: true,
      isSuccess: false,
    });
    mockScoreResult = idleMutation(readSubjectLabScore(SCORED_WIRE));
    await renderScreen();
    expect(screen.queryByLabelText(/as a bandit/)).toBeNull();
    expect(
      screen.getByText(/Couldn't load the campaign this lab was opened from/),
    ).toBeTruthy();
  });

  it("withholds the handoff while the online gate is closed", async () => {
    routerHarness.__setSearchParamsForTests({ seed: SEED, campaignId: "cmp_1" });
    hooksHarness.__setOnlineGateForTests({ effectiveRole: "editor", enabled: false });
    hooksHarness.__setHookResultForTests("useCampaign", loadedQuery(CAMPAIGN));
    mockScoreResult = idleMutation(readSubjectLabScore(SCORED_WIRE));
    await renderScreen();
    expect(screen.queryByLabelText(/as a bandit/)).toBeNull();
  });
});
