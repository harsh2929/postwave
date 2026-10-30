import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryOptions = {
  enabled: boolean;
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
};

type MutationOptions = {
  mutationFn: (input: Record<string, unknown>) => Promise<unknown>;
  onSuccess: (result: unknown) => void;
};

const mocks = vi.hoisted(() => ({
  gate: {
    enabled: true,
    baseUrl: "https://api.postwave.test/gateway",
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: null as string | null,
    effectiveRole: null as string | null,
    credentialScope: "api-key:generation-one",
    canReadOfflineSnapshots: false,
  },
  getSettings: vi.fn(),
  setSettings: vi.fn(),
  request: vi.fn(),
  loadSnapshotBacked: vi.fn(),
  queryOptions: [] as QueryOptions[],
  mutationOptions: undefined as MutationOptions | undefined,
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryOptions) => {
    mocks.queryOptions.push(options);
    return options;
  },
  useMutation: (options: MutationOptions) => {
    mocks.mutationOptions = options;
    return { isPending: false, mutateAsync: vi.fn() };
  },
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => mocks.gate,
  onlineQueryAuthorityOwner: (gate: typeof mocks.gate) =>
    JSON.stringify([
      gate.baseUrl,
      gate.tenantId,
      gate.userId,
      gate.effectiveRole,
      gate.credentialScope,
    ]),
  canRunOnlineOrSnapshotQuery: (gate: typeof mocks.gate) =>
    gate.enabled || gate.canReadOfflineSnapshots,
}));

vi.mock("@/api/sdkClient", () => ({
  getClient: () => ({
    client: {
      sendingSettings: {
        get: mocks.getSettings,
        set: mocks.setSettings,
      },
      request: mocks.request,
    },
  }),
}));

vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: () => true }));
vi.mock("@/lib/deliverabilitySnapshots", () => ({
  snapshotScope: (gate: typeof mocks.gate) =>
    gate.canReadOfflineSnapshots ? "qualified-snapshot-scope" : null,
  loadSnapshotBacked: mocks.loadSnapshotBacked,
}));

// eslint-disable-next-line import/first
import {
  sendingSettingsQueryKey,
  sendingStatusQueryKey,
  useSendingSettings,
  useSendingStatus,
  useUpdateSendingSettings,
} from "./useSendingOps";

const ROW = {
  tenant_id: "11111111-1111-4111-8111-111111111111",
  max_sends_per_hour: 250,
  quiet_hours_start: "",
  quiet_hours_end: "",
  quiet_hours_tz: "",
  quiet_hours_per_recipient: true,
  updated_at: "2026-09-07T08:00:00.000000001Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryOptions.length = 0;
  mocks.mutationOptions = undefined;
  Object.assign(mocks.gate, {
    enabled: true,
    baseUrl: "https://api.postwave.test/gateway",
    tenantId: ROW.tenant_id,
    userId: null,
    effectiveRole: null,
    credentialScope: "api-key:generation-one",
    canReadOfflineSnapshots: false,
  });
  mocks.getSettings.mockResolvedValue(ROW);
  mocks.setSettings.mockResolvedValue(ROW);
  mocks.loadSnapshotBacked.mockImplementation(
    async (input: { loadNetwork: () => Promise<unknown> }) => ({
      value: await input.loadNetwork(),
      fromSnapshot: false,
      capturedAt: 1,
    }),
  );
});

describe("sending settings query authority", () => {
  it("loads an online API-key baseline even though no human snapshot scope exists", async () => {
    useSendingSettings();
    const options = mocks.queryOptions[0];

    expect(options?.enabled).toBe(true);
    expect(options?.queryKey).toEqual(sendingSettingsQueryKey(mocks.gate));
    await expect(options?.queryFn()).resolves.toMatchObject({ value: ROW });
    expect(mocks.getSettings).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed or wrong-tenant cached snapshot values", async () => {
    Object.assign(mocks.gate, {
      enabled: false,
      userId: "22222222-2222-4222-8222-222222222222",
      effectiveRole: "owner",
      credentialScope: "session",
      canReadOfflineSnapshots: true,
    });

    mocks.loadSnapshotBacked.mockResolvedValueOnce({
      value: { ...ROW, max_sends_per_hour: "250" },
      fromSnapshot: true,
      capturedAt: 1,
    });
    useSendingSettings();
    await expect(mocks.queryOptions[0]?.queryFn()).rejects.toThrow(
      /invalid or did not match the active workspace/u,
    );

    mocks.queryOptions.length = 0;
    mocks.loadSnapshotBacked.mockResolvedValueOnce({
      value: {
        ...ROW,
        tenant_id: "33333333-3333-4333-8333-333333333333",
      },
      fromSnapshot: true,
      capturedAt: 1,
    });
    useSendingSettings();
    await expect(mocks.queryOptions[0]?.queryFn()).rejects.toThrow(
      /invalid or did not match the active workspace/u,
    );
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });

  it("uses the same full owner tuple for settings, status, and invalidation", async () => {
    useUpdateSendingSettings();
    const settingsKey = sendingSettingsQueryKey(mocks.gate);
    const statusKey = sendingStatusQueryKey(mocks.gate);

    expect(settingsKey[1]).toBe(statusKey[1]);
    const result = await mocks.mutationOptions?.mutationFn({
      max_sends_per_hour: 250,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "",
      quiet_hours_per_recipient: true,
      expected_updated_at: "2026-09-07T08:00:00Z",
    });

    expect(result).toMatchObject({ kind: "applied" });
    expect(mocks.setSettings).toHaveBeenCalledTimes(1);
    mocks.mutationOptions?.onSuccess(result);
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: settingsKey,
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: statusKey,
    });
  });

  it("changes settings and status keys together on origin or key rotation", () => {
    const firstSettings = sendingSettingsQueryKey(mocks.gate);
    const firstStatus = sendingStatusQueryKey(mocks.gate);

    mocks.gate.baseUrl = "https://other.postwave.test/gateway";
    expect(sendingSettingsQueryKey(mocks.gate)).not.toEqual(firstSettings);
    expect(sendingStatusQueryKey(mocks.gate)).not.toEqual(firstStatus);

    mocks.gate.baseUrl = "https://api.postwave.test/gateway";
    mocks.gate.credentialScope = "api-key:generation-two";
    expect(sendingSettingsQueryKey(mocks.gate)).not.toEqual(firstSettings);
    expect(sendingStatusQueryKey(mocks.gate)).not.toEqual(firstStatus);
  });
});

/**
 * PERF-1 — the status poll must follow the SCREEN's focus, not its mount.
 *
 * sending-settings is a hidden Tabs.Screen, and Expo Router keeps a visited tab
 * mounted, so an unconditional `refetchInterval` kept one observer polling
 * GET /api/v1/settings/sending/status every 30 seconds for the rest of the
 * session after a single visit: ten requests per five minutes on the dashboard
 * for a screen nobody was looking at.
 *
 * The captured options run in a REAL QueryObserver (the file-wide mock only
 * records them), because the thing that regresses is the request count the
 * scheduler produces, not the shape of an options object.
 */
describe("sending status poll follows screen focus", () => {
  type ReactQuery = typeof import("@tanstack/react-query");
  let restoreServerCheck: (() => void) | null = null;
  let restoreFocus: (() => void) | null = null;

  /** A status payload parseSendingStatus accepts for the gate's workspace. */
  const STATUS_WIRE = {
    tenant_id: ROW.tenant_id,
    max_sends_per_hour: 250,
    quiet_hours_start: "",
    quiet_hours_end: "",
    quiet_hours_tz: "",
    quiet_hours_per_recipient: true,
    counter_authoritative: false,
    counter_source: "unavailable",
    counter_scope: "unavailable",
    cap_coordination_state: "ready",
    cap_coordination_ready: true,
    cap_coordination_cap: 250,
    cap_coordination_matches_settings: true,
  };

  afterEach(() => {
    restoreServerCheck?.();
    restoreFocus?.();
    restoreServerCheck = null;
    restoreFocus = null;
    vi.useRealTimers();
  });

  /**
   * GETs the status query the hook last issued makes in five minutes after
   * its mount read. Each test calls the hook itself (rules-of-hooks), so this
   * only ever runs the options it captured.
   */
  async function statusGetsOverFiveMinutes(
    appForeground = true,
  ): Promise<number> {
    const options = mocks.queryOptions.at(-1);
    if (!options) throw new Error("useSendingStatus issued no query");
    const rq = await vi.importActual<ReactQuery>("@tanstack/react-query");
    // Under node TanStack believes it is server-rendering and never arms a
    // refetch timer at all, which would make every count here a vacuous 0.
    rq.environmentManager.setIsServer(() => false);
    restoreServerCheck = () =>
      rq.environmentManager.setIsServer(() => rq.isServer);
    rq.focusManager.setFocused(appForeground);
    restoreFocus = () => rq.focusManager.setFocused(undefined);
    vi.useFakeTimers();
    mocks.request.mockResolvedValue(STATUS_WIRE);

    const client = new rq.QueryClient({
      defaultOptions: { queries: { retry: 0 } },
    });
    const observer = new rq.QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      // The mount read ran and parsed for this workspace, so the count below
      // measures the poll alone rather than a query that never started.
      expect(mocks.request).toHaveBeenCalledTimes(1);
      expect(observer.getCurrentResult().data).toMatchObject({
        tenantId: ROW.tenant_id,
      });
      mocks.request.mockClear();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      return mocks.request.mock.calls.length;
    } finally {
      unsubscribe();
      client.clear();
    }
  }

  it("issues no status GETs while the sending-settings tab is blurred", async () => {
    useSendingStatus({ focused: false });
    await expect(statusGetsOverFiveMinutes()).resolves.toBe(0);
  });

  it("keeps desktop's 30-second cadence while the tab is focused", async () => {
    useSendingStatus({ focused: true });
    await expect(statusGetsOverFiveMinutes()).resolves.toBe(10);
    expect(mocks.request).toHaveBeenLastCalledWith(
      "GET",
      "/api/v1/settings/sending/status",
    );
  });

  it("stops even the focused poll while the app is backgrounded", async () => {
    useSendingStatus({ focused: true });
    await expect(statusGetsOverFiveMinutes(false)).resolves.toBe(0);
  });
});
