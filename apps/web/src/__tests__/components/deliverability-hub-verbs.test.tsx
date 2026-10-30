// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// deliverability-38 (refresh all six hub surfaces), -40 (breach fix CTA) and
// -58 (hygiene playbooks). /app/deliverability/page.tsx is another session's
// WIP, so each component is driven directly. Assertions are consequences:
// the six GETs and the query-cache entries they update, the receipt copy for
// full / partial refreshes, the href each fix CTA resolves to, and which
// playbook body is on screen.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BreachFixCta } from "@/components/deliverability/BreachFixCta";
import { DeliverabilityHubRefresh } from "@/components/deliverability/DeliverabilityHubRefresh";
import { HygienePlaybooks } from "@/components/deliverability/HygienePlaybooks";

const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: { ...actual.api, get: mocks.apiGet } };
});

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const KEY_BASE = ["deliverability-hub", "tenant-1", "owner"] as const;

const RESPONSES: Record<string, unknown> = {
  "/api/v1/deliverability/hub": {
    tenant_id: "tenant-1",
    score: 88,
    breaches: [],
    blocklist_hits: [],
  },
  "/api/v1/deliverability/hub/history": {
    snapshots: [{ score: 88 }],
    count: 1,
    model_version: "v3",
  },
  "/api/v1/deliverability/hub/dns-health": {
    identities: [{ domain: "mail.example.test" }],
  },
  "/api/v1/deliverability/hub/blocklist-hits": { items: [] },
  "/api/v1/deliverability/hub/webhook-errors": { items: [] },
  "/api/v1/deliverability/hub/bounce-class-breakdown": {
    series: [{ day: "2026-09-01", counts: null }],
  },
};

let failing = new Set<string>();

beforeEach(() => {
  failing = new Set();
  mocks.apiGet.mockImplementation((path: string) =>
    failing.has(path)
      ? Promise.reject(new Error(`${path} failed`))
      : path in RESPONSES
        ? Promise.resolve(RESPONSES[path])
        : Promise.reject(new Error(`unmocked ${path}`)),
  );
});

let root: Root | null = null;

function render(node: ReactNode, client?: QueryClient) {
  const container = document.createElement("div");
  document.body.append(container);
  const queryClient =
    client ??
    new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root = createRoot(container);
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, node),
    );
  });
  return { container, queryClient };
}

async function flush() {
  for (let turn = 0; turn < 8; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(scope: ParentNode, label: string | RegExp): HTMLButtonElement {
  const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => {
      const text = candidate.textContent?.trim() ?? "";
      return typeof label === "string" ? text === label : label.test(text);
    },
  );
  if (!node) throw new Error(`missing button ${String(label)}`);
  return node;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("DeliverabilityHubRefresh (deliverability-38)", () => {
  it("reads all six surfaces into the page's query keys and reports a full receipt", async () => {
    const { container, queryClient } = render(
      <DeliverabilityHubRefresh keyBase={KEY_BASE} enabled />,
    );
    expect(mocks.apiGet).not.toHaveBeenCalled();

    await act(async () => {
      button(container, "Refresh evidence").click();
    });
    await flush();

    expect(mocks.apiGet.mock.calls.map(([path]) => path).sort()).toEqual(
      [
        "/api/v1/deliverability/hub",
        "/api/v1/deliverability/hub/blocklist-hits",
        "/api/v1/deliverability/hub/bounce-class-breakdown",
        "/api/v1/deliverability/hub/dns-health",
        "/api/v1/deliverability/hub/history",
        "/api/v1/deliverability/hub/webhook-errors",
      ].sort(),
    );
    // Written under the SAME keys /app/deliverability observes.
    expect(queryClient.getQueryData([...KEY_BASE, "summary"])).toMatchObject({
      score: 88,
    });
    expect(queryClient.getQueryData([...KEY_BASE, "dns"])).toEqual([
      { domain: "mail.example.test" },
    ]);
    expect(queryClient.getQueryData([...KEY_BASE, "bounce-classes"])).toEqual([
      { day: "2026-09-01", counts: {} },
    ]);
    expect(queryClient.getQueryData([...KEY_BASE, "history"])).toMatchObject({
      count: 1,
      model_version: "v3",
    });
    expect(container.textContent).toMatch(
      /All 6 evidence surfaces verified at /,
    );
  });

  it("never announces a partial refresh as a clean one", async () => {
    failing = new Set([
      "/api/v1/deliverability/hub/history",
      "/api/v1/deliverability/hub/dns-health",
    ]);
    const onRefreshed = vi.fn();
    const { container, queryClient } = render(
      <DeliverabilityHubRefresh
        keyBase={KEY_BASE}
        enabled
        onRefreshed={onRefreshed}
      />,
    );
    await act(async () => {
      button(container, "Refresh evidence").click();
    });
    await flush();

    expect(container.textContent).toContain("4 of 6 surfaces verified");
    expect(container.textContent).toContain(
      "Not verified: Score history, DNS health.",
    );
    expect(onRefreshed).toHaveBeenCalledWith(
      expect.objectContaining({
        verified: 4,
        failed: ["Score history", "DNS health"],
      }),
    );
    // The failed surface is an error in the shared cache, not stale "healthy".
    expect(queryClient.getQueryState([...KEY_BASE, "dns"])?.status).toBe(
      "error",
    );
  });

  it("sends nothing before workspace identity is verified", async () => {
    const { container } = render(
      <DeliverabilityHubRefresh keyBase={KEY_BASE} enabled={false} />,
    );
    const control = button(container, "Refresh evidence");
    expect(control.disabled).toBe(true);
    await act(async () => {
      control.click();
    });
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });
});

describe("BreachFixCta (deliverability-40)", () => {
  function hrefFor(fixCta: unknown): string | null {
    const { container } = render(
      <BreachFixCta breach={{ code: "b1", fix_cta: fixCta }} />,
    );
    const link = container.querySelector("a");
    const href = link?.getAttribute("href") ?? null;
    act(() => root!.unmount());
    root = null;
    container.remove();
    return href;
  }

  it("maps every desktop section the hub emits to its web route", () => {
    expect(
      hrefFor({ label: "Open suppressions", section: "suppressions" }),
    ).toBe("/app/suppressions");
    expect(hrefFor({ label: "Review campaigns", section: "campaigns" })).toBe(
      "/app/campaigns",
    );
    expect(hrefFor({ label: "Open sequences", section: "sequences" })).toBe(
      "/app/sequences",
    );
    expect(hrefFor({ label: "Fix DNS", section: "domains" })).toBe(
      "/app/settings/sender",
    );
    expect(
      hrefFor({ label: "Review hits", section: "deliverabilityHub" }),
    ).toBe("/app/deliverability#dh-blocklist");
  });

  it("renders the server label as the link text", () => {
    const { container } = render(
      <BreachFixCta
        breach={{
          code: "dns_broken",
          fix_cta: { label: "Fix DNS", section: "domains" },
        }}
      />,
    );
    expect(container.querySelector("a")?.textContent).toBe("Fix DNS");
  });

  it("opens an https href in a new tab and refuses any other scheme", () => {
    const { container } = render(
      <BreachFixCta
        breach={{
          code: "ext",
          fix_cta: { label: "Delist", href: "https://delist.example.test/x" },
        }}
      />,
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://delist.example.test/x");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    act(() => root!.unmount());
    root = null;

    expect(hrefFor({ label: "Bad", href: "javascript:alert(1)" })).toBeNull();
    expect(
      hrefFor({ label: "Plain", href: "http://insecure.example.test" }),
    ).toBeNull();
  });

  it("withholds an unmapped section with its reason instead of a dead button", () => {
    const { container } = render(
      <BreachFixCta
        breach={{
          code: "x",
          fix_cta: { label: "Open thing", section: "nope" },
        }}
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(button(container, "Open thing").disabled).toBe(true);
    expect(container.textContent).toContain(
      "This fix has no web destination yet.",
    );
  });

  it("renders nothing for a breach without a fix", () => {
    const { container } = render(<BreachFixCta breach={{ code: "none" }} />);
    expect(container.textContent).toBe("");
  });
});

describe("HygienePlaybooks (deliverability-58)", () => {
  it("expands one playbook at a time and collapses it again", () => {
    const { container } = render(<HygienePlaybooks />);
    const sunset = button(container, /^Sunset flow/);
    const mpp = button(container, /^Apple Mail Privacy Protection/);
    expect(sunset.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Win-back");

    act(() => sunset.click());
    expect(sunset.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Win-back");
    const region = container.querySelector('[role="region"]')!;
    expect(sunset.getAttribute("aria-controls")).toBe(region.id);

    act(() => mpp.click());
    expect(sunset.getAttribute("aria-expanded")).toBe("false");
    expect(mpp.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).not.toContain("Win-back");
    expect(container.textContent).toContain("Watch machine opens");

    act(() => mpp.click());
    expect(mpp.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="region"]')).toBeNull();
  });

  it("does not promise a send-time control that does not exist", () => {
    const { container } = render(<HygienePlaybooks />);
    act(() => button(container, /^Apple Mail Privacy Protection/).click());
    expect(container.textContent).not.toContain("Exclude pre-fetched opens");
  });
});
