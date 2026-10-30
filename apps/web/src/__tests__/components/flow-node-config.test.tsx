// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeConfigPanel } from "@/app/(dashboard)/app/flows/_components/node-config-panel";
import type { CatalogItem, FlowNode } from "@/lib/flows-api";

// The entity picker (FLOW-009: campaign / segment / list / coupon / template
// fields) fetches released lists; stub them so unrelated pickers resolve
// without a network call. Coupon inventory is release-held and must not fetch.
vi.mock("@/lib/segments-api", () => ({
  listSegments: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/campaigns-api", () => ({
  listCampaigns: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/forms-api", () => ({
  listLists: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/campaign-templates-api", () => ({
  listTemplates: vi.fn().mockResolvedValue([]),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const triggerCatalog: CatalogItem[] = [
  {
    key: "subscriber_did_not_open",
    label: "Did not open",
    category: "trigger",
    runtime_status: "partial",
    fields: [
      { key: "campaign_id", type: "string", required: true },
      { key: "after_days", type: "number", required: true },
    ],
  },
];

const nodeCatalog: CatalogItem[] = [
  {
    key: "wait_until_trigger",
    label: "Wait until event",
    category: "wait",
    runtime_status: "supported",
    fields: [{ key: "wait_trigger", type: "trigger", required: true }],
  },
  {
    key: "ab_test",
    label: "A/B test",
    category: "split",
    runtime_status: "supported",
    fields: [{ key: "variants", type: "array", required: true }],
  },
  {
    key: "coupon_assign",
    label: "Assign coupon",
    category: "commerce",
    runtime_status: "supported",
  },
];

function Harness({
  initial,
  readOnly = false,
}: {
  initial: FlowNode;
  readOnly?: boolean;
}) {
  const [node, setNode] = useState(initial);
  return createElement(
    "div",
    null,
    createElement(NodeConfigPanel, {
      node,
      nodes: [node],
      nodeCatalog,
      triggerCatalog,
      conditionFields: [],
      currentNext: "",
      isEntry: true,
      inboundCount: 0,
      requiresReview: false,
      readOnly,
      onChange: (patch) => setNode((current) => ({ ...current, ...patch })),
      onSetNext: () => undefined,
      onMakeEntry: () => undefined,
      onDelete: () => undefined,
      onClose: () => undefined,
    }),
    createElement("pre", { "data-testid": "state" }, JSON.stringify(node)),
  );
}

function mount(node: FlowNode, readOnly = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Harness, { initial: node, readOnly }),
      ),
    ),
  );
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("flow node configuration", () => {
  it("authors a structured wait trigger with every required trigger field", () => {
    const root = mount({ id: "wait_1", type: "wait_until_trigger" });
    const triggerSelect = document.querySelector("select") as HTMLSelectElement;
    act(() => {
      triggerSelect.value = "subscriber_did_not_open";
      triggerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Campaign Id *");
    expect(document.body.textContent).toContain("After Days *");
    expect(document.querySelector('input[type="number"]')).not.toBeNull();
    expect(
      document.querySelector('[data-testid="state"]')?.textContent,
    ).toContain('"wait_trigger":{"type":"subscriber_did_not_open"}');
    act(() => root.unmount());
  });

  it("renders an editor for A/B variants", () => {
    const root = mount({ id: "ab_1", type: "ab_test", variants: [] });
    const add = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add variant"),
    );
    expect(add).toBeDefined();
    act(() => add?.click());
    expect(
      document.querySelector('[data-testid="state"]')?.textContent,
    ).toContain('"variants":[{"id":"v_');
    act(() => root.unmount());
  });

  it("keeps automatic winner promotion visibly release-held", () => {
    const root = mount({
      id: "ab_held",
      type: "ab_test",
      variants: [],
      auto_promote: true,
    });
    const autoPromote = document.querySelector(
      'input[type="checkbox"][aria-describedby]',
    ) as HTMLInputElement;
    expect(autoPromote).not.toBeNull();
    expect(autoPromote.checked).toBe(true);
    expect(autoPromote.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Auto-promote preference (stored only)",
    );
    expect(document.body.textContent).toContain(
      "saving this node does not select or promote a variant",
    );
    act(() => root.unmount());
  });

  it("preserves a saved coupon-pool reference without fetching held inventory", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const root = mount({
      id: "coupon_1",
      type: "coupon_assign",
      metadata: { coupon_pool_id: "pool_42" },
    });
    const select = document.querySelector(
      "select[aria-label='coupon_pool_id']",
    ) as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("pool_42");
    expect(select.querySelector('option[value="pool_42"]')).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Coupon-pool inventory and issuance are not mounted in production",
    );
    expect(document.body.textContent).toContain(
      "The saved reference remains in this flow",
    );
    expect(
      document.querySelector('[data-testid="state"]')?.textContent,
    ).toContain('"metadata":{"coupon_pool_id":"pool_42"}');
    expect(document.body.textContent).not.toContain("Retry");
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("shows an honest hold instead of a false empty or Retry state", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const root = mount({ id: "coupon_1", type: "coupon_assign" });
    const select = document.querySelector(
      "select[aria-label='coupon_pool_id']",
    ) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.textContent).toContain(
      "Coupon pool selection is release-held",
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Retry");
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("keeps saved node settings inspectable but disables every authoring control", () => {
    const root = mount(
      {
        id: "wait_read_only",
        type: "wait_until_trigger",
        wait_trigger: {
          type: "subscriber_did_not_open",
          campaign_id: "campaign_1",
          after_days: 4,
        },
      },
      true,
    );
    const fieldset = document.querySelector("fieldset");
    expect(fieldset?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "This node is read-only for your current flow access",
    );
    for (const control of fieldset?.querySelectorAll(
      "button, input, select, textarea",
    ) ?? []) {
      // Native disabled fieldsets disable every descendant form control in a
      // browser. happy-dom does not reflect that inherited state through the
      // descendant's `:disabled` pseudo-class, so assert the structural gate.
      expect(control.closest("fieldset")?.hasAttribute("disabled")).toBe(true);
    }
    expect(document.querySelector('button[aria-label="Close panel"]')).not.toBe(
      null,
    );
    act(() => root.unmount());
  });
});
