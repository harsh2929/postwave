// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Custom-field governance caps (parity row platform-33): GET renders the
// effective caps against usage; "Configure limits" PUTs ONLY the caps that
// changed; non-admins and view-as sessions get the reason, not the editor.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CustomFieldLimitsCard } from "@/components/settings/custom-field-limits-card";
import type { MeResponse } from "@/lib/auth-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const LIMITS = {
  max_custom_fields: 100,
  max_searchable_fields: 3,
  used_custom_fields: 91,
  used_searchable_fields: 3,
};

const roots: Root[] = [];
let calls: Call[] = [];
let respond: (call: Call) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: "cf-admin",
    tenant_id: "00000000-0000-4000-8000-000000000001",
    email: "cf-admin@example.test",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Fields workspace",
    workspace_slug: "fields-workspace",
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

function inputByLabel(container: HTMLElement, text: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  const input = label
    ? container.querySelector<HTMLInputElement>(
        `#${CSS.escape(label.htmlFor)}`,
      )
    : null;
  if (!input) throw new Error(`No input labelled ${text}`);
  return input;
}

async function renderCard(identity: MeResponse | null = me()) {
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
        <CustomFieldLimitsCard
          identity={identity}
          queryBase={["settings", "t", "admin", "custom-fields-authority"]}
        />
      </QueryClientProvider>,
    );
  });
  return { container };
}

beforeEach(() => {
  calls = [];
  respond = (call) =>
    call.method === "GET" && call.path === "/api/v1/settings/custom-fields"
      ? json(LIMITS)
      : json({});
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

describe("CustomFieldLimitsCard", () => {
  it("renders effective caps against usage with near/at-limit states", async () => {
    const { container } = await renderCard();
    await eventually(() =>
      expect(container.textContent).toContain("91 / 100 (91%)"),
    );
    const bars = Array.from(container.querySelectorAll('[role="progressbar"]'));
    expect(bars.map((bar) => bar.getAttribute("aria-valuetext"))).toEqual([
      "91 of 100 fields used · near limit",
      "3 of 3 fields used · at limit",
    ]);
    expect(container.textContent).toContain("Near limit");
    expect(container.textContent).toContain("At limit");
    expect(calls).toEqual([
      { method: "GET", path: "/api/v1/settings/custom-fields", body: null },
    ]);
  });

  it("PUTs only the changed cap and renders the server's resolved limits", async () => {
    respond = (call) => {
      if (call.method === "PUT") {
        return json({ ...LIMITS, max_custom_fields: 250 });
      }
      return json(LIMITS);
    };
    const { container } = await renderCard();
    await eventually(() => expect(button("Configure limits")).toBeDefined());
    await click(button("Configure limits"));

    expect(button("Save limits")?.disabled).toBe(true);
    await act(async () =>
      setInput(inputByLabel(container, "Max total fields"), "250"),
    );
    await click(button("Save limits"));

    await eventually(() =>
      expect(container.textContent).toContain("Custom-field limits updated."),
    );
    expect(calls.filter((call) => call.method !== "GET")).toEqual([
      {
        method: "PUT",
        path: "/api/v1/settings/custom-fields",
        body: { max_custom_fields: 250 },
      },
    ]);
    expect(container.textContent).toContain("91 / 250 (36%)");
    expect(button("Save limits")).toBeUndefined();
  });

  it("refuses a non-whole cap locally without a request", async () => {
    const { container } = await renderCard();
    await eventually(() => expect(button("Configure limits")).toBeDefined());
    await click(button("Configure limits"));
    await act(async () =>
      setInput(inputByLabel(container, "Max searchable fields"), "2.5"),
    );
    await click(button("Save limits"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Max searchable fields must be a whole number of 0 or more.",
    );
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("warns that a cap below usage keeps existing fields", async () => {
    const { container } = await renderCard();
    await eventually(() => expect(button("Configure limits")).toBeDefined());
    await click(button("Configure limits"));
    await act(async () =>
      setInput(inputByLabel(container, "Max total fields"), "50"),
    );
    expect(container.textContent).toContain(
      "A cap below current usage keeps every existing field",
    );
  });

  it("renders the server's sentence when the save is refused and keeps the draft", async () => {
    respond = (call) =>
      call.method === "PUT"
        ? json(
            {
              error: {
                code: "invalid_limit",
                message: "max_searchable_fields must be non-negative",
              },
            },
            400,
          )
        : json(LIMITS);
    const { container } = await renderCard();
    await eventually(() => expect(button("Configure limits")).toBeDefined());
    await click(button("Configure limits"));
    const searchable = inputByLabel(container, "Max searchable fields");
    await act(async () => setInput(searchable, "5"));
    await click(button("Save limits"));
    await eventually(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "max_searchable_fields must be non-negative",
      ),
    );
    expect(searchable.value).toBe("5");
    expect(container.textContent).not.toContain("Custom-field limits updated.");
  });

  it("shows a load failure with retry instead of inventing usage", async () => {
    // A non-retryable refusal, so the assertion does not wait out backoff.
    respond = () =>
      json(
        { error: { code: "forbidden", message: "read_subscribers scope required" } },
        403,
      );
    const { container } = await renderCard();
    await eventually(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "read_subscribers scope required",
      ),
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(button("Retry")).toBeDefined();
  });

  it("withholds the editor from non-admins and view-as sessions with the reason", async () => {
    for (const identity of [
      me({ role: "editor", effective_role: "editor" }),
      me({ role: "owner", effective_role: "viewer", viewer_mode: true }),
    ]) {
      const { container } = await renderCard(identity);
      await eventually(() =>
        expect(container.textContent).toContain(
          "Only workspace owners and admins can change these limits.",
        ),
      );
      expect(button("Configure limits")).toBeUndefined();
      for (const root of roots.splice(0)) act(() => root.unmount());
      document.body.innerHTML = "";
    }
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });
});
