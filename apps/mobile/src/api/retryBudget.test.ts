/**
 * How long can one tap take to FAIL?
 *
 * Two retry policies sit on top of each other and nothing states their
 * product:
 *
 *   - the SDK retries a transport failure (a timeout included) `retries` times,
 *     each attempt with its own `timeoutMs` clock, with jittered exponential
 *     backoff in between (packages/sdk-ts/src/client.ts);
 *   - TanStack retries the whole thing `retry` more times on top
 *     (lib/queryClient.ts).
 *
 * They MULTIPLY. The comment on `retry` records that at `retry: 2` this ran to
 * "multi-minute spinner hangs", which is the failure this test exists to keep
 * from coming back quietly — nobody changing one of these four numbers can see
 * the other three from where they are standing.
 *
 * This is a SHAPE test, not a timing test: it does the arithmetic on the live
 * constants, so it costs no wall-clock and cannot flake. It asserts a CEILING
 * on the worst case, not an exact value, so tightening any of the four passes
 * and loosening any of them fails with the number.
 *
 * Node-run: no react-native imports.
 */
import { PostwaveClient } from "@postwave/sdk";
import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

// eslint-disable-next-line import/first
import { queryClient } from "@/lib/queryClient";

/**
 * The client exactly as `api/sdkClient.getClient()` builds it: mobile passes
 * neither `retries` nor `timeoutMs`, so both are the SDK's defaults, and that
 * is the point — the budget below is inherited, not chosen.
 */
function mobileClient(): PostwaveClient {
  return new PostwaveClient({
    apiKey: "pw_test",
    authMode: "api_key",
    baseUrl: "https://api.example.com",
    fetch: (async () => new Response("{}")) as unknown as typeof fetch,
  });
}

/** TanStack's own default: min(1000 * 2**failureCount, 30_000). */
function tanstackRetryDelayMs(failureCount: number): number {
  return Math.min(1_000 * 2 ** failureCount, 30_000);
}

/**
 * The longest a single SDK request can take before it gives up.
 *
 * `computeBackoff` is not on the SDK's public export surface, so its ceiling is
 * restated here from packages/sdk-ts/src/client.ts: `base = 250 * 2**attempt`
 * plus jitter in [0, base), capped at 30s — i.e. strictly under `2 * base`. It
 * is a rounding term either way: three backoffs total under 3.5s against
 * 120s of timeouts, so the assertions below are driven by `retries` and
 * `timeoutMs`, which ARE read live.
 */
function sdkWorstCaseMs(client: PostwaveClient): number {
  const attempts = client.retries + 1;
  let total = attempts * client.timeoutMs;
  for (let attempt = 0; attempt < client.retries; attempt += 1) {
    total += Math.min(2 * 250 * 2 ** attempt, 30_000);
  }
  return total;
}

describe("worst-case time from tap to error", () => {
  it("keeps the SDK's own attempt budget where mobile expects it", () => {
    const client = mobileClient();
    expect(client.retries).toBe(3);
    expect(client.timeoutMs).toBe(30_000);
    expect(sdkWorstCaseMs(client)).toBeLessThanOrEqual(124_000);
  });

  it("does not let the two retry policies multiply past four minutes", () => {
    const client = mobileClient();
    const retry = queryClient.getDefaultOptions().queries?.retry;
    expect(
      typeof retry,
      "queries.retry is no longer a plain number, so this budget cannot be computed — work out the new worst case and restate it here",
    ).toBe("number");

    const queryRetries = retry as number;
    let worstCaseMs = sdkWorstCaseMs(client) * (queryRetries + 1);
    for (let failure = 0; failure < queryRetries; failure += 1) {
      worstCaseMs += tanstackRetryDelayMs(failure);
    }

    // 4 SDK attempts x 30s + ~3.5s backoff = ~123.5s, doubled by the single
    // TanStack retry, plus its 1s delay = ~248s. That is already a long time to
    // watch a spinner; it must not grow by accident.
    expect(
      worstCaseMs,
      `a query can now spend ${Math.round(worstCaseMs / 1000)}s failing before the screen says anything`,
    ).toBeLessThanOrEqual(250_000);
  });

  it("never auto-retries a mutation — a duplicate write is worse than a failure", () => {
    expect(queryClient.getDefaultOptions().mutations?.retry).toBe(0);
  });
});
