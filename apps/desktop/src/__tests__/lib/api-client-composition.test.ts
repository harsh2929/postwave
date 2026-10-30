import { describe, expect, it } from "vitest";

import {
  api,
  apiAuth,
  apiInlineAi,
  apiMonetization,
  apiSendTimeAssets,
  suppressionsApi,
} from "../../lib/api-client";

describe("API facade composition", () => {
  it("exports one shared facade identity through compatibility names", () => {
    expect(apiAuth).toBe(api);
    expect(apiInlineAi).toBe(api);
    expect(apiMonetization).toBe(api);
    expect(apiSendTimeAssets).toBe(api);
  });

  it("includes representative methods from every composed domain bag", () => {
    expect(api).toMatchObject({
      health: expect.any(Function),
      getBestSendTime: expect.any(Function),
      listDiscounts: expect.any(Function),
      login: expect.any(Function),
      predictInboxPlacement: expect.any(Function),
      privacyPortal: { get: expect.any(Function) },
      listArchiveComments: expect.any(Function),
      getAuditCount: expect.any(Function),
    });
    expect(suppressionsApi).toMatchObject({
      bulkAction: expect.any(Function),
    });
  });
});
