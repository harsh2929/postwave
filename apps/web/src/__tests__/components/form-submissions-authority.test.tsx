// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SubmissionsPage from "@/app/(dashboard)/app/forms/[id]/submissions/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  deleteSubmission: vi.fn(),
  fetchSubmissionsCsv: vi.fn(),
  getForm: vi.fn(),
  listAllSubmissions: vi.fn(),
  resendConfirmation: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "form-1" }),
  usePathname: () => "/app/forms/form-1/submissions",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth-api", () => ({
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/forms-api", () => ({
  deleteSubmission: mocks.deleteSubmission,
  fetchSubmissionsCsv: mocks.fetchSubmissionsCsv,
  getForm: mocks.getForm,
  listAllSubmissions: mocks.listAllSubmissions,
  resendConfirmation: mocks.resendConfirmation,
}));

vi.mock("@/lib/download", () => ({ downloadTextFile: vi.fn() }));

const form = {
  id: "form-1",
  tenantId: "tenant-1",
  slug: "newsletter",
  name: "Newsletter",
  optInMode: "double",
  structure: { fields: [] },
  settings: { successMessage: "Thanks" },
  status: "published",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

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

let root: Root | null = null;

async function settle(turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPage() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SubmissionsPage),
      ),
    );
  });
  await settle();
  return { host, queryClient };
}

beforeEach(() => {
  mocks.getForm.mockResolvedValue(form);
  mocks.listAllSubmissions.mockResolvedValue({
    items: [
      {
        id: "submission-1",
        formId: "form-1",
        email: "private@example.test",
        customFields: {},
        status: "confirmed",
        submittedAt: "2026-08-01T00:00:00Z",
      },
    ],
    truncated: false,
  });
  mocks.fetchSubmissionsCsv.mockResolvedValue("id,email\n");
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("form submission authority", () => {
  it.each(["viewer", "editor"] as const)(
    "does not request PII inventory for a %s",
    async (role) => {
      mocks.whoami.mockResolvedValue(identity(role));
      const { host, queryClient } = await renderPage();

      expect(host.textContent).toContain("restricted to owners and admins");
      expect(host.textContent).toContain("No submission inventory");
      expect(mocks.getForm).not.toHaveBeenCalled();
      expect(mocks.listAllSubmissions).not.toHaveBeenCalled();
      expect(
        queryClient
          .getQueriesData({ queryKey: ["forms-submissions-sensitive"] })
          .every(([, data]) => data === undefined),
      ).toBe(true);
    },
  );

  it.each(["owner", "admin"] as const)(
    "loads the isolated submission inventory for an %s",
    async (role) => {
      const opened = identity(role);
      mocks.whoami.mockResolvedValue(opened);
      mocks.whoamiFresh.mockResolvedValue(opened);
      const { host } = await renderPage();

      expect(mocks.getForm).toHaveBeenCalledWith("form-1");
      expect(mocks.listAllSubmissions).toHaveBeenCalledWith("form-1");
      expect(host.textContent).toContain("private@example.test");
    },
  );

  it("revalidates fresh authority before export and blocks a demoted admin", async () => {
    mocks.whoami.mockResolvedValue(identity("admin"));
    mocks.whoamiFresh.mockResolvedValue(identity("viewer"));
    const { host } = await renderPage();
    const exportButton = Array.from(host.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Export CSV",
    );
    expect(exportButton).toBeTruthy();

    await act(async () => exportButton?.click());
    await settle(2);

    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSubmissionsCsv).not.toHaveBeenCalled();
  });
});
