// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";

const mocks = vi.hoisted(() => ({
  authority: vi.fn(),
  sinks: vi.fn(),
  dlq: vi.fn(),
  jobs: vi.fn(),
  keys: vi.fn(),
  rules: vi.fn(),
  fires: vi.fn(),
  incidents: vi.fn(),
  stats: vi.fn(),
  checkpoint: vi.fn(),
  manifests: vi.fn(),
  exportJobs: vi.fn(),
  proof: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/audit-operations-api", () => ({
  getAuditAuthority: mocks.authority,
  listRecoverySinks: mocks.sinks,
  listAuditSinkDLQ: mocks.dlq,
  listAuditSinkReplayJobs: mocks.jobs,
  listAuditSinkSigningKeys: mocks.keys,
  listAuditAlertRules: mocks.rules,
  listAuditAlertFires: mocks.fires,
  listAuditAlertIncidents: mocks.incidents,
  getAuditStats: mocks.stats,
  getLatestAuditCheckpoint: mocks.checkpoint,
  listAuditExportManifests: mocks.manifests,
  listAuditExportJobs: mocks.exportJobs,
  createAuditExportJob: vi.fn(),
  auditExportJobDownloadPath: (id: string) =>
    `/api/v1/audit/export-jobs/${id}/download`,
  getAuditInclusionProof: mocks.proof,
  cancelAuditSinkReplayJob: vi.fn(),
  createAuditSinkReplayJob: vi.fn(),
  replayAuditSinkDLQBulk: vi.fn(),
  replayAuditSinkDLQEntry: vi.fn(),
  resetAuditSinkCircuit: vi.fn(),
  rotateAuditSinkSigningKey: vi.fn(),
  setRecoverySinkEnabled: vi.fn(),
  testExistingAuditSink: vi.fn(),
  createAuditAlertRule: vi.fn(),
  deleteAuditAlertRule: vi.fn(),
  patchAuditAlertRule: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

import { AuditAlertRulesPanel } from "@/components/settings/audit-alert-rules-panel";
import { AuditForensicsPanel } from "@/components/settings/audit-forensics-panel";
import { AuditSinkRecoveryPanel } from "@/components/settings/audit-sink-recovery-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return root;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

beforeEach(() => {
  // Manual "load more" is refused unless the app is known to be online.
  setOnlineStatusForTest("online");
});

afterEach(() => {
  setOnlineStatusForTest("connecting");
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("audit operations panels", () => {
  it("loads recovery inventory only on request and distinguishes verified empty state", async () => {
    mocks.authority.mockResolvedValue({
      scopes: ["audit:read", "audit:configure_sinks", "audit:execute_actions"],
      auditScopes: [
        "audit:read",
        "audit:configure_sinks",
        "audit:execute_actions",
      ],
      isAdmin: true,
    });
    mocks.sinks.mockResolvedValue([]);
    mocks.dlq.mockResolvedValue([]);
    const root = render(
      createElement(AuditSinkRecoveryPanel, {
        tenantId: "tenant-1",
        userId: "user-1",
        role: "owner",
        identityReady: true,
      }),
    );
    try {
      expect(mocks.authority).not.toHaveBeenCalled();
      await act(async () => button("Load recovery console").click());
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Verified empty: this workspace has no audit sinks",
        );
        expect(document.body.textContent).toContain(
          "Verified empty: the server reports no pending dead-letter entries",
        );
      });
      expect(mocks.authority).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("paginates replay jobs with the server cursor", async () => {
    mocks.authority.mockResolvedValue({
      scopes: ["audit:read", "audit:configure_sinks", "audit:execute_actions"],
      auditScopes: [
        "audit:read",
        "audit:configure_sinks",
        "audit:execute_actions",
      ],
      isAdmin: true,
    });
    mocks.sinks.mockResolvedValue([
      {
        id: "sink-1",
        kind: "s3",
        name: "Archive",
        enabled: true,
        outputFormat: "postwave_native",
        webhookFormat: "postwave_v1",
        consecutiveFailures: 0,
        autoDisableAfter: 10,
        circuitState: "closed",
        hasLastError: false,
      },
    ]);
    mocks.dlq.mockResolvedValue([]);
    mocks.jobs.mockImplementation(
      (_tenantId: string, _sinkId: string, options: { cursor?: string }) =>
        Promise.resolve(
          options.cursor
            ? {
                jobs: [
                  {
                    id: "job-2",
                    tenantId: "tenant-1",
                    sinkId: "sink-1",
                    fromAuditId: 30,
                    toAuditId: 40,
                    status: "completed",
                    rowsSent: 11,
                    rowsFailed: 0,
                    createdAt: "2026-08-29T10:01:00Z",
                    hasLastError: false,
                  },
                ],
              }
            : {
                jobs: [
                  {
                    id: "job-1",
                    tenantId: "tenant-1",
                    sinkId: "sink-1",
                    fromAuditId: 10,
                    toAuditId: 20,
                    status: "completed",
                    rowsSent: 11,
                    rowsFailed: 0,
                    createdAt: "2026-08-29T10:00:00Z",
                    hasLastError: false,
                  },
                ],
                nextCursor: "cursor-1",
              },
        ),
    );
    const root = render(
      createElement(AuditSinkRecoveryPanel, {
        tenantId: "tenant-1",
        userId: "user-1",
        role: "owner",
        identityReady: true,
      }),
    );
    try {
      await act(async () => button("Load recovery console").click());
      await waitFor(() => {
        expect(document.body.textContent).toContain("10–20");
        expect(button("Load more replay jobs").disabled).toBe(false);
      });
      await act(async () => button("Load more replay jobs").click());
      await waitFor(() => {
        expect(document.body.textContent).toContain("30–40");
      });
      expect(mocks.jobs).toHaveBeenCalledWith(
        "tenant-1",
        "sink-1",
        expect.objectContaining({ cursor: "cursor-1", limit: 25 }),
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows read-only audit-alert inventory without mutation controls", async () => {
    mocks.authority.mockResolvedValue({
      scopes: ["audit:read"],
      auditScopes: ["audit:read"],
      isAdmin: false,
    });
    mocks.rules.mockResolvedValue([
      {
        id: "rule-read-only",
        name: "Privilege escalation review",
        enabled: true,
        actionGlob: "role.*",
        operatorKind: "glob",
        channelKind: "email",
        notifySlack: false,
        firedCount: 0,
        createdAt: "2026-08-30T00:00:00Z",
        hasDeliveryError: false,
      },
    ]);
    const root = render(
      createElement(AuditAlertRulesPanel, {
        tenantId: "tenant-1",
        userId: "user-1",
        role: "viewer",
        identityReady: true,
      }),
    );
    try {
      await act(async () => button("Load alert rules").click());
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Privilege escalation review",
        );
        expect(document.body.textContent).toContain("Rule changes are held");
      });
      const labels = Array.from(
        document.querySelectorAll("button"),
        (candidate) => candidate.textContent?.trim(),
      );
      expect(labels).toContain("Refresh rules");
      expect(labels).toContain("View evidence");
      expect(labels).not.toContain("New alert rule");
      expect(labels).not.toContain("Pause");
      expect(labels).not.toContain("Slack on");
      expect(labels).not.toContain("Delete");
    } finally {
      act(() => root.unmount());
    }
  });

  it("fails forensic aggregation closed when audit:read_pii is absent", async () => {
    mocks.whoami.mockResolvedValue({
      user_id: "user-1",
      tenant_id: "tenant-1",
      email: "viewer@example.test",
      role: "viewer",
      effective_role: "viewer",
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Workspace",
      workspace_slug: "workspace",
    });
    mocks.authority.mockResolvedValue({
      scopes: ["audit:read"],
      auditScopes: ["audit:read"],
      isAdmin: false,
    });
    const root = render(createElement(AuditForensicsPanel, { filters: {} }));
    try {
      await act(async () => button("Load forensics").click());
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Raw audit forensics are held",
        );
      });
      expect(mocks.stats).not.toHaveBeenCalled();
      expect(mocks.manifests).not.toHaveBeenCalled();
      expect(mocks.checkpoint).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("holds async export when the mounted contract cannot preserve an until bound", async () => {
    mocks.whoami.mockResolvedValue({
      user_id: "user-1",
      tenant_id: "tenant-1",
      email: "owner@example.test",
      role: "owner",
      effective_role: "owner",
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Workspace",
      workspace_slug: "workspace",
    });
    mocks.authority.mockResolvedValue({
      scopes: ["audit:read", "audit:read_pii", "audit:execute_actions"],
      auditScopes: ["audit:read", "audit:read_pii", "audit:execute_actions"],
      isAdmin: false,
    });
    mocks.stats.mockResolvedValue({
      totalEvents: 0,
      byActorType: [],
      topActions: [],
      daily: [],
    });
    mocks.manifests.mockResolvedValue([]);
    mocks.exportJobs.mockResolvedValue([]);
    const root = render(
      createElement(AuditForensicsPanel, {
        filters: { until: "2026-08-29T12:00:00Z" },
      }),
    );
    try {
      await act(async () => button("Load forensics").click());
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "End-bounded background export is unavailable",
        );
      });
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (candidate) =>
            candidate.textContent?.trim() === "Review background export",
        ),
      ).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });
});
