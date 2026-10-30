// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// commerce-45 — review-widget authoring with the release hold simulated as
// LIFTED (the availability module is mocked to true). Proves the verb is
// complete behind the gate: the exact POST /api/v1/reviews/widgets request the
// form sends, the inventory refresh it triggers, and that the admin gate still
// holds when the release gate does not.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewWidgetAuthoring } from "@/app/(dashboard)/app/reviews/_components/widget-authoring-form";
import { setOnlineStatusForTest } from "@/lib/online-manager";

vi.mock("@/lib/reviews-operational-availability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/reviews-operational-availability")
  >()),
  REVIEW_WIDGET_AUTHORING_AVAILABLE: true,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Recorded {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

const roots: Root[] = [];
let calls: Recorded[];
const KEY_BASE = ["reviews", "tenant-1", "owner"] as const;

function button(label: string): HTMLButtonElement {
  const node = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(node instanceof HTMLButtonElement)) throw new Error(`no ${label}`);
  return node;
}

function setValue(
  el: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  const proto =
    el.tagName === "SELECT"
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(canAdmin: boolean) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ReviewWidgetAuthoring
          canAdmin={canAdmin}
          widgetTypes={["star_rating", "summary"]}
          keyBase={KEY_BASE}
        />
      </QueryClientProvider>,
    );
  });
  return { container, invalidate };
}

beforeEach(() => {
  setOnlineStatusForTest("online");
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const url = new URL(raw, "http://localhost");
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const record: Recorded = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers,
      };
      calls.push(record);
      if (record.method === "POST" && record.path === "/api/v1/reviews/widgets") {
        const body = record.body as Record<string, string>;
        return new Response(
          JSON.stringify({
            id: "w-new",
            slug: "storefront-stars",
            name: body.name,
            status: body.status,
            widget_type: body.widget_type,
            language: body.language ?? "en",
            public_url: "",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("ReviewWidgetAuthoring with the release hold lifted", () => {
  it("POSTs the exact widget and refreshes the inventory", async () => {
    const { container, invalidate } = await render(true);
    expect(container.querySelector('[role="note"]')).toBeNull();

    const [name, language] = [
      ...container.querySelectorAll<HTMLInputElement>("input"),
    ];
    const [type, status] = [
      ...container.querySelectorAll<HTMLSelectElement>("select"),
    ];
    expect(name.disabled).toBe(false);
    expect(button("Create widget").disabled).toBe(true); // empty name

    setValue(name, "  Storefront stars ");
    setValue(type, "star_rating");
    setValue(status, "draft");
    setValue(language, "de");
    expect(button("Create widget").disabled).toBe(false);

    await act(async () => {
      container.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/reviews/widgets",
      body: {
        name: "Storefront stars",
        widget_type: "star_rating",
        status: "draft",
        language: "de",
      },
    });
    expect(writes[0].headers["content-type"]).toBe("application/json");
    expect(typeof writes[0].headers["idempotency-key"]).toBe("string");

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [...KEY_BASE, "widgets"],
    });
    expect(name.value).toBe("");
  });

  it("keeps the admin gate when the release gate is open", async () => {
    const { container } = await render(false);
    const note = container.querySelector('[role="note"]');
    expect(note!.textContent).toContain(
      "Only workspace owners and admins can create review widgets.",
    );
    const name = container.querySelector<HTMLInputElement>("input")!;
    expect(name.disabled).toBe(true);
    expect(name.getAttribute("aria-describedby")).toBe(note!.id);
    expect(button("Create widget").disabled).toBe(true);
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle(2);
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });
});
