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
  create: vi.fn(),
  test: vi.fn(),
  patch: vi.fn(),
  listSigningKeys: vi.fn(),
  rotateSigningKey: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    getApiUrl: () => "https://api.example.test",
    api: {
      ...actual.api,
      auditSinkCreate: mocks.create,
      auditSinkTest: mocks.test,
      auditSinkPatch: mocks.patch,
      auditSinkSigningKeysList: mocks.listSigningKeys,
      auditSinkRotateKey: mocks.rotateSigningKey,
    },
  };
});

vi.mock("../../components/Toast", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../components/Toast")>();
  return {
    ...actual,
    toast: {
      ...actual.toast,
      error: mocks.toastError,
      success: mocks.toastSuccess,
    },
  };
});

import type { AuditSink } from "../../lib/api-client";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";
import {
  CreateSinkModal,
  EditSinkModal,
  SINK_KINDS,
} from "../../pages/AuditSinks";

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

const hideIntent: LifecycleIntent = {
  ...quitIntent,
  kind: "close-window",
  disposition: "hide",
};

const s3Sink: AuditSink = {
  id: "sink-s3",
  kind: "s3",
  name: "Production archive",
  enabled: true,
  config: {
    region: "us-east-1",
    bucket: "audit-prod",
    prefix: "audit/",
    cursor: 81,
  },
  output_format: "postwave_native",
  webhook_format: "postwave_v1",
  consecutive_failures: 0,
  auto_disable_after: 100,
  circuit_state: "closed",
};

const httpSink: AuditSink = {
  ...s3Sink,
  id: "sink-http",
  kind: "http",
  name: "Security webhook",
  config: { url: "https://siem.example.test/audit" },
  webhook_format: "standard_webhooks",
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
  mocks.create.mockResolvedValue({ data: { sink: s3Sink } });
  mocks.test.mockResolvedValue({ data: { ok: true } });
  mocks.patch.mockResolvedValue({ data: { sink: s3Sink } });
  mocks.listSigningKeys.mockResolvedValue({ data: { keys: [] } });
  mocks.rotateSigningKey.mockResolvedValue({
    data: { kid: "new-signing-key" },
  });
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

function input(label: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`Expected input: ${label}`);
  return found;
}

function setValue(target: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelectValue(target: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(target, value);
    target.dispatchEvent(new Event("change", { bubbles: true }));
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

function fillDatadogDraft(): void {
  setValue(input("Name"), "Datadog production");
  setValue(input("Site"), "datadoghq.com");
  setValue(input("API key"), "dd-write-only-secret");
}

describe("audit sink lifecycle behavior", () => {
  it("classifies every destination field as non-secret config or write-only credentials", () => {
    const inventory = Object.fromEntries(
      SINK_KINDS.map((kind) => [
        kind.value,
        {
          config: kind.fields
            .filter((field) => field.store === "config")
            .map((field) => field.key),
          credentials: kind.fields
            .filter((field) => field.store === "credentials")
            .map((field) => field.key),
        },
      ]),
    );

    expect(inventory).toEqual({
      datadog: { config: ["site"], credentials: ["api_key"] },
      splunk: {
        config: ["hec_url", "index"],
        credentials: ["token"],
      },
      s3: {
        config: ["region", "bucket", "prefix"],
        credentials: ["aws_access_key_id", "aws_secret_access_key"],
      },
      archive: {
        config: [
          "region",
          "bucket",
          "prefix",
          "retention_days",
          "object_lock_mode",
        ],
        credentials: ["aws_access_key_id", "aws_secret_access_key"],
      },
      http: {
        config: ["url"],
        credentials: ["bearer_token", "hmac_secret"],
      },
      snowflake_shareback: {
        config: ["account_locator", "share_name", "bucket", "region", "prefix"],
        credentials: ["aws_access_key_id", "aws_secret_access_key"],
      },
      otlp_logs: {
        config: ["endpoint", "service_name", "compression", "headers"],
        credentials: ["bearer_token", "api_key"],
      },
    });
  });

  it("permits hide but requires explicit discard and zeroizes a create draft", async () => {
    const onClose = vi.fn();
    render(<CreateSinkModal onClose={onClose} onCreated={vi.fn()} />);
    fillDatadogDraft();

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "New audit sink draft",
        level: "blocking",
        canSave: false,
        canDiscard: true,
        canRecover: false,
      },
    ]);
    await expect(inspectLifecycle(hideIntent)).resolves.toEqual([]);

    act(() => button("Cancel").click());
    expect(document.body.textContent).toContain(
      "Discard this audit sink draft?",
    );
    expect(input("API key").value).toBe("dd-write-only-secret");

    act(() => button("Discard sink draft").click());
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(input("API key").value).toBe("");
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("single-flights create and keeps the draft guarded after a thrown failure", async () => {
    const pending = deferred<never>();
    mocks.create.mockReturnValueOnce(pending.promise);
    render(<CreateSinkModal onClose={vi.fn()} onCreated={vi.fn()} />);
    fillDatadogDraft();

    const create = button("Create");
    act(() => {
      create.click();
      create.click();
    });
    await flush();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector<HTMLButtonElement>(".modal-close")?.disabled,
    ).toBe(true);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Audit sink create or test", canDiscard: false },
    ]);

    await act(async () => {
      pending.reject(new Error("offline"));
      await pending.promise.catch(() => undefined);
    });
    expect(input("API key").value).toBe("dd-write-only-secret");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "New audit sink draft", canDiscard: true, canSave: false },
    ]);
  });

  it("clears write-only credentials after the server commits a create", async () => {
    const onCreated = vi.fn();
    render(<CreateSinkModal onClose={vi.fn()} onCreated={onCreated} />);
    fillDatadogDraft();

    act(() => button("Create").click());
    await flush();

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: { api_key: "dd-write-only-secret" },
      }),
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(input("API key").value).toBe("");
  });

  it("does not silently erase destination credentials when the kind changes", async () => {
    render(<CreateSinkModal onClose={vi.fn()} onCreated={vi.fn()} />);
    fillDatadogDraft();
    const destination = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Destination"]',
    );
    if (!destination) throw new Error("Expected destination selector");

    setSelectValue(destination, "splunk");
    expect(document.body.textContent).toContain(
      "Discard destination fields and switch?",
    );
    expect(destination.value).toBe("datadog");
    expect(input("API key").value).toBe("dd-write-only-secret");

    act(() => button("Discard fields and switch").click());
    await flush();
    expect(destination.value).toBe("splunk");
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="API key"]'),
    ).toBeNull();
  });

  it("single-flights test delivery and restores the discard-only owner", async () => {
    const pending = deferred<never>();
    mocks.test.mockReturnValueOnce(pending.promise);
    render(<CreateSinkModal onClose={vi.fn()} onCreated={vi.fn()} />);
    fillDatadogDraft();

    const test = button("Test delivery");
    act(() => {
      test.click();
      test.click();
    });
    await flush();
    expect(mocks.test).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Audit sink create or test", canDiscard: false },
    ]);

    await act(async () => {
      pending.reject(new Error("timeout"));
      await pending.promise.catch(() => undefined);
    });
    expect(input("API key").value).toBe("dd-write-only-secret");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "New audit sink draft", canDiscard: true },
    ]);
  });

  it("confirms and zeroizes replacement credentials before rotation is abandoned", async () => {
    const onClose = vi.fn();
    render(<EditSinkModal sink={s3Sink} onClose={onClose} onSaved={vi.fn()} />);
    const rotate = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!rotate) throw new Error("Expected rotate-credentials checkbox");
    act(() => rotate.click());
    setValue(input("Access key ID"), "AKIA-REPLACEMENT");

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Changes to Production archive", canDiscard: true },
    ]);
    act(() => rotate.click());
    expect(document.body.textContent).toContain(
      "Discard replacement credentials?",
    );
    expect(input("Access key ID").value).toBe("AKIA-REPLACEMENT");

    act(() => button("Discard credentials").click());
    await flush();
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Access key ID"]'),
    ).toBeNull();
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);

    act(() => rotate.click());
    setValue(input("Access key ID"), "AKIA-CLOSE-DRAFT");
    act(() => button("Cancel").click());
    expect(document.body.textContent).toContain("Discard audit sink changes?");
    expect(input("Access key ID").value).toBe("AKIA-CLOSE-DRAFT");
    act(() => button("Discard changes").click());
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Access key ID"]'),
    ).toBeNull();
  });

  it("single-flights update and retains write-only credentials after rejection", async () => {
    const pending = deferred<never>();
    mocks.patch.mockReturnValueOnce(pending.promise);
    render(<EditSinkModal sink={s3Sink} onClose={vi.fn()} onSaved={vi.fn()} />);
    const rotate = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!rotate) throw new Error("Expected rotate-credentials checkbox");
    act(() => rotate.click());
    setValue(input("Access key ID"), "AKIA-RETRY");
    setValue(input("Secret access key"), "secret-retry-value");

    const save = button("Save");
    act(() => {
      save.click();
      save.click();
    });
    await flush();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Audit sink update or key rotation", canDiscard: false },
    ]);

    await act(async () => {
      pending.reject(new Error("offline"));
      await pending.promise.catch(() => undefined);
    });
    expect(input("Secret access key").value).toBe("secret-retry-value");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Changes to Production archive", canDiscard: true },
    ]);
  });

  it("confirms signing-key rotation and blocks lifecycle until refresh completes", async () => {
    const pending = deferred<{ data: { kid: string } }>();
    mocks.rotateSigningKey.mockReturnValueOnce(pending.promise);
    render(
      <EditSinkModal sink={httpSink} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    await flush();

    act(() => button("Rotate signing key").click());
    expect(document.body.textContent).toContain("Rotate this signing key?");
    act(() => {
      button("Rotate key").click();
      button("Rotate key").click();
    });
    await flush();
    expect(mocks.rotateSigningKey).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Audit sink update or key rotation", canDiscard: false },
    ]);

    await act(async () => {
      pending.resolve({ data: { kid: "rotated-key-id" } });
      await pending.promise;
      await Promise.resolve();
    });
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
    expect(mocks.listSigningKeys).toHaveBeenCalledTimes(2);
  });
});
