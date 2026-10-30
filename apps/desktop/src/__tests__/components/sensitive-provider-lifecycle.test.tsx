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
  listProviders: vi.fn(),
  saveProvider: vi.fn(),
  deleteProvider: vi.fn(),
  byokListProviders: vi.fn(),
  byokCreateKey: vi.fn(),
  byokActivateKey: vi.fn(),
  byokHealthCheck: vi.fn(),
  byokDeleteKey: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  deliverabilityHubApi: {
    providers: mocks.listProviders,
    upsertProvider: mocks.saveProvider,
    deleteProvider: mocks.deleteProvider,
  },
  api: {
    byokListProviders: mocks.byokListProviders,
    byokCreateKey: mocks.byokCreateKey,
    byokActivateKey: mocks.byokActivateKey,
    byokHealthCheck: mocks.byokHealthCheck,
    byokDeleteKey: mocks.byokDeleteKey,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => true,
  useCanWrite: () => true,
  useRoleStatus: () => "resolved",
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { ProviderConfigCard } from "../../components/deliverability/ProviderConfigCard";
import { BYOKKeysPanel } from "../../components/hipaa/BYOKKeysPanel";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listProviders.mockResolvedValue({ data: { items: [] } });
  mocks.saveProvider.mockResolvedValue({ data: { item: {} } });
  mocks.deleteProvider.mockResolvedValue({ data: { ok: true } });
  mocks.byokListProviders.mockResolvedValue({ data: { providers: ["aws"] } });
  mocks.byokCreateKey.mockResolvedValue({ data: { item: {} } });
  mocks.byokActivateKey.mockResolvedValue({ data: { ok: true } });
  mocks.byokHealthCheck.mockResolvedValue({ data: { ok: true } });
  mocks.byokDeleteKey.mockResolvedValue({ data: { ok: true } });
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

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}

function field(label: string): HTMLInputElement | HTMLSelectElement {
  const owner = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const id = owner?.htmlFor;
  const found = id ? document.getElementById(id) : null;
  if (
    !(found instanceof HTMLInputElement || found instanceof HTMLSelectElement)
  ) {
    throw new Error(`Expected field: ${label}`);
  }
  return found;
}

function setField(
  target: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  act(() => {
    const prototype =
      target instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      target,
      value,
    );
    target.dispatchEvent(
      new Event(target instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("sensitive provider lifecycle behavior", () => {
  it("protects provider credentials and requires confirmation before switching", async () => {
    render(<ProviderConfigCard />);
    await flush();

    setField(field("Webhook receiver token"), "edge-secret");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Deliverability provider credentials",
        level: "blocking",
        canDiscard: true,
      },
    ]);

    setField(field("Provider"), "mailchimp");
    expect(
      document.body.textContent?.includes(
        "Discard credentials and switch provider?",
      ),
    ).toBe(true);
    expect((field("Webhook receiver token") as HTMLInputElement).value).toBe(
      "edge-secret",
    );

    act(() => button("Discard and switch").click());
    expect((field("Provider") as HTMLSelectElement).value).toBe("mailchimp");
    expect((field("Webhook receiver token") as HTMLInputElement).value).toBe(
      "",
    );
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("keeps a provider draft and releases its operation blocker after rejection", async () => {
    const pending = deferred<never>();
    mocks.saveProvider.mockReturnValueOnce(pending.promise);
    render(<ProviderConfigCard />);
    await flush();

    setField(
      field("Webhook receiver token"),
      "retry-secret-with-at-least-32-characters",
    );
    const save = button("Save provider");
    act(() => {
      save.click();
      save.click();
    });
    expect(mocks.saveProvider).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Deliverability provider operation", canDiscard: false },
    ]);

    await act(async () => {
      pending.reject(new Error("offline"));
      await pending.promise.catch(() => undefined);
    });
    expect(button("Save provider").disabled).toBe(false);
    expect((field("Webhook receiver token") as HTMLInputElement).value).toBe(
      "retry-secret-with-at-least-32-characters",
    );
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Deliverability provider credentials", canDiscard: true },
    ]);
  });

  it("does not hash away a generated token before explicit storage acknowledgement", async () => {
    render(<ProviderConfigCard />);
    await flush();

    act(() => button("Generate 256-bit token").click());
    expect((field("Webhook receiver token") as HTMLInputElement).value).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(button("Save provider").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "This generated token is shown only until save",
    );

    act(() => button("I stored it securely").click());
    expect(button("Save provider").disabled).toBe(false);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Deliverability provider credentials", canDiscard: true },
    ]);
  });

  it("requires explicit BYOK draft discard and zeroizes the key reference", async () => {
    render(<BYOKKeysPanel keys={[]} onReload={vi.fn()} canMutate />);
    await flush();
    act(() => button("+ Register key").click());
    setField(field("Key reference"), "vault/transit/tenant-key");

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Encryption key registration",
        level: "blocking",
        canDiscard: true,
      },
    ]);
    act(() => button("Cancel").click());
    expect(
      document.body.textContent?.includes("Discard key registration?"),
    ).toBe(true);
    expect((field("Key reference") as HTMLInputElement).value).toBe(
      "vault/transit/tenant-key",
    );

    act(() => button("Discard draft").click());
    expect(document.body.textContent?.includes("Register a new key")).toBe(
      false,
    );
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("single-flights BYOK registration and restores the guarded draft on failure", async () => {
    const pending = deferred<never>();
    mocks.byokCreateKey.mockReturnValueOnce(pending.promise);
    render(<BYOKKeysPanel keys={[]} onReload={vi.fn()} canMutate />);
    await flush();
    act(() => button("+ Register key").click());
    setField(field("Key reference"), "arn:aws:kms:region:account:key/id");

    const register = button("Register");
    act(() => {
      register.click();
      register.click();
    });
    expect(mocks.byokCreateKey).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Encryption key operation", canDiscard: false },
    ]);

    await act(async () => {
      pending.reject(new Error("offline"));
      await pending.promise.catch(() => undefined);
    });
    expect(button("Register").disabled).toBe(false);
    expect((field("Key reference") as HTMLInputElement).value).toBe(
      "arn:aws:kms:region:account:key/id",
    );
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Encryption key registration", canDiscard: true },
    ]);
  });
});
