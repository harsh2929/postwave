// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// commerce-45 — review-widget authoring under the REAL (unmocked) release
// policy: REVIEW_WIDGET_AUTHORING_AVAILABLE is false, exactly as desktop's
// WidgetsTab withholds it. Every control must stay visible, disabled, and
// described by the policy's own sentence; nothing may reach the network from
// the form or from the transport.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewWidgetAuthoring } from "@/app/(dashboard)/app/reviews/_components/widget-authoring-form";
import { createReviewWidget } from "@/lib/reviews-api";
import {
  REVIEW_WIDGET_AUTHORING_AVAILABLE,
  REVIEW_WIDGET_AUTHORING_UNAVAILABLE_REASON,
} from "@/lib/reviews-operational-availability";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
}

async function render(canAdmin: boolean): Promise<HTMLElement> {
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
        <ReviewWidgetAuthoring
          canAdmin={canAdmin}
          widgetTypes={["star_rating", "summary"]}
          keyBase={["reviews", "t", "owner"]}
        />
      </QueryClientProvider>,
    );
  });
  return container;
}

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ReviewWidgetAuthoring under the shipped release policy", () => {
  it("is the policy this file pins", () => {
    expect(REVIEW_WIDGET_AUTHORING_AVAILABLE).toBe(false);
  });

  it("renders every control disabled, described by the reason, and sends nothing", async () => {
    const container = await render(true);
    const note = container.querySelector('[role="note"]');
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("Widget authoring is review-gated");
    expect(note!.textContent).toContain(
      REVIEW_WIDGET_AUTHORING_UNAVAILABLE_REASON,
    );
    expect(note!.textContent).toContain(
      "An administrator can monitor the inventory while the complete lifecycle is implemented.",
    );

    const controls = [
      ...container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        "input, select",
      ),
    ];
    expect(controls.length).toBe(4);
    for (const control of controls) {
      expect(control.disabled, control.id).toBe(true);
      expect(control.getAttribute("aria-describedby"), control.id).toBe(
        note!.id,
      );
    }
    const submit = button("Create widget");
    expect(submit).toBeDefined();
    expect(submit!.disabled).toBe(true);
    expect(submit!.getAttribute("aria-describedby")).toBe(note!.id);

    await act(async () => {
      submit!.click();
      container.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tells a read-only role so, instead of implying an admin could author", async () => {
    const container = await render(false);
    const note = container.querySelector('[role="note"]');
    expect(note!.textContent).toContain("Your current role is read-only.");
    expect(button("Create widget")!.disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses the held write in the transport before any request", async () => {
    await expect(
      createReviewWidget({
        name: "Storefront stars",
        widget_type: "star_rating",
        status: "draft",
      }),
    ).rejects.toMatchObject({
      code: "review_widget_authoring_unavailable",
      status: 503,
      message: REVIEW_WIDGET_AUTHORING_UNAVAILABLE_REASON,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
