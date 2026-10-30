/**
 * What reaches the Keychain under the offline queue's key is the paused
 * mutation's REPLAY identity — never the rollback snapshot `onMutate` stashed
 * in `state.context`, which holds full cached rows for every projection the
 * write touched. The 2026-09 security review recorded that the "nothing is
 * persisted but allowlisted paused mutations" invariant had no filter or test
 * behind it for the DATA inside those mutations. This is that test.
 */
import { describe, expect, it, vi } from "vitest";

// The envelope module imports expo-secure-store for its get/set helpers; under
// vitest that reaches react-native's Flow-typed sources. Same stub the
// persister's own test uses — nothing here touches the store.
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
}));

// eslint-disable-next-line import/first
import {
  type StoredEnvelope,
  fitClientToBudget,
  withoutRollbackContext,
} from "./secureQueryEnvelope";

const SNAPSHOT_ROW = "ana@example.com — unsubscribed 2026-07-01";

function envelopeWith(mutations: unknown[]): StoredEnvelope {
  return {
    version: 1,
    client: {
      buster: "test",
      timestamp: 0,
      clientState: { queries: [], mutations },
    },
  } as unknown as StoredEnvelope;
}

const paused = {
  mutationKey: ["subscribers", "unsubscribe", "s1"],
  state: {
    status: "pending",
    isPaused: true,
    variables: { id: "s1" },
    context: {
      // The shape lib/optimisticQueries produces: previous query data, verbatim.
      snapshots: [{ key: ["subscribers", "t1"], data: { items: [{ id: "s1", label: SNAPSHOT_ROW }] } }],
    },
  },
  meta: { offlineSafe: true },
};

describe("withoutRollbackContext", () => {
  it("drops state.context and keeps everything the replay needs", () => {
    const out = withoutRollbackContext(paused) as typeof paused;
    expect(out.state).not.toHaveProperty("context");
    expect(out.state.variables).toEqual({ id: "s1" });
    expect(out.state.isPaused).toBe(true);
    expect(out.mutationKey).toEqual(paused.mutationKey);
    expect(out.meta).toEqual({ offlineSafe: true });
  });

  it("leaves a mutation with no context, and non-objects, untouched", () => {
    const bare = { mutationKey: ["x"], state: { isPaused: true } };
    expect(withoutRollbackContext(bare)).toEqual(bare);
    expect(withoutRollbackContext(null)).toBeNull();
    expect(withoutRollbackContext("nope")).toBe("nope");
  });
});

describe("fitClientToBudget", () => {
  it("never lets a rollback snapshot's rows into the stored bytes", () => {
    const { raw } = fitClientToBudget(envelopeWith([paused]));
    expect(raw).not.toContain(SNAPSHOT_ROW);
    expect(raw).not.toContain('"context"');
    // The mutation itself is still there to replay.
    expect(raw).toContain('"isPaused":true');
    expect(raw).toContain('"id":"s1"');
  });
});
