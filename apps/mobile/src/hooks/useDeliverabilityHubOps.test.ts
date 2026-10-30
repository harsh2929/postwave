import { beforeEach, describe, expect, it, vi } from "vitest";

interface MutationConfig {
  mutationFn: () => Promise<unknown>;
  retry: boolean;
  onSettled: () => void;
}

const mocks = vi.hoisted(() => ({
  clearRepairOverride: vi.fn(),
  invalidateQueries: vi.fn(),
  refetchQueries: vi.fn(),
  mutationConfig: undefined as MutationConfig | undefined,
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (config: MutationConfig) => {
    mocks.mutationConfig = config;
    return { mutate: vi.fn(), isPending: false };
  },
  useQuery: vi.fn(),
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidateQueries,
    refetchQueries: mocks.refetchQueries,
  }),
}));

vi.mock("@/api/deliverabilityHubOps", () => ({
  clearRepairOverride: mocks.clearRepairOverride,
  fetchWebhookErrors: vi.fn(),
}));

vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => ({
    tenantId: "tenant-1",
    enabled: true,
  }),
}));

// eslint-disable-next-line import/first
import { useClearRepairOverride } from "./useDeliverabilityHubOps";

beforeEach(() => {
  mocks.clearRepairOverride.mockReset();
  mocks.clearRepairOverride.mockResolvedValue({
    kind: "committed",
    cleared: true,
    capCoordinationOutcome: "committed",
  });
  mocks.invalidateQueries.mockReset();
  mocks.invalidateQueries.mockResolvedValue(undefined);
  mocks.refetchQueries.mockReset();
  mocks.refetchQueries.mockResolvedValue(undefined);
  mocks.mutationConfig = undefined;
});

describe("useClearRepairOverride", () => {
  it("disables mutation retries and invalidates current hub state on every settle", async () => {
    useClearRepairOverride();
    const config = mocks.mutationConfig;
    expect(config).toBeDefined();
    expect(config?.retry).toBe(false);

    await expect(config?.mutationFn()).resolves.toMatchObject({
      kind: "committed",
    });
    expect(mocks.clearRepairOverride).toHaveBeenCalledTimes(1);

    config?.onSettled();
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["deliverability-hub", "tenant-1"],
    });
  });

  it("reconciles with an active-query read and never dispatches the mutation", async () => {
    const hook = useClearRepairOverride();
    await hook.reconcile();

    expect(mocks.refetchQueries).toHaveBeenCalledWith(
      {
        queryKey: ["deliverability-hub", "tenant-1"],
        type: "active",
      },
      { throwOnError: true },
    );
    expect(mocks.clearRepairOverride).not.toHaveBeenCalled();
  });
});
