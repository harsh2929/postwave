// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// /lifecycle mailbox-provider breakdown → by campaign (parity row
// deliverability-67). Desktop: IspBreakdownCard + CampaignSelect →
// GET /api/v1/isp-breakdown/by-campaign/{id}.
//
// Asserted at the stubbed fetch: the exact method + path the server will
// see, and what the card renders from the answer — including the refusals
// (a server denial, a response for another campaign, a malformed typed id).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/lifecycle",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

const TENANT_PATH = "/api/v1/isp-breakdown";
const BY_CAMPAIGN_PREFIX = "/api/v1/isp-breakdown/by-campaign/";
const CAMPAIGNS_PATH = "/api/v1/campaigns";

const LAUNCH = "0f4c9a2e-1111-4111-8111-aaaaaaaaaaaa";
const DRAFT = "0f4c9a2e-2222-4222-8222-bbbbbbbbbbbb";
const OLDER = "0f4c9a2e-3333-4333-8333-cccccccccccc";

function bucket(isp: string, sent: number, openRate: number) {
  return {
    isp,
    subscribers: sent,
    sent,
    opens: Math.round(sent * openRate),
    clicks: 0,
    bounces: 0,
    complaints: 0,
    open_rate: openRate,
    click_rate: 0.1,
    bounce_rate: 0.02,
    complaint_rate: 0,
  };
}

type CampaignMode = "ok" | "empty" | "denied" | "mismatch";
let campaignMode: CampaignMode = "ok";

function urlOf(input: RequestInfo | URL): URL {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  return new URL(raw, "http://postwave.test");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubTransport(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = urlOf(input);
      if (url.pathname === TENANT_PATH) {
        return json({ window_days: 30, buckets: [bucket("gmail", 1000, 0.5)] });
      }
      if (url.pathname.startsWith(BY_CAMPAIGN_PREFIX)) {
        const id = decodeURIComponent(
          url.pathname.slice(BY_CAMPAIGN_PREFIX.length),
        );
        if (campaignMode === "denied") {
          return json(
            {
              error: {
                code: "forbidden",
                message: "Your API key lacks the read_reports scope.",
              },
            },
            403,
          );
        }
        return json({
          campaign_id: campaignMode === "mismatch" ? DRAFT : id,
          buckets:
            campaignMode === "empty" ? [] : [bucket("yahoo", 40, 0.25)],
        });
      }
      if (url.pathname === CAMPAIGNS_PATH) {
        return json([
          {
            id: LAUNCH,
            tenant_id: WHOAMI.tenant_id,
            name: "September launch",
            subject: "It's here",
            status: "sent",
          },
          {
            id: DRAFT,
            tenant_id: WHOAMI.tenant_id,
            name: "",
            subject: "Untitled draft",
            status: "draft",
          },
        ]);
      }
      if (url.pathname === "/api/v1/lifecycle/stages") {
        return json({ stages: ["lead"] });
      }
      if (url.pathname === "/api/v1/lifecycle/distribution") {
        return json({ items: [{ stage: "lead", count: 3 }] });
      }
      return json({ error: { code: "not_found", message: "" } }, 404);
    }),
  );
}

function calls(): Array<{ url: URL; method: string }> {
  return vi.mocked(globalThis.fetch).mock.calls.map(([input, init]) => ({
    url: urlOf(input),
    method: (init?.method ?? "GET").toUpperCase(),
  }));
}

function byCampaignCalls() {
  return calls().filter((call) =>
    call.url.pathname.startsWith(BY_CAMPAIGN_PREFIX),
  );
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function ispSurface(container: HTMLElement): HTMLElement {
  const heading = [...container.querySelectorAll("h2, h3")].find(
    (el) => el.textContent?.trim() === "Mailbox providers",
  );
  expect(heading, "Mailbox providers surface").toBeDefined();
  const surface = heading!.closest("section") as HTMLElement | null;
  expect(surface).not.toBeNull();
  return surface!;
}

function scopeSelect(container: HTMLElement): HTMLSelectElement {
  const select = [
    ...ispSurface(container).querySelectorAll<HTMLSelectElement>("select"),
  ].find((el) =>
    [...el.options].some(
      (option) => option.textContent === "All campaigns · tenant window",
    ),
  );
  expect(select, "ISP campaign select").toBeDefined();
  return select!;
}

async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

function buttonIn(scope: HTMLElement, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(found, `button "${text}"`).toBeDefined();
  return found!;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await settle();
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

async function mount() {
  const Page = (await import("@/app/(dashboard)/app/lifecycle/page")).default;
  return renderPage(Page);
}

beforeEach(() => {
  vi.clearAllMocks();
  campaignMode = "ok";
  stubTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lifecycle ISP breakdown by campaign", () => {
  it("starts on the tenant window and lists campaigns to scope by", async () => {
    const { container, root } = await mount();
    try {
      expect(calls().filter((c) => c.url.pathname === TENANT_PATH)).toHaveLength(
        1,
      );
      expect(byCampaignCalls()).toHaveLength(0);
      const campaignList = calls().find(
        (c) => c.url.pathname === CAMPAIGNS_PATH,
      );
      expect(campaignList?.url.searchParams.get("limit")).toBe("100");

      const surface = ispSurface(container);
      expect(surface.textContent).toContain("gmail");
      expect(surface.textContent).toContain("1,000 sent");
      const select = scopeSelect(container);
      expect(select.value).toBe("");
      expect([...select.options].map((o) => [o.value, o.textContent])).toEqual(
        [
          ["", "All campaigns · tenant window"],
          [LAUNCH, "September launch · sent"],
          [DRAFT, "Untitled draft · draft"],
        ],
      );
    } finally {
      unmount(root);
    }
  });

  it("picking a campaign requests its breakdown and renders it in place of the window", async () => {
    const { container, root } = await mount();
    try {
      await choose(scopeSelect(container), LAUNCH);

      const requested = byCampaignCalls();
      expect(requested).toHaveLength(1);
      expect(requested[0]!.method).toBe("GET");
      expect(requested[0]!.url.pathname).toBe(
        `/api/v1/isp-breakdown/by-campaign/${LAUNCH}`,
      );
      expect([...requested[0]!.url.searchParams.keys()]).toEqual([]);

      const surface = ispSurface(container);
      expect(surface.textContent).toContain("for the selected campaign");
      expect(surface.textContent).toContain("yahoo");
      expect(surface.textContent).toContain("40 sent");
      expect(surface.textContent).toContain("25%");
      expect(surface.textContent).not.toContain("gmail");
      expect(scopeSelect(container).value).toBe(LAUNCH);

      // Back to the tenant window.
      await choose(scopeSelect(container), "");
      expect(ispSurface(container).textContent).toContain("gmail");
      expect(ispSurface(container).textContent).not.toContain("yahoo");
      expect(byCampaignCalls()).toHaveLength(1);
    } finally {
      unmount(root);
    }
  });

  it("an exact campaign id can be used, and a malformed one is refused before sending", async () => {
    const { container, root } = await mount();
    try {
      const surface = ispSurface(container);
      await click(buttonIn(surface, "Use campaign ID"));
      const input = surface.querySelector<HTMLInputElement>(
        'input[placeholder="Paste an exact campaign ID"]',
      );
      expect(input).not.toBeNull();
      const form = input!.closest("form")!;

      await type(input!, "42; DROP TABLE");
      await submit(form);
      expect(surface.querySelector('[role="alert"]')?.textContent).toContain(
        "A campaign ID is a UUID",
      );
      expect(byCampaignCalls()).toHaveLength(0);

      await type(input!, `  ${OLDER} `);
      await submit(form);
      const requested = byCampaignCalls();
      expect(requested).toHaveLength(1);
      expect(requested[0]!.url.pathname).toBe(
        `/api/v1/isp-breakdown/by-campaign/${OLDER}`,
      );
      const select = scopeSelect(container);
      expect(select.value).toBe(OLDER);
      expect(select.selectedOptions[0]?.textContent).toBe(
        `Campaign ${OLDER} · direct ID`,
      );
      expect(ispSurface(container).textContent).toContain("yahoo");
    } finally {
      unmount(root);
    }
  });

  it("renders the server's denial rather than an empty breakdown", async () => {
    campaignMode = "denied";
    const { container, root } = await mount();
    try {
      await choose(scopeSelect(container), LAUNCH);
      const alert = ispSurface(container).querySelector('[role="alert"]');
      expect(alert?.textContent).toContain(
        "Your API key lacks the read_reports scope.",
      );
      expect(alert?.textContent).toContain("Retry");
      expect(ispSurface(container).textContent).not.toContain(
        "No provider events for this campaign",
      );
    } finally {
      unmount(root);
    }
  });

  it("refuses a breakdown that answers for a different campaign", async () => {
    campaignMode = "mismatch";
    const { container, root } = await mount();
    try {
      await choose(scopeSelect(container), LAUNCH);
      const surface = ispSurface(container);
      expect(surface.querySelector('[role="alert"]')?.textContent).toContain(
        "answered for a different campaign",
      );
      expect(surface.textContent).not.toContain("yahoo");
    } finally {
      unmount(root);
    }
  });

  it("says when a campaign has produced no provider events", async () => {
    campaignMode = "empty";
    const { container, root } = await mount();
    try {
      await choose(scopeSelect(container), LAUNCH);
      expect(ispSurface(container).textContent).toContain(
        "No provider events for this campaign",
      );
    } finally {
      unmount(root);
    }
  });
});
