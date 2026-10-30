// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  reauthorize: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@/lib/preferences-api", () => ({
  listSubscriberTopics: mocks.list,
  setSubscriberTopics: mocks.set,
}));
vi.mock("@/lib/subscriber-authority", () => ({
  reauthorizeSubscriberMutation: mocks.reauthorize,
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success },
}));

import { SubscriberPreferencesPanel } from "@/app/(dashboard)/app/subscribers/[id]/_preferences-panel";

const authority = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  role: "editor" as const,
};
const topic = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: authority.tenantId,
  slug: "product-updates",
  name: "Product updates",
  description: "Major releases.",
  defaultOptIn: false,
  displayOrder: 1,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-30T00:00:00Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reauthorize.mockResolvedValue(undefined);
  mocks.set.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("SubscriberPreferencesPanel", () => {
  it("confirms an administrative opt-in and verifies the fresh readback", async () => {
    mocks.list
      .mockResolvedValueOnce([{ topic, optedIn: false }])
      .mockResolvedValueOnce([{ topic, optedIn: true }]);
    mount(authority);

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "administrative topic overrides",
      );
      expect(button(/^Opt in$/u)).not.toBeNull();
    });
    act(() => button(/^Opt in$/u).click());
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
    );
    await act(async () => {
      button(
        /^Record opt-in$/u,
        document.querySelector('[role="dialog"]')!,
      ).click();
    });

    await waitFor(() => {
      expect(mocks.set).toHaveBeenCalledWith(
        "ada@example.com",
        [{ topicId: topic.id, optedIn: true }],
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mocks.reauthorize).toHaveBeenCalledTimes(2);
      expect(mocks.list).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain("Opted in");
      expect(mocks.success).toHaveBeenCalledOnce();
    });
  });

  it("keeps viewer controls visible but disabled with a permission reason", async () => {
    mocks.list.mockResolvedValue([{ topic, optedIn: true }]);
    mount(null);

    await waitFor(() => {
      const control = button(/^Opt out$/u);
      expect(control.disabled).toBe(true);
      expect(control.getAttribute("aria-describedby")).toBeTruthy();
      expect(document.body.textContent).toContain(
        "Viewer access can inspect topic choices but cannot change them.",
      );
    });
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("distinguishes a verified empty catalog from a failed read", async () => {
    mocks.list.mockResolvedValue([]);
    mount(authority);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "no preference-center topics configured",
      );
    });

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    mocks.list.mockRejectedValue(new Error("offline"));
    mount(authority);
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "could not be verified",
      );
      expect(document.body.textContent).not.toContain(
        "no preference-center topics configured",
      );
    });
  });

  it("does not repeat an acknowledged write when final-state verification fails", async () => {
    mocks.list
      .mockResolvedValueOnce([{ topic, optedIn: false }])
      .mockRejectedValueOnce(new Error("readback unavailable"));
    mount(authority);
    await waitFor(() => expect(button(/^Opt in$/u)).not.toBeNull());
    act(() => button(/^Opt in$/u).click());
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
    );
    await act(async () => {
      button(
        /^Record opt-in$/u,
        document.querySelector('[role="dialog"]')!,
      ).click();
    });
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "may have saved",
      );
      expect(mocks.set).toHaveBeenCalledTimes(1);
    });
  });
});

function mount(currentAuthority: typeof authority | null): void {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <SubscriberPreferencesPanel
          email="ada@example.com"
          tenantId={authority.tenantId}
          role={currentAuthority?.role ?? "viewer"}
          authority={currentAuthority}
          enabled
        />
      </QueryClientProvider>,
    );
  });
}

function button(
  pattern: RegExp,
  within: ParentNode = document,
): HTMLButtonElement {
  const match = [...within.querySelectorAll("button")].find((candidate) =>
    pattern.test(
      candidate.textContent?.trim() ??
        candidate.getAttribute("aria-label") ??
        "",
    ),
  );
  if (!match) throw new Error(`Button not found: ${pattern}`);
  return match as HTMLButtonElement;
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}
