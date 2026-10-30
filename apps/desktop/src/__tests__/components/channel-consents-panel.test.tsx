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
  list: vi.fn(),
  set: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  versionChanged: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listSubscriberChannelConsents: mocks.list,
    setSubscriberChannelConsent: mocks.set,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { ChannelConsentsPanel } from "../../components/subscribers/ChannelConsentsPanel";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.list.mockResolvedValue({ data: { items: [] } });
  mocks.set.mockResolvedValue({
    data: {
      id: "consent-email",
      subscriber_id: "subscriber-1",
      subscriber_version: '"subscriber:subscriber-1:v2"',
      channel: "email",
      status: "opted_in",
      consent_timestamp: "2026-01-02T10:30:00.000Z",
      consent_source: "double_optin",
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

function setValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function buttonByText(label: string): HTMLButtonElement {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function completeReviewedEvidence(): string {
  const captured = "2026-01-02T10:30";
  setValue(
    document.getElementById(
      "channel-consent-evidence-source",
    ) as HTMLSelectElement,
    "double_optin",
  );
  setValue(
    document.getElementById(
      "channel-consent-evidence-channel",
    ) as HTMLSelectElement,
    "email",
  );
  setValue(
    document.getElementById(
      "channel-consent-evidence-basis",
    ) as HTMLSelectElement,
    "consent",
  );
  setValue(
    document.getElementById("channel-consent-evidence-at") as HTMLInputElement,
    captured,
  );
  setValue(
    document.getElementById(
      "channel-consent-evidence-jurisdiction",
    ) as HTMLInputElement,
    "gb",
  );
  setValue(
    document.getElementById(
      "channel-consent-evidence-policy",
    ) as HTMLInputElement,
    "privacy-2026-01",
  );
  setValue(
    document.getElementById(
      "channel-consent-evidence-evidence",
    ) as HTMLTextAreaElement,
    "receipt:consent-123",
  );
  setValue(
    document.getElementById(
      "channel-consent-evidence-reason",
    ) as HTMLTextAreaElement,
    "Reviewed the double opt-in receipt.",
  );
  const scope = document
    .getElementById("channel-consent-evidence-reason")
    ?.closest('[role="dialog"]')
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!scope) throw new Error("Missing scope acknowledgement");
  act(() => scope.click());
  return captured;
}

describe("ChannelConsentsPanel", () => {
  it("keeps unknown channel state visible and mutations disabled for viewers", async () => {
    render(
      <ChannelConsentsPanel subscriberId="subscriber-1" canMutate={false} />,
    );
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith("subscriber-1"),
    );
    await waitFor(() => expect(document.body.textContent).toContain("Unknown"));
    expect(buttonByLabel("Grant Email consent").disabled).toBe(true);
    const sms = buttonByLabel("SMS consent is read-only");
    expect(sms.disabled).toBe(true);
    expect(sms.getAttribute("title")).toBeNull();
    const descriptions = (sms.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(descriptions).toContain(
      "SMS, Push, WhatsApp, and RCS consent are read-only",
    );
    expect(document.body.textContent).toContain(
      "Viewer access can inspect channel consent but cannot grant or revoke it.",
    );
  });

  it("requires reviewed evidence before recording a channel grant", async () => {
    render(
      <ChannelConsentsPanel
        subscriberId="subscriber-1"
        subscriberVersion='"subscriber:subscriber-1:v1"'
        canMutate
        onSubscriberVersionChange={mocks.versionChanged}
      />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("Unknown"));
    act(() => buttonByLabel("Grant Email consent").click());
    expect(buttonByText("Record grant").disabled).toBe(true);

    const captured = completeReviewedEvidence();
    act(() => buttonByText("Record grant").click());

    await waitFor(() => expect(mocks.set).toHaveBeenCalledTimes(1));
    expect(mocks.set).toHaveBeenCalledWith(
      "subscriber-1",
      "email",
      {
        status: "opted_in",
        consent_source: "double_optin",
        consent_timestamp: new Date(captured).toISOString(),
        evidence_channel: "email",
        legal_basis: "consent",
        evidence: "receipt:consent-123",
        jurisdiction: "GB",
        reason: "Reviewed the double opt-in receipt.",
        policy_version: "privacy-2026-01",
      },
      {
        version: '"subscriber:subscriber-1:v1"',
        maxAttempts: 1,
        requireOnline: true,
      },
    );
    expect(mocks.versionChanged).toHaveBeenCalledWith(
      '"subscriber:subscriber-1:v2"',
    );
  });

  it("stops mutations and asks for a reload after a stale revision", async () => {
    mocks.set.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 412,
        code: "precondition_failed",
        message: "stale",
      },
    });
    render(
      <ChannelConsentsPanel
        subscriberId="subscriber-1"
        subscriberVersion='"subscriber:subscriber-1:v1"'
        canMutate
      />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("Unknown"));
    act(() => buttonByLabel("Grant Email consent").click());
    completeReviewedEvidence();
    act(() => buttonByText("Record grant").click());
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Couldn't update consent",
      detail:
        "This subscriber changed elsewhere. Reload it before reviewing consent again.",
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Reload this subscriber to obtain the latest revision",
      ),
    );
    expect(buttonByLabel("Grant Email consent").disabled).toBe(true);
  });
});
