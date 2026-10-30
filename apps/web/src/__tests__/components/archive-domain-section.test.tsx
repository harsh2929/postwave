// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Archive custom domain verbs (parity rows platform-29..32) with the shared
// custom-domain release policy OPENED, so each verb's real request is
// observable at the fetch boundary. The held (production) state is pinned by
// archive-domain-section-held.test.tsx against the unmocked policy.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Policy from "@/lib/custom-domain-operational-availability";
import type { MeResponse } from "@/lib/auth-api";

vi.mock(
  "@/lib/custom-domain-operational-availability",
  async (importOriginal) => {
    const actual = await importOriginal<typeof Policy>();
    return {
      ...actual,
      CUSTOM_DOMAIN_REGISTRATION_AVAILABLE: true,
      CUSTOM_DOMAIN_VERIFICATION_AVAILABLE: true,
      CUSTOM_DOMAIN_REMOVAL_AVAILABLE: true,
      requireCustomDomainOperation: () => undefined,
      requireCustomDomainValueUnchanged: () => undefined,
    };
  },
);

import { ArchiveDomainSection } from "@/app/(dashboard)/app/archive-settings/archive-domain-section";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const roots: Root[] = [];

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const DOMAIN_STATUS = {
  domain: "news.example.test",
  cname_target: "custom-domains.moosewave.com",
  verification_token: "tok123",
  status: "pending",
  last_checked_at: "",
  verified_at: "",
  last_error: "",
  ssl_status: "pending",
  ssl_last_error: "",
};

const SETTINGS = {
  tenant_archive_slug: "acme",
  archive_domain: "news.example.test",
  archive_title: "Acme",
  archive_tagline: "",
  tips_enabled: false,
  tips_currency: "usd",
  tips_suggested_amounts: [],
  tips_min_amount: 100,
  tips_message: "",
  archive_bar_default_enabled: true,
  view_in_browser_default_enabled: true,
};

let calls: Call[] = [];
let respond: (call: Call) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function defaultResponder(call: Call): Response {
  if (call.method === "GET" && call.path === "/api/v1/admin/archive/domain") {
    return json(DOMAIN_STATUS);
  }
  return json({});
}

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: "archive-admin",
    tenant_id: TENANT_ID,
    email: "archive-admin@example.test",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Archive workspace",
    workspace_slug: "archive-workspace",
    ...overrides,
  };
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
}

function setInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

async function click(element: HTMLElement | undefined): Promise<void> {
  expect(element).toBeDefined();
  await act(async () => {
    element!.click();
  });
}

function mutations(): Call[] {
  return calls.filter((call) => call.method !== "GET");
}

async function renderSection(identity = me()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, networkMode: "always", gcTime: 0 },
      mutations: { retry: false, networkMode: "always" },
    },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ArchiveDomainSection
          me={identity}
          queryBase={["archive-admin", TENANT_ID, "admin", "u", false]}
        />
      </QueryClientProvider>,
    );
  });
  await eventually(() =>
    expect(container.textContent).toContain("news.example.test"),
  );
  return { client, container };
}

beforeEach(() => {
  calls = [];
  respond = defaultResponder;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const call: Call = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: new URL(url, "http://localhost").pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      return respond(call);
    }),
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ArchiveDomainSection (release policy open)", () => {
  it("copies the exact CNAME host, target, and TXT value (platform-32)", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await renderSection();

    await click(button("Copy host"));
    await click(button("Copy target"));
    await click(button("Copy TXT value"));

    expect(writeText.mock.calls.map(([text]) => text)).toEqual([
      "news.example.test",
      "custom-domains.moosewave.com",
      "postwave-verify=tok123",
    ]);
    expect(mutations()).toEqual([]);
  });

  it("saves ONLY archive_domain, normalized, and renders the receipt (platform-29)", async () => {
    respond = (call) => {
      if (call.method === "PUT") {
        return json({ ...SETTINGS, archive_domain: "letters.example.test" });
      }
      if (call.method === "GET" && call.path === "/api/v1/admin/archive/domain") {
        const alreadySaved = calls.some((c) => c.method === "PUT");
        return json(
          alreadySaved
            ? { ...DOMAIN_STATUS, domain: "letters.example.test" }
            : DOMAIN_STATUS,
        );
      }
      return json({});
    };
    const { container } = await renderSection();

    const saveButton = button("Save domain");
    expect(saveButton?.disabled).toBe(true);
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => setInput(input, "  Letters.Example.TEST "));
    expect(button("Save domain")?.disabled).toBe(false);
    await click(button("Save domain"));

    await eventually(() =>
      expect(container.textContent).toContain(
        "Archive domain saved as letters.example.test.",
      ),
    );
    expect(mutations()).toEqual([
      {
        method: "PUT",
        path: "/api/v1/admin/archive/tenant-settings",
        body: { archive_domain: "letters.example.test" },
      },
    ]);
    // The receipt is reflected, and the domain status is re-read.
    await eventually(() => {
      expect(
        calls.filter(
          (c) => c.method === "GET" && c.path === "/api/v1/admin/archive/domain",
        ).length,
      ).toBeGreaterThanOrEqual(2);
      expect(input.value).toBe("letters.example.test");
      expect(button("Save domain")?.disabled).toBe(true);
    });
  });

  it("clears the domain with an explicit empty string", async () => {
    respond = (call) =>
      call.method === "PUT"
        ? json({ ...SETTINGS, archive_domain: "" })
        : defaultResponder(call);
    const { container } = await renderSection();
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => setInput(input, ""));
    await click(button("Save domain"));
    await eventually(() =>
      expect(container.textContent).toContain("Archive domain cleared."),
    );
    expect(mutations()[0]).toEqual({
      method: "PUT",
      path: "/api/v1/admin/archive/tenant-settings",
      body: { archive_domain: "" },
    });
  });

  it("renders the server's validation sentence when the save is refused", async () => {
    respond = (call) =>
      call.method === "PUT"
        ? json(
            {
              error: {
                code: "invalid_domain",
                message: "archive domain uses a reserved suffix",
              },
            },
            400,
          )
        : defaultResponder(call);
    const { container } = await renderSection();
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => setInput(input, "news.moosewave.com"));
    await click(button("Save domain"));
    await eventually(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain(
        "archive domain uses a reserved suffix",
      );
    });
    expect(container.textContent).not.toContain("Archive domain saved");
  });

  it("verifies DNS and renders the server's verdict (platform-30)", async () => {
    let verdict: Record<string, unknown> = {
      ...DOMAIN_STATUS,
      status: "failed",
      last_error: "CNAME news.example.test resolves to elsewhere.test",
    };
    respond = (call) =>
      call.method === "POST" ? json(verdict) : defaultResponder(call);
    const { container } = await renderSection();

    await click(button("Verify DNS"));
    await eventually(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        "CNAME news.example.test resolves to elsewhere.test",
      ),
    );
    expect(mutations()).toEqual([
      {
        method: "POST",
        path: "/api/v1/admin/archive/domain/verify",
        body: {},
      },
    ]);

    verdict = {
      ...DOMAIN_STATUS,
      status: "verified",
      verified_at: "2026-09-01T10:00:00Z",
      ssl_status: "issuing",
    };
    await click(button("Verify DNS"));
    await eventually(() => {
      expect(container.textContent).toContain(
        "news.example.test passed DNS verification.",
      );
      expect(button("Re-check DNS")).toBeDefined();
      expect(container.textContent).toContain("issuing");
    });
    expect(mutations()).toHaveLength(2);
  });

  it("removes verification only after a confirm that names the consequence (platform-31)", async () => {
    respond = (call) =>
      call.method === "DELETE"
        ? new Response(null, { status: 204 })
        : defaultResponder(call);
    const { container } = await renderSection();

    await click(button("Remove verification"));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(
      "Remove custom-domain verification?",
    );
    expect(dialog?.textContent).toContain(
      "news.example.test will stop routing to this archive immediately",
    );
    expect(mutations()).toEqual([]);

    const confirm = Array.from(
      dialog?.querySelectorAll("button") ?? [],
    ).find((b) => b.textContent?.trim() === "Remove verification");
    await click(confirm);

    await eventually(() =>
      expect(container.textContent).toContain(
        "Verification removed. The host no longer routes to this archive",
      ),
    );
    expect(mutations()).toEqual([
      { method: "DELETE", path: "/api/v1/admin/archive/domain", body: null },
    ]);
  });

  it("keeps the dialog open with the server's sentence when removal fails", async () => {
    respond = (call) =>
      call.method === "DELETE"
        ? json({ error: { code: "forbidden", message: "admin scope required" } }, 403)
        : defaultResponder(call);
    const { container } = await renderSection();
    await click(button("Remove verification"));
    const dialog = document.querySelector('[role="dialog"]');
    const confirm = Array.from(
      dialog?.querySelectorAll("button") ?? [],
    ).find((b) => b.textContent?.trim() === "Remove verification");
    await click(confirm);
    await eventually(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "admin scope required",
      ),
    );
    expect(container.textContent).not.toContain("Verification removed");
  });

  it("withholds every domain mutation from non-admins and view-as sessions", async () => {
    for (const identity of [
      me({ role: "editor", effective_role: "editor" }),
      me({ role: "owner", effective_role: "viewer", viewer_mode: true }),
    ]) {
      const { container } = await renderSection(identity);
      expect(container.textContent).toContain(
        "Only workspace owners and admins can change, verify, or remove the archive domain.",
      );
      for (const label of [
        "Save domain",
        "Verify DNS",
        "Remove verification",
      ]) {
        expect(
          Array.from(container.querySelectorAll("button")).some(
            (b) => b.textContent?.trim() === label,
          ),
        ).toBe(false);
      }
      expect(container.querySelector("input")).toBeNull();
      // Reading and copying the record stays available.
      expect(
        Array.from(container.querySelectorAll("button")).some(
          (b) => b.textContent?.trim() === "Copy host",
        ),
      ).toBe(true);
      for (const root of roots.splice(0)) act(() => root.unmount());
      document.body.innerHTML = "";
    }
    expect(mutations()).toEqual([]);
  });
});
