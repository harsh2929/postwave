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
  canAdmin: vi.fn<() => boolean>(),
  me: vi.fn(),
  roleStatus: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin(),
  useMe: () => mocks.me(),
  useRoleStatus: () => mocks.roleStatus(),
}));

vi.mock("../../lib/api-client", () => ({
  frequencyCapsApi: {
    list: mocks.list,
    create: mocks.create,
    update: mocks.update,
    remove: mocks.remove,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { FrequencyCapsCard } from "../../components/deliverability/FrequencyCapsCard";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const ADMIN_ME = {
  tenant: "tenant-1",
  user: "admin@example.test",
  credentialSource: "session",
  credentialFingerprint: null,
  webhookPlaygroundRecoveryScope: "scope-tenant-1-admin",
  role: "admin",
  effectiveRole: "admin",
};

const CAP = {
  id: "cap-1",
  label: "Daily marketing",
  max_sends: 3,
  window_hours: 24,
  active: true,
  channels: ["email"],
  updated_at: "2026-08-30T06:00:00Z",
};

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
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
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.canAdmin.mockReturnValue(true);
  mocks.me.mockReturnValue(ADMIN_ME);
  mocks.roleStatus.mockReturnValue("resolved");
  mocks.list.mockResolvedValue({ data: { items: [CAP] } });
  mocks.create.mockResolvedValue({ data: CAP });
  mocks.update.mockResolvedValue({ data: CAP });
  mocks.remove.mockResolvedValue({ data: undefined });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  window.localStorage.clear();
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

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}

function queryButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

function input(label: string): HTMLInputElement {
  const labels = Array.from(document.querySelectorAll("label"));
  const matching = labels.find((candidate) =>
    candidate.textContent?.includes(label),
  );
  const id = matching?.htmlFor;
  const found = id ? document.getElementById(id) : null;
  if (!(found instanceof HTMLInputElement)) {
    throw new Error(`Expected input: ${label}`);
  }
  return found;
}

function setInput(target: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function adminReceiptOwner(): string {
  return JSON.stringify({
    tenant: ADMIN_ME.tenant,
    principal: ADMIN_ME.user,
    recoveryScope: ADMIN_ME.webhookPlaygroundRecoveryScope,
    credentialSource: ADMIN_ME.credentialSource,
    role: ADMIN_ME.role,
    effectiveRole: ADMIN_ME.effectiveRole,
    roleStatus: "resolved",
    canAdmin: true,
  });
}

function adminReceiptStorageKey(): string {
  return `postwave.frequency-cap.pending.v1:${encodeURIComponent(adminReceiptOwner())}`;
}

describe("FrequencyCapsCard", () => {
  it("does not issue a protected read before workspace identity resolves", async () => {
    mocks.me.mockReturnValue(null);
    mocks.roleStatus.mockReturnValue("loading");
    render(<FrequencyCapsCard />);
    await flush();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(button("Refresh caps").disabled).toBe(true);
  });

  it("clears prior rows and ignores a stale response when the tenant changes", async () => {
    const first = deferred<{ data: { items: (typeof CAP)[] } }>();
    const nextCap = { ...CAP, id: "cap-2", label: "Tenant two cap" };
    mocks.list
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ data: { items: [nextCap] } });

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));

    mocks.me.mockReturnValue({
      ...ADMIN_ME,
      tenant: "tenant-2",
      webhookPlaygroundRecoveryScope: "scope-tenant-2-admin",
    });
    act(() => root?.render(<FrequencyCapsCard />));
    await waitFor(() =>
      expect(document.body.textContent).toContain(nextCap.label),
    );
    expect(document.body.textContent).not.toContain(CAP.label);

    await act(async () => {
      first.resolve({ data: { items: [CAP] } });
      await first.promise;
    });
    expect(document.body.textContent).toContain(nextCap.label);
    expect(document.body.textContent).not.toContain(CAP.label);
  });

  it("hides verified rows synchronously when the workspace identity changes", async () => {
    const second = deferred<{ data: { items: (typeof CAP)[] } }>();
    const nextCap = { ...CAP, id: "cap-2", label: "Tenant two cap" };
    mocks.list
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockReturnValueOnce(second.promise);

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(document.body.textContent).toContain(CAP.label));

    mocks.me.mockReturnValue({
      ...ADMIN_ME,
      tenant: "tenant-2",
      webhookPlaygroundRecoveryScope: "scope-tenant-2-admin",
    });
    act(() => root?.render(<FrequencyCapsCard />));
    expect(document.body.textContent).not.toContain(CAP.label);
    expect(button("New cap").disabled).toBe(true);

    await act(async () => {
      second.resolve({ data: { items: [nextCap] } });
      await second.promise;
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(nextCap.label),
    );
  });

  it("does not turn a first 404 into a verified empty rule set", async () => {
    mocks.list.mockResolvedValueOnce({
      error: { status: 404, message: "not found" },
    });
    render(<FrequencyCapsCard />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "No empty state has been assumed",
      ),
    );
    expect(document.body.textContent).not.toContain(
      "No frequency caps configured",
    );
    expect(button("New cap").disabled).toBe(true);
  });

  it("retains verified rows when a later refresh fails", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockResolvedValueOnce({ error: { message: "gateway offline" } });
    render(<FrequencyCapsCard />);
    await waitFor(() => expect(document.body.textContent).toContain(CAP.label));
    act(() => button("Refresh caps").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "gateway offline Showing the last verified complete rule list",
      ),
    );
    expect(document.body.textContent).toContain(CAP.label);
  });

  it("shows readable rules but blocks mutations when the canonical list is malformed", async () => {
    mocks.list.mockResolvedValueOnce({
      data: { items: [CAP, { ...CAP, id: "cap-bad", label: "" }] },
    });
    render(<FrequencyCapsCard />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("1 malformed server rule"),
    );
    expect(document.body.textContent).toContain(CAP.label);
    expect(button("New cap").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "server returned an incomplete frequency-cap list",
    );
  });

  it("does not read admin policy for a non-admin and hides all mutations in demo mode", async () => {
    mocks.canAdmin.mockReturnValue(false);
    render(<FrequencyCapsCard />);
    await flush();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(button("New cap").disabled).toBe(true);
    expect(document.body.textContent).not.toContain(CAP.label);
    expect(document.body.textContent).not.toContain("Edit");
    expect(document.body.textContent).not.toContain("Delete");
    expect(document.body.textContent).toContain("Read-only access");

    mocks.canAdmin.mockReturnValue(true);
    act(() => root?.render(<FrequencyCapsCard readOnly />));
    await waitFor(() => expect(document.body.textContent).toContain(CAP.label));
    expect(document.body.textContent).toContain("Demo data is read-only");
    expect(document.body.textContent).not.toContain("New cap");
    expect(document.body.textContent).not.toContain("Edit");
    expect(document.body.textContent).not.toContain("Delete");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("keeps writes disabled when an admin lacks an exact recovery identity", async () => {
    mocks.me.mockReturnValue({
      ...ADMIN_ME,
      webhookPlaygroundRecoveryScope: undefined,
    });
    render(<FrequencyCapsCard />);
    await waitFor(() => expect(document.body.textContent).toContain(CAP.label));

    expect(button("New cap").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "A verified recovery identity is required",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("preserves a blank numeric draft and blocks create", async () => {
    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), "Weekly marketing");
    const maxSends = input("Maximum sends");
    setInput(maxSends, "");
    expect(maxSends.value).toBe("");
    act(() => button("Create cap").click());
    expect(mocks.create).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Use a whole number from 1 to 1,000.",
    );
  });

  it("validates an edited label and protects dirty modal dismissal", async () => {
    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("Edit").disabled).toBe(false));
    act(() => button("Edit").click());
    setInput(input("Label"), "   ");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { canSave: false, canDiscard: true },
    ]);
    act(() => button("Save changes").click());
    expect(mocks.update).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Label is required");
    act(() => button("Cancel").click());
    expect(document.body.textContent).toContain("Discard frequency-cap draft?");
    await act(async () => {
      button("Discard draft").click();
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain("Save changes");
  });

  it("single-flights repeated create submissions in the same tick", async () => {
    const pending = deferred<{ data: typeof CAP }>();
    mocks.create.mockReturnValueOnce(pending.promise);
    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), "Weekly marketing");
    const form = button("Create cap").closest("form");
    if (!form) throw new Error("Expected create form");

    act(() => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({
        data: { ...CAP, id: "cap-2", label: "Weekly marketing" },
      });
      await pending.promise;
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Cap "Weekly marketing" created',
    );
  });

  it("persists the exact retry receipt before dispatching a mutation", async () => {
    mocks.create.mockImplementationOnce(async (_input, options) => {
      const pending = Object.values(window.localStorage)
        .map((raw) => JSON.parse(String(raw)) as Record<string, unknown>)
        .find((value) => value.kind === "create");
      expect(pending).toMatchObject({
        kind: "create",
        idempotencyKey: options.idempotencyKey,
        createdAtMs: expect.any(Number),
        input: { label: "Weekly marketing" },
      });
      expect(JSON.parse(String(pending?.owner))).toMatchObject({
        tenant: ADMIN_ME.tenant,
        principal: ADMIN_ME.user,
        recoveryScope: ADMIN_ME.webhookPlaygroundRecoveryScope,
        credentialSource: ADMIN_ME.credentialSource,
        role: "admin",
        effectiveRole: "admin",
      });
      return {
        data: { ...CAP, id: "cap-2", label: "Weekly marketing" },
      };
    });

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), "Weekly marketing");
    await act(async () => button("Create cap").click());

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(window.localStorage.length).toBe(0);
  });

  it("does not dispatch when durable receipt storage is unavailable", async () => {
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("storage locked");
      });

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), "Weekly marketing");
    await act(async () => button("Create cap").click());
    setItem.mockRestore();

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Couldn't secure retry receipt",
      detail:
        "No request was sent. Restore local storage access, then try again.",
    });
  });

  it.each([
    ["malformed", "{not-json"],
    ["oversized", "x".repeat(128 * 1024 + 1)],
  ])(
    "retains and blocks an unverifiable %s durable receipt",
    async (_caseName, storedBytes) => {
      const storageKey = adminReceiptStorageKey();
      window.localStorage.setItem(storageKey, storedBytes);

      render(<FrequencyCapsCard />);
      await waitFor(() =>
        expect(button("Recheck receipt storage").disabled).toBe(false),
      );

      expect(button("New cap").disabled).toBe(true);
      expect(document.body.textContent).toContain("changes remain blocked");
      expect(window.localStorage.getItem(storageKey)).toBe(storedBytes);
      expect(mocks.create).not.toHaveBeenCalled();

      window.localStorage.removeItem(storageKey);
      await act(async () => button("Recheck receipt storage").click());
      await waitFor(() =>
        expect(
          button("New cap").disabled,
          document.body.textContent ?? "",
        ).toBe(false),
      );
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it("blocks on a durable receipt read failure without dispatching", async () => {
    const getItem = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("storage locked");
      });

    render(<FrequencyCapsCard />);
    await waitFor(() =>
      expect(button("Recheck receipt storage").disabled).toBe(false),
    );

    expect(document.body.textContent).toContain(
      "receipt storage could not be read",
    );
    expect(button("New cap").disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
    getItem.mockRestore();
  });

  it("does not overwrite or dispatch past another tab's durable receipt", async () => {
    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), "Weekly marketing");

    const owner = adminReceiptOwner();
    const storageKey = adminReceiptStorageKey();
    const externalReceipt = JSON.stringify({
      owner,
      kind: "create",
      beforeIds: [CAP.id],
      idempotencyKey: "external-tab-key",
      createdAtMs: Date.now(),
      input: {
        label: "External tab cap",
        max_sends: 3,
        window_hours: 24,
        active: true,
        channels: ["email"],
      },
    });
    window.localStorage.setItem(storageKey, externalReceipt);

    await act(async () => button("Create cap").click());

    expect(mocks.create).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(storageKey)).toBe(externalReceipt);
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Couldn't secure retry receipt",
      detail:
        "No request was sent. Restore local storage access, then try again.",
    });
  });

  it("never clears a different receipt installed before a stale response completes", async () => {
    const response = deferred<{
      data: typeof CAP;
    }>();
    mocks.create.mockReturnValueOnce(response.promise);
    mocks.list.mockResolvedValue({ data: { items: [CAP] } });

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), "Weekly marketing");
    act(() => button("Create cap").click());
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));

    const storageKey = adminReceiptStorageKey();
    const replacement = JSON.stringify({
      owner: adminReceiptOwner(),
      kind: "create",
      beforeIds: [CAP.id],
      idempotencyKey: "newer-tab-key",
      createdAtMs: Date.now(),
      input: {
        label: "Newer tab cap",
        max_sends: 2,
        window_hours: 12,
        active: true,
        channels: ["email"],
      },
    });
    window.localStorage.setItem(storageKey, replacement);

    await act(async () => {
      response.resolve({
        data: { ...CAP, id: "cap-2", label: "Weekly marketing" },
      });
      await response.promise;
    });
    await waitFor(() => expect(button("Retry original request")).toBeTruthy());

    expect(window.localStorage.getItem(storageKey)).toBe(replacement);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith(
      'Cap "Weekly marketing" created',
    );
  });

  it("reconciles a receipt retained across unmount before the response arrives", async () => {
    const created = {
      ...CAP,
      id: "cap-2",
      label: "Weekly marketing",
      updated_at: "2026-08-30T06:01:00Z",
    };
    const pending = deferred<{ data: typeof created }>();
    mocks.list
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockResolvedValueOnce({ data: { items: [CAP, created] } });
    mocks.create.mockReturnValueOnce(pending.promise);

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), created.label);
    act(() => button("Create cap").click());
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(window.localStorage.length).toBe(1);

    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    root = null;
    container?.remove();
    container = null;
    await act(async () => {
      pending.resolve({ data: created });
      await pending.promise;
    });
    expect(window.localStorage.length).toBe(1);

    render(<FrequencyCapsCard />);
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        `Cap "${created.label}" created and verified`,
      ),
    );
    expect(window.localStorage.length).toBe(0);
  });

  it("verifies an ambiguous create before reporting success", async () => {
    const created = { ...CAP, id: "cap-2", label: "Weekly marketing" };
    mocks.list
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockResolvedValueOnce({ data: { items: [CAP, created] } });
    mocks.create.mockResolvedValueOnce({
      error: { kind: "network", message: "connection reset" },
    });

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), created.label);
    await act(async () => button("Create cap").click());

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        `Cap "${created.label}" created and verified`,
      ),
    );
    expect(document.body.textContent).not.toContain("Create cap");
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("retains an in-progress idempotency receipt as an unknown outcome", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockResolvedValueOnce({
        error: { kind: "network", message: "offline" },
      });
    mocks.create.mockResolvedValueOnce({
      error: {
        status: 409,
        code: "idempotency_key_in_progress",
        message: "request still processing",
      },
    });

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), "Weekly marketing");
    await act(async () => button("Create cap").click());

    await waitFor(() => expect(button("Retry original request")).toBeTruthy());
    expect(button("Cancel").disabled).toBe(true);
    expect(
      Object.keys(window.localStorage).some((key) =>
        key.startsWith("postwave.frequency-cap.pending.v1:"),
      ),
    ).toBe(true);
  });

  it("blocks lifecycle and retry until an ambiguous create is reconciled", async () => {
    const created = {
      ...CAP,
      id: "cap-2",
      label: "Weekly marketing",
      updated_at: "2026-08-30T06:01:00Z",
    };
    mocks.list
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockResolvedValueOnce({ error: { kind: "network", message: "offline" } })
      .mockResolvedValueOnce({ data: { items: [CAP] } });
    mocks.create.mockResolvedValueOnce({
      error: { kind: "network", message: "connection reset" },
    });

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), "Weekly marketing");
    await act(async () => button("Create cap").click());
    await waitFor(() => expect(button("Retry original request")).toBeTruthy());
    const blocked = await inspectLifecycle(quitIntent);
    expect(blocked).toContainEqual(
      expect.objectContaining({
        level: "blocking",
        canSave: false,
        canDiscard: false,
      }),
    );
    expect(button("Cancel").disabled).toBe(true);

    await act(async () => button("Verify outcome").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("outcome remains unknown"),
    );
    expect(button("Create cap").disabled).toBe(true);
    const stillBlocked = await inspectLifecycle(quitIntent);
    expect(stillBlocked).toContainEqual(
      expect.objectContaining({
        level: "blocking",
        canSave: false,
        canDiscard: false,
      }),
    );

    const firstKey = mocks.create.mock.calls[0]?.[1]?.idempotencyKey;
    const receiptKey = Object.keys(window.localStorage)[0];
    const receiptRaw = window.localStorage.getItem(receiptKey!);
    if (!receiptRaw) throw new Error("Expected durable receipt");
    const originalCreatedAtMs = (
      JSON.parse(receiptRaw) as { createdAtMs: number }
    ).createdAtMs;
    mocks.create.mockImplementationOnce(async () => {
      const retainedRaw = window.localStorage.getItem(receiptKey!);
      if (!retainedRaw) throw new Error("Expected retained durable receipt");
      expect(
        (JSON.parse(retainedRaw) as { createdAtMs: number }).createdAtMs,
      ).toBe(originalCreatedAtMs);
      return { data: created };
    });
    await act(async () => button("Retry original request").click());
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    expect(mocks.create.mock.calls[1]?.[1]?.idempotencyKey).toBe(firstKey);
  });

  it("recovers an unresolved create after remount and retries the same receipt", async () => {
    const created = {
      ...CAP,
      id: "cap-2",
      label: "Weekly marketing",
      updated_at: "2026-08-30T06:01:00Z",
    };
    mocks.list
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockResolvedValueOnce({ error: { kind: "network", message: "offline" } })
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockResolvedValue({ data: { items: [CAP, created] } });
    mocks.create
      .mockResolvedValueOnce({
        error: { kind: "network", message: "connection reset" },
      })
      .mockResolvedValueOnce({ data: created });

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), created.label);
    await act(async () => button("Create cap").click());
    await waitFor(() => expect(button("Retry original request")).toBeTruthy());
    const firstKey = mocks.create.mock.calls[0]?.[1]?.idempotencyKey;
    expect(firstKey).toEqual(expect.any(String));
    expect(
      Object.keys(window.localStorage).some((key) =>
        key.startsWith("postwave.frequency-cap.pending.v1:"),
      ),
    ).toBe(true);

    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    root = null;
    container?.remove();
    container = null;
    render(<FrequencyCapsCard />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("outcome remains unknown"),
    );
    expect(input("Label").value).toBe(created.label);
    const recoveredGuard = await inspectLifecycle(quitIntent);
    expect(recoveredGuard).toContainEqual(
      expect.objectContaining({ level: "blocking", canDiscard: false }),
    );

    await act(async () => button("Retry original request").click());
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    expect(mocks.create.mock.calls[1]?.[1]?.idempotencyKey).toBe(firstKey);
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        `Cap "${created.label}" created`,
      ),
    );
    expect(
      Object.keys(window.localStorage).some((key) =>
        key.startsWith("postwave.frequency-cap.pending.v1:"),
      ),
    ).toBe(false);
  });

  it("does not inherit or replay another principal's receipt in the same tenant", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockResolvedValueOnce({ error: { kind: "network", message: "offline" } })
      .mockResolvedValueOnce({ data: { items: [CAP] } });
    mocks.create.mockResolvedValueOnce({
      error: { kind: "network", message: "connection reset" },
    });

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), "Weekly marketing");
    await act(async () => button("Create cap").click());
    await waitFor(() => expect(button("Retry original request")).toBeTruthy());
    const originalStorageKey = Object.keys(window.localStorage)[0];
    expect(originalStorageKey).toEqual(expect.any(String));

    mocks.me.mockReturnValue({
      ...ADMIN_ME,
      user: "other-admin@example.test",
      webhookPlaygroundRecoveryScope: "scope-tenant-1-other-admin",
    });
    act(() => root?.render(<FrequencyCapsCard />));
    await waitFor(() => expect(button("New cap").disabled).toBe(false));

    expect(queryButton("Retry original request")).toBeUndefined();
    expect(window.localStorage.getItem(originalStorageKey!)).not.toBeNull();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("never dispatches an expired receipt and retires it only after a verified list is accepted", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockResolvedValueOnce({ error: { kind: "network", message: "offline" } })
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockResolvedValue({ data: { items: [CAP] } });
    mocks.create.mockResolvedValueOnce({
      error: { kind: "network", message: "connection reset" },
    });

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), "Weekly marketing");
    await act(async () => button("Create cap").click());
    await waitFor(() => expect(button("Retry original request")).toBeTruthy());

    const storageKey = Object.keys(window.localStorage)[0];
    const raw = window.localStorage.getItem(storageKey!);
    if (!raw) throw new Error("Expected durable receipt");
    const expired = JSON.parse(raw) as Record<string, unknown>;
    expired.createdAtMs = Date.now() - 24 * 60 * 60 * 1_000;
    window.localStorage.setItem(storageKey!, JSON.stringify(expired));

    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    root = null;
    container?.remove();
    container = null;
    render(<FrequencyCapsCard />);

    await waitFor(() => expect(button("Accept verified list")).toBeTruthy());
    expect(document.body.textContent).toContain("replay window has expired");
    expect(queryButton("Retry original request")).toBeUndefined();
    expect(mocks.create).toHaveBeenCalledTimes(1);

    await act(async () => button("Accept verified list").click());
    await waitFor(() => expect(window.localStorage.length).toBe(0));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Verified frequency-cap list accepted; the expired request was not replayed",
    );
  });

  it("requires a post-expiry complete read before a long-lived receipt can be accepted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:00:00Z"));
    mocks.list
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockResolvedValueOnce({
        error: { kind: "network", message: "verification unavailable" },
      })
      .mockResolvedValueOnce({
        error: { kind: "network", message: "boundary read unavailable" },
      })
      .mockResolvedValueOnce({ data: { items: [CAP] } });
    mocks.create.mockResolvedValueOnce({
      error: { kind: "network", message: "connection reset" },
    });

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("New cap").disabled).toBe(false));
    act(() => button("New cap").click());
    setInput(input("Label"), "Weekly marketing");
    await act(async () => button("Create cap").click());
    await waitFor(() => expect(button("Retry original request")).toBeTruthy());
    expect(mocks.list).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1_000 + 20);
    });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
    expect(queryButton("Retry original request")).toBeUndefined();
    expect(queryButton("Accept verified list")).toBeUndefined();
    expect(window.localStorage.length).toBe(1);

    await act(async () => button("Verify outcome").click());
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(button("Accept verified list")).toBeTruthy());
    expect(window.localStorage.length).toBe(1);
  });

  it("does not reconcile or accept an expired receipt against a partial server list", async () => {
    const storageKey = adminReceiptStorageKey();
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        owner: adminReceiptOwner(),
        kind: "create",
        beforeIds: [CAP.id],
        idempotencyKey: "expired-partial-list-key",
        createdAtMs: Date.now() - 24 * 60 * 60 * 1_000,
        input: {
          label: "Weekly marketing",
          max_sends: 3,
          window_hours: 24,
          active: true,
          channels: ["email"],
        },
      }),
    );
    mocks.list
      .mockResolvedValueOnce({
        data: { items: [CAP, { ...CAP, id: "cap-bad", label: "" }] },
      })
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockResolvedValue({ data: { items: [CAP] } });

    render(<FrequencyCapsCard />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "retained request cannot be reconciled",
      ),
    );

    expect(queryButton("Accept verified list")).toBeUndefined();
    expect(queryButton("Retry original request")).toBeUndefined();
    expect(window.localStorage.getItem(storageKey)).not.toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();

    await act(async () => button("Refresh caps").click());
    await waitFor(() => expect(button("Accept verified list")).toBeTruthy());
    expect(window.localStorage.getItem(storageKey)).not.toBeNull();
  });

  it("passes the visible server revision and a stable receipt when updating", async () => {
    const updated = {
      ...CAP,
      label: "Daily lifecycle",
      updated_at: "2026-08-30T06:01:00Z",
    };
    mocks.update.mockResolvedValueOnce({ data: updated });
    mocks.list.mockResolvedValueOnce({ data: { items: [CAP] } });

    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("Edit").disabled).toBe(false));
    act(() => button("Edit").click());
    setInput(input("Label"), updated.label);
    await act(async () => button("Save changes").click());

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update).toHaveBeenCalledWith(
      CAP.id,
      {
        label: updated.label,
        max_sends: CAP.max_sends,
        window_hours: CAP.window_hours,
        active: CAP.active,
      },
      CAP.updated_at,
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Cap updated");
  });

  it("treats a bodyless 204 delete result as success", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: { items: [CAP] } })
      .mockResolvedValue({ data: { items: [] } });
    render(<FrequencyCapsCard />);
    await waitFor(() => expect(button("Delete").disabled).toBe(false));
    act(() => button("Delete").click());
    await act(async () => button("Delete cap").click());
    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith(
        CAP.id,
        CAP.updated_at,
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Cap deleted");
    expect(mocks.toastError).not.toHaveBeenCalledWith(
      "The server did not confirm cap deletion.",
    );
  });
});
