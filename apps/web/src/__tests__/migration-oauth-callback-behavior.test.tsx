// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeOAuth: vi.fn(),
  replace: vi.fn(),
  success: vi.fn(),
  search: new URLSearchParams(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.search,
}));

vi.mock("@/lib/migration-api", () => ({
  completeOAuth: mocks.completeOAuth,
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return {
    ...actual,
    whoami: mocks.whoami,
    whoamiFresh: mocks.whoamiFresh,
  };
});

vi.mock("sonner", () => ({ toast: { success: mocks.success } }));

import OAuthCallbackPage from "@/app/(dashboard)/app/migrations/oauth/callback/page";
import { qk } from "@/lib/query-keys";
import type { MeResponse } from "@/lib/auth-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const ADMIN_A: MeResponse = {
  user_id: "usr_a",
  tenant_id: "tnt_a",
  email: "a@example.com",
  role: "admin",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace A",
  workspace_slug: "workspace-a",
};

const ADMIN_B: MeResponse = {
  ...ADMIN_A,
  user_id: "usr_b",
  tenant_id: "tnt_b",
  email: "b@example.com",
  workspace_name: "Workspace B",
  workspace_slug: "workspace-b",
};

const EDITOR: MeResponse = {
  ...ADMIN_A,
  role: "owner",
  effective_role: "editor",
};

const VIEWER_MODE: MeResponse = {
  ...ADMIN_A,
  role: "owner",
  effective_role: "viewer",
  viewer_mode: true,
};

function pendingMarker(
  identity: MeResponse = ADMIN_A,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    source: "mailchimp",
    startedAt: Date.now(),
    tenantId: identity.tenant_id,
    userId: identity.user_id,
    effectiveRole: identity.effective_role ?? identity.role,
    viewerMode: identity.viewer_mode === true,
    ...overrides,
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

async function renderCallback() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient!}>
        <StrictMode>
          <OAuthCallbackPage />
        </StrictMode>
      </QueryClientProvider>,
    );
  });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.search = new URLSearchParams();
  mocks.completeOAuth.mockResolvedValue({
    job_id: "job_mailchimp_1",
    account_id: "account_1",
  });
  mocks.whoami.mockResolvedValue(ADMIN_A);
  mocks.whoamiFresh.mockResolvedValue(ADMIN_A);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  queryClient?.clear();
  root = null;
  container = null;
  queryClient = null;
});

describe("migration OAuth callback", () => {
  it("completes a valid callback exactly once under React Strict Mode", async () => {
    mocks.search = new URLSearchParams(
      "code=provider-code&state=nonce&source=mailchimp",
    );
    sessionStorage.setItem("postwave:oauth-pending", pendingMarker());

    await renderCallback();

    expect(mocks.completeOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.completeOAuth).toHaveBeenCalledWith(
      "mailchimp",
      "provider-code",
      "nonce",
      expect.anything(),
    );
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("postwave:oauth-pending")).toBeNull();
  });

  it("rejects a callback that was not initiated on this device", async () => {
    mocks.search = new URLSearchParams(
      "code=provider-code&state=nonce&source=mailchimp",
    );

    const rendered = await renderCallback();

    expect(mocks.completeOAuth).not.toHaveBeenCalled();
    expect(rendered.textContent).toContain("Connection needs attention");
    expect(rendered.textContent).toContain("no pending OAuth flow");
  });

  it("turns provider error codes into actionable copy without calling the API", async () => {
    mocks.search = new URLSearchParams("error=access_denied&source=mailchimp");

    const rendered = await renderCallback();

    expect(mocks.completeOAuth).not.toHaveBeenCalled();
    expect(rendered.textContent).toContain("You declined access");
    expect(rendered.querySelectorAll("h1")).toHaveLength(1);
  });

  it.each([
    [EDITOR, "effective editor role"],
    [VIEWER_MODE, "Viewer mode is active"],
  ])(
    "does not consume the callback for a read-only principal %#",
    async (identity, copy) => {
      mocks.whoami.mockResolvedValue(identity);
      mocks.search = new URLSearchParams(
        "code=provider-code&state=nonce&source=mailchimp",
      );
      const marker = pendingMarker();
      sessionStorage.setItem("postwave:oauth-pending", marker);

      const rendered = await renderCallback();

      expect(rendered.textContent).toContain(copy);
      expect(mocks.completeOAuth).not.toHaveBeenCalled();
      expect(sessionStorage.getItem("postwave:oauth-pending")).toBe(marker);
    },
  );

  it("keeps the marker intact when the initial identity check fails", async () => {
    mocks.whoami.mockRejectedValue(new Error("Auth service unavailable"));
    mocks.search = new URLSearchParams(
      "code=provider-code&state=nonce&source=mailchimp",
    );
    const marker = pendingMarker();
    sessionStorage.setItem("postwave:oauth-pending", marker);

    const rendered = await renderCallback();

    expect(rendered.textContent).toContain("Couldn’t verify migration access");
    expect(rendered.textContent).toContain("Auth service unavailable");
    expect(mocks.completeOAuth).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("postwave:oauth-pending")).toBe(marker);
  });

  it("rechecks exact admin authority before consuming the marker or completing OAuth", async () => {
    mocks.whoamiFresh.mockResolvedValue(EDITOR);
    mocks.search = new URLSearchParams(
      "code=provider-code&state=nonce&source=mailchimp",
    );
    const marker = pendingMarker();
    sessionStorage.setItem("postwave:oauth-pending", marker);

    const rendered = await renderCallback();

    expect(rendered.textContent).toContain("effective editor role");
    expect(mocks.completeOAuth).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("postwave:oauth-pending")).toBe(marker);
  });

  it("shows a retryable auth error and preserves the marker when fresh verification is unavailable", async () => {
    mocks.whoamiFresh.mockRejectedValue(new Error("Auth service unavailable"));
    mocks.search = new URLSearchParams(
      "code=provider-code&state=nonce&source=mailchimp",
    );
    const marker = pendingMarker();
    sessionStorage.setItem("postwave:oauth-pending", marker);

    const rendered = await renderCallback();

    expect(rendered.textContent).toContain(
      "Couldn’t reverify migration access",
    );
    expect(rendered.textContent).toContain("Auth service unavailable");
    expect(rendered.textContent).not.toContain("No migration started");
    expect(mocks.completeOAuth).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("postwave:oauth-pending")).toBe(marker);
  });

  it("preserves a principal-scoped marker when another admin opens its callback", async () => {
    mocks.search = new URLSearchParams(
      "code=provider-code&state=nonce&source=mailchimp",
    );
    const marker = pendingMarker(ADMIN_B);
    sessionStorage.setItem("postwave:oauth-pending", marker);

    const rendered = await renderCallback();

    expect(rendered.textContent).toContain(
      "workspace identity no longer matches",
    );
    expect(mocks.completeOAuth).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("postwave:oauth-pending")).toBe(marker);
  });

  it.each([
    ["non-numeric", "not-a-timestamp"],
    ["too far in the future", Date.now() + 2 * 60 * 1000],
  ])("rejects a %s OAuth marker timestamp", async (_label, startedAt) => {
    mocks.search = new URLSearchParams(
      "code=provider-code&state=nonce&source=mailchimp",
    );
    sessionStorage.setItem(
      "postwave:oauth-pending",
      pendingMarker(ADMIN_A, { startedAt }),
    );

    const rendered = await renderCallback();

    expect(rendered.textContent).toContain("OAuth flow expired");
    expect(mocks.completeOAuth).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("postwave:oauth-pending")).toBeNull();
  });

  it("aborts an in-flight callback result when the user or tenant changes", async () => {
    let resolveCompletion!: (value: {
      job_id: string;
      account_id: string;
    }) => void;
    const completion = new Promise<{
      job_id: string;
      account_id: string;
    }>((resolve) => {
      resolveCompletion = resolve;
    });
    mocks.completeOAuth.mockReturnValue(completion);
    mocks.search = new URLSearchParams(
      "code=provider-code&state=nonce&source=mailchimp",
    );
    sessionStorage.setItem("postwave:oauth-pending", pendingMarker());
    await renderCallback();
    expect(mocks.completeOAuth).toHaveBeenCalledTimes(1);

    mocks.whoamiFresh.mockResolvedValue(ADMIN_B);
    await act(async () => {
      queryClient?.setQueryData(qk.authMe(), ADMIN_B);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveCompletion({
        job_id: "job_stale",
        account_id: "account_stale",
      });
      await completion;
      await Promise.resolve();
    });

    expect(mocks.completeOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("does not restart a consumed callback for an equivalent identity refresh", async () => {
    let resolveCompletion!: (value: {
      job_id: string;
      account_id: string;
    }) => void;
    const completion = new Promise<{
      job_id: string;
      account_id: string;
    }>((resolve) => {
      resolveCompletion = resolve;
    });
    mocks.completeOAuth.mockReturnValue(completion);
    mocks.search = new URLSearchParams(
      "code=provider-code&state=nonce&source=mailchimp",
    );
    sessionStorage.setItem("postwave:oauth-pending", pendingMarker());
    const rendered = await renderCallback();
    expect(mocks.completeOAuth).toHaveBeenCalledTimes(1);

    await act(async () => {
      queryClient?.setQueryData(qk.authMe(), { ...ADMIN_A });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.completeOAuth).toHaveBeenCalledTimes(1);
    expect(rendered.textContent).not.toContain("no pending OAuth flow");

    await act(async () => {
      resolveCompletion({
        job_id: "job_mailchimp_1",
        account_id: "account_1",
      });
      await completion;
      await Promise.resolve();
    });
    expect(mocks.replace).toHaveBeenCalledTimes(1);
  });
});
