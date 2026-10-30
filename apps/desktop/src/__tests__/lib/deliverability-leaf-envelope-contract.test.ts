import { describe, expect, it } from "vitest";

import { createBotOpensApi } from "../../lib/api/bot-opens";
import { createDeliverabilityControlApi } from "../../lib/api/deliverability-control";
import { createDomainWarmupApi } from "../../lib/api/domain-warmup";
import type { ApiRequester, ApiResult } from "../../lib/api/result";

function requesterWith(value: unknown): ApiRequester {
  return async <T>(): Promise<ApiResult<T>> =>
    ({ data: value }) as ApiResult<T>;
}

describe("deliverability leaf API envelopes", () => {
  it("does not normalize a missing warmup plans array into a false empty", async () => {
    const api = createDomainWarmupApi(requesterWith({ populated: true }));
    const response = await api.list();
    expect(response.error).toBeUndefined();
    expect(response.data).toBeUndefined();
  });

  it("does not normalize missing bot signatures into a false empty", async () => {
    const api = createBotOpensApi(requesterWith({ populated: true }));
    const response = await api.listSignatures();
    expect(response.error).toBeUndefined();
    expect(response.data).toBeUndefined();
  });

  it("does not normalize missing deliverability-control items into a false empty", async () => {
    const api = createDeliverabilityControlApi(
      requesterWith({ populated: true }),
    );
    const response = await api.listDomainSetups();
    expect(response.error).toBeUndefined();
    expect(response.data).toBeUndefined();
  });

  it("still preserves genuine empty arrays", async () => {
    const warmup = createDomainWarmupApi(requesterWith({ plans: [] }));
    const botOpens = createBotOpensApi(requesterWith({ signatures: [] }));
    const control = createDeliverabilityControlApi(
      requesterWith({ items: [] }),
    );
    await expect(warmup.list()).resolves.toEqual({ data: [] });
    await expect(botOpens.listSignatures()).resolves.toEqual({ data: [] });
    await expect(control.listDomainSetups()).resolves.toEqual({ data: [] });
  });
});
