import { renderHook, waitFor } from "@testing-library/react-native";
import { afterEach, describe, expect, it } from "@jest/globals";

import {
  useAddPushSuppression,
  usePushSuppressions,
  useRemovePushSuppression,
  type PushSuppressionAccess,
} from "@/hooks/usePushSuppressions";
import type { PushSuppressionRow } from "@/lib/pushSuppressions";

const {
  __getLastMutationOptionsForTests,
  __getQueryOptionsForTests,
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
const ID = "33333333-3333-4333-8333-333333333333";
const IDENTITY = {
  baseUrl: "https://api.moosewave.com",
  tenantId: TENANT,
  userId: "22222222-2222-4222-8222-222222222222",
  effectiveRole: "owner",
  mode: "session" as const,
  contextEpoch: null,
  fingerprint: "push-test-identity",
};

function access(
  over: Partial<PushSuppressionAccess> = {},
): PushSuppressionAccess {
  return {
    identity: IDENTITY,
    roleAllowed: true,
    canRequest: true,
    online: true,
    sessionReady: true,
    denialReason: null,
    ...over,
  };
}

const EMPTY_PAGE = {
  tenantId: TENANT,
  items: [],
  total: 0,
  snapshotAt: "2026-08-29T10:00:00Z",
};

const MANUAL: PushSuppressionRow = {
  id: ID,
  tenantId: TENANT,
  deviceTokenHash: "0123456789abcdef",
  platform: "apns",
  reason: "manual",
  source: "dashboard",
  createdAt: "2026-08-29T09:00:00Z",
  updatedAt: "2026-08-29T09:00:00Z",
  version: 4,
  reversible: true,
};

function lastInfiniteOptions() {
  const entry = __getQueryOptionsForTests()
    .filter((candidate: { kind: string }) => candidate.kind === "infinite")
    .at(-1);
  if (!entry) throw new Error("infinite query options were not registered");
  return entry.options;
}

function mutationOptions() {
  const options = __getLastMutationOptionsForTests();
  if (!options) throw new Error("mutation options were not registered");
  return options;
}

afterEach(() => {
  request.mockReset();
  __resetQueryResultForTests();
  __resetAuthStateForTests();
});

describe("Route43 mobile query boundary", () => {
  it("makes zero requests before the exact owner/admin boundary", async () => {
    const denied = access({
      roleAllowed: false,
      canRequest: false,
      denialReason: "denied",
    });
    const rendered = await renderHook(() => usePushSuppressions("all", denied));
    const options = lastInfiniteOptions();
    expect(options.enabled).toBe(false);
    await expect(
      options.queryFn({
        pageParam: undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/workspace or access changed/iu);
    expect(request).not.toHaveBeenCalled();
    await rendered.unmount();
  });

  it("tenant-decodes a bounded page and forwards cancellation", async () => {
    request.mockResolvedValue(EMPTY_PAGE);
    const rendered = await renderHook(() =>
      usePushSuppressions("all", access()),
    );
    const options = lastInfiniteOptions();
    const controller = new AbortController();
    await expect(
      options.queryFn({ pageParam: undefined, signal: controller.signal }),
    ).resolves.toEqual(EMPTY_PAGE);
    expect(request).toHaveBeenCalledWith("GET", "/api/v1/push/suppressions", {
      query: { limit: 100 },
      signal: controller.signal,
    });
    await rendered.unmount();
  });

  it("retires an older platform request before transport", async () => {
    const rendered = await renderHook(
      ({ platform }: { platform: string }) =>
        usePushSuppressions(platform, access()),
      { initialProps: { platform: "apns" } },
    );
    const oldOptions = lastInfiniteOptions();
    await rendered.rerender({ platform: "fcm" });
    await expect(
      oldOptions.queryFn({
        pageParam: undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/workspace or access changed/iu);
    expect(request).not.toHaveBeenCalled();
    await rendered.unmount();
  });
});

describe("Route43 versioned removal boundary", () => {
  it("sends expected_version and accepts only the identity-bound next-version receipt", async () => {
    request.mockResolvedValue({
      ok: true,
      tenantId: TENANT,
      id: ID,
      version: 5,
      stillSuppressed: true,
    });
    const rendered = await renderHook(() => useRemovePushSuppression(access()));
    await expect(mutationOptions().mutationFn(MANUAL)).resolves.toMatchObject({
      version: 5,
      stillSuppressed: true,
    });
    expect(request).toHaveBeenCalledWith(
      "DELETE",
      `/api/v1/push/suppressions/${ID}`,
      {
        body: { expected_version: 4 },
        signal: expect.anything(),
      },
    );
    await rendered.unmount();
  });

  it("refuses locked authority before transport", async () => {
    const rendered = await renderHook(() => useRemovePushSuppression(access()));
    await expect(
      mutationOptions().mutationFn({
        ...MANUAL,
        reason: "user_opt_out",
        source: "preference_center",
        reversible: false,
        lockedReason: "user_opt_out_authority",
      }),
    ).rejects.toThrow(/only a reversible manual dashboard authority/iu);
    expect(request).not.toHaveBeenCalled();
    await rendered.unmount();
  });

  it("keeps the write single-flight while the first receipt is pending", async () => {
    let resolveRequest!: (value: unknown) => void;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const rendered = await renderHook(() => useRemovePushSuppression(access()));
    const first = mutationOptions().mutationFn(MANUAL);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await expect(mutationOptions().mutationFn(MANUAL)).rejects.toThrow(
      /already in progress/iu,
    );
    resolveRequest({
      ok: true,
      tenantId: TENANT,
      id: ID,
      version: 5,
      stillSuppressed: false,
    });
    await expect(first).resolves.toMatchObject({ stillSuppressed: false });
    await rendered.unmount();
  });

  it("does not adopt a confirmed receipt after an identity transition", async () => {
    request.mockImplementation(async () => {
      __setAuthStateForTests({
        tenantId: "44444444-4444-4444-8444-444444444444",
        session: { tenantId: "44444444-4444-4444-8444-444444444444" },
      });
      return {
        ok: true,
        tenantId: TENANT,
        id: ID,
        version: 5,
        stillSuppressed: false,
      };
    });
    const rendered = await renderHook(() => useRemovePushSuppression(access()));
    await expect(mutationOptions().mutationFn(MANUAL)).rejects.toThrow(
      /server confirmed.*workspace identity changed/iu,
    );
    await rendered.unmount();
  });
});

describe("Route43 manual add boundary", () => {
  const TOKEN = "d".repeat(64);
  const ADD_ROW = {
    id: "55555555-5555-4555-8555-555555555555",
    tenant_id: TENANT,
    device_token_hash: "fedcba9876543210",
    platform: "apns",
    reason: "manual",
    source: "dashboard",
    created_at: "2026-08-29T09:00:00Z",
    updated_at: "2026-08-29T09:00:00Z",
    version: 1,
    reversible: true,
  };

  it("POSTs the pinned body and accepts only a verified own-tenant manual row", async () => {
    request.mockResolvedValue(ADD_ROW);
    const rendered = await renderHook(() => useAddPushSuppression(access()));
    await expect(
      mutationOptions().mutationFn({ deviceToken: TOKEN, platform: "apns" }),
    ).resolves.toMatchObject({
      tenantId: TENANT,
      platform: "apns",
      version: 1,
    });
    expect(request).toHaveBeenCalledWith("POST", "/api/v1/push/suppressions", {
      body: { device_token: TOKEN, platform: "apns", reason: "manual" },
    });
    await rendered.unmount();
  });

  it("refuses an invalid token before transport", async () => {
    const rendered = await renderHook(() => useAddPushSuppression(access()));
    await expect(
      mutationOptions().mutationFn({ deviceToken: "short", platform: "apns" }),
    ).rejects.toThrow(/20–4096 bytes/u);
    expect(request).not.toHaveBeenCalled();
    await rendered.unmount();
  });

  it("refuses a receipt that is not this tenant's own manual authority", async () => {
    request.mockResolvedValue({
      ...ADD_ROW,
      tenant_id: "44444444-4444-4444-8444-444444444444",
    });
    const rendered = await renderHook(() => useAddPushSuppression(access()));
    await expect(
      mutationOptions().mutationFn({ deviceToken: TOKEN, platform: "apns" }),
    ).rejects.toThrow(/could not be verified/u);
    await rendered.unmount();
  });

  it("keeps a 4xx sentence and turns transport loss into outcome-unknown", async () => {
    const rendered = await renderHook(() => useAddPushSuppression(access()));
    request.mockRejectedValue(
      Object.assign(new Error("platform must be one of apns, fcm, web"), {
        status: 422,
      }),
    );
    await expect(
      mutationOptions().mutationFn({ deviceToken: TOKEN, platform: "apns" }),
    ).rejects.toThrow(/platform must be one of/u);
    request.mockRejectedValue(new Error("socket hang up"));
    await expect(
      mutationOptions().mutationFn({ deviceToken: TOKEN, platform: "apns" }),
    ).rejects.toThrow(/outcome unknown/iu);
    await rendered.unmount();
  });
});
