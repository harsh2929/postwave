// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    readonly code: string;

    constructor(
      message: string,
      public readonly status: number,
      _body?: unknown,
      details: { code?: string } = {},
    ) {
      super(message);
      this.name = "ApiError";
      this.code = details.code ?? `http_${status}`;
    }
  }

  return {
    ApiError,
    api: { post: mocks.post },
  };
});

import { VoiceDriftBanner } from "@/app/(dashboard)/app/campaigns/voice-drift-banner";
import {
  buildVoiceDriftRequest,
  getVoiceDriftReading,
  type VoiceDriftReading,
} from "@/lib/ai-compose-api";
import { ApiError } from "@/lib/api";

let root: Root | null = null;
let queryClient: QueryClient | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.post.mockReset();
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  queryClient?.clear();
  root = null;
  queryClient = null;
  document.body.replaceChildren();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => flush());
    }
  }
  throw lastError;
}

type BannerProps = Parameters<typeof VoiceDriftBanner>[0];

function renderBanner(
  overrides: Partial<BannerProps> = {},
): (next: Partial<BannerProps>) => void {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
    },
  });

  const props: BannerProps = {
    bodyHtml: "<p>Initial campaign copy</p>",
    bodyText: "",
    campaignId: "campaign-1",
    enabled: true,
    role: "editor",
    tenantId: "tenant-1",
    ...overrides,
  };

  const paint = (next: Partial<BannerProps> = {}) => {
    Object.assign(props, next);
    const banner: ReactElement = createElement(VoiceDriftBanner, { ...props });
    act(() => {
      root?.render(
        createElement(QueryClientProvider, { client: queryClient! }, banner),
      );
    });
  };

  paint();
  return paint;
}

function reading(
  overrides: Partial<VoiceDriftReading> = {},
): VoiceDriftReading {
  return {
    score: 86,
    severity: "ok",
    ...overrides,
  };
}

describe("voice-drift request selection", () => {
  it("uses real HTML verbatim and omits the lower-priority text fallback", () => {
    expect(
      buildVoiceDriftRequest({
        html: "  <p>Keep surrounding whitespace</p>  ",
        text: "stale fallback",
        profileId: "  profile-1  ",
      }),
    ).toEqual({
      html: "  <p>Keep surrounding whitespace</p>  ",
      profile_id: "profile-1",
    });
  });

  it("falls back to plain text when HTML is missing or whitespace-only", async () => {
    const signal = new AbortController().signal;
    mocks.post.mockResolvedValueOnce(reading());

    await getVoiceDriftReading(
      { html: " \n ", text: "  Real plain-text copy\n" },
      { signal },
    );

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/voice/drift",
      { text: "  Real plain-text copy\n" },
      { signal },
    );
  });

  it("rejects an empty candidate locally instead of issuing a known-bad call", async () => {
    expect(buildVoiceDriftRequest({ html: " ", text: "\n" })).toBeNull();
    await expect(
      getVoiceDriftReading({ html: " ", text: "\n" }),
    ).rejects.toThrow("non-empty HTML or plain-text body");
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe("VoiceDriftBanner", () => {
  it("does not request an empty body and renders an honest advisory state", () => {
    renderBanner({ bodyHtml: " ", bodyText: "\n" });

    expect(mocks.post).not.toHaveBeenCalled();
    expect(
      document
        .querySelector('[data-testid="voice-drift-banner-empty"]')
        ?.getAttribute("role"),
    ).toBe("status");
    expect(document.body.textContent).toContain("add campaign content");
  });

  it("keys requests by effective copy, aborts the old load, and keeps the newest score", async () => {
    const first = deferred<VoiceDriftReading>();
    const second = deferred<VoiceDriftReading>();
    mocks.post.mockImplementation((_path: string, body: { html?: string }) =>
      body.html?.includes("First") ? first.promise : second.promise,
    );

    const rerender = renderBanner({
      bodyHtml: "<p>First campaign body</p>",
    });
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const firstSignal = (
      mocks.post.mock.calls[0]?.[2] as { signal?: AbortSignal }
    ).signal;

    rerender({ bodyHtml: "<p>Newest campaign body</p>" });
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => {
      second.resolve(
        reading({
          score: 42,
          severity: "critical",
          reason: "Newest-copy verdict",
        }),
      );
      await flush();
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Newest-copy verdict");
      expect(document.body.textContent).toContain("42/100");
    });

    await act(async () => {
      first.resolve(reading({ score: 99, reason: "Stale verdict" }));
      await flush();
    });
    expect(document.body.textContent).toContain("Newest-copy verdict");
    expect(document.body.textContent).not.toContain("Stale verdict");
    expect(document.body.textContent).not.toContain("99/100");
  });

  it("exposes a keyboard-sized disclosure and limits guidance to three items", async () => {
    mocks.post.mockResolvedValueOnce(
      reading({
        score: 63,
        severity: "warn",
        reason: "A very long reason that still belongs to the current draft.",
        suggestions: ["One", "Two", "Three", "Four"],
      }),
    );
    renderBanner();

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="voice-drift-banner"]'),
      ).toBeTruthy(),
    );
    const disclosure = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Why?");
    expect(disclosure).toBeTruthy();
    expect(disclosure?.classList.contains("min-h-11")).toBe(true);
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    const controlledId = disclosure?.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();
    const controlled = document.getElementById(controlledId!);
    expect(controlled?.hidden).toBe(true);

    act(() => disclosure?.click());

    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
    expect(disclosure?.textContent).toBe("Hide details");
    expect(controlled?.hidden).toBe(false);
    expect(controlled?.querySelectorAll("li")).toHaveLength(3);
    expect(document.body.textContent).not.toContain("Four");
  });

  it("distinguishes an inactive profile from a real green pass", async () => {
    mocks.post.mockResolvedValueOnce(
      reading({
        score: 100,
        suggestions: ["No voice profile yet — drift check is inactive."],
      }),
    );
    renderBanner();

    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="voice-drift-banner-inactive"]'),
      ).toBeTruthy();
    });
    expect(document.body.textContent).toContain("build a voice profile");
    expect(document.body.textContent).not.toContain("On brand");
  });

  it("keeps service unavailability advisory and does not invent a remedy", async () => {
    mocks.post.mockRejectedValueOnce(
      new ApiError("upstream unavailable", 503, undefined, {
        code: "upstream_unavailable",
      }),
    );
    renderBanner();

    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="voice-drift-banner-error"]'),
      ).toBeTruthy();
    });
    expect(document.body.textContent).toContain("service is not responding");
    expect(document.body.textContent).not.toMatch(/api key|credential/i);
  });
});
