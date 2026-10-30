import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestPlan } from "../components/playground/PlaygroundCodeGen";
import type { PlaygroundExecutionPolicy } from "../pages/api-playground-policy";

type IdentityFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<IdentityFetch>(),
  getApiKey: vi.fn<() => string | null>(),
  nextClientEventSeq: vi.fn<() => number>(),
  observeContextEpoch: vi.fn<(epoch: string | null | undefined) => boolean>(),
}));

vi.mock("../lib/api-identity-native-fetch", () => ({
  apiIdentityAwareNativeFetch: mocks.fetch,
}));

vi.mock("../lib/api-client", () => ({
  NATIVE_CLIENT_HEADERS: {
    "X-Postwave-Client": "desktop",
    "X-Postwave-Version": "route44-test",
  },
  getApiKey: mocks.getApiKey,
  nextClientEventSeq: mocks.nextClientEventSeq,
}));

vi.mock("../lib/context-epoch", () => ({
  CONTEXT_EPOCH_HEADER: "x-postwave-context-epoch",
  observeContextEpoch: mocks.observeContextEpoch,
}));

import {
  PLAYGROUND_CATALOG_MAX_BYTES,
  PLAYGROUND_PREVIEW_MAX_BYTES,
  PLAYGROUND_REQUEST_TIMEOUT_MS,
  executePlaygroundRequest,
  loadPlaygroundCatalogDocument,
  playgroundApiCredentialFingerprintSuffix,
  playgroundHasApiCredentialFor,
} from "../pages/api-playground-transport";

const REVIEWED_CONTRACT_FINGERPRINTS: Record<string, string> = {
  "GET /api/v1/tags": "1193:b404302def9af8f2",
  "POST /api/v1/tags": "1681:85f1ec4398f9ec5d",
  "DELETE /api/v1/tags/{id}": "994:97c063ae36746f64",
};

function executablePolicy(
  overrides: Partial<PlaygroundExecutionPolicy> = {},
): PlaygroundExecutionPolicy {
  const operationKey = overrides.operationKey ?? "GET /api/v1/tags";
  return {
    operationKey,
    method: "get",
    pathTemplate: "/api/v1/tags",
    executable: true,
    effect: "read",
    contractFingerprint:
      REVIEWED_CONTRACT_FINGERPRINTS[operationKey] ?? "unreviewed",
    authMode: "workspace",
    requiredRole: "viewer",
    idempotency: "none",
    responseKind: "json",
    responseMediaTypesByStatus: {
      "200": ["application/json"],
      "502": ["application/json"],
      "503": ["application/json"],
    },
    ...overrides,
  };
}

function requestPlan(overrides: Partial<RequestPlan> = {}): RequestPlan {
  return {
    method: "get",
    url: "https://api.postwave.test/api/v1/tags",
    headers: {},
    body: "",
    bodyIsJSON: false,
    authMode: "workspace",
    snippetAllowed: true,
    ...overrides,
  };
}

function installAbortablePendingFetch(): void {
  mocks.fetch.mockImplementation(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = (): void =>
          reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener("abort", rejectAbort, { once: true });
      }),
  );
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.getApiKey.mockReset().mockReturnValue("browser-test-secret");
  mocks.nextClientEventSeq.mockReset().mockReturnValue(44);
  mocks.observeContextEpoch.mockReset().mockReturnValue(false);
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void, delay?: number) =>
      globalThis.setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) =>
      globalThis.clearTimeout(timer),
  });
});

describe("playground credential binding", () => {
  it("detects and fingerprints the exact browser API credential", async () => {
    expect(playgroundHasApiCredentialFor("https://api.postwave.test")).toBe(
      true,
    );
    const suffix = await playgroundApiCredentialFingerprintSuffix(
      "https://api.postwave.test",
    );
    expect(suffix).toMatch(/^[0-9a-f]{8}$/u);

    mocks.getApiKey.mockReturnValue(null);
    expect(playgroundHasApiCredentialFor("https://api.postwave.test")).toBe(
      false,
    );
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API Playground catalog transport", () => {
  it("accepts the real generated artifact between 4 MiB and the 8 MiB cap", async () => {
    const body = readFileSync(
      new URL("../../../../packages/openapi/openapi.json", import.meta.url),
      "utf8",
    );
    const bytes = new TextEncoder().encode(body).byteLength;
    expect(bytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(bytes).toBeLessThanOrEqual(PLAYGROUND_CATALOG_MAX_BYTES);
    mocks.fetch.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(bytes),
        },
      }),
    );

    const document = (await loadPlaygroundCatalogDocument(
      "https://api.postwave.test/tenant-edge/",
    )) as { openapi?: string };

    expect(document.openapi).toBe("3.1.0");
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.postwave.test/tenant-edge/api/v1/openapi.json",
    );
    expect(init?.headers).toEqual({
      Accept: "application/json",
      "X-Postwave-Client": "desktop",
      "X-Postwave-Version": "route44-test",
      Authorization: "Bearer pw_browser-test-secret",
    });
    expect(init?.redirect).toBe("error");
  });

  it("rejects a catalog body above the 8 MiB safety ceiling", async () => {
    mocks.fetch.mockResolvedValue(
      new Response("x".repeat(PLAYGROUND_CATALOG_MAX_BYTES + 1), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      loadPlaygroundCatalogDocument("https://api.postwave.test"),
    ).rejects.toThrow(
      `Catalog exceeds the ${PLAYGROUND_CATALOG_MAX_BYTES}-byte safety ceiling.`,
    );
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("rejects an oversized declared catalog without reading its stream", async () => {
    let pulled = false;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    mocks.fetch.mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(PLAYGROUND_CATALOG_MAX_BYTES + 1),
        },
      }),
    );

    await expect(
      loadPlaygroundCatalogDocument("https://api.postwave.test"),
    ).rejects.toThrow(
      `Catalog exceeds the ${PLAYGROUND_CATALOG_MAX_BYTES}-byte safety ceiling.`,
    );
    expect(pulled).toBe(false);
    expect(cancelled).toBe(true);
  });

  it.each(["text/html", "text/notjson", "application/notjson"])(
    "rejects unsupported catalog media %s before parsing",
    async (contentType) => {
      mocks.fetch.mockResolvedValue(
        new Response("<html>not a contract</html>", {
          status: 200,
          headers: { "Content-Type": contentType },
        }),
      );

      await expect(
        loadPlaygroundCatalogDocument("https://api.postwave.test"),
      ).rejects.toThrow(
        `Catalog returned unsupported content type “${contentType}”.`,
      );
    },
  );

  it("rejects malformed JSON even when its media type claims JSON", async () => {
    mocks.fetch.mockResolvedValue(
      new Response('{"openapi":', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      loadPlaygroundCatalogDocument("https://api.postwave.test"),
    ).rejects.toThrow("Catalog response is not valid JSON.");
  });

  it("does not render raw native catalog transport diagnostics", async () => {
    mocks.fetch.mockRejectedValue(
      new Error(
        "failed https://api.postwave.test/api/v1/openapi.json token=pw_secret",
      ),
    );

    const result = loadPlaygroundCatalogDocument("https://api.postwave.test");
    await expect(result).rejects.toThrow(
      "Native transport diagnostics are not rendered",
    );
    await expect(result).rejects.not.toThrow("pw_secret");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});

describe("API Playground execution transport", () => {
  it("classifies caller cancellation without retrying", async () => {
    installAbortablePendingFetch();
    const controller = new AbortController();

    const pending = executePlaygroundRequest(
      "https://api.postwave.test",
      requestPlan(),
      executablePolicy(),
      controller.signal,
    );
    controller.abort("operator-cancelled");

    await expect(pending).resolves.toMatchObject({
      status: 0,
      statusText: "Cancelled",
      outcome: "aborted",
      ambiguous: false,
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("classifies the 20-second read boundary as safely retryable without retrying automatically", async () => {
    vi.useFakeTimers();
    installAbortablePendingFetch();

    const pending = executePlaygroundRequest(
      "https://api.postwave.test",
      requestPlan(),
      executablePolicy(),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(PLAYGROUND_REQUEST_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({
      status: 0,
      statusText: "Timed out",
      outcome: "timeout",
      ambiguous: false,
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("truncates previews at exactly 2 MiB", async () => {
    const responseBytes = PLAYGROUND_PREVIEW_MAX_BYTES + 17;
    mocks.fetch.mockResolvedValue(
      new Response("x".repeat(responseBytes), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(responseBytes),
        },
      }),
    );

    const result = await executePlaygroundRequest(
      "https://api.postwave.test",
      requestPlan(),
      executablePolicy(),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: 200,
      previewBytes: PLAYGROUND_PREVIEW_MAX_BYTES,
      contentLength: responseBytes,
      truncated: true,
      outcome: "http",
      ambiguous: false,
    });
    expect(result.body).toHaveLength(PLAYGROUND_PREVIEW_MAX_BYTES);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("sends exact protected headers once and classifies a 5xx as ambiguous", async () => {
    mocks.fetch.mockResolvedValue(
      new Response('{"error":"uncertain"}', {
        status: 503,
        statusText: "Service Unavailable",
        headers: {
          "Content-Type": "application/json",
          "X-Postwave-Context-Epoch": "epoch-44",
        },
      }),
    );
    const plan = requestPlan({
      method: "post",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "idem-route44",
      },
      body: '{"name":"release"}',
      bodyIsJSON: true,
    });

    const result = await executePlaygroundRequest(
      "https://api.postwave.test",
      plan,
      executablePolicy({
        operationKey: "POST /api/v1/tags",
        method: "post",
        effect: "effectful",
        idempotency: "required",
      }),
      new AbortController().signal,
    );

    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(String(url)).toBe(plan.url);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      body: plan.body,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({
      Accept: "application/json",
      "X-Postwave-Client": "desktop",
      "X-Postwave-Version": "route44-test",
      "Content-Type": "application/json",
      "Idempotency-Key": "idem-route44",
      "X-Request-Id": expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      "X-Postwave-Event-Seq": "44",
      Authorization: "Bearer pw_browser-test-secret",
    });
    expect(mocks.nextClientEventSeq).toHaveBeenCalledOnce();
    expect(mocks.observeContextEpoch).toHaveBeenCalledWith("epoch-44");
    expect(result).toMatchObject({
      status: 503,
      statusText: "Service Unavailable",
      outcome: "http",
      ambiguous: true,
    });
    expect(result.requestId).toBe(
      (init?.headers as Record<string, string>)["X-Request-Id"],
    );
  });

  it("blocks same-origin method and route substitution before fetch", async () => {
    const signal = new AbortController().signal;

    await expect(
      executePlaygroundRequest(
        "https://api.postwave.test",
        requestPlan({ url: "https://api.postwave.test/api/v1/accounts" }),
        executablePolicy(),
        signal,
      ),
    ).resolves.toMatchObject({ outcome: "contract", status: 0 });
    await expect(
      executePlaygroundRequest(
        "https://api.postwave.test",
        requestPlan({ method: "delete" }),
        executablePolicy(),
        signal,
      ),
    ).resolves.toMatchObject({ outcome: "contract", status: 0 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["custom:api", "custom:api/api/v1/tags"],
    [
      "https://user:password@api.postwave.test",
      "https://api.postwave.test/api/v1/tags",
    ],
  ])(
    "blocks non-HTTP or credentialed authority %s before fetch",
    async (baseURL, url) => {
      await expect(
        executePlaygroundRequest(
          baseURL,
          requestPlan({ url }),
          executablePolicy(),
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ outcome: "contract", status: 0 });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it("rechecks body and protected headers at the transport boundary", async () => {
    const signal = new AbortController().signal;
    await expect(
      executePlaygroundRequest(
        "https://api.postwave.test",
        requestPlan({ body: "x".repeat(256 * 1024 + 1) }),
        executablePolicy(),
        signal,
      ),
    ).resolves.toMatchObject({
      outcome: "contract",
      body: expect.stringContaining("safe body boundary"),
    });
    await expect(
      executePlaygroundRequest(
        "https://api.postwave.test",
        requestPlan({ headers: { Authorization: "stale-secret" } }),
        executablePolicy(),
        signal,
      ),
    ).resolves.toMatchObject({
      outcome: "contract",
      body: expect.stringContaining("protected transport boundary"),
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rechecks aggregate native header bytes at the transport boundary", async () => {
    const value = "x".repeat(8 * 1024);
    const result = await executePlaygroundRequest(
      "https://api.postwave.test",
      requestPlan({
        headers: {
          Accept: value,
          "Content-Type": value,
          "Idempotency-Key": value,
          "If-Match": value,
        },
      }),
      executablePolicy(),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      outcome: "contract",
      body: expect.stringContaining("protected native transport boundary"),
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("withholds an unexpected response media type without consuming its body", async () => {
    mocks.fetch.mockResolvedValue(
      new Response("<html>upstream error</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
    );

    await expect(
      executePlaygroundRequest(
        "https://api.postwave.test",
        requestPlan(),
        executablePolicy(),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      status: 502,
      statusText: "Unexpected response media",
      body: expect.stringContaining("instead of declared JSON media"),
      previewBytes: 0,
      outcome: "contract",
      ambiguous: false,
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("withholds a JSON body for an undocumented response status", async () => {
    mocks.fetch.mockResolvedValue(
      new Response('{"error":"not in contract"}', {
        status: 418,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      executePlaygroundRequest(
        "https://api.postwave.test",
        requestPlan(),
        executablePolicy(),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      status: 418,
      outcome: "contract",
      previewBytes: 0,
      body: expect.stringContaining("status 418 is not declared"),
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("classifies an untruncated malformed declared JSON response as a contract failure", async () => {
    mocks.fetch.mockResolvedValue(
      new Response('{"private":', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await executePlaygroundRequest(
      "https://api.postwave.test",
      requestPlan(),
      executablePolicy(),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: 200,
      statusText: "Invalid JSON response",
      outcome: "contract",
      ambiguous: false,
      previewBytes: 0,
      body: expect.stringContaining("invalid JSON"),
    });
    expect(result.body).not.toContain("private");
  });

  it.each([
    {
      label: "effectful invalid JSON",
      response: () =>
        new Response('{"created":', {
          status: 201,
          statusText: "Created",
          headers: { "Content-Type": "application/json" },
        }),
      plan: requestPlan({ method: "post" }),
      policy: executablePolicy({
        operationKey: "POST /api/v1/tags",
        method: "post",
        effect: "effectful",
        responseMediaTypesByStatus: { "201": ["application/json"] },
      }),
      expectedStatus: 201,
      statusText: "Invalid JSON response",
      diagnostic: "invalid JSON",
    },
    {
      label: "destructive unexpected media",
      response: () =>
        new Response("<html>created, perhaps</html>", {
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "text/html" },
        }),
      plan: requestPlan({
        method: "delete",
        url: "https://api.postwave.test/api/v1/tags/tag-44",
      }),
      policy: executablePolicy({
        operationKey: "DELETE /api/v1/tags/{id}",
        method: "delete",
        pathTemplate: "/api/v1/tags/{id}",
        effect: "destructive",
        responseMediaTypesByStatus: { "200": ["application/json"] },
      }),
      expectedStatus: 200,
      statusText: "Unexpected response media",
      diagnostic: "instead of declared JSON media",
    },
  ])(
    "ambiguity-gates a 2xx $label contract violation without losing its HTTP diagnostic",
    async ({
      response,
      plan,
      policy,
      expectedStatus,
      statusText,
      diagnostic,
    }) => {
      mocks.fetch.mockResolvedValue(response());

      const result = await executePlaygroundRequest(
        "https://api.postwave.test",
        plan,
        policy,
        new AbortController().signal,
      );

      expect(result).toMatchObject({
        status: expectedStatus,
        statusText,
        outcome: "contract",
        ambiguous: true,
        previewBytes: 0,
        body: expect.stringContaining(diagnostic),
        requestId: expect.any(String),
      });
      expect(mocks.fetch).toHaveBeenCalledOnce();
    },
  );

  it("classifies an effectful timeout as ambiguous without retrying", async () => {
    vi.useFakeTimers();
    installAbortablePendingFetch();
    const plan = requestPlan({ method: "post" });
    const policy = executablePolicy({
      operationKey: "POST /api/v1/tags",
      method: "post",
      effect: "effectful",
    });

    const pending = executePlaygroundRequest(
      "https://api.postwave.test",
      plan,
      policy,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(PLAYGROUND_REQUEST_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({
      outcome: "timeout",
      ambiguous: true,
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("classifies an operator-cancelled mutation as ambiguous", async () => {
    installAbortablePendingFetch();
    const controller = new AbortController();
    const pending = executePlaygroundRequest(
      "https://api.postwave.test",
      requestPlan({ method: "post" }),
      executablePolicy({
        operationKey: "POST /api/v1/tags",
        method: "post",
        effect: "effectful",
      }),
      controller.signal,
    );

    controller.abort("operator-cancelled");

    await expect(pending).resolves.toMatchObject({
      outcome: "aborted",
      statusText: "Cancelled",
      ambiguous: true,
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("does not render raw native transport diagnostics", async () => {
    mocks.fetch.mockRejectedValue(
      new Error(
        "failed https://api.postwave.test/api/v1/tags?query=private@example.com token=pw_secret",
      ),
    );

    const result = await executePlaygroundRequest(
      "https://api.postwave.test",
      requestPlan(),
      executablePolicy(),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      outcome: "network",
      ambiguous: false,
      statusText: "Network error",
    });
    expect(result.body).toContain(
      "Native transport diagnostics are not rendered",
    );
    expect(result.body).not.toContain("private@example.com");
    expect(result.body).not.toContain("pw_secret");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});
