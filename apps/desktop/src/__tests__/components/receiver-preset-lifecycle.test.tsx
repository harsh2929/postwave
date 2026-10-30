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
  createWebhook: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    createOutboundWebhook: mocks.createWebhook,
  };
});

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

import { ReceiverPresetDialog } from "../../components/webhooks/ReceiverPresetDialog";
import type { ReceiverPreset } from "../../components/webhooks/receiver-presets";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const preset: ReceiverPreset = {
  name: "Custom receiver",
  urlPlaceholder: "https://receiver.example.test/webhook",
  defaultEvents: ["campaign.sent"],
  helpText: "Connect a test receiver.",
  description: "Test receiver",
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
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.createWebhook.mockResolvedValue({
    data: {
      webhook: {
        id: "webhook-1",
        tenant_id: "tenant-1",
        url: "https://receiver.example.test/webhook",
        events: ["campaign.sent"],
        active: true,
        created_at: "2026-07-16T08:00:00.000Z",
        updated_at: "2026-07-16T08:00:00.000Z",
        consecutive_failures: 0,
        signing_algorithm: "hmac_sha256",
      },
      signing_secret: "signing-secret",
    },
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

function setUrl(value: string): void {
  const input = document.querySelector<HTMLInputElement>("#wh-preset-url");
  if (!input) throw new Error("Expected receiver URL field");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setControlValue(
  control: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      control,
      value,
    );
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("receiver preset lifecycle", () => {
  it("sends write-only receiver auth once and clears the local credential draft", async () => {
    render(
      <ReceiverPresetDialog
        open
        preset={preset}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    setUrl("https://receiver.example.test/webhook");
    const mode = document.querySelector<HTMLSelectElement>(
      ".wh-auth-fieldset select",
    );
    if (!mode) throw new Error("Expected receiver auth method");
    setControlValue(mode, "bearer");
    const token = document.querySelector<HTMLInputElement>(
      ".wh-auth-fieldset input[type='password']",
    );
    if (!token) throw new Error("Expected receiver Bearer token");
    setControlValue(token, "receiver-write-only-token");

    act(() => button("Connect").click());
    await flush();

    expect(mocks.createWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        auth_config: {
          type: "bearer",
          bearer_token: "receiver-write-only-token",
        },
      }),
      { idempotencyKey: expect.any(String) },
    );
    expect(document.body.textContent).not.toContain(
      "receiver-write-only-token",
    );
    expect(
      document.querySelector<HTMLInputElement>(
        ".wh-auth-fieldset input[type='password']",
      ),
    ).toBeNull();
  });

  it("blocks an incomplete receiver-auth replacement before the request", () => {
    render(
      <ReceiverPresetDialog
        open
        preset={preset}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    setUrl("https://receiver.example.test/webhook");
    const mode = document.querySelector<HTMLSelectElement>(
      ".wh-auth-fieldset select",
    );
    if (!mode) throw new Error("Expected receiver auth method");
    setControlValue(mode, "bearer");

    act(() => button("Connect").click());

    expect(mocks.createWebhook).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Enter the Bearer token");
  });

  it("never prepares a create and requires explicit local discard", async () => {
    const onClose = vi.fn();
    render(
      <ReceiverPresetDialog
        open
        preset={preset}
        onClose={onClose}
        onCreated={vi.fn()}
      />,
    );
    setUrl("https://receiver.example.test/webhook");

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Webhook receiver draft",
        level: "warning",
        canSave: false,
        canDiscard: true,
      },
    ]);
    expect(mocks.createWebhook).not.toHaveBeenCalled();

    act(() => button("Cancel").click());
    expect(onClose).not.toHaveBeenCalled();
    expect(button("Discard draft")).toBeTruthy();
    act(() => button("Keep editing").click());
    expect(
      document.querySelector<HTMLInputElement>("#wh-preset-url")?.value,
    ).toBe("https://receiver.example.test/webhook");

    act(() => button("Cancel").click());
    act(() => button("Discard draft").click());
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector<HTMLInputElement>("#wh-preset-url")?.value,
    ).toBe("");
    expect(mocks.createWebhook).not.toHaveBeenCalled();
  });

  it("single-flights, survives unmount, and hands the full secret to its parent", async () => {
    const pending = deferred<{
      data: {
        webhook: {
          id: string;
          tenant_id: string;
          url: string;
          events: string[];
          active: boolean;
          created_at: string;
          updated_at: string;
          consecutive_failures: number;
          signing_algorithm: "hmac_sha256";
        };
        signing_secret: string;
      };
    }>();
    mocks.createWebhook.mockReturnValueOnce(pending.promise);
    const onCreated = vi.fn();
    render(
      <ReceiverPresetDialog
        open
        preset={preset}
        onClose={vi.fn()}
        onCreated={onCreated}
      />,
    );
    setUrl("https://receiver.example.test/webhook");

    act(() => {
      button("Connect").click();
      button("Connect").click();
    });
    expect(mocks.createWebhook).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "blocking", canSave: false, canDiscard: false },
    ]);

    act(() => root?.unmount());
    root = null;
    await expect(inspectLifecycle(quitIntent)).resolves.toHaveLength(1);
    pending.resolve({
      data: {
        webhook: {
          id: "webhook-1",
          tenant_id: "tenant-1",
          url: "https://receiver.example.test/webhook",
          events: ["campaign.sent"],
          active: true,
          created_at: "2026-07-16T08:00:00.000Z",
          updated_at: "2026-07-16T08:00:00.000Z",
          consecutive_failures: 0,
          signing_algorithm: "hmac_sha256",
        },
        signing_secret: "signing-secret",
      },
    });
    await flush();
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ signing_secret: "signing-secret" }),
    );
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("contains a thrown create, retains the draft, and releases controls", async () => {
    mocks.createWebhook.mockRejectedValueOnce(new Error("connection refused"));
    render(
      <ReceiverPresetDialog
        open
        preset={preset}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    setUrl("https://receiver.example.test/webhook");
    act(() => button("Connect").click());
    await flush();

    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("connection refused"),
    );
    expect(
      document.querySelector<HTMLInputElement>("#wh-preset-url")?.value,
    ).toBe("https://receiver.example.test/webhook");
    expect(button("Connect").disabled).toBe(false);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Webhook receiver draft", canDiscard: true },
    ]);
  });

  it("reuses one logical create identity across an ambiguous manual retry", async () => {
    mocks.createWebhook.mockResolvedValueOnce({
      error: {
        kind: "network",
        code: "network_error",
        message: "The response was lost.",
      },
    });
    render(
      <ReceiverPresetDialog
        open
        preset={preset}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    setUrl("https://receiver.example.test/webhook");

    act(() => button("Connect").click());
    await flush();
    const firstKey = mocks.createWebhook.mock.calls[0]?.[1]?.idempotencyKey;
    expect(firstKey).toEqual(expect.any(String));

    act(() => button("Connect").click());
    await flush();
    expect(mocks.createWebhook.mock.calls[1]?.[1]?.idempotencyKey).toBe(
      firstKey,
    );
  });
});
