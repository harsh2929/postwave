// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// What the campaign editor's Save actually puts on the wire for the audience.
//
// Choosing "Entire audience" set segment_id to undefined, JSON.stringify
// dropped the key, PATCH read the missing key as "leave unchanged", and the
// server kept the old segment while the editor toasted "Campaign saved." —
// the picker then snapped back to the segment. This drives the real save
// workflow and the real campaigns transport against a stubbed fetch, and
// reads the request body that left the client.
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
  whoamiFresh: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: mocks.whoamiFresh,
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { useCampaignSaveWorkflow } from "../app/(dashboard)/app/campaigns/[id]/use-campaign-save-workflow";
import type { Campaign } from "@/lib/campaigns-api";
import type { MeResponse } from "@/lib/auth-api";

const IDENTITY: MeResponse = {
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
} as MeResponse;

const SAVED: Campaign = {
  id: "campaign-1",
  tenant_id: "tenant-1",
  name: "Launch",
  subject: "Hello",
  status: "draft",
  body_html: '<p>Hi <a href="{{ unsubscribe_url }}">unsubscribe</a></p>',
  delivery_settings: { from_email: "sender@example.test" },
  segment_id: "segment-1",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
};

let latest: ReturnType<typeof useCampaignSaveWorkflow> | null = null;
let root: Root | null = null;
let patches: Array<Record<string, unknown>> = [];

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoamiFresh.mockResolvedValue(IDENTITY);
  patches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
      const body = request
        ? await request.clone().text()
        : String(init?.body ?? "");
      if (method === "PATCH") {
        const sent = JSON.parse(body) as Record<string, unknown>;
        patches.push(sent);
        return new Response(
          JSON.stringify({
            ...SAVED,
            ...sent,
            updated_at: "2026-01-03T00:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  latest = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function Harness(props: Parameters<typeof useCampaignSaveWorkflow>[0]) {
  latest = useCampaignSaveWorkflow(props);
  return null;
}

async function saveDraft(draft: Campaign): Promise<boolean> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      createElement(Harness, {
        campaign: draft,
        campaignKey: ["campaign", draft.id],
        campaignsBaseKey: ["campaigns"],
        queryClient: new QueryClient(),
        setCampaign: vi.fn(),
        setDirty: vi.fn(),
        testEmail: "",
        canWrite: true,
        openedIdentity: IDENTITY,
      }),
    ),
  );
  let saved = false;
  await act(async () => {
    saved = (await latest?.save()) ?? false;
  });
  return saved;
}

describe("campaign audience on the wire", () => {
  it("clears a segment when the editor switches to everyone", async () => {
    const saved = await saveDraft({ ...SAVED, segment_id: undefined });

    expect(saved).toBe(true);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toHaveProperty("segment_id", "");
    expect(patches[0]).toHaveProperty("list_id", "");
  });

  it("moves a segment campaign onto a list in one request", async () => {
    const saved = await saveDraft({ ...SAVED, segment_id: "", list_id: "16" });

    expect(saved).toBe(true);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ list_id: "16", segment_id: "" });
  });

  it("repeats an unchanged segment so a save never drops the audience", async () => {
    await saveDraft(SAVED);

    expect(patches[0]).toMatchObject({ segment_id: "segment-1", list_id: "" });
  });
});
