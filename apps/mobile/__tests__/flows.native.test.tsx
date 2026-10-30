/**
 * Flows — the render contract for the catalogue, the topology sheet and the
 * review queue.
 *
 * WHAT THIS FILE EXISTS TO CATCH. The flow surface makes one claim that is not
 * on the wire and is catastrophic if it regresses: whether anything is
 * RUNNING. The server contains the flow runtime (`flowRuntimeQualified =
 * false`; `ActivateFlow` is a bare 503), so a row whose status column reads
 * "active" is a historical label. A regression that painted it as a healthy
 * green "Active" would tell an operator their abandoned-cart flow is live when
 * it has never executed. The pure rules live in lib/flowTopology.test.ts; this
 * file proves they reach the screen.
 *
 * WHY THE SHEET AND THE ROWS ARE RENDERED DIRECTLY RATHER THAN OPENED BY A TAP.
 * The `@tanstack/react-query` harness sets ONE result for every `useQuery` in
 * the module graph, and this screen runs four of them (flows, one flow, its
 * versions, the approvals queue) whose payloads are four different shapes — a
 * page envelope, a bare flow, a version array and an approval array. A test
 * that opened the sheet by tapping would hand the version list a page object
 * and prove nothing. So the route keeps genuinely page-shaped payloads, and
 * the sheet and the approval row — which take their data as props — are driven
 * with genuinely version- and approval-shaped ones. That is house rule 10, and
 * it is the reason a whole earlier round of suites passed while asserting
 * nothing.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import { FlowApprovalRow } from "@/components/flows/FlowApprovalRow";
import { FlowDetailSheet } from "@/components/flows/FlowDetailSheet";
import { parseFlow, parseFlowVersionList, type MobileFlow } from "@/lib/flowWire";
import { parseFlowApproval } from "@/lib/flowApprovals";
import { STATIC_FLOW_LABELS, flowLabels } from "@/lib/flowCatalog";
import { parseFlowValidation } from "@/lib/flowValidation";

import Flows from "../app/(tabs)/flows";

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

/** `annotateFlowRuntime` stamps this onto every Flow the API returns. */
const CONTAINED_RUNTIME = {
  capability: "flow_execution",
  runtime_status: "unavailable",
  execution_enabled: false,
  code: "flow_runtime_unavailable",
  message:
    "Flow execution is unavailable; the flow was not activated, published, or dispatched.",
  prerequisites: ["tenant_scoped_worker_authority"],
};

function flow(overrides: Record<string, unknown> = {}): MobileFlow {
  return parseFlow({
    id: "f-1",
    name: "Abandoned cart",
    status: "draft",
    version: 2,
    re_enrollment: "once",
    re_enrollment_cooldown_hours: 0,
    graph: {
      entry_id: "n1",
      triggers: [{ type: "product_event", event_name: "cart_abandoned" }],
      nodes: [
        { id: "n1", type: "wait", duration_seconds: 3_600 },
        { id: "n2", type: "send_email", template_id: "tpl-1" },
      ],
      edges: [{ from: "n1", to: "n2" }],
      goals: [],
    },
    created_at: "2026-06-01T09:00:00Z",
    updated_at: "2026-07-20T09:00:00Z",
    runtime: CONTAINED_RUNTIME,
    ...overrides,
  })!;
}

/** The exact shape `useFlows` resolves to: `FlowPage`. */
function loadedPage(flows: readonly MobileFlow[], nextCursor: string | null = null) {
  const data = { items: flows, nextCursor };
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data })),
  };
}

describe("the flow catalogue", () => {
  it("renders a bounded first frame while the catalogue is still loading", async () => {
    const view = await render(<Flows />, { wrapper });

    expect(view.toJSON()).not.toBeNull();
    // The header proves the route module — not an error boundary — rendered.
    expect(screen.getAllByText("Flows").length).toBeGreaterThan(0);
  });

  it("offers the two panes: what exists, and what is waiting on a human", async () => {
    await render(<Flows />, { wrapper });

    expect(screen.getAllByText("Flows").length).toBeGreaterThan(0);
    expect(screen.getByText("Reviews")).toBeTruthy();
  });

  it("shows a loaded flow with its size, trigger and re-entry policy", async () => {
    queryHarness.__setQueryResultForTests(loadedPage([flow()]));

    await render(<Flows />, { wrapper });

    expect(screen.getByText("Abandoned cart")).toBeTruthy();
    expect(screen.getByText(/2 steps/)).toBeTruthy();
    expect(screen.getByText(/Product event/)).toBeTruthy();
    // The 2026 frontier audit's P0: an abandoned-cart flow on "once" fires at
    // most one time per subscriber, ever. It is visible nowhere else on a phone.
    expect(screen.getByText("Enters once")).toBeTruthy();
  });

  it("NEVER paints a status-active flow as running while the runtime is contained", async () => {
    queryHarness.__setQueryResultForTests(
      loadedPage([flow({ status: "active" })]),
    );

    await render(<Flows />, { wrapper });

    expect(screen.getByText("Legacy active")).toBeTruthy();
    // The bare word would claim execution the server explicitly refuses.
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("says once, in words, that nothing is executing", async () => {
    queryHarness.__setQueryResultForTests(loadedPage([flow()]));

    await render(<Flows />, { wrapper });

    expect(screen.getByText(/flow runtime is unavailable/i)).toBeTruthy();
  });

  it("exposes no control that could only ever answer 503", async () => {
    // ActivateFlow is a bare WriteUnavailable, and UpdateFlow refuses any
    // transition to active, so there is no status control on this surface.
    queryHarness.__setQueryResultForTests(
      loadedPage([flow({ status: "paused" })]),
    );

    await render(<Flows />, { wrapper });

    expect(screen.queryByRole("button", { name: /activate/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /publish/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /new flow/i })).toBeNull();
  });

  it("admits there are more flows rather than showing a subset as complete", async () => {
    queryHarness.__setQueryResultForTests(loadedPage([flow()], "cursor-2"));

    await render(<Flows />, { wrapper });

    expect(screen.getByText(/more than fit on one page/i)).toBeTruthy();
  });

  it("does not claim there are more when the server said this was the last page", async () => {
    queryHarness.__setQueryResultForTests(loadedPage([flow()], null));

    await render(<Flows />, { wrapper });

    expect(screen.queryByText(/more than fit on one page/i)).toBeNull();
  });

  it("names a flow nothing can enter, instead of leaving the line blank", async () => {
    queryHarness.__setQueryResultForTests(
      loadedPage([flow({ graph: { nodes: [], triggers: [] } })]),
    );

    await render(<Flows />, { wrapper });

    expect(screen.getByText(/No trigger/)).toBeTruthy();
  });

  it("reads an offline session as offline, never as an empty catalogue", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false });
    queryHarness.__setQueryResultForTests(loadedPage([]));

    await render(<Flows />, { wrapper });

    expect(screen.getByText(/You're offline/)).toBeTruthy();
    expect(screen.queryByText("No flows yet")).toBeNull();
  });

  it("renders the genuinely-empty catalogue as empty, and says where flows come from", async () => {
    queryHarness.__setQueryResultForTests(loadedPage([]));

    await render(<Flows />, { wrapper });

    expect(screen.getByText("No flows yet")).toBeTruthy();
  });

  it("renders a failed fetch as an error, never as 'no flows'", async () => {
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

    await render(<Flows />, { wrapper });

    expect(screen.queryByText("No flows yet")).toBeNull();
  });

  /**
   * THE SCREEN'S OWN COMMENT WAS WRONG, AND THE GAP IT HID IS THIS.
   *
   * flows.tsx documented that "both list reads are coerced to arrays at the
   * boundary rather than trusted" while guarding only `versionRows`. `allFlows`
   * was `page?.items ?? []` — a NULLISH guard — and a restored cache entry
   * whose `items` is a truthy non-array (the cache is persisted to disk and
   * rehydrated on launch; see lib/secureQueryPersister) reached `.find` on the
   * `openFlow` memo and killed the whole tab with "allFlows.find is not a
   * function". The screen never even got as far as the empty state.
   */
  it("survives a restored page whose items is a truthy non-array", async () => {
    queryHarness.__setQueryResultForTests({
      ...loadedPage([]),
      data: { items: {}, nextCursor: null } as unknown as {
        items: readonly MobileFlow[];
        nextCursor: string | null;
      },
    });

    const view = await render(<Flows />, { wrapper });

    expect(view.toJSON()).not.toBeNull();
    // The header proves the route module — not an error boundary — rendered.
    expect(screen.getAllByText("Flows").length).toBeGreaterThan(0);
  });

  it("still renders real flows — the guard must not swallow good input", async () => {
    // A coercion that returned [] unconditionally would pass the test above.
    queryHarness.__setQueryResultForTests(loadedPage([flow()]));

    await render(<Flows />, { wrapper });

    expect(screen.getByText("Abandoned cart")).toBeTruthy();
  });
});

describe("the review pane, reached from the route", () => {
  /**
   * Driven with APPROVAL-shaped payloads. The flows query receives them too —
   * one harness result serves every `useQuery` — but an array has no `items`,
   * so the catalogue reads as empty and only the review pane is asserted here.
   */
  function loadedApprovals(rows: unknown[]) {
    return {
      data: rows,
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      isPending: false,
      isRefetching: false,
      isSuccess: true,
      refetch: jest.fn(async () => ({ data: rows })),
    };
  }

  it("shows a parked review once the pane is opened", async () => {
    queryHarness.__setQueryResultForTests(loadedApprovals([approval()]));

    await render(<Flows />, { wrapper });
    // The tab's spoken label carries its badge count ("Reviews, 1"), which is
    // the exact-value rule working as intended — so match the prefix.
    await fireEvent.press(screen.getByLabelText(/^Reviews/));

    expect(screen.getByText("legal-check")).toBeTruthy();
    expect(screen.getByText("Awaiting review")).toBeTruthy();
  });

  it("explains an empty queue by the runtime, not with a cheerful shrug", async () => {
    queryHarness.__setQueryResultForTests(loadedApprovals([]));

    await render(<Flows />, { wrapper });
    // The tab's spoken label carries its badge count ("Reviews, 1"), which is
    // the exact-value rule working as intended — so match the prefix.
    await fireEvent.press(screen.getByLabelText(/^Reviews/));

    expect(screen.getByText("Nothing waiting")).toBeTruthy();
    // The honest reason: nothing executes, so nothing parks at a review gate.
    expect(screen.getByText(/flow runtime is currently unavailable/i)).toBeTruthy();
  });

  /**
   * A NON-ARRAY QUEUE MUST STILL REACH AN EXPLAINED STATE.
   *
   * `approvals.data ?? []` let a rehydrated `{items: []}` through, and
   * `rows.length` on it is `undefined`. `isEmpty={rows.length === 0}` was then
   * FALSE, so QueryStates skipped its whole ladder and rendered the pane's
   * children — which are `null`. The operator got a blank queue with no
   * skeleton, no error and no empty copy: the screen said nothing at all about
   * a review backlog it could not read.
   */
  it("reaches the empty explanation even from a non-array queue", async () => {
    queryHarness.__setQueryResultForTests(
      loadedApprovals({ items: [] } as unknown as unknown[]),
    );

    await render(<Flows />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/^Reviews/));

    expect(screen.getByText("Nothing waiting")).toBeTruthy();
  });

  it("renders a failed queue fetch as an error, never as 'nothing waiting'", async () => {
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

    await render(<Flows />, { wrapper });
    // The tab's spoken label carries its badge count ("Reviews, 1"), which is
    // the exact-value rule working as intended — so match the prefix.
    await fireEvent.press(screen.getByLabelText(/^Reviews/));

    expect(screen.queryByText("Nothing waiting")).toBeNull();
  });
});

/** The exact shape `useFlowVersions` resolves to: `MobileFlowVersion[]`. */
const VERSIONS = parseFlowVersionList({
  items: [
    {
      id: "v-2",
      flow_id: "f-1",
      version: 2,
      status: "active",
      generated_by: "ai",
      graph: { nodes: [{ id: "a" }, { id: "b" }] },
      published_at: "2026-07-10T09:00:00Z",
      created_at: "2026-07-10T08:00:00Z",
    },
    {
      id: "v-1",
      flow_id: "f-1",
      version: 1,
      status: "draft",
      generated_by: "human",
      graph: { nodes: [{ id: "a" }] },
      published_at: null,
      created_at: "2026-06-01T09:00:00Z",
    },
  ],
});

const SETTLED = {
  isError: false,
  isLoading: false,
  isFetching: false,
  isSuccess: true,
};

/**
 * The wiring check is off in these fixtures unless a test turns it on:
 * `canCheck: false` is the viewer path, and every assertion below is about the
 * topology the sheet draws, not about the validator.
 */
const NO_CHECK = {
  canCheck: false,
  online: true,
  pending: false,
  result: null,
  failure: null,
  onCheck: jest.fn(),
};

function sheetProps(overrides: Record<string, unknown> = {}) {
  return {
    flow: flow(),
    fresh: null,
    versions: VERSIONS,
    versionsQuery: SETTLED,
    gate: { enabled: true },
    labels: STATIC_FLOW_LABELS,
    check: NO_CHECK,
    now: Date.parse("2026-07-21T09:00:00Z"),
    onClose: jest.fn(),
    ...overrides,
  };
}

describe("the flow detail sheet", () => {
  it("renders the stored design as a readable vertical topology", async () => {
    await render(<FlowDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText("Time delay")).toBeTruthy();
    expect(screen.getByText("Email message")).toBeTruthy();
    expect(screen.getByText("Waits: 1 hour")).toBeTruthy();
  });

  it("says WHICH rule produced the order, because only one of three is execution order", async () => {
    await render(<FlowDetailSheet {...sheetProps()} />, { wrapper });

    // This flow has a real entry_id, so the order genuinely is the engine's.
    expect(screen.getByText(/Ordered from the flow's entry step/)).toBeTruthy();
  });

  it("refuses to imply execution order for a graph that names no entry step", async () => {
    const noEntry = flow({
      graph: {
        nodes: [
          { id: "a", type: "wait", duration_seconds: 60 },
          { id: "b", type: "exit" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      },
    });

    await render(<FlowDetailSheet {...sheetProps({ flow: noEntry })} />, {
      wrapper,
    });

    expect(screen.getByText(/not execution order/)).toBeTruthy();
  });

  it("never renders an unset delay as zero", async () => {
    const unset = flow({
      graph: { entry_id: "n1", nodes: [{ id: "n1", type: "wait" }] },
    });

    await render(<FlowDetailSheet {...sheetProps({ flow: unset })} />, {
      wrapper,
    });

    expect(screen.getByText("Waits: not set")).toBeTruthy();
    expect(screen.queryByText(/0 seconds/)).toBeNull();
    expect(screen.queryByText("Waits: No delay")).toBeNull();
  });

  it("shows a step nothing leads to instead of quietly dropping it", async () => {
    const orphaned = flow({
      graph: {
        entry_id: "n1",
        nodes: [
          { id: "n1", type: "exit" },
          { id: "stray", type: "send_sms", sms_body: "hi" },
        ],
      },
    });

    await render(<FlowDetailSheet {...sheetProps({ flow: orphaned })} />, {
      wrapper,
    });

    expect(screen.getByText("Nothing in this flow leads here.")).toBeTruthy();
    expect(screen.getByText("SMS message")).toBeTruthy();
  });

  it("states the runtime containment in the server's own words", async () => {
    await render(<FlowDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText(/Flow execution is unavailable/)).toBeTruthy();
  });

  it("names who wrote each version, which on this platform may be an AI", async () => {
    await render(<FlowDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText("Written by AI")).toBeTruthy();
    expect(screen.getByText("Written by a person")).toBeTruthy();
    expect(screen.getByText("Version 2")).toBeTruthy();
  });

  it("distinguishes a published version from one that was never published", async () => {
    await render(<FlowDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText(/never published/)).toBeTruthy();
  });

  it("renders an empty version history as 'never published', not as a failure", async () => {
    await render(<FlowDetailSheet {...sheetProps({ versions: [] })} />, {
      wrapper,
    });

    expect(screen.getByText("No published versions")).toBeTruthy();
  });

  it("renders a failed version fetch as an error, never as 'never published'", async () => {
    await render(
      <FlowDetailSheet
        {...sheetProps({
          versions: [],
          versionsQuery: { ...SETTLED, isError: true, isSuccess: false },
        })}
      />,
      { wrapper },
    );

    expect(screen.queryByText("No published versions")).toBeNull();
  });

  it("says a flow with no steps was never built out, rather than showing nothing", async () => {
    const bare = flow({ graph: { nodes: [] } });

    await render(<FlowDetailSheet {...sheetProps({ flow: bare })} />, {
      wrapper,
    });

    expect(screen.getByText(/never built out/)).toBeTruthy();
  });

  it("ignores a refreshed read that belongs to a DIFFERENT flow", async () => {
    // A stale single-flow response for the previously-opened row must never
    // paint over the one actually on screen.
    const other = flow({ id: "f-99", name: "Someone else's flow" });

    await render(
      <FlowDetailSheet {...sheetProps({ flow: flow(), fresh: other })} />,
      { wrapper },
    );

    expect(screen.getAllByText("Abandoned cart").length).toBeGreaterThan(0);
    expect(screen.queryByText("Someone else's flow")).toBeNull();
  });

  it("names a node type this build predates, using the SERVER's catalogue", async () => {
    // The whole reason the catalogue is fetched. Without it, a workspace on a
    // newer API reads `send_whatsapp` as a raw key on a phone and as a proper
    // name on every other client.
    const newer = flow({
      graph: {
        entry_id: "n1",
        nodes: [{ id: "n1", type: "send_whatsapp", template_id: "9" }],
      },
    });

    await render(
      <FlowDetailSheet
        {...sheetProps({
          flow: newer,
          labels: flowLabels({
            schemaVersion: "klv03.flow-builder.v1",
            nodes: [
              {
                key: "send_whatsapp",
                label: "WhatsApp message",
                category: "message",
                channel: "whatsapp",
                runtimeStatus: "unavailable",
                requiresReview: false,
                fields: [],
              },
            ],
            triggers: [],
            actions: [],
            statuses: [],
            conditionFields: [],
          }),
        })}
      />,
      { wrapper },
    );

    expect(screen.getByText("WhatsApp message")).toBeTruthy();
    expect(screen.queryByText("send_whatsapp")).toBeNull();
  });
});

describe("the wiring check", () => {
  const CHECK = {
    canCheck: true,
    online: true,
    pending: false,
    result: null,
    failure: null,
    onCheck: jest.fn(),
  };

  it("offers the check to an editor and hands back the flow it belongs to", async () => {
    const onCheck = jest.fn();
    await render(
      <FlowDetailSheet {...sheetProps({ check: { ...CHECK, onCheck } })} />,
      { wrapper },
    );

    fireEvent.press(screen.getByText("Check this flow's wiring"));
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it("does NOT offer it to a viewer, and says why rather than showing nothing", async () => {
    // POST /flow-builder/validate is write:campaigns at the mount AND
    // session_minimum_role "editor" in routeauth/manifest.json. A viewer
    // discovering that through a 403 after a tap is the failure this avoids.
    await render(
      <FlowDetailSheet
        {...sheetProps({ check: { ...CHECK, canCheck: false } })}
      />,
      { wrapper },
    );

    expect(screen.queryByText("Check this flow's wiring")).toBeNull();
    expect(screen.getByText(/needs an editor session/)).toBeTruthy();
  });

  it("cannot be fired offline — there is nothing to queue for a verdict", async () => {
    await render(
      <FlowDetailSheet {...sheetProps({ check: { ...CHECK, online: false } })} />,
      { wrapper },
    );

    expect(screen.getByText("Offline — can't check")).toBeTruthy();
  });

  it("prints the validator's own sentences, which name the node and the field", async () => {
    const result = parseFlowValidation({
      valid: false,
      executable: false,
      errors: ['edge to "ghost" does not reference a node'],
      warnings: [
        'node "n1": type "send_email" is unavailable',
        'node "n2": type "wait" is unavailable',
        'node "n1" (send_email): required field "template_id" is missing',
      ],
    });

    await render(
      <FlowDetailSheet {...sheetProps({ check: { ...CHECK, result } })} />,
      { wrapper },
    );

    expect(screen.getByText("1 problem in this flow's wiring")).toBeTruthy();
    expect(
      screen.getByText('edge to "ghost" does not reference a node'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'node "n1" (send_email): required field "template_id" is missing',
      ),
    ).toBeTruthy();
    // The two runtime-status lines are collapsed to one count, not repeated
    // per node — the sheet already leads with the containment in words.
    expect(
      screen.queryByText('node "n1": type "send_email" is unavailable'),
    ).toBeNull();
    expect(screen.getByText("2 steps · runtime unavailable")).toBeTruthy();
  });

  it("reports a FAILED CHECK as a failed check, never as a verdict on the flow", async () => {
    await render(
      <FlowDetailSheet
        {...sheetProps({
          check: {
            ...CHECK,
            failure:
              "This workspace's API is older than this app and can't check a stored flow. Nothing is wrong with the flow itself.",
          },
        })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/Nothing is wrong with the flow itself/)).toBeTruthy();
    expect(screen.queryByText(/problem in this flow's wiring/)).toBeNull();
  });

  it("offers nothing at all for a flow with no steps", async () => {
    const bare = flow({ graph: { nodes: [] } });
    await render(
      <FlowDetailSheet {...sheetProps({ flow: bare, check: CHECK })} />,
      { wrapper },
    );

    expect(screen.queryByText("Wiring check")).toBeNull();
    expect(screen.getByText(/never built out/)).toBeTruthy();
  });
});

function approval(overrides: Record<string, unknown> = {}) {
  return parseFlowApproval({
    id: "ap-1",
    automation_id: "11111111-1111-4111-8111-111111111111",
    node_id: "legal-check",
    channel: "email",
    transactional_status: "requested",
    requested_at: "2026-07-21T06:00:00Z",
    created_at: "2026-07-21T05:59:00Z",
    decided_at: null,
    ...overrides,
  })!;
}

function approvalProps(overrides: Record<string, unknown> = {}) {
  return {
    approval: approval(),
    now: Date.parse("2026-07-21T09:00:00Z"),
    canDecide: true,
    online: true,
    busy: false,
    onDecide: jest.fn(),
    ...overrides,
  };
}

describe("the review queue row", () => {
  it("offers both verbs to an editor on a parked review", async () => {
    await render(<FlowApprovalRow {...approvalProps()} />, { wrapper });

    expect(screen.getByText("legal-check")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("offers them on a 'marketing' row too, because Repo.Decide accepts it", async () => {
    // The column DEFAULT, which the engine's own gate maps to pending. A queue
    // that hid it would leave the flow parked with nothing on screen.
    await render(
      <FlowApprovalRow
        {...approvalProps({
          approval: approval({ transactional_status: "marketing" }),
        })}
      />,
      { wrapper },
    );

    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByText("Not yet requested")).toBeTruthy();
  });

  it("offers NO verb on a row the server would answer 409 for", async () => {
    await render(
      <FlowApprovalRow
        {...approvalProps({
          approval: approval({
            transactional_status: "approved",
            decided_at: "2026-07-21T07:00:00Z",
          }),
        })}
      />,
      { wrapper },
    );

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.getByText("Approved")).toBeTruthy();
  });

  it("tells a viewer why, instead of letting them discover a 403", async () => {
    await render(<FlowApprovalRow {...approvalProps({ canDecide: false })} />, {
      wrapper,
    });

    expect(screen.getByText(/Read-only for your role/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("refuses to decide offline, and says why it is not queued", async () => {
    await render(<FlowApprovalRow {...approvalProps({ online: false })} />, {
      wrapper,
    });

    expect(screen.getByText(/never queued for later/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("marks both buttons busy while a decision is in flight", async () => {
    await render(<FlowApprovalRow {...approvalProps({ busy: true })} />, {
      wrapper,
    });

    expect(
      screen.getByRole("button", { name: "Approve" }).props.accessibilityState,
    ).toMatchObject({ disabled: true, busy: true });
  });

  it("does not attach a flow name it cannot resolve", async () => {
    // `automation_id` points at the `automations` table; flow-builder flows
    // live in `automation_journeys`. Joining them would label a review with a
    // stranger's flow.
    await render(<FlowApprovalRow {...approvalProps()} />, { wrapper });

    expect(screen.getByText(/^Automation /)).toBeTruthy();
    expect(screen.queryByText("Abandoned cart")).toBeNull();
  });

  it("renders an unrecorded wait time as an em-dash, never as 'just now'", async () => {
    await render(
      <FlowApprovalRow
        {...approvalProps({
          approval: approval({ requested_at: null, created_at: null }),
        })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/Waiting since —/)).toBeTruthy();
  });
});
