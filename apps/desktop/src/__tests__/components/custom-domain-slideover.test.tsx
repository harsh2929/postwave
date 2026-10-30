// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomDomain, DNSRecord } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  writeClipboardText: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../hooks/useSlideoverBehavior", () => ({
  useSlideoverBehavior: vi.fn(),
}));

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.writeClipboardText,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: vi.fn(),
    success: mocks.toastSuccess,
  },
}));

import { CustomDomainSlideover } from "../../components/CustomDomainSlideover";

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
  mocks.writeClipboardText.mockResolvedValue({
    ok: true,
    backend: "web",
    contentClass: "public",
    clearScheduled: false,
    clearAfterMs: null,
    historyWarning: null,
  });
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function record(overrides: Partial<DNSRecord> = {}): DNSRecord {
  return {
    type: "CNAME",
    name: "mail.example.test",
    value: "edge.moosewave.com",
    verified: false,
    error: "Record not found",
    ...overrides,
  };
}

function domain(overrides: Partial<CustomDomain> = {}): CustomDomain {
  return {
    id: "domain-1",
    domain: "mail.example.test",
    purpose: "tracking",
    verified: false,
    dns_records: [record()],
    createdAt: "2026-07-15T08:00:00.000Z",
    ...overrides,
  };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("CustomDomainSlideover", () => {
  it("renders legacy ownership evidence without a verification action", () => {
    const onChange = vi.fn();
    render(
      <CustomDomainSlideover
        domain={domain()}
        onClose={vi.fn()}
        onChange={onChange}
      />,
    );

    expect(document.body.textContent).toContain("Ownership evidence only");
    expect(document.body.textContent).toContain("DNS re-check held");
    expect(document.body.textContent).toContain(
      "automated TLS issuance and renewal",
    );
    expect(button("DNS re-check held").disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Check DNS ownership");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps safe evidence copying available", async () => {
    render(
      <CustomDomainSlideover domain={domain()} onClose={vi.fn()} />,
    );
    const copy = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy host for CNAME record 1"]',
    );
    expect(copy).not.toBeNull();
    act(() => copy?.click());
    await flush();

    expect(mocks.writeClipboardText).toHaveBeenCalledWith(
      "mail.example.test",
      { contentClass: "public", label: "DNS record" },
    );
  });

  it("never offers destructive removal", () => {
    render(
      <CustomDomainSlideover domain={domain()} onClose={vi.fn()} />,
    );
    expect(document.body.textContent).toContain("Removal is intentionally held");
    expect(
      Array.from(document.querySelectorAll("button")).some((candidate) =>
        /^remove(?:\s|$)/iu.test(candidate.textContent?.trim() ?? ""),
      ),
    ).toBe(false);
  });

  it("shows verified rows as historical evidence, not live readiness", () => {
    render(
      <CustomDomainSlideover
        domain={domain({
          verified: true,
          verifiedAt: "2026-08-03T10:15:28.942Z",
          dns_records: [record({ verified: true, error: undefined })],
        })}
        onClose={vi.fn()}
      />,
    );
    expect(document.body.textContent).toContain("Last check passed");
    expect(document.body.textContent).toContain("No production consumer is qualified");
    expect(button("DNS re-check held").disabled).toBe(true);
  });
});
