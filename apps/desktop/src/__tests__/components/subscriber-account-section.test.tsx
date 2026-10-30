// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  link: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listAccounts: mocks.list,
    createAccount: mocks.create,
    setSubscriberAccount: mocks.link,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { AccountSection } from "../../components/subscribers/AccountSection";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

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

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function input(label: string, value: string): void {
  const element = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!element) throw new Error(`Missing input: ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.list.mockResolvedValue({ data: { items: [], total: 0 } });
  mocks.link.mockResolvedValue({
    data: {
      id: "subscriber-1",
      email: "reader@example.com",
      account_id: "account-1",
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("subscriber account section", () => {
  it("owns and aborts its account-directory request", () => {
    let signal: AbortSignal | undefined;
    mocks.list.mockImplementation((opts?: { signal?: AbortSignal }) => {
      signal = opts?.signal;
      return new Promise(() => undefined);
    });
    render(
      <AccountSection
        subscriberId="subscriber-1"
        accountId={null}
        subscriberVersion='"subscriber:subscriber-1:v1"'
        canMutate
      />,
    );
    expect(signal?.aborted).toBe(false);
    act(() => root?.unmount());
    root = null;
    expect(signal?.aborted).toBe(true);
  });

  it("offers a retry and distinguishes an unavailable linked record", async () => {
    mocks.list
      .mockResolvedValueOnce({
        error: { kind: "transport", message: "private network detail" },
      })
      .mockResolvedValueOnce({ data: { items: [], total: 0 } });
    render(
      <AccountSection
        subscriberId="subscriber-1"
        accountId="account-missing"
        subscriberVersion='"subscriber:subscriber-1:v1"'
        canMutate
      />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "The account directory could not be loaded",
      );
    });
    expect(document.body.textContent).not.toContain("private network detail");
    act(() => button("Retry account directory").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "account that is no longer visible",
      );
    });
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("validates UTF-8 bounds and serializes create-and-link submissions", async () => {
    let resolveCreate:
      | ((value: {
          data: { id: string; name: string; industry: string };
        }) => void)
      | undefined;
    mocks.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    render(
      <AccountSection
        subscriberId="subscriber-1"
        accountId={null}
        subscriberVersion='"subscriber:subscriber-1:v1"'
        canMutate
      />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("Not linked");
    });
    act(() => button("New").click());
    input("New account name", "🚀".repeat(60));
    expect(document.body.textContent).toContain("200 UTF-8 bytes or fewer");
    expect(button("Create & link").disabled).toBe(true);

    input("New account name", "Acme");
    const submit = button("Create & link");
    act(() => {
      submit.click();
      submit.click();
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreate?.({
        data: { id: "account-1", name: "Acme", industry: "" },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(mocks.link).toHaveBeenCalledTimes(1));
    expect(mocks.link).toHaveBeenCalledWith(
      "subscriber-1",
      "account-1",
      '"subscriber:subscriber-1:v1"',
    );
  });
});
