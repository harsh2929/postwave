// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TemplateDetailActions } from "@/app/(dashboard)/app/templates/_components/template-detail-actions";
import type { CampaignTemplate } from "@/lib/campaign-templates-api";

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ARCHIVED_TEMPLATE: CampaignTemplate = {
  id: "template-archived",
  tenant_id: "tenant-demo",
  etag: '"template-v1"',
  archived_at: "2026-08-26T10:00:00Z",
  name: "Lifecycle signal",
  subject: "A useful signal",
  tags: [],
  source: "mine",
  template_kind: "editable",
  capabilities: {
    can_favorite: false,
    can_restore: true,
  },
};

function render(): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(TemplateDetailActions, { template: ARCHIVED_TEMPLATE }),
    ),
  );
  return root;
}

function buttonWithLabel(label: string): HTMLButtonElement {
  const node = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!node) throw new Error(`Button not found: ${label}`);
  return node;
}

function buttonWithText(text: string): HTMLButtonElement {
  const node = Array.from(document.querySelectorAll("button")).find(
    (button): button is HTMLButtonElement =>
      button.textContent?.trim() === text,
  );
  if (!node) throw new Error(`Button not found: ${text}`);
  return node;
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("template detail lifecycle focus", () => {
  it("returns focus to the actions trigger when Restore is cancelled with Escape", async () => {
    const root = render();
    try {
      const trigger = buttonWithLabel("Actions for Lifecycle signal");
      await act(async () => trigger.click());
      await act(async () => buttonWithText("Restore").click());
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      act(() => root.unmount());
    }
  });
});
