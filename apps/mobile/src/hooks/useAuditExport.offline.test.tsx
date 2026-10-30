/**
 * The audit export's three writes, started with no connection (CRIT-2).
 *
 * `canStart` is AUTH state (a validated session), not reachability. So once
 * the export history has loaded, a phone that loses signal still offers
 * "Export this window". Under the client's mutation default (networkMode
 * "online") that tap was PAUSED: "Starting…" spun and no toast appeared.
 * Then, on reconnect, the POST went out anyway. It enqueued a server-side
 * export for an operator who may have given up minutes or hours before.
 * Creating and deleting a recurring schedule paused and replayed the same way.
 *
 * WHAT STAYS REAL. The hook, TanStack, and the app's OWN QueryClient with its
 * mutation defaults. The pause is behaviour of that client, so a stand-in
 * client, or reading back the options object, would only restate the code
 * under test. The transports, the online gate and the toast are stand-ins.
 * `onlineManager` is flipped the way lib/connectivity flips it from NetInfo.
 *
 * Each case lets the history load online, drops the connection and fires the
 * write. Then it checks the outcome: the request left at once with the shape
 * the sheet promised, the caller's error toast is shown, nothing is left
 * spinning, and reconnecting replays nothing.
 */
import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditExportSchedule } from "@/lib/auditExportSchedules";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  gate: {
    enabled: true,
    baseUrl: "https://api.postwave.test",
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    effectiveRole: "admin",
    credentialScope: "session",
    canReadOfflineSnapshots: true,
  },
  request: vi.fn(),
  createSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  fetchSchedules: vi.fn(),
  toast: vi.fn(),
}));

// lib/queryClient builds its persister at import time.
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => m.gate,
}));
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: m.toast }),
}));
vi.mock("@/api/client", () => ({
  getClient: () => ({ client: { request: m.request } }),
}));
vi.mock("@/api/auditExportSchedules", () => ({
  createAuditExportSchedule: (...args: unknown[]) => m.createSchedule(...args),
  deleteAuditExportSchedule: (...args: unknown[]) => m.deleteSchedule(...args),
  fetchAuditExportSchedules: (...args: unknown[]) => m.fetchSchedules(...args),
}));

const { queryClient } = await import("@/lib/queryClient");
const { useAuditExportController } = await import("./useAuditExport");

/** What the transport throws when the radio is gone. */
const OFFLINE = () => new TypeError("Network request failed");

/** Yesterday's finished export: a loaded history with nothing in flight. */
const DONE_JOB = {
  id: "job-1",
  status: "completed",
  createdAt: "2026-09-13T08:00:00Z",
  completedAt: "2026-09-13T08:02:00Z",
  exportedRows: 120,
  estimatedRows: 120,
};

const SCHEDULE: AuditExportSchedule = {
  id: "sched-1",
  cadence: "weekly",
  recipients: ["dpo@example.com"],
  enabled: true,
  createdByEmail: "admin@example.com",
  lastEnqueuedAt: null,
  createdAt: "2026-09-01T00:00:00Z",
};

type Controller = ReturnType<typeof useAuditExportController>;
let latest: Controller;
let renderer: TestRenderer.ReactTestRenderer | undefined;

function Probe() {
  latest = useAuditExportController(
    true,
    {
      actorType: "user",
      since: "2026-09-13T00:00:00Z",
      windowDescription: "the last 24 hours",
    },
    { isAdmin: true },
  );
  return null;
}

/** Let every queued fetch, mutation and effect settle. */
async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountLoaded() {
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await settle();
  // The state CRIT-2 is about: the history is LOADED, so the sheet's
  // paused-first-fetch guard does not apply and Start is on offer.
  expect(latest.jobs).toEqual([DONE_JOB]);
  expect(latest.isPaused).toBe(false);
  expect(latest.canStart).toBe(true);
  expect(latest.schedules.canManage).toBe(true);
}

async function setOnline(online: boolean) {
  await act(async () => {
    onlineManager.setOnline(online);
  });
  await settle();
}

/** Every write the transport saw: the history's GETs are not writes. */
function writes(): unknown[][] {
  return m.request.mock.calls.filter(([method]) => method !== "GET");
}

beforeEach(() => {
  m.request.mockReset();
  m.createSchedule.mockReset();
  m.deleteSchedule.mockReset();
  m.fetchSchedules.mockReset();
  m.toast.mockReset();
  m.request.mockImplementation(async (method: string) => {
    if (method === "GET") return { jobs: [DONE_JOB] };
    throw OFFLINE();
  });
  m.fetchSchedules.mockResolvedValue([SCHEDULE]);
  m.createSchedule.mockRejectedValue(OFFLINE());
  m.deleteSchedule.mockRejectedValue(OFFLINE());
});

// Unmount and clear BEFORE going back online: a write a failing case left
// paused must not resume into the next case's mocks.
afterEach(async () => {
  const current = renderer;
  renderer = undefined;
  if (current) await act(async () => current.unmount());
  queryClient.clear();
  onlineManager.setOnline(true);
});

describe("audit export writes started offline fail now instead of replaying later", () => {
  it("Start sends the POST at once, toasts the failure, and reconnecting enqueues nothing", async () => {
    await mountLoaded();
    await setOnline(false);

    await act(async () => {
      latest.start();
    });
    await settle();

    expect(latest.scope.body).toEqual({
      actorType: "user",
      since: "2026-09-13T00:00:00Z",
    });
    expect(writes()).toEqual([
      [
        "POST",
        "/api/v1/audit/export-async",
        { body: { actorType: "user", since: "2026-09-13T00:00:00Z" } },
      ],
    ]);
    expect(m.toast.mock.calls).toEqual([
      [
        {
          kind: "error",
          message:
            "Couldn't queue the export. Check your connection and try again.",
        },
      ],
    ]);
    expect(latest.starting).toBe(false);

    await setOnline(true);
    expect(writes()).toHaveLength(1);
    expect(m.toast).toHaveBeenCalledTimes(1);
  });

  it("creating a schedule offline resolves false with the error toast, and is not created on reconnect", async () => {
    await mountLoaded();
    await setOnline(false);

    let outcome: boolean | undefined;
    await act(async () => {
      void latest.schedules
        .create({ cadence: "weekly", recipients: ["dpo@example.com"] })
        .then((ok) => {
          outcome = ok;
        });
    });
    await settle();

    expect(m.createSchedule.mock.calls).toEqual([
      [{ cadence: "weekly", recipients: ["dpo@example.com"] }],
    ]);
    expect(outcome).toBe(false);
    expect(m.toast.mock.calls).toEqual([
      [
        {
          kind: "error",
          message:
            "Couldn't create the schedule. Check your connection and try again.",
        },
      ],
    ]);
    expect(latest.schedules.creating).toBe(false);

    await setOnline(true);
    expect(m.createSchedule).toHaveBeenCalledTimes(1);
  });

  it("deleting a schedule offline resolves false with the error toast, and is not deleted on reconnect", async () => {
    await mountLoaded();
    expect(latest.schedules.rows).toEqual([SCHEDULE]);
    await setOnline(false);

    let outcome: boolean | undefined;
    await act(async () => {
      void latest.schedules.remove(SCHEDULE).then((ok) => {
        outcome = ok;
      });
    });
    await settle();

    expect(m.deleteSchedule.mock.calls).toEqual([["sched-1"]]);
    expect(outcome).toBe(false);
    expect(m.toast.mock.calls).toEqual([
      [
        {
          kind: "error",
          message:
            "Couldn't delete the schedule. Check your connection and try again.",
        },
      ],
    ]);
    expect(latest.schedules.removing).toBe(false);

    await setOnline(true);
    expect(m.deleteSchedule).toHaveBeenCalledTimes(1);
  });
});
