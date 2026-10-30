import { beforeEach, describe, expect, it, vi } from "vitest";

type RetryInput = {
  id: string;
  action: "mark-ready" | "dismiss";
  expectedUpdatedAt: string;
};

interface QueryConfig {
  queryKey: readonly unknown[];
  enabled: boolean;
  queryFn: () => Promise<unknown>;
}

interface MutationConfig {
  mutationFn: (input: RetryInput) => Promise<unknown>;
  retry: boolean;
  onSettled: () => void;
}

const mocks = vi.hoisted(() => ({
  gate: {
    enabled: true,
    tenantId: "tenant-1" as string | null,
    userId: "user-1" as string | null,
    effectiveRole: "admin" as string | null,
  },
  fetchRetryEvents: vi.fn(),
  setRetryEventStatus: vi.fn(),
  invalidateQueries: vi.fn(),
  queryConfig: undefined as QueryConfig | undefined,
  mutationConfig: undefined as MutationConfig | undefined,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (config: QueryConfig) => {
    mocks.queryConfig = config;
    return { data: undefined, isError: false };
  },
  useMutation: (config: MutationConfig) => {
    mocks.mutationConfig = config;
    return { mutate: vi.fn(), isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("@/api/deliverabilityRecovery", () => ({
  fetchAutoSuppress: vi.fn(),
  fetchRetryEvents: mocks.fetchRetryEvents,
  fetchSoftBounceStats: vi.fn(),
  fetchSpamTrapHits: vi.fn(),
  fetchSpamTrapStats: vi.fn(),
  runSoftBounceRecovery: vi.fn(),
  setAutoSuppress: vi.fn(),
  setRetryEventStatus: mocks.setRetryEventStatus,
}));

vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => mocks.gate,
}));

// eslint-disable-next-line import/first
import {
  useRetryEvents,
  useSetRetryEventStatus,
} from "./useDeliverabilityRecovery";

const REVISION = "2026-08-29T00:01:02.123456789Z";

beforeEach(() => {
  mocks.gate.enabled = true;
  mocks.gate.tenantId = "tenant-1";
  mocks.gate.userId = "user-1";
  mocks.gate.effectiveRole = "admin";
  mocks.fetchRetryEvents.mockReset();
  mocks.fetchRetryEvents.mockResolvedValue([]);
  mocks.setRetryEventStatus.mockReset();
  mocks.setRetryEventStatus.mockResolvedValue({
    id: "event-1",
    updatedAt: "2026-08-29T00:02:00Z",
  });
  mocks.invalidateQueries.mockReset();
  mocks.invalidateQueries.mockResolvedValue(undefined);
  mocks.queryConfig = undefined;
  mocks.mutationConfig = undefined;
});

describe("intelligent-retry hooks", () => {
  it("does not fetch exact-admin evidence for a viewer and isolates the cache by principal", () => {
    mocks.gate.effectiveRole = "viewer";
    useRetryEvents();

    expect(mocks.queryConfig).toMatchObject({
      enabled: false,
      queryKey: ["intelligent-retry-events", "tenant-1", "user-1", "viewer"],
    });
    expect(mocks.fetchRetryEvents).not.toHaveBeenCalled();

    mocks.gate.effectiveRole = "superadmin";
    useRetryEvents();
    expect(mocks.queryConfig?.enabled).toBe(false);
  });

  it("enables the private read only for a complete online admin identity", async () => {
    useRetryEvents();
    expect(mocks.queryConfig).toMatchObject({
      enabled: true,
      queryKey: ["intelligent-retry-events", "tenant-1", "user-1", "admin"],
    });
    await mocks.queryConfig?.queryFn();
    expect(mocks.fetchRetryEvents).toHaveBeenCalledWith("tenant-1");

    mocks.gate.userId = null;
    useRetryEvents();
    expect(mocks.queryConfig?.enabled).toBe(false);
  });

  it("passes the loaded revision, disables retries, and invalidates after settle", async () => {
    useSetRetryEventStatus();
    expect(mocks.mutationConfig?.retry).toBe(false);

    await mocks.mutationConfig?.mutationFn({
      id: "event-1",
      action: "dismiss",
      expectedUpdatedAt: REVISION,
    });
    expect(mocks.setRetryEventStatus).toHaveBeenCalledWith(
      "event-1",
      "dismiss",
      REVISION,
      "tenant-1",
    );

    mocks.mutationConfig?.onSettled();
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["intelligent-retry-events", "tenant-1"],
    });
  });

  it("refuses a viewer mutation before the transport", async () => {
    mocks.gate.effectiveRole = "viewer";
    useSetRetryEventStatus();

    await expect(
      mocks.mutationConfig?.mutationFn({
        id: "event-1",
        action: "mark-ready",
        expectedUpdatedAt: REVISION,
      }),
    ).rejects.toThrow(/owner or admin access/iu);
    expect(mocks.setRetryEventStatus).not.toHaveBeenCalled();
  });
});
