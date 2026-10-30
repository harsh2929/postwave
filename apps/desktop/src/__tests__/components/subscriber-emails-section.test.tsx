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
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  MAX_EMAILS_PER_PROFILE: 5,
  api: {
    listSubscriberEmails: mocks.list,
    addSubscriberEmail: mocks.add,
    updateSubscriberEmail: mocks.update,
    deleteSubscriberEmail: mocks.remove,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { SubscriberEmailsSection } from "../../components/subscribers/SubscriberEmailsSection";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function address(
  overrides: Partial<{
    id: string;
    subscriber_id: string;
    email: string;
    is_primary: boolean;
    consent_status: string;
    suppressed: boolean;
    last_engaged_at: string;
    created_at: string;
    updated_at: string;
    version: string;
  }> = {},
) {
  return {
    id: "address-1",
    subscriber_id: "subscriber-1",
    email: "ada@example.com",
    is_primary: true,
    consent_status: "never_subscribed",
    suppressed: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    version: '"subscriber-email:v1"',
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.list.mockResolvedValue({ data: { items: [address()] } });
  mocks.add.mockResolvedValue({
    data: address({
      id: "address-2",
      email: "alternate@example.com",
      is_primary: false,
      version: '"subscriber-email:v2"',
    }),
  });
  mocks.update.mockResolvedValue({
    data: address({
      consent_status: "subscribed",
      version: '"subscriber-email:v2"',
    }),
  });
  mocks.remove.mockResolvedValue({ data: { deleted: true } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return { rerender: (next) => act(() => root?.render(next)) };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
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

function buttonByText(label: string): HTMLButtonElement {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function renderSection(canMutate = true): ReturnType<typeof render> {
  return render(
    <SubscriberEmailsSection
      subscriberId="subscriber-1"
      subscriberVersion='"subscriber:subscriber-1:v1"'
      canonicalEmail="ada@example.com"
      canMutate={canMutate}
    />,
  );
}

function fillConsentEvidence(email: string): void {
  setValue(
    document.getElementById("address-consent-source") as HTMLSelectElement,
    "double_optin",
  );
  setValue(
    document.getElementById("address-consent-channel") as HTMLSelectElement,
    "email",
  );
  setValue(
    document.getElementById("address-consent-basis") as HTMLSelectElement,
    "consent",
  );
  setValue(
    document.getElementById("address-consent-at") as HTMLInputElement,
    "2026-01-02T10:30",
  );
  setValue(
    document.getElementById("address-consent-jurisdiction") as HTMLInputElement,
    "gb",
  );
  setValue(
    document.getElementById("address-consent-policy") as HTMLInputElement,
    "privacy-2026-01",
  );
  setValue(
    document.getElementById("address-consent-evidence") as HTMLTextAreaElement,
    "receipt:consent-123",
  );
  setValue(
    document.getElementById("address-consent-reason") as HTMLTextAreaElement,
    "Reviewed the exact double opt-in receipt.",
  );
  const acknowledgement = document
    .getElementById("address-consent-reason")
    ?.closest('[role="dialog"]')
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!acknowledgement) throw new Error("Missing consent acknowledgement");
  act(() => acknowledgement.click());
  setValue(
    document.getElementById("address-consent-confirmation") as HTMLInputElement,
    email,
  );
}

describe("SubscriberEmailsSection", () => {
  it("shows honest delivery identity and removes decorative primary controls", async () => {
    renderSection(false);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Delivery address"),
    );

    expect(mocks.list).toHaveBeenCalledWith("subscriber-1", {
      signal: expect.any(AbortSignal),
    });
    expect(document.body.textContent).not.toContain("Set primary");
    expect(
      document.querySelector("select[aria-label^='Consent for']"),
    ).toBeNull();
    expect(buttonByText("Review consent").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Viewer access can inspect address state but cannot change it.",
    );
  });

  it("adds an alternate with no fabricated consent or primary claim", async () => {
    renderSection();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Delivery address"),
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[type="email"]',
    );
    if (!input) throw new Error("Missing add-address input");
    setValue(input, "alternate@example.com");
    act(() => buttonByText("Add alternate").click());

    await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1));
    expect(mocks.add).toHaveBeenCalledWith(
      "subscriber-1",
      { email: "alternate@example.com" },
      '"subscriber:subscriber-1:v1"',
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.add.mock.calls[0]?.[1]).not.toHaveProperty("consent_status");
    expect(mocks.add.mock.calls[0]?.[1]).not.toHaveProperty("is_primary");
  });

  it("requires evidence and the exact address before granting consent", async () => {
    renderSection();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Delivery address"),
    );
    act(() => buttonByText("Review consent").click());
    expect(buttonByText("Record decision").disabled).toBe(true);

    fillConsentEvidence("ada@example.com");
    expect(buttonByText("Record decision").disabled).toBe(false);
    act(() => buttonByText("Record decision").click());

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update).toHaveBeenCalledWith(
      "subscriber-1",
      "address-1",
      {
        consent_status: "subscribed",
        source: "double_optin",
        channel: "email",
        legal_basis: "consent",
        occurred_at: new Date("2026-01-02T10:30").toISOString(),
        jurisdiction: "GB",
        evidence: "receipt:consent-123",
        reason: "Reviewed the exact double opt-in receipt.",
        policy_version: "privacy-2026-01",
      },
      '"subscriber-email:v1"',
      { signal: expect.any(AbortSignal) },
    );
  });

  it("requires evidence and typed confirmation before restoring delivery", async () => {
    mocks.list.mockResolvedValue({
      data: { items: [address({ suppressed: true })] },
    });
    mocks.update.mockResolvedValue({
      data: address({ suppressed: false, version: '"subscriber-email:v2"' }),
    });
    renderSection();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Suppressed"),
    );
    act(() => buttonByText("Review restoration").click());

    setValue(
      document.getElementById(
        "address-suppression-reason",
      ) as HTMLTextAreaElement,
      "Provider classified a verified false positive.",
    );
    setValue(
      document.getElementById(
        "address-suppression-evidence",
      ) as HTMLTextAreaElement,
      "ticket:PW-2042 provider-trace:77",
    );
    const acknowledgement = document
      .getElementById("address-suppression-reason")
      ?.closest('[role="alertdialog"]')
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!acknowledgement)
      throw new Error("Missing suppression acknowledgement");
    act(() => acknowledgement.click());
    setValue(
      document.getElementById(
        "address-suppression-confirmation",
      ) as HTMLInputElement,
      "ada@example.com",
    );
    act(() => buttonByText("Remove address hold").click());

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update).toHaveBeenCalledWith(
      "subscriber-1",
      "address-1",
      {
        suppressed: false,
        suppression_reason: "Provider classified a verified false positive.",
        suppression_evidence: "ticket:PW-2042 provider-trace:77",
      },
      '"subscriber-email:v1"',
      { signal: expect.any(AbortSignal) },
    );
  });

  it("protects the canonical address and conditionally removes an alternate", async () => {
    mocks.list.mockResolvedValue({
      data: {
        items: [
          address(),
          address({
            id: "address-2",
            email: "alternate@example.com",
            is_primary: false,
            version: '"subscriber-email:alternate-v1"',
          }),
        ],
      },
    });
    renderSection();
    await waitFor(() =>
      expect(document.body.textContent).toContain("alternate@example.com"),
    );
    const rows = [
      ...document.querySelectorAll<HTMLElement>(".subscriber-address"),
    ];
    const canonicalRemove =
      rows[0]?.querySelector<HTMLButtonElement>(".btn-danger-ghost");
    const alternateRemove =
      rows[1]?.querySelector<HTMLButtonElement>(".btn-danger-ghost");
    expect(canonicalRemove?.disabled).toBe(true);
    if (!alternateRemove) throw new Error("Missing alternate remove action");
    act(() => alternateRemove.click());
    setValue(
      document.getElementById(
        "address-removal-confirmation",
      ) as HTMLInputElement,
      "alternate@example.com",
    );
    act(() => buttonByText("Remove alternate").click());

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(1));
    expect(mocks.remove).toHaveBeenCalledWith(
      "subscriber-1",
      "address-2",
      '"subscriber-email:alternate-v1"',
      { signal: expect.any(AbortSignal) },
    );
  });

  it("aborts the old profile request when identity changes", async () => {
    const { rerender } = renderSection();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    const firstSignal = mocks.list.mock.calls[0]?.[1]?.signal as AbortSignal;
    rerender(
      <SubscriberEmailsSection
        subscriberId="subscriber-2"
        subscriberVersion='"subscriber:subscriber-2:v1"'
        canonicalEmail="grace@example.com"
        canMutate
      />,
    );
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
  });

  it("holds mutations when a rolling deployment omits revision tokens", async () => {
    mocks.list.mockResolvedValue({
      data: { items: [address({ version: "" })] },
    });
    renderSection();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Address actions are temporarily held.",
      ),
    );
    expect(buttonByText("Review consent").disabled).toBe(true);
    expect(buttonByText("Review suppression").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "will not perform an unconditional consent or suppression write",
    );
  });

  it("rejects malformed list contracts instead of rendering partial controls", async () => {
    mocks.list.mockResolvedValue({
      data: { items: [{ email: "attacker@example.com" }] },
    });
    renderSection();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The service returned an invalid address contract.",
      ),
    );
    expect(document.querySelector(".subscriber-address")).toBeNull();
    expect(document.querySelector('input[type="email"]')).toBeNull();
  });

  it("reloads after a stale reviewed decision and never retries it blindly", async () => {
    mocks.update.mockResolvedValue({
      error: {
        kind: "http",
        status: 412,
        message: "precondition failed",
      },
    });
    renderSection();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Delivery address"),
    );
    act(() => buttonByText("Review consent").click());
    fillConsentEvidence("ada@example.com");
    act(() => buttonByText("Record decision").click());

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Address changed in another session",
      }),
    );
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("suppresses same-tick duplicate add submissions", async () => {
    let resolveAdd:
      | ((value: { data: ReturnType<typeof address> }) => void)
      | undefined;
    mocks.add.mockReturnValue(
      new Promise((resolve) => {
        resolveAdd = resolve;
      }),
    );
    renderSection();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Delivery address"),
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[type="email"]',
    );
    if (!input) throw new Error("Missing add-address input");
    setValue(input, "alternate@example.com");
    const button = buttonByText("Add alternate");
    act(() => {
      button.click();
      button.click();
    });
    expect(mocks.add).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveAdd?.({
        data: address({
          id: "address-2",
          email: "alternate@example.com",
          is_primary: false,
        }),
      });
      await Promise.resolve();
    });
  });
});
