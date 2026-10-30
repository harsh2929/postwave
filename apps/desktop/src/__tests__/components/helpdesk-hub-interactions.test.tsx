// @vitest-environment happy-dom

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

import type { ServiceHubConfig } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  config: vi.fn(),
  updateConfig: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/store", () => ({ useCanAdmin: () => mocks.canAdmin }));
vi.mock("../../lib/api-client", () => ({
  serviceSuiteApi: {
    config: mocks.config,
    updateConfig: mocks.updateConfig,
  },
}));
vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

import { CustomerHubConfig } from "../../components/helpdesk/CustomerHubConfig";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const VERSION = "2026-08-24T10:00:00Z";

function config(over: Partial<ServiceHubConfig> = {}): ServiceHubConfig {
  return {
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    version: "absent",
    status: "draft",
    order_history_enabled: false,
    favorites_enabled: false,
    coupons_enabled: false,
    recommendations_enabled: false,
    customer_agent_enabled: false,
    storefronts: [],
    content_blocks: [],
    personalization_rules: {},
    support_settings: {},
    styling: {},
    metadata: {},
    runtime_available: false,
    runtime_status: "held",
    runtime_reason_code: "customer_hub_runtime_unavailable",
    customer_agent_effective_enabled: false,
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  vi.clearAllMocks();
  mocks.config.mockResolvedValue({ data: config() });
  mocks.updateConfig.mockResolvedValue({
    data: config({
      version: VERSION,
      status: "paused",
      created_at: VERSION,
      updated_at: VERSION,
    }),
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderHub(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <CustomerHubConfig tenantId={TENANT_ID} accessAllowed online />,
    ),
  );
  await flush();
}

function statusSelect(): HTMLSelectElement {
  const node = document.getElementById("hub-status");
  if (!(node instanceof HTMLSelectElement)) {
    throw new Error("Missing Hub status select");
  }
  return node;
}

function button(label: string): HTMLButtonElement {
  const node = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!node) throw new Error(`Missing button ${label}`);
  return node;
}

function changeStatus(value: string): void {
  const select = statusSelect();
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("CustomerHubConfig replacement lifecycle", () => {
  it("uses the exact absent ETag and a complete body on the first single-event save", async () => {
    await renderHub();
    expect(statusSelect().value).toBe("draft");

    changeStatus("paused");
    expect(statusSelect().value).toBe("paused");
    expect(mocks.updateConfig).not.toHaveBeenCalled();

    await act(async () => {
      button("Save changes").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.updateConfig).toHaveBeenCalledTimes(1);
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      {
        status: "paused",
        order_history_enabled: false,
        favorites_enabled: false,
        coupons_enabled: false,
        recommendations_enabled: false,
        customer_agent_enabled: false,
        storefronts: [],
        content_blocks: [],
        personalization_rules: {},
        support_settings: {},
        styling: {},
        metadata: {},
      },
      "absent",
    );
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("retires the prior version after an unverified 2xx replacement body", async () => {
    mocks.updateConfig.mockResolvedValue({
      data: config({
        tenantId: OTHER_TENANT_ID,
        tenant_id: OTHER_TENANT_ID,
        version: VERSION,
        status: "paused",
        created_at: VERSION,
        updated_at: VERSION,
      }),
    });
    await renderHub();
    changeStatus("paused");

    await act(async () => {
      button("Save changes").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Refresh before replacing it",
      ),
    );
    const heldSave = button("Save changes");
    expect(heldSave.disabled).toBe(true);
    act(() => heldSave.click());
    expect(mocks.updateConfig).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Customer Hub response could not be verified",
      }),
    );
  });
});
