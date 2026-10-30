// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";

import { MAX_SENDS_PER_HOUR, validateSendingForm } from "./sendingForm";
import {
  isCanonicalSendingSettingsRow,
  reconcileSendingSettingsMutation,
  setSendingSettingsOnce,
  type SendingSettingsWriteInput,
} from "./sendingSettingsMutation";
import { parseSendingStatus } from "./sendingStatusSchema";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const REVISION = "2026-08-30T08:00:00Z";
const INPUT: SendingSettingsWriteInput = {
  max_sends_per_hour: 250,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "America/New_York",
  quiet_hours_per_recipient: false,
  expected_updated_at: REVISION,
};

const saved = (overrides: Record<string, unknown> = {}) => ({
  tenant_id: TENANT,
  max_sends_per_hour: 250,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "America/New_York",
  quiet_hours_per_recipient: false,
  updated_at: "2026-08-30T08:01:00Z",
  ...overrides,
});

const status = (ready: boolean, overrides: Record<string, unknown> = {}) => ({
  ...saved(),
  cap_coordination_state: ready ? "ready" : "conservatively_fenced",
  cap_coordination_ready: ready,
  cap_coordination_cap: 250,
  cap_coordination_matches_settings: ready,
  ...overrides,
});

function fakeClient(options: {
  set: () => Promise<unknown>;
  get: () => Promise<unknown>;
  readStatus: () => Promise<unknown>;
}) {
  const set = vi.fn(options.set);
  const get = vi.fn(options.get);
  const request = vi.fn(options.readStatus);
  return {
    client: { sendingSettings: { set, get }, request } as never,
    set,
    get,
    request,
  };
}

describe("sending-settings normal-read schema", () => {
  it("accepts a bounded committed row and the exact synthetic no-row shape", () => {
    expect(isCanonicalSendingSettingsRow(saved())).toBe(true);
    expect(
      isCanonicalSendingSettingsRow({
        tenant_id: TENANT,
        quiet_hours_per_recipient: true,
        updated_at: "0001-01-01T00:00:00Z",
        ip_pool: { name: "shared", dedicated: false },
      }),
    ).toBe(true);
  });

  it.each([
    ["cap over the limit", saved({ max_sends_per_hour: 1_000_001 })],
    ["coerced cap", saved({ max_sends_per_hour: "250" })],
    ["partial quiet hours", saved({ quiet_hours_end: "" })],
    ["unknown timezone", saved({ quiet_hours_tz: "Mars/Olympus" })],
    ["equal quiet times", saved({ quiet_hours_end: "22:00" })],
    ["missing recipient mode", saved({ quiet_hours_per_recipient: undefined })],
    ["malformed revision", saved({ updated_at: "yesterday" })],
    ["non-UUID tenant", saved({ tenant_id: "tenant-a" })],
    ["non-UUID updater", saved({ updated_by_user_id: "user-1" })],
    ["unknown top-level member", saved({ route_proven: true })],
    [
      "unknown pool member",
      saved({
        ip_pool: { name: "shared", dedicated: false, route_proven: true },
      }),
    ],
    [
      "zero row carrying a fallback",
      {
        tenant_id: TENANT,
        quiet_hours_per_recipient: true,
        updated_at: "0001-01-01T00:00:00Z",
        fallback_hour_utc: 9,
      },
    ],
    [
      "zero row carrying an updater",
      {
        tenant_id: TENANT,
        quiet_hours_per_recipient: true,
        updated_at: "0001-01-01T00:00:00Z",
        updated_by_user_id: USER,
      },
    ],
    ["malformed pool", saved({ ip_pool: { name: "", dedicated: true } })],
  ])("rejects %s before it can seed a form", (_name, value) => {
    expect(isCanonicalSendingSettingsRow(value)).toBe(false);
  });
});

describe("sending-settings mutation reconciliation", () => {
  it("turns a committed 503 into success using canonical GET/status only", async () => {
    const c = fakeClient({
      set: async () => {
        throw { status: 503, code: "sending_cap_convergence_pending" };
      },
      get: async () => saved({ updated_at: "2026-08-30T08:00:00.000000001Z" }),
      readStatus: async () => status(true),
    });

    await expect(
      setSendingSettingsOnce(c.client, INPUT, TENANT),
    ).resolves.toMatchObject({ kind: "applied" });
    expect(c.set).toHaveBeenCalledTimes(1);
    expect(c.get).toHaveBeenCalledTimes(1);
    expect(c.request).toHaveBeenCalledWith(
      "GET",
      "/api/v1/settings/sending/status",
    );
  });

  it("holds a transport-unknown result until shared cap authority is ready", async () => {
    let ready = false;
    const c = fakeClient({
      set: async () => {
        throw new TypeError("response lost");
      },
      get: async () => saved(),
      readStatus: async () => status(ready),
    });

    await expect(
      setSendingSettingsOnce(c.client, INPUT, TENANT),
    ).resolves.toMatchObject({ kind: "pending" });
    expect(c.set).toHaveBeenCalledTimes(1);

    ready = true;
    await expect(
      reconcileSendingSettingsMutation(c.client, INPUT, TENANT),
    ).resolves.toMatchObject({ kind: "applied" });
    expect(c.set).toHaveBeenCalledTimes(1);
    expect(c.get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing", undefined],
    ["Go-zero", "0001-01-01T00:00:00Z"],
    ["impossible", "2026-02-30T08:01:00Z"],
    ["unchanged", REVISION],
    ["stale", "2026-08-30T07:59:59.999999999Z"],
    ["equal instant in another offset", "2026-08-30T09:00:00+01:00"],
  ])(
    "does not promote matching reconciliation with a %s revision",
    async (_name, updatedAt) => {
      const c = fakeClient({
        set: async () => {
          throw new TypeError("response lost");
        },
        get: async () => saved({ updated_at: updatedAt }),
        readStatus: async () => status(true),
      });

      await expect(
        setSendingSettingsOnce(c.client, INPUT, TENANT),
      ).resolves.toMatchObject({ kind: "pending" });
      expect(c.set).toHaveBeenCalledTimes(1);
      expect(c.get).toHaveBeenCalledTimes(1);
      expect(c.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["missing readiness", { cap_coordination_ready: undefined }],
    ["coerced readiness", { cap_coordination_ready: "true" }],
    ["missing match proof", { cap_coordination_matches_settings: undefined }],
    ["coerced matching cap", { cap_coordination_cap: "250" }],
    ["contradictory cap", { cap_coordination_cap: 251 }],
    [
      "active fence",
      { cap_coordination_fence_started_at: "2026-08-30T08:01:01Z" },
    ],
    ["malformed fence", { cap_coordination_fence_started_at: 1 }],
    ["malformed quiet-hours field", { quiet_hours_start: 2200 }],
  ])(
    "does not accept a superficially ready status with %s",
    async (_name, statusOverrides) => {
      const c = fakeClient({
        set: async () => {
          throw new TypeError("response lost");
        },
        get: async () => saved(),
        readStatus: async () => status(true, statusOverrides),
      });

      await expect(
        setSendingSettingsOnce(c.client, INPUT, TENANT),
      ).resolves.toMatchObject({ kind: "pending" });
      expect(c.set).toHaveBeenCalledTimes(1);
      expect(c.get).toHaveBeenCalledTimes(1);
      expect(c.request).toHaveBeenCalledTimes(1);
    },
  );

  it("waits for causal quiescence before the exact no-row projection proves not applied", async () => {
    let monotonicNow = 100;
    const clock = vi
      .spyOn(globalThis.performance, "now")
      .mockImplementation(() => monotonicNow);
    const firstWrite = { ...INPUT, expected_updated_at: "" };
    const c = fakeClient({
      set: async () => {
        throw new TypeError("response lost");
      },
      get: async () => ({
        tenant_id: TENANT,
        quiet_hours_per_recipient: true,
        ip_pool: { name: "shared", dedicated: false },
        updated_at: "0001-01-01T00:00:00Z",
      }),
      readStatus: async () => ({
        tenant_id: TENANT,
        quiet_hours_per_recipient: true,
        cap_coordination_state: "ready",
        cap_coordination_ready: true,
        cap_coordination_matches_settings: true,
        cap_coordination_fence_started_at: null,
      }),
    });

    try {
      const initial = await setSendingSettingsOnce(
        c.client,
        firstWrite,
        TENANT,
      );
      expect(initial).toMatchObject({ kind: "pending" });
      const dispatchedAt =
        initial.kind === "pending" ? initial.mutationDispatchedAt : undefined;

      monotonicNow += 35_001;
      await expect(
        reconcileSendingSettingsMutation(
          c.client,
          firstWrite,
          TENANT,
          dispatchedAt,
        ),
      ).resolves.toMatchObject({ kind: "not-applied" });
      expect(c.set).toHaveBeenCalledTimes(1);
      expect(c.get).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ["missing revision", { updated_at: undefined }],
    ["null revision", { updated_at: null }],
    ["empty revision", { updated_at: "" }],
    ["zero-prefix revision", { updated_at: "0001-01-01T00:00:00Z-extra" }],
    ["explicit null cap", { max_sends_per_hour: null }],
    ["explicit empty quiet field", { quiet_hours_start: "" }],
    ["legacy fallback", { fallback_hour_utc: 9 }],
    ["updater identity", { updated_by_user_id: USER }],
  ])(
    "keeps a first write pending for a no-row projection with %s",
    async (_name, projectionOverrides) => {
      const firstWrite = { ...INPUT, expected_updated_at: "" };
      const c = fakeClient({
        set: async () => {
          throw new TypeError("response lost");
        },
        get: async () => ({
          tenant_id: TENANT,
          quiet_hours_per_recipient: true,
          updated_at: "0001-01-01T00:00:00Z",
          ...projectionOverrides,
        }),
        readStatus: async () => ({}),
      });

      await expect(
        setSendingSettingsOnce(c.client, firstWrite, TENANT),
      ).resolves.toMatchObject({ kind: "pending" });
      expect(c.set).toHaveBeenCalledTimes(1);
    },
  );

  it("fails closed on malformed success and malformed verification payloads", async () => {
    const c = fakeClient({
      set: async () => undefined,
      get: async () => null,
      readStatus: async () => null,
    });

    await expect(
      setSendingSettingsOnce(c.client, INPUT, TENANT),
    ).resolves.toMatchObject({ kind: "pending" });
    expect(c.set).toHaveBeenCalledTimes(1);
  });

  it("requires a fresh post-window baseline and ready authority before releasing retry", async () => {
    let monotonicNow = 500;
    let ready = false;
    const clock = vi
      .spyOn(globalThis.performance, "now")
      .mockImplementation(() => monotonicNow);
    const c = fakeClient({
      set: async () => {
        throw { status: 503 };
      },
      get: async () =>
        saved({
          max_sends_per_hour: 500,
          updated_at: REVISION,
        }),
      readStatus: async () =>
        ready
          ? status(true, {
              max_sends_per_hour: 500,
              cap_coordination_cap: 500,
            })
          : status(false, {
              max_sends_per_hour: 500,
              cap_coordination_cap: 500,
              cap_coordination_fence_started_at: "2026-08-30T08:00:01Z",
            }),
    });

    try {
      const initial = await setSendingSettingsOnce(c.client, INPUT, TENANT);
      expect(initial).toMatchObject({ kind: "pending" });
      const dispatchedAt =
        initial.kind === "pending" ? initial.mutationDispatchedAt : undefined;

      monotonicNow += 35_001;
      await expect(
        reconcileSendingSettingsMutation(c.client, INPUT, TENANT, dispatchedAt),
      ).resolves.toMatchObject({ kind: "pending" });

      ready = true;
      await expect(
        reconcileSendingSettingsMutation(c.client, INPUT, TENANT, dispatchedAt),
      ).resolves.toMatchObject({ kind: "not-applied" });
      expect(c.set).toHaveBeenCalledTimes(1);
      expect(c.get).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
    }
  });

  it("releases a rolled-back no-op once the unchanged revision is quiescent and ready", async () => {
    let monotonicNow = 1_000;
    const clock = vi
      .spyOn(globalThis.performance, "now")
      .mockImplementation(() => monotonicNow);
    const c = fakeClient({
      set: async () => {
        throw new TypeError("response lost");
      },
      get: async () => saved({ updated_at: REVISION }),
      readStatus: async () => status(true, { updated_at: REVISION }),
    });

    try {
      const initial = await setSendingSettingsOnce(c.client, INPUT, TENANT);
      expect(initial).toMatchObject({ kind: "pending" });
      const dispatchedAt =
        initial.kind === "pending" ? initial.mutationDispatchedAt : undefined;

      monotonicNow += 35_001;
      await expect(
        reconcileSendingSettingsMutation(c.client, INPUT, TENANT, dispatchedAt),
      ).resolves.toMatchObject({ kind: "not-applied" });
      expect(c.set).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("never accepts another tenant's canonical row", async () => {
    const c = fakeClient({
      set: async () => {
        throw { status: 503 };
      },
      get: async () => saved({ tenant_id: OTHER_TENANT }),
      readStatus: async () => status(true),
    });

    await expect(
      setSendingSettingsOnce(c.client, INPUT, TENANT),
    ).resolves.toMatchObject({ kind: "pending" });
    expect(c.set).toHaveBeenCalledTimes(1);
  });

  it("surfaces a 409 only with an exact not-committed receipt", async () => {
    const conflict = {
      status: 409,
      code: "settings_revision_conflict",
      responseMetadata: { sendingCapOutcome: "not-committed" },
    };
    const c = fakeClient({
      set: async () => {
        throw conflict;
      },
      get: async () => saved(),
      readStatus: async () => status(true),
    });

    await expect(setSendingSettingsOnce(c.client, INPUT, TENANT)).rejects.toBe(
      conflict,
    );
    expect(c.set).toHaveBeenCalledTimes(1);
    expect(c.get).not.toHaveBeenCalled();
    expect(c.request).not.toHaveBeenCalled();
  });

  it.each([
    [400, undefined],
    [401, { sendingCapOutcome: "not-committed " }],
    [412, { sendingCapOutcome: "committed" }],
  ])(
    "holds an unproven HTTP %s outcome for read-only reconciliation",
    async (statusCode, responseMetadata) => {
      const c = fakeClient({
        set: async () => {
          throw {
            status: statusCode,
            code: "rewritten_response",
            responseMetadata,
          };
        },
        get: async () => {
          throw new TypeError("canonical read unavailable");
        },
        readStatus: async () => {
          throw new TypeError("status read unavailable");
        },
      });

      await expect(
        setSendingSettingsOnce(c.client, INPUT, TENANT),
      ).resolves.toMatchObject({ kind: "pending" });
      expect(c.set).toHaveBeenCalledTimes(1);
      expect(c.get).toHaveBeenCalledTimes(1);
      expect(c.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([400, 503])(
    "allows ordinary retry for HTTP %s only with exact not-committed proof",
    async (statusCode) => {
      const failure = {
        status: statusCode,
        code: "definitely_not_committed",
        responseMetadata: { sendingCapOutcome: "not-committed" },
      };
      const c = fakeClient({
        set: async () => {
          throw failure;
        },
        get: async () => saved(),
        readStatus: async () => status(true),
      });

      await expect(
        setSendingSettingsOnce(c.client, INPUT, TENANT),
      ).rejects.toBe(failure);
      expect(c.set).toHaveBeenCalledTimes(1);
      expect(c.get).not.toHaveBeenCalled();
      expect(c.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    "0001-01-01T00:00:00Z",
    "2026-02-30T08:01:00Z",
    REVISION,
    "2026-08-30T07:59:59.999999999Z",
    "2026-08-30T09:00:00+01:00",
  ])(
    "reconciles a committed-shaped response with invalid revision %s",
    async (updatedAt) => {
      const c = fakeClient({
        set: async () => saved({ updated_at: updatedAt }),
        get: async () => {
          throw new TypeError("canonical read unavailable");
        },
        readStatus: async () => {
          throw new TypeError("status read unavailable");
        },
      });

      await expect(
        setSendingSettingsOnce(c.client, INPUT, TENANT),
      ).resolves.toMatchObject({ kind: "pending" });
      expect(c.set).toHaveBeenCalledTimes(1);
      expect(c.get).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts a genuinely newer sub-millisecond direct revision", async () => {
    const c = fakeClient({
      set: async () => saved({ updated_at: "2026-08-30T08:00:00.000000001Z" }),
      get: async () => {
        throw new Error("reconciliation must not run");
      },
      readStatus: async () => {
        throw new Error("reconciliation must not run");
      },
    });

    await expect(
      setSendingSettingsOnce(c.client, INPUT, TENANT),
    ).resolves.toMatchObject({ kind: "applied" });
    expect(c.set).toHaveBeenCalledTimes(1);
    expect(c.get).not.toHaveBeenCalled();
  });
});

/**
 * CQ-3: four gates read the same two rules — the form, the row schema, the
 * status parser and the reconcile proof. Each used to carry its own copy of
 * the cap ceiling and of the quiet-hours rule, and the form's copy had already
 * lost the start !== end clause the other three (and the server) enforce.
 * The table below asks all four the same question at each edge.
 */
describe("sending-settings cross-module contract", () => {
  type Row = ReturnType<typeof saved>;

  const formAccepts = (row: Row): boolean =>
    Object.keys(
      validateSendingForm({
        maxSendsPerHour:
          row.max_sends_per_hour == null ? "" : String(row.max_sends_per_hour),
        quietStart: row.quiet_hours_start ?? "",
        quietEnd: row.quiet_hours_end ?? "",
        quietTz: row.quiet_hours_tz ?? "",
        perRecipient: row.quiet_hours_per_recipient,
      }),
    ).length === 0;

  /** The full status wire shape, counter contract included. */
  const wireStatus = (row: Row) => ({
    ...row,
    cap_coordination_state: "ready",
    cap_coordination_ready: true,
    cap_coordination_cap: row.max_sends_per_hour,
    cap_coordination_matches_settings: true,
    counter_authoritative: false,
    counter_source: "unavailable",
    counter_scope: "unavailable",
  });

  const statusParses = (row: Row): boolean => {
    try {
      parseSendingStatus(wireStatus(row));
      return true;
    } catch {
      return false;
    }
  };

  /** A lost PUT resolved by reads, where the reads prove this exact row. */
  const reconcileKind = async (row: Row): Promise<string> => {
    const c = fakeClient({
      set: async () => {
        throw new TypeError("response lost");
      },
      get: async () => row,
      readStatus: async () => wireStatus(row),
    });
    const input: SendingSettingsWriteInput = {
      max_sends_per_hour: row.max_sends_per_hour,
      quiet_hours_start: row.quiet_hours_start,
      quiet_hours_end: row.quiet_hours_end,
      quiet_hours_tz: row.quiet_hours_tz,
      quiet_hours_per_recipient: row.quiet_hours_per_recipient,
      expected_updated_at: REVISION,
    };
    const result = await reconcileSendingSettingsMutation(
      c.client,
      input,
      TENANT,
    );
    expect(c.set).not.toHaveBeenCalled();
    return result.kind;
  };

  it("mirrors the server's MaxSendsPerHour", () => {
    // apps/api/internal/sendingsettings/sendingsettings.go:98
    expect(MAX_SENDS_PER_HOUR).toBe(1_000_000);
  });

  it("accepts a cap of exactly the ceiling in all four", async () => {
    const row = saved({ max_sends_per_hour: MAX_SENDS_PER_HOUR });
    expect(formAccepts(row)).toBe(true);
    expect(isCanonicalSendingSettingsRow(row)).toBe(true);
    expect(statusParses(row)).toBe(true);
    await expect(reconcileKind(row)).resolves.toBe("applied");
  });

  it("refuses one over the ceiling in all four", async () => {
    const row = saved({ max_sends_per_hour: MAX_SENDS_PER_HOUR + 1 });
    expect(formAccepts(row)).toBe(false);
    expect(isCanonicalSendingSettingsRow(row)).toBe(false);
    expect(statusParses(row)).toBe(false);
    await expect(reconcileKind(row)).resolves.not.toBe("applied");
  });

  it("refuses a quiet window that starts and ends at the same minute in all four", async () => {
    const row = saved({
      quiet_hours_start: "22:00",
      quiet_hours_end: "22:00",
      quiet_hours_tz: "UTC",
    });
    // Vacuity floor: the same row with a real window passes every gate, so
    // the refusals below are about the equal times and nothing else.
    const control = { ...row, quiet_hours_end: "07:00" };
    expect(formAccepts(control)).toBe(true);
    expect(isCanonicalSendingSettingsRow(control)).toBe(true);
    expect(statusParses(control)).toBe(true);
    await expect(reconcileKind(control)).resolves.toBe("applied");

    expect(formAccepts(row)).toBe(false);
    expect(isCanonicalSendingSettingsRow(row)).toBe(false);
    expect(statusParses(row)).toBe(false);
    await expect(reconcileKind(row)).resolves.not.toBe("applied");
  });
});
