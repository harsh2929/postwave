// @vitest-environment happy-dom

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
  archiveTemplate: vi.fn(),
  behavior: vi.fn(),
  canWrite: true,
  clone: vi.fn(),
  createCampaign: vi.fn(),
  favorite: vi.fn(),
  getRegions: vi.fn(),
  getRevision: vi.fn(),
  getRevisions: vi.fn(),
  getTemplate: vi.fn(),
  registerGuard: vi.fn(() => () => undefined),
  restoreTemplate: vi.fn(),
  setSection: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  unfavorite: vi.fn(),
  updateTemplate: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    archiveCampaignTemplate: mocks.archiveTemplate,
    cloneCampaignTemplate: mocks.clone,
    createCampaignFromTemplate: mocks.createCampaign,
    favoriteCampaignTemplate: mocks.favorite,
    getCampaignTemplate: mocks.getTemplate,
    getCampaignTemplateRevision: mocks.getRevision,
    listCampaignTemplateRevisions: mocks.getRevisions,
    restoreCampaignTemplate: mocks.restoreTemplate,
    unfavoriteCampaignTemplate: mocks.unfavorite,
    updateCampaignTemplate: mocks.updateTemplate,
  },
  apiSendTimeAssets: {
    getTemplateRegions: mocks.getRegions,
  },
}));

vi.mock("../../hooks/useSlideoverBehavior", () => ({
  useSlideoverBehavior: mocks.behavior,
}));

vi.mock("../../lib/store", () => ({
  setSection: mocks.setSection,
  useCanWrite: () => mocks.canWrite,
}));

vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: mocks.registerGuard,
  signalLifecycleOwnerChanged: vi.fn(),
}));

vi.mock("../../components/TemplatePreview", () => ({
  TemplatePreview: ({ html }: { html: string }) => (
    <div data-testid="template-preview">{html}</div>
  ),
  TemplatePreviewToolbar: () => <div>Preview controls</div>,
}));

vi.mock("../../components/PendingSyncStatus", () => ({
  PendingSyncStatus: () => null,
}));

vi.mock("../../lib/campaign-template-previews", () => ({
  campaignTemplatePreviewUrl: (template: CampaignTemplate) =>
    template.preview_assets?.[0]?.url ?? null,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: ({
    busy,
    cancelLabel = "Cancel",
    confirmLabel = "Confirm",
    danger,
    description,
    onClose,
    onConfirm,
    open,
    title,
  }: {
    busy?: boolean;
    cancelLabel?: string;
    confirmLabel?: string;
    danger?: boolean;
    description?: string;
    onClose: () => void;
    onConfirm: () => void | Promise<void>;
    open: boolean;
    title: string;
  }): ReactElement | null =>
    open ? (
      <div role={danger ? "alertdialog" : "dialog"} aria-label={title}>
        <p>{description}</p>
        <button type="button" onClick={onClose} disabled={busy}>
          {cancelLabel}
        </button>
        <button type="button" onClick={() => void onConfirm()} disabled={busy}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

import { type CampaignTemplate } from "../../lib/api-client";
import { TemplateDetailSlideover } from "../../components/TemplateDetailSlideover";

const baseTemplate: CampaignTemplate = {
  id: "template-a",
  tenant_id: "tenant-1",
  slug: "verified-template",
  name: "Verified template",
  subject: "Saved subject",
  preview_text: "Saved preview",
  body_html: "<p>Saved body</p>",
  variables: [{ name: "first_name", label: "First name", default: "Ada" }],
  tags: ["kind:regular"],
  goal: "welcome",
  template_kind: "editable",
  review_status: "approved",
  source_license_status: "owned",
  is_favorited: false,
  capabilities: {
    can_preview: true,
    can_favorite: true,
    can_adapt: true,
    can_use_directly: true,
    can_create_campaign: true,
    can_edit_directly: true,
    can_clone: true,
    can_delete: true,
    can_archive: true,
    can_restore: false,
    has_source_html: true,
    has_source_mjml: false,
    has_desktop_preview: true,
    has_mobile_preview: false,
  },
  recommended_action: "campaign_template_create_campaign",
  warnings: [],
  version: 1,
  etag: '"campaign-template:template-a:v1"',
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canWrite = true;
  mocks.getRegions.mockResolvedValue({ data: { regions: [] } });
  mocks.favorite.mockResolvedValue({ data: { ok: true, favorited: true } });
  mocks.unfavorite.mockResolvedValue({ data: { ok: true, favorited: false } });
  mocks.archiveTemplate.mockResolvedValue({
    data: {
      ...baseTemplate,
      archived_at: "2026-07-29T12:00:00.000Z",
      version: 2,
      etag: '"campaign-template:template-a:v2"',
      capabilities: {
        ...baseTemplate.capabilities!,
        can_archive: false,
        can_restore: true,
      },
    },
  });
  mocks.restoreTemplate.mockResolvedValue({
    data: {
      ...baseTemplate,
      version: 3,
      etag: '"campaign-template:template-a:v3"',
    },
  });
  mocks.getRevisions.mockResolvedValue({
    data: {
      items: [
        {
          version: 1,
          etag: '"campaign-template:template-a:v1"',
          transition: "created",
          name: baseTemplate.name,
          subject: baseTemplate.subject,
          snapshot_time: "2026-07-29T10:00:00.000Z",
        },
      ],
      page: 1,
      per_page: 20,
      total: 1,
    },
  });
  mocks.getRevision.mockResolvedValue({
    data: {
      version: 1,
      etag: '"campaign-template:template-a:v1"',
      transition: "created",
      snapshot_time: "2026-07-29T10:00:00.000Z",
      snapshot: baseTemplate,
    },
  });
  mocks.updateTemplate.mockImplementation(
    async (_id: string, patch: Partial<CampaignTemplate>) => ({
      data: { ...baseTemplate, ...patch },
    }),
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function renderDetail(
  template: CampaignTemplate = baseTemplate,
  callbacks: Partial<{
    onAdapt: (template: CampaignTemplate) => void;
    onClose: () => void;
    onDeleted: (id: string) => void;
    onDuplicate: (template: CampaignTemplate) => void;
    onFavoriteChanged: (template: CampaignTemplate) => void;
    onUpdated: (template: CampaignTemplate) => void;
  }> = {},
): {
  onClose: () => void;
  onDuplicate: (template: CampaignTemplate) => void;
  onUpdated: (template: CampaignTemplate) => void;
  rerender: (next: CampaignTemplate) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onClose = callbacks.onClose ?? vi.fn();
  const onDuplicate = callbacks.onDuplicate ?? vi.fn();
  const onUpdated = callbacks.onUpdated ?? vi.fn();
  const render = (next: CampaignTemplate): void => {
    root?.render(
      <TemplateDetailSlideover
        template={next}
        onClose={onClose}
        onUpdated={onUpdated}
        onDeleted={callbacks.onDeleted ?? vi.fn()}
        onDuplicate={onDuplicate}
        onAdapt={callbacks.onAdapt}
        onFavoriteChanged={callbacks.onFavoriteChanged}
      />,
    );
  };
  act(() => render(template));
  return {
    onClose,
    onDuplicate,
    onUpdated,
    rerender: (next) => act(() => render(next)),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

function button(label: string): HTMLButtonElement {
  const match = findButton(label);
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

function setInput(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  act(() => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    // Native value setters require the concrete input as their receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) Reflect.apply(setter, input, [value]);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function blur(input: HTMLElement): void {
  act(() => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

describe("TemplateDetailSlideover maturity boundary", () => {
  it("fails closed until the complete record is verified", async () => {
    const load = deferred<{ data: CampaignTemplate }>();
    mocks.getTemplate.mockReturnValue(load.promise);
    renderDetail();

    expect(document.body.textContent).toContain("Loading template details");
    expect(document.body.textContent).toContain(
      "Editing and consequential actions stay locked",
    );
    expect(document.body.textContent).not.toContain("Use in campaign");
    expect(document.body.textContent).not.toContain("Regions");
    expect(document.querySelector('[aria-label="Template name"]')).toBeNull();

    load.resolve({ data: baseTemplate });
    await flush();

    expect(document.body.textContent).toContain("Full record verified");
    expect(button("Use in campaign").disabled).toBe(false);
    expect(button("Regions").disabled).toBe(false);
  });

  it("shows an explicit load error and retries before unlocking actions", async () => {
    mocks.getTemplate
      .mockResolvedValueOnce({ error: { message: "Gateway unavailable" } })
      .mockResolvedValueOnce({ data: baseTemplate });
    renderDetail();
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Gateway unavailable",
    );
    expect(document.body.textContent).not.toContain("Use in campaign");

    act(() => button("Retry loading template").click());
    await flush();

    expect(mocks.getTemplate).toHaveBeenCalledTimes(2);
    expect(button("Use in campaign").disabled).toBe(false);
  });

  it("rejects a malformed success payload at the runtime boundary", async () => {
    mocks.getTemplate.mockResolvedValue({
      data: {
        ...baseTemplate,
        tags: ["valid", 42],
      },
    });
    renderDetail();
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "incomplete template record",
    );
    expect(document.body.textContent).not.toContain("Use in campaign");
    expect(document.querySelector('[aria-label="Template name"]')).toBeNull();
  });

  it("ignores a late record response instead of replacing a dirty newer draft", async () => {
    const firstLoad = deferred<{ data: CampaignTemplate }>();
    const secondTemplate = {
      ...baseTemplate,
      id: "template-b",
      slug: "template-b",
      name: "Template B",
      subject: "Template B saved subject",
    };
    mocks.getTemplate.mockImplementation((id: string) =>
      id === baseTemplate.id
        ? firstLoad.promise
        : Promise.resolve({ data: secondTemplate }),
    );
    const detail = renderDetail();
    detail.rerender(secondTemplate);
    await flush();
    act(() => button("Edit").click());

    const subject = document.querySelector("#tpl-subject");
    expect(subject).toBeInstanceOf(HTMLInputElement);
    setInput(subject as HTMLInputElement, "Local B draft");

    firstLoad.resolve({
      data: { ...baseTemplate, subject: "Late template A response" },
    });
    await flush();

    expect((subject as HTMLInputElement).value).toBe("Local B draft");
    expect(document.body.textContent).toContain("Unsaved local changes");
  });

  it("routes close button, backdrop, and Escape through one discard decision", async () => {
    mocks.getTemplate.mockResolvedValue({ data: baseTemplate });
    const detail = renderDetail();
    await flush();
    act(() => button("Edit").click());
    const html = document.querySelector("#tpl-html") as HTMLTextAreaElement;
    setInput(html, "<p>Unsaved draft</p>");

    expect(button("Use in campaign").disabled).toBe(true);
    expect(button("Duplicate").disabled).toBe(true);
    expect(button("Regions").disabled).toBe(true);
    expect(button("Archive template").disabled).toBe(true);

    act(() => {
      (
        document.querySelector(
          '[aria-label="Close template details"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(detail.onClose).not.toHaveBeenCalled();
    act(() => button("Keep editing").click());

    act(() => {
      (document.querySelector(".slideover-overlay") as HTMLElement).click();
    });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    act(() => button("Keep editing").click());

    const behavior = mocks.behavior.mock.calls.at(-1)?.[0] as {
      disableEscape: boolean;
      onClose: () => void;
    };
    expect(behavior.disableEscape).toBe(false);
    act(() => behavior.onClose());
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    act(() => button("Discard changes").click());

    expect(detail.onClose).toHaveBeenCalledOnce();
  });

  it("blocks every close path while a mutation is in flight", async () => {
    const update = deferred<{ data: CampaignTemplate }>();
    mocks.getTemplate.mockResolvedValue({ data: baseTemplate });
    mocks.updateTemplate.mockReturnValue(update.promise);
    const detail = renderDetail();
    await flush();
    act(() => button("Edit").click());
    const subject = document.querySelector("#tpl-subject") as HTMLInputElement;
    setInput(subject, "Saving subject");
    blur(subject);
    await flush();
    expect(mocks.updateTemplate).toHaveBeenCalledOnce();

    const behavior = mocks.behavior.mock.calls.at(-1)?.[0] as {
      onClose: () => void;
    };
    act(() => {
      behavior.onClose();
      (document.querySelector(".slideover-overlay") as HTMLElement).click();
      (
        document.querySelector(
          '[aria-label="Close template details"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(detail.onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.body.textContent).toContain(
      "Wait for the current template operation",
    );

    update.resolve({ data: { ...baseTemplate, subject: "Saving subject" } });
    await flush();
  });

  it("serializes field mutations and preserves edits made during an earlier save", async () => {
    const firstUpdate = deferred<{ data: CampaignTemplate }>();
    const secondUpdate = deferred<{ data: CampaignTemplate }>();
    mocks.getTemplate.mockResolvedValue({ data: baseTemplate });
    mocks.updateTemplate
      .mockReturnValueOnce(firstUpdate.promise)
      .mockReturnValueOnce(secondUpdate.promise);
    renderDetail();
    await flush();
    act(() => button("Edit").click());

    const subject = document.querySelector("#tpl-subject") as HTMLInputElement;
    const preview = document.querySelector("#tpl-preview") as HTMLInputElement;
    setInput(subject, "First serialized subject");
    blur(subject);
    setInput(preview, "Second serialized preview");
    blur(preview);
    await flush();

    expect(mocks.updateTemplate).toHaveBeenCalledTimes(1);
    firstUpdate.resolve({
      data: { ...baseTemplate, subject: "First serialized subject" },
    });
    await flush();

    expect(mocks.updateTemplate).toHaveBeenCalledTimes(2);
    expect(mocks.updateTemplate.mock.calls[1]?.[1]).toEqual({
      preview_text: "Second serialized preview",
    });
    expect(preview.value).toBe("Second serialized preview");

    secondUpdate.resolve({
      data: {
        ...baseTemplate,
        subject: "First serialized subject",
        preview_text: "Second serialized preview",
      },
    });
    await flush();
    expect(document.body.textContent).toContain("Saved server version");
  });

  it("fails closed when a successful update response is malformed", async () => {
    mocks.getTemplate.mockResolvedValue({ data: baseTemplate });
    mocks.updateTemplate.mockResolvedValue({
      data: { ...baseTemplate, name: null },
    });
    const detail = renderDetail();
    await flush();
    act(() => button("Edit").click());
    const subject = document.querySelector("#tpl-subject") as HTMLInputElement;
    setInput(subject, "Possibly committed subject");
    blur(subject);
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "update may have committed",
    );
    expect(document.body.textContent).not.toContain("Use in campaign");
    expect(detail.onUpdated).not.toHaveBeenCalled();
  });

  it("locks edits and consequential actions after an offline-queued update", async () => {
    mocks.getTemplate.mockResolvedValue({ data: baseTemplate });
    mocks.updateTemplate.mockResolvedValue({
      queued: true,
      receipt: {
        queueId: "template-mutation-1",
        queuedAt: "2026-07-22T00:00:00.000Z",
        state: "pending",
        resource: "campaign-templates",
        action: "Update template",
        record: "Template template-a",
      },
    });
    renderDetail();
    await flush();
    act(() => button("Edit").click());
    const subject = document.querySelector("#tpl-subject") as HTMLInputElement;
    setInput(subject, "Queued subject");
    blur(subject);
    await flush();

    expect(document.body.textContent).toContain("pending sync");
    expect(document.body.textContent).toContain(
      "Reopen this detail after sync",
    );
    expect(button("Use in campaign").disabled).toBe(true);
    expect(button("Duplicate").disabled).toBe(true);
    expect(button("Regions").disabled).toBe(true);
    expect(button("Archive template").disabled).toBe(true);
    expect(
      (
        document.querySelector(
          '[aria-label="Template name"]',
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(subject.disabled).toBe(true);
    expect(mocks.updateTemplate).toHaveBeenCalledWith(
      baseTemplate.id,
      { subject: "Queued subject" },
      { expectedVersion: '"campaign-template:template-a:v1"' },
    );
  });

  it("fails closed on a stale edit and guides the operator to reload", async () => {
    mocks.getTemplate.mockResolvedValue({ data: baseTemplate });
    mocks.updateTemplate.mockResolvedValue({
      error: {
        kind: "http",
        status: 412,
        code: "precondition_failed",
        message: "Precondition failed",
      },
    });
    renderDetail();
    await flush();
    act(() => button("Edit").click());
    const subject = document.querySelector("#tpl-subject") as HTMLInputElement;
    setInput(subject, "A stale local edit");
    blur(subject);
    await flush();

    expect(mocks.updateTemplate).toHaveBeenCalledWith(
      baseTemplate.id,
      { subject: "A stale local edit" },
      { expectedVersion: baseTemplate.etag },
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "changed after it was opened",
    );
    expect(document.body.textContent).toContain("Retry loading template");
    expect(document.body.textContent).not.toContain("Use in campaign");
  });

  it("archives recoverably with If-Match and keeps lineage/history intact", async () => {
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    mocks.getTemplate.mockResolvedValue({ data: baseTemplate });
    renderDetail(baseTemplate, { onClose, onDeleted });
    await flush();

    act(() => button("Archive template").click());
    const confirmation = document.querySelector('[role="alertdialog"]');
    expect(confirmation?.textContent).toContain("remains recoverable");
    const confirmButton = confirmation?.querySelectorAll("button").item(1);
    act(() => (confirmButton as HTMLButtonElement).click());
    await flush();

    expect(mocks.archiveTemplate).toHaveBeenCalledWith(
      baseTemplate.id,
      baseTemplate.etag,
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("remains recoverable"),
    );
    expect(onDeleted).toHaveBeenCalledWith(baseTemplate.id);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("restores an archived template and exposes read-only revision snapshots", async () => {
    const archivedTemplate: CampaignTemplate = {
      ...baseTemplate,
      archived_at: "2026-07-29T12:00:00.000Z",
      version: 2,
      etag: '"campaign-template:template-a:v2"',
      capabilities: {
        ...baseTemplate.capabilities!,
        can_favorite: false,
        can_adapt: false,
        can_use_directly: false,
        can_create_campaign: false,
        can_edit_directly: false,
        can_clone: false,
        can_delete: false,
        can_archive: false,
        can_restore: true,
      },
      warnings: [
        {
          code: "template_archived",
          message: "This template is archived and cannot be edited or used.",
          recommended_action: "campaign_template_restore",
        },
      ],
    };
    mocks.getTemplate.mockResolvedValue({ data: archivedTemplate });
    const onDeleted = vi.fn();
    renderDetail(archivedTemplate, { onDeleted });
    await flush();

    expect(document.body.textContent).toContain("Archived · recoverable");
    expect(findButton("Edit")).toBeUndefined();
    expect(findButton("Regions")).toBeUndefined();
    act(() => button("History").click());
    await flush();
    expect(mocks.getRevisions).toHaveBeenCalledWith(archivedTemplate.id, {
      page: 1,
      per_page: 20,
    });
    expect(document.body.textContent).toContain("Version 1");
    act(() => button("Inspect snapshot").click());
    await flush();
    expect(mocks.getRevision).toHaveBeenCalledWith(archivedTemplate.id, 1);
    expect(document.body.textContent).toContain("Version 1 snapshot");

    act(() => button("Restore template").click());
    await flush();
    expect(mocks.restoreTemplate).toHaveBeenCalledWith(
      archivedTemplate.id,
      archivedTemplate.etag,
    );
    expect(onDeleted).toHaveBeenCalledWith(archivedTemplate.id);
  });

  it("contains thrown region failures and offers an explicit retry", async () => {
    mocks.getTemplate.mockResolvedValue({ data: baseTemplate });
    mocks.getRegions
      .mockRejectedValueOnce(new Error("Region parser unavailable"))
      .mockResolvedValueOnce({ data: { regions: [] } });
    renderDetail();
    await flush();

    act(() => button("Regions").click());
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Region parser unavailable",
    );

    act(() => button("Retry saved regions").click());
    await flush();
    expect(mocks.getRegions).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("No editable regions");
  });

  it("rejects malformed region success data instead of crashing the pane", async () => {
    mocks.getTemplate.mockResolvedValue({ data: baseTemplate });
    mocks.getRegions.mockResolvedValue({
      data: {
        regions: [{ name: "hero", default_html: "<h1>Hi</h1>", position: -1 }],
      },
    });
    renderDetail();
    await flush();
    act(() => button("Regions").click());
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "invalid regions response",
    );
    expect(document.body.textContent).not.toContain("offset -1");
  });

  it("stays put on failed campaign creation or clone and closes only on confirmation", async () => {
    mocks.getTemplate.mockResolvedValue({ data: baseTemplate });
    mocks.createCampaign.mockResolvedValueOnce({
      error: { message: "Campaign service unavailable" },
    });
    mocks.clone.mockResolvedValue({
      error: { message: "Clone service unavailable" },
    });
    const detail = renderDetail();
    await flush();

    act(() => button("Use in campaign").click());
    await flush();
    expect(detail.onClose).not.toHaveBeenCalled();
    expect(mocks.setSection).not.toHaveBeenCalled();

    act(() => button("Duplicate").click());
    await flush();
    expect(detail.onDuplicate).not.toHaveBeenCalled();
    expect(detail.onClose).not.toHaveBeenCalled();

    mocks.createCampaign.mockResolvedValueOnce({
      data: { id: "campaign-1", name: "Confirmed campaign" },
    });
    act(() => button("Use in campaign").click());
    await flush();
    expect(mocks.setSection).toHaveBeenCalledWith("campaigns");
    expect(detail.onClose).toHaveBeenCalledOnce();
  });

  it("reconciles an exact clone and rejects malformed clone/create confirmations", async () => {
    const onDuplicate = vi.fn();
    mocks.getTemplate.mockResolvedValue({ data: baseTemplate });
    mocks.clone
      .mockResolvedValueOnce({ data: { ...baseTemplate, id: null } })
      .mockResolvedValueOnce({
        data: {
          ...baseTemplate,
          id: "template-copy",
          slug: "verified-template-copy",
          name: "Verified template (copy)",
        },
      });
    mocks.createCampaign.mockResolvedValue({ data: { id: null, name: 42 } });
    const detail = renderDetail(baseTemplate, { onDuplicate });
    await flush();

    act(() => button("Use in campaign").click());
    await flush();
    expect(mocks.setSection).not.toHaveBeenCalled();
    expect(detail.onClose).not.toHaveBeenCalled();

    act(() => button("Duplicate").click());
    await flush();
    expect(onDuplicate).not.toHaveBeenCalled();
    expect(detail.onClose).not.toHaveBeenCalled();

    act(() => button("Duplicate").click());
    await flush();
    expect(onDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "template-copy" }),
    );
    expect(detail.onClose).not.toHaveBeenCalled();
  });

  it("keeps viewer and platform authority truth after verification", async () => {
    mocks.canWrite = false;
    mocks.getTemplate.mockResolvedValue({ data: baseTemplate });
    renderDetail();
    await flush();

    expect(
      (
        document.querySelector(
          '[aria-label="Template name"]',
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(button("Use in campaign").disabled).toBe(true);
    expect(button("Duplicate").disabled).toBe(true);
    expect(
      (
        document.querySelector(
          '[aria-label="Add to favorites"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(document.body.textContent).not.toContain("Archive template");
  });

  it("keeps verified platform originals read-only while allowing an editor to clone", async () => {
    const platformTemplate = {
      ...baseTemplate,
      tenant_id: undefined,
      capabilities: {
        ...baseTemplate.capabilities!,
        can_edit_directly: false,
        can_delete: false,
        can_archive: false,
      },
    };
    mocks.getTemplate.mockResolvedValue({ data: platformTemplate });
    renderDetail(platformTemplate);
    await flush();

    expect(button("Use in campaign").disabled).toBe(false);
    expect(button("Clone to edit").disabled).toBe(false);
    expect(document.body.textContent).toContain("read-only");
    expect(document.body.textContent).not.toContain("Archive template");
    act(() => button("Edit").click());
    expect(
      (document.querySelector("#tpl-subject") as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("makes an approved reference editable only through Make it mine", async () => {
    const approvedReference = {
      ...baseTemplate,
      template_kind: "reference" as const,
      source_provider: "external-catalog",
      source_brand: "Example Studio",
      source_license_status: "owned",
      review_status: "approved" as const,
      capabilities: {
        ...baseTemplate.capabilities!,
        can_use_directly: false,
        can_create_campaign: false,
        can_edit_directly: false,
        can_clone: false,
        can_delete: false,
        can_archive: false,
      },
      recommended_action: "campaign_template_adapt",
      warnings: [
        {
          code: "adaptation_only",
          message:
            "This inspiration can guide an original editable adaptation.",
          recommended_action: "campaign_template_adapt",
        },
      ],
    };
    const onAdapt = vi.fn();
    const onDeleted = vi.fn();
    mocks.getTemplate.mockResolvedValue({ data: approvedReference });
    const detail = renderDetail(approvedReference, { onAdapt, onDeleted });
    await flush();

    expect(
      (
        document.querySelector(
          '[aria-label="Template name"]',
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(button("Make it mine").disabled).toBe(false);
    expect(findButton("Edit")).toBeUndefined();
    expect(findButton("Regions")).toBeUndefined();
    expect(findButton("Duplicate")).toBeUndefined();
    expect(findButton("Archive template")).toBeUndefined();
    expect(findButton("Use in campaign")).toBeUndefined();
    expect(document.body.textContent).toContain(
      "inspiration and its source details stay unchanged",
    );

    act(() => button("Make it mine").click());

    expect(onAdapt).toHaveBeenCalledWith(approvedReference);
    expect(detail.onClose).toHaveBeenCalledTimes(1);
    expect(mocks.createCampaign).not.toHaveBeenCalled();
    expect(mocks.clone).not.toHaveBeenCalled();
    expect(mocks.archiveTemplate).not.toHaveBeenCalled();
    expect(mocks.updateTemplate).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("renders a screenshot-only reference from its hosted preview asset", async () => {
    const screenshotReference: CampaignTemplate = {
      ...baseTemplate,
      body_html: "",
      template_kind: "reference",
      source_provider: "external-catalog",
      preview_assets: [
        {
          variant: "desktop",
          url: "https://assets.postwave.test/hosted/reference.png",
          mime_type: "image/png",
          width: 1200,
          height: 2400,
          size_bytes: 80_000,
          status: "ready",
        },
      ],
      capabilities: {
        ...baseTemplate.capabilities!,
        can_use_directly: false,
        can_create_campaign: false,
        can_edit_directly: false,
        can_clone: false,
        can_delete: false,
        can_archive: false,
        has_source_html: false,
      },
    };
    mocks.getTemplate.mockResolvedValue({ data: screenshotReference });
    renderDetail(screenshotReference, { onAdapt: vi.fn() });
    await flush();

    const image = document.querySelector<HTMLImageElement>(
      'img[alt="Hosted desktop preview of Verified template"]',
    );
    expect(image?.src).toBe(
      "https://assets.postwave.test/hosted/reference.png",
    );
    expect(document.body.textContent).toContain(
      "The original provider page is never loaded",
    );
  });

  it("keeps pending and unowned inspiration previewable but non-executable", async () => {
    const pendingReference = {
      ...baseTemplate,
      template_kind: "reference" as const,
      source_provider: "external-catalog",
      source_license_status: "personal-use-unreviewed",
      review_status: "pending" as const,
      capabilities: {
        ...baseTemplate.capabilities!,
        can_adapt: false,
        can_use_directly: false,
        can_create_campaign: false,
        can_edit_directly: false,
        can_clone: false,
        can_delete: false,
        can_archive: false,
      },
      recommended_action: "await_review",
      warnings: [
        {
          code: "review_pending",
          message:
            "This inspiration is awaiting source review; adaptation unlocks after usage rights are approved.",
          recommended_action: "campaign_template_review",
        },
      ],
    };
    mocks.getTemplate.mockResolvedValue({ data: pendingReference });
    renderDetail(pendingReference);
    await flush();

    expect(button("Make it mine").disabled).toBe(true);
    expect(findButton("Edit")).toBeUndefined();
    expect(findButton("Regions")).toBeUndefined();
    expect(findButton("Duplicate")).toBeUndefined();
    expect(findButton("Archive template")).toBeUndefined();
    expect(document.body.textContent).toContain("awaiting source review");
    expect(document.body.textContent).toContain("usage rights are approved");
    expect(
      (
        document.querySelector(
          '[aria-label="Add to favorites"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
