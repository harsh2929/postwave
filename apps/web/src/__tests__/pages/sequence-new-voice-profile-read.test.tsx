// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getTemplate: vi.fn(),
  createSequence: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ templateId: "welcome-warm" }),
  usePathname: () => "/app/sequences/new/welcome-warm",
  useSearchParams: () => new URLSearchParams("step=3"),
  useRouter: () => ({
    push: mocks.push,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("@/lib/voice-api", () => ({
  getProfile: mocks.getProfile,
  getTemplate: mocks.getTemplate,
  createSequence: mocks.createSequence,
}));

import NewSequenceFlowPage from "@/app/(dashboard)/app/sequences/new/[templateId]/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const template = {
  id: "welcome-warm",
  slug: "welcome-warm",
  name: "Warm welcome",
  description: "A grounded welcome sequence.",
  category: "Welcome",
  length: 3,
  variables: [],
  emails: [],
};

const profile = {
  id: "voice-1",
  itemCount: 3,
  builtAt: "2026-08-30T10:00:00Z",
  vocabulary: [{ term: "clear", weight: 0.8 }],
  samples: [],
};

function mount(): { root: Root; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(NewSequenceFlowPage));
  });
  return { root, container };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => flush());
    }
  }
  throw lastError;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  mocks.getTemplate.mockResolvedValue(template);
  mocks.getProfile.mockResolvedValue(profile);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("new sequence voice-profile read", () => {
  it("distinguishes loading from a verified ready profile", async () => {
    let release!: (value: typeof profile) => void;
    mocks.getProfile.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { root, container } = mount();
    try {
      await waitFor(() => {
        expect(container.querySelector('[role="status"]')?.textContent).toMatch(
          /Loading profile/iu,
        );
      });
      await act(async () => {
        release(profile);
        await flush();
      });
      await waitFor(() => {
        expect(container.textContent).toContain("Profile ready");
        expect(container.textContent).toContain("3 items");
        expect(container.textContent).toContain("clear");
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders verified absence as setup guidance, not a read failure", async () => {
    mocks.getProfile.mockResolvedValueOnce(null);
    const { root, container } = mount();
    try {
      await waitFor(() => {
        expect(container.textContent).toContain("No voice profile yet.");
        expect(container.textContent).toContain("Set up voice profile");
      });
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders a failed read as retryable and never calls it missing", async () => {
    mocks.getProfile
      .mockRejectedValueOnce(new Error("profile unavailable"))
      .mockResolvedValueOnce(profile);
    const { root, container } = mount();
    try {
      await waitFor(() => {
        expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
          /Voice profile could not be verified/iu,
        );
        expect(container.textContent).not.toContain("No voice profile yet.");
      });
      await act(async () => {
        button(container, "Retry profile").click();
        await flush();
      });
      await waitFor(() => {
        expect(container.textContent).toContain("Profile ready");
        expect(container.querySelector('[role="alert"]')).toBeNull();
      });
      expect(mocks.getProfile).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });
});
