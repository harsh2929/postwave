import { renderHook } from "@testing-library/react-native";
import { afterEach, describe, expect, it, jest } from "@jest/globals";

import type { SmsInboxAccess } from "@/hooks/useSmsInbox";
import { useSetQuietHoursEnabled } from "@/hooks/useSmsPolicies";
import type { SmsQuietHoursRule } from "@/lib/smsPolicies";

const {
  __getLastMutationOptionsForTests,
  __resetQueryResultForTests,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./mocks/reactQuery.cjs");
const {
  request,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./mocks/apiRuntime.cjs");
const {
  __resetAuthStateForTests,
  __setAuthStateForTests,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./mocks/authStore.cjs");

const TENANT = "11111111-1111-4111-8111-111111111111";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UPDATED = "2026-08-21T09:00:00Z";
const IDENTITY = {
  baseUrl: "https://api.moosewave.com",
  tenantId: TENANT,
  userId: "22222222-2222-4222-8222-222222222222",
  effectiveRole: "owner",
  mode: "session" as const,
  contextEpoch: null,
  fingerprint: "policy-test-identity",
};

const ACCESS: SmsInboxAccess = {
  identity: IDENTITY,
  roleAllowed: true,
  canRequest: true,
  online: true,
  sessionReady: true,
  denialReason: null,
};

function rule(
  countryCode: "" | "US" | "CA",
  enabled: boolean,
): SmsQuietHoursRule {
  return {
    id: ID,
    label: "Historical window",
    countryCode,
    startMinute: 21 * 60,
    endMinute: 9 * 60,
    days: [0, 1, 2, 3, 4, 5, 6],
    timezone: "UTC",
    enabled,
    createdAt: UPDATED,
    updatedAt: UPDATED,
  };
}

function wire(countryCode: "" | "US" | "CA", enabled: boolean) {
  return {
    id: ID,
    tenant_id: TENANT,
    label: "Historical window",
    country_code: countryCode,
    start_minute: 21 * 60,
    end_minute: 9 * 60,
    start_local: "21:00",
    end_local: "09:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    timezone: "UTC",
    enabled,
    created_at: UPDATED,
    updated_at: "2026-08-21T09:01:00Z",
  };
}

function mutationOptions() {
  const options = __getLastMutationOptionsForTests();
  if (!options) throw new Error("mutation options were not registered");
  return options;
}

describe("SMS quiet-hours mutation boundary", () => {
  afterEach(() => {
    request.mockReset();
    __resetQueryResultForTests();
    __resetAuthStateForTests();
  });

  it("atomically disables an enabled historical country row and retires its scope", async () => {
    request.mockResolvedValue(wire("", false));
    const rendered = await renderHook(() => useSetQuietHoursEnabled(ACCESS));
    const controllerMatcher = expect.anything();

    await expect(
      mutationOptions().mutationFn({ rule: rule("US", true), enabled: false }),
    ).resolves.toEqual(
      expect.objectContaining({ enabled: false, countryCode: "" }),
    );
    expect(request).toHaveBeenCalledWith(
      "PATCH",
      `/api/v1/sms/quiet-hours/${ID}`,
      {
        body: {
          enabled: false,
          country_code: "",
          expected_updated_at: UPDATED,
        },
        signal: controllerMatcher,
      },
    );
    await rendered.unmount();
  });

  it("blocks enabling an uncleared historical country row before any request", async () => {
    const rendered = await renderHook(() => useSetQuietHoursEnabled(ACCESS));

    await expect(
      mutationOptions().mutationFn({ rule: rule("CA", false), enabled: true }),
    ).rejects.toMatchObject({
      code: "country_scope_release_held",
      status: 422,
    });
    expect(request).not.toHaveBeenCalled();
    await rendered.unmount();
  });

  it("reports a server-confirmed policy change when identity changes after the receipt", async () => {
    request.mockImplementation(async () => {
      __setAuthStateForTests({
        tenantId: "33333333-3333-4333-8333-333333333333",
        session: { tenantId: "33333333-3333-4333-8333-333333333333" },
      });
      return wire("", false);
    });
    const rendered = await renderHook(() => useSetQuietHoursEnabled(ACCESS));

    await expect(
      mutationOptions().mutationFn({ rule: rule("", true), enabled: false }),
    ).rejects.toMatchObject({
      code: "sms_policy_receipt_confirmed_identity_changed",
      message: expect.stringMatching(
        /server confirmed.*before.*identity changed/iu,
      ),
    });
    expect(request).toHaveBeenCalledTimes(1);
    await rendered.unmount();
  });

  it("treats a transport failure after dispatch as outcome unknown", async () => {
    request.mockRejectedValue(
      Object.assign(new Error("proxy secret"), { status: 503 }),
    );
    const rendered = await renderHook(() => useSetQuietHoursEnabled(ACCESS));

    await expect(
      mutationOptions().mutationFn({ rule: rule("", true), enabled: false }),
    ).rejects.toMatchObject({
      code: "sms_policy_outcome_unknown",
      message: expect.stringMatching(/reload the original workspace/iu),
    });
    await rendered.unmount();
  });
});
