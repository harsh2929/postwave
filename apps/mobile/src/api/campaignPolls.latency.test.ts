/**
 * Round-trip-shape guard for the campaign poll receipts read.
 *
 * `listCampaignPollReceipts` used to await each poll's tally before asking for
 * the next, so a campaign with N polls cost 1 + N SERIAL round trips on the
 * screen an operator opens before pressing Send. The tallies are independent —
 * each needs only its own definition, already in hand from the register — so
 * the shape is now one register read followed by a bounded wave.
 *
 * This asserts the SHAPE (concurrency and ordering), not a wall-clock number:
 * the per-op delay is simulated, and the threshold is halfway between the
 * serial and concurrent costs so a reintroduced `await` inside the loop fails
 * here rather than on a flaky timing margin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listCampaignPollReceipts } from "./campaignPolls";

const mocks = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest: mocks.rawRequest }));

const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const REVISION = "33333333-3333-4333-8333-333333333333";
/** Simulated round trip. A phone pays 50-300ms; 10ms keeps the suite quick. */
const RTT_MS = 10;
const POLLS = 12;
/** Mirrors TALLY_CONCURRENCY in campaignPolls.ts. */
const CONCURRENCY = 6;

function definition(index: number) {
  return {
    id: `2222${String(index).padStart(4, "0")}-2222-4222-8222-222222222222`,
    campaign_id: CAMPAIGN,
    content_revision_id: REVISION,
    content_revision_source_hash: "a".repeat(64),
    poll_contract_sha256: "b".repeat(64),
    poll_key: `poll-${index}`,
    question: `Question ${index}?`,
    two_step_required: true,
    options: [
      { option_key: "yes", label: "Yes", position: 0 },
      { option_key: "no", label: "No", position: 1 },
    ],
    created_at: "2026-08-30T10:00:00Z",
  };
}

function tally(index: number) {
  return {
    poll_id: definition(index).id,
    poll_key: `poll-${index}`,
    content_revision_id: REVISION,
    question: `Question ${index}?`,
    options: [
      { option_key: "yes", label: "Yes", counted: index },
      { option_key: "no", label: "No", counted: 0 },
    ],
    machine_excluded: 0,
    unclassified_excluded: 0,
    voided_multi_option: 0,
    superseded_choices: 0,
    previewed_only: 0,
    submission_receipts: index,
  };
}

/** Records the window each request occupied so overlap is observable. */
function install(
  onTally: (index: number) => { data: unknown; error: unknown },
): { windows: { path: string; start: number; end: number }[] } {
  const windows: { path: string; start: number; end: number }[] = [];
  mocks.rawRequest.mockImplementation(async (_method: string, path: string) => {
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, RTT_MS));
    windows.push({ path, start, end: performance.now() });
    if (!path.includes("/tally")) {
      return {
        data: { items: Array.from({ length: POLLS }, (_u, i) => definition(i)) },
        error: null,
      };
    }
    const match = path.match(/polls\/poll-(\d+)\/tally/);
    return onTally(Number(match?.[1] ?? -1));
  });
  return { windows };
}

// Braced deliberately: an arrow that RETURNS the mock hands vitest the mock
// itself as a teardown hook, and it then gets invoked with no arguments.
beforeEach(() => {
  mocks.rawRequest.mockReset();
});

describe("campaign poll tallies are read in a bounded wave", () => {
  it("costs one register read plus ceil(N/6) waves, not 1 + N round trips", async () => {
    const { windows } = install((index) => ({
      data: tally(index),
      error: null,
    }));

    const t0 = performance.now();
    const receipts = await listCampaignPollReceipts(CAMPAIGN);
    const wall = performance.now() - t0;

    expect(receipts).toHaveLength(POLLS);
    // Every tally was still requested exactly once, and in definition order.
    expect(receipts.map((r) => r.definition.pollKey)).toEqual(
      Array.from({ length: POLLS }, (_u, i) => `poll-${i}`),
    );
    expect(windows.filter((w) => w.path.includes("/tally"))).toHaveLength(
      POLLS,
    );

    // Serial would be (1 + POLLS) * RTT_MS = 130ms of simulated wire time.
    // The bounded wave is (1 + ceil(POLLS / CONCURRENCY)) * RTT_MS = 30ms.
    const serial = (1 + POLLS) * RTT_MS;
    const bounded = (1 + Math.ceil(POLLS / CONCURRENCY)) * RTT_MS;
    expect(wall).toBeLessThan((serial + bounded) / 2);

    // Direct concurrency evidence: the first CONCURRENCY tallies overlap.
    const tallies = windows
      .filter((w) => w.path.includes("/tally"))
      .sort((a, b) => a.start - b.start);
    const first = tallies[0]!;
    const nth = tallies[CONCURRENCY - 1]!;
    expect(nth.start).toBeLessThan(first.end);
  });

  it("still raises the FIRST failing definition, not the first to settle", async () => {
    // Definition 8 fails fast; definition 2 fails slowly. The serial loop
    // raised 2 because it never reached 8, and so must the wave.
    install((index) => {
      if (index === 2) return { data: null, error: { status: 500, message: "second" } };
      if (index === 8) return { data: null, error: { status: 500, message: "eighth" } };
      return { data: tally(index), error: null };
    });

    await expect(listCampaignPollReceipts(CAMPAIGN)).rejects.toThrow("second");
  });
});
