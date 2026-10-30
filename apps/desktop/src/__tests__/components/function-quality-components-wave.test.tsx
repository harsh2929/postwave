// @vitest-environment happy-dom

import { readFileSync } from "node:fs";

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  compose: vi.fn(),
  deleteDictionaryEntry: vi.fn(),
  exportDictionaryCSV: vi.fn(),
  getSettings: vi.fn(),
  getWorkspaceSettings: vi.fn(),
  importDictionaryCSV: vi.fn(),
  listDictionary: vi.fn(),
  preview: vi.fn(),
  putSettings: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  upsertDictionaryEntry: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  emailBlocksApi: {
    catalog: mocks.catalog,
    compose: mocks.compose,
  },
  getWorkspaceSettings: mocks.getWorkspaceSettings,
  translationsApi: {
    deleteDictionaryEntry: mocks.deleteDictionaryEntry,
    exportDictionaryCSV: mocks.exportDictionaryCSV,
    getSettings: mocks.getSettings,
    importDictionaryCSV: mocks.importDictionaryCSV,
    listDictionary: mocks.listDictionary,
    preview: mocks.preview,
    putSettings: mocks.putSettings,
    upsertDictionaryEntry: mocks.upsertDictionaryEntry,
  },
}));

vi.mock("../../components/EmailPreviewTabs", () => ({
  EmailPreviewTabs: ({ body }: { body: string }) => <div>{body}</div>,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { BlockEditor } from "../../components/composer/BlockEditor";
import { TranslationsPanel } from "../../components/composer/TranslationsPanel";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalog.mockResolvedValue({
    data: {
      brand: {
        primary_color: "#112233",
        background_color: "#ffffff",
        body_font: "Inter",
        heading_font: "Inter",
      },
      blocks: [
        {
          id: "hero",
          name: "Hero",
          category: "Content",
          description: "A prominent campaign introduction.",
          fields: [
            {
              key: "headline",
              label: "Headline",
              type: "text",
            },
          ],
          defaults: { headline: "Welcome" },
        },
      ],
    },
  });
  mocks.compose.mockResolvedValue({
    data: { mjml: "<mjml />", warnings: [] },
  });
  mocks.getWorkspaceSettings.mockResolvedValue({
    data: { brand_color: "#445566" },
  });
  mocks.getSettings.mockResolvedValue({
    data: {
      enabled: false,
      default_locale: "en",
      supported_locales: ["fr"],
      fallback_strategy: "subscriber_locale",
      locale_attribute: "locale",
    },
  });
  mocks.listDictionary.mockResolvedValue({ data: { entries: [] } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error("Missing button: " + label);
  return match;
}

function setValue(element: HTMLInputElement, value: string): void {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value",
    );
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("function-quality component interactions", () => {
  it("exposes block descriptions, disclosure relationships, and disabled reasons", async () => {
    render(
      <BlockEditor
        instances={[{ block_id: "hero", config: { headline: "Welcome" } }]}
        onInstancesChange={vi.fn()}
        onApply={vi.fn()}
        canMutate={false}
      />,
    );
    await flush();

    const picker = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Block to add"]',
    );
    expect(picker?.getAttribute("aria-describedby")).toBe(
      "block-to-add-description",
    );
    expect(
      document.getElementById("block-to-add-description")?.textContent,
    ).toContain("prominent campaign introduction");

    const disclosure = button("Edit fields for Hero");
    const panelId = disclosure.getAttribute("aria-controls");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId!)?.hidden).toBe(true);
    act(() => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(panelId!)?.hidden).toBe(false);

    const apply = button("Apply to body");
    expect(apply.disabled).toBe(true);
    const reasonId = apply.getAttribute("aria-describedby");
    expect(document.getElementById(reasonId!)?.textContent).toContain(
      "Viewer role",
    );
  });

  it("requires explicit confirmation before closing a dirty translation draft", async () => {
    const onClose = vi.fn();
    render(
      <TranslationsPanel
        open
        onClose={onClose}
        body="<p>Original</p>"
        canMutate
        canAdmin={false}
      />,
    );
    await flush();

    expect(document.body.textContent).toContain(
      "Translation settings need an admin role.",
    );
    expect(
      document.getElementById("translation-csv-format")?.textContent,
    ).toContain("CSV columns");

    const term = document.getElementById("tr-term");
    expect(term).toBeInstanceOf(HTMLInputElement);
    setValue(term as HTMLInputElement, "Moosewave");
    act(() => button("Close").click());

    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Discard translation changes?");
    await act(async () => {
      button("Discard changes").click();
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("leaves dictionary loading with an actionable error after a thrown request", async () => {
    mocks.listDictionary.mockRejectedValueOnce(new Error("offline"));
    render(
      <TranslationsPanel
        open
        onClose={vi.fn()}
        body="<p>Original</p>"
        canMutate
        canAdmin
      />,
    );
    await flush();

    expect(document.body.textContent).toContain(
      "The dictionary request did not complete.",
    );
    expect(button("Retry")).toBeTruthy();
  });

  it("keeps the Templates decomposition and async-safety contracts explicit", () => {
    const templates = readFileSync("src/pages/Templates.tsx", "utf8");
    const templatesView = readFileSync(
      "src/components/templates/TemplatesLibraryView.tsx",
      "utf8",
    );
    const templateStyles = readFileSync("src/styles-templates-v2.css", "utf8");
    const budgets = readFileSync(
      "scripts/function-quality-budgets.json",
      "utf8",
    );

    expect(templates).toContain("function useTemplateLibraryController(");
    expect(templates).toContain("onRecentViewRecorded: () => void");
    expect(templates).toContain("identityScope: string | null");
    expect(templates).toContain("requestId !== listSequence.current");
    expect(templates).toContain("api.getCampaignTemplate(id)");
    expect(templates).toContain("favoriteBusyIds");
    expect(templateStyles).toContain("background: var(--pw-bg-elev-2)");
    expect(templatesView).not.toContain("var(--pw-surface-subtle)");
    expect(templates).not.toContain("var(--pw-surface-subtle)");
    expect(budgets).not.toContain('"src/pages/Templates.tsx"');
    expect(budgets).not.toContain(
      '"src/components/composer/TranslationsPanel.tsx"',
    );
    expect(budgets).not.toContain('"src/components/composer/BlockEditor.tsx"');
  });
});
