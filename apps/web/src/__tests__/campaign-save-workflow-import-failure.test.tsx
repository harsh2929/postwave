// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
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
  sendCampaignTest: vi.fn(),
  toastError: vi.fn(),
  updateCampaign: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/campaign-block-renderer", () => {
  throw new Error("campaign validator chunk unavailable");
});

vi.mock("@/lib/campaigns-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaigns-api")>()),
  sendCampaignTest: mocks.sendCampaignTest,
  updateCampaign: mocks.updateCampaign,
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}));

import {
  CAMPAIGN_CONTENT_VALIDATION_UNAVAILABLE,
  useCampaignSaveWorkflow,
} from "@/app/(dashboard)/app/campaigns/[id]/use-campaign-save-workflow";
import type { Campaign } from "@/lib/campaigns-api";
import type { MeResponse } from "@/lib/auth-api";

const campaign: Campaign = {
  id: "campaign-import-failure",
  tenant_id: "tenant-1",
  name: "Launch",
  subject: "Hello",
  status: "draft",
  body_html: '<a href="https://shop.example.test/launch">Launch</a>',
  delivery_settings: { from_email: "sender@example.test" },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
};

const identity: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "editor@example.test",
  role: "editor",
  effective_role: "editor",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

type WorkflowProps = Parameters<typeof useCampaignSaveWorkflow>[0];

let latest: ReturnType<typeof useCampaignSaveWorkflow> | null = null;
let queryClient: QueryClient | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoamiFresh.mockResolvedValue(identity);
  latest = null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  queryClient?.clear();
  document.body.replaceChildren();
  latest = null;
  queryClient = null;
  root = null;
});

function Harness(props: WorkflowProps) {
  latest = useCampaignSaveWorkflow(props);
  return null;
}

function renderWorkflow(): void {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  act(() => {
    root?.render(
      createElement(Harness, {
        campaign,
        campaignKey: ["campaign", campaign.id],
        campaignsBaseKey: ["campaigns"],
        queryClient: queryClient!,
        setCampaign: vi.fn(),
        setDirty: vi.fn(),
        testEmail: "recipient@example.test",
        canWrite: true,
        openedIdentity: identity,
      }),
    );
  });
}

function current(): ReturnType<typeof useCampaignSaveWorkflow> {
  if (!latest) throw new Error("Campaign workflow hook has not rendered.");
  return latest;
}

describe("campaign link-validator chunk failure", () => {
  it("fails closed, releases the lock for retry, and never persists or dispatches", async () => {
    renderWorkflow();

    await act(async () => {
      await expect(current().save()).resolves.toBe(false);
    });
    expect(current().saving).toBe(false);

    // A transient chunk failure does not strand the synchronous operation
    // lock. A deliberate retry runs validation again and still fails closed
    // while the mocked chunk remains unavailable.
    await act(async () => {
      await expect(current().save()).resolves.toBe(false);
      await current().sendTest();
    });

    expect(mocks.updateCampaign).not.toHaveBeenCalled();
    expect(mocks.sendCampaignTest).not.toHaveBeenCalled();
    expect(mocks.whoamiFresh).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledTimes(3);
    for (const [message] of mocks.toastError.mock.calls) {
      expect(message).toBe(CAMPAIGN_CONTENT_VALIDATION_UNAVAILABLE);
      expect(message).not.toContain("chunk unavailable");
    }
    expect(current().saving).toBe(false);
  });
});
