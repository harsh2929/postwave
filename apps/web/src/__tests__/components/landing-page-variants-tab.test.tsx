// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VariantsTab } from "@/app/(dashboard)/app/landing-pages/[id]/variants-tab";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createVariant: vi.fn(),
  deleteVariant: vi.fn(),
  listVariants: vi.fn(),
  updateVariant: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/landing-pages-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/landing-pages-api")>();
  return {
    ...actual,
    landingPagesApi: {
      ...actual.landingPagesApi,
      createVariant: mocks.createVariant,
      deleteVariant: mocks.deleteVariant,
      listVariants: mocks.listVariants,
      updateVariant: mocks.updateVariant,
    },
  };
});

function identity(role: "owner" | "admin" | "editor" | "viewer") {
  return {
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "user@example.test",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Test",
    workspace_slug: "test",
  };
}

function renderVariants(
  role: "owner" | "admin" | "editor" | "viewer" = "admin",
  blocks: Array<Record<string, unknown>> = [],
): { root: Root; queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(VariantsTab, {
          pageId: "lp_1",
          currentBlocks: blocks,
          baseKey: ["landing-pages", "tenant-1", role, "user-1", false],
          identity: identity(role),
          canAdmin: role === "owner" || role === "admin",
        }),
      ),
    );
  });

  return { root, queryClient };
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

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("landing page variants request states", () => {
  it("distinguishes a failed request from an empty experiment and retries", async () => {
    mocks.listVariants
      .mockRejectedValueOnce(new Error("variants unavailable"))
      .mockResolvedValueOnce([]);
    const { root, queryClient } = renderVariants();

    try {
      await waitFor(() => {
        const alert = document.querySelector('[role="alert"]');
        expect(alert?.textContent).toContain("Could not load variants");
      });
      expect(document.body.textContent).not.toContain("No variants yet");

      const retry = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry",
      );
      expect(retry).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        (retry as HTMLButtonElement).click();
      });

      await waitFor(() => {
        expect(document.body.textContent).toContain("No variants yet");
      });
      expect(mocks.listVariants).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it.each(["editor", "viewer"] as const)(
    "keeps variant writes unavailable to a %s while preserving reads",
    async (role) => {
      mocks.listVariants.mockResolvedValue([]);
      const { root, queryClient } = renderVariants(role);
      try {
        await waitFor(() => {
          expect(document.body.textContent).toContain("No variants yet");
        });
        expect(document.body.textContent).toContain("read-only");
        expect(document.body.textContent).not.toContain(
          "Capture current content as a variant",
        );
        expect(mocks.listVariants).toHaveBeenCalledTimes(1);
        expect(mocks.whoamiFresh).not.toHaveBeenCalled();
        expect(mocks.createVariant).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        queryClient.clear();
      }
    },
  );

  it("blocks a stale admin before variant transport", async () => {
    const opened = identity("admin");
    mocks.listVariants.mockResolvedValue([]);
    mocks.whoamiFresh.mockResolvedValue(identity("editor"));
    const blocks = [{ type: "hero", heading: "Original" }];
    const { root, queryClient } = renderVariants("admin", blocks);
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Capture current content as a variant",
        );
      });
      const capture = Array.from(document.querySelectorAll("button")).find(
        (button) =>
          button.textContent?.includes("Capture current content as a variant"),
      );
      expect(capture).toBeInstanceOf(HTMLButtonElement);
      await act(async () => {
        (capture as HTMLButtonElement).click();
      });
      await waitFor(() => expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1));
      expect(mocks.createVariant).not.toHaveBeenCalled();
      expect(opened.role).toBe("admin");
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it("fresh-checks once, deduplicates same-tick capture, and freezes blocks", async () => {
    const opened = identity("admin");
    let releaseFresh!: (value: ReturnType<typeof identity>) => void;
    mocks.listVariants.mockResolvedValue([]);
    mocks.whoamiFresh.mockReturnValue(
      new Promise((resolve) => {
        releaseFresh = resolve;
      }),
    );
    mocks.createVariant.mockResolvedValue({ id: "variant-1" });
    const blocks = [{ type: "hero", heading: "Original" }];
    const { root, queryClient } = renderVariants("admin", blocks);
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Capture current content as a variant",
        );
      });
      const capture = Array.from(document.querySelectorAll("button")).find(
        (button) =>
          button.textContent?.includes("Capture current content as a variant"),
      ) as HTMLButtonElement;
      await act(async () => {
        capture.click();
        capture.click();
        blocks[0].heading = "Changed after click";
        await Promise.resolve();
      });
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      act(() => releaseFresh(opened));
      await waitFor(() => expect(mocks.createVariant).toHaveBeenCalledTimes(1));
      expect(mocks.createVariant).toHaveBeenCalledWith("lp_1", {
        name: "Variant 1",
        weight: 50,
        blocks: [{ type: "hero", heading: "Original" }],
        is_control: true,
      });
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });
});
