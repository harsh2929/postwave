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
  behavior: vi.fn(),
  canAdmin: true,
  canWrite: true,
  deleteForm: vi.fn(),
  getEmbed: vi.fn(),
  getForm: vi.fn(),
  listSubmissions: vi.fn(),
  updateForm: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    deleteForm: mocks.deleteForm,
    getForm: mocks.getForm,
    getFormEmbed: mocks.getEmbed,
    listFormSubmissions: mocks.listSubmissions,
    updateForm: mocks.updateForm,
  },
}));

vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: ({
    busy,
    cancelLabel = "Cancel",
    confirmLabel = "Confirm",
    onClose,
    onConfirm,
    open,
    title,
  }: {
    busy?: boolean;
    cancelLabel?: string;
    confirmLabel?: string;
    onClose: () => void;
    onConfirm: () => void | Promise<void>;
    open: boolean;
    title: string;
  }): ReactElement | null =>
    open ? (
      <div role="alertdialog" aria-label={title}>
        <span>{title}</span>
        <button type="button" disabled={busy} onClick={onClose}>
          {cancelLabel}
        </button>
        <button type="button" disabled={busy} onClick={() => void onConfirm()}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));
vi.mock("../../components/forms/EmbedPreviewCard", () => ({
  EmbedPreviewCard: () => null,
}));
vi.mock("../../components/forms/FormFieldsEditor", () => ({
  FormFieldsEditor: () => <button type="button">+ Add field</button>,
  firstFormFieldError: () => null,
}));
vi.mock("../../components/forms/FormSpamSettings", () => ({
  FormSpamSettings: () => null,
  applySpamSettings: (settings: Record<string, unknown>) => settings,
  parseSpamSettings: () => ({
    captchaProvider: "",
    captchaSiteKey: "",
    honeypotEnabled: true,
    rateLimitPerMin: "",
  }),
}));
vi.mock("../../components/forms/SubmissionsAnalytics", () => ({
  SubmissionsAnalytics: () => <div>Submission analytics</div>,
}));
vi.mock("../../components/PendingSyncStatus", () => ({
  PendingSyncStatus: () => null,
}));
vi.mock("../../hooks/useSlideoverBehavior", () => ({
  useSlideoverBehavior: mocks.behavior,
}));
vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: () => () => undefined,
}));
vi.mock("../../lib/safe-url", () => ({
  safeFormSuccessRedirectUrl: (value: string) => value,
}));
vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useCanWrite: () => mocks.canWrite,
}));
vi.mock("../../lib/tauri", () => ({
  tauriApi: { openUrl: vi.fn() },
}));
vi.mock("../../components/Toast", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { FormDetailSlideover } from "../../components/FormDetailSlideover";
import type { FormDetail } from "../../lib/api-client";

const FORM: FormDetail = {
  id: "form-1",
  name: "Launch list",
  slug: "launch",
  optInMode: "double" as const,
  status: "published" as const,
  structure: {
    fields: [{ id: "email", kind: "email", label: "Email", required: true }],
  },
  settings: {},
  updatedAt: "2026-07-21T10:00:00.000Z",
};

const EMBED = {
  flavor: "iframe" as const,
  snippet: '<iframe src="https://forms.example.test/forms/launch"></iframe>',
  language: "html",
  instructions: "Paste in the page body.",
  public_host: "https://forms.example.test",
  public_url: "https://forms.example.test/forms/launch",
};
const FORM_VERSION = '"form:form-1:v1"';
const NEXT_FORM_VERSION = '"form:form-1:v2"';
type FormResult = { data: FormDetail; serverVersion?: string };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAdmin = true;
  mocks.canWrite = true;
  mocks.getForm.mockResolvedValue({ data: FORM, serverVersion: FORM_VERSION });
  mocks.getEmbed.mockResolvedValue({ data: EMBED });
  mocks.listSubmissions.mockResolvedValue({ data: [] });
  mocks.updateForm.mockResolvedValue({
    data: FORM,
    serverVersion: NEXT_FORM_VERSION,
  });
  mocks.deleteForm.mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function renderDetail(
  options: {
    form?: typeof FORM;
    key?: string;
    onChanged?: () => void;
    onClose?: () => void;
    onDeleted?: () => void;
  } = {},
): void {
  const form = options.form ?? FORM;
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(
      <FormDetailSlideover
        key={options.key ?? form.id}
        formId={form.id}
        initial={form}
        onChanged={options.onChanged ?? vi.fn()}
        onClose={options.onClose ?? vi.fn()}
        onDeleted={options.onDeleted ?? vi.fn()}
      />,
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

function editName(value: string): HTMLInputElement {
  act(() => button("Settings").click());
  const input = document.querySelector<HTMLInputElement>("#form-name");
  if (!input) throw new Error("Missing form name input");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe("FormDetailSlideover mature workspace", () => {
  it("routes X, Escape, and backdrop through discard confirmation and restores the baseline", async () => {
    const onClose = vi.fn();
    renderDetail({ onClose });
    await flush();
    const name = editName("Unsaved launch list");

    act(() => button("×").click());
    expect(document.body.textContent).toContain(
      "Discard unsaved form changes?",
    );
    expect(onClose).not.toHaveBeenCalled();
    act(() => button("Cancel").click());
    expect(name.value).toBe("Unsaved launch list");

    const escapeBehavior = mocks.behavior.mock.calls.at(-1)?.[0] as {
      disableEscape: boolean;
      onClose: () => void;
    };
    expect(escapeBehavior.disableEscape).toBe(false);
    act(() => escapeBehavior.onClose());
    expect(document.body.textContent).toContain(
      "Discard unsaved form changes?",
    );
    act(() => button("Cancel").click());

    const backdrop = document.querySelector(
      '[data-testid="form-detail-backdrop"]',
    );
    if (!(backdrop instanceof HTMLElement)) throw new Error("Missing backdrop");
    act(() => backdrop.click());
    act(() => button("Discard changes").click());

    expect(name.value).toBe(FORM.name);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("locks every close path and single-flights a double save", async () => {
    const pending = deferred<FormResult>();
    mocks.updateForm.mockReturnValueOnce(pending.promise);
    const onClose = vi.fn();
    renderDetail({ onClose });
    await flush();
    editName("Changed once");

    act(() => {
      button("Save settings").click();
      button("Save settings").click();
    });
    expect(mocks.updateForm).toHaveBeenCalledOnce();
    expect(
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Close form details"]',
      )?.disabled,
    ).toBe(true);
    const savingBehavior = mocks.behavior.mock.calls.at(-1)?.[0] as {
      disableEscape: boolean;
      onClose: () => void;
    };
    expect(savingBehavior.disableEscape).toBe(true);
    const backdrop = document.querySelector(
      '[data-testid="form-detail-backdrop"]',
    );
    act(() => {
      savingBehavior.onClose();
      (backdrop as HTMLElement).click();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();

    pending.resolve({
      data: { ...FORM, name: "Changed once" },
      serverVersion: NEXT_FORM_VERSION,
    });
    await flush();
    expect(
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Close form details"]',
      )?.disabled,
    ).toBe(false);
  });

  it("single-flights publication and deletion actions", async () => {
    const publish = deferred<FormResult>();
    mocks.updateForm.mockReturnValueOnce(publish.promise);
    const onDeleted = vi.fn();
    renderDetail({ onDeleted });
    await flush();

    act(() => {
      button("Move to draft").click();
      button("Move to draft").click();
    });
    expect(mocks.updateForm).toHaveBeenCalledOnce();
    publish.resolve({
      data: { ...FORM, status: "draft" as const },
      serverVersion: NEXT_FORM_VERSION,
    });
    await flush();

    const deletion = deferred<{ data: { ok: boolean } }>();
    mocks.deleteForm.mockReturnValueOnce(deletion.promise);
    act(() => button("Settings").click());
    act(() => button("Delete form").click());
    act(() => {
      button("Delete").click();
      button("Delete").click();
    });
    expect(mocks.deleteForm).toHaveBeenCalledOnce();
    expect(mocks.deleteForm).toHaveBeenCalledWith(FORM.id, {
      expectedVersion: NEXT_FORM_VERSION,
    });
    deletion.resolve({ data: { ok: true } });
    await flush();
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it("reconciles a stale admin deletion instead of deleting a newer form", async () => {
    mocks.deleteForm.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 412,
        code: "precondition_failed",
        message: "the resource was modified",
      },
    });
    const onDeleted = vi.fn();
    renderDetail({ onDeleted });
    await flush();

    act(() => button("Settings").click());
    act(() => button("Delete form").click());
    act(() => button("Delete").click());
    await flush();

    expect(mocks.deleteForm).toHaveBeenCalledWith(FORM.id, {
      expectedVersion: FORM_VERSION,
    });
    expect(onDeleted).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.body.textContent).toContain("Form changed elsewhere");
    expect(button("Reload current version")).toBeTruthy();
  });
});

describe("FormDetailSlideover resilient interaction contracts", () => {
  it("releases the operation and close locks when a request throws", async () => {
    mocks.updateForm.mockRejectedValueOnce(new Error("Network disconnected"));
    renderDetail();
    await flush();
    editName("Retryable change");
    act(() => button("Save settings").click());
    await flush();

    expect(
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Close form details"]',
      )?.disabled,
    ).toBe(false);
    expect(button("Save settings").disabled).toBe(false);

    mocks.updateForm.mockResolvedValueOnce({
      data: { ...FORM, name: "Retryable change" },
      serverVersion: NEXT_FORM_VERSION,
    });
    act(() => button("Save settings").click());
    await flush();
    expect(mocks.updateForm).toHaveBeenCalledTimes(2);
  });

  it("preserves a dirty draft on 412 and requires explicit reconciliation", async () => {
    mocks.updateForm.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 412,
        code: "precondition_failed",
        message: "the resource was modified",
      },
    });
    renderDetail();
    await flush();
    const name = editName("My local edit");
    act(() => button("Save settings").click());
    await flush();

    expect(mocks.updateForm).toHaveBeenCalledWith(FORM.id, expect.any(Object), {
      expectedVersion: FORM_VERSION,
      requireOnline: true,
    });
    expect(name.value).toBe("My local edit");
    expect(document.body.textContent).toContain("Form changed elsewhere");
    expect(name.readOnly).toBe(true);

    const remote = { ...FORM, name: "Remote current version" };
    mocks.getForm.mockResolvedValue({
      data: remote,
      serverVersion: NEXT_FORM_VERSION,
    });
    act(() => button("Reload current version").click());
    expect(document.body.textContent).toContain(
      "Reload the current server version?",
    );
    act(() => button("Discard and reload").click());
    await flush();

    expect(document.querySelector("#form-slideover-title")?.textContent).toBe(
      remote.name,
    );
    expect(
      document.querySelector<HTMLInputElement>("#form-name")?.readOnly,
    ).toBe(false);
  });

  it("allows clean dismissal while the abortable embed read is pending", async () => {
    const embed = deferred<{ data: typeof EMBED }>();
    mocks.getEmbed.mockReturnValueOnce(embed.promise);
    const onClose = vi.fn();
    renderDetail({ onClose });
    await flush();

    const close = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close form details"]',
    );
    expect(close?.disabled).toBe(false);
    act(() => close?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("implements automatic APG keyboard tabs with connected panels", async () => {
    renderDetail();
    await flush();
    const overview = button("Overview");
    overview.focus();
    act(() => {
      overview.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
      );
    });
    const share = button("Share");
    expect(share.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(share);
    expect(
      document.getElementById(share.getAttribute("aria-controls") ?? ""),
    ).not.toBeNull();

    act(() => {
      share.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "End" }),
      );
    });
    expect(button("Settings").getAttribute("aria-selected")).toBe("true");
    act(() => {
      button("Settings").dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Home" }),
      );
    });
    expect(button("Overview").getAttribute("aria-selected")).toBe("true");
  });

  it("enforces the admin PII boundary and always discloses the 1,000-row cap", async () => {
    mocks.canAdmin = false;
    renderDetail();
    await flush();
    act(() => button("Responses").click());
    expect(document.body.textContent).toContain(
      "Response details are admin-only",
    );
    expect(mocks.listSubmissions).not.toHaveBeenCalled();
    act(() => button("Settings").click());
    expect(document.body.textContent).toContain("Deletion is admin-only");
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Delete form",
      ),
    ).toBe(false);

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    mocks.canAdmin = true;
    renderDetail();
    await flush();
    act(() => button("Responses").click());
    expect(document.body.textContent).toContain(
      "1,000 most recent response rows",
    );
    expect(document.body.textContent).toContain("Confidential admin workspace");
  });

  it("fails closed for an unrecognised field wire shape and omits structure from settings saves", async () => {
    const unsupported = {
      ...FORM,
      structure: {
        fields: [
          { id: "email", kind: "email", label: "Email", required: true },
          { key: "company", label: "Company", type: "text" },
        ],
      },
    };
    mocks.getForm.mockResolvedValue({
      data: unsupported,
      serverVersion: FORM_VERSION,
    });
    mocks.updateForm.mockResolvedValue({
      data: unsupported,
      serverVersion: NEXT_FORM_VERSION,
    });
    renderDetail({ form: unsupported });
    await flush();
    editName("Safe rename");

    expect(document.body.textContent).toContain(
      "unrecognised or mixed field schema",
    );
    expect(document.body.textContent).not.toContain("+ Add field");
    act(() => button("Save settings").click());
    await flush();
    expect(mocks.updateForm).toHaveBeenCalledOnce();
    expect(mocks.updateForm.mock.calls[0]?.[0]).toBe(FORM.id);
    expect(mocks.updateForm.mock.calls[0]?.[1]).not.toHaveProperty("structure");
    expect(mocks.updateForm.mock.calls[0]?.[2]).toEqual({
      expectedVersion: FORM_VERSION,
      requireOnline: true,
    });
  });

  it("ignores a completed mutation after the keyed form identity changes", async () => {
    const pending = deferred<FormResult>();
    mocks.updateForm.mockReturnValueOnce(pending.promise);
    const onChanged = vi.fn();
    renderDetail({ key: FORM.id, onChanged });
    await flush();
    editName("Old identity edit");
    act(() => button("Save settings").click());

    const second = {
      ...FORM,
      id: "form-2",
      name: "Waitlist two",
      slug: "waitlist-two",
    };
    mocks.getForm.mockImplementation((id: string) =>
      Promise.resolve({
        data: id === second.id ? second : FORM,
        serverVersion: id === second.id ? '"form:form-2:v1"' : FORM_VERSION,
      }),
    );
    renderDetail({ form: second, key: second.id, onChanged });
    await flush();
    pending.resolve({
      data: { ...FORM, name: "Old identity result" },
      serverVersion: NEXT_FORM_VERSION,
    });
    await flush();

    expect(document.querySelector("#form-slideover-title")?.textContent).toBe(
      second.name,
    );
    expect(onChanged).not.toHaveBeenCalled();
  });
});
