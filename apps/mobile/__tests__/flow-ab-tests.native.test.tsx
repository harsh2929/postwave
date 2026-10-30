/**
 * Flow A/B tests — the render contract for the in-flow split monitor.
 *
 * WHY THIS FILE EXISTS. `app/(tabs)/flow-ab-tests.tsx` and the four components
 * under `components/flow-ab/` shipped with policy tests only
 * (`lib/flowAbTests.test.ts` drives the parsers, and `lib/flowAbPolicy.ts` is
 * pure judgement). Nothing had ever MOUNTED any of it. Policy tests prove the
 * sentences are right; they cannot prove the screen survives being opened, and
 * in this programme that distinction has already cost a crashed dashboard —
 * `MaintenanceBanner` took the whole surface down with "windows.find is not a
 * function" the first time a query answered something other than an array, with
 * 31 green policy tests behind it.
 *
 * TWO ENTRY POINTS, ON PURPOSE. The screen runs THREE queries (the catalogue,
 * one test's config, one test's counters) and the `@tanstack/react-query`
 * harness sets ONE result for every `useQuery` in the module graph. So the list
 * is driven through the route — where the sheet is closed and the shared payload
 * cannot reach it — and `FlowAbTestSheet` is driven DIRECTLY by props, which is
 * the only way its three inputs can disagree the way they do in production (the
 * config lands, the counters 500). Rendering the whole screen with one payload
 * would hand the arms the catalogue and pass while asserting nothing.
 *
 * THE PAYLOADS ARE BUILT BY THE REAL PARSERS. `parseFlowAbTestList` /
 * `parseFlowAbResults` are what `api/flowAbTests` hands these components, so the
 * fixtures below are raw Go-shaped wire rows put through them. The assertions
 * are typed-out literal sentences — the parser supplies the INPUT, never the
 * expectation. That is what pins the parse→render seam, which the mobile logic
 * audit found to be this client's dominant failure class (response-shape drift
 * → silently-empty screens).
 *
 * WHAT THIS PROTECTS. Every assertion is a WRONG SENTENCE or a crash:
 *
 *   - "No in-flow A/B tests" shown because the list request failed tells an
 *     operator no automation in the workspace has a split configured. The
 *     subtitle's "0 running" is the same lie with a number on it: absence is not
 *     zero, and this screen's whole design is that its three empty-looking
 *     states mean completely different things.
 *   - A failed COUNTERS fetch rendering "0.0%" says an arm is converting nobody
 *     when the truth is that nothing was measured. That reads as a failing
 *     variant, which has a completely different fix from a failing request.
 *   - `conversion_rate` is a 0..1 FRACTION (flowabtests.go:190). Treating it as a
 *     percentage renders 21% as 0.2% — the exact bug the campaign A/B card
 *     carries a comment about.
 *   - A stored verdict presented UNDATED lets a week-old evaluation be read as
 *     the current state of a running test.
 *   - No surface here may offer the evaluation: `POST /{id}/evaluate` writes
 *     `status='completed'`, `ended_at=now()` (setWinner, :205). A button that
 *     quietly ends a live experiment is the one control this screen exists to
 *     not have.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { FlowAbTestSheet } from "@/components/flow-ab/FlowAbTestSheet";
import * as Gate from "@/hooks/useOnlineQueryGate";
import {
  parseFlowAbResults,
  parseFlowAbTest,
  parseFlowAbTestList,
} from "@/lib/flowAbTests";

import FlowAbTests, { ErrorBoundary } from "../app/(tabs)/flow-ab-tests";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const hookHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  hookHarness.__resetOnlineGateForTests();
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

/** A row exactly as `flowabtests.ABTest` marshals it (flowabtests.go:45). */
function wireTest(overrides: Record<string, unknown> = {}) {
  return {
    id: "ab-1",
    automation_id: "au-1",
    node_id: "welcome-split",
    status: "running",
    variants: [
      { id: "v-control", label: "Original subject", percentage: 50 },
      { id: "v-b", label: "Shorter subject", percentage: 50 },
    ],
    created_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-16T09:00:00Z",
    ...overrides,
  };
}

/** `List` answers `{"items": [...]}` (:340), through the real parser. */
function loadedList(rows: readonly Record<string, unknown>[]) {
  return settled(parseFlowAbTestList({ items: rows }));
}

/** `Results` answers `{"results": [...]}` (:441), through the real parser. */
function counters(rows: readonly Record<string, unknown>[]) {
  return parseFlowAbResults({ results: rows });
}

function settled(value: unknown) {
  return {
    data: value,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: value })),
  };
}

function failed() {
  return {
    data: undefined,
    error: new Error("upstream unavailable"),
    isError: true,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

function online(role = "admin") {
  hookHarness.__setOnlineGateForTests({
    enabled: true,
    tenantId: "t1",
    effectiveRole: role,
    online: true,
  });
}

describe("flow A/B tests screen render contract", () => {
  it("mounts at all", async () => {
    // The assertion this file is really for: before this, nothing had ever
    // rendered this route.
    online();
    queryHarness.__setQueryResultForTests(loadedList([wireTest()]));
    await render(<FlowAbTests />, { wrapper });
    expect(screen.getByText("Flow A/B tests")).toBeTruthy();
    expect(screen.getByText("Node welcome-split")).toBeTruthy();
  });

  it("counts the running splits and says how many exist", async () => {
    online();
    queryHarness.__setQueryResultForTests(
      loadedList([
        wireTest(),
        wireTest({ id: "ab-2", node_id: "winback-split", status: "completed" }),
      ]),
    );
    await render(<FlowAbTests />, { wrapper });
    expect(screen.getByText("1 running · 2 splits")).toBeTruthy();
  });

  it("floats the still-collecting splits above the historical ones", async () => {
    // The server answers `ORDER BY created_at DESC` (:79) and knows nothing
    // about status. A completed test's counters are a record; a running one's
    // are a live measurement, and reading one as the other is the mistake the
    // ordering exists to prevent — so the newest row must not win here.
    online();
    queryHarness.__setQueryResultForTests(
      loadedList([
        wireTest({ id: "ab-new", node_id: "newest-but-done", status: "completed" }),
        wireTest({ id: "ab-old", node_id: "older-but-live", status: "running" }),
      ]),
    );
    await render(<FlowAbTests />, { wrapper });
    const titles = screen
      .getAllByText(/^Node /u)
      .map((node) => node.props.children);
    expect(titles).toEqual(["Node older-but-live", "Node newest-but-done"]);
  });

  it("does not tell a failed fetch that no automation has a split", async () => {
    // "No in-flow A/B tests" is a fact about the WORKSPACE. Rendering it
    // because a request failed is the most damaging string on this screen, and
    // it is one collapsed error ladder away.
    online();
    queryHarness.__setQueryResultForTests(failed());
    await render(<FlowAbTests />, { wrapper });
    expect(screen.queryByText("No in-flow A/B tests")).toBeNull();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("says the running count is UNKNOWN rather than zero when the list failed", async () => {
    // "0 running" is a very specific and reassuring claim to make about a
    // workspace whose list you did not receive. So is "Nothing is collecting
    // right now" — that one is a claim about the automation RUNTIME derived
    // from a network failure.
    online();
    queryHarness.__setQueryResultForTests(failed());
    await render(<FlowAbTests />, { wrapper });
    expect(screen.getByText("— running")).toBeTruthy();
    expect(screen.queryByText(/0 running/u)).toBeNull();
    expect(screen.queryByText(/Nothing is collecting right now/u)).toBeNull();
  });

  it("does say nothing is collecting once the list has actually resolved", async () => {
    // The other half of the pair above: with the fetch settled, "nothing is
    // collecting" is a true statement about the workspace and withholding it
    // would leave a page of paused splits explaining nothing.
    online();
    queryHarness.__setQueryResultForTests(
      loadedList([wireTest({ status: "paused" })]),
    );
    await render(<FlowAbTests />, { wrapper });
    expect(screen.getByText("0 running · 1 split")).toBeTruthy();
    expect(screen.getByText(/Nothing is collecting right now/u)).toBeTruthy();
  });

  it("asks a gate-closed session to reconnect instead of reporting an empty workspace", async () => {
    // Offline is not broken and it is not empty. A cached conversion rate of
    // unknown age is the thing this screen refuses to show.
    hookHarness.__setOnlineGateForTests({ enabled: false, tenantId: "t1" });
    queryHarness.__setQueryResultForTests(settled(undefined));
    await render(<FlowAbTests />, { wrapper });
    expect(screen.getByText(/Connect to your workspace/u)).toBeTruthy();
    expect(screen.queryByText("No in-flow A/B tests")).toBeNull();
    expect(screen.getByText("— running")).toBeTruthy();
  });

  it("calls a workspace with no splits empty rather than broken", async () => {
    online();
    queryHarness.__setQueryResultForTests(loadedList([]));
    await render(<FlowAbTests />, { wrapper });
    expect(screen.getByText("No in-flow A/B tests")).toBeTruthy();
    expect(screen.queryByText("Try again")).toBeNull();
  });

  it("renders a split whose every omitempty field was dropped", async () => {
    // `automation_id`, `label`, `percentage`, `winner` and `updated_at` are all
    // `omitempty` on the Go structs, so a minimal row is a real payload — and
    // it must render rather than throw or go blank.
    online();
    queryHarness.__setQueryResultForTests(
      settled(parseFlowAbTestList({ items: [{ id: "ab-bare" }] })),
    );
    await render(<FlowAbTests />, { wrapper });
    expect(screen.getByText("Unnamed split")).toBeTruthy();
    expect(screen.getByText("0 variants")).toBeTruthy();
    expect(screen.getByText(/Update time not recorded/u)).toBeTruthy();
    expect(screen.getByText(/Not evaluated yet/u)).toBeTruthy();
  });

  it("still mounts when the list carries no array at all", async () => {
    // The restored-cache / disabled-query path hands the list `undefined` and
    // the status sort runs during render, which is where MaintenanceBanner died
    // ("windows.find is not a function") with 31 green policy tests behind it.
    //
    // AWAITED, not `expect(() => render(...)).not.toThrow()`. RNTL 14's `render`
    // is an ASYNC function (dist/render.js:22), so a render that throws rejects
    // a promise instead of throwing synchronously and that matcher passes for a
    // component that cannot mount at all — I checked, with a component whose
    // body is nothing but `throw`. Awaiting is what makes a crash fail this
    // test; the getByText is what makes a BLANK screen fail it too.
    online();
    queryHarness.__setQueryResultForTests(settled(undefined));
    await render(<FlowAbTests />, { wrapper });
    expect(screen.getByText("Flow A/B tests")).toBeTruthy();
    expect(screen.getByText("— running")).toBeTruthy();
  });

  it("keeps a malformed payload inside this tab", async () => {
    // The route's whole containment story is `export { AppErrorBoundary as
    // ErrorBoundary }`, and Expo Router is the only thing that reads it — so
    // nothing else on this device notices if it goes. It matters here more than
    // on a typical route: the variant list is free-form JSON authored on a
    // canvas, and `orderTests` calls `.map` on whatever the query holds. A
    // payload that reached this screen with its `{items: […]}` envelope still
    // on it throws "tests.map is not a function" during the sort, and this
    // export is what decides whether that costs one tab or the app shell.
    expect(typeof ErrorBoundary).toBe("function");
  });

  it("offers no evaluation control to an admin, and says where ending a test lives", async () => {
    // The one write that reads like a read. `POST /{id}/evaluate` computes the
    // verdict AND writes status='completed', ended_at=now() (:205) — a one-way
    // act for the whole workspace. Admin or not, this screen must not carry it,
    // and it must say so rather than leave the absence looking like an
    // oversight.
    online();
    queryHarness.__setQueryResultForTests(loadedList([wireTest()]));
    await render(<FlowAbTests />, { wrapper });
    expect(screen.queryByText(/Evaluate/u)).toBeNull();
    expect(screen.queryByText(/Declare/u)).toBeNull();
    expect(screen.getByText(/stay on desktop/u)).toBeTruthy();
  });

  it("shows the whole roster to a viewer", async () => {
    // The three reads are mounted `RequireScope(ScopeReadCampaigns)` and
    // nothing in the package calls requireAdmin: `read:campaigns` is in
    // `readOnlyScopes` (apikeys/middleware.go:332), so no role check is applied
    // and the route row carries no minimumRole. A screen that hid itself from a
    // viewer would defeat the row it was opened from — and there is nothing to
    // withhold, because there is no destructive control to gate.
    online("viewer");
    queryHarness.__setQueryResultForTests(loadedList([wireTest()]));
    await render(<FlowAbTests />, { wrapper });
    expect(screen.getByText("Node welcome-split")).toBeTruthy();
    expect(screen.getByText("1 running · 1 split")).toBeTruthy();
  });
});

/**
 * The sheet takes THREE independently-failing inputs, so it is driven by props.
 * Through the screen they would all be the same harness payload, and the
 * "config landed, counters did not" case — the one that decides whether a rate
 * is unknown or zero — would be unreachable.
 */
describe("flow A/B test sheet render contract", () => {
  const test = parseFlowAbTest(wireTest());

  it("mounts and names the arms, marking the server's control", async () => {
    // `controlVariantID` is `Variants[0].ID` (:295), and the recorded verdict is
    // a comparison AGAINST it — a reader who cannot see which arm is the
    // baseline cannot interpret the verdict above it.
    await render(
      <FlowAbTestSheet
        test={test}
        detail={null}
        results={counters([
          { variant_id: "v-control", assigned: 500, converted: 105, conversion_rate: 0.21 },
          { variant_id: "v-b", assigned: 500, converted: 130, conversion_rate: 0.26 },
        ])}
        resultsLoading={false}
        resultsFailed={false}
        onClose={() => {}}
      />,
      { wrapper },
    );
    expect(screen.getByText("Node welcome-split")).toBeTruthy();
    expect(screen.getByText("Original subject")).toBeTruthy();
    expect(screen.getByText("Shorter subject")).toBeTruthy();
    expect(screen.getByText("Control")).toBeTruthy();
  });

  it("reads conversion_rate as the FRACTION the server computes", async () => {
    // `Repo.Results` returns converted/assigned (:190). Treating 0.21 as a
    // percentage renders a healthy arm as 0.2% — the campaign A/B card carries
    // a comment about exactly this bug on the neighbouring endpoint.
    await render(
      <FlowAbTestSheet
        test={test}
        detail={null}
        results={counters([
          { variant_id: "v-control", assigned: 500, converted: 105, conversion_rate: 0.21 },
        ])}
        resultsLoading={false}
        resultsFailed={false}
        onClose={() => {}}
      />,
      { wrapper },
    );
    expect(screen.getByText("21.0%")).toBeTruthy();
    expect(screen.queryByText("0.2%")).toBeNull();
    expect(screen.getByText("105 converted of 500 assigned")).toBeTruthy();
  });

  it("spends an em-dash on an arm the runtime never bucketed anyone into", async () => {
    // A counter row only exists once the engine has bucketed somebody
    // (postgres_store.go:466). "0.0%" here would say the variant is failing;
    // the truth is that it is receiving no traffic, which has a completely
    // different fix.
    await render(
      <FlowAbTestSheet
        test={test}
        detail={null}
        results={counters([
          { variant_id: "v-control", assigned: 500, converted: 105, conversion_rate: 0.21 },
        ])}
        resultsLoading={false}
        resultsFailed={false}
        onClose={() => {}}
      />,
      { wrapper },
    );
    expect(
      screen.getByText(
        "No assignments recorded — the runtime has not bucketed anyone into this arm",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("0.0%")).toBeNull();
  });

  it("makes no comparative claim when the counters fetch failed", async () => {
    // The counters fail SEPARATELY from the config: the arms still render, and
    // every rate has to become unknown rather than zero. A "leader" derived
    // from a failed fetch would be a verdict invented out of a network error.
    await render(
      <FlowAbTestSheet
        test={test}
        detail={null}
        results={counters([
          { variant_id: "v-control", assigned: 500, converted: 105, conversion_rate: 0.21 },
          { variant_id: "v-b", assigned: 500, converted: 130, conversion_rate: 0.26 },
        ])}
        resultsLoading={false}
        resultsFailed
        onClose={() => {}}
      />,
      { wrapper },
    );
    expect(screen.getByText(/live counters could not be loaded/u)).toBeTruthy();
    expect(screen.getByText("Original subject")).toBeTruthy();
    // Both rate figures rendered, and both rendered UNKNOWN. Asserting only the
    // absence of "0.0%" would pass just as well if the arms had vanished, which
    // is the shape of a test that proves nothing.
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText("21.0%")).toBeNull();
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.queryByText(/is ahead by/u)).toBeNull();
  });

  it("names a leader in words that are not a result", async () => {
    // `flowAbLeader` computes no p-value and the word "winner" is reserved for
    // the STORED verdict. The margin is printed beside the claim so the reader
    // is not asked to trust an adjective.
    await render(
      <FlowAbTestSheet
        test={test}
        detail={null}
        results={counters([
          { variant_id: "v-control", assigned: 500, converted: 105, conversion_rate: 0.21 },
          { variant_id: "v-b", assigned: 500, converted: 130, conversion_rate: 0.26 },
        ])}
        resultsLoading={false}
        resultsFailed={false}
        onClose={() => {}}
      />,
      { wrapper },
    );
    expect(
      screen.getByText(
        "Shorter subject is ahead by 5.0 points. Ahead is not a result — the winner is decided by the evaluation on desktop.",
      ),
    ).toBeTruthy();
  });

  it("refuses to name a leader below the sample floor", async () => {
    // Under 100 assignments a single conversion moves the rate by a whole
    // point, so the ordering is noise. Naming a leader there is the reading a
    // 2am glance would act on.
    await render(
      <FlowAbTestSheet
        test={test}
        detail={null}
        results={counters([
          { variant_id: "v-control", assigned: 10, converted: 1, conversion_rate: 0.1 },
          { variant_id: "v-b", assigned: 9, converted: 3, conversion_rate: 0.3333 },
        ])}
        resultsLoading={false}
        resultsFailed={false}
        onClose={() => {}}
      />,
      { wrapper },
    );
    expect(screen.getByText(/Too few assignments to compare/u)).toBeTruthy();
    expect(screen.queryByText(/is ahead by/u)).toBeNull();
  });

  it("dates a stored verdict and warns that the counters may have moved", async () => {
    // `winner` is only written by the evaluation, which also ends the test
    // (:205). Undated, a week-old verdict reads as the current state of the
    // arms rendered underneath it.
    const evaluated = parseFlowAbTest(
      wireTest({
        status: "completed",
        winner: {
          variant_id: "v-b",
          conversion_rate: 0.26,
          p_value: 0.012,
          significant: true,
          method: "two_proportion_z",
          evaluated_at: "2026-08-10T12:00:00Z",
        },
      }),
    );
    await render(
      <FlowAbTestSheet
        test={evaluated}
        detail={null}
        results={counters([
          { variant_id: "v-control", assigned: 500, converted: 105, conversion_rate: 0.21 },
          { variant_id: "v-b", assigned: 500, converted: 130, conversion_rate: 0.26 },
        ])}
        resultsLoading={false}
        resultsFailed={false}
        onClose={() => {}}
      />,
      { wrapper },
    );
    expect(screen.getByText("Shorter subject won this evaluation")).toBeTruthy();
    expect(screen.getByText(/p = 0\.012/u)).toBeTruthy();
    expect(
      screen.getByText(
        /^Evaluated .+ — the counters below may have moved since\.$/u,
      ),
    ).toBeTruthy();
  });

  it("never calls an inconclusive evaluation a win", async () => {
    // The server's z-test did not clear alpha; the arm named is merely the best
    // observed rate. Presenting that as a winner is the one thing the stored
    // verdict must not be allowed to say.
    const inconclusive = parseFlowAbTest(
      wireTest({
        status: "completed",
        winner: {
          variant_id: "v-b",
          conversion_rate: 0.26,
          p_value: 0.4,
          significant: false,
          inconclusive: true,
          method: "two_proportion_z",
        },
      }),
    );
    await render(
      <FlowAbTestSheet
        test={inconclusive}
        detail={null}
        results={counters([])}
        resultsLoading={false}
        resultsFailed={false}
        onClose={() => {}}
      />,
      { wrapper },
    );
    expect(screen.getByText("Inconclusive — Shorter subject led")).toBeTruthy();
    expect(screen.queryByText(/won this evaluation/u)).toBeNull();
    // The verdict landed with no `evaluated_at`, and an undated one has to say
    // so rather than quietly drop the caveat the dated branch carries.
    expect(screen.getByText("Evaluation time not recorded.")).toBeTruthy();
  });

  it("keeps the traffic of a variant the stored config no longer lists", async () => {
    // The runtime bucketed subscribers into an arm a later edit removed. Those
    // assignments are real; dropping the row would quietly shrink the
    // denominator a reader is comparing against.
    await render(
      <FlowAbTestSheet
        test={test}
        detail={null}
        results={counters([
          { variant_id: "v-control", assigned: 500, converted: 105, conversion_rate: 0.21 },
          { variant_id: "v-removed", assigned: 120, converted: 30, conversion_rate: 0.25 },
        ])}
        resultsLoading={false}
        resultsFailed={false}
        onClose={() => {}}
      />,
      { wrapper },
    );
    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.getByText("v-removed")).toBeTruthy();
    expect(screen.getByText("30 converted of 120 assigned")).toBeTruthy();
  });

  it("says no assignments exist at all rather than showing a zero", async () => {
    // The configured-but-never-entered case for the WHOLE test. This is the
    // only one of the three empty-looking states that is an operational
    // problem, so it must not be rendered as a set of zeroes.
    await render(
      <FlowAbTestSheet
        test={test}
        detail={null}
        results={counters([])}
        resultsLoading={false}
        resultsFailed={false}
        onClose={() => {}}
      />,
      { wrapper },
    );
    expect(
      screen.getByText("No assignments recorded on any of 2 arms."),
    ).toBeTruthy();
  });

  it("opens on a split with no variants and no counters yet", async () => {
    // `GET /ab-tests/{id}` answers a BARE object, `parseFlowAbTest` keeps a row
    // whose every optional field was dropped, and the counters are still in
    // flight. Awaited rather than wrapped in `not.toThrow()` — see the screen
    // suite: RNTL 14's `render` is async, so that matcher passes for a
    // component that throws on sight.
    await render(
      <FlowAbTestSheet
        test={parseFlowAbTest({ id: "ab-bare" })}
        detail={null}
        results={counters([])}
        resultsLoading
        resultsFailed={false}
        onClose={() => {}}
      />,
      { wrapper },
    );
    expect(screen.getByText("Unnamed split")).toBeTruthy();
    expect(screen.getByText("Loading counters…")).toBeTruthy();
    // Zero arms is not "nothing to compare because the traffic is thin" — the
    // subtitle has to hold either way, and `flowAbTotals` reports 0 of 0.
    expect(
      screen.getByText("No assignments recorded on any of 0 arms."),
    ).toBeTruthy();
  });
});
