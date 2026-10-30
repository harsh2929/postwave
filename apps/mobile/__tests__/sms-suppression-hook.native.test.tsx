import { renderHook, waitFor } from "@testing-library/react-native";
import { afterEach, describe, expect, it } from "@jest/globals";

import type { SmsInboxAccess } from "@/hooks/useSmsInbox";
import { useSmsSuppressions } from "@/hooks/useSuppressionOps";

const {
  __getQueryClientForTests,
  __getQueryOptionsForTests,
  __resetQueryResultForTests,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./mocks/reactQuery.cjs");
const {
  request,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./mocks/apiRuntime.cjs");

const IDENTITY = {
  baseUrl: "https://api.moosewave.com",
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  effectiveRole: "owner",
  mode: "session" as const,
  contextEpoch: null,
  fingerprint: "sms-test-identity",
};

function access(overrides: Partial<SmsInboxAccess> = {}): SmsInboxAccess {
  return {
    identity: IDENTITY,
    roleAllowed: true,
    canRequest: true,
    online: true,
    sessionReady: true,
    denialReason: null,
    ...overrides,
  };
}

function lastInfiniteOptions() {
  const entry = __getQueryOptionsForTests()
    .filter((candidate: { kind: string }) => candidate.kind === "infinite")
    .at(-1);
  if (!entry) throw new Error("infinite query options were not registered");
  return entry.options;
}

const EMPTY_PAGE = {
  tenantId: IDENTITY.tenantId,
  items: [],
  total: 0,
  snapshotAt: "2026-08-21T11:00:00Z",
};

describe("SMS suppression query boundary", () => {
  afterEach(() => {
    __resetQueryResultForTests();
    request.mockReset();
  });

  it("makes zero requests before the exact owner/admin boundary", async () => {
    const rendered = await renderHook(() =>
      useSmsSuppressions(
        access({
          roleAllowed: false,
          canRequest: false,
          denialReason: "denied",
        }),
      ),
    );
    const options = lastInfiniteOptions();

    expect(options.enabled).toBe(false);
    await expect(
      options.queryFn({
        pageParam: undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/identity is unavailable/u);
    expect(request).not.toHaveBeenCalled();
    await rendered.unmount();
  });

  it("keeps exact phone out of the URL and binds it in the POST body", async () => {
    request.mockResolvedValue(EMPTY_PAGE);
    const rendered = await renderHook(() =>
      useSmsSuppressions(access(), "+14155550123"),
    );
    const options = lastInfiniteOptions();
    const controller = new AbortController();

    await options.queryFn({
      pageParam: undefined,
      signal: controller.signal,
    });

    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/v1/sms/suppressions/query",
      {
        body: {
          phone: "+14155550123",
        },
        idempotencyKey: null,
        signal: controller.signal,
      },
    );
    await rendered.unmount();
  });

  it("uses GET only for the unfiltered roster", async () => {
    request.mockResolvedValue(EMPTY_PAGE);
    const rendered = await renderHook(() => useSmsSuppressions(access()));
    const options = lastInfiniteOptions();
    const controller = new AbortController();

    await options.queryFn({
      pageParam: undefined,
      signal: controller.signal,
    });

    expect(request).toHaveBeenCalledWith("GET", "/api/v1/sms/suppressions", {
      query: { limit: 100 },
      signal: controller.signal,
    });
    await rendered.unmount();
  });

  it("aborts and retires the protected cache on demotion", async () => {
    const client = __getQueryClientForTests();
    const rendered = await renderHook(
      ({ currentAccess }: { currentAccess: SmsInboxAccess }) =>
        useSmsSuppressions(currentAccess),
      { initialProps: { currentAccess: access() } },
    );

    await rendered.rerender({
      currentAccess: access({ roleAllowed: false, canRequest: false }),
    });

    await waitFor(() => {
      expect(client.cancelQueries).toHaveBeenCalledWith({
        queryKey: ["sms-suppressions-v2"],
      });
      expect(client.removeQueries).toHaveBeenCalledWith({
        queryKey: ["sms-suppressions-v2"],
      });
    });
    await rendered.unmount();
  });
});
