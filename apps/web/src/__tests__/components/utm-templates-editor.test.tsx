// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// UTM templates editor (desktop UTMTemplatesView parity, row campaigns-46):
// list, load, save the workspace default, save one campaign's override,
// delete through a confirm that names the consequence, and preview a link.
// Real transport; only `fetch` is stubbed.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UtmTemplatesEditor } from "@/components/campaigns/utm-templates-editor";
import type { MeResponse } from "@/lib/auth-api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/scoring",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function identity(role: MeResponse["role"], viewer = false): MeResponse {
  return {
    user_id: "u-1",
    tenant_id: "t-1",
    email: "ops@brand.example",
    role,
    effective_role: role,
    viewer_mode: viewer,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Brand",
    workspace_slug: "brand",
  };
}

const DEFAULT_ROW = {
  id: "tpl-default",
  is_default: true,
  utm_source: "newsletter",
  utm_medium: "email",
  enabled: true,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};
const OTHER_OVERRIDE = {
  id: "tpl-other",
  campaign_id: "c-other",
  is_default: false,
  utm_campaign: "spring",
  enabled: true,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
};

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

let seen: Seen[] = [];
let me: MeResponse = identity("admin");
let handler: (req: Seen) => Response | undefined = () => undefined;
const roots: Root[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
  throw last;
}

async function mount(props: { campaignId?: string } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <UtmTemplatesEditor identity={me} {...props} />
      </QueryClientProvider>,
    );
  });
  return container;
}

function button(label: RegExp, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((candidate) =>
    label.test(candidate.textContent ?? ""),
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button ${label}`);
  return found;
}

function input(label: string): HTMLInputElement {
  const found = [...document.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const element = found ? document.getElementById(found.htmlFor) : null;
  if (!(element instanceof HTMLInputElement)) throw new Error(`no input ${label}`);
  return element;
}

async function type(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

const writes = () => seen.filter((req) => req.method !== "GET");

beforeEach(() => {
  seen = [];
  me = identity("admin");
  handler = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const req: Seen = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: new URL(raw, "http://postwave.test").pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      seen.push(req);
      const custom = handler(req);
      if (custom) return custom;
      if (req.path === "/api/v1/auth/me") return json(200, me);
      if (req.method === "GET" && req.path === "/api/v1/utm-templates") {
        return json(200, { templates: [DEFAULT_ROW, OTHER_OVERRIDE], count: 2 });
      }
      if (req.method === "POST") return json(200, { id: "tpl-saved" });
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      return json(404, { error: { code: "not_found", message: "" } });
    }),
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("UTM templates editor", () => {
  it("loads the default into the form and saves it back as the workspace default", async () => {
    const container = await mount();
    await eventually(() => expect(container.textContent).toContain("Workspace default"));
    expect(container.textContent).toContain("utm_source=newsletter · utm_medium=email");
    expect(container.textContent).toContain("Campaign override");
    expect(
      container.querySelector('a[href="/app/campaigns/c-other/utm"]'),
    ).not.toBeNull();

    await click(button(/Load into form/));
    expect(input("utm_source").value).toBe("newsletter");
    expect(input("utm_medium").value).toBe("email");
    await type(input("utm_campaign"), "  autumn  ");
    await click(button(/Save as workspace default/));

    await eventually(() =>
      expect(writes().map((req) => `${req.method} ${req.path}`)).toEqual([
        "POST /api/v1/utm-templates",
      ]),
    );
    // Trimmed, and only the parameters that are set.
    expect(writes()[0]?.body).toEqual({
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "autumn",
    });
    // The write re-checked authority first, then the list was re-read.
    const paths = seen.map((req) => `${req.method} ${req.path}`);
    expect(paths.indexOf("GET /api/v1/auth/me")).toBeLessThan(
      paths.indexOf("POST /api/v1/utm-templates"),
    );
    await eventually(() =>
      expect(container.textContent).toContain(
        "Saved as the workspace default: utm_source=newsletter · utm_medium=email · utm_campaign=autumn.",
      ),
    );
    await eventually(() =>
      expect(
        seen.filter((req) => req.method === "GET" && req.path === "/api/v1/utm-templates"),
      ).toHaveLength(2),
    );
  });

  it("saves this campaign's override and previews through it", async () => {
    handler = (req) =>
      req.path === "/api/v1/utm-templates/preview"
        ? json(200, {
            original: "https://shop.example/sale",
            rewritten: "https://shop.example/sale?utm_source=vip",
            template: { ...DEFAULT_ROW, id: "tpl-c1", campaign_id: "c-1", utm_source: "vip" },
          })
        : undefined;
    const container = await mount({ campaignId: "c-1" });
    await eventually(() =>
      expect(container.textContent).toContain("No override configuration is saved"),
    );
    await type(input("utm_source"), "vip");
    await click(button(/Save as this campaign's override/));
    await eventually(() =>
      expect(writes()[0]).toMatchObject({
        method: "POST",
        path: "/api/v1/utm-templates/campaign/c-1",
        body: { utm_source: "vip" },
      }),
    );
    await eventually(() =>
      expect(container.textContent).toContain("Saved as this campaign's override: utm_source=vip."),
    );

    await type(input("Link to preview"), "https://shop.example/sale");
    await click(button(/^Preview$/));
    await eventually(() =>
      expect(writes()[1]).toMatchObject({
        method: "POST",
        path: "/api/v1/utm-templates/preview",
        body: { url: "https://shop.example/sale", campaign_id: "c-1" },
      }),
    );
    await eventually(() =>
      expect(container.querySelector('[data-testid="utm-preview-result"]')?.textContent).toContain(
        "Applied this campaign's override",
      ),
    );
    expect(container.textContent).toContain("https://shop.example/sale?utm_source=vip");
  });

  it("says when no template applies and the link is sent unchanged", async () => {
    handler = (req) =>
      req.path === "/api/v1/utm-templates/preview"
        ? json(200, {
            original: "https://shop.example/",
            rewritten: "https://shop.example/",
            template: { id: "", enabled: false },
          })
        : undefined;
    const container = await mount();
    await click(button(/^Preview$/));
    await eventually(() =>
      expect(container.textContent).toContain(
        "No template applies — the link is sent unchanged",
      ),
    );
    // Scoring page (no campaign): the preview is not bound to a campaign.
    expect(writes()[0]?.body).toEqual({ url: "https://example.com/launch" });
  });

  it("deletes only after a confirm that names the consequence", async () => {
    const container = await mount();
    await eventually(() => expect(container.textContent).toContain("Workspace default"));
    await click(button(/Delete/));
    const dialog = await (async () => {
      let found: Element | null = null;
      await eventually(() => {
        found = document.querySelector('[role="dialog"]');
        expect(found).not.toBeNull();
      });
      return found as unknown as HTMLElement;
    })();
    expect(dialog.textContent).toContain("Delete the workspace default UTM template?");
    expect(dialog.textContent).toContain(
      "Future sends without their own override will stop getting these UTM parameters.",
    );
    expect(writes()).toEqual([]);
    await click(button(/Delete template/, dialog));
    await eventually(() =>
      expect(writes().map((req) => `${req.method} ${req.path}`)).toEqual([
        "DELETE /api/v1/utm-templates/tpl-default",
      ]),
    );
    await eventually(() =>
      expect(container.textContent).toContain("Deleted the workspace default template."),
    );
  });

  it("renders the server's refusal sentence instead of inventing one", async () => {
    handler = (req) =>
      req.method === "POST" && req.path === "/api/v1/utm-templates"
        ? json(403, {
            error: { code: "forbidden", message: "Your role cannot change UTM templates." },
          })
        : undefined;
    const container = await mount();
    await type(input("utm_source"), "newsletter");
    await click(button(/Save as workspace default/));
    await eventually(() =>
      expect(container.textContent).toContain("Your role cannot change UTM templates."),
    );
  });

  it("withholds writes from editors with the reason, but lets them preview", async () => {
    me = identity("editor");
    const container = await mount({ campaignId: "c-1" });
    await eventually(() => expect(container.textContent).toContain("Workspace default"));
    expect(button(/Save as workspace default/).disabled).toBe(true);
    expect(button(/Save as this campaign's override/).disabled).toBe(true);
    expect(button(/Delete/).disabled).toBe(true);
    expect(container.textContent).toContain(
      "Saving or deleting UTM templates needs an owner or admin role.",
    );
    expect(button(/^Preview$/).disabled).toBe(false);
  });

  it("keeps viewer mode read-only, preview included", async () => {
    me = identity("admin", true);
    const container = await mount();
    await eventually(() => expect(container.textContent).toContain("Workspace default"));
    expect(button(/Save as workspace default/).disabled).toBe(true);
    expect(button(/^Preview$/).disabled).toBe(true);
    expect(container.textContent).toContain(
      "This session is in viewer mode, so UTM templates are read-only.",
    );
  });

  it("does not render a failed list as an empty configuration", async () => {
    handler = (req) =>
      req.method === "GET" && req.path === "/api/v1/utm-templates"
        ? json(403, { error: { code: "forbidden", message: "Templates are unavailable." } })
        : undefined;
    const container = await mount();
    await eventually(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "UTM templates could not be loaded",
      ),
    );
    expect(container.textContent).not.toContain("No UTM templates are saved");
  });
});
