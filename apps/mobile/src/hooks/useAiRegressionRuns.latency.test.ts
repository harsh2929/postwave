/**
 * Round-trip-shape guard for the regression-run evidence read.
 *
 * `GET /runs/{id}` and `GET /runs/{id}/results` both take only the run id, so
 * awaiting the first before asking for the second put a second round trip
 * (50-300ms on a phone) in front of the evidence sheet for nothing. This
 * asserts they OVERLAP, and that the detail read still owns the error message
 * a caller sees — the reason the two were sequenced in the first place.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRegressionRun: vi.fn(),
  getRegressionRunResults: vi.fn(),
}));
// The hook module reaches react-native through the online gate; the shape
// under test is the transport composition, so both are stubbed away.
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));
vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => ({ enabled: true, tenantId: "t" }),
}));
vi.mock("@/api/aiRegressionRuns", () => ({
  listRegressionRuns: vi.fn(),
  getRegressionRun: mocks.getRegressionRun,
  getRegressionRunResults: mocks.getRegressionRunResults,
}));

// eslint-disable-next-line import/first
import { readRegressionRunEvidence } from "@/hooks/useAiRegressionRuns";

/** Simulated round trip. A phone pays 50-300ms; 20ms keeps the suite quick. */
const RTT_MS = 20;

type Window = { start: number; end: number };

/**
 * A host that holds the thread once, the way a GC pause or a loaded CI
 * runner does: the first reply to land blocks for `stallMs`, so every timer
 * due inside that span fires late. Atomics.wait sleeps without spinning a
 * CPU the rest of the suite is sharing.
 */
function hostThatStalls(stallMs: number): () => void {
  let pending = stallMs > 0;
  return () => {
    if (!pending) return;
    pending = false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
  };
}

function delayed<T>(value: T, windows: Window[], stall: () => void) {
  return async (): Promise<T> => {
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, RTT_MS));
    stall();
    windows.push({ start, end: performance.now() });
    return value;
  };
}

// Braced: an arrow that RETURNS a mock hands vitest the mock as a teardown
// hook, which then gets invoked with no arguments.
beforeEach(() => {
  mocks.getRegressionRun.mockReset();
  mocks.getRegressionRunResults.mockReset();
});

describe("regression run evidence is one wave, not two", () => {
  // No wall-clock threshold. A loaded CI runner fires a 20ms timer 10ms+
  // late, and once the host stalls for a full round trip the concurrent read
  // takes as long as the serial one did on an idle host, so no threshold can
  // pass the first and still fail the second. Overlapping request windows
  // are the concurrency itself, and they hold at any host speed.
  it.each([
    ["an idle host", 0],
    ["a host that stalls for a full round trip", RTT_MS],
  ] as const)(
    "issues the detail and the results reads concurrently on %s",
    async (_host, stallMs) => {
      const windows: Window[] = [];
      const stall = hostThatStalls(stallMs);
      mocks.getRegressionRun.mockImplementation(
        delayed({ data: { id: "run-1" }, error: null }, windows, stall),
      );
      mocks.getRegressionRunResults.mockImplementation(
        delayed({ data: { items: [] }, error: null }, windows, stall),
      );

      await readRegressionRunEvidence("run-1");

      expect(windows).toHaveLength(2);
      // The second read left before the first one landed.
      const [first, second] = [...windows].sort((a, b) => a.start - b.start);
      expect(second!.start).toBeLessThan(first!.end);
    },
  );

  it("still reports the DETAIL read's failure, not the results 404", async () => {
    mocks.getRegressionRun.mockResolvedValue({
      data: null,
      error: { status: 403, message: "detail refused" },
    });
    mocks.getRegressionRunResults.mockResolvedValue({
      data: null,
      error: { status: 404, message: "no such run" },
    });

    await expect(readRegressionRunEvidence("run-1")).rejects.toThrow(
      /detail refused|permission|access/i,
    );
  });
});
