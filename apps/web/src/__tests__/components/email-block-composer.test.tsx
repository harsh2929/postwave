// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  compose: vi.fn(),
  fresh: vi.fn(),
}));
vi.mock("@/lib/workspace-ops-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-ops-api")>()),
  getEmailBlockCatalog: mocks.catalog,
  composeEmailBlocks: mocks.compose,
}));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: mocks.fresh,
}));

import { EmailBlockComposer } from "@/app/(dashboard)/app/campaigns/[id]/email-block-composer";
import type { MeResponse } from "@/lib/auth-api";

const identity: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "owner@example.test",
  role: "owner",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Test",
  workspace_slug: "test",
};
const catalog = {
  brand: {
    primary_color: "#123456",
    body_font: "Arial",
    heading_font: "Arial",
    background_color: "#ffffff",
  },
  blocks: [
    {
      id: "text",
      name: "Text",
      category: "content",
      description: "Text block",
      fields: [{ key: "content", label: "Content", type: "text", options: [], help: "" }],
      defaults: { content: "Hello" },
    },
  ],
};

beforeEach(() => {
  document.body.replaceChildren();
  mocks.catalog.mockReset().mockResolvedValue(catalog);
  mocks.compose.mockReset();
  mocks.fresh.mockReset().mockResolvedValue(identity);
});
afterEach(() => document.body.replaceChildren());

async function render(overrides: Partial<MeResponse> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <EmailBlockComposer
        identity={{ ...identity, ...overrides }}
        subject="Launch"
        onApply={vi.fn()}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button ${label}`);
  return match;
}

describe("campaign email block composer", () => {
  it("drops a compose response when a block changes while it is in flight", async () => {
    let release!: (value: { mjml: string; warnings: string[] }) => void;
    mocks.compose.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { container, root } = await render();
    try {
      await act(async () => button(container, "Add block").click());
      await act(async () => button(container, "Compose MJML").click());
      const input = container.querySelector<HTMLInputElement>("#catalog-0-content");
      await act(async () => {
        if (!input) throw new Error("Missing content field");
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, "Changed");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        release({ mjml: "<mjml><mj-body /></mjml>", warnings: [] });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(container.textContent).not.toContain("Composition is current");
      expect(button(container, "Apply composed MJML").disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps viewer mode read-only and never calls compose", async () => {
    const { container, root } = await render({ viewer_mode: true });
    try {
      expect(button(container, "Add block").disabled).toBe(true);
      expect(button(container, "Compose MJML").disabled).toBe(true);
      expect(container.textContent).toContain("Editor access outside viewer mode");
      expect(mocks.compose).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
