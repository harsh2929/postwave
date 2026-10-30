// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// campaigns-86 (merge-variables editor) and campaigns-87 (editable regions) on
// the template edit form. The real api helpers run over a mocked transport, so
// every assertion is a consequence: the PATCH's method, path, If-Match and
// exact `variables` body; the regions GET's path; the region list rendered
// from it; and the exact span "Open HTML editor" selects in the source.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TemplateEditorForm } from "@/app/(dashboard)/app/templates/_components/template-editor-form";
import { ApiError } from "@/lib/api";
import type { CampaignTemplate } from "@/lib/campaign-templates-api";
import {
  byteOffsetToIndex,
  locateRegionInSource,
  regionSourceFormat,
} from "@/lib/template-regions-api";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => {
    throw new Error("unmocked GET");
  }),
  apiPatch: vi.fn(
    async (
      _path: string,
      _body?: unknown,
      _opts?: { headers?: Record<string, string> },
    ): Promise<unknown> => ({}),
  ),
  apiPost: vi.fn(
    async (
      _path: string,
      _body?: unknown,
      _opts?: unknown,
    ): Promise<unknown> => ({}),
  ),
  push: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      get: mocks.apiGet,
      patch: mocks.apiPatch,
      post: mocks.apiPost,
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn() },
}));

vi.mock("@/lib/use-unsaved-changes-guard", () => ({
  useUnsavedChangesGuard: () => undefined,
}));

vi.mock("@/components/editor/editor-shell", async () => {
  const React = await import("react");
  return {
    EditorShell: () =>
      React.createElement("div", { "data-testid": "editor-shell" }),
  };
});

vi.mock(
  "@/app/(dashboard)/app/templates/_components/template-preview",
  async () => {
    const React = await import("react");
    return {
      TemplatePreviewFrame: () =>
        React.createElement("div", { "data-testid": "template-preview" }),
    };
  },
);

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ME = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "owner@example.test",
  role: "owner",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Acme",
  workspace_slug: "acme",
};

// "é" is two UTF-8 bytes but one UTF-16 unit, so the server's byte offset (9)
// and the textarea's string index (8) differ — the conversion is exercised.
const PREFIX = "<p>é</p>";
const REGION_SOURCE = "{{region:hero}}<h1>Hi</h1>{{/region}}";
const BODY_HTML = `${PREFIX}${REGION_SOURCE}<p>tail</p>`;
const REGION = {
  name: "hero",
  default_html: "<h1>Hi</h1>",
  position: new TextEncoder().encode(PREFIX).length,
  length: new TextEncoder().encode(REGION_SOURCE).length,
};

const TEMPLATE: CampaignTemplate = {
  id: "template-1",
  tenant_id: "tenant-1",
  etag: '"template-v1"',
  name: "Weekly digest",
  subject: "This week",
  goal: "newsletter",
  tags: ["weekly"],
  body_html: BODY_HTML,
  body_mjml: "",
  template_kind: "editable",
  variables: [
    { name: "first_name", label: "First name", default: "there", type: "text" },
    { name: "old_code", label: "", default: "" },
  ],
};

const REGIONS_PATH = "/api/v1/campaign-templates/template-1/regions";
let regionsResponse: () => Promise<unknown>;

let root: Root | null = null;

beforeEach(() => {
  regionsResponse = async () => ({ regions: [REGION], count: 1 });
  mocks.apiGet.mockImplementation(async (path: string) => {
    if (path === "/api/v1/auth/me") return ME;
    if (path === REGIONS_PATH) return regionsResponse();
    throw new Error(`unmocked GET ${path}`);
  });
  mocks.apiPatch.mockImplementation(async () => ({ ...TEMPLATE }));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(template: CampaignTemplate = TEMPLATE): void {
  const host = document.createElement("div");
  document.body.append(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root = createRoot(host);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TemplateEditorForm, { intent: "edit", template }),
      ),
    );
  });
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label ||
      candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function input(label: string): HTMLInputElement {
  const match = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!match) throw new Error(`Input not found: ${label}`);
  return match;
}

function setValue(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    control,
    value,
  );
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("template merge-variables editor (campaigns-86)", () => {
  it("saves added, edited, and removed variables in the template PATCH, keeping stored fields", async () => {
    render();
    await flush();

    expect(input("Variable 1 name").value).toBe("first_name");
    expect(input("Variable 2 name").value).toBe("old_code");

    await act(async () => {
      setValue(input("Variable 1 label"), "Greeting name");
    });
    await act(async () => button("Remove variable old_code").click());
    await act(async () => button("Add variable").click());
    await act(async () => {
      // Names are sanitised to letters, digits and underscores as typed.
      setValue(input("Variable 2 name"), "promo code");
      setValue(input("Variable 2 label"), "Promo");
      setValue(input("Variable 2 default content"), "WELCOME");
    });
    expect(input("Variable 2 name").value).toBe("promo_code");

    await act(async () => {
      button("Save changes").click();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.apiPatch).toHaveBeenCalledTimes(1);
    const [path, body, opts] = mocks.apiPatch.mock.calls[0]!;
    expect(path).toBe("/api/v1/campaign-templates/template-1");
    expect(opts?.headers?.["If-Match"]).toBe('"template-v1"');
    expect((body as { variables?: unknown }).variables).toEqual([
      {
        type: "text",
        name: "first_name",
        label: "Greeting name",
        default: "there",
      },
      { name: "promo_code", label: "Promo", default: "WELCOME" },
    ]);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Template updated");
    expect(mocks.push).toHaveBeenCalledWith("/app/templates/template-1");
  });

  it("leaves stored variables untouched when only other fields change", async () => {
    render();
    await flush();
    await act(async () => {
      setValue(
        document.querySelector<HTMLInputElement>("#template-name")!,
        "Renamed digest",
      );
    });
    await act(async () => {
      button("Save changes").click();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.apiPatch).toHaveBeenCalledTimes(1);
    const body = mocks.apiPatch.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.name).toBe("Renamed digest");
    expect("variables" in body).toBe(false);
  });

  it("refuses a duplicate or empty name and says why, sending nothing", async () => {
    render();
    await flush();
    await act(async () => button("Add variable").click());
    await act(async () => setValue(input("Variable 3 name"), "first_name"));
    await act(async () => {
      button("Save changes").click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      'Merge variable "first_name" is listed twice. Variable names must be unique.',
    );

    await act(async () => setValue(input("Variable 3 name"), ""));
    await act(async () => {
      button("Save changes").click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "Every merge variable needs a name of up to 64 letters, numbers, or underscores.",
    );
    expect(mocks.apiPatch).not.toHaveBeenCalled();
  });
});

describe("region offsets (campaigns-87)", () => {
  it("selects MJML when a legacy template has both sources", () => {
    expect(
      regionSourceFormat({ body_html: "<p>old</p>", body_mjml: "<mjml />" }),
    ).toBe("mjml");
    expect(
      regionSourceFormat({ body_html: "<p>only</p>", body_mjml: "" }),
    ).toBe("html");
  });

  it("converts the server's UTF-8 byte offset to a string index", () => {
    expect(byteOffsetToIndex(BODY_HTML, REGION.position)).toBe(PREFIX.length);
    expect(byteOffsetToIndex(BODY_HTML, REGION.position)).not.toBe(
      REGION.position,
    );
    expect(byteOffsetToIndex(BODY_HTML, REGION.position + REGION.length)).toBe(
      PREFIX.length + REGION_SOURCE.length,
    );
  });

  it("trusts the saved offset over name order while the source is unchanged", () => {
    // Ordinal 0 would name the FIRST "hero"; the offset names the second.
    const second = "{{region:hero}}<p>two</p>{{/region}}";
    const source = `${BODY_HTML}${second}`;
    const bytes = new TextEncoder();
    const range = locateRegionInSource(
      source,
      source,
      {
        name: "hero",
        default_html: "<p>two</p>",
        position: bytes.encode(BODY_HTML).length,
        length: bytes.encode(second).length,
      },
      0,
    );
    expect(range && source.slice(range.start, range.end)).toBe(second);
  });
});

describe("template editable regions (campaigns-87)", () => {
  it("lists the saved regions from GET …/regions and opens the HTML editor on the exact region span", async () => {
    render();
    await flush();

    expect(mocks.apiGet).toHaveBeenCalledWith(
      REGIONS_PATH,
      expect.objectContaining({ signal: expect.anything() }),
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("1 editable region in the saved HTML.");
    expect(text).toContain(`offset ${REGION.position}, span ${REGION.length}`);
    expect(text).toContain("<h1>Hi</h1>");

    expect(button("Design (blocks)").disabled).toBe(true);
    expect(document.querySelector("#template-source")).not.toBeNull();

    await act(async () => button("Open HTML editor for region hero").click());
    await flush();

    const source =
      document.querySelector<HTMLTextAreaElement>("#template-source");
    expect(source).not.toBeNull();
    expect(source!.value).toBe(BODY_HTML);
    expect(document.activeElement).toBe(source);
    expect(
      source!.value.slice(source!.selectionStart, source!.selectionEnd),
    ).toBe(REGION_SOURCE);
    expect(source!.selectionStart).toBe(PREFIX.length);
  });

  it("re-finds a region by name once the draft has diverged, and says when it is gone", async () => {
    render();
    await flush();
    const source =
      document.querySelector<HTMLTextAreaElement>("#template-source")!;
    const shifted = `<div>new intro</div>${BODY_HTML}`;
    await act(async () => setValue(source, shifted));
    expect(document.body.textContent).toContain(
      "Your source has unsaved changes.",
    );

    await act(async () => button("Open HTML editor for region hero").click());
    await flush();
    expect(source.selectionStart).toBe(
      "<div>new intro</div>".length + PREFIX.length,
    );
    expect(source.value.slice(source.selectionStart, source.selectionEnd)).toBe(
      REGION_SOURCE,
    );

    await act(async () => setValue(source, "<p>no regions left</p>"));
    await act(async () => button("Open HTML editor for region hero").click());
    expect(document.body.textContent).toContain(
      'Region "hero" is no longer in your HTML source. Save your changes to refresh the saved regions.',
    );
  });

  it("renders a failed or malformed regions read as an error with retry, never as 'no regions'", async () => {
    regionsResponse = async () => {
      throw new ApiError("Template not found.", 404, undefined, {
        code: "not_found",
      });
    };
    render();
    await flush();
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Saved regions could not be loaded");
    expect(alert?.textContent).toContain("Template not found.");
    expect(document.body.textContent).not.toContain("No editable regions");

    regionsResponse = async () => ({ regions: [{ name: "", position: 0 }] });
    await act(async () => button("Retry saved regions").click());
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "The server returned an invalid regions response. No unverified region data was shown.",
    );
    expect(document.body.textContent).not.toContain("No editable regions");
  });

  it("coaches the region syntax when there are none and opens the source editor", async () => {
    regionsResponse = async () => ({ regions: [], count: 0 });
    render({ ...TEMPLATE, body_mjml: "<mjml><mj-body /></mjml>" });
    await flush();
    expect(document.body.textContent).toContain("No editable regions");
    expect(document.querySelector("#template-source")).toBeNull();

    await act(async () => button("Open MJML editor").click());
    await flush();
    const source =
      document.querySelector<HTMLTextAreaElement>("#template-source");
    expect(source?.value).toBe("<mjml><mj-body /></mjml>");
    expect(document.activeElement).toBe(source);
  });
});
