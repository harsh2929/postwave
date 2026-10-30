// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { UTMTemplate } from "../../lib/api-client";

vi.mock("../../components/Modal", () => ({
  Modal: ({
    children,
    open,
    title,
  }: {
    children: ReactNode;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
}));

import { UTMTemplatesView } from "../../components/composer/UTMTemplatesView";
import type { UTMTemplatesController } from "../../components/composer/useUTMTemplatesController";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function template(overrides: Partial<UTMTemplate> = {}): UTMTemplate {
  return {
    id: "template-1",
    is_default: true,
    enabled: true,
    utm_source: "newsletter",
    created_at: "2026-07-16T09:00:00.000Z",
    updated_at: "2026-07-16T09:00:00.000Z",
    ...overrides,
  };
}

function controller(
  overrides: Partial<UTMTemplatesController> = {},
): UTMTemplatesController {
  return {
    applyToCampaign: vi.fn().mockResolvedValue(undefined),
    canEditTemplates: true,
    canMutate: true,
    closeDelete: vi.fn(),
    deleteTarget: null,
    deleteTemplate: vi.fn().mockResolvedValue(undefined),
    discardConfirmOpen: false,
    discardDraft: vi.fn(),
    form: {
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "",
      utm_term: "",
      utm_content: "",
    },
    formHasValue: true,
    load: vi.fn().mockResolvedValue(undefined),
    loadError: null,
    loading: false,
    loadTemplate: vi.fn(),
    mutation: null,
    operationActive: false,
    preview: null,
    previewError: null,
    previewing: false,
    previewUrl: "https://example.test/launch",
    runPreview: vi.fn().mockResolvedValue(undefined),
    keepEditing: vi.fn(),
    requestClose: vi.fn().mockReturnValue(true),
    saveDefault: vi.fn().mockResolvedValue(undefined),
    selectDelete: vi.fn(),
    setFormValue: vi.fn(),
    setPreviewUrl: vi.fn(),
    templates: [template()],
    templatesGateTitle: "UTM template changes need an admin role",
    ...overrides,
  };
}

function renderView(value: UTMTemplatesController): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <UTMTemplatesView
        campaignId="campaign-1"
        controller={value}
        onClose={vi.fn()}
        open
      />,
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("UTMTemplatesView", () => {
  it("renders exact template provenance and delegates row actions", () => {
    const value = controller({
      templates: [
        template(),
        template({
          id: "template-2",
          campaign_id: "campaign-1",
          is_default: false,
          utm_source: "launch",
        }),
      ],
    });
    renderView(value);

    expect(document.body.textContent).toContain("Default");
    expect(document.body.textContent).toContain("This campaign");
    expect(document.body.textContent).toContain("utm_source=newsletter");
    act(() => button("Load").click());
    expect(value.loadTemplate).toHaveBeenCalledWith(value.templates?.[0]);
    const deleteButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((candidate) => candidate.textContent?.trim() === "Delete");
    act(() => deleteButtons[1]?.click());
    expect(value.selectDelete).toHaveBeenCalledWith(value.templates?.[1]);
  });

  it("shows honest loading/errors and wires retry", () => {
    const value = controller({
      loadError: "database unavailable",
      templates: null,
    });
    renderView(value);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "database unavailable",
    );
    act(() => button("Retry").click());
    expect(value.load).toHaveBeenCalledTimes(1);
  });

  it("keeps restricted mutations focusable, visibly explained, inert, and axe-clean", async () => {
    const value = controller({
      canEditTemplates: false,
      templatesGateTitle: "UTM template changes need an admin role",
    });
    renderView(value);

    expect(button("Delete").disabled).toBe(false);
    expect(button("Delete").getAttribute("aria-disabled")).toBe("true");
    expect(button("Save as tenant default").disabled).toBe(false);
    expect(button("Save as tenant default").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(button("Apply to this campaign").disabled).toBe(false);
    expect(button("Apply to this campaign").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(document.body.textContent).toContain(
      "UTM template changes need an admin role",
    );
    expect(button("Preview").disabled).toBe(false);
    act(() => {
      button("Delete").click();
      button("Save as tenant default").click();
      button("Apply to this campaign").click();
    });
    expect(value.selectDelete).not.toHaveBeenCalled();
    expect(value.saveDefault).not.toHaveBeenCalled();
    expect(value.applyToCampaign).not.toHaveBeenCalled();
    expect(document.querySelector("[title]")).toBeNull();

    const result = await axe.run(container ?? document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("renders preview provenance and delegates bounded form changes", () => {
    const value = controller({
      preview: {
        original: "https://example.test/launch",
        rewritten: "https://example.test/launch?utm_source=newsletter",
        template: template({ id: "", enabled: false }),
      },
    });
    renderView(value);
    expect(document.body.textContent).toContain("No UTM template applies");
    expect(document.body.textContent).toContain("utm_source=newsletter");

    const source = document.querySelector<HTMLInputElement>("#utm-utm_source");
    expect(source?.maxLength).toBe(256);
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(source, "product");
      source?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(value.setFormValue).toHaveBeenCalledWith("utm_source", "product");
  });
});
