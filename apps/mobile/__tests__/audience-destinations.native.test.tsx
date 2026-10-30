/**
 * AudienceDestinationsPanel — the render contract.
 *
 * This panel exists because `capabilityCoverage.ts` claimed mobile offered
 * audience destinations while nothing did. A render test matters more than
 * usual here for the same reason: the failure being corrected was a screen
 * asserting a capability it did not have, and a component nobody mounts is the
 * same failure wearing different clothes.
 *
 * Every assertion is about a WRONG SENTENCE rather than a blank card. These
 * rows push subscriber lists into live ad audiences, so a destination the
 * server calls broken rendering as healthy is the costly direction.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AudienceDestinationsPanel } from "@/components/integrations/AudienceDestinationsPanel";
import {
  DestinationSyncJobsSheet,
  type DestinationSyncJobsSheetProps,
} from "@/components/integrations/DestinationSyncJobsSheet";
import * as Gate from "@/hooks/useOnlineQueryGate";
import type {
  AudienceDestination,
  DestinationSyncJob,
} from "@/lib/audienceDestinationRows";

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

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1",
    provider: "meta",
    status: "active",
    listId: "l1",
    segmentId: null,
    externalAudienceId: "ext-9",
    lastSyncedAt: "2026-08-18T10:00:00Z",
    updatedAt: null,
    ...overrides,
  };
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

function online(role = "admin") {
  hookHarness.__setOnlineGateForTests({
    enabled: true,
    tenantId: "t1",
    effectiveRole: role,
    online: true,
  });
}

describe("audience destinations panel", () => {
  it("mounts and names the destination", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled([row()]));
    await render(<AudienceDestinationsPanel />, { wrapper });
    expect(screen.getByText("Audience destinations")).toBeTruthy();
    expect(screen.getByText("meta")).toBeTruthy();
  });

  // Two tests rather than one with an unmount() in the middle: RNTL's `screen`
  // stays bound to the unmounted tree, so every LATER test in the file then
  // queries a dead render. That cost two false failures here.
  it("offers Pause on a live destination", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled([row()]));
    await render(<AudienceDestinationsPanel />, { wrapper });
    expect(screen.getByText("Pause")).toBeTruthy();
  });

  it("offers Resume on a paused destination", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled([row({ status: "paused" })]));
    await render(<AudienceDestinationsPanel />, { wrapper });
    expect(screen.getByText("Resume")).toBeTruthy();
  });

  it("says 'never synced' rather than leaving the line blank", async () => {
    // A blank line reads as "fine". Never-synced is the most common
    // misconfiguration this panel exists to surface.
    online();
    queryHarness.__setQueryResultForTests(
      settled([row({ lastSyncedAt: null })]),
    );
    await render(<AudienceDestinationsPanel />, { wrapper });
    expect(screen.getByText(/never synced/u)).toBeTruthy();
  });

  it("shows rows to a non-admin but no controls", async () => {
    online("viewer");
    queryHarness.__setQueryResultForTests(settled([row()]));
    await render(<AudienceDestinationsPanel />, { wrapper });
    expect(screen.getByText("meta")).toBeTruthy();
    expect(screen.queryByText("Pause")).toBeNull();
    expect(screen.queryByText("Disconnect")).toBeNull();
    expect(screen.getByText(/Read-only for your role/u)).toBeTruthy();
  });

  it("renders nothing when there are no destinations", async () => {
    // An empty section on an integrations screen only raises a question.
    online();
    queryHarness.__setQueryResultForTests(settled([]));
    await render(<AudienceDestinationsPanel />, { wrapper });
    expect(screen.queryByText("Audience destinations")).toBeNull();
  });

  it("does not crash when the query resolves to a non-array", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled(undefined as never));
    expect(() =>
      render(<AudienceDestinationsPanel />, { wrapper }),
    ).not.toThrow();
  });

  // The panel could say a destination was in `error` and had no way to say what
  // the error WAS — the transport, the parser and the server route all existed
  // and nothing called them.
  it("offers the sync history that says WHY a destination stopped", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled([row({ status: "error" })]));
    await render(<AudienceDestinationsPanel />, { wrapper });
    expect(
      screen.getByLabelText("Sync history for meta"),
    ).toBeTruthy();
  });

  // ScopeReadReports is the floor on GET /{id}/jobs, the same floor as the
  // list: the reason a destination stopped is exactly what a viewer needs in
  // order to tell someone who can fix it.
  it("shows the sync history to a viewer, who cannot pause anything", async () => {
    online("viewer");
    queryHarness.__setQueryResultForTests(settled([row({ status: "error" })]));
    await render(<AudienceDestinationsPanel />, { wrapper });
    expect(screen.getByLabelText("Sync history for meta")).toBeTruthy();
    expect(screen.queryByText("Pause")).toBeNull();
  });

  it("opens the history sheet for the destination that was tapped", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled([row({ status: "error" })]));
    await render(<AudienceDestinationsPanel />, { wrapper });
    fireEvent.press(screen.getByLabelText("Sync history for meta"));
    expect(await screen.findByText("meta sync history")).toBeTruthy();
  });
});

/**
 * The sheet is exercised against fixed props rather than through the panel: the
 * jest react-query harness answers EVERY `useQuery` with one override, so a
 * mounted panel cannot hold a destinations result and a jobs result at the same
 * time. Props are what make "a failed FETCH must never render as 'never
 * synced'" assertable at all.
 */
function destination(
  overrides: Partial<AudienceDestination> = {},
): AudienceDestination {
  return {
    id: "d1",
    provider: "meta",
    status: "error",
    listId: "l1",
    segmentId: null,
    externalAudienceId: "ext-9",
    lastSyncedAt: "2026-08-18T10:00:00Z",
    updatedAt: null,
    ...overrides,
  };
}

function job(overrides: Partial<DestinationSyncJob> = {}): DestinationSyncJob {
  return {
    id: "j1",
    status: "failed",
    error: "429 from provider",
    membersSynced: 0,
    startedAt: "2026-08-18T10:00:00Z",
    finishedAt: "2026-08-18T10:00:09Z",
    ...overrides,
  };
}

const NOW = new Date("2026-08-18T10:05:00Z").getTime();

function sheetQuery(overrides: Record<string, unknown> = {}) {
  return {
    isError: false,
    isLoading: false,
    isFetching: false,
    isSuccess: true,
    error: null,
    ...overrides,
  };
}

/**
 * The neutral values for the sheet's parity-pass props: no sync-now (below the
 * editor floor), preview not yet asked for, no job opened. Each test overrides
 * only the section it is about.
 */
function sheetExtras(
  overrides: Partial<
    Pick<DestinationSyncJobsSheetProps, "syncNow" | "preview" | "diagnostics">
  > = {},
): Pick<DestinationSyncJobsSheetProps, "syncNow" | "preview" | "diagnostics"> {
  return {
    syncNow: undefined,
    preview: {
      requested: false,
      onRequest: jest.fn(),
      data: null,
      query: sheetQuery(),
    },
    diagnostics: {
      openJobId: null,
      onToggleJob: jest.fn(),
      data: null,
      query: sheetQuery(),
      errorMessage: null,
    },
    ...overrides,
  };
}

describe("the destination sync-history sheet", () => {
  it("echoes the provider's own words rather than translating them", async () => {
    await render(
      <DestinationSyncJobsSheet
        destination={destination()}
        jobs={[job()]}
        jobsQuery={sheetQuery()}
        gate={{ enabled: true }}
        now={NOW}
        onClose={() => undefined}
        {...sheetExtras()}
      />,
      { wrapper },
    );
    expect(screen.getByText("429 from provider")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("never states a delivered count for a job still running", async () => {
    // "0 members synced" is a serious claim, and a job that has not finished
    // is not it.
    await render(
      <DestinationSyncJobsSheet
        destination={destination()}
        jobs={[job({ id: "j2", status: "running", error: "", finishedAt: null })]}
        jobsQuery={sheetQuery()}
        gate={{ enabled: true }}
        now={NOW}
        onClose={() => undefined}
        {...sheetExtras()}
      />,
      { wrapper },
    );
    expect(screen.getByText("Still running.")).toBeTruthy();
    expect(screen.queryByText(/0 members synced/u)).toBeNull();
  });

  it("a failed FETCH of the history never renders as 'never synced'", async () => {
    await render(
      <DestinationSyncJobsSheet
        destination={destination()}
        jobs={[]}
        jobsQuery={sheetQuery({
          isError: true,
          isSuccess: false,
          error: new Error("boom"),
        })}
        gate={{ enabled: true }}
        now={NOW}
        onClose={() => undefined}
        {...sheetExtras()}
      />,
      { wrapper },
    );
    expect(screen.queryByText("No syncs recorded")).toBeNull();
  });

  it("says the history is capped when a full page comes back", async () => {
    const jobs = Array.from({ length: 25 }, (_, i) =>
      job({ id: `j${i}`, status: "succeeded", error: "", membersSynced: i }),
    );
    await render(
      <DestinationSyncJobsSheet
        destination={destination()}
        jobs={jobs}
        jobsQuery={sheetQuery()}
        gate={{ enabled: true }}
        now={NOW}
        onClose={() => undefined}
        {...sheetExtras()}
      />,
      { wrapper },
    );
    expect(screen.getByText(/25 most recent syncs/u)).toBeTruthy();
  });
});

/**
 * The 2026-08 parity additions: sync-now (editor floor), membership preview
 * (press-driven), per-job provider diagnostics (tap-through). All exercised
 * against fixed props for the same single-global-query-mock reason as above.
 */
describe("sync-now in the destination sheet", () => {
  it("renders the button when the panel says the role clears the editor floor", async () => {
    const onPress = jest.fn();
    await render(
      <DestinationSyncJobsSheet
        destination={destination()}
        jobs={[]}
        jobsQuery={sheetQuery()}
        gate={{ enabled: true }}
        now={NOW}
        onClose={() => undefined}
        {...sheetExtras({ syncNow: { busy: false, onPress } })}
      />,
      { wrapper },
    );
    fireEvent.press(screen.getByLabelText("Sync now"));
    expect(onPress).toHaveBeenCalled();
  });

  it("explains the editor floor instead of rendering a dead control below it", async () => {
    await render(
      <DestinationSyncJobsSheet
        destination={destination()}
        jobs={[]}
        jobsQuery={sheetQuery()}
        gate={{ enabled: true }}
        now={NOW}
        onClose={() => undefined}
        {...sheetExtras()}
      />,
      { wrapper },
    );
    expect(screen.queryByLabelText("Sync now")).toBeNull();
    expect(screen.getByText(/needs an editor role/u)).toBeTruthy();
  });
});

describe("membership preview in the destination sheet", () => {
  it("stays un-fetched until the reader asks", async () => {
    const onRequest = jest.fn();
    await render(
      <DestinationSyncJobsSheet
        destination={destination()}
        jobs={[]}
        jobsQuery={sheetQuery()}
        gate={{ enabled: true }}
        now={NOW}
        onClose={() => undefined}
        {...sheetExtras({
          preview: {
            requested: false,
            onRequest,
            data: null,
            query: sheetQuery(),
          },
        })}
      />,
      { wrapper },
    );
    fireEvent.press(screen.getByLabelText("Preview who will be pushed"));
    expect(onRequest).toHaveBeenCalled();
  });

  it("renders the firewall arithmetic once it arrives", async () => {
    await render(
      <DestinationSyncJobsSheet
        destination={destination()}
        jobs={[]}
        jobsQuery={sheetQuery()}
        gate={{ enabled: true }}
        now={NOW}
        onClose={() => undefined}
        {...sheetExtras({
          preview: {
            requested: true,
            onRequest: jest.fn(),
            data: {
              provider: "meta",
              totalMembers: 120,
              excludedCount: 5,
              deliverable: 115,
              truncated: false,
              firewallActive: true,
            },
            query: sheetQuery(),
          },
        })}
      />,
      { wrapper },
    );
    expect(screen.getByText("120 in the source audience")).toBeTruthy();
    expect(
      screen.getByText("5 withheld by the consent firewall"),
    ).toBeTruthy();
    expect(screen.getByText("115 would be pushed")).toBeTruthy();
    expect(screen.getByText("Nothing is shipped by this preview.")).toBeTruthy();
  });

  it("a failed preview reads as unknown, never as zero", async () => {
    await render(
      <DestinationSyncJobsSheet
        destination={destination()}
        jobs={[]}
        jobsQuery={sheetQuery()}
        gate={{ enabled: true }}
        now={NOW}
        onClose={() => undefined}
        {...sheetExtras({
          preview: {
            requested: true,
            onRequest: jest.fn(),
            data: null,
            query: sheetQuery({
              isError: true,
              isSuccess: false,
              error: Object.assign(new Error("boom"), { status: 500 }),
            }),
          },
        })}
      />,
      { wrapper },
    );
    expect(screen.getByText(/unknown — not zero/u)).toBeTruthy();
    expect(screen.queryByText(/0 in the source audience/u)).toBeNull();
  });

  it("names the sync runner when the server says it is missing", async () => {
    await render(
      <DestinationSyncJobsSheet
        destination={destination()}
        jobs={[]}
        jobsQuery={sheetQuery()}
        gate={{ enabled: true }}
        now={NOW}
        onClose={() => undefined}
        {...sheetExtras({
          preview: {
            requested: true,
            onRequest: jest.fn(),
            data: null,
            query: sheetQuery({
              isError: true,
              isSuccess: false,
              error: Object.assign(new Error("unavailable"), { status: 503 }),
            }),
          },
        })}
      />,
      { wrapper },
    );
    expect(screen.getByText(/needs the sync runner/u)).toBeTruthy();
  });
});

describe("per-job diagnostics in the destination sheet", () => {
  it("offers the tap-through on a failed job and not on a clean one", async () => {
    await render(
      <DestinationSyncJobsSheet
        destination={destination()}
        jobs={[
          job(),
          job({ id: "j9", status: "succeeded", error: "", membersSynced: 12 }),
        ]}
        jobsQuery={sheetQuery()}
        gate={{ enabled: true }}
        now={NOW}
        onClose={() => undefined}
        {...sheetExtras()}
      />,
      { wrapper },
    );
    expect(screen.getAllByText("Ask the provider why")).toHaveLength(1);
  });

  it("renders the provider's own verdict for the opened job", async () => {
    await render(
      <DestinationSyncJobsSheet
        destination={destination()}
        jobs={[job()]}
        jobsQuery={sheetQuery()}
        gate={{ enabled: true }}
        now={NOW}
        onClose={() => undefined}
        {...sheetExtras({
          diagnostics: {
            openJobId: "j1",
            onToggleJob: jest.fn(),
            data: {
              provider: "meta",
              providerStatus: "REJECTED",
              providerMessage: "Audience below the minimum size",
              externalJobId: "ext-job-4",
              externalAudienceId: "",
              jobStatus: "failed",
              jobError: "429 from provider",
            },
            query: sheetQuery(),
            errorMessage: null,
          },
        })}
      />,
      { wrapper },
    );
    expect(screen.getByText("Provider status: REJECTED")).toBeTruthy();
    expect(
      screen.getByText("Audience below the minimum size"),
    ).toBeTruthy();
    expect(screen.getByText("Provider job id: ext-job-4")).toBeTruthy();
  });

  it("renders a refusal as its reason, not as a load failure", async () => {
    await render(
      <DestinationSyncJobsSheet
        destination={destination()}
        jobs={[job()]}
        jobsQuery={sheetQuery()}
        gate={{ enabled: true }}
        now={NOW}
        onClose={() => undefined}
        {...sheetExtras({
          diagnostics: {
            openJobId: "j1",
            onToggleJob: jest.fn(),
            data: null,
            query: sheetQuery({
              isError: true,
              isSuccess: false,
              error: Object.assign(new Error("conflict"), {
                status: 409,
                code: "diagnostics_unavailable",
              }),
            }),
            errorMessage:
              "No provider request id was recorded for this job, so there is nothing to look up on the provider's side.",
          },
        })}
      />,
      { wrapper },
    );
    expect(
      screen.getByText(/No provider request id was recorded/u),
    ).toBeTruthy();
  });
});

describe("sync-now through the panel (role floors)", () => {
  it("an editor gets Sync now in the sheet but no Pause on the row", async () => {
    online("editor");
    queryHarness.__setQueryResultForTests(settled([row({ status: "error" })]));
    await render(<AudienceDestinationsPanel />, { wrapper });
    expect(screen.queryByText("Pause")).toBeNull();
    fireEvent.press(screen.getByLabelText("Sync history for meta"));
    expect(await screen.findByLabelText("Sync now")).toBeTruthy();
  });

  it("a viewer gets neither, and is told why sync-now is absent", async () => {
    online("viewer");
    queryHarness.__setQueryResultForTests(settled([row({ status: "error" })]));
    await render(<AudienceDestinationsPanel />, { wrapper });
    fireEvent.press(screen.getByLabelText("Sync history for meta"));
    expect(await screen.findByText(/needs an editor role/u)).toBeTruthy();
    expect(screen.queryByLabelText("Sync now")).toBeNull();
  });
});
