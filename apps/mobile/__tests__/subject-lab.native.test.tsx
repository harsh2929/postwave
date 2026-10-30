/**
 * Subject Lab — the render contract for mobile's AI scoring surface.
 *
 * THE AUTHORISATION THIS FILE PINS, and why it needs pinning twice. apps/api
 * authorises every route at two independent gates: the
 * `apikeys.RequireScope(...)` wrapper at the mount site and
 * `routeauth.Middleware`, which evaluates
 * apps/api/internal/routeauth/manifest.json on its own. For this screen's two
 * routes the gates DISAGREE, and only the manifest carries the real floor:
 *
 *   GET  /api/v1/subject-analyzer/buckets  mount read:reports     · manifest viewer
 *   POST /api/v1/subject-lab/score         mount write:campaigns  · manifest EDITOR
 *   POST /api/v1/subject-lab/variants      mount write:campaigns  · manifest EDITOR
 *
 * A screen built from the handler files alone would put the composer in front
 * of every viewer, where it can return nothing but 403. The role cases below
 * are what stops that regressing — in BOTH directions. This file previously
 * recorded the score floor as `admin` and pinned an editor being refused;
 * subject_lab.go MountRoutes mounts both POSTs under write:campaigns and
 * routeauth/manifest.json records `"session_minimum_role": "editor"` for both,
 * so that assertion was pinning a permission the server grants. The floor is
 * editor, the viewer is the role that must be refused, and the refusal copy is
 * asserted here too so it can never again name a rule the server does not have.
 *
 * THE SECOND THING PINNED IS AN HONESTY CONTRACT. `subject_lab.go`'s
 * `scoringModel` swallows an empty or unreadable corpus to `baseline = 0` and
 * marks every variant `low_confidence`, so the wire body for "this workspace
 * has never sent anything" is indistinguishable from a real measurement of
 * zero unless the client refuses to read it as one. The empty-corpus case
 * asserts an em-dash and an explanation, never "0.0%".
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as GateHooks from "@/hooks/useOnlineQueryGate";
import { readSubjectBuckets, readSubjectLabScore } from "@/lib/subjectLab";

import SubjectLab from "../app/(tabs)/subject-lab";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const gateHarness = GateHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

const BUCKETS_WIRE = {
  window_days: 180,
  campaigns_total: 42,
  buckets: [
    {
      attribute: "length",
      bucket: "short",
      campaigns: 12,
      open_rate: 0.24,
      click_rate: 0.03,
    },
    {
      attribute: "length",
      bucket: "very_long",
      campaigns: 6,
      open_rate: 0.11,
      click_rate: 0.01,
    },
  ],
};

function loadedBuckets(wire: unknown) {
  return {
    data: readSubjectBuckets(wire),
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

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

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
});

describe("Subject Lab", () => {
  it("offers scoring to an admin", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    queryHarness.__setQueryResultForTests(loadedBuckets(BUCKETS_WIRE));
    await renderScreen();
    expect(screen.getByText("Score a subject line")).toBeTruthy();
    expect(
      screen.getByLabelText("Subject lines to score, one per line"),
    ).toBeTruthy();
    // Nothing typed yet, so the control refuses rather than posting an empty
    // list the server would 400.
    expect(screen.getByLabelText("Score").props.accessibilityState).toEqual({
      disabled: true,
    });
  });

  it("offers scoring to an EDITOR — the manifest floor for both POSTs", async () => {
    // The server's floor, measured at both gates: subject_lab.go mounts
    // write:campaigns and the manifest says session_minimum_role "editor".
    // Refusing an editor here told them they lacked a permission they hold.
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    queryHarness.__setQueryResultForTests(loadedBuckets(BUCKETS_WIRE));
    await renderScreen();
    expect(screen.getByText("Score a subject line")).toBeTruthy();
    expect(screen.getByLabelText("Score")).toBeTruthy();
    expect(screen.queryByText("Writing and scoring need editor access")).toBeNull();
  });

  it("withholds scoring from a viewer, and names the real floor when it does", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    queryHarness.__setQueryResultForTests(loadedBuckets(BUCKETS_WIRE));
    await renderScreen();
    expect(screen.queryByText("Score a subject line")).toBeNull();
    expect(screen.queryByLabelText("Score")).toBeNull();
    expect(screen.getByText("Writing and scoring need editor access")).toBeTruthy();
    // The refusal must not name a stricter rule than the server has: an
    // "admin-only" sentence here is a false statement about apps/api.
    expect(screen.queryByText(/admin/i)).toBeNull();
    // The viewer-readable half is still there — that is the whole reason the
    // evidence rollup is a separate route with a separate floor.
    expect(screen.getByText("What works for your list")).toBeTruthy();
  });

  it("shows a viewer what has worked, with the sample size attached", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    queryHarness.__setQueryResultForTests(loadedBuckets(BUCKETS_WIRE));
    await renderScreen();
    expect(screen.getByText("How long should it be?")).toBeTruthy();
    expect(screen.getByText("Under 30 characters")).toBeTruthy();
    expect(screen.getByText("24.0%")).toBeTruthy();
    expect(screen.getByText("n=12")).toBeTruthy();
    expect(
      screen.getByText(
        "Under 30 characters opens 13.0 pts higher than 80+ characters.",
      ),
    ).toBeTruthy();
  });

  it("says so, rather than inventing a pattern, when there is no history", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    queryHarness.__setQueryResultForTests(
      loadedBuckets({ window_days: 180, campaigns_total: 0, buckets: [] }),
    );
    await renderScreen();
    expect(screen.getByText("Nothing measured yet")).toBeTruthy();
  });

  it("refuses to run offline and says why", async () => {
    gateHarness.__setOnlineGateForTests({
      effectiveRole: "admin",
      enabled: false,
    });
    queryHarness.__setQueryResultForTests(loadedBuckets(BUCKETS_WIRE));
    await renderScreen();
    expect(screen.getByText("Reconnect to open Subject Lab")).toBeTruthy();
    expect(
      screen.getByText("Reconnect to read your subject-line history."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Score").props.accessibilityState).toEqual({
      disabled: true,
    });
  });
});

/**
 * The reader is unit-tested in src/lib/subjectLab.test.ts; this asserts the one
 * thing a unit test cannot — that the honest reading is what the SCREEN would
 * render for the empty-corpus body the server actually sends.
 */
/**
 * The Subject Lab shipped able to GRADE a subject line and unable to WRITE
 * one, so every candidate had to be invented elsewhere and pasted in.
 * POST /api/v1/subject-lab/variants closes that, and what is pinned here is
 * the part a refactor breaks silently: the control is offered on the same bit
 * as scoring, and it refuses a request the server would refuse anyway.
 *
 * The `subject_lab` feature flag is deliberately NOT modelled. It is per
 * tenant, off by default, has no probe, and answers with the shared
 * entitlement envelope — so the honest client offers the control and renders
 * the refusal. A test that hid the panel would be pinning a lie to every
 * workspace that has the flag on.
 */
describe("Subject Lab generation", () => {
  const SEED_FIELD = "Subject line to generate variants from";

  it("offers the generator to whoever may score", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    queryHarness.__setQueryResultForTests(loadedBuckets(BUCKETS_WIRE));
    await renderScreen();
    expect(screen.getByText("Write some options")).toBeTruthy();
    expect(screen.getByLabelText(SEED_FIELD)).toBeTruthy();
  });

  it("offers it to an EDITOR, whom the server admits to /variants", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    queryHarness.__setQueryResultForTests(loadedBuckets(BUCKETS_WIRE));
    await renderScreen();
    expect(screen.getByText("Write some options")).toBeTruthy();
    expect(screen.getByLabelText("Generate")).toBeTruthy();
  });

  it("withholds it from anyone who could not score the results", async () => {
    // Generating candidates for someone who cannot then evaluate them is a
    // button that leads nowhere — and a viewer holds neither route.
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    queryHarness.__setQueryResultForTests(loadedBuckets(BUCKETS_WIRE));
    await renderScreen();
    expect(screen.queryByText("Write some options")).toBeNull();
    expect(screen.queryByLabelText("Generate")).toBeNull();
  });

  it("refuses a seed shorter than the server's floor, and stops refusing at it", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    queryHarness.__setQueryResultForTests(loadedBuckets(BUCKETS_WIRE));
    await renderScreen();
    const button = screen.getByLabelText("Generate");
    // Nothing typed: the control refuses rather than posting a seed the
    // handler answers with `seed_too_short`.
    expect(button.props.accessibilityState).toEqual({ disabled: true });

    await fireEvent.changeText(screen.getByLabelText(SEED_FIELD), "too short");
    expect(
      screen.getByLabelText("Generate").props.accessibilityState,
    ).toEqual({ disabled: true });
    expect(screen.getByText(/at least 10 characters/)).toBeTruthy();

    await fireEvent.changeText(
      screen.getByLabelText(SEED_FIELD),
      "Your April report is ready",
    );
    expect(
      screen.getByLabelText("Generate").props.accessibilityState,
    ).toEqual({ disabled: false });
  });

  it("cannot be fired while the online gate is closed", async () => {
    // /variants is a live LLM call with no offline projection, and it is not
    // queueable — so an offline tap could only produce a late failure.
    gateHarness.__setOnlineGateForTests({
      effectiveRole: "admin",
      enabled: false,
    });
    queryHarness.__setQueryResultForTests(loadedBuckets(BUCKETS_WIRE));
    await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText(SEED_FIELD),
      "Your April report is ready",
    );
    expect(
      screen.getByLabelText("Generate").props.accessibilityState,
    ).toEqual({ disabled: true });
  });
});

describe("empty-corpus honesty", () => {
  it("reads a zero baseline as unmeasured, not as a zero open rate", () => {
    const reading = readSubjectLabScore({
      baseline_open: 0,
      window_days: 180,
      variants: [
        {
          text: "Spring sale",
          predicted_open: 0,
          ci_low: 0,
          ci_high: 0.15,
          matched_n: 0,
          low_confidence: true,
        },
      ],
    });
    expect(reading.insufficient).toBe(true);
    expect(reading.baselineLabel).toBe("—");
    expect(reading.rows[0]?.predictedLabel).toBe("—");
  });
});
