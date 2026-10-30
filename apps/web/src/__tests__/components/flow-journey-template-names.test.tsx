// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// TMPL-C. The flow editor's "Preview journey" dialog read "Sends the email
// from template 8b7d95b5-9d6c-…" while the canvas node for the same step said
// "First-Sentence Welcome": the editor resolved template names for the canvas
// but never handed that resolver to the journey preview. These tests render
// the real editor, open the real dialog, and read what a person sees.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FlowEditor } from "@/app/(dashboard)/app/flows/_components/flow-editor";
import { flowsApi, type Flow } from "@/lib/flows-api";

const WELCOME_ID = "8b7d95b5-9d6c-4ff3-bc37-616ad388fe49";
const FOLLOW_UP_ID = "4e07c006-993d-46dd-83b3-1374b3a27430";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  listTemplates: vi.fn(),
  getCampaignTemplate: vi.fn(),
}));

const OWNER = {
  user_id: "user_1",
  tenant_id: "tenant_1",
  email: "owner@example.test",
  role: "owner" as const,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

const FLOW: Flow = {
  id: "flow_1",
  name: "Walkthrough check welcome flow",
  status: "draft",
  graph: {
    entry_id: "n1",
    nodes: [
      { id: "n1", type: "send_email", template_id: WELCOME_ID },
      { id: "n2", type: "send_email", template_id: FOLLOW_UP_ID },
    ],
    edges: [{ from: "n1", to: "n2" }],
    triggers: [{ type: "list_joined" }],
  },
} as unknown as Flow;

const CATALOG = {
  nodes: [
    {
      key: "send_email",
      label: "Send email",
      category: "message",
      runtime_status: "supported",
    },
  ],
  triggers: [{ key: "list_joined", label: "List joined", category: "trigger" }],
  actions: [],
  condition_fields: [],
} as unknown as Awaited<ReturnType<typeof flowsApi.catalog>>;

vi.mock("@/lib/flows-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/flows-api")>();
  return {
    ...actual,
    flowsApi: {
      ...actual.flowsApi,
      get: vi.fn(),
      catalog: vi.fn(),
      update: vi.fn(),
    },
  };
});

vi.mock("@/lib/campaign-templates-api", () => ({
  listTemplates: mocks.listTemplates,
  getCampaignTemplate: mocks.getCampaignTemplate,
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: mocks.whoami, whoamiFresh: mocks.whoamiFresh };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

beforeEach(() => {
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  vi.mocked(flowsApi.get).mockResolvedValue(FLOW);
  vi.mocked(flowsApi.catalog).mockResolvedValue(CATALOG);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function openJourneyPreview(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(FlowEditor, { flowId: "flow_1" }),
      ),
    );
  });
  await flush();
  const trigger = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Preview journey",
  );
  if (!trigger) throw new Error("Preview journey button not rendered");
  await act(async () => {
    trigger.click();
  });
  await flush(2);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("journey dialog did not open");
  return dialog;
}

describe("journey preview template names", () => {
  it("names each step's template, as the canvas does", async () => {
    mocks.listTemplates.mockResolvedValue([
      { id: WELCOME_ID, name: "First-Sentence Welcome" },
      { id: FOLLOW_UP_ID, name: "Negative Welcome" },
    ]);

    const dialog = await openJourneyPreview();

    const text = dialog.textContent ?? "";
    expect(text).toContain("Sends “First-Sentence Welcome”");
    expect(text).toContain("Sends “Negative Welcome”");
    expect(text).not.toContain(WELCOME_ID);
    expect(text).not.toContain(FOLLOW_UP_ID);
  });

  it("says a template could not be loaded instead of printing its id", async () => {
    // The library list does not carry the follow-up, and its own lookup
    // fails (deleted, or no longer visible to this workspace).
    mocks.listTemplates.mockResolvedValue([
      { id: WELCOME_ID, name: "First-Sentence Welcome" },
    ]);
    mocks.getCampaignTemplate.mockRejectedValue(new Error("not found"));

    const dialog = await openJourneyPreview();

    const text = dialog.textContent ?? "";
    expect(text).toContain("Sends “First-Sentence Welcome”");
    expect(text).toContain(
      "Sends an email from a template that couldn’t be loaded",
    );
    expect(text).not.toContain(FOLLOW_UP_ID);
    expect(mocks.getCampaignTemplate).toHaveBeenCalledWith(FOLLOW_UP_ID);
  });

  it("says a name is loading, not that it failed, until the lookups settle", async () => {
    // The follow-up is not in the library list, and its own lookup is still
    // in flight when the dialog opens.
    mocks.listTemplates.mockResolvedValue([
      { id: WELCOME_ID, name: "First-Sentence Welcome" },
    ]);
    let finish: (template: { id: string; name: string }) => void = () => {};
    mocks.getCampaignTemplate.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const dialog = await openJourneyPreview();
    expect(dialog.textContent).toContain(
      "Sends an email (loading the template name…)",
    );
    expect(dialog.textContent).not.toContain("couldn’t be loaded");

    await act(async () => {
      finish({ id: FOLLOW_UP_ID, name: "Negative Welcome" });
    });
    await flush(2);
    expect(dialog.textContent).toContain("Sends “Negative Welcome”");
    expect(dialog.textContent).not.toContain("loading the template name");
  });
});
