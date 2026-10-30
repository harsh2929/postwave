// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudienceDestinationsManager } from "@/app/(dashboard)/app/audience-destinations/audience-destinations-manager";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  list: vi.fn(),
  sync: vi.fn(),
  jobs: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("@/lib/use-online", () => ({ useOnline: () => "online" }));
vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));
vi.mock("@/lib/audience-destinations-api", () => ({
  listAudienceDestinations: mocks.list,
  syncAudienceDestination: mocks.sync,
  listAudienceDestinationJobs: mocks.jobs,
  previewAudienceDestination: mocks.preview,
  createAudienceDestination: vi.fn(),
  updateAudienceDestination: vi.fn(),
  disconnectAudienceDestination: vi.fn(),
  testAudienceDestinationReadiness: vi.fn(),
  getAudienceDestinationJobDiagnostics: vi.fn(),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DESTINATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LIST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const JOB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = "2026-08-29T12:00:00Z";

const me = {
  user_id: USER,
  tenant_id: TENANT,
  email: "admin@example.com",
  role: "admin" as const,
  effective_role: "admin" as const,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

const destination = {
  id: DESTINATION,
  tenant_id: TENANT,
  provider: "meta" as const,
  list_id: LIST,
  status: "active" as const,
  config: {},
  credential_reference_set: true,
  created_at: NOW,
  updated_at: NOW,
};

function render(): { root: Root; client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AudienceDestinationsManager, {
          me,
          providers: {
            providers: ["meta"],
            capabilities: {
              meta: { configured: true, diagnostics: false },
            },
          },
        }),
      ),
    );
  });
  return { root, client };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(label),
  );
}

beforeEach(() => {
  mocks.whoami.mockResolvedValue(me);
  mocks.list.mockResolvedValue([destination]);
  mocks.jobs.mockResolvedValue([]);
  mocks.preview.mockResolvedValue({
    destination_id: DESTINATION,
    provider: "meta",
    total_members: 100,
    excluded_count: 5,
    deliverable: 95,
    truncated: false,
    firewall_active: true,
  });
  mocks.sync.mockResolvedValue({
    status: "succeeded",
    replayed: false,
    destination,
    job: {
      id: JOB,
      tenant_id: TENANT,
      destination_id: DESTINATION,
      started_at: NOW,
      finished_at: NOW,
      status: "succeeded",
      members_synced: 95,
      trigger_kind: "manual",
      source_members_observed: 100,
      cap_exceeded: false,
      created_at: NOW,
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("audience destination management", () => {
  it("defers history and outbound sync, confirms the send, and reauthorizes", async () => {
    const { root } = render();
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Meta");
      });
      expect(mocks.jobs).not.toHaveBeenCalled();
      expect(mocks.preview).not.toHaveBeenCalled();
      expect(mocks.sync).not.toHaveBeenCalled();

      await act(async () => button("History")?.click());
      await waitFor(() => {
        expect(mocks.jobs).toHaveBeenCalled();
        expect(mocks.preview).toHaveBeenCalled();
        expect(document.body.textContent).toContain("95");
        expect(document.body.textContent).toContain("Verified empty history");
      });
      await act(async () => button("Close")?.click());

      await act(async () => button("Sync now")?.click());
      expect(mocks.sync).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(document.body.textContent).toContain("Send this audience now?");
      });
      await act(async () => button("Sync audience")?.click());
      await waitFor(() => {
        expect(mocks.sync).toHaveBeenCalledWith(
          expect.objectContaining({
            current: destination,
            signal: expect.any(AbortSignal),
          }),
        );
      });
      expect(mocks.whoami).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });
});
