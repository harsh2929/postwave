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

import type { SubscriberDetail } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  updateSubscriber: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { updateSubscriber: mocks.updateSubscriber },
}));

vi.mock("../../components/Toast", () => ({
  toast: { success: mocks.toastSuccess },
}));

import {
  SubscriberStatusConsentModal,
  buildSubscriberStatusConsentPatch,
  validateSubscriberStatusConsentDraft,
  type SubscriberStatusConsentDraft,
  type SubscriberStatusConsentTarget,
} from "../../components/subscribers/SubscriberStatusConsentModal";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateSubscriber.mockResolvedValue({ data: enabledDetail() });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

function target(
  overrides: Partial<SubscriberStatusConsentTarget> = {},
): SubscriberStatusConsentTarget {
  return {
    id: "subscriber-1",
    version: `"subscriber:subscriber-1:v1"`,
    email: "reader@example.test",
    status: "disabled",
    ...overrides,
  };
}

function enabledDetail(
  overrides: Partial<SubscriberDetail> = {},
): SubscriberDetail {
  const capturedAt = new Date("2026-07-01T09:30").toISOString();
  return {
    id: "subscriber-1",
    version: `"subscriber:subscriber-1:v2"`,
    email: "reader@example.test",
    status: "enabled",
    consent_source: "double_optin",
    consent_timestamp: capturedAt,
    consent_email_marketing_at: capturedAt,
    ...overrides,
  };
}

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function control<
  T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
>(suffix: string): T {
  const found = document.querySelector<T>(`[id$="-${suffix}"]`);
  if (!found) throw new Error(`Missing ${suffix} control`);
  return found;
}

function change(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function fillCompleteReview(): void {
  change(control("source"), "double_optin");
  change(control("channel"), "email");
  change(control("basis"), "consent");
  change(control("captured"), "2026-07-01T09:30");
  change(control("jurisdiction"), "GB");
  change(control("policy"), "privacy-2026-07");
  change(control("evidence"), "receipt:CONSENT-42");
  change(control("reason"), "Reviewed the double opt-in receipt.");
  const checkbox = document.querySelector<HTMLInputElement>(
    '.subscriber-status-consent__confirm input[type="checkbox"]',
  );
  if (!checkbox) throw new Error("Missing scope acknowledgement");
  act(() => checkbox.click());
  change(control("email"), "reader@example.test");
}

function modal(
  overrides: Partial<Parameters<typeof SubscriberStatusConsentModal>[0]> = {},
): ReactElement {
  return (
    <SubscriberStatusConsentModal
      target={target()}
      onClose={vi.fn()}
      onEnabled={vi.fn()}
      {...overrides}
    />
  );
}

describe("SubscriberStatusConsentModal", () => {
  it("explains exact-address scope and has no serious accessibility violations", async () => {
    render(modal());
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    if (!dialog) throw new Error("Expected reviewed-consent dialog");

    expect(dialog.textContent).toContain("One exact address");
    expect(dialog.textContent).toContain("Email marketing only");
    expect(dialog.textContent).toContain("This is not an operator opt-in");
    expect(dialog.textContent).toContain("does not clear independent bounce");
    expect(document.activeElement).toBe(control("source"));
    const result = await axe.run(dialog);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("keeps an incomplete grant local and focuses the first invalid field", () => {
    render(modal());
    const submit = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Record consent & enable");
    act(() => submit?.click());

    expect(mocks.updateSubscriber).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("10 highlighted review fields");
    expect(control("source").getAttribute("aria-invalid")).toBe("true");
  });

  it("submits one online-only evidence envelope under a same-tick double action", async () => {
    const pending = deferred<{ data: SubscriberDetail }>();
    mocks.updateSubscriber.mockReturnValue(pending.promise);
    const onEnabled = vi.fn();
    const onClose = vi.fn();
    render(modal({ onEnabled, onClose }));
    fillCompleteReview();
    const submit = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Record consent & enable");
    if (!submit) throw new Error("Missing submit button");

    act(() => {
      submit.click();
      submit.click();
    });

    expect(mocks.updateSubscriber).toHaveBeenCalledTimes(1);
    expect(mocks.updateSubscriber).toHaveBeenCalledWith(
      "subscriber-1",
      {
        status: "enabled",
        consent_source: "double_optin",
        consent_timestamp: new Date("2026-07-01T09:30").toISOString(),
        consent_channel: "email",
        consent_legal_basis: "consent",
        consent_jurisdiction: "GB",
        consent_evidence: "receipt:CONSENT-42",
        consent_reason: "Reviewed the double opt-in receipt.",
        consent_policy_version: "privacy-2026-07",
      },
      {
        version: `"subscriber:subscriber-1:v1"`,
        signal: expect.objectContaining({ aborted: false }),
        requireOnline: true,
        maxAttempts: 1,
      },
    );
    expect(
      document.querySelector<HTMLButtonElement>(".modal-close")?.disabled,
    ).toBe(true);

    await act(async () => pending.resolve({ data: enabledDetail() }));
    expect(onEnabled).toHaveBeenCalledWith(enabledDetail());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight grant when the target identity changes", async () => {
    const pending = deferred<{ data: SubscriberDetail }>();
    mocks.updateSubscriber.mockReturnValue(pending.promise);
    const onEnabled = vi.fn();
    const view = render(modal({ onEnabled }));
    fillCompleteReview();
    const submit = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Record consent & enable");
    act(() => submit?.click());
    const options = mocks.updateSubscriber.mock.calls[0]?.[2] as
      | { signal?: AbortSignal }
      | undefined;
    expect(options?.signal?.aborted).toBe(false);

    view.rerender(
      modal({
        target: target({ id: "subscriber-2", email: "other@example.test" }),
        onEnabled,
      }),
    );
    expect(options?.signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ data: enabledDetail() }));
    expect(onEnabled).not.toHaveBeenCalled();
  });

  it("rejects a response for a different canonical address", async () => {
    mocks.updateSubscriber.mockResolvedValue({
      data: enabledDetail({ email: "other@example.test" }),
    });
    const onEnabled = vi.fn();
    render(modal({ onEnabled }));
    fillCompleteReview();
    const submit = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Record consent & enable");
    await act(async () => submit?.click());

    expect(onEnabled).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "did not verify this exact address",
    );
  });
});

describe("subscriber status consent validation", () => {
  const complete: SubscriberStatusConsentDraft = {
    source: "single_optin",
    channel: "web",
    legalBasis: "consent",
    capturedAt: "2026-07-01T09:30:00.000Z",
    jurisdiction: "us-ca",
    evidence: "receipt:CONSENT-9",
    reason: "Reviewed the signed first-party record.",
    policyVersion: "privacy-v9",
    scopeAcknowledged: true,
    typedEmail: "reader@example.test",
  };

  it("requires the canonical email exactly and builds the backend grant contract", () => {
    expect(
      validateSubscriberStatusConsentDraft(
        { ...complete, typedEmail: "READER@example.test" },
        "reader@example.test",
        Date.parse("2026-07-02T00:00:00Z"),
      ),
    ).toMatchObject({ typedEmail: expect.any(String) });
    expect(
      buildSubscriberStatusConsentPatch(
        complete,
        "reader@example.test",
        Date.parse("2026-07-02T00:00:00Z"),
      ),
    ).toEqual({
      status: "enabled",
      consent_source: "single_optin",
      consent_timestamp: "2026-07-01T09:30:00.000Z",
      consent_channel: "web",
      consent_legal_basis: "consent",
      consent_jurisdiction: "US-CA",
      consent_evidence: "receipt:CONSENT-9",
      consent_reason: "Reviewed the signed first-party record.",
      consent_policy_version: "privacy-v9",
    });
  });
});
