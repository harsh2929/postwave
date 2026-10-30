// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditAlertRuleForm } from "../../components/audit/AuditAlertRuleForm";
import { api } from "../../lib/api-client";
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

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
  vi.restoreAllMocks();
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

function control<T extends HTMLInputElement | HTMLSelectElement>(
  label: string,
): T {
  const accessible = document.querySelector<T>(`[aria-label="${label}"]`);
  if (accessible) return accessible;
  const labels = Array.from(document.querySelectorAll("label"));
  const owner = labels.find(
    (candidate) =>
      candidate.querySelector("span")?.textContent?.trim() === label,
  );
  const found = owner?.querySelector<T>("input, select");
  if (!found) throw new Error(`Expected control: ${label}`);
  return found;
}

function setValue(
  target: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    target instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
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
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("audit alert rule lifecycle", () => {
  it("requires explicit replacement before clearing channel credentials", async () => {
    const onCancel = vi.fn();
    render(
      <AuditAlertRuleForm
        onSubmit={vi.fn().mockResolvedValue(true)}
        onCancel={onCancel}
      />,
    );

    setValue(
      control<HTMLInputElement>("Slack incoming webhook URL"),
      "https://hooks.slack.example/secret",
    );
    const slackSecret = control<HTMLInputElement>(
      "Slack incoming webhook URL",
    );
    expect(slackSecret.type).toBe("password");
    expect(slackSecret.autocomplete).toBe("new-password");
    const reveal = document.querySelector<HTMLButtonElement>(
      '[aria-label="Show Slack incoming webhook URL"]',
    );
    expect(reveal).not.toBeNull();
    act(() => reveal?.click());
    expect(slackSecret.type).toBe("text");
    expect(
      document.querySelector('[aria-label="Hide Slack incoming webhook URL"]'),
    ).not.toBeNull();
    setValue(control<HTMLSelectElement>("Delivery"), "webhook");

    expect(document.body.textContent).toContain(
      "Replace delivery-channel configuration?",
    );
    expect(control<HTMLSelectElement>("Delivery").value).toBe("slack");
    expect(
      control<HTMLInputElement>("Slack incoming webhook URL").value,
    ).toContain("secret");

    act(() => button("Replace channel").click());
    await flush();
    expect(control<HTMLSelectElement>("Delivery").value).toBe("webhook");
    expect(control<HTMLInputElement>("Webhook URL").value).toBe("");
    expect(control<HTMLInputElement>("HMAC secret (optional)").type).toBe(
      "password",
    );
    setValue(
      control<HTMLInputElement>("HMAC secret (optional)"),
      "discard-me",
    );

    act(() => button("Cancel").click());
    expect(document.body.textContent).toContain("Discard rule draft?");
    expect(onCancel).not.toHaveBeenCalled();
    act(() => button("Discard").click());
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      control<HTMLInputElement>("Slack incoming webhook URL").value,
    ).toBe("");
  });

  it("confirms operator replacement before clearing typed parameters", async () => {
    render(
      <AuditAlertRuleForm
        onSubmit={vi.fn().mockResolvedValue(false)}
        onCancel={vi.fn()}
      />,
    );
    const matchKind = control<HTMLSelectElement>("Match kind");
    setValue(matchKind, "threshold_window");
    setValue(control<HTMLInputElement>("Count"), "12");
    setValue(control<HTMLInputElement>("Window (minutes)"), "30");
    setValue(matchKind, "rate_deviation");

    expect(document.body.textContent).toContain(
      "Replace operator configuration?",
    );
    expect(matchKind.value).toBe("threshold_window");
    expect(control<HTMLInputElement>("Count").value).toBe("12");
    act(() => button("Replace operator").click());
    await flush();
    expect(matchKind.value).toBe("rate_deviation");
    expect(control<HTMLInputElement>("Deviation %").value).toBe("");
  });

  it("clears channel secrets after a successful create", async () => {
    let submittedConfig: Record<string, unknown> | null = null;
    const onSubmit = vi.fn().mockImplementation(async (input) => {
      submittedConfig = { ...input.channel_config };
      return true;
    });
    const onCancel = vi.fn();
    render(<AuditAlertRuleForm onSubmit={onSubmit} onCancel={onCancel} />);
    setValue(control<HTMLInputElement>("Rule name"), "Secret-bearing rule");
    setValue(control<HTMLInputElement>("Action glob"), "audit.*");
    setValue(
      control<HTMLInputElement>("Slack incoming webhook URL"),
      "https://hooks.slack.example/one-time",
    );

    act(() => button("Create rule").click());
    await flush();
    expect(submittedConfig).toEqual({
      webhook_url: "https://hooks.slack.example/one-time",
    });
    expect(onSubmit.mock.calls[0]?.[0].channel_config).toEqual({});
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      control<HTMLInputElement>("Slack incoming webhook URL").value,
    ).toBe("");
  });

  it("single-flights create and retains a failed draft", async () => {
    const pending = deferred<boolean>();
    const onSubmit = vi.fn().mockReturnValue(pending.promise);
    render(<AuditAlertRuleForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    setValue(control<HTMLInputElement>("Rule name"), "Off-hours export");
    setValue(control<HTMLInputElement>("Action glob"), "audit.export.*");
    setValue(
      control<HTMLInputElement>("Slack incoming webhook URL"),
      "https://hooks.slack.example/retry",
    );

    const create = button("Create rule");
    act(() => {
      create.click();
      create.click();
    });
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "New audit-alert rule draft operation",
        level: "blocking",
        canSave: false,
        canDiscard: false,
      },
    ]);

    pending.resolve(false);
    await flush();
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "New audit-alert rule draft",
        level: "warning",
        canSave: false,
        canDiscard: true,
      },
    ]);
    expect(control<HTMLInputElement>("Rule name").value).toBe(
      "Off-hours export",
    );
    expect(
      control<HTMLInputElement>("Slack incoming webhook URL").value,
    ).toContain("retry");
  });

  it("verifies with an ephemeral clone and erases its credential values", async () => {
    const verification = deferred<{ data: { ok: boolean } }>();
    let handedOff: Record<string, unknown> | null = null;
    vi.spyOn(api, "auditAlertVerifyServiceNow").mockImplementation((config) => {
      handedOff = config;
      return verification.promise;
    });
    render(
      <AuditAlertRuleForm
        onSubmit={vi.fn().mockResolvedValue(false)}
        onCancel={vi.fn()}
      />,
    );
    setValue(control<HTMLSelectElement>("Delivery"), "servicenow");
    setValue(control<HTMLInputElement>("Instance URL"), "https://acme.service-now.com");
    setValue(control<HTMLInputElement>("Username"), "postwave");
    setValue(control<HTMLInputElement>("Password / API token"), "verify-secret");
    setValue(
      control<HTMLInputElement>("Inbound webhook secret"),
      "inbound-secret",
    );

    act(() => button("Test connection").click());
    await flush();
    expect(handedOff).toMatchObject({
      password: "verify-secret",
      inbound_secret: "inbound-secret",
    });

    verification.resolve({ data: { ok: true } });
    await flush();
    expect(handedOff).toMatchObject({
      instance_url: "https://acme.service-now.com",
      username: "postwave",
    });
    expect(handedOff).not.toHaveProperty("password");
    expect(handedOff).not.toHaveProperty("inbound_secret");
    expect(control<HTMLInputElement>("Password / API token").value).toBe(
      "verify-secret",
    );
  });
});
