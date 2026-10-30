import { afterEach, describe, expect, it, vi } from "vitest";

import { createSegmentInsightsApi } from "../../lib/api/segment-insights";
import type { ApiResult } from "../../lib/api/result";

type SegmentRequester = Parameters<typeof createSegmentInsightsApi>[0];
type SegmentRequestOptions = Parameters<SegmentRequester>[2];
type SegmentDependencies = Parameters<typeof createSegmentInsightsApi>[1];

function unusedRequester(): {
  paths: string[];
  request: SegmentRequester;
} {
  const paths: string[] = [];
  const request: SegmentRequester = async <T>(
    path: string,
    _init?: RequestInit,
    _opts?: SegmentRequestOptions,
  ): Promise<ApiResult<T>> => {
    paths.push(path);
    return { data: {} as T };
  };
  return { paths, request };
}

function downloadHarness(
  nativeFetchImplementation: () => Promise<Response>,
  apiKey: string | null = "desktop-secret",
) {
  const controller = new AbortController();
  const dispose = vi.fn();
  const apiUrl = vi.fn((path: string) => `https://api.example.test${path}`);
  const createDownloadController = vi.fn((_signal?: AbortSignal | null) => ({
    signal: controller.signal,
    dispose,
  }));
  const errorFromResponse = vi.fn(async (_response: Response) => ({
    kind: "http" as const,
    status: 403,
    code: "forbidden",
    message: "Forbidden",
  }));
  const getApiKey = vi.fn(() => apiKey);
  const nativeFetch = vi.fn(nativeFetchImplementation);
  const normalizeApiKey = vi.fn((key: string | null | undefined) =>
    key ? `pw_${key}` : null,
  );
  const transportError = vi.fn((_error: unknown) => ({
    kind: "network" as const,
    code: "network_error",
    message: "Network error",
  }));
  const dependencies: SegmentDependencies = {
    apiUrl,
    createDownloadController,
    errorFromResponse,
    getApiKey,
    nativeFetch,
    normalizeApiKey,
    transportError,
  };
  return {
    apiUrl,
    controller,
    createDownloadController,
    dependencies,
    dispose,
    errorFromResponse,
    getApiKey,
    nativeFetch,
    normalizeApiKey,
    transportError,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSegmentInsightsApi CSV transport", () => {
  it("preserves encoded download URL, native credentials, filename, and disposal", async () => {
    const response = new Response("date,count\n2026-07-15,42\n", {
      status: 200,
      headers: {
        "Content-Disposition": 'attachment; filename="growth-report.csv"',
        "Content-Type": "text/csv",
      },
    });
    const harness = downloadHarness(async () => response);
    const { paths, request } = unusedRequester();
    const api = createSegmentInsightsApi(request, harness.dependencies);
    const callerSignal = new AbortController().signal;

    const result = await api.growthReportCSV("segment/one", {
      days: 30,
      signal: callerSignal,
    });

    expect(paths).toEqual([]);
    expect(harness.createDownloadController).toHaveBeenCalledWith(callerSignal);
    expect(harness.apiUrl).toHaveBeenCalledWith(
      "/api/v1/segments/segment%2Fone/growth/report.csv?days=30",
    );
    expect(harness.getApiKey).toHaveBeenCalledTimes(1);
    expect(harness.normalizeApiKey).toHaveBeenCalledWith("desktop-secret");
    expect(harness.nativeFetch).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/segments/segment%2Fone/growth/report.csv?days=30",
      {
        method: "GET",
        headers: {
          Accept: "text/csv",
          Authorization: "Bearer pw_desktop-secret",
        },
        mode: "cors",
        credentials: "include",
        cache: "no-store",
        signal: harness.controller.signal,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.filename).toBe("growth-report.csv");
    expect(await result.data?.blob.text()).toBe("date,count\n2026-07-15,42\n");
    expect(harness.dispose).toHaveBeenCalledTimes(1);
  });

  it("preserves the dated fallback filename and omits absent authorization", async () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(
      "2026-07-15T12:00:00.000Z",
    );
    const harness = downloadHarness(
      async () => new Response("date,count\n", { status: 200 }),
      null,
    );
    const { request } = unusedRequester();
    const api = createSegmentInsightsApi(request, harness.dependencies);

    const result = await api.growthReportCSV("segment/one");

    expect(result.data?.filename).toBe("segment-growth-report-2026-07-15.csv");
    expect(harness.nativeFetch).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/segments/segment%2Fone/growth/report.csv",
      expect.objectContaining({ headers: { Accept: "text/csv" } }),
    );
    expect(harness.dispose).toHaveBeenCalledTimes(1);
  });

  it("delegates HTTP response parsing and still disposes the controller", async () => {
    const forbidden = new Response("forbidden", { status: 403 });
    const harness = downloadHarness(async () => forbidden);
    const { request } = unusedRequester();
    const api = createSegmentInsightsApi(request, harness.dependencies);

    const result = await api.growthReportCSV("segment/one");

    expect(harness.errorFromResponse).toHaveBeenCalledWith(forbidden);
    expect(result).toEqual({
      error: {
        kind: "http",
        status: 403,
        code: "forbidden",
        message: "Forbidden",
      },
    });
    expect(harness.transportError).not.toHaveBeenCalled();
    expect(harness.dispose).toHaveBeenCalledTimes(1);
  });

  it("normalizes thrown download failures and still disposes the controller", async () => {
    const failure = new Error("connection reset");
    const harness = downloadHarness(async () => Promise.reject(failure));
    const { request } = unusedRequester();
    const api = createSegmentInsightsApi(request, harness.dependencies);

    const result = await api.growthReportCSV("segment/one");

    expect(harness.transportError).toHaveBeenCalledWith(failure);
    expect(result).toEqual({
      error: {
        kind: "network",
        code: "network_error",
        message: "Network error",
      },
    });
    expect(harness.errorFromResponse).not.toHaveBeenCalled();
    expect(harness.dispose).toHaveBeenCalledTimes(1);
  });
});
