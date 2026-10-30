/**
 * `?q=` on arrival — Flows and Templates.
 *
 * Search already sends it. `src/api/search.ts` (`registryTarget`) returns
 * `{ pathname, params: { q: hit.title } }` for every list-support surface, and
 * `flow` / `template` both take that branch because `@postwave/route-map`
 * declares their mobile shape as `list`. `src/lib/navDeepLinks.ts`
 * (`navLinkSearchSuffix`) appends the same `?q=` to a destination deep link.
 *
 * Five sibling screens consume it — lists, tags, segments, suppressions,
 * subscribers — and these two did not: both opened with `useState("")` and no
 * `useLocalSearchParams` anywhere in the file. The param was constructed,
 * routed, and dropped on arrival, so tapping a flow or a design in Search
 * landed on the unfiltered list and read as the search having done nothing.
 *
 * The two screens narrow by different mechanisms, so the assertions differ and
 * both are about the narrowing, not about a prop:
 *   Flows     filters IN MEMORY (`flowRows`), so the seed must remove the
 *             non-matching rows from the rendered pane.
 *   Templates narrows SERVER-side (`useTemplateCatalog(debouncedQuery, …)`), so
 *             the seed must reach that hook's first argument on first render.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import * as ExpoRouter from "expo-router";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as GateHooks from "@/hooks/useOnlineQueryGate";
import { parseFlow, type MobileFlow } from "@/lib/flowWire";

jest.mock("@/hooks/useCampaignTemplates", () => {
  const pending = {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: true,
    isPending: true,
    hasNextPage: false,
    fetchNextPage: jest.fn(),
    refetch: jest.fn(),
  };
  const calls: unknown[][] = [];
  return {
    __catalogCalls: calls,
    useTemplateCatalog: (...args: unknown[]) => {
      calls.push(args);
      return pending;
    },
    useTemplateGoals: () => pending,
    useTemplateDetail: () => pending,
    useCloneTemplate: () => ({ mutate: jest.fn(), isPending: false }),
    useStartCampaignFromTemplate: () => ({
      mutate: jest.fn(),
      isPending: false,
    }),
    useSetTemplateFavorite: () => ({ mutate: jest.fn(), isPending: false }),
  };
});

import * as TemplateHooks from "@/hooks/useCampaignTemplates";

import Flows from "../app/(tabs)/flows";
import Templates from "../app/(tabs)/templates";

const routerHarness = ExpoRouter as unknown as {
  __setSearchParamsForTests: (over: Record<string, string> | null) => void;
};
const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = GateHooks as unknown as {
  __resetOnlineGateForTests: () => void;
};
const catalogCalls = (
  TemplateHooks as unknown as { __catalogCalls: unknown[][] }
).__catalogCalls;

afterEach(() => {
  // The expo-router mock keeps MODULE state, which `restoreMocks` does not
  // touch — leaving `q` set here would seed the next suite's screen.
  routerHarness.__setSearchParamsForTests(null);
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  catalogCalls.length = 0;
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

const CONTAINED_RUNTIME = {
  capability: "flow_execution",
  runtime_status: "unavailable",
  execution_enabled: false,
  code: "flow_runtime_unavailable",
  message:
    "Flow execution is unavailable; the flow was not activated, published, or dispatched.",
  prerequisites: ["tenant_scoped_worker_authority"],
};

function flow(id: string, name: string): MobileFlow {
  return parseFlow({
    id,
    name,
    status: "draft",
    version: 1,
    re_enrollment: "once",
    re_enrollment_cooldown_hours: 0,
    graph: {
      entry_id: "n1",
      triggers: [{ type: "product_event", event_name: "cart_abandoned" }],
      nodes: [{ id: "n1", type: "wait", duration_seconds: 3_600 }],
      edges: [],
      goals: [],
    },
    created_at: "2026-06-01T09:00:00Z",
    updated_at: "2026-07-20T09:00:00Z",
    runtime: CONTAINED_RUNTIME,
  }) as MobileFlow;
}

function loadedPage(flows: readonly MobileFlow[]) {
  const data = { items: flows, nextCursor: null };
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

describe("Flows opens narrowed to the hit Search sent it to", () => {
  it("filters the pane down to the seeded flow", async () => {
    queryHarness.__setQueryResultForTests(
      loadedPage([flow("f-1", "Abandoned cart"), flow("f-2", "Winback")]),
    );
    routerHarness.__setSearchParamsForTests({ q: "Winback" });

    await render(<Flows />, { wrapper });

    expect(screen.getByText("Winback")).toBeTruthy();
    // The whole point: the row the user did NOT pick is gone. Seeding only the
    // text box while leaving the list unfiltered would still read as a no-op.
    expect(screen.queryByText("Abandoned cart")).toBeNull();
    expect(screen.getByLabelText("Search flows by name").props.value).toBe(
      "Winback",
    );
  });

  it("shows the whole catalogue when Search sent no seed", async () => {
    queryHarness.__setQueryResultForTests(
      loadedPage([flow("f-1", "Abandoned cart"), flow("f-2", "Winback")]),
    );

    await render(<Flows />, { wrapper });

    // Pins the other half: the seed must not narrow a list nobody searched.
    expect(screen.getByText("Abandoned cart")).toBeTruthy();
    expect(screen.getByText("Winback")).toBeTruthy();
    expect(screen.getByLabelText("Search flows by name").props.value).toBe("");
  });
});

describe("Templates opens narrowed to the hit Search sent it to", () => {
  const LABEL = "Search templates by name, subject, description, brand or tag";

  it("passes the seed to the server query on the first render", async () => {
    routerHarness.__setSearchParamsForTests({ q: "Spring launch" });

    await render(<Templates />, { wrapper });

    expect(catalogCalls.length).toBeGreaterThan(0);
    // First ARGUMENT of the FIRST call: a seed that only arrives after a
    // re-render has already cost the operator an unfiltered round trip.
    expect(catalogCalls[0]?.[0]).toBe("Spring launch");
    expect(screen.getByLabelText(LABEL).props.value).toBe("Spring launch");
  });

  it("asks for the unfiltered library when Search sent no seed", async () => {
    await render(<Templates />, { wrapper });

    expect(catalogCalls[0]?.[0]).toBe("");
    expect(screen.getByLabelText(LABEL).props.value).toBe("");
  });
});

/**
 * The SECOND hit — the half a fresh `render()` can never reach.
 *
 * expo-router REUSES a mounted route. Both screens are hidden `Tabs.Screen`s
 * and nothing in app/(tabs)/_layout.tsx sets `unmountOnBlur`, so a second
 * search hit for the same screen is delivered to the LIVE component as new
 * params. `useState(params.q)` reads its initializer once, on first mount, so
 * without an adopt effect the operator is left looking at the previous query
 * while the new one is dropped — and on Templates the stale query is not just
 * displayed, it is the one sent to the server.
 *
 * The trap in the naive fix is the other assertion in each pair: re-seeding on
 * every render (or on the params OBJECT, which `useLocalSearchParams` rebuilds
 * every render) would snap the box back to `q` on every keystroke. Adoption is
 * therefore keyed on the param VALUE, and the "keeps typing" cases hold that
 * line — they fail against a fix that fights the user.
 *
 * Precedent, and a plain statement of its limits: only ONE of the five sibling
 * screens named in the header actually does this — subscribers/index.tsx:117
 * ("If we're re-navigated here with a fresh `q` … adopt it into the search
 * box"). lists/index.tsx:123, tags.tsx:89, segments/index.tsx:72 and
 * suppressions/index.tsx:105 all still seed with a bare `useState` and share
 * the same first-mount-only trap. They are owned elsewhere; this test covers
 * the two screens fixed here.
 */
describe("Flows adopts the query a SECOND search hit brings", () => {
  const LABEL = "Search flows by name";

  it("re-narrows to the new hit when Search re-navigates to the mounted screen", async () => {
    queryHarness.__setQueryResultForTests(
      loadedPage([flow("f-1", "Abandoned cart"), flow("f-2", "Winback")]),
    );
    routerHarness.__setSearchParamsForTests({ q: "Winback" });

    const view = await render(<Flows />, { wrapper });
    expect(screen.queryByText("Abandoned cart")).toBeNull();

    // The second hit. Same mounted screen, new params.
    routerHarness.__setSearchParamsForTests({ q: "Abandoned cart" });
    await view.rerender(<Flows />);

    expect(screen.getByLabelText(LABEL).props.value).toBe("Abandoned cart");
    expect(screen.getByText("Abandoned cart")).toBeTruthy();
    // Still the whole point: the pane follows the box. A seeded input over an
    // unfiltered list would read as the second search having done nothing.
    expect(screen.queryByText("Winback")).toBeNull();
  });

  it("brings the operator back to the pane the new query filters", async () => {
    queryHarness.__setQueryResultForTests(
      loadedPage([flow("f-1", "Abandoned cart"), flow("f-2", "Winback")]),
    );
    routerHarness.__setSearchParamsForTests({ q: "Winback" });

    const view = await render(<Flows />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/^Reviews/));
    // Reviews has no search box, so an adopted query would be invisible there.
    expect(screen.queryByLabelText(LABEL)).toBeNull();

    routerHarness.__setSearchParamsForTests({ q: "Abandoned cart" });
    await view.rerender(<Flows />);

    expect(screen.getByLabelText(LABEL).props.value).toBe("Abandoned cart");
    expect(screen.getByText("Abandoned cart")).toBeTruthy();
  });

  it("does not clobber typing the operator did after the seed", async () => {
    queryHarness.__setQueryResultForTests(
      loadedPage([flow("f-1", "Abandoned cart"), flow("f-2", "Winback")]),
    );
    routerHarness.__setSearchParamsForTests({ q: "Winback" });

    const view = await render(<Flows />, { wrapper });
    await fireEvent.changeText(screen.getByLabelText(LABEL), "Aband");

    // A re-render with the param UNCHANGED is the common case: any parent
    // state change, a refetch, a keystroke. None of them may re-seed.
    await view.rerender(<Flows />);

    expect(screen.getByLabelText(LABEL).props.value).toBe("Aband");
    expect(screen.getByText("Abandoned cart")).toBeTruthy();
    expect(screen.queryByText("Winback")).toBeNull();
  });
});

describe("Templates adopts the query a SECOND search hit brings", () => {
  const LABEL = "Search templates by name, subject, description, brand or tag";
  const lastCatalogQuery = () => catalogCalls[catalogCalls.length - 1]?.[0];

  it("sends the NEW query to the server, not the previous one", async () => {
    routerHarness.__setSearchParamsForTests({ q: "Spring launch" });

    const view = await render(<Templates />, { wrapper });
    expect(catalogCalls[0]?.[0]).toBe("Spring launch");

    routerHarness.__setSearchParamsForTests({ q: "Autumn drop" });
    await view.rerender(<Templates />);

    expect(screen.getByLabelText(LABEL).props.value).toBe("Autumn drop");
    // Templates narrows SERVER-side, so the assertion that matters is the
    // request finally issued — a stale seed here fetches the WRONG LIBRARY,
    // not merely a wrong-looking box. (`useDebounced` is identity in this
    // harness — jest.routes.config.cjs maps it to mocks/queryHooks.cjs — so
    // `waitFor` is holding the value's arrival at the hook, not a real 300ms.)
    await waitFor(() => expect(lastCatalogQuery()).toBe("Autumn drop"));
  });

  it("does not clobber typing the operator did after the seed", async () => {
    routerHarness.__setSearchParamsForTests({ q: "Spring launch" });

    const view = await render(<Templates />, { wrapper });
    await fireEvent.changeText(screen.getByLabelText(LABEL), "Spr");

    await view.rerender(<Templates />);

    expect(screen.getByLabelText(LABEL).props.value).toBe("Spr");
    await waitFor(() => expect(lastCatalogQuery()).toBe("Spr"));
  });
});
