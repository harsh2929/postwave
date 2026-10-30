// @vitest-environment happy-dom
//
// Editing a flow while a save is in flight used to lose the edits silently.
// markSaved() re-serialized whatever was on the canvas WHEN THE RESPONSE
// ARRIVED, not what was actually sent, so the dirty flag cleared, the "Unsaved
// changes" indicator flipped to "Saved", and the beforeunload guard stopped
// arming — while the server still held the older graph.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FlowEditor } from "@/app/(dashboard)/app/flows/_components/flow-editor";
import { flowsApi, type Flow } from "@/lib/flows-api";

const authMocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

const OWNER_IDENTITY = {
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
  name: "Welcome",
  status: "draft",
  graph: {
    entry_id: "n1",
    nodes: [{ id: "n1", type: "send_email", template_id: "t1" }],
    edges: [],
    triggers: [{ type: "list_joined" }],
  },
} as unknown as Flow;

const FLOW_CATALOG = {
  nodes: [
    {
      key: "send_email",
      label: "Send email",
      category: "message",
      runtime_status: "supported",
    },
    {
      key: "wait",
      label: "Wait",
      category: "control",
      runtime_status: "supported",
    },
    {
      key: "exit",
      label: "Exit",
      category: "control",
      runtime_status: "supported",
    },
  ],
  triggers: [{ key: "list_joined", label: "List joined", category: "trigger" }],
  actions: [],
  condition_fields: [],
} as unknown as Awaited<ReturnType<typeof flowsApi.catalog>>;

// Held open so the test can edit the graph mid-flight, then resolve.
let releaseUpdate: ((flow: Flow) => void) | null = null;

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
  // Node captions resolve from ONE id+name list request; the per-id getter is
  // only the fallback for ids that list did not carry.
  listTemplates: vi.fn().mockResolvedValue([{ id: "t1", name: "Tpl" }]),
  getCampaignTemplate: vi.fn().mockResolvedValue({ id: "t1", name: "Tpl" }),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return {
    ...actual,
    whoami: authMocks.whoami,
    whoamiFresh: authMocks.whoamiFresh,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  authMocks.whoami.mockResolvedValue(OWNER_IDENTITY);
  authMocks.whoamiFresh.mockResolvedValue(OWNER_IDENTITY);
});

afterEach(() => {
  document.body.innerHTML = "";
  releaseUpdate = null;
  vi.clearAllMocks();
});

// Both the flow and the catalog query have to settle, then the seeding effect
// runs and re-renders. One microtask is not enough.
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function byText(re: RegExp): HTMLElement | undefined {
  return Array.from(document.querySelectorAll("span,button")).find((el) =>
    re.test(el.textContent ?? ""),
  ) as HTMLElement | undefined;
}

describe("flow editor save race", () => {
  it("can delete and undo a step after write authority arrives on a cold load", async () => {
    let resolveIdentity!: (value: typeof OWNER_IDENTITY) => void;
    authMocks.whoami.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveIdentity = resolve;
      }),
    );
    vi.mocked(flowsApi.get).mockResolvedValue(FLOW);
    vi.mocked(flowsApi.catalog).mockResolvedValue(FLOW_CATALOG);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    try {
      await act(async () =>
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(FlowEditor, { flowId: "flow_1" }),
          ),
        ),
      );
      await flush();
      expect(document.querySelector('[data-node-id="n1"]')).not.toBeNull();
      await act(async () => resolveIdentity(OWNER_IDENTITY));
      await flush();
      const node = document.querySelector<HTMLButtonElement>(
        '[data-node-id="n1"]',
      )!;
      await act(async () =>
        node.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
        ),
      );
      expect(document.querySelector('[data-node-id="n1"]')).toBeNull();
      expect(document.body.textContent).toContain("Unsaved changes");
      const undoButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Undo"]',
      )!;
      await act(async () => undoButton.click());
      expect(document.querySelector('[data-node-id="n1"]')).not.toBeNull();
      expect(document.body.textContent).toContain("All changes saved");
    } finally {
      await act(async () => root.unmount());
      client.clear();
    }
  });

  it("renders the editor read-only for a viewer without losing inspection", async () => {
    authMocks.whoami.mockResolvedValueOnce({
      ...OWNER_IDENTITY,
      role: "viewer",
      effective_role: "viewer",
    });
    vi.mocked(flowsApi.get).mockResolvedValue(FLOW);
    vi.mocked(flowsApi.catalog).mockResolvedValue(FLOW_CATALOG);

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(FlowEditor, { flowId: "flow_1" }),
        ),
      );
    });
    await flush();

    expect(document.body.textContent).toContain(
      "Flows are read-only for this session",
    );
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Flow name"]')
        ?.disabled,
    ).toBe(true);
    for (const label of ["Validate", "Save"]) {
      const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      expect(button?.disabled).toBe(true);
    }
    expect(
      document.querySelector<HTMLSelectElement>(
        'select[aria-label="Add trigger"]',
      )?.disabled,
    ).toBe(true);
    expect(document.querySelector("[data-connect-label]")).toBeNull();

    const node = document.querySelector<HTMLButtonElement>(
      '[data-node-id="n1"]',
    );
    expect(node).not.toBeNull();
    expect(authMocks.whoamiFresh).not.toHaveBeenCalled();
    expect(flowsApi.update).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("stays dirty when the graph is edited while a save is in flight", async () => {
    vi.mocked(flowsApi.get).mockResolvedValue(FLOW);
    vi.mocked(flowsApi.catalog).mockResolvedValue(FLOW_CATALOG);
    vi.mocked(flowsApi.update).mockImplementation(
      () =>
        new Promise<Flow>((resolve) => {
          releaseUpdate = resolve;
        }),
    );

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(FlowEditor, { flowId: "flow_1" }),
        ),
      );
    });
    await flush();

    // Dirty the editor so Save is enabled: rename the flow.
    const nameInput = document.querySelector(
      'input[aria-label="Flow name"]',
    ) as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(nameInput, "Welcome v2");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(byText(/Unsaved changes/)).toBeTruthy();

    // Start the save. flowsApi.update is now pending.
    const saveButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Save",
    );
    expect(saveButton).toBeTruthy();
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush(2);
    expect(vi.mocked(flowsApi.update)).toHaveBeenCalledTimes(1);

    // The operator keeps typing while the request is in flight.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(nameInput, "Welcome v3 — edited mid-save");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // The server responds with what it actually received (v2).
    await act(async () => {
      releaseUpdate!({ ...FLOW, name: "Welcome v2" });
    });
    await flush(4);

    // The v3 edit was never sent, so the editor must still consider itself
    // dirty — otherwise the beforeunload guard disarms and v3 is lost.
    expect(byText(/Unsaved changes/)).toBeTruthy();
    expect(byText(/All changes saved|^Saved /)).toBeFalsy();

    await act(async () => {
      root.unmount();
    });
  });

  it("presents legacy-active publication as stored configuration, not live execution", async () => {
    vi.mocked(flowsApi.get).mockResolvedValue({
      ...FLOW,
      status: "active",
      latest_version: {
        id: "version_2",
        flow_id: FLOW.id,
        version: 2,
        status: "draft",
        graph: FLOW.graph,
        generated_by: "human",
        created_at: "2026-09-04T00:00:00Z",
      },
    });
    vi.mocked(flowsApi.catalog).mockResolvedValue(FLOW_CATALOG);

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(FlowEditor, { flowId: "flow_1" }),
        ),
      );
    });
    await flush();

    expect(document.body.textContent).toContain("Draft changes · unpublished");
    expect(document.body.textContent).toContain("Activation unavailable");
    expect(
      document.querySelector(
        '[title="Promote the saved draft to published configuration"]',
      ),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Mark configuration paused");
    expect(
      document.querySelector(
        '[title="Changes only the stored status; no execution is running"]',
      ),
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain("Flow paused");
    expect(document.body.textContent).not.toContain("Live · published");
    expect(document.body.textContent).not.toContain("running journey");

    const nameInput = document.querySelector(
      'input[aria-label="Flow name"]',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(nameInput, "Stored configuration edit");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("legacy active status");
    expect(document.body.textContent).toContain(
      "Enrollment, scheduling, and delivery remain release-held",
    );

    await act(async () => {
      root.unmount();
    });
  });
});
