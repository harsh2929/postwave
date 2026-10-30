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

import type { SubscriberFederationLink } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listSubscriberFederatedLinks: mocks.list,
    createSubscriberFederatedLink: mocks.create,
    deleteSubscriberFederatedLink: mocks.remove,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { FederatedIdentityPanel } from "../../components/subscribers/FederatedIdentityPanel";

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
  mocks.remove.mockResolvedValue({ data: undefined });
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function federationLink(
  overrides: Partial<SubscriberFederationLink> = {},
): SubscriberFederationLink {
  return {
    id: "link-1",
    child_subscriber_id: "subscriber-1",
    parent_tenant_id: "11111111-1111-4111-8111-111111111111",
    master_subscriber_id: "22222222-2222-4222-8222-222222222222",
    match_type: "manual",
    match_key: "reader@example.com",
    created_at: "2026-07-15T08:00:00.000Z",
    updated_at: "2026-07-15T08:00:00.000Z",
    ...overrides,
  };
}

function panel(
  subscriberId = "subscriber-1",
  canMutate = true,
  onUnavailable = vi.fn(),
): ReactElement {
  return (
    <FederatedIdentityPanel
      subscriberId={subscriberId}
      subscriberVersion={`"subscriber:${subscriberId}:v1"`}
      canMutate={canMutate}
      onUnavailable={onUnavailable}
    />
  );
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

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function input(id: string, value: string): void {
  const element = document.getElementById(id) as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
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

describe("FederatedIdentityPanel", () => {
  it("leads with verified link context and keeps raw IDs in technical details", async () => {
    const link = federationLink({ match_type: "email" });
    mocks.list.mockResolvedValueOnce({ data: { items: [link] } });

    render(panel("subscriber-1", false));

    await waitFor(() => {
      expect(mocks.list).toHaveBeenCalledWith("subscriber-1", {
        signal: expect.any(AbortSignal),
      });
      expect(document.body.textContent).toContain("Matched on email");
    });
    expect(document.body.textContent).toContain("Master identity linked");
    expect(document.body.textContent).toContain("Agency parent");
    expect(document.body.textContent).toContain(
      "Parent-workspace names and profile details stay private",
    );
    const technicalDetails =
      document.querySelector<HTMLDetailsElement>("details");
    expect(technicalDetails?.open).toBe(false);
    expect(technicalDetails?.textContent).toContain("Technical identifiers");
    expect(document.body.textContent).toContain("11111111…1111");
    expect(document.body.textContent).toContain("22222222…2222");
    expect(document.body.textContent).toContain("reader@example.com");
    expect(document.body.textContent).not.toContain("Unlink");
  });

  it("reports an unavailable route without presenting it as a load error", async () => {
    const onUnavailable = vi.fn();
    mocks.list.mockResolvedValueOnce({
      error: { kind: "http", status: 404, message: "Not found" },
    });

    render(panel("subscriber-1", true, onUnavailable));

    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).not.toContain(
      "Couldn't load federated identities",
    );
  });

  it("creates and removes a manual parent identity link", async () => {
    const link = federationLink();
    mocks.create.mockResolvedValueOnce({ data: link });
    render(panel());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Not federated"),
    );

    act(() => button("Link parent identity…").click());
    input("fed-parent-tenant", link.parent_tenant_id);
    input("fed-master-subscriber", link.master_subscriber_id);
    act(() => button("Link").click());

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith(
        "subscriber-1",
        {
          parent_tenant_id: link.parent_tenant_id,
          master_subscriber_id: link.master_subscriber_id,
          match_type: "manual",
        },
        `"subscriber:subscriber-1:v1"`,
      );
      expect(document.body.textContent).toContain("22222222…2222");
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith({
      message: "Federated identity linked",
    });

    act(() => button("Unlink").click());
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[role="alertdialog"] button',
      ),
    ).find((candidate) => candidate.textContent?.trim() === "Unlink");
    if (!confirm) throw new Error("Missing unlink confirmation");
    act(() => confirm.click());
    await waitFor(() => {
      expect(mocks.remove).toHaveBeenCalledWith(
        "subscriber-1",
        link.master_subscriber_id,
        `"subscriber:subscriber-1:v1"`,
      );
      expect(document.body.textContent).toContain("Not federated");
    });
    expect(mocks.toastSuccess).toHaveBeenLastCalledWith({
      message: "Federated identity unlinked",
    });
  });

  it("does not leak a pending mutation into a newly selected subscriber", async () => {
    const creation = deferred<{ data: SubscriberFederationLink }>();
    mocks.create.mockReturnValueOnce(creation.promise);
    const view = render(panel("subscriber-1"));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Not federated"),
    );

    act(() => button("Link parent identity…").click());
    const parentA = "33333333-3333-4333-8333-333333333333";
    const masterA = "44444444-4444-4444-8444-444444444444";
    input("fed-parent-tenant", parentA);
    input("fed-master-subscriber", masterA);
    act(() => button("Link").click());

    view.rerender(panel("subscriber-2"));
    await waitFor(() => {
      expect(mocks.list).toHaveBeenLastCalledWith("subscriber-2", {
        signal: expect.any(AbortSignal),
      });
      expect(document.body.textContent).toContain("Not federated");
    });
    creation.resolve({
      data: federationLink({
        parent_tenant_id: parentA,
        master_subscriber_id: masterA,
      }),
    });
    await act(async () => Promise.resolve());

    expect(document.body.textContent).not.toContain("44444444");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
