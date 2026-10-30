// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// SETC-037: the notification settings page renders a category × channel matrix
// (Email | In-app | Webhook). In-app defaults ON (behavior preservation),
// webhook defaults OFF; a save round-trips the full matrix plus the webhook URL,
// and an invalid (non-https) URL blocks the save.

import { act, createElement } from "react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "./_roots";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  sendTest: vi.fn(),
}));

vi.mock("@/lib/notification-prefs-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/notification-prefs-api")>();
  return {
    ...actual,
    notificationPrefsApi: {
      get: mocks.get,
      patch: mocks.patch,
      sendTest: mocks.sendTest,
    },
  };
});

// Keep the page focused: stub the push card (touches navigator) and the guard.
vi.mock("@/components/notifications/web-push-card", () => ({
  WebPushCard: () => null,
}));
vi.mock("@/components/settings/unsaved-changes", () => ({
  useUnsavedChangesGuard: () => {},
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import NotificationsPage from "@/app/(dashboard)/app/settings/notifications/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function basePrefs(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "u1",
    tenant_id: "t1",
    email_on_send_complete: true,
    email_on_approval_request: true,
    email_on_bounce_alert: true,
    email_on_deliverability_alert: true,
    email_on_usage_alert: true,
    inapp_on_send_complete: true,
    inapp_on_approval_request: true,
    inapp_on_bounce_alert: true,
    inapp_on_deliverability_alert: true,
    inapp_on_usage_alert: true,
    webhook_on_send_complete: false,
    webhook_on_approval_request: false,
    webhook_on_bounce_alert: false,
    webhook_on_deliverability_alert: false,
    webhook_on_usage_alert: false,
    notification_webhook_url: "",
    notification_webhook_kind: "slack",
    digest_frequency: "weekly",
    usage_alert_threshold_pct: 0,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => window.requestAnimationFrame(r));
  await new Promise((r) => window.setTimeout(r, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

function checkbox(label: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`checkbox not found: ${label}`);
  return el;
}

function setUrl(value: string): void {
  setInput("webhook-url", value);
}

function setInput(id: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error("webhook url input not found");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.includes(text) === true,
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function saveButton(): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll("button")).find((x) =>
    x.textContent?.includes("Save preferences"),
  );
  if (!b) throw new Error("save button not found");
  return b as HTMLButtonElement;
}

afterEach(() => {
  unmountRoots();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("NotificationsPage matrix (SETC-037)", () => {
  it("renders every category over three channels with channel defaults", async () => {
    // A user who opted OUT of in-app bounce alerts must show that one cell
    // unchecked while email stays checked and webhook stays off.
    mocks.get.mockResolvedValue(basePrefs({ inapp_on_bounce_alert: false }));
    render(createElement(NotificationsPage));

    // Gate on load completing (checkboxes enable) — the default render already
    // paints 15 matrix cells, so counting them can't tell us the load is done.
    await waitFor(() =>
      expect(checkbox("Bounce-rate alerts — In-app").disabled).toBe(false),
    );

    // 5 categories × 3 channels = 15 matrix checkboxes.
    expect(document.querySelectorAll('input[aria-label*="—"]').length).toBe(15);
    expect(checkbox("Bounce-rate alerts — Email").checked).toBe(true);
    expect(checkbox("Bounce-rate alerts — In-app").checked).toBe(false);
    expect(checkbox("Bounce-rate alerts — Webhook").checked).toBe(false);
    expect(checkbox("Send completion — In-app").checked).toBe(true);
  });

  it("round-trips the webhook channel: enable + URL → PATCH carries both", async () => {
    mocks.get.mockResolvedValue(basePrefs());
    mocks.patch.mockImplementation(async (p: Record<string, unknown>) =>
      basePrefs(p),
    );
    render(createElement(NotificationsPage));

    await waitFor(() =>
      expect(checkbox("Bounce-rate alerts — Webhook").disabled).toBe(false),
    );

    await act(async () => {
      checkbox("Bounce-rate alerts — Webhook").click();
      setUrl("https://hooks.example.com/services/x");
      await flush();
    });

    await waitFor(() => expect(saveButton().disabled).toBe(false));
    await act(async () => {
      saveButton().click();
      await flush();
    });

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    const sent = mocks.patch.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.webhook_on_bounce_alert).toBe(true);
    expect(sent.notification_webhook_url).toBe(
      "https://hooks.example.com/services/x",
    );
    // In-app for other categories is preserved (still on).
    expect(sent.inapp_on_send_complete).toBe(true);
  });

  it("blocks the save when the webhook URL is not https", async () => {
    mocks.get.mockResolvedValue(basePrefs());
    render(createElement(NotificationsPage));

    await waitFor(() =>
      expect(checkbox("Bounce-rate alerts — Webhook").disabled).toBe(false),
    );

    await act(async () => {
      // Make the form dirty AND set an invalid URL.
      checkbox("Bounce-rate alerts — Webhook").click();
      setUrl("http://insecure.example.com/x");
      await flush();
    });

    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(document.body.textContent).toContain(
      "Enter a valid URL that starts with https://",
    );
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("never paints guessed defaults after a failed load and retries in place", async () => {
    mocks.get
      .mockRejectedValueOnce(new Error("notification store offline"))
      .mockResolvedValueOnce(basePrefs({ email_on_send_complete: false }));
    render(createElement(NotificationsPage));

    await waitFor(() =>
      expect(document.body.textContent).toContain("notification store offline"),
    );
    expect(
      document.querySelector('[aria-label="Notification preferences"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain(
      "saved choices were not replaced with defaults",
    );

    await act(async () => {
      buttonByText("Retry preferences").click();
      await flush();
    });
    await waitFor(() =>
      expect(checkbox("Send completion — Email").disabled).toBe(false),
    );
    expect(checkbox("Send completion — Email").checked).toBe(false);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("lets operators clear and retype the threshold, validates it inline, and sends a number", async () => {
    mocks.get.mockResolvedValue(basePrefs());
    mocks.patch.mockImplementation(async (p: Record<string, unknown>) =>
      basePrefs(p),
    );
    render(createElement(NotificationsPage));

    await waitFor(() =>
      expect(checkbox("Send completion — Email").disabled).toBe(false),
    );
    await act(async () => {
      setInput("usage-threshold", "");
      await flush();
    });
    expect(
      document.querySelector<HTMLInputElement>("#usage-threshold")?.value,
    ).toBe("");

    await act(async () => {
      setInput("usage-threshold", "12.5");
      await flush();
    });
    expect(
      document.querySelector("#usage-threshold")?.getAttribute("aria-invalid"),
    ).toBe("true");
    expect(saveButton().disabled).toBe(true);

    await act(async () => {
      setInput("usage-threshold", "42");
      await flush();
      saveButton().click();
      await flush();
    });
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(mocks.patch.mock.calls[0][0].usage_alert_threshold_pct).toBe(42);
  });

  it("single-flights same-tick saves without discarding an edit made in flight", async () => {
    const save = deferred<ReturnType<typeof basePrefs>>();
    mocks.get.mockResolvedValue(basePrefs());
    mocks.patch.mockReturnValue(save.promise);
    render(createElement(NotificationsPage));

    await waitFor(() =>
      expect(checkbox("Send completion — Email").disabled).toBe(false),
    );
    await act(async () => {
      checkbox("Send completion — Email").click();
      await flush();
    });
    const sentButton = saveButton();
    act(() => {
      sentButton.click();
      sentButton.click();
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);

    await act(async () => {
      checkbox("Approval requests — Email").click();
      save.resolve(
        basePrefs({
          email_on_send_complete: false,
          email_on_approval_request: true,
        }),
      );
      await flush();
    });
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(checkbox("Approval requests — Email").checked).toBe(false);
  });

  it("single-flights test delivery and leaves a focused persistent error", async () => {
    const send = deferred<{ sent: boolean; to: string }>();
    mocks.get.mockResolvedValue(basePrefs());
    mocks.sendTest.mockReturnValue(send.promise);
    render(createElement(NotificationsPage));

    await waitFor(() =>
      expect(buttonByText("Send test notification").disabled).toBe(false),
    );
    const testButton = buttonByText("Send test notification");
    act(() => {
      testButton.click();
      testButton.click();
    });
    expect(mocks.sendTest).toHaveBeenCalledTimes(1);

    await act(async () => {
      send.reject(new Error("mailer unavailable"));
      await flush();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("mailer unavailable"),
    );
    expect(document.activeElement?.getAttribute("role")).toBe("alert");
  });
});
