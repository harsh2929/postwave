/**
 * Templates — the render contract for the design library, its five-state
 * ladder, its goal filter, and the two verbs.
 *
 * WHY THIS FILE MOCKS `useCampaignTemplates` INSTEAD OF DRIVING THE SHARED
 * `@tanstack/react-query` HARNESS. That harness returns ONE result for every
 * query in the module graph, and this screen holds three with three different
 * shapes: an INFINITE catalogue (`{ pages: TemplateCatalogPage[] }`), a goal
 * rollup (`TemplateGoalCount[]`), and a single-template read
 * (`MobileTemplate | null`). Feeding all three the same object is precisely the
 * round-4 failure it caused elsewhere — suites that passed only on error paths
 * because no loaded-state assertion could be expressed. Mocking the hook module
 * gives each one its real return type, which is the shape the screen consumes.
 *
 * WHAT IS DELIBERATELY NOT MOCKED. `useTemplateActions`, `ConfirmSheet`,
 * `Toast`, `templatePolicy` and the row/sheet components are all real: the
 * confirm-before-clone, the role gate, and the eligibility refusal are the
 * riskiest decisions on this surface, and stubbing any of them would turn an
 * assertion about the product into an assertion about a stub.
 *
 * THE AUTHORISATION THIS FILE PINS. Reading the catalogue passes
 * `apikeys.RequireScope(read:campaigns)`, which is in `readOnlyScopes`, so any
 * authenticated dashboard user gets the list. `POST /{id}/clone` and
 * `/{id}/create-campaign` are `write:campaigns`, which is NOT read-only and is
 * admitted for owner/admin/editor only (`sessionRoleAllowsScopes` +
 * `editorWriteScopes`). That asymmetry — browse for everyone, act for editors —
 * is what the "viewer" cases below exist to hold in place.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";
import { TemplateDetailSheet } from "@/components/templates/TemplateDetailSheet";
import * as GateHooks from "@/hooks/useOnlineQueryGate";
import {
  parseGoalCounts,
  parseTemplate,
  parseTemplateCatalogPage,
  type MobileTemplate,
  type TemplateCatalogPage,
  type TemplateGoalCount,
} from "@/lib/templateCatalog";

jest.mock("@/hooks/useCampaignTemplates", () => {
  const state: Record<string, unknown> = {};
  return {
    __state: state,
    // Args are RECORDED: the shelf/sort controls' whole job is what they make
    // this hook ask the server for, so the seam under test is the arguments.
    useTemplateCatalog: (...args: unknown[]) => {
      state["catalogArgs"] = args;
      return state["catalog"];
    },
    useTemplateGoals: () => state["goals"],
    useTemplateDetail: () => state["detail"],
    useCloneTemplate: () => state["clone"],
    useStartCampaignFromTemplate: () => state["start"],
    // The favourite star. Shape matches the real return type (a TanStack
    // mutation), not a bare function: a stub whose shape drifts lets a suite
    // pass on its error path while hiding every loaded-state assertion.
    useSetTemplateFavorite: () => state["favorite"] ?? { mutate: jest.fn() },
  };
});

import * as TemplateHooks from "@/hooks/useCampaignTemplates";

import Templates from "../app/(tabs)/templates";

const hookState = (
  TemplateHooks as unknown as { __state: Record<string, unknown> }
).__state;

const gateHarness = GateHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
  /** OS reachability, separate from the auth gate — see the mock's own note. */
  __setIsOnlineForTests: (value: boolean) => void;
};

// ---------------------------------------------------------------------------
// Fixtures — every one built by the real parser from a payload shaped like the
// Go marshaller's, `omitempty` omissions included.
// ---------------------------------------------------------------------------

/**
 * A catalogue row as `Repo.Search` emits one: both body columns projected to
 * '' (catalog.go:182), so `bodyLoaded` is false and the body state is unknown.
 */
const CATALOG_PAGE: TemplateCatalogPage = parseTemplateCatalogPage({
  items: [
    {
      id: "tpl-1",
      tenant_id: "11111111-1111-4111-8111-111111111111",
      slug: "spring-launch",
      name: "Spring launch",
      subject: "The spring drop is live",
      description: "Announce the seasonal drop",
      body_html: "",
      body_mjml: "",
      variables: [{ name: "first_name" }],
      tags: ["seasonal"],
      goal: "promotional",
      usage_count: 12,
      last_used_at: "2026-07-01T09:00:00Z",
      template_kind: "editable",
      review_status: "approved",
      source_license_status: "owned",
      source_provider: "postwave",
    },
    {
      // The reference library (migration 1748): captured for inspiration, and
      // refused by the server for both verbs.
      id: "tpl-2",
      slug: "competitor-newsletter",
      name: "Allbirds weekly",
      subject: "This week at Allbirds",
      variables: [],
      tags: [],
      goal: "newsletter",
      template_kind: "reference",
      review_status: "approved",
      source_license_status: "owned",
      source_brand: "Allbirds",
    },
  ],
  page: 1,
  per_page: 24,
  total: 2,
});

const GOAL_COUNTS: TemplateGoalCount[] = parseGoalCounts([
  // The server sorts count-descending and CAN emit a blank-goal bucket
  // (extras.go:146); the parser drops the blank one and the rail re-sorts.
  { goal: "", count: 4 },
  { goal: "promotional", count: 7 },
  { goal: "welcome", count: 2 },
]);

/** The single read — the only response whose body fields mean anything. */
const DETAIL: MobileTemplate = parseTemplate(
  {
    id: "tpl-1",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    slug: "spring-launch",
    name: "Spring launch",
    subject: "The spring drop is live",
    body_html: "<p>Hello</p>",
    variables: [{ name: "first_name" }],
    tags: ["seasonal"],
    goal: "promotional",
    template_kind: "editable",
    review_status: "approved",
    source_license_status: "owned",
  },
  "detail",
)!;

/** The reference row's single read: still refused, and now body-bearing. */
const REFERENCE_DETAIL: MobileTemplate = parseTemplate(
  {
    id: "tpl-2",
    slug: "competitor-newsletter",
    name: "Allbirds weekly",
    subject: "This week at Allbirds",
    body_html: "<p>captured</p>",
    variables: [],
    tags: [],
    template_kind: "reference",
    review_status: "approved",
    source_license_status: "owned",
    source_brand: "Allbirds",
  },
  "detail",
)!;

function catalogResult(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: true,
    isPending: true,
    isSuccess: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(async () => undefined),
    refetch: jest.fn(async () => ({ data: undefined })),
    ...overrides,
  };
}

function loadedCatalog(pages: TemplateCatalogPage[]) {
  return catalogResult({
    data: { pages, pageParams: [1] },
    isLoading: false,
    isPending: false,
    isSuccess: true,
  });
}

function queryResult(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: undefined })),
    ...overrides,
  };
}

function mutationResult(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => null),
    reset: jest.fn(),
    variables: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  hookState["catalog"] = catalogResult();
  hookState["goals"] = queryResult({ data: [] as TemplateGoalCount[] });
  hookState["detail"] = queryResult({ data: null });
  hookState["clone"] = mutationResult();
  hookState["start"] = mutationResult();
  // The route table gives this screen no role floor (reading is viewer-and-up),
  // and the shared gate mock carries no role — so the default render is the
  // read-only one, which is the state most sessions are actually in.
  gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
});

afterEach(() => {
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
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </SafeAreaProvider>
  );
}

// ---------------------------------------------------------------------------
// The five-state ladder
// ---------------------------------------------------------------------------

describe("the catalogue's five states", () => {
  it("LOADING: renders a bounded first frame, and no verdict about the library", async () => {
    const view = await render(<Templates />, { wrapper });

    expect(view.toJSON()).not.toBeNull();
    expect(screen.getAllByText("Templates").length).toBeGreaterThan(0);
    // No count is known yet, so none is claimed — and "nothing here" is not
    // said about a fetch that has not finished.
    expect(screen.queryByText(/in this workspace/)).toBeNull();
    expect(screen.queryByText("No designs yet")).toBeNull();
  });

  it("GATE CLOSED: reads an offline session as offline, never as an empty library", async () => {
    gateHarness.__setOnlineGateForTests({
      enabled: false,
      effectiveRole: "editor",
    });
    hookState["catalog"] = loadedCatalog([
      parseTemplateCatalogPage({ items: [], page: 1, per_page: 24, total: 0 }),
    ]);

    await render(<Templates />, { wrapper });

    expect(screen.getByText(/You're offline/)).toBeTruthy();
    expect(screen.queryByText("No designs yet")).toBeNull();
  });

  it("ERROR: renders a failed fetch as an error, never as 'no designs'", async () => {
    hookState["catalog"] = catalogResult({
      error: new Error("boom"),
      isError: true,
      isLoading: false,
      isPending: false,
    });

    await render(<Templates />, { wrapper });

    expect(screen.queryByText("No designs yet")).toBeNull();
    expect(screen.queryByText("Nothing matches")).toBeNull();
    // An error state that cannot be retried is a dead end; QueryStates wires
    // the query's own refetch to it.
    expect(screen.getByLabelText("Retry")).toBeTruthy();
  });

  it("EMPTY: says where designs come from instead of leaving a blank page", async () => {
    hookState["catalog"] = loadedCatalog([
      parseTemplateCatalogPage({ items: [], page: 1, per_page: 24, total: 0 }),
    ]);

    await render(<Templates />, { wrapper });

    expect(screen.getByText("No designs yet")).toBeTruthy();
    // total: 0 came from the server, so stating it is honest.
    expect(screen.getByText("0 designs in this workspace")).toBeTruthy();
  });

  it("EMPTY-BY-FILTER: distinguishes 'nothing matches' from 'nothing exists'", async () => {
    hookState["catalog"] = loadedCatalog([
      parseTemplateCatalogPage({ items: [], page: 1, per_page: 24, total: 0 }),
    ]);
    hookState["goals"] = queryResult({ data: GOAL_COUNTS });

    await render(<Templates />, { wrapper });
    // `useDebounced` is identity in this harness, so the filter applies at once.
    await fireEvent.press(screen.getByLabelText("Promotional, 7 designs"));

    expect(screen.getByText("Nothing matches")).toBeTruthy();
    expect(screen.queryByText("No designs yet")).toBeNull();
  });

  it("LOADED: shows the row, its provenance, and its real usage count", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);

    await render(<Templates />, { wrapper });

    expect(screen.getByText("Spring launch")).toBeTruthy();
    expect(screen.getByText("The spring drop is live")).toBeTruthy();
    expect(screen.getByText("2 designs in this workspace")).toBeTruthy();
    expect(screen.getByText(/Used 12 times/)).toBeTruthy();
  });

  it("LOADED: states the refusal on a reference row rather than offering a dead verb", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);

    await render(<Templates />, { wrapper });

    // Colour is never the only signal: the pill carries the word, and its
    // accessibility label carries the whole sentence.
    expect(screen.getByText("Reference")).toBeTruthy();
    expect(screen.getByText(/Captured from Allbirds/)).toBeTruthy();
  });

  it("says 'Never used' rather than printing a zero beside a missing date", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);

    await render(<Templates />, { wrapper });

    expect(screen.getByText(/Never used/)).toBeTruthy();
  });

  it("stays silent about the library size when the envelope carried no total", async () => {
    // A bare-array response: `total` parses to null, not 0 — absence is not a
    // measurement of an empty workspace.
    hookState["catalog"] = loadedCatalog([
      parseTemplateCatalogPage([
        {
          id: "tpl-9",
          slug: "s",
          name: "Orphan design",
          subject: "hi",
          variables: [],
          tags: [],
          template_kind: "editable",
          review_status: "approved",
          source_license_status: "owned",
        },
      ]),
    ]);

    await render(<Templates />, { wrapper });

    expect(screen.getByText("Orphan design")).toBeTruthy();
    expect(screen.queryByText(/in this workspace/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The goal filter
// ---------------------------------------------------------------------------

describe("the goal filter", () => {
  it("is hidden entirely when the rollup offers nothing to filter by", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);

    await render(<Templates />, { wrapper });

    expect(screen.queryByLabelText("Filter designs by goal")).toBeNull();
  });

  it("offers only the goals the CHECK constraint accepts, led by All", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    hookState["goals"] = queryResult({ data: GOAL_COUNTS });

    await render(<Templates />, { wrapper });

    expect(screen.getByLabelText("Filter designs by goal")).toBeTruthy();
    expect(screen.getByLabelText("All goals, 9 designs")).toBeTruthy();
    // TEMPLATE_GOALS order, not the server's count-descending order (which put
    // promotional first), so the rail does not rearrange itself under the
    // user's thumb between refreshes. Scoped to the GOAL rail: the shelf
    // control above it renders tabs of its own (All/Gallery/Team/…).
    // The segment role is platform-specific (`tab` maps to
    // UIAccessibilityTraitNone on iOS, so the chips take `button` there);
    // `segmented-control-role.native.test.tsx` is what pins that choice.
    const chips = within(screen.getByLabelText("Filter designs by goal"))
      .getAllByRole(Platform.OS === "ios" ? "button" : "tab")
      .map((node) => node.props.accessibilityLabel);
    expect(chips).toEqual([
      "All goals, 9 designs",
      "Welcome, 2 designs",
      "Promotional, 7 designs",
    ]);
  });

  it("never offers the blank-goal bucket the /goals rollup can return", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    hookState["goals"] = queryResult({ data: GOAL_COUNTS });

    await render(<Templates />, { wrapper });

    // `goal=` means "no filter" server-side, so a chip for it would be a
    // control that silently does nothing. The 4 templates in that bucket are
    // reachable only through All.
    expect(screen.queryByText("No goal")).toBeNull();
    expect(screen.getByLabelText("All goals, 9 designs")).toBeTruthy();
  });

  it("marks the chosen goal as selected, not merely as a different colour", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    hookState["goals"] = queryResult({ data: GOAL_COUNTS });

    await render(<Templates />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Welcome, 2 designs"));

    // Re-queried after the press: the element handle captured before it is a
    // snapshot of the previous tree and would report the stale state.
    expect(
      screen.getByLabelText("Welcome, 2 designs").props.accessibilityState?.selected,
    ).toBe(true);
    expect(
      screen.getByLabelText("All goals, 9 designs").props.accessibilityState?.selected,
    ).toBe(false);
  });

  it("keeps the rail reachable when the rollup itself failed, so a filter is escapable", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    hookState["goals"] = queryResult({ data: GOAL_COUNTS });

    const view = await render(<Templates />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Welcome, 2 designs"));

    // The rollup now errors — its data disappears and the rail would collapse
    // to nothing, stranding the operator inside the goal they just picked with
    // no control left that clears it.
    hookState["goals"] = queryResult({
      data: undefined,
      isError: true,
      isSuccess: false,
      error: new Error("boom"),
    });
    await view.rerender(<Templates />);

    expect(screen.getByLabelText("Filter designs by goal")).toBeTruthy();
    // "All" is the way out, and it survives the rollup that produced it.
    expect(screen.getByLabelText("All goals")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The verbs: role gate, eligibility gate, and the clone confirmation
// ---------------------------------------------------------------------------

async function openSpringLaunch() {
  const view = await render(<Templates />, { wrapper });
  await fireEvent.press(screen.getByText("Spring launch"));
  return view;
}

describe("the clone action", () => {
  beforeEach(() => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    hookState["detail"] = queryResult({ data: DETAIL });
  });

  it("tells a viewer that acting needs an editor role, instead of a later 403", async () => {
    // read:campaigns is a read-only scope so the list still loads; the two
    // verbs are write:campaigns, which the session path admits for
    // owner/admin/editor only.
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });

    await openSpringLaunch();

    // Twice, on purpose: the list header says it before anything is opened,
    // and the sheet repeats it beside the control it disabled.
    expect(screen.getAllByText(/needs an editor role/)).toHaveLength(2);
    expect(
      screen.getByLabelText("Duplicate this design").props.accessibilityState
        ?.disabled,
    ).toBe(true);
    // Reading is not gated: a viewer still sees the whole library (the row and
    // the sheet title it opened both carry the name).
    expect(screen.getAllByText("Spring launch").length).toBeGreaterThan(0);
  });

  it("never reaches the network for a viewer, even if the control were pressed", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    const clone = mutationResult();
    hookState["clone"] = clone;

    await openSpringLaunch();
    await fireEvent.press(screen.getByLabelText("Duplicate this design"));

    // Not merely "the request did not go out" — the flow never STARTED. Were
    // the role gate to regress, the confirm would open here and this
    // assertion, unlike a bare mutateAsync check, would catch it.
    expect(screen.queryByText("Duplicate this design?")).toBeNull();
    expect(clone.mutateAsync).not.toHaveBeenCalled();
  });

  it("asks before duplicating, and names the copy the server will create", async () => {
    const clone = mutationResult();
    hookState["clone"] = clone;

    await openSpringLaunch();
    await fireEvent.press(screen.getByLabelText("Duplicate this design"));

    // `cloneCopyName` derives "<name> (copy)" when the body omits a name, and
    // mobile always omits it — so this is what the row will actually be called.
    expect(screen.getByText(/Spring launch \(copy\)/)).toBeTruthy();
    expect(clone.mutateAsync).not.toHaveBeenCalled();
  });

  it("does NOT duplicate when the confirmation is declined", async () => {
    const clone = mutationResult();
    hookState["clone"] = clone;

    await openSpringLaunch();
    await fireEvent.press(screen.getByLabelText("Duplicate this design"));
    await fireEvent.press(screen.getByLabelText("Cancel"));

    expect(clone.mutateAsync).not.toHaveBeenCalled();
  });

  it("duplicates with the template's id once the confirmation is accepted", async () => {
    const clone = mutationResult();
    hookState["clone"] = clone;

    await openSpringLaunch();
    await fireEvent.press(screen.getByLabelText("Duplicate this design"));
    await fireEvent.press(screen.getByLabelText("Duplicate"));

    // The clone POST carries no body at all — the id is the whole request.
    expect(clone.mutateAsync).toHaveBeenCalledWith("tpl-1");
  });

  it("surfaces a server refusal in the server's own words, not as a generic failure", async () => {
    const clone = mutationResult({
      mutateAsync: jest.fn(async () => {
        throw Object.assign(new Error("unprocessable"), {
          status: 422,
          code: "reference_clone_blocked",
        });
      }),
    });
    hookState["clone"] = clone;

    await openSpringLaunch();
    await fireEvent.press(screen.getByLabelText("Duplicate this design"));
    await fireEvent.press(screen.getByLabelText("Duplicate"));

    expect(
      screen.getByText(/Reference designs can't be duplicated/),
    ).toBeTruthy();
  });

});

/**
 * The sheet is driven directly here for the same reason the agent-routines
 * suite drives ITS sheet directly: `useIsOnline` resolves through the shared
 * queryHooks Proxy, which hard-codes `true` and has no setter, and replacing
 * that module would take every other hook mapped to it down with it. The
 * component takes `online` as a prop, so the branch is reachable honestly.
 */
function sheetProps(overrides: Record<string, unknown> = {}) {
  return {
    template: DETAIL,
    detail: DETAIL,
    detailLoading: false,
    detailFailed: false,
    onClose: jest.fn(),
    canWrite: true,
    online: true,
    starting: false,
    duplicating: false,
    onStartCampaign: jest.fn(),
    onDuplicate: jest.fn(),
    ...overrides,
  };
}

describe("the sheet offline", () => {
  it("refuses both verbs, and says the tap is not being queued for later", async () => {
    // Neither verb is registered in lib/offlineMutationContract, so there is no
    // queue to put this in — the refusal has to happen at the button, not as a
    // replay hours later from a phone that has changed hands since.
    await render(<TemplateDetailSheet {...sheetProps({ online: false })} />, {
      wrapper,
    });

    expect(screen.getByText(/Neither verb is queued/)).toBeTruthy();
    expect(
      screen.getByLabelText("Duplicate this design").props.accessibilityState
        ?.disabled,
    ).toBe(true);
    expect(
      screen.getByLabelText("Start a campaign from this design").props
        .accessibilityState?.disabled,
    ).toBe(true);
  });

  it("does not blame the network when the design itself is the problem", async () => {
    // Eligibility outranks connectivity: telling someone to reconnect when the
    // template can never be cloned sends them to fix the wrong thing.
    await render(
      <TemplateDetailSheet
        {...sheetProps({
          online: false,
          template: REFERENCE_DETAIL,
          detail: REFERENCE_DETAIL,
        })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/adapt it into an editable template/)).toBeTruthy();
    expect(screen.queryByText(/Neither verb is queued/)).toBeNull();
  });
});

describe("the eligibility gate in the sheet", () => {
  it("refuses a reference design with the adaptation route out, not a dead button", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    // The single read agrees with the row: still a reference record.
    hookState["detail"] = queryResult({ data: REFERENCE_DETAIL });

    await render(<Templates />, { wrapper });
    await fireEvent.press(screen.getByText("Allbirds weekly"));

    expect(screen.getByText(/adapt it into an editable template/)).toBeTruthy();
    expect(
      screen.getByLabelText("Start a campaign from this design").props
        .accessibilityState?.disabled,
    ).toBe(true);
  });

  it("says 'Checking the design…' before the single read lands, never 'it is empty'", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    hookState["detail"] = queryResult({
      data: undefined,
      isLoading: true,
      isPending: true,
      isSuccess: false,
    });

    await render(<Templates />, { wrapper });
    await fireEvent.press(screen.getByText("Spring launch"));

    // The catalogue projects '' for both body columns, so a catalogue row
    // cannot answer this — claiming "no email body" here would be a claim
    // about a design nobody has read.
    expect(screen.getByText("Checking the design…")).toBeTruthy();
    expect(screen.queryByText(/would arrive blank/)).toBeNull();
  });

  it("only says a design is bodyless once the single read has actually said so", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    hookState["detail"] = queryResult({
      data: parseTemplate(
        {
          id: "tpl-1",
          slug: "spring-launch",
          name: "Spring launch",
          subject: "The spring drop is live",
          variables: [],
          tags: [],
          template_kind: "editable",
          review_status: "approved",
          source_license_status: "owned",
        },
        "detail",
      ),
    });

    await render(<Templates />, { wrapper });
    await fireEvent.press(screen.getByText("Spring launch"));

    expect(screen.getByText(/would arrive blank/)).toBeTruthy();
  });
});

describe("starting a campaign", () => {
  it("goes straight through with no confirmation, because the draft is where it lands", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    hookState["detail"] = queryResult({ data: DETAIL });
    const start = mutationResult({
      mutateAsync: jest.fn(async () => ({
        id: "cmp-1",
        name: "Spring launch",
        status: "draft",
      })),
    });
    hookState["start"] = start;

    await openSpringLaunch();
    await fireEvent.press(screen.getByLabelText("Start a campaign from this design"));

    expect(start.mutateAsync).toHaveBeenCalledWith("tpl-1");
  });

  it("warns that unfilled placeholders reach the draft verbatim", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    hookState["detail"] = queryResult({ data: DETAIL });

    await openSpringLaunch();

    // `substitute` leaves {{first_name}} in place when the value is nil, and
    // this screen supplies no values at all.
    expect(screen.getByText(/first_name/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The favourite star
// ---------------------------------------------------------------------------

describe("the favourite star", () => {
  /**
   * The star had NO behavioural coverage at all, and its failure path was the
   * one place on this screen where a write could fail in total silence.
   *
   * `useSetTemplateFavorite` is OPTIMISTIC: `onMutate` patches every catalogue
   * page so the star fills on the tap, and `onError` restores the snapshot. The
   * hook has no toast — so before this, a rejected favourite showed the star
   * fill and then empty itself, with nothing said. That is exactly the defect
   * the notification inbox names about its own optimistic read receipt ("a
   * silently-reappearing dot reads as a bug"), and it is worse here because the
   * star is the ONLY control on this screen a viewer is allowed to press.
   *
   * The mutation callbacks are invoked directly rather than by resolving a
   * rejected promise: `mutate` is the mocked TanStack entry point, so the
   * per-call `onError` the screen hands it IS the artefact under test, and
   * calling it is what a rejected request would do.
   */
  function pressStar(label: string) {
    return fireEvent.press(screen.getByLabelText(label));
  }

  it("sends the OPPOSITE of the row's current state, per row", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    const favorite = mutationResult();
    hookState["favorite"] = favorite;

    await render(<Templates />, { wrapper });
    await pressStar("Add Spring launch to your favourites");

    expect(favorite.mutate).toHaveBeenCalled();
    const [vars] = (favorite.mutate as jest.Mock).mock.calls[0] as [
      { id: string; favorited: boolean },
    ];
    expect(vars).toEqual({ id: "tpl-1", favorited: true });
  });

  it("says so when the favourite FAILS, instead of letting the star silently revert", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    const favorite = mutationResult();
    hookState["favorite"] = favorite;

    await render(<Templates />, { wrapper });
    await pressStar("Add Spring launch to your favourites");

    const call = (favorite.mutate as jest.Mock).mock.calls[0] as [
      unknown,
      { onError?: (e: unknown) => void } | undefined,
    ];
    // The screen must hand the mutation a per-call failure handler at all…
    expect(typeof call[1]?.onError).toBe("function");
    await act(async () => {
      call[1]?.onError?.(new Error("network refused"));
    });

    // …and that handler must SAY which way the star failed. "Couldn't add"
    // and "Couldn't remove" are different facts to somebody clearing a
    // shortlist, and the star's whole meaning is its direction.
    expect(
      screen.getByText("Couldn't add Spring launch to your favourites."),
    ).toBeTruthy();
  });

  it("names the other direction when UNfavouriting fails", async () => {
    hookState["catalog"] = loadedCatalog([
      parseTemplateCatalogPage({
        items: [
          {
            id: "tpl-1",
            slug: "spring-launch",
            name: "Spring launch",
            subject: "The spring drop is live",
            variables: [],
            tags: [],
            template_kind: "editable",
            review_status: "approved",
            source_license_status: "owned",
            is_favorited: true,
          },
        ],
        page: 1,
        per_page: 24,
        total: 1,
      }),
    ]);
    const favorite = mutationResult();
    hookState["favorite"] = favorite;

    await render(<Templates />, { wrapper });
    await pressStar("Remove Spring launch from your favourites");

    const call = (favorite.mutate as jest.Mock).mock.calls[0] as [
      { favorited: boolean },
      { onError?: (e: unknown) => void } | undefined,
    ];
    expect(call[0].favorited).toBe(false);
    await act(async () => {
      call[1]?.onError?.(new Error("network refused"));
    });

    expect(
      screen.getByText("Couldn't remove Spring launch from your favourites."),
    ).toBeTruthy();
  });

  it("does not offer the star at all while offline", async () => {
    // The write is not in lib/offlineMutationContract, so it cannot be queued;
    // a control that can only fail is worse than no control.
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    hookState["favorite"] = mutationResult();
    gateHarness.__setIsOnlineForTests(false);

    await render(<Templates />, { wrapper });

    expect(
      screen.queryByLabelText("Add Spring launch to your favourites"),
    ).toBeNull();
  });
});

describe("the catalog controls (shelf + sort)", () => {
  it("asks the catalogue for the chosen shelf, not merely re-labels the list", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);
    hookState["goals"] = queryResult({ data: GOAL_COUNTS });

    await render(<Templates />, { wrapper });
    await fireEvent.press(screen.getByText("Gallery"));

    const args = hookState["catalogArgs"] as unknown[];
    expect(args[2]).toBe("gallery");
  });

  it("threads the archived shelf through — the reversible lifecycle's other half", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);

    await render(<Templates />, { wrapper });
    await fireEvent.press(screen.getByText("Archived"));

    expect((hookState["catalogArgs"] as unknown[])[2]).toBe("archived");
  });

  it("asks for the chosen sort order", async () => {
    hookState["catalog"] = loadedCatalog([CATALOG_PAGE]);

    await render(<Templates />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Sort by most used"));

    expect((hookState["catalogArgs"] as unknown[])[3]).toBe("most_used");
  });
});

describe("the lifecycle verb in the sheet", () => {
  // The DETAIL read is the only one that carries a strong entity tag; the
  // catalogue projection answers etag '' and the verb must then stay unoffered
  // (a PATCH without a strong If-Match is a guaranteed 428/412).
  const TAGGED = { ...DETAIL, etag: '"v7"' };

  it("offers Archive on an active design once the tagged detail read lands", async () => {
    const onToggleArchived = jest.fn();
    await render(
      <TemplateDetailSheet
        {...sheetProps({ detail: TAGGED, onToggleArchived })}
      />,
      { wrapper },
    );

    await fireEvent.press(screen.getByLabelText("Archive this design"));
    expect(onToggleArchived).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tpl-1", etag: '"v7"' }),
    );
  });

  it("offers Restore — and the Archived pill — on an archived design", async () => {
    const archived = { ...TAGGED, archivedAt: "2026-08-01T10:00:00Z" };
    await render(
      <TemplateDetailSheet
        {...sheetProps({ detail: archived, onToggleArchived: jest.fn() })}
      />,
      { wrapper },
    );

    expect(
      screen.getByLabelText("Restore this design to the library"),
    ).toBeTruthy();
    expect(screen.getByText("Archived")).toBeTruthy();
  });

  it("withholds the verb entirely without a strong tag, offline, or for a viewer", async () => {
    await render(
      <TemplateDetailSheet
        {...sheetProps({ onToggleArchived: jest.fn() })}
      />,
      { wrapper },
    );
    // DETAIL carries etag '' (the catalogue projection) — no verb.
    expect(screen.queryByLabelText("Archive this design")).toBeNull();

    screen.unmount();
    await render(
      <TemplateDetailSheet
        {...sheetProps({
          detail: { ...DETAIL, etag: '"v7"' },
          onToggleArchived: jest.fn(),
          canWrite: false,
        })}
      />,
      { wrapper },
    );
    expect(screen.queryByLabelText("Archive this design")).toBeNull();
  });
});
