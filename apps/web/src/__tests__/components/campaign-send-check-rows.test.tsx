// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Parity rows campaigns-31 (accessibility) and campaigns-32 (broken links).
//
// Both endpoints existed and neither was reachable from the campaign send
// flow on web. What is asserted here is the CONSEQUENCE: the exact requests
// the rows send (method, path, body), the sentence each verdict renders, and
// that a link the sweep could not reach is shown as broken with its reason —
// not that two rows exist.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { post: mocks.post },
  apiErrorMessage: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
  ApiError: class ApiError extends Error {},
}));

import { CampaignSendCheckRows } from "@/components/campaigns/campaign-send-check-rows";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN = "33333333-3333-4333-8333-333333333333";
const BODY = '<p>Hi <a href="https://example.com/a">link</a></p>';

const A11Y_REPORT = {
  findings: [
    {
      rule: "img_missing_alt",
      severity: "error",
      message: "Image has no alt text.",
      snippet: "<img src=hero.png>",
      wcag: "1.1.1",
    },
    {
      rule: "generic_link_text",
      severity: "warn",
      message: "Link text says 'click here'.",
      snippet: "",
      wcag: "2.4.4",
    },
  ],
  counts: { info: 0, warn: 1, error: 1 },
  score: 80,
};

const LINK_RESULTS = [
  { url: "https://example.com/a", status: 200, ok: true },
  // The server's own sentence (apps/api/internal/link_checker publicLinkError).
  {
    url: "https://example.com/gone",
    status: 0,
    ok: false,
    error: "The link didn't respond within 5 seconds.",
  },
];

const roots: Root[] = [];

function render(ui: ReactNode): Root {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  roots.push(root);
  return root;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function row(testId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!element) throw new Error(`Row not found: ${testId}`);
  return element;
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function mount(overrides: Partial<{ bodyHtml: string; subject: string }> = {}) {
  return render(
    createElement(CampaignSendCheckRows, {
      bodyHtml: overrides.bodyHtml ?? BODY,
      campaignId: CAMPAIGN,
      enabled: true,
      role: "admin",
      subject: overrides.subject ?? "  Spring launch  ",
      tenantId: TENANT,
    }),
  );
}

beforeEach(() => {
  mocks.post.mockReset();
  mocks.post.mockImplementation(async (path: string) => {
    if (path === "/api/v1/a11y/check") return A11Y_REPORT;
    if (path.endsWith("/check-links")) return LINK_RESULTS;
    throw new Error(`unexpected path ${path}`);
  });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("campaign send check rows", () => {
  it("lints the body and sweeps the campaign's links with the mounted requests", async () => {
    mount();
    await flush();

    // The a11y lint carries the TRIMMED subject: passing it is what turns on
    // the server's subject-length rule.
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/a11y/check",
      { html: BODY, subject: "Spring launch" },
      expect.objectContaining({ idempotencyKey: null }),
    );
    // The link sweep is campaign-scoped and takes no body of its own.
    expect(mocks.post).toHaveBeenCalledWith(
      `/api/v1/campaigns/${CAMPAIGN}/check-links`,
      {},
      expect.objectContaining({ idempotencyKey: null, requireOnline: true }),
    );

    expect(row("send-check-a11y").textContent).toContain(
      "Score 80/100 · 1 error · 1 warning",
    );
    expect(row("send-check-a11y").dataset.status).toBe("fail");
    expect(row("send-check-links").textContent).toContain(
      "1 of 2 links broken.",
    );
    expect(row("send-check-links").dataset.status).toBe("fail");
    // Neither row may claim to gate the send.
    expect(
      document.querySelector('[data-testid="campaign-send-checks"]')
        ?.textContent,
    ).toContain("these do not block Send");
  });

  it("expands the findings and the per-link verdicts on request", async () => {
    mount();
    await flush();

    act(() => button("Findings (2)").click());
    expect(row("send-check-a11y").textContent).toContain("img_missing_alt");
    expect(row("send-check-a11y").textContent).toContain("WCAG 1.1.1");

    act(() => button("Links (2)").click());
    const links = row("send-check-links").textContent ?? "";
    // A request that never produced a status shows why, not a fabricated code,
    // as text on the row rather than only in a tooltip.
    expect(links).toContain("Broken");
    expect(links).toContain("https://example.com/gone");
    expect(links).toContain("No response");
    expect(links).toContain("The link didn't respond within 5 seconds.");
  });

  it("omits an empty subject rather than linting a zero-length one", async () => {
    mount({ subject: "   " });
    await flush();

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/a11y/check",
      { html: BODY },
      expect.objectContaining({ idempotencyKey: null }),
    );
  });

  it("says a plain-text campaign has nothing to lint instead of scoring it", async () => {
    mount({ bodyHtml: "   " });
    await flush();

    expect(
      mocks.post.mock.calls.some(([path]) => path === "/api/v1/a11y/check"),
    ).toBe(false);
    expect(row("send-check-a11y").textContent).toContain(
      "no HTML body, so there is nothing to lint",
    );
  });

  it("renders the server's failure sentence and re-runs the sweep on retry", async () => {
    mocks.post.mockImplementation(async (path: string) => {
      if (path === "/api/v1/a11y/check") return A11Y_REPORT;
      throw new Error("link checker is unavailable");
    });
    mount();
    await flush();

    expect(row("send-check-links").textContent).toContain(
      "link checker is unavailable",
    );
    expect(row("send-check-links").dataset.status).toBe("error");

    const before = mocks.post.mock.calls.filter(([path]) =>
      String(path).endsWith("/check-links"),
    ).length;
    act(() => button("Retry").click());
    await flush();
    expect(
      mocks.post.mock.calls.filter(([path]) =>
        String(path).endsWith("/check-links"),
      ).length,
    ).toBeGreaterThan(before);
  });

  it("issues no request at all while the send dialog is closed", async () => {
    render(
      createElement(CampaignSendCheckRows, {
        bodyHtml: BODY,
        campaignId: CAMPAIGN,
        enabled: false,
        role: "admin",
        subject: "Spring launch",
        tenantId: TENANT,
      }),
    );
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="campaign-send-checks"]')).toBe(
      null,
    );
  });
});

describe("accessibility row cache identity", () => {
  it("re-lints when the body changes instead of reusing the previous score", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    const props = {
      campaignId: CAMPAIGN,
      enabled: true,
      role: "admin" as const,
      subject: "Spring launch",
      tenantId: TENANT,
    };
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(CampaignSendCheckRows, { ...props, bodyHtml: BODY }),
        ),
      );
    });
    await flush();
    const first = mocks.post.mock.calls.filter(
      ([path]) => path === "/api/v1/a11y/check",
    ).length;
    expect(first).toBe(1);

    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(CampaignSendCheckRows, {
            ...props,
            bodyHtml: `${BODY}<img src="hero.png">`,
          }),
        ),
      );
    });
    await flush();

    const calls = mocks.post.mock.calls.filter(
      ([path]) => path === "/api/v1/a11y/check",
    );
    expect(calls.length).toBe(2);
    expect((calls[1]?.[1] as { html: string }).html).toContain("hero.png");
  });
});
