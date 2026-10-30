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
  canAdmin: true,
  contextEpoch: "push-epoch-1",
  contextListeners: new Set<(epoch: string) => void>(),
  me: {
    user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tenant: "00000000-0000-0000-0000-000000000043",
    role: "admin",
    effectiveRole: "admin",
  },
  list: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  bulkImport: vi.fn(),
  bulkRemove: vi.fn(),
  saveFile: vi.fn(),
  pickImportFiles: vi.fn(),
  copy: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useMe: () => mocks.me,
}));

vi.mock("../../lib/context-epoch", () => ({
  readContextEpoch: () => mocks.contextEpoch,
  onContextEpochObserved: (listener: (epoch: string) => void) => {
    mocks.contextListeners.add(listener);
    return () => mocks.contextListeners.delete(listener);
  },
}));

vi.mock("../../lib/desktop-router", () => ({
  desktopRouteIdentityScope: (user?: string, tenant?: string) =>
    user && tenant ? `${user}:${tenant}` : null,
}));

vi.mock("../../lib/api-client", () => ({
  pushSuppressionsApi: {
    list: mocks.list,
    add: mocks.add,
    remove: mocks.remove,
    bulkImport: mocks.bulkImport,
    bulkRemove: mocks.bulkRemove,
  },
}));

vi.mock("../../lib/file-transfer", () => ({
  saveFile: mocks.saveFile,
  pickImportFiles: mocks.pickImportFiles,
}));
vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.copy,
  clipboardAnnouncement: () => "Fingerprint copied.",
}));
vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

import { PushSuppressions } from "../../pages/PushSuppressions";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const manualRow = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: mocks.me.tenant,
  device_token_hash: "0123456789abcdef",
  platform: "apns" as const,
  reason: "manual" as const,
  source: "dashboard" as const,
  created_at: "2026-08-28T10:00:00Z",
  updated_at: "2026-08-28T10:00:00Z",
  version: 3,
  reversible: true,
};

const providerRow = {
  id: "22222222-2222-4222-8222-222222222222",
  tenant_id: mocks.me.tenant,
  device_token_hash: "1111222233334444",
  platform: "fcm" as const,
  reason: "unregistered" as const,
  source: "provider" as const,
  created_at: "2026-08-28T09:00:00Z",
  updated_at: "2026-08-28T09:01:00Z",
  version: 2,
  reversible: false,
  locked_reason: "provider_authority" as const,
};

function page(items = [manualRow, providerRow]) {
  return {
    data: {
      tenantId: mocks.me.tenant,
      items,
      total: items.length,
      snapshotAt: "2026-08-28T11:00:00Z",
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  mocks.contextEpoch = "push-epoch-1";
  mocks.contextListeners.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.list.mockResolvedValue(page());
  mocks.add.mockResolvedValue({ data: manualRow });
  mocks.remove.mockResolvedValue({
    data: {
      ok: true,
      tenantId: mocks.me.tenant,
      id: manualRow.id,
      version: manualRow.version + 1,
      stillSuppressed: false,
    },
  });
  mocks.bulkImport.mockResolvedValue({
    data: {
      ok: true,
      tenantId: mocks.me.tenant,
      created: 1,
      existing: 0,
      items: [manualRow],
    },
  });
  mocks.bulkRemove.mockResolvedValue({
    data: {
      ok: true,
      tenantId: mocks.me.tenant,
      removed: 1,
      stillSuppressed: 0,
      items: [
        {
          ok: true,
          tenantId: mocks.me.tenant,
          id: manualRow.id,
          version: manualRow.version + 1,
          stillSuppressed: false,
        },
      ],
    },
  });
  mocks.pickImportFiles.mockResolvedValue({
    ok: true,
    files: [],
    source: "web",
    cancelled: true,
  });
  mocks.saveFile.mockResolvedValue({
    ok: true,
    status: "download_started",
    transferId: "push-export",
    collision: false,
  });
  mocks.copy.mockResolvedValue({
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
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function settle(): Promise<void> {
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
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing ${label}`);
  return match;
}

function change(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("push suppression exact-admin authority", () => {
  it("blocks every protected request before an unauthorized route can mount", async () => {
    mocks.canAdmin = false;
    render(<PushSuppressions />);
    await settle();

    expect(document.body.textContent).toContain(
      "no protected push-suppression request was started",
    );
    expect(document.body.textContent).not.toContain("Add manual suppression");
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("renders semantic authority, provenance, filters, and private detail", async () => {
    render(<PushSuppressions />);
    await settle();

    expect(document.querySelector("table")).not.toBeNull();
    expect(document.querySelectorAll('th[scope="col"]')).toHaveLength(8);
    expect(document.body.textContent).toContain("Dashboard manual · reversible");
    expect(document.body.textContent).toContain("Provider · locked");
    expect(document.querySelectorAll('button[aria-label^="Remove suppression"]')).toHaveLength(1);
    expect(document.querySelector('[role="search"]')).not.toBeNull();
    expect(button("All platforms").getAttribute("aria-pressed")).toBe("true");
    expect(button("All reasons").getAttribute("aria-pressed")).toBe("true");
    expect(button("All sources").getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain(
      "This time is observation metadata, not a row timestamp cutoff.",
    );
    expect(document.body.textContent).not.toContain("insertion boundary");

    const detailTrigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="View details for fingerprint ${providerRow.device_token_hash}"]`,
    );
    if (!detailTrigger) throw new Error("Missing detail trigger");
    act(() => detailTrigger.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("CAS version");
    act(() => button("Copy fingerprint").click());
    await settle();
    expect(mocks.copy).toHaveBeenCalledWith(providerRow.device_token_hash, {
      contentClass: "personal",
      label: "Push token fingerprint",
    });
  });

  it("uses latest-request-wins when a filter overtakes the first load", async () => {
    const first = deferred<ReturnType<typeof page>>();
    const fcmPage = page([providerRow]);
    const second = deferred<ReturnType<typeof page>>();
    mocks.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<PushSuppressions />);
    act(() => button("FCM (Android)").click());
    expect(mocks.list).toHaveBeenCalledTimes(2);

    second.resolve(fcmPage);
    await settle();
    expect(document.body.textContent).toContain(providerRow.device_token_hash);
    first.resolve(page([manualRow]));
    await settle();
    expect(document.body.textContent).toContain(providerRow.device_token_hash);
    expect(document.body.textContent).not.toContain(manualRow.device_token_hash);
  });

  it("preserves verified rows on retryable failure and disables mutations", async () => {
    mocks.list
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce({
        error: { status: 503, message: "secret upstream detail" },
      })
      .mockResolvedValueOnce(page());
    render(<PushSuppressions />);
    await settle();
    act(() => button("Refresh registry").click());
    await settle();

    expect(document.body.textContent).toContain("Showing the last verified page");
    expect(document.body.textContent).toContain(manualRow.device_token_hash);
    expect(document.body.textContent).not.toContain("secret upstream detail");
    expect(button("Add manual suppression").disabled).toBe(true);
    expect(button("Remove").disabled).toBe(true);
    act(() => button("Retry").click());
    await settle();
    expect(button("Add manual suppression").disabled).toBe(false);
  });

  it("fails closed and removes prior rows on malformed or missing authority", async () => {
    mocks.list.mockResolvedValueOnce(page()).mockResolvedValueOnce({
      error: {
        status: 200,
        code: "invalid_push_suppression_response",
        message: "untrusted response detail",
      },
    });
    render(<PushSuppressions />);
    await settle();
    act(() => button("Refresh registry").click());
    await settle();

    expect(document.body.textContent).toContain("No unverified rows were shown");
    expect(document.body.textContent).not.toContain(manualRow.device_token_hash);
    expect(document.body.textContent).not.toContain("untrusted response detail");
    expect(document.querySelector("table")).toBeNull();
  });

  it("validates raw input without normalization and reports unknown outcomes", async () => {
    mocks.add.mockResolvedValueOnce({
      error: { status: 503, message: "must not reach the operator" },
    });
    render(<PushSuppressions />);
    await settle();
    act(() => button("Add manual suppression").click());
    const token = document.querySelector<HTMLTextAreaElement>("textarea");
    if (!token) throw new Error("Missing private token field");
    expect(token.getAttribute("autocomplete")).toBe("off");
    expect(token.getAttribute("data-1p-ignore")).toBe("true");
    expect(document.querySelector('select[name="reason"]')).toBeNull();

    change(token, `${"a".repeat(64)} `);
    act(() => button("Add to registry").click());
    await settle();
    expect(mocks.add).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("paste the canonical token exactly");

    change(token, "a".repeat(64));
    act(() => button("Add to registry").click());
    await settle();
    expect(mocks.add).toHaveBeenCalledWith(
      { device_token: "a".repeat(64), platform: "apns", reason: "manual" },
      { signal: expect.any(AbortSignal) },
    );
    expect(document.body.textContent).toContain("unknown outcome");
    expect(document.body.textContent).not.toContain("must not reach the operator");
    expect(token.value).toBe("");
  });

  it("reviews a local CSV by counts without rendering raw tokens", async () => {
    const apnsToken = "b".repeat(64);
    const fcmToken = `fcm-${"x".repeat(24)}`;
    const csv = `platform,device_token\napns,${apnsToken}\nfcm,${fcmToken}\n`;
    const file = new File([csv], `private-${apnsToken}.csv`, {
      type: "text/csv",
    });
    mocks.pickImportFiles.mockResolvedValueOnce({
      ok: true,
      files: [file],
      source: "web",
    });
    mocks.bulkImport.mockResolvedValueOnce({
      data: {
        ok: true,
        tenantId: mocks.me.tenant,
        created: 1,
        existing: 1,
        items: [manualRow, providerRow],
      },
    });
    render(<PushSuppressions />);
    await settle();

    act(() => button("Import reviewed CSV").click());
    await settle();
    expect(document.body.textContent).toContain("Review manual push suppression import");
    expect(document.body.textContent).toContain("APNs 1 · FCM 1 · Web 0");
    expect(document.body.textContent).toContain("Raw values hidden");
    expect(document.body.textContent).not.toContain(apnsToken);
    expect(document.body.textContent).not.toContain(fcmToken);
    expect(document.body.textContent).not.toContain(file.name);

    act(() => button("Import 2 reviewed rows").click());
    await settle();
    expect(mocks.bulkImport).toHaveBeenCalledWith(
      [
        { device_token: apnsToken, platform: "apns", reason: "manual" },
        { device_token: fcmToken, platform: "fcm", reason: "manual" },
      ],
      { signal: expect.any(AbortSignal) },
    );
    expect(document.body.textContent).not.toContain(apnsToken);
    expect(document.body.textContent).not.toContain(fcmToken);
  });

  it("clears imported raw state when the bulk outcome is unknown", async () => {
    const token = "c".repeat(64);
    mocks.pickImportFiles.mockResolvedValueOnce({
      ok: true,
      files: [
        new File([`platform,device_token\napns,${token}\n`], "review.csv", {
          type: "text/csv",
        }),
      ],
      source: "web",
    });
    mocks.bulkImport.mockResolvedValueOnce({
      error: { status: 503, message: "private upstream detail" },
    });
    render(<PushSuppressions />);
    await settle();

    act(() => button("Import reviewed CSV").click());
    await settle();
    act(() => button("Import 1 reviewed rows").click());
    await settle();

    expect(document.body.textContent).toContain(
      "did not confirm how many rows were imported",
    );
    expect(document.body.textContent).toContain("Raw tokens were cleared");
    expect(document.body.textContent).not.toContain(token);
    expect(document.body.textContent).not.toContain("private upstream detail");
    expect(document.querySelector('button[type="submit"]')).toBeNull();
  });

  it("sends the reviewed CAS version once and restores focus after cancel", async () => {
    render(<PushSuppressions />);
    await settle();
    const trigger = button("Remove");
    act(() => {
      trigger.focus();
      trigger.click();
    });
    act(() => button("Cancel").click());
    await settle();
    expect(document.activeElement).toBe(trigger);

    act(() => trigger.click());
    const typed = document.querySelector<HTMLInputElement>(
      `input[placeholder="${manualRow.device_token_hash}"]`,
    );
    if (!typed) throw new Error("Missing CAS confirmation input");
    change(typed, manualRow.device_token_hash);
    act(() => button("Remove reviewed authority").click());
    await settle();
    expect(mocks.remove).toHaveBeenCalledWith(
      manualRow.id,
      { expected_version: manualRow.version },
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it("bulk-removes only selected current-page reversible rows with CAS", async () => {
    render(<PushSuppressions />);
    await settle();
    const selection = document.querySelector<HTMLInputElement>(
      `input[aria-label="Select suppression ${manualRow.device_token_hash}"]`,
    );
    if (!selection) throw new Error("Missing reversible row selection");
    expect(
      document.querySelector(
        `input[aria-label="Select suppression ${providerRow.device_token_hash}"]`,
      ),
    ).toBeNull();

    act(() => selection.click());
    expect(document.body.textContent).toContain(
      "1 reversible authority selected from this verified view",
    );
    const trigger = button("Review bulk removal");
    act(() => trigger.click());
    const review = document.querySelector('[role="alertdialog"]');
    expect(review?.textContent).toContain("exact CAS versions");
    expect(review?.textContent).toContain(manualRow.device_token_hash);
    expect(review?.textContent).not.toContain(providerRow.device_token_hash);

    const typed = document.querySelector<HTMLInputElement>(
      'input[placeholder="REMOVE 1"]',
    );
    if (!typed) throw new Error("Missing bulk confirmation input");
    change(typed, "REMOVE 1");
    act(() => button("Remove 1 authorities").click());
    await settle();

    expect(mocks.bulkRemove).toHaveBeenCalledWith(
      [{ id: manualRow.id, expected_version: manualRow.version }],
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.bulkRemove).toHaveBeenCalledTimes(1);
  });

  it("closes and refreshes the registry after a CAS conflict", async () => {
    mocks.remove.mockResolvedValueOnce({
      error: { status: 409, code: "version_conflict", message: "private detail" },
    });
    render(<PushSuppressions />);
    await settle();
    act(() => button("Remove").click());
    const typed = document.querySelector<HTMLInputElement>(
      `input[placeholder="${manualRow.device_token_hash}"]`,
    );
    if (!typed) throw new Error("Missing CAS confirmation input");
    change(typed, manualRow.device_token_hash);
    act(() => button("Remove reviewed authority").click());
    await settle();

    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "The row changed before removal. The registry is being refreshed.",
    );
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("private detail");
  });

  it("remounts and retires private rows when the context epoch changes", async () => {
    const replacement = { ...manualRow, id: "33333333-3333-4333-8333-333333333333", device_token_hash: "aaaabbbbccccdddd" };
    mocks.list.mockResolvedValueOnce(page([manualRow])).mockResolvedValueOnce(page([replacement]));
    render(<PushSuppressions />);
    await settle();
    expect(document.body.textContent).toContain(manualRow.device_token_hash);

    act(() => {
      mocks.contextEpoch = "push-epoch-2";
      for (const listener of mocks.contextListeners) listener("push-epoch-2");
    });
    expect(document.body.textContent).not.toContain(manualRow.device_token_hash);
    await settle();
    expect(document.body.textContent).toContain(replacement.device_token_hash);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
});
