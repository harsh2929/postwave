// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
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
  canWrite: false,
  me: {
    user: "template-user",
    tenant: "template-workspace",
    role: "viewer",
    effectiveRole: "viewer",
  },
  search: vi.fn(),
  stats: vi.fn(),
  goals: vi.fn(),
  getTemplate: vi.fn(),
  favorite: vi.fn(),
  unfavorite: vi.fn(),
  clone: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  listBlocks: vi.fn(),
  getBlock: vi.fn(),
  createBlock: vi.fn(),
  deleteBlock: vi.fn(),
  clipboard: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  consumeDeepLink: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    searchCampaignTemplates: mocks.search,
    getCampaignTemplateStats: mocks.stats,
    listCampaignTemplateGoals: mocks.goals,
    getCampaignTemplate: mocks.getTemplate,
    favoriteCampaignTemplate: mocks.favorite,
    unfavoriteCampaignTemplate: mocks.unfavorite,
    cloneCampaignTemplate: mocks.clone,
    createCampaignTemplate: mocks.createTemplate,
    updateCampaignTemplate: mocks.updateTemplate,
  },
  apiSendTimeAssets: {
    listSavedBlocks: mocks.listBlocks,
    getSavedBlock: mocks.getBlock,
    createSavedBlock: mocks.createBlock,
    deleteSavedBlock: mocks.deleteBlock,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanWrite: () => mocks.canWrite,
  useMe: () => mocks.me,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    info: mocks.toastInfo,
  },
}));

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.clipboard,
}));

vi.mock("../../lib/deep-link", () => ({
  consumePendingDeepLinkTarget: mocks.consumeDeepLink,
  onPendingDeepLinkTarget: () => () => undefined,
}));

vi.mock("../../lib/desktop-task-intents", () => ({
  consumeDesktopTaskIntent: vi.fn(),
}));

vi.mock("../../hooks/useDesktopTaskIntent", () => ({
  useWriteDesktopTaskIntent: () => undefined,
}));

vi.mock("../../hooks/useSettingsDraftLifecycle", () => ({
  markLifecycleOperationRefRetained: () => undefined,
  useDiscardOnlyDraftLifecycle: () => undefined,
}));

vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: () => () => undefined,
}));

vi.mock("../../components/PendingSyncStatus", () => ({
  PendingSyncStatus: () => null,
}));

vi.mock("../../components/HeroEmptyState", () => ({
  HeroEmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("../../components/TemplateDetailSlideover", () => ({
  TemplateDetailSlideover: ({ template }: { template: { id: string } }) => (
    <div role="dialog" aria-label="Template detail">
      Template detail {template.id}
    </div>
  ),
}));

vi.mock("../../components/templates/AiTemplateGeneratorModal", () => ({
  AiTemplateGeneratorModal: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="AI template generator" /> : null,
}));

vi.mock("../../components/templates/TemplateLeaderboardSection", () => ({
  TemplateLeaderboardSection: () => null,
}));

vi.mock("../../lib/heroAssets", () => ({
  HERO: { templates: "templates.png" },
}));

import { Templates } from "../../pages/Templates";

const catalogFacets = {
  goals: [],
  categories: [],
  providers: [],
  industries: [],
  styles: [],
  layouts: [],
};

const template = {
  id: "template-record-id-00000000-1111-2222-3333-444444444444",
  tenant_id: "tenant-full-record",
  slug: "quarterly-customer-research-newsletter",
  name: "Quarterly customer research newsletter — complete edition",
  subject:
    "A complete, intentionally long subject line that must remain visible without a tooltip",
  preview_text: "Research highlights",
  body_html: '<img src="https://tracker.invalid/pixel.gif"><p>Hello</p>',
  goal: "newsletter",
  template_kind: "editable",
  source_brand: "Customer Research Collective",
  source_provider: "External design catalog",
  source_external_id: "external-template-record-id-998877665544332211",
  thumbnail_url: "https://tracker.invalid/template-preview.png",
  usage_count: 12_345,
  last_used_at: "2026-07-16T08:30:45.000Z",
  updated_at: "2026-07-16T07:20:15.000Z",
  review_status: "approved",
  source_license_status: "owned",
  tags: ["kind:regular", "research", "quarterly"],
  is_favorited: false,
  capabilities: {
    can_preview: true,
    can_favorite: true,
    can_adapt: false,
    can_use_directly: false,
    can_create_campaign: false,
    can_edit_directly: false,
    can_clone: false,
    can_delete: false,
    can_archive: false,
    can_restore: false,
    has_source_html: true,
    has_source_mjml: false,
    has_desktop_preview: true,
    has_mobile_preview: false,
  },
  recommended_action: "request_campaign_write_access",
  warnings: [
    {
      code: "write_permission_required",
      message:
        "Your current role can browse this template but cannot modify or use it.",
      recommended_action: "request_campaign_write_access",
    },
  ],
};

const savedBlock = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  name: "Spring launch hero — desktop and mobile",
  kind: "section",
  body_html: '<img src="https://tracker.invalid/saved-block.gif"><p>Launch</p>',
  body_json: { block_id: "launch-hero", version: 4 },
  created_at: "2026-07-15T02:03:04.000Z",
  updated_at: "2026-07-16T05:06:07.000Z",
  version: 4,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.localStorage.clear();
  mocks.canWrite = false;
  mocks.me = {
    user: "template-user",
    tenant: "template-workspace",
    role: "viewer",
    effectiveRole: "viewer",
  };
  for (const value of Object.values(mocks)) {
    if (typeof value === "function" && "mockReset" in value) value.mockReset();
  }
  mocks.consumeDeepLink.mockReturnValue(null);
  mocks.search.mockResolvedValue({
    data: {
      items: [template],
      page: 1,
      per_page: 50,
      total: 1,
      facets: catalogFacets,
    },
  });
  mocks.stats.mockResolvedValue({
    data: {
      total: 1,
      mine: 1,
      featured: 0,
      favorites: 0,
      used_last_30d: 12_345,
      top_template_name: template.name,
      top_usage_count: 12_345,
    },
  });
  mocks.goals.mockResolvedValue({
    data: [
      { goal: "newsletter", count: 1 },
      { goal: "welcome", count: 0 },
    ],
  });
  mocks.getTemplate.mockResolvedValue({ data: template });
  mocks.favorite.mockResolvedValue({ data: { ok: true, favorited: true } });
  mocks.unfavorite.mockResolvedValue({ data: { ok: true, favorited: false } });
  mocks.clone.mockResolvedValue({ data: { ...template, id: "template-copy" } });
  mocks.createTemplate.mockResolvedValue({
    data: { ...template, id: "template-created" },
  });
  mocks.updateTemplate.mockResolvedValue({ data: template });
  mocks.listBlocks.mockResolvedValue({
    data: { items: [savedBlock], total: 1 },
  });
  mocks.getBlock.mockResolvedValue({ data: savedBlock });
  mocks.createBlock.mockResolvedValue({ data: savedBlock });
  mocks.deleteBlock.mockResolvedValue({
    data: { ok: true, id: savedBlock.id, version: savedBlock.version + 1 },
  });
  mocks.clipboard.mockResolvedValue({
    ok: true,
    backend: "web",
    contentClass: "personal",
    clearScheduled: false,
    clearAfterMs: null,
    historyWarning: null,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Templates />));
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (caught) {
      failure = caught;
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw failure;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function setInput(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function selectSource(value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    `input[type="radio"][value="${value}"]`,
  );
  if (!input) throw new Error(`Missing template source: ${value}`);
  act(() => input.click());
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Templates production interaction maturity", () => {
  it("keeps viewer actions discoverable and exposes complete safe catalog context", async () => {
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );

    for (const action of [button("Generate with AI"), button("New template")]) {
      expect(action.disabled).toBe(false);
      expect(action.getAttribute("aria-disabled")).toBe("true");
      act(() => action.click());
    }
    expect(
      document.querySelector('[aria-label="AI template generator"]'),
    ).toBeNull();
    expect(document.querySelector("#tpl-new-name")).toBeNull();
    expect(document.body.textContent).toContain(
      "Viewer role can browse templates but cannot create them.",
    );

    const search = document.querySelector<HTMLInputElement>(
      "#tpl-template-search",
    );
    expect(search?.labels?.[0]?.textContent).toContain("Search templates");
    expect(
      document.querySelector<HTMLInputElement>(
        'input[type="radio"][value="platform"]',
      )?.labels?.[0]?.textContent,
    ).toContain("Inspiration");
    expect(
      document.querySelector<HTMLInputElement>(
        'input[type="radio"][value="mine"]',
      )?.labels?.[0]?.textContent,
    ).toContain("My templates");
    expect(
      document.querySelector<HTMLInputElement>(
        'input[type="radio"][value="favorited"]',
      )?.labels?.[0]?.textContent,
    ).toContain("Favorites");
    const unavailableGoal = document.querySelector<HTMLButtonElement>(
      'button[data-goal="welcome"]',
    );
    expect(unavailableGoal?.disabled).toBe(false);
    expect(unavailableGoal?.getAttribute("aria-disabled")).toBe("true");
    expect(unavailableGoal?.textContent).toContain("0");

    expect(document.body.textContent).toContain(template.subject);
    expect(document.body.textContent).toContain(template.id);
    expect(document.body.textContent).toContain(template.source_external_id);
    expect(document.body.textContent).toContain("12,345 times");
    expect(document.body.textContent).toContain("External design catalog");
    expect(document.body.textContent).toContain("Preview only");
    expect(document.body.textContent).toContain(
      "Your current role can browse this template but cannot modify or use it.",
    );
    expect(document.body.textContent).toContain("Source and template details");
    expect(document.body.textContent).not.toContain("License:");
    expect(document.body.textContent).not.toContain("Edit status");
    expect(
      document.querySelector('img[src^="https://tracker.invalid/"]'),
    ).toBeNull();
    expect(document.querySelector('img[src*="/thumbnail.png"]')).toBeNull();
    expect(
      document.querySelector('.tpl-card-visual[aria-hidden="true"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      `Preview text: ${template.preview_text}`,
    );
    expect(document.querySelector("iframe")).toBeNull();
    expect(
      document.querySelector("ul.tpl-library-grid > li.tpl-card"),
    ).not.toBeNull();
    expect(
      container?.querySelectorAll(
        "button[title], input[title], select[title], textarea[title], li[title], span[title]",
      ),
    ).toHaveLength(0);

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("contains synchronous failures, single-flights retry, and retains stale rows honestly", async () => {
    mocks.search.mockImplementationOnce(() => {
      throw new Error("private database host and query detail");
    });
    mocks.stats.mockRejectedValueOnce(
      new Error("private analytics connection detail"),
    );
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The service could not be reached. Check the connection and retry.",
      ),
    );
    expect(document.body.textContent).not.toContain("private database host");
    expect(document.body.textContent).not.toContain(
      "private analytics connection detail",
    );
    expect(document.body.textContent).toContain(
      "Library statistics could not be refreshed.",
    );
    expect(document.body.textContent).toContain("Unavailable");

    const firstRetry = button("Retry template catalog");
    await act(async () => {
      firstRetry.click();
      firstRetry.click();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );
    expect(mocks.search).toHaveBeenCalledTimes(2);

    const refresh = deferred<{
      error: { message: string; status: number; requestId: string };
    }>();
    mocks.search.mockReturnValueOnce(refresh.promise);
    act(() => button("Refresh").click());
    expect(document.body.textContent).toContain(
      "Showing the previous verified catalog while the current view is refreshed.",
    );
    expect(document.body.textContent).toContain(template.name);
    await act(async () => {
      refresh.resolve({
        error: {
          message: "private SQL table name",
          status: 500,
          requestId: "req-template-refresh-500",
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(template.name);
    expect(document.body.textContent).toContain(
      "Request req-template-refresh-500",
    );
    expect(document.body.textContent).not.toContain("private SQL table name");
  });

  it("single-flights favorite updates while keeping the control focusable", async () => {
    const pending = deferred<{ data: { ok: boolean; favorited: boolean } }>();
    mocks.favorite.mockReturnValueOnce(pending.promise);
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );
    const favorite = document.querySelector<HTMLButtonElement>(
      `button[aria-label="Add ${template.name} to favorites"]`,
    );
    if (!favorite) throw new Error("Missing favorite control");
    act(() => {
      favorite.click();
      favorite.click();
    });
    expect(mocks.favorite).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      const busy = document.querySelector<HTMLButtonElement>(
        `button[aria-label="Updating favorite for ${template.name}"]`,
      );
      expect(busy?.disabled).toBe(false);
      expect(busy?.getAttribute("aria-disabled")).toBe("true");
      expect(document.body.textContent).toContain(
        `Updating favorite for ${template.name}`,
      );
    });
    await act(async () => {
      pending.resolve({ data: { ok: true, favorited: true } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      document.querySelector(
        `button[aria-label="Remove ${template.name} from favorites"]`,
      ),
    ).not.toBeNull();
  });

  it("optimistically favorites and restores the exact card snapshot on failure", async () => {
    const pending = deferred<{
      error: { message: string; status: number; requestId: string };
    }>();
    mocks.favorite.mockReturnValueOnce(pending.promise);
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );
    const favorite = document.querySelector<HTMLButtonElement>(
      `button[aria-label="Add ${template.name} to favorites"]`,
    );
    if (!favorite) throw new Error("Missing favorite control");
    act(() => favorite.click());

    await waitFor(() =>
      expect(
        document.querySelector(
          `button[aria-label="Updating favorite for ${template.name}"]`,
        ),
      ).not.toBeNull(),
    );
    await act(async () => {
      pending.resolve({
        error: {
          message: "favorite unavailable",
          status: 503,
          requestId: "req-favorite-rollback",
        },
      });
      await pending.promise;
    });
    await waitFor(() =>
      expect(
        document.querySelector(
          `button[aria-label="Add ${template.name} to favorites"]`,
        ),
      ).not.toBeNull(),
    );
    expect(document.body.textContent).toContain(template.source_external_id);
    expect(document.body.textContent).toContain("12,345 times");
  });

  it("keeps archived discovery explicit and server-filtered", async () => {
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );

    selectSource("archived");
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(2));

    expect(mocks.search.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        archived: "archived",
        source: "all",
        favorited: false,
      }),
    );
    expect(document.body.textContent).toContain(
      "Recoverable workspace templates",
    );
  });

  it("restores bounded workspace discovery preferences after a cold remount", async () => {
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );
    const search = document.querySelector<HTMLInputElement>(
      "#tpl-template-search",
    );
    if (!search) throw new Error("Missing template search");
    setInput(search, "editorial launch");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 320));
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('button[data-goal="newsletter"]')
        ?.click(),
    );
    const selects = [...document.querySelectorAll<HTMLSelectElement>("select")];
    const lifecycle = selects.find((select) =>
      select.labels?.[0]?.textContent?.includes("Lifecycle"),
    );
    const sort = selects.find((select) =>
      select.labels?.[0]?.textContent?.includes("Sort by"),
    );
    if (!lifecycle || !sort) throw new Error("Missing discovery preferences");
    act(() => {
      lifecycle.value = "all";
      lifecycle.dispatchEvent(new Event("change", { bubbles: true }));
      sort.value = "most_used";
      sort.dispatchEvent(new Event("change", { bubbles: true }));
      button("Compact").click();
    });
    await waitFor(() =>
      expect(mocks.search.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          archived: "all",
          goal: "newsletter",
          query: "editorial launch",
          sort: "most_used",
        }),
      ),
    );

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    render();
    await waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>("#tpl-template-search")?.value,
      ).toBe("editorial launch"),
    );
    expect(button("Compact").getAttribute("aria-pressed")).toBe("true");
    const restoredSelects = [
      ...document.querySelectorAll<HTMLSelectElement>("select"),
    ];
    expect(
      restoredSelects.find((select) =>
        select.labels?.[0]?.textContent?.includes("Lifecycle"),
      )?.value,
    ).toBe("all");
    expect(
      restoredSelects.find((select) =>
        select.labels?.[0]?.textContent?.includes("Sort by"),
      )?.value,
    ).toBe("most_used");
  });

  it("aborts and resets catalog state when the workspace identity changes", async () => {
    const first = deferred<{
      data: {
        items: (typeof template)[];
        page: number;
        per_page: number;
        total: number;
        facets: typeof catalogFacets;
      };
    }>();
    mocks.search.mockReturnValueOnce(first.promise);
    render();
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1));
    const firstSignal = mocks.search.mock.calls[0]?.[1]?.signal as
      | AbortSignal
      | undefined;
    mocks.me = {
      ...mocks.me,
      user: "another-template-user",
      tenant: "another-template-workspace",
    };
    act(() => root?.render(<Templates />));

    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>("#tpl-template-search")?.value,
    ).toBe("");
  });

  it("never dispatches a debounced query from the previous workspace under the next identity", async () => {
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );
    const search = document.querySelector<HTMLInputElement>(
      "#tpl-template-search",
    );
    if (!search) throw new Error("Missing template search");

    const oldQuery = "private previous-workspace query";
    const oldQueryRequest = deferred<{
      data: {
        items: (typeof template)[];
        page: number;
        per_page: number;
        total: number;
        facets: typeof catalogFacets;
      };
    }>();
    mocks.search.mockReturnValueOnce(oldQueryRequest.promise);
    setInput(search, oldQuery);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 320));
    });
    await waitFor(() =>
      expect(mocks.search.mock.calls.at(-1)?.[0]?.query).toBe(oldQuery),
    );
    const oldSignal = mocks.search.mock.calls.at(-1)?.[1]?.signal as
      | AbortSignal
      | undefined;
    const callsBeforeIdentitySwitch = mocks.search.mock.calls.length;

    mocks.me = {
      ...mocks.me,
      user: "next-template-user",
      tenant: "next-template-workspace",
    };
    act(() => root?.render(<Templates />));

    await waitFor(() =>
      expect(mocks.search.mock.calls.length).toBeGreaterThan(
        callsBeforeIdentitySwitch,
      ),
    );
    expect(oldSignal?.aborted).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>("#tpl-template-search")?.value,
    ).toBe("");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 320));
    });
    expect(
      mocks.search.mock.calls
        .slice(callsBeforeIdentitySwitch)
        .some(([options]) => options.query === oldQuery),
    ).toBe(false);
  });

  it("unmounts every identity-owned draft and aborts saved-block reads on workspace change", async () => {
    mocks.canWrite = true;
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );

    act(() => button("New template").click());
    const templateName =
      document.querySelector<HTMLInputElement>("#tpl-new-name");
    if (!templateName) throw new Error("Missing template name field");
    setInput(templateName, "Previous workspace template draft");
    act(() => button("Generate with AI").click());
    expect(
      document.querySelector('[aria-label="AI template generator"]'),
    ).not.toBeNull();

    const pendingBlocks = deferred<{
      data: { items: (typeof savedBlock)[] };
    }>();
    mocks.listBlocks.mockReturnValueOnce(pendingBlocks.promise);
    selectSource("saved_blocks");
    await waitFor(() => expect(mocks.listBlocks).toHaveBeenCalledTimes(1));
    const savedBlockSignal = mocks.listBlocks.mock.calls[0]?.[1]?.signal as
      | AbortSignal
      | undefined;
    act(() => button("New saved block").click());
    const blockName = document.querySelector<HTMLInputElement>("#sb-name");
    if (!blockName) throw new Error("Missing saved-block name field");
    setInput(blockName, "Previous workspace saved-block draft");

    mocks.me = {
      ...mocks.me,
      user: "clean-template-user",
      tenant: "clean-template-workspace",
    };
    act(() => root?.render(<Templates />));

    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );
    expect(savedBlockSignal?.aborted).toBe(true);
    expect(document.querySelector("#tpl-new-name")).toBeNull();
    expect(document.querySelector("#sb-name")).toBeNull();
    expect(
      document.querySelector('[aria-label="AI template generator"]'),
    ).toBeNull();
    expect(
      document.querySelector<HTMLInputElement>("#tpl-template-search")?.value,
    ).toBe("");
  });

  it("removes an unfavorited record from the Favorites result set immediately", async () => {
    mocks.search
      .mockResolvedValueOnce({
        data: {
          items: [template],
          page: 1,
          per_page: 48,
          total: 1,
          facets: {
            goals: [],
            categories: [],
            providers: [],
            industries: [],
            styles: [],
            layouts: [],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [{ ...template, is_favorited: true }],
          page: 1,
          per_page: 48,
          total: 1,
          facets: {
            goals: [],
            categories: [],
            providers: [],
            industries: [],
            styles: [],
            layouts: [],
          },
        },
      });
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );
    selectSource("favorited");
    await waitFor(() =>
      expect(
        document.querySelector(
          `button[aria-label="Remove ${template.name} from favorites"]`,
        ),
      ).not.toBeNull(),
    );
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          `button[aria-label="Remove ${template.name} from favorites"]`,
        )
        ?.click(),
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain("No favorites yet"),
    );
    expect(mocks.unfavorite).toHaveBeenCalledTimes(1);
  });

  it("refreshes the current generation instead of rolling a failed favorite into a changed filter", async () => {
    const currentTemplate = {
      ...template,
      id: "current-platform-template-5555",
      name: "Current platform result",
      is_favorited: false,
    };
    const response = (items: (typeof template)[]) => ({
      data: {
        items,
        page: 1,
        per_page: 100,
        total: items.length,
        facets: catalogFacets,
      },
    });
    mocks.search
      .mockResolvedValueOnce(response([template]))
      .mockResolvedValueOnce(response([{ ...template, is_favorited: true }]))
      .mockResolvedValueOnce(response([currentTemplate]))
      .mockResolvedValueOnce(response([currentTemplate]));
    const pendingUnfavorite = deferred<{
      error: { message: string; status: number; requestId: string };
    }>();
    mocks.unfavorite.mockReturnValueOnce(pendingUnfavorite.promise);

    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );
    selectSource("favorited");
    await waitFor(() =>
      expect(
        document.querySelector(
          `button[aria-label="Remove ${template.name} from favorites"]`,
        ),
      ).not.toBeNull(),
    );
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          `button[aria-label="Remove ${template.name} from favorites"]`,
        )
        ?.click(),
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain("No favorites yet"),
    );

    selectSource("platform");
    await waitFor(() =>
      expect(document.body.textContent).toContain(currentTemplate.name),
    );
    await act(async () => {
      pendingUnfavorite.resolve({
        error: {
          message: "favorite update failed",
          status: 503,
          requestId: "req-stale-favorite-generation",
        },
      });
      await pendingUnfavorite.promise;
    });

    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(4));
    await waitFor(() =>
      expect(document.querySelector(".page-subtitle")?.textContent).toBe(
        "1 template",
      ),
    );
    expect(document.body.textContent).toContain(currentTemplate.name);
    expect(
      document.querySelector(
        `button[aria-label="Open template ${template.name}"]`,
      ),
    ).toBeNull();
    expect(document.querySelectorAll("li.tpl-card")).toHaveLength(1);
    expect(mocks.search.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        source: "platform",
        favorited: false,
      }),
    );
  });

  it("fails closed when a successful response contains malformed records", async () => {
    mocks.search.mockResolvedValueOnce({
      data: {
        items: [{ ...template, id: 42, name: null }],
        page: 1,
        per_page: 48,
        total: 1,
        facets: {},
      },
    });
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The server returned an invalid template catalog response",
      ),
    );
    expect(document.body.textContent).toContain("Template catalog unavailable");
    expect(document.querySelector("li.tpl-card")).toBeNull();
  });

  it("preserves concurrent card updates when a later catalog page arrives", async () => {
    mocks.search.mockResolvedValueOnce({
      data: {
        items: [template],
        page: 1,
        per_page: 48,
        total: 2,
        facets: catalogFacets,
      },
    });
    const nextPage = deferred<{
      data: {
        items: (typeof template)[];
        page: number;
        per_page: number;
        total: number;
        facets: typeof catalogFacets;
      };
    }>();
    mocks.search.mockReturnValueOnce(nextPage.promise);
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );

    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(2));
    const favorite = document.querySelector<HTMLButtonElement>(
      `button[aria-label="Add ${template.name} to favorites"]`,
    );
    if (!favorite) throw new Error("Missing favorite control");
    act(() => favorite.click());
    await waitFor(() =>
      expect(
        document.querySelector(
          `button[aria-label="Remove ${template.name} from favorites"]`,
        ),
      ).not.toBeNull(),
    );

    const secondTemplate = {
      ...template,
      id: "template-record-id-second-page",
      name: "Second-page template",
    };
    await act(async () => {
      nextPage.resolve({
        data: {
          items: [secondTemplate],
          page: 2,
          per_page: 100,
          total: 2,
          facets: catalogFacets,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(secondTemplate.name);
    expect(
      document.querySelector(
        `button[aria-label="Remove ${template.name} from favorites"]`,
      ),
    ).not.toBeNull();
  });

  it("clears previously visible catalog data when pagination loses access", async () => {
    mocks.search
      .mockResolvedValueOnce({
        data: {
          items: [template],
          page: 1,
          per_page: 100,
          total: 2,
          facets: catalogFacets,
        },
      })
      .mockResolvedValueOnce({
        error: {
          message: "private authorization policy detail",
          status: 403,
          requestId: "req-template-page-denied",
        },
      });
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Template catalog unavailable",
      ),
    );
    expect(
      document.querySelector(
        `button[aria-label="Open template ${template.name}"]`,
      ),
    ).toBeNull();
    expect(document.querySelector('[aria-label="Template detail"]')).toBeNull();
    expect(document.body.textContent).toContain("req-template-page-denied");
    expect(document.body.textContent).not.toContain(
      "private authorization policy detail",
    );
  });

  it("lets the newest source request win and cancels an older deep-link open", async () => {
    const oldDeepLink = deferred<{ data: typeof template }>();
    mocks.consumeDeepLink.mockReturnValueOnce({
      section: "templates",
      id: "older-deep-link-template-id",
    });
    mocks.getTemplate.mockReturnValueOnce(oldDeepLink.promise);
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );
    act(() => button(template.name).click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        `Template detail ${template.id}`,
      ),
    );
    await act(async () => {
      oldDeepLink.resolve({
        data: {
          ...template,
          id: "older-deep-link-template-id",
          name: "Older deep-link template",
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      `Template detail ${template.id}`,
    );
    expect(document.body.textContent).not.toContain(
      "Template detail older-deep-link-template-id",
    );

    const team = deferred<{ data: Record<string, unknown> }>();
    const gallery = deferred<{ data: Record<string, unknown> }>();
    mocks.search
      .mockReturnValueOnce(team.promise)
      .mockReturnValueOnce(gallery.promise);
    selectSource("team");
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(2));
    selectSource("platform");
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(3));
    await act(async () => {
      gallery.resolve({
        data: {
          items: [
            { ...template, id: "new-gallery", name: "Newest gallery result" },
          ],
          page: 1,
          per_page: 48,
          total: 1,
          facets: catalogFacets,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Newest gallery result");
    await act(async () => {
      team.resolve({
        data: {
          items: [
            { ...template, id: "old-team", name: "Late stale team result" },
          ],
          page: 1,
          per_page: 48,
          total: 1,
          facets: catalogFacets,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Newest gallery result");
    expect(document.body.textContent).not.toContain("Late stale team result");
  });

  it("single-flights template creation and keeps dismissal discoverable during commit", async () => {
    mocks.canWrite = true;
    const pendingCreate = deferred<{ data: typeof template }>();
    mocks.createTemplate.mockReturnValueOnce(pendingCreate.promise);
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );
    act(() => button("New template").click());
    const name = document.querySelector<HTMLInputElement>("#tpl-new-name");
    if (!name) throw new Error("Missing template name field");
    setInput(name, "Single-flight launch template");
    const goal = document.querySelector<HTMLSelectElement>("#tpl-new-goal");
    if (!goal) throw new Error("Missing template goal field");
    act(() => {
      goal.value = "announcement";
      goal.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const create = button("Create template");
    act(() => {
      create.click();
      create.click();
    });
    expect(mocks.createTemplate).toHaveBeenCalledTimes(1);
    expect(mocks.createTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "announcement" }),
      {},
    );
    expect(mocks.updateTemplate).not.toHaveBeenCalled();
    await waitFor(() => {
      const cancel = button("Cancel");
      expect(cancel.disabled).toBe(false);
      expect(cancel.getAttribute("aria-disabled")).toBe("true");
      expect(button("Creating…").getAttribute("aria-busy")).toBe("true");
    });
    await act(async () => {
      pendingCreate.resolve({
        data: {
          ...template,
          id: "single-flight-created-template",
          name: "Single-flight launch template",
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.querySelector("#tpl-new-name")).toBeNull(),
    );
  });

  it("makes saved blocks semantic, non-executing, permission-honest, and clipboard single-flight", async () => {
    const pendingCopy = deferred<{
      ok: true;
      backend: "web";
      contentClass: "personal";
      clearScheduled: false;
      clearAfterMs: null;
      historyWarning: null;
    }>();
    mocks.clipboard.mockReturnValueOnce(pendingCopy.promise);
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );
    selectSource("saved_blocks");
    await waitFor(() =>
      expect(document.body.textContent).toContain(savedBlock.name),
    );
    await waitFor(() => expect(button("Refresh")).toBeTruthy());
    expect(document.body.textContent).not.toContain("Used (30d)");

    const catalogCallsBeforeRefresh = mocks.search.mock.calls.length;
    const savedBlockCallsBeforeRefresh = mocks.listBlocks.mock.calls.length;
    const pendingRefresh = deferred<{
      data: { items: (typeof savedBlock)[] };
    }>();
    mocks.listBlocks.mockReturnValueOnce(pendingRefresh.promise);
    const refreshSavedBlocks = button("Refresh");
    await act(async () => {
      refreshSavedBlocks.click();
      refreshSavedBlocks.click();
      await Promise.resolve();
    });
    expect(mocks.listBlocks).toHaveBeenCalledTimes(
      savedBlockCallsBeforeRefresh + 1,
    );
    expect(mocks.search).toHaveBeenCalledTimes(catalogCallsBeforeRefresh);
    expect(button("Refreshing…").getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      pendingRefresh.resolve({ data: { items: [savedBlock] } });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(button("Refresh")).toBeTruthy());

    expect(document.body.textContent).toContain(savedBlock.id);
    expect(document.body.textContent).toContain("Block kind: section");
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.body.innerHTML).not.toContain(
      "tracker.invalid/saved-block.gif",
    );
    expect(
      document.querySelector("ul.tpl-library-grid > li.pw-saved-block-card"),
    ).not.toBeNull();
    expect(
      document
        .querySelector("li.pw-saved-block-card")
        ?.hasAttribute("draggable"),
    ).toBe(false);
    const savedBlockSearch = document.querySelector<HTMLInputElement>(
      "#tpl-template-search",
    );
    expect(savedBlockSearch?.labels?.[0]?.textContent).toContain(
      "Search saved blocks",
    );
    if (!savedBlockSearch) throw new Error("Missing saved-block search");
    setInput(savedBlockSearch, "no-such-saved-block");
    expect(document.body.textContent).toContain(
      "No saved blocks match “no-such-saved-block”",
    );
    act(() => button("Clear saved-block search").click());
    expect(document.body.textContent).toContain(savedBlock.name);

    const create = button("New saved block");
    const remove = button("Delete block");
    expect(create.disabled).toBe(false);
    expect(create.getAttribute("aria-disabled")).toBe("true");
    expect(remove.disabled).toBe(false);
    expect(remove.getAttribute("aria-disabled")).toBe("true");

    const copy = button("Copy block content");
    act(() => {
      copy.click();
      copy.click();
    });
    expect(mocks.clipboard).toHaveBeenCalledTimes(1);
    expect(mocks.clipboard.mock.calls[0]?.[0]).toBe(savedBlock.body_html);
    await waitFor(() => expect(button("Copying…").disabled).toBe(false));
    await act(async () => {
      pendingCopy.resolve({
        ok: true,
        backend: "web",
        contentClass: "personal",
        clearScheduled: false,
        clearAfterMs: null,
        historyWarning: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      `${savedBlock.name} copied. Paste it into a template body.`,
    );
  });

  it("validates create forms inline and confirms saved-block deletion without leaking server detail", async () => {
    mocks.canWrite = true;
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );

    act(() => button("New template").click());
    const createTemplate = button("Create template");
    expect(createTemplate.disabled).toBe(false);
    expect(createTemplate.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "Enter a template name before creating it.",
    );
    const templateName =
      document.querySelector<HTMLInputElement>("#tpl-new-name");
    if (!templateName) throw new Error("Missing template name field");
    setInput(templateName, "Customer launch announcement");
    expect(button("Create template").getAttribute("aria-disabled")).toBe(
      "false",
    );
    act(() => button("Cancel").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Discard this template?"),
    );
    act(() => button("Discard template").click());

    selectSource("saved_blocks");
    await waitFor(() =>
      expect(document.body.textContent).toContain(savedBlock.name),
    );
    act(() => button("New saved block").click());
    expect(button("Save block").getAttribute("aria-disabled")).toBe("true");
    const blockName = document.querySelector<HTMLInputElement>("#sb-name");
    const blockJson = document.querySelector<HTMLTextAreaElement>("#sb-json");
    if (!blockName || !blockJson) throw new Error("Missing saved-block fields");
    setInput(blockName, "Reusable research footer");
    setInput(blockJson, "{invalid json");
    expect(document.body.textContent).toContain(
      "Block JSON must be valid JSON.",
    );
    expect(button("Save block").getAttribute("aria-disabled")).toBe("true");
    act(() => button("Cancel").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Discard this saved block?"),
    );
    act(() => button("Discard block").click());

    mocks.deleteBlock.mockResolvedValueOnce({
      error: {
        message: "private blocks table constraint detail",
        status: 500,
        requestId: "req-delete-block-500",
      },
    });
    act(() => button("Delete block").click());
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(savedBlock.name);
    const confirm = dialog?.querySelector<HTMLButtonElement>(".btn-danger");
    if (!confirm) throw new Error("Missing delete confirmation");
    await act(async () => {
      confirm.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("Request req-delete-block-500"),
      }),
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "private blocks table constraint detail",
    );
  });

  it("preserves a saved-block draft when a successful create response is malformed", async () => {
    mocks.canWrite = true;
    mocks.createBlock.mockResolvedValueOnce({
      data: { ...savedBlock, id: null, updated_at: "not-a-date" },
    });
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(template.name),
    );
    selectSource("saved_blocks");
    await waitFor(() =>
      expect(document.body.textContent).toContain(savedBlock.name),
    );
    act(() => button("New saved block").click());
    const blockName = document.querySelector<HTMLInputElement>("#sb-name");
    const blockHtml = document.querySelector<HTMLTextAreaElement>("#sb-html");
    if (!blockName || !blockHtml) throw new Error("Missing saved-block fields");
    setInput(blockName, "Ambiguous reusable footer");
    setInput(blockHtml, "<footer>Keep this draft</footer>");

    act(() => button("Save block").click());
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "The saved-block response could not be verified.",
        }),
      ),
    );

    expect(document.querySelector<HTMLInputElement>("#sb-name")?.value).toBe(
      "Ambiguous reusable footer",
    );
    expect(mocks.createBlock).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith(
      expect.stringContaining("Ambiguous reusable footer"),
    );
  });
});
