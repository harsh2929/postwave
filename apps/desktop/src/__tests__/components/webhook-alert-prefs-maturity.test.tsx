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
  get: vi.fn(),
  put: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getWebhookAlertPrefs: mocks.get,
    putWebhookAlertPrefs: mocks.put,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

import { AlertPrefsSection } from "../../components/webhooks/AlertPrefsSection";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const preferences = {
  notify_auto_disabled: true,
  notify_failure_rate: true,
  failure_rate_pct: 20,
  notify_latency: true,
  latency_ms: 5_000,
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  mocks.get.mockReset();
  mocks.put.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.get.mockResolvedValue({ data: preferences });
  mocks.put.mockResolvedValue({ data: { ok: true } });
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function autoPauseCheckbox(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (!input) throw new Error("Missing auto-pause checkbox");
  return input;
}

describe("webhook notification preference maturity", () => {
  it("withholds the admin-only card when webhook administration is unavailable", async () => {
    mocks.canAdmin = false;
    render(<AlertPrefsSection />);
    await flush();

    expect(document.body.textContent).toBe("");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("labels canonical auto-pause coverage and preserves legacy thresholds as read-only evidence", async () => {
    render(<AlertPrefsSection />);
    await flush();

    expect(document.body.textContent).toContain(
      "Email the workspace owner after an auto-pause",
    );
    expect(document.body.textContent).toContain(
      "Threshold alerts are not canonical yet",
    );
    expect(document.body.textContent).toContain(
      "failure rate at 20% and p99 latency at 5,000 ms",
    );
    expect(document.querySelectorAll('input[type="number"]')).toHaveLength(0);
    expect(autoPauseCheckbox().checked).toBe(true);
  });

  it("persists the complete verified preference object and changes UI only after acknowledgement", async () => {
    let resolveSave:
      | ((value: { data: { ok: boolean } }) => void)
      | undefined;
    mocks.put.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    render(<AlertPrefsSection />);
    await flush();
    const input = autoPauseCheckbox();

    act(() => input.click());
    expect(mocks.put).toHaveBeenCalledWith({
      notify_auto_disabled: false,
      notify_failure_rate: true,
      failure_rate_pct: 20,
      notify_latency: true,
      latency_ms: 5_000,
    });
    expect(autoPauseCheckbox().checked).toBe(true);
    expect(autoPauseCheckbox().disabled).toBe(true);

    await act(async () => {
      resolveSave?.({ data: { ok: true } });
      await Promise.resolve();
    });
    expect(autoPauseCheckbox().checked).toBe(false);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Auto-pause owner notification disabled",
    );
  });

  it("fails closed on malformed success instead of inventing defaults", async () => {
    mocks.get.mockResolvedValueOnce({
      data: { notify_auto_disabled: true },
    });
    render(<AlertPrefsSection />);
    await flush();

    expect(document.body.textContent).toContain(
      "malformed webhook notification preferences",
    );
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.body.textContent).toContain(
      "Existing values were not replaced",
    );
  });

  it("retains the verified setting when a mutation is rejected", async () => {
    mocks.put.mockResolvedValueOnce({
      error: {
        message:
          "receiver failed with token=private-value at https://api.example.test/path?key=secret",
      },
    });
    render(<AlertPrefsSection />);
    await flush();

    act(() => autoPauseCheckbox().click());
    await flush();

    expect(autoPauseCheckbox().checked).toBe(true);
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(String(mocks.toastError.mock.calls[0]?.[0])).not.toContain(
      "private-value",
    );
    expect(String(mocks.toastError.mock.calls[0]?.[0])).not.toContain(
      "key=secret",
    );
  });
});
