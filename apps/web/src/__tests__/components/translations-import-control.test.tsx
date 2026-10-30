// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  identity: {
    user_id: "user-1",
    tenant_id: "tenant-1",
    role: "editor",
    viewer_mode: false,
  },
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  settings: vi.fn(),
  dictionary: vi.fn(),
  importCsv: vi.fn(),
  preview: vi.fn(),
  saveSettings: vi.fn(),
  upsertEntry: vi.fn(),
  deleteEntry: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));
// The reads and the CSV import are faked; the pure helpers (locale validation,
// the fallback-strategy list, the list parser) come from the real module,
// because a hand-written copy of a validation rule here would pass while the
// page and the server disagreed.
vi.mock("@/lib/translations-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/translations-api")>()),
  getTranslationSettings: mocks.settings,
  getTranslationDictionary: mocks.dictionary,
  importGlossaryCsv: mocks.importCsv,
  previewTranslation: mocks.preview,
  saveTranslationSettings: mocks.saveSettings,
  upsertTranslationEntry: mocks.upsertEntry,
  deleteTranslationEntry: mocks.deleteEntry,
  csvIsHeaderOnly: vi.fn(() => false),
}));

import TranslationsPage from "@/app/(dashboard)/app/translations/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TranslationsPage),
      ),
    );
  });
  return { container, root };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void) {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await settle();
    }
  }
  throw last;
}

function importButton(): HTMLButtonElement {
  return [...document.querySelectorAll("button")].find((node) =>
    /Import glossary/u.test(node.textContent ?? ""),
  ) as HTMLButtonElement;
}

async function choose(file: File) {
  const input = document.querySelector<HTMLInputElement>(
    "#translation-glossary-csv",
  )!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [file],
  });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue(mocks.identity);
  mocks.whoamiFresh.mockResolvedValue(mocks.identity);
  mocks.settings.mockResolvedValue({
    tenant_id: "tenant-1",
    enabled: true,
    default_locale: "en",
    supported_locales: ["fr"],
    fallback_strategy: "source",
    locale_attribute: "locale",
  });
  mocks.dictionary.mockResolvedValue([]);
  mocks.importCsv.mockResolvedValue({
    imported: 2,
    skipped: 1,
    errors: ["row 4: missing term"],
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("translations glossary import control", () => {
  it("checks fresh editor authority, reports the result, and reads back the dictionary", async () => {
    const view = mount();
    await waitFor(() => expect(importButton()).toBeTruthy());
    const file = new File(["term,fr\nHello,Bonjour\n"], "glossary.csv", {
      type: "text/csv",
    });
    await choose(file);
    expect(importButton().disabled).toBe(false);
    act(() => importButton().click());

    await waitFor(() => expect(mocks.importCsv).toHaveBeenCalledWith(file));
    expect(mocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.importCsv.mock.invocationCallOrder[0]!,
    );
    await waitFor(() =>
      expect(view.container.textContent).toMatch(/Imported 2; skipped 1/u),
    );
    expect(view.container.textContent).toContain("row 4: missing term");
    expect(mocks.dictionary.mock.calls.length).toBeGreaterThan(1);
    act(() => view.root.unmount());
  });

  it("fails closed when workspace identity changes before upload", async () => {
    mocks.whoamiFresh.mockResolvedValueOnce({
      ...mocks.identity,
      tenant_id: "tenant-2",
    });
    const view = mount();
    await waitFor(() => expect(importButton()).toBeTruthy());
    await choose(new File(["term\nHello\n"], "glossary.csv"));
    act(() => importButton().click());

    await waitFor(() =>
      expect(
        view.container.querySelector('[role="alert"]')?.textContent,
      ).toMatch(/identity or authority changed/u),
    );
    expect(mocks.importCsv).not.toHaveBeenCalled();
    act(() => view.root.unmount());
  });

  it("does not expose upload controls to viewers", async () => {
    mocks.whoami.mockResolvedValueOnce({ ...mocks.identity, role: "viewer" });
    const view = mount();
    await waitFor(() =>
      expect(view.container.textContent).toMatch(/Import is read-only/u),
    );
    expect(
      view.container.querySelector("#translation-glossary-csv"),
    ).toBeNull();
    expect(mocks.importCsv).not.toHaveBeenCalled();
    act(() => view.root.unmount());
  });
});
