// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Parity row audience-43 — sunset policy management on /list-hygiene.
//
// What these assert is the CONSEQUENCE of each verb: the exact request (method,
// path, body) and what the card then shows. Three things are easy to get
// wrong and expensive when wrong:
//   1. The wire is camelCase (`inactiveDays`, `excludedTags`). snake_case is
//      silently dropped by Go's decoder and then fails as "0 days".
//   2. Every save is PAUSED (`enabled: false`) and nothing ever calls `/run` —
//      execution is withheld on desktop and web alike.
//   3. The LIST is ScopeAdmin: a non-admin must make zero policy requests.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => ({})),
  post: vi.fn(
    async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> =>
      ({}),
  ),
  put: vi.fn(
    async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> =>
      ({}),
  ),
  del: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => undefined),
  whoamiFresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { get: mocks.get, post: mocks.post, put: mocks.put, delete: mocks.del },
  apiErrorMessage: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("@/lib/auth-api", () => ({
  whoami: vi.fn(),
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { SunsetPoliciesCard } from "@/components/subscribers/SunsetPoliciesCard";
import type { MeResponse } from "@/lib/auth-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "ada@example.com",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
} as unknown as MeResponse;
const EDITOR = {
  ...OWNER,
  role: "editor",
  effective_role: "editor",
} as unknown as MeResponse;

const KEY = ["list-hygiene", OWNER.tenant_id, "owner", "sunset"] as const;

const POLICY = {
  id: "pol_1",
  tenantId: OWNER.tenant_id,
  name: "12-month sunset",
  inactiveDays: 365,
  action: "suppress",
  enabled: false,
  excludedTags: ["vip"],
  createdAt: "2026-08-01T09:00:00Z",
  updatedAt: "2026-08-02T09:00:00Z",
};

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
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(identity: MeResponse | null = OWNER) {
  return render(createElement(SunsetPoliciesCard, { identity, queryKey: KEY }));
}

function card(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    '[data-testid="sunset-policies"]',
  );
  if (!element) throw new Error("Sunset card not rendered");
  return element;
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!element) throw new Error("No dialog is open");
  return element;
}

function field(labelText: string, scope: ParentNode = document) {
  const label = [...scope.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === labelText,
  );
  const control = label ? document.getElementById(label.htmlFor) : null;
  if (!control) throw new Error(`Control not found for label: ${labelText}`);
  return control as HTMLInputElement | HTMLSelectElement;
}

function type(control: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    control instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function listRoute(path: string): boolean {
  return path === "/api/v1/sunset/policies";
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  mocks.get.mockImplementation(async (path: string) => {
    if (listRoute(path)) return { items: [POLICY] };
    if (path === "/api/v1/sunset/policies/pol_1/executions") {
      return {
        items: [
          {
            id: "exe_1",
            policyId: "pol_1",
            subscriberId: "sub_42",
            actionTaken: "skipped",
            reason: "excluded tag vip",
            executedAt: "2026-08-03T10:00:00Z",
          },
        ],
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  mocks.post.mockImplementation(async (path: string, body?: unknown) => {
    if (listRoute(path)) {
      return { ...POLICY, ...(body as object), id: "pol_2" };
    }
    if (path === "/api/v1/sunset/reengagement/preview") {
      return {
        subject: "We miss you at Acme",
        preheader: "Still want these?",
        bodyText: "Hi there — it has been a while.",
        bodyHtml: "<p>Hi there</p>",
        primaryCta: "Keep me subscribed",
        candidateCount: 0,
        variant: "direct",
      };
    }
    throw new Error(`unexpected POST ${path}`);
  });
  mocks.put.mockImplementation(async (_path: string, body?: unknown) => ({
    ...POLICY,
    ...(body as object),
  }));
  mocks.del.mockResolvedValue(undefined);
});

function allPaths(): string[] {
  return [mocks.get, mocks.post, mocks.put, mocks.del].flatMap((mock) =>
    mock.mock.calls.map((call) => String(call[0])),
  );
}

afterEach(() => {
  // Execution is withheld on desktop and web alike: whatever a test did, no
  // request may have reached the synchronous `/run` sweep.
  const ran = allPaths().filter((path) => path.endsWith("/run"));
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  expect(ran).toEqual([]);
});

describe("sunset policies card", () => {
  it("lists policies with their criteria and never offers a run", async () => {
    mount();
    await flush();

    expect(mocks.get).toHaveBeenCalledWith("/api/v1/sunset/policies");
    expect(card().textContent).toContain("12-month sunset");
    expect(card().textContent).toContain(
      "Inactive ≥ 365 days → Suppress (stop all sends) · excludes vip",
    );
    expect(card().textContent).toContain("Run unavailable");
    expect(card().textContent).toContain(
      "Automated and manual sweeps are unavailable in this release",
    );
    expect(allPaths().some((path) => path.endsWith("/run"))).toBe(false);
  });

  it("creates a paused policy with the camelCase body after a fresh admin check", async () => {
    mount();
    await flush();

    act(() => button("New policy").click());
    await flush();
    const form = dialog();
    act(() => type(field("Name", form), "  Quarterly sweep "));
    act(() => type(field("Inactive days", form), "90"));
    act(() => type(field("Action", form), "tag"));
    act(() => type(field("Excluded tags", form), "vip, paying , vip"));
    act(() => button("Create policy", form).click());
    await flush();

    expect(mocks.whoamiFresh).toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/sunset/policies",
      {
        name: "Quarterly sweep",
        inactiveDays: 90,
        action: "tag",
        enabled: false,
        excludedTags: ["vip", "paying"],
      },
      { requireOnline: true },
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(card().textContent).toContain("Quarterly sweep");
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Created "Quarterly sweep"');
  });

  it("refuses an out-of-range threshold before spending a request", async () => {
    mount();
    await flush();

    act(() => button("New policy").click());
    await flush();
    const form = dialog();
    act(() => type(field("Name", form), "Too eager"));
    act(() => type(field("Inactive days", form), "10"));
    act(() => button("Create policy", form).click());
    await flush();

    expect(mocks.post).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain(
      "Inactive days must be a whole number between 30 and 730.",
    );
  });

  it("renders the server's sentence when a save is refused", async () => {
    mocks.post.mockRejectedValueOnce(
      new Error("inactive_days must be between 30 and 730"),
    );
    mount();
    await flush();

    act(() => button("New policy").click());
    await flush();
    const form = dialog();
    act(() => type(field("Name", form), "Server says no"));
    act(() => button("Create policy", form).click());
    await flush();

    expect(dialog().textContent).toContain(
      "inactive_days must be between 30 and 730",
    );
  });

  it("edits with a full-replace PUT that keeps the policy paused", async () => {
    mount();
    await flush();

    act(() => button("Edit").click());
    await flush();
    const form = dialog();
    expect(field("Name", form).value).toBe("12-month sunset");
    act(() => type(field("Inactive days", form), "400"));
    act(() => button("Save policy", form).click());
    await flush();

    expect(mocks.put).toHaveBeenCalledWith(
      "/api/v1/sunset/policies/pol_1",
      {
        name: "12-month sunset",
        inactiveDays: 400,
        action: "suppress",
        enabled: false,
        excludedTags: ["vip"],
      },
      { requireOnline: true },
    );
    expect(card().textContent).toContain("Inactive ≥ 400 days");
  });

  it("deletes only behind a confirm that names what survives", async () => {
    mount();
    await flush();

    act(() => button("Delete").click());
    await flush();
    expect(dialog().textContent).toContain(
      'Delete "12-month sunset"? Past executions stay in the history; no subscribers are changed.',
    );
    expect(mocks.del).not.toHaveBeenCalled();

    await act(async () => {
      button("Delete policy", dialog()).click();
    });
    await flush();

    expect(mocks.whoamiFresh).toHaveBeenCalled();
    expect(mocks.del).toHaveBeenCalledWith("/api/v1/sunset/policies/pol_1", {
      requireOnline: true,
    });
    expect(card().textContent).not.toContain("12-month sunset");
    expect(card().textContent).toContain("No sunset policies yet.");
  });

  it("loads a policy's execution history on demand", async () => {
    mount();
    await flush();
    expect(
      mocks.get.mock.calls.some((call) => String(call[0]).includes("executions")),
    ).toBe(false);

    act(() => button("History").click());
    await flush();

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/sunset/policies/pol_1/executions",
      { query: { limit: 50 } },
    );
    expect(card().textContent).toContain("sub_42");
    expect(card().textContent).toContain("excluded tag vip");
    expect(card().textContent).toContain("skipped");
  });

  it("previews re-engagement copy with PascalCase brand fields and refuses unsafe URLs", async () => {
    mount();
    await flush();

    act(() => type(field("Workspace name"), " Acme "));
    act(() => type(field("Homepage URL"), "http://acme.example"));
    act(() => type(field("Template variant"), "direct"));
    act(() => button("Generate preview").click());
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(card().textContent).toContain(
      "Homepage URL must be an absolute HTTPS URL without embedded credentials.",
    );

    act(() => type(field("Homepage URL"), "https://acme.example"));
    act(() => button("Generate preview").click());
    await flush();

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/sunset/reengagement/preview",
      {
        brand: {
          WorkspaceName: "Acme",
          HomepageURL: "https://acme.example",
          Tone: "casual",
        },
        variant: "direct",
      },
      { idempotencyKey: null },
    );
    const result = document.querySelector('[data-testid="sunset-preview-result"]');
    expect(result?.textContent).toContain("We miss you at Acme");
    expect(result?.textContent).toContain("Keep me subscribed");
    // Generated markup is shown as SOURCE, never injected as elements.
    expect(result?.querySelector("pre p")).toBeNull();
  });

  it("withholds every policy request and write from a non-admin, with the reason", async () => {
    mount(EDITOR);
    await flush();

    expect(mocks.get).not.toHaveBeenCalled();
    expect(button("New policy").disabled).toBe(true);
    expect(button("Generate preview").disabled).toBe(true);
    expect(card().textContent).toContain(
      "Sunset policies need owner or admin access. No policy request was made for this session.",
    );
  });

  it("reports a failed list as a failed request, not an empty list", async () => {
    mocks.get.mockRejectedValue(new Error("sunset list failed"));
    mount();
    await flush();

    expect(card().textContent).toContain("sunset list failed");
    expect(card().textContent).toContain("This is a failed request, not an empty list.");
    expect(card().textContent).not.toContain("No sunset policies yet.");
  });
});
