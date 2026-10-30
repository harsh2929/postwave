// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VersionHistory } from "@/app/(dashboard)/app/flows/_components/version-history";
import { flowsApi, type FlowGraph } from "@/lib/flows-api";

const authMocks = vi.hoisted(() => ({
  me: {
    user_id: "user_1",
    tenant_id: "tenant_1",
    email: "owner@example.test",
    role: "owner" as const,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Workspace",
    workspace_slug: "workspace",
  },
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: authMocks.whoamiFresh,
}));

vi.mock("@/lib/flows-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/flows-api")>();
  return {
    ...actual,
    flowsApi: {
      ...actual.flowsApi,
      listVersions: vi.fn().mockResolvedValue({ items: [] }),
      createVersion: vi.fn().mockResolvedValue({ id: "version_1" }),
      promoteVersion: vi.fn(),
    },
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

authMocks.whoamiFresh.mockResolvedValue(authMocks.me);

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

describe("flow version history", () => {
  it("preserves history reads but disables snapshot and restore authority", async () => {
    const graph: FlowGraph = { nodes: [], edges: [], triggers: [] };
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
          createElement(VersionHistory, {
            flowId: "flow_read_only",
            currentGraph: graph,
            hasUnsavedEdits: false,
            identity: { ...authMocks.me, role: "viewer" },
            canWrite: false,
            onClose: () => undefined,
            onFlowReplaced: () => undefined,
          }),
        ),
      );
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "Version history remains available to inspect",
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Snapshot label"]',
    );
    const snapshot = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Snapshot current"),
    );
    expect(input?.disabled).toBe(true);
    expect(snapshot?.disabled).toBe(true);
    await act(async () => snapshot?.click());
    expect(authMocks.whoamiFresh).not.toHaveBeenCalled();
    expect(flowsApi.createVersion).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("snapshots the unsaved graph currently on the canvas", async () => {
    const graph: FlowGraph = {
      entry_id: "new_step",
      nodes: [{ id: "new_step", type: "send_email", template_id: "tpl_new" }],
      edges: [],
      triggers: [{ type: "list_joined", list_id: "list_new" }],
    };
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
          createElement(VersionHistory, {
            flowId: "flow_1",
            currentGraph: graph,
            hasUnsavedEdits: false,
            identity: authMocks.me,
            canWrite: true,
            onClose: () => undefined,
            onFlowReplaced: () => undefined,
          }),
        ),
      );
      await Promise.resolve();
    });
    const snapshot = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Snapshot current"),
    );
    await act(async () => {
      snapshot?.click();
      await Promise.resolve();
    });
    expect(vi.mocked(flowsApi.createVersion)).toHaveBeenCalledWith("flow_1", {
      generated_by: "human",
      graph,
    });
    act(() => root.unmount());
  });

  it("distinguishes a failed history request from an empty history and retries", async () => {
    vi.mocked(flowsApi.listVersions).mockRejectedValueOnce(
      new Error("versions unavailable"),
    );
    const graph: FlowGraph = {
      entry_id: undefined,
      nodes: [],
      edges: [],
      triggers: [],
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(VersionHistory, {
            flowId: "flow_error",
            currentGraph: graph,
            hasUnsavedEdits: false,
            identity: authMocks.me,
            canWrite: true,
            onClose: () => undefined,
            onFlowReplaced: () => undefined,
          }),
        ),
      );
    });

    try {
      await waitFor(() => {
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Could not load version history",
        );
      });
      expect(document.body.textContent).not.toContain("No versions yet");

      const retry = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry",
      );
      await act(async () => {
        retry?.click();
      });
      await waitFor(() => {
        expect(document.body.textContent).toContain("No versions yet");
      });
      expect(flowsApi.listVersions).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });
});
