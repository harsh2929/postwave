import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SmsSuppression } from "@/lib/suppressionContracts";
import {
  authorizeAndAddSmsSuppression,
  SmsSuppressionAddOutcomeUnknownError,
  SmsSuppressionAddRefusedError,
  type SmsSuppressionAddRuntime,
} from "@/lib/smsSuppressionAdd";
import {
  authorizeAndRemoveSmsSuppression,
  SmsSuppressionRemovalOutcomeUnknownError,
  SmsSuppressionRemovalRefusedError,
  type SmsSuppressionRemovalRuntime,
} from "@/lib/smsSuppressionRemoval";

const harness = {
  current: null as Record<string, unknown> | null,
  online: true,
  request: vi.fn<(id: string) => Promise<unknown>>(async (id) => ({
    ok: true,
    tenantId: TENANT,
    id,
  })),
};

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function row(over: Partial<SmsSuppression> = {}): SmsSuppression {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    phone: "+12025550101",
    reason: "manual",
    source: "manual",
    createdAt: "2026-08-21T10:00:00Z",
    reversible: true,
    ...over,
  };
}

function profile(effectiveRole = "admin") {
  return { tenantId: TENANT, userId: USER, effectiveRole };
}

function state(effectiveRole = "admin") {
  return {
    baseUrl: "https://api.postwave.test",
    mode: "session",
    session: { tenantId: TENANT, userId: USER, effectiveRole },
    sessionValidation: "validated_online",
    canUseOnlineServices: () => true,
    refreshSessionFromServer: vi.fn(async () => profile(effectiveRole)),
  };
}

beforeEach(() => {
  harness.current = state();
  harness.online = true;
  harness.request.mockClear();
  harness.request.mockImplementation(async (id) => ({
    ok: true,
    tenantId: TENANT,
    id,
  }));
});

function runtime(): SmsSuppressionRemovalRuntime {
  return {
    isOnline: () => harness.online,
    readAuth: () => harness.current as never,
    deleteSuppression: harness.request,
  };
}

describe("SMS suppression removal authority", () => {
  it.each([
    [
      "STOP",
      row({
        reason: "stop_keyword",
        source: "twilio",
        reversible: false,
        lockedReason: "carrier_or_system_authority",
      }),
    ],
    [
      "carrier",
      row({
        reason: "carrier_block",
        source: "telnyx",
        reversible: false,
        lockedReason: "carrier_or_system_authority",
      }),
    ],
    [
      "complaint",
      row({
        reason: "complaint",
        source: "bandwidth",
        reversible: false,
        lockedReason: "carrier_or_system_authority",
      }),
    ],
    [
      "system",
      row({
        reason: "quiet_hours",
        source: "api",
        reversible: false,
        lockedReason: "carrier_or_system_authority",
      }),
    ],
  ])("rejects %s before reauth or DELETE", async (_label, locked) => {
    const initial = harness.current as ReturnType<typeof state>;
    await expect(
      authorizeAndRemoveSmsSuppression(locked, TENANT, runtime()),
    ).rejects.toBeInstanceOf(SmsSuppressionRemovalRefusedError);
    expect(initial.refreshSessionFromServer).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("rejects a cached viewer before any network request", async () => {
    harness.current = state("viewer");
    const initial = harness.current as ReturnType<typeof state>;
    await expect(
      authorizeAndRemoveSmsSuppression(row(), TENANT, runtime()),
    ).rejects.toBeInstanceOf(SmsSuppressionRemovalRefusedError);
    expect(initial.refreshSessionFromServer).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("revalidates and refuses DELETE if the effective role was demoted", async () => {
    const initial = state("admin");
    initial.refreshSessionFromServer.mockImplementation(async () => {
      harness.current = state("viewer");
      return profile("viewer");
    });
    harness.current = initial;
    await expect(
      authorizeAndRemoveSmsSuppression(row(), TENANT, runtime()),
    ).rejects.toBeInstanceOf(SmsSuppressionRemovalRefusedError);
    expect(initial.refreshSessionFromServer).toHaveBeenCalledTimes(1);
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("deletes only after authoritative identity and effective-admin equality", async () => {
    const initial = state("admin");
    harness.current = initial;
    await authorizeAndRemoveSmsSuppression(row(), TENANT, runtime());
    expect(initial.refreshSessionFromServer).toHaveBeenCalledTimes(1);
    expect(harness.request).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
    );
  });

  it("rejects an unbound or mismatched DELETE receipt", async () => {
    harness.request.mockResolvedValue({ ok: true });
    await expect(
      authorizeAndRemoveSmsSuppression(row(), TENANT, runtime()),
    ).rejects.toBeInstanceOf(SmsSuppressionRemovalOutcomeUnknownError);
    harness.request.mockResolvedValue({
      ok: true,
      tenantId: TENANT,
      id: "44444444-4444-4444-8444-444444444444",
    });
    await expect(
      authorizeAndRemoveSmsSuppression(row(), TENANT, runtime()),
    ).rejects.toBeInstanceOf(SmsSuppressionRemovalOutcomeUnknownError);
  });

  it("classifies transport and 5xx DELETE failures as outcome unknown", async () => {
    for (const error of [new Error("socket reset"), { status: 503 }]) {
      harness.request.mockRejectedValueOnce(error);
      await expect(
        authorizeAndRemoveSmsSuppression(row(), TENANT, runtime()),
      ).rejects.toMatchObject({
        code: "sms_suppression_outcome_unknown",
        message: expect.stringMatching(/refresh the exact row.*before retrying/iu),
      });
    }
  });

  it("keeps a typed 4xx DELETE rejection distinct from an unknown outcome", async () => {
    harness.request.mockRejectedValueOnce({ status: 409 });
    await expect(
      authorizeAndRemoveSmsSuppression(row(), TENANT, runtime()),
    ).rejects.toBeInstanceOf(SmsSuppressionRemovalRefusedError);
  });

  it("does not claim no effect when identity changes after an exact DELETE receipt", async () => {
    harness.request.mockImplementation(async (id) => {
      harness.current = state("viewer");
      return { ok: true, tenantId: TENANT, id };
    });
    await expect(
      authorizeAndRemoveSmsSuppression(row(), TENANT, runtime()),
    ).rejects.toThrow(/server confirmed removal.*original workspace/iu);
  });
});

describe("SMS suppression add authority", () => {
  function addRuntime(receipt: unknown): SmsSuppressionAddRuntime {
    return {
      isOnline: () => harness.online,
      readAuth: () => harness.current as never,
      addSuppression: vi.fn(async () => receipt),
    };
  }

  it("reauthorizes and validates the exact manual receipt", async () => {
    const runtime = addRuntime({
      id: "33333333-3333-4333-8333-333333333333",
      phone_e164: "+12025550101",
      reason: "manual",
      source: "manual",
      created_at: "2026-08-28T09:00:00Z",
      reversible: true,
    });
    await expect(
      authorizeAndAddSmsSuppression("+12025550101", TENANT, runtime),
    ).resolves.toMatchObject({ phone: "+12025550101", reversible: true });
    expect(runtime.addSuppression).toHaveBeenCalledWith("+12025550101");
  });

  it("refuses spoofed phones and mismatched receipts", async () => {
    await expect(
      authorizeAndAddSmsSuppression(
        "letters12025550101",
        TENANT,
        addRuntime({}),
      ),
    ).rejects.toBeInstanceOf(SmsSuppressionAddRefusedError);
    await expect(
      authorizeAndAddSmsSuppression(
        "+12025550101",
        TENANT,
        addRuntime({
          id: "33333333-3333-4333-8333-333333333333",
          phone_e164: "+12025550102",
          reason: "manual",
          source: "manual",
          created_at: "2026-08-28T09:00:00Z",
          reversible: true,
        }),
      ),
    ).rejects.toBeInstanceOf(SmsSuppressionAddOutcomeUnknownError);
  });

  it("classifies transport and 5xx POST failures as outcome unknown", async () => {
    for (const error of [new Error("socket reset"), { status: 502 }]) {
      const runtime = addRuntime({});
      runtime.addSuppression = vi.fn(async () => {
        throw error;
      });
      await expect(
        authorizeAndAddSmsSuppression("+12025550101", TENANT, runtime),
      ).rejects.toMatchObject({
        code: "sms_suppression_outcome_unknown",
        message: expect.stringMatching(/refresh the exact phone.*before retrying/iu),
      });
    }
  });

  it("keeps a typed 4xx POST rejection distinct from an unknown outcome", async () => {
    const runtime = addRuntime({});
    runtime.addSuppression = vi.fn(async () => {
      throw { status: 409 };
    });
    await expect(
      authorizeAndAddSmsSuppression("+12025550101", TENANT, runtime),
    ).rejects.toBeInstanceOf(SmsSuppressionAddRefusedError);
  });

  it("does not claim no effect when identity changes after an exact add receipt", async () => {
    const runtime = addRuntime({
      id: "33333333-3333-4333-8333-333333333333",
      phone_e164: "+12025550101",
      reason: "manual",
      source: "manual",
      created_at: "2026-08-28T09:00:00Z",
      reversible: true,
    });
    runtime.addSuppression = vi.fn(async (phone) => {
      harness.current = state("viewer");
      return {
        id: "33333333-3333-4333-8333-333333333333",
        phone_e164: phone,
        reason: "manual",
        source: "manual",
        created_at: "2026-08-28T09:00:00Z",
        reversible: true,
      };
    });
    await expect(
      authorizeAndAddSmsSuppression("+12025550101", TENANT, runtime),
    ).rejects.toThrow(/server confirmed the manual hold.*original workspace/iu);
  });
});
