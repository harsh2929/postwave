/**
 * SEC-API-3 — the assurance card polls `latest` every 2 s while a run is
 * active, and it used to re-download the whole limit-200 evidence page on
 * every one of those ticks. The route answers `private, no-cache` with no ETag,
 * so each tick was a full 200 and three full server-side list reads. A screen
 * left open on a queued run in retry backoff re-downloaded identical evidence
 * about 150 times.
 *
 * Evidence is NOT frozen while a run is active: extraction and finding rows are
 * committed as they land and the card renders them mid-run (the advisory line
 * and the unavailable-extractions row). So the fix is a throttle, not a
 * terminal-only gate: `latest` keeps its 2 s cadence, evidence refreshes at most
 * every 30 s while the run is active, and a new run, a state change, a failed
 * evidence read or any refetch of a terminal run reads evidence again at once.
 *
 * These run the REAL hook under a REAL QueryClient with fake timers; only the
 * transport and the online gate are mocked.
 */
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  // React Native defines `window`; query-core's isServer check
  // (typeof window === "undefined") would otherwise switch refetchInterval off
  // in the node test environment.
  (globalThis as { window?: unknown }).window = globalThis;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  return {
    latest: 0,
    evidence: 0,
    runId: "run-1",
    state: "running",
    evidenceFails: false,
    /** Finding codes the server has committed so far for the current run. */
    findings: [] as string[],
  };
});

vi.mock("@/api/client", () => ({
  getClient: () => ({
    client: {
      campaignAssurance: {
        getLatest: async (_campaignId: string) => {
          api.latest += 1;
          return {
            data: {
              detail: { run: { id: api.runId, state: api.state } },
              applicability: {
                applicable_to_frozen_snapshot: true,
                freshness: "frozen_snapshot_current",
              },
            },
            measurement: { source_classes: [] },
          };
        },
        getEvidence: async (_campaignId: string, runId: string) => {
          api.evidence += 1;
          if (api.evidenceFails) throw new Error("evidence unavailable");
          return {
            data: {
              run_id: runId,
              extractions: { items: [] },
              findings: {
                items: api.findings.map((code) => ({ code, blocking: false })),
              },
              overrides: { items: [] },
            },
          };
        },
      },
    },
  }),
}));
vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => ({
    enabled: true,
    tenantId: "tenant-1",
    effectiveRole: "editor",
  }),
}));

const { useCampaignAssurance } = await import("./useCampaignAssurance");

type Seen = {
  state: string;
  runId: string;
  /** null = the card's "could not be loaded on this read" branch. */
  findingCodes: string[] | null;
};
const seen: Seen[] = [];

function Probe() {
  const query = useCampaignAssurance("cmp-1");
  const data = query.data;
  if (data) {
    const run = data.latest.data.detail.run;
    seen.push({
      state: run.state,
      runId: run.id,
      findingCodes:
        data.evidence?.data.findings.items.map((item) => item.code) ?? null,
    });
  }
  return null;
}

let qc: QueryClient;
let renderer: TestRenderer.ReactTestRenderer | undefined;

/** Deliver settled query results: notifyManager batches on a (faked) timer. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function mount() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function seconds(n: number) {
  for (let s = 0; s < n; s++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(api, {
    latest: 0,
    evidence: 0,
    runId: "run-1",
    state: "running",
    evidenceFails: false,
    findings: [],
  });
  seen.length = 0;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  qc?.clear();
  vi.useRealTimers();
});

describe("useCampaignAssurance polling cost (SEC-API-3)", () => {
  it("keeps the 2 s latest poll but downloads evidence at most once per 30 s while the run is active", async () => {
    await mount();
    await seconds(60);

    // The run status still moves at the old cadence.
    expect(api.latest).toBeGreaterThanOrEqual(25);
    // One minute at one download per 30 s: the first load, then at most two
    // refreshes. A literal, not derived from the hook's constant, so loosening
    // the throttle cannot loosen the test.
    expect(api.evidence).toBeLessThanOrEqual(3);
    // Throttling must never surface as the card's "details could not be
    // loaded" branch: every render after the first load still carries evidence.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((s) => s.findingCodes === null)).toEqual([]);
  });

  it("still shows findings the server commits mid-run, within one refresh window", async () => {
    await mount();
    await seconds(5);
    expect(seen.at(-1)?.findingCodes).toEqual([]);

    // The worker records an advisory finding while the run keeps running.
    api.findings = ["F07_LINK_REPUTATION"];
    await seconds(32);

    expect(seen.at(-1)?.state).toBe("running");
    expect(seen.at(-1)?.findingCodes).toEqual(["F07_LINK_REPUTATION"]);
  });

  it("reads evidence once on the terminal transition, then stops polling entirely", async () => {
    await mount();
    await seconds(10);
    const before = api.evidence;

    api.state = "complete";
    api.findings = ["F09_BLOCKING"];
    await seconds(3);
    expect(api.evidence).toBe(before + 1);
    expect(seen.at(-1)).toEqual({
      state: "complete",
      runId: "run-1",
      findingCodes: ["F09_BLOCKING"],
    });

    const settled = { latest: api.latest, evidence: api.evidence };
    await seconds(60);
    expect(api.latest).toBe(settled.latest);
    expect(api.evidence).toBe(settled.evidence);
  });

  it("re-reads evidence on the next tick after a failed evidence read", async () => {
    api.evidenceFails = true;
    await mount();
    expect(seen.at(-1)?.findingCodes).toBeNull();

    api.evidenceFails = false;
    api.findings = ["F06_SPAM_TRIGGER"];
    const before = api.evidence;
    await seconds(3);

    expect(api.evidence).toBeGreaterThan(before);
    expect(seen.at(-1)?.findingCodes).toEqual(["F06_SPAM_TRIGGER"]);
  });

  it("reads evidence immediately when a queued run starts running", async () => {
    api.state = "queued";
    await mount();
    await seconds(5);
    const before = api.evidence;

    api.state = "running";
    api.findings = ["F11_UNICODE_TAGS"];
    await seconds(2);

    expect(api.evidence).toBe(before + 1);
    expect(seen.at(-1)).toEqual({
      state: "running",
      runId: "run-1",
      findingCodes: ["F11_UNICODE_TAGS"],
    });
  });

  it("reads evidence immediately for a new run id", async () => {
    await mount();
    await seconds(5);
    const before = api.evidence;

    api.runId = "run-2";
    api.findings = ["F08_RUN_TWO"];
    await seconds(2);

    expect(api.evidence).toBe(before + 1);
    expect(seen.at(-1)).toEqual({
      state: "running",
      runId: "run-2",
      findingCodes: ["F08_RUN_TWO"],
    });
  });

  it("re-reads a terminal run's evidence once when the action hooks invalidate it", async () => {
    api.state = "complete";
    await mount();
    const before = api.evidence;

    // An override receipt was appended; useCampaignAssuranceActions invalidates
    // by this predicate.
    api.findings = ["F10_OVERRIDDEN"];
    await act(async () => {
      await qc.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          query.queryKey[0] === "campaign-assurance" &&
          query.queryKey.includes("cmp-1"),
      });
    });
    await flush();

    expect(api.evidence).toBe(before + 1);
    expect(seen.at(-1)?.findingCodes).toEqual(["F10_OVERRIDDEN"]);
  });
});
