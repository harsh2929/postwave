// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TemplateEditorForm } from "@/app/(dashboard)/app/templates/_components/template-editor-form";
import type { CampaignTemplate } from "@/lib/campaign-templates-api";

const generation = vi.hoisted(() => ({ status: "available" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ children, href }: { children: React.ReactNode; href: string }) =>
      React.createElement("a", { href }, children),
  };
});
vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: () =>
      (props: { editorSource?: boolean; open?: boolean }) =>
        props.editorSource
          ? React.createElement("div", {
              "data-testid": "editor-ai-dialog",
              "data-open": String(props.open),
            })
          : null,
  };
});
vi.mock("@/components/editor/editor-shell", () => ({
  EditorShell: () => null,
}));
vi.mock("@/lib/use-template-generation-availability", () => ({
  useTemplateGenerationAvailability: () => generation.status,
}));
vi.mock("@/app/(dashboard)/app/templates/_components/template-preview", () => ({
  TemplatePreviewFrame: () => null,
}));
vi.mock("@/app/(dashboard)/app/templates/_components/template-asset-picker", () => ({
  TemplateAssetPicker: () => null,
}));
vi.mock("@/app/(dashboard)/app/templates/_components/template-preflight-card", () => ({
  TemplatePreflightCard: () => null,
}));
vi.mock("@/app/(dashboard)/app/templates/_components/template-regions-panel", () => ({
  TemplateRegionsPanel: () => null,
}));
vi.mock("@/app/(dashboard)/app/templates/_components/template-variables-editor", () => ({
  TemplateVariablesEditor: () => null,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const template = {
  id: "template-1",
  tenant_id: "tenant-1",
  name: "Weekly notes",
  subject: "This week",
  body_html: "<html><body><p>Saved source</p></body></html>",
  body_mjml: "",
  source: "mine",
  template_kind: "editable",
  etag: '"template-v1"',
  capabilities: { can_adapt: true, can_edit_directly: true },
} as unknown as CampaignTemplate;

let root: Root;

beforeEach(() => {
  generation.status = "available";
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  window.localStorage.clear();
  vi.clearAllMocks();
});

function aiButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.includes("Describe a change"),
  );
  if (!button) throw new Error("Missing AI edit action");
  return button;
}

describe("saved template AI edit boundary", () => {
  it("shows a non-actionable coming-soon state when generation is unavailable", async () => {
    generation.status = "unavailable";
    await act(async () => {
      root.render(createElement(TemplateEditorForm, {
        intent: "edit", template,
        recoveryScope: { tenantId: "tenant-1", userId: "actor-1" },
      }));
    });
    const button = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent?.includes("AI changes · Coming soon"),
    );
    expect(button?.disabled).toBe(true);
  });

  it("opens only for a clean saved version and locks as soon as the draft changes", async () => {
    await act(async () => {
      root.render(
        createElement(TemplateEditorForm, {
          intent: "edit",
          template,
          recoveryScope: { tenantId: "tenant-1", userId: "actor-1" },
        }),
      );
    });
    expect(aiButton().disabled).toBe(false);
    await act(async () => aiButton().click());
    expect(
      document.querySelector("[data-testid='editor-ai-dialog']")?.getAttribute(
        "data-open",
      ),
    ).toBe("true");
    const name = document.querySelector<HTMLInputElement>("#template-name")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
        ?.set?.call(name, "Changed but unsaved");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(aiButton().disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Save changes before using AI",
    );
  });
});
