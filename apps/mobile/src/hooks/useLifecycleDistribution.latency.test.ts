/**
 * Round-trip-shape guard for the lifecycle rollup.
 *
 * The histogram and the stage catalog are two argument-free GETs, and neither
 * consumes the other — so reading the catalog only after the histogram landed
 * put a second round trip (50-300ms on a phone) in front of the analytics
 * card for nothing. The two now leave together.
 *
 * The degrade contract is asserted alongside the shape, because that is what
 * makes the parallel version safe: a failed catalog still renders the
 * histogram, and a 404 histogram still hides the section.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchLifecycleDistribution: vi.fn(),
  fetchLifecycleStages: vi.fn(),
}));
// The hook module reaches react-native through the online gate; the shape
// under test is the transport composition, so both are stubbed away.
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));
vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => ({ enabled: true, tenantId: "t" }),
}));

class LifecycleReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

vi.mock("@/api/lifecycleRollup", () => ({
  fetchLifecycleDistribution: mocks.fetchLifecycleDistribution,
  fetchLifecycleStages: mocks.fetchLifecycleStages,
  isLifecycleUnavailable: (err: unknown) =>
    err instanceof LifecycleReadError && err.status === 404,
}));

// eslint-disable-next-line import/first
import { readLifecycleDistribution } from "@/hooks/useLifecycleDistribution";

/** Simulated round trip. A phone pays 50-300ms; 20ms keeps the suite quick. */
const RTT_MS = 20;

const ROWS = [{ stage: "active", count: 3 }];

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

function delayed<T>(
  make: () => T,
  windows: Window[],
  stall: () => void,
): () => Promise<T> {
  return async () => {
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, RTT_MS));
    stall();
    windows.push({ start, end: performance.now() });
    return make();
  };
}

// Braced: an arrow that RETURNS a mock hands vitest the mock as a teardown
// hook, which then gets invoked with no arguments.
beforeEach(() => {
  mocks.fetchLifecycleDistribution.mockReset();
  mocks.fetchLifecycleStages.mockReset();
});

describe("the lifecycle rollup is one wave, not two", () => {
  // No wall-clock threshold. A loaded CI runner fires a 20ms timer 10ms+
  // late, and once the host stalls for a full round trip the concurrent read
  // takes as long as the serial one did on an idle host, so no threshold can
  // pass the first and still fail the second. Overlapping request windows
  // are the concurrency itself, and they hold at any host speed.
  it.each([
    ["an idle host", 0],
    ["a host that stalls for a full round trip", RTT_MS],
  ] as const)(
    "issues the histogram and the stage catalog concurrently on %s",
    async (_host, stallMs) => {
      const windows: Window[] = [];
      const stall = hostThatStalls(stallMs);
      mocks.fetchLifecycleDistribution.mockImplementation(
        delayed(() => ROWS, windows, stall),
      );
      mocks.fetchLifecycleStages.mockImplementation(
        delayed(() => ["active", "churned"], windows, stall),
      );

      const view = await readLifecycleDistribution();

      expect(view).not.toBeNull();
      expect(windows).toHaveLength(2);
      // The second read left before the first one landed.
      const [first, second] = [...windows].sort((a, b) => a.start - b.start);
      expect(second!.start).toBeLessThan(first!.end);
    },
  );

  it("still renders the histogram when the stage catalog fails", async () => {
    mocks.fetchLifecycleDistribution.mockResolvedValue(ROWS);
    mocks.fetchLifecycleStages.mockRejectedValue(
      new LifecycleReadError(500, "catalog down"),
    );

    await expect(readLifecycleDistribution()).resolves.not.toBeNull();
  });

  it("still hides the section when the routes are not mounted", async () => {
    mocks.fetchLifecycleDistribution.mockRejectedValue(
      new LifecycleReadError(404, "not mounted"),
    );
    mocks.fetchLifecycleStages.mockRejectedValue(
      new LifecycleReadError(404, "not mounted"),
    );

    await expect(readLifecycleDistribution()).resolves.toBeNull();
  });

  it("still surfaces a non-404 histogram failure", async () => {
    mocks.fetchLifecycleDistribution.mockRejectedValue(
      new LifecycleReadError(500, "rollup down"),
    );
    mocks.fetchLifecycleStages.mockResolvedValue([]);

    await expect(readLifecycleDistribution()).rejects.toThrow("rollup down");
  });
});
