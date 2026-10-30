// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TemplateEditorForm } from "@/app/(dashboard)/app/templates/_components/template-editor-form";
import type { CampaignTemplate } from "@/lib/campaign-templates-api";
import {
  templateRecoveryKey,
  writeTemplateRecovery,
} from "@/lib/template-editor-recovery";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  guard: vi.fn(),
  editorProps: null as Record<string, unknown> | null,
  compile: vi.fn(),
  workspaceSettingsGet: vi.fn(),
}));

vi.mock("@/components/editor/compile-mjml", () => ({
  compileMjmlSource: mocks.compile,
}));

vi.mock("@/lib/content-library-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content-library-api")>()),
  listSavedBlocks: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }),
}));

vi.mock("@/lib/workspace-settings-api", () => ({
  workspaceSettingsApi: {
    get: mocks.workspaceSettingsGet,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/use-unsaved-changes-guard", () => ({
  useUnsavedChangesGuard: (dirty: boolean) => mocks.guard(dirty),
}));

vi.mock("@/lib/campaign-templates-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/campaign-templates-api")>();
  return {
    ...actual,
    createCampaignTemplate: mocks.create,
    updateCampaignTemplate: mocks.update,
  };
});

vi.mock("@/components/editor/editor-shell", async () => {
  const React = await import("react");
  return {
    EditorShell: (props: Record<string, unknown>) => {
      mocks.editorProps = props;
      return React.createElement("div", { "data-testid": "editor-shell" });
    },
  };
});

vi.mock(
  "@/app/(dashboard)/app/templates/_components/template-asset-picker",
  async () => {
    const React = await import("react");
    return {
      TemplateAssetPicker: ({
        open,
        onInsert,
      }: {
        open: boolean;
        onInsert: (url: string, alt: string) => void;
      }) =>
        open
          ? React.createElement(
              "button",
              {
                type: "button",
                onClick: () =>
                  onInsert(
                    "https://cdn.moosewave.com/a.png?x=1&y=2",
                    'A "bright" <wave>',
                  ),
              },
              "Use test image",
            )
          : null,
    };
  },
);

vi.mock(
  "@/app/(dashboard)/app/templates/_components/template-preview",
  async () => {
    const React = await import("react");
    return {
      TemplatePreviewFrame: ({ html }: { html: string }) =>
        React.createElement("div", { "data-testid": "template-preview" }, html),
    };
  },
);

// The saved-regions panel reads through TanStack Query; its behaviour is
// covered in template-variables-regions.test.tsx. Stub it so this file stays
// about the form's save boundary without a QueryClient.
vi.mock(
  "@/app/(dashboard)/app/templates/_components/template-regions-panel",
  () => ({ TemplateRegionsPanel: () => null }),
);

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TEMPLATE: CampaignTemplate = {
  id: "template-1",
  tenant_id: "tenant-1",
  etag: '"template-v1"',
  name: "Weekly digest",
  subject: "This week",
  goal: "newsletter",
  tags: ["team:editorial", "weekly"],
  body_html: "<p>Stored compiled HTML</p>",
  body_mjml: "<mjml><mj-body /></mjml>",
  template_kind: "editable",
};
const HTML_TEMPLATE: CampaignTemplate = { ...TEMPLATE, body_mjml: "" };

let root: Root | null = null;

beforeEach(() => {
  mocks.editorProps = null;
  mocks.compile.mockResolvedValue({ html: "<p>Compiled MJML</p>", errors: [] });
  mocks.workspaceSettingsGet.mockRejectedValue(new Error("Workspace brand not in this fixture"));
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  vi.clearAllMocks();
  document.body.innerHTML = "";
  sessionStorage.clear();
});

function renderTemplate(template: CampaignTemplate = TEMPLATE): void {
  act(() => {
    root?.render(
      createElement(TemplateEditorForm, { intent: "edit", template }),
    );
  });
}

function latestDirty(): boolean | undefined {
  return mocks.guard.mock.calls.at(-1)?.[0] as boolean | undefined;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function setControlValue(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : control instanceof HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new Error("Native value setter is unavailable");
  setter.call(control, value);
  control.dispatchEvent(
    new Event(control instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }),
  );
}

describe("TemplateEditorForm unsaved state", () => {
  it("starts a block design in a new template without replacing imported HTML", async () => {
    mocks.create.mockResolvedValue({ id: "block-copy-1" });
    renderTemplate(HTML_TEMPLATE);
    await act(async () => button("Make an editable block copy").click());
    await act(async () => {
      button("Create block copy").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      name: "Weekly digest · Block design",
      subject: HTML_TEMPLATE.subject,
      tags: ["weekly"],
      body_html: "",
      body_mjml: "",
    }));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith("/app/templates/block-copy-1/edit");
  });

  it("offers current workspace brand blocks without rewriting the saved design", async () => {
    mocks.workspaceSettingsGet.mockResolvedValueOnce({
      tenant_id: "tenant-1",
      timezone: "UTC",
      date_format: "YYYY-MM-DD",
      display_name: "Northstar",
      brand_color: "#123456",
    });
    await act(async () => {
      root?.render(createElement(TemplateEditorForm, { intent: "edit", template: TEMPLATE }));
    });
    const blocks = mocks.editorProps?.workspaceBlocks as Array<{ id: string; source: string }>;
    expect(blocks.map((block) => block.id)).toContain("brand-header");
    expect(blocks.find((block) => block.id === "brand-header")?.source).toContain("Northstar");
    expect(mocks.editorProps?.initialMjml).toBe(TEMPLATE.body_mjml);
    expect(latestDirty()).toBe(false);
  });

  it("passes authoritative HTML and keeps Blocks edits dirty after live props update", async () => {
    renderTemplate();

    expect(latestDirty()).toBe(false);
    expect(mocks.editorProps?.initialHtml).toBe("<p>Stored compiled HTML</p>");

    const onMjmlChange = mocks.editorProps?.onMjmlChange as
      | ((mjml: string, html: string) => void)
      | undefined;
    await act(async () => {
      onMjmlChange?.(
        "<mjml><mj-body><mj-text>Changed</mj-text></mj-body></mjml>",
        "<p>Changed compiled HTML</p>",
      );
    });

    expect(mocks.editorProps?.initialHtml).toBe("<p>Changed compiled HTML</p>");
    expect(latestDirty()).toBe(true);
  });

  it("keeps an uncompiled block edit when switching immediately to source", async () => {
    renderTemplate();
    const onSourceChange = mocks.editorProps?.onMjmlSourceChange as
      | ((mjml: string) => void)
      | undefined;
    await act(async () => onSourceChange?.("<mjml>uncompiled edit</mjml>"));
    expect(latestDirty()).toBe(true);
    await act(async () => button("Code / import").click());
    expect(
      document.querySelector<HTMLTextAreaElement>("#template-source")?.value,
    ).toBe("<mjml>uncompiled edit</mjml>");
  });

  it("guards metadata and both raw-code formats against navigation", async () => {
    renderTemplate();

    const name = document.querySelector<HTMLInputElement>("#template-name");
    const subject =
      document.querySelector<HTMLInputElement>("#template-subject");
    const goal = document.querySelector<HTMLSelectElement>("#template-goal");
    const tags = document.querySelector<HTMLInputElement>("#template-tags");
    expect(name && subject && goal && tags).toBeTruthy();

    await act(async () => {
      setControlValue(name!, "Renamed digest");
      setControlValue(subject!, "A new subject");
      setControlValue(goal!, "announcement");
      setControlValue(tags!, "weekly, launch");
    });
    expect(latestDirty()).toBe(true);

    await act(async () => {
      setControlValue(name!, TEMPLATE.name);
      setControlValue(subject!, TEMPLATE.subject);
      setControlValue(goal!, TEMPLATE.goal!);
      setControlValue(tags!, "weekly");
    });
    expect(latestDirty()).toBe(false);

    await act(async () => button("Code / import").click());
    const source =
      document.querySelector<HTMLTextAreaElement>("#template-source");
    expect(source?.value).toBe(TEMPLATE.body_mjml);
    await act(async () => setControlValue(source!, "<mjml>Edited</mjml>"));
    expect(latestDirty()).toBe(true);

    await act(async () => setControlValue(source!, TEMPLATE.body_mjml!));
    // The legacy compiled HTML has been retired; that normalization itself is
    // a pending change even after the MJML text returns to its old value.
    expect(latestDirty()).toBe(true);
    await act(async () => button("HTML").click());
    expect(source?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Convert its current render");
  });

  it("submits one complete save under rapid activation and clears the baseline", async () => {
    let releaseUpdate: ((template: CampaignTemplate) => void) | undefined;
    mocks.update.mockImplementation(
      () =>
        new Promise<CampaignTemplate>((resolve) => {
          releaseUpdate = resolve;
        }),
    );
    renderTemplate(HTML_TEMPLATE);

    const name = document.querySelector<HTMLInputElement>("#template-name");
    await act(async () => setControlValue(name!, "Launch digest"));
    expect(latestDirty()).toBe(true);

    const save = button("Save changes");
    await act(async () => {
      save.click();
      save.click();
      await Promise.resolve();
    });

    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(
      TEMPLATE.id,
      {
        name: "Launch digest",
        subject: TEMPLATE.subject,
        goal: TEMPLATE.goal,
        tags: ["team:editorial", "weekly"],
        preview_text: "",
        description: "",
        category: "",
        body_html: HTML_TEMPLATE.body_html,
        body_mjml: "",
      },
      TEMPLATE.etag,
    );
    expect(document.querySelector('button[aria-busy="true"]')).not.toBeNull();

    await act(async () => {
      releaseUpdate?.({ ...TEMPLATE, name: "Launch digest" });
      await Promise.resolve();
    });

    expect(latestDirty()).toBe(false);
    expect(mocks.push).toHaveBeenCalledWith(`/app/templates/${TEMPLATE.id}`);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("keeps the navigation guard armed when persistence fails", async () => {
    mocks.update.mockRejectedValueOnce(new Error("network unavailable"));
    renderTemplate(HTML_TEMPLATE);

    const subject =
      document.querySelector<HTMLInputElement>("#template-subject");
    await act(async () => setControlValue(subject!, "Unsaved subject"));
    expect(latestDirty()).toBe(true);

    await act(async () => {
      button("Save changes").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.update).toHaveBeenCalledOnce();
    expect(latestDirty()).toBe(true);
    expect(document.body.textContent).toContain("network unavailable");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("saves MJML as the sole source after editing a legacy dual-source template", async () => {
    mocks.update.mockResolvedValue({ ...TEMPLATE, body_html: "" });
    renderTemplate();
    await act(async () => button("Code / import").click());
    await act(async () => {
      button("Save changes").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.compile).toHaveBeenCalledWith(
      TEMPLATE.body_mjml,
      expect.any(AbortSignal),
    );
    expect(mocks.update).toHaveBeenCalledWith(
      TEMPLATE.id,
      expect.objectContaining({ body_html: "", body_mjml: TEMPLATE.body_mjml }),
      TEMPLATE.etag,
    );
  });

  it("offers a version-scoped unsaved browser draft without silently replacing the server copy", async () => {
    const recoveryScope = { tenantId: "tenant-1", userId: "user-1" };
    const key = templateRecoveryKey({
      ...recoveryScope,
      templateId: HTML_TEMPLATE.id,
      etag: HTML_TEMPLATE.etag,
    });
    writeTemplateRecovery(sessionStorage, key, {
      name: "Recovered digest",
      subject: HTML_TEMPLATE.subject,
      previewText: "",
      description: "",
      category: "",
      goal: "newsletter",
      tagsInput: "weekly",
      bodyHtml: HTML_TEMPLATE.body_html!,
      bodyMjml: "",
      variables: "[]",
    });
    await act(async () => {
      root?.render(
        createElement(TemplateEditorForm, {
          intent: "edit",
          template: HTML_TEMPLATE,
          recoveryScope,
        }),
      );
    });
    expect(
      document.querySelector<HTMLInputElement>("#template-name")?.value,
    ).toBe(HTML_TEMPLATE.name);
    expect(document.body.textContent).toContain(
      "unsaved draft from this browser",
    );
    await act(async () => button("Restore draft").click());
    expect(
      document.querySelector<HTMLInputElement>("#template-name")?.value,
    ).toBe("Recovered digest");
    expect(latestDirty()).toBe(true);
    window.dispatchEvent(new Event("pagehide"));
    expect(sessionStorage.getItem(key)).toContain("Recovered digest");
  });

  it("inserts a hosted image with escaped attributes and keeps HTML authoritative", async () => {
    renderTemplate(HTML_TEMPLATE);
    await act(async () => button("Insert library image").click());
    await act(async () => button("Use test image").click());
    const source =
      document.querySelector<HTMLTextAreaElement>("#template-source");
    expect(source?.value).toContain(
      'src="https://cdn.moosewave.com/a.png?x=1&amp;y=2"',
    );
    expect(source?.value).toContain('alt="A &quot;bright&quot; &lt;wave&gt;"');
    expect(latestDirty()).toBe(true);
  });

  it("imports MJML only after confirming replacement of the current HTML source", async () => {
    renderTemplate(HTML_TEMPLATE);
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Import HTML or MJML file"]',
    )!;
    const file = new File(["<mjml><mj-body /></mjml>"], "new-design.mjml", {
      type: "text/plain",
    });
    Object.defineProperty(file, "text", {
      value: async () => "<mjml><mj-body /></mjml>",
    });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      document.querySelector<HTMLTextAreaElement>("#template-source")?.value,
    ).toBe(HTML_TEMPLATE.body_html);
    await act(async () => button("Replace source").click());
    expect(
      document.querySelector<HTMLTextAreaElement>("#template-source")?.value,
    ).toBe("<mjml><mj-body /></mjml>");
    expect(latestDirty()).toBe(true);
  });
});
