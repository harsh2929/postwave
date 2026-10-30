// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  analyticsSurfaceApi,
  marketingSurfaceApi,
} from "@/lib/integrations-surface-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("integration surface route capabilities", () => {
  it("does not expose unmounted generic webhook-ingest operations on marketing", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(marketingSurfaceApi.ingestProviders).toBeUndefined();
    expect(marketingSurfaceApi.ingestEndpoints).toBeUndefined();
    expect(marketingSurfaceApi.provisionIngest).toBeUndefined();
    expect(marketingSurfaceApi.rotateIngest).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retains webhook-ingest operations on a surface that mounts them", () => {
    expect(analyticsSurfaceApi.ingestProviders).toBeTypeOf("function");
    expect(analyticsSurfaceApi.ingestEndpoints).toBeTypeOf("function");
    expect(analyticsSurfaceApi.provisionIngest).toBeTypeOf("function");
    expect(analyticsSurfaceApi.rotateIngest).toBeTypeOf("function");
  });
});
