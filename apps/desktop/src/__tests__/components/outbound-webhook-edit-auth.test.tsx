// @vitest-environment happy-dom

import axe from "axe-core";
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
  update: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return { ...actual, updateOutboundWebhook: mocks.update };
});

vi.mock("../../components/Toast", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

import { OutboundWebhookEditDialog } from "../../components/webhooks/OutboundWebhookEditDialog";
import type { OutboundWebhook } from "../../lib/api-client";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const webhook: OutboundWebhook = {
  id: "webhook-1",
  tenant_id: "tenant-1",
  url: "https://receiver.example.test/webhook",
  description: "Production receiver",
  events: ["campaign.sent"],
  active: true,
  created_at: "2026-07-23T08:00:00.000Z",
  updated_at: "2026-07-23T08:00:00.000Z",
  config_version: 1,
  consecutive_failures: 0,
  signing_algorithm: "hmac_sha256",
  auth_config: {
    type: "headers",
    header_names: ["X-Api-Key"],
    secret_redacted: true,
  },
  auth_config_status: "ready",
  url_status: "ready",
  delivery_policy_status: "ready",
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.update.mockResolvedValue({ data: webhook });
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

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function open(overrides: Partial<OutboundWebhook> = {}): void {
  render(
    <OutboundWebhookEditDialog
      webhook={{ ...webhook, ...overrides }}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
}

describe("outbound webhook receiver-auth editing", () => {
  it("preserves existing write-only credentials when another field changes", async () => {
    open();
    expect(document.body.textContent).toContain(
      "Currently configured: custom header (X-Api-Key)",
    );
    expect(button("Save changes").disabled).toBe(true);
    const description = document.querySelector<HTMLInputElement>(
      "#wh-edit-description",
    );
    if (!description) throw new Error("Missing description");
    setControlValue(description, "Updated receiver");

    act(() => button("Save changes").click());
    await flush();

    expect(mocks.update).toHaveBeenCalledWith("webhook-1", {
      description: "Updated receiver",
      events: ["campaign.sent"],
    });
  });

  it("never round-trips the redacted read URL and sends only an explicit replacement", async () => {
    open({ url: "https://receiver.example.test/…?…" });
    expect(
      document.querySelector<HTMLInputElement>("#wh-edit-url")?.value,
    ).toBe("");

    const input = document.querySelector<HTMLInputElement>("#wh-edit-url");
    if (!input) throw new Error("Missing endpoint replacement input");
    setControlValue(input, "https://receiver.example.test/new/complete-path");

    act(() => button("Save changes").click());
    await flush();

    expect(mocks.update).toHaveBeenCalledWith(
      "webhook-1",
      expect.objectContaining({
        url: "https://receiver.example.test/new/complete-path",
      }),
    );
  });

  it("sends explicit null only when the operator chooses to clear auth", async () => {
    open();
    const mode = document.querySelector<HTMLSelectElement>(
      ".wh-auth-fieldset select",
    );
    if (!mode) throw new Error("Missing auth mode");
    setControlValue(mode, "none");

    act(() => button("Save changes").click());
    await flush();

    expect(mocks.update).toHaveBeenCalledWith(
      "webhook-1",
      expect.objectContaining({ auth_config: null }),
    );
  });

  it("replaces credentials without hydrating any historical secret value", async () => {
    open({ auth_config_status: "invalid" });
    expect(document.body.textContent).toContain(
      "Existing credentials are invalid",
    );
    expect(document.body.textContent).not.toContain(
      "receiver-write-only-token",
    );
    const mode = document.querySelector<HTMLSelectElement>(
      ".wh-auth-fieldset select",
    );
    if (!mode) throw new Error("Missing auth mode");
    setControlValue(mode, "bearer");
    const token = document.querySelector<HTMLInputElement>(
      ".wh-auth-fieldset input[type='password']",
    );
    if (!token) throw new Error("Missing Bearer token");
    setControlValue(token, "replacement-token");

    act(() => button("Save changes").click());
    await flush();

    expect(mocks.update).toHaveBeenCalledWith(
      "webhook-1",
      expect.objectContaining({
        auth_config: {
          type: "bearer",
          bearer_token: "replacement-token",
        },
      }),
    );
  });

  it("uses explicit nulls to clear policy while preserving the hidden destination", async () => {
    open({
      url: "https://receiver.example.test/…?…",
      filter_expression: "subscriber.status == active",
      transform_template: { email: "/subscriber/email" },
      delivery_policy_status: "ready",
    });

    act(() => button("Reset policy").click());
    act(() => button("Save changes").click());
    await flush();

    expect(mocks.update).toHaveBeenCalledWith(
      "webhook-1",
      expect.objectContaining({
        filter_expression: null,
        transform_template: null,
      }),
    );
    expect(mocks.update.mock.calls[0]?.[1]).not.toHaveProperty("url");
  });

  it("keeps the credential editor free of serious accessibility violations", async () => {
    open();
    const result = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
