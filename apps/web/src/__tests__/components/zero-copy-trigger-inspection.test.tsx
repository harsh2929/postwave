// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The inspect dialog's read-only operational tabs: Enqueue log, Alert config,
// and Recovery. Each tab is reachable from the drafts table, sends its GET
// with an abort signal, renders presence flags rather than values, refreshes
// on demand, and offers no poll / alert-edit / retry control.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AutomationApi from "@/lib/automation-configuration-api";
import type * as AuthApi from "@/lib/auth-api";
import { ApiError } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import type {
  ZeroCopyAlertConfig,
  ZeroCopyDLQEntry,
  ZeroCopyDraft,
  ZeroCopyFireRecord,
} from "@/lib/automation-configuration-api";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  listDrafts: vi.fn(),
  getDraft: vi.fn(),
  listFires: vi.fn(),
  getAlerts: vi.fn(),
  listDLQ: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthApi>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/automation-configuration-api", async (importOriginal) => ({
  ...(await importOriginal<typeof AutomationApi>()),
  listZeroCopyDrafts: mocks.listDrafts,
  getZeroCopyDraft: mocks.getDraft,
  listZeroCopyFires: mocks.listFires,
  getZeroCopyAlerts: mocks.getAlerts,
  listZeroCopyDLQ: mocks.listDLQ,
}));

import { ZeroCopyDraftsPanel } from "@/app/(dashboard)/app/flows/configuration/zero-copy-drafts-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const TRIGGER_ID = "00000000-0000-4000-8000-000000000002";
const roots: Root[] = [];

const me: MeResponse = {
  user_id: "automation-admin",
  tenant_id: TENANT_ID,
  email: "automation-admin@example.test",
  role: "admin",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Automation workspace",
  workspace_slug: "automation-workspace",
};

const runtime = {
  capability: "zero_copy_trigger_execution",
  runtimeStatus: "unavailable",
  executionEnabled: false,
  code: "zero_copy_runtime_unavailable",
  message: "Execution is release-held.",
  prerequisites: ["release_certification"],
};

const draft: ZeroCopyDraft = {
  id: TRIGGER_ID,
  name: "Warehouse draft",
  description: "Inert configuration",
  status: "draft",
  provider: "snowflake",
  query: "SELECT email, updated_at FROM audience",
  cursorColumn: "updated_at",
  profileKeyColumn: "email",
  pollingIntervalSeconds: 300,
  maxRowsPerTick: 500,
  config: {},
  createdAt: "2026-08-29T10:00:00Z",
  updatedAt: "2026-08-30T10:00:00Z",
  runtime,
};

const fires: ZeroCopyFireRecord[] = [
  {
    id: 41,
    triggerId: TRIGGER_ID,
    status: "queued",
    firedAt: "2026-09-01T10:00:00Z",
    hasCursor: true,
    hasProfileKey: true,
    hasSubscriber: true,
    hasPayload: false,
    hasFlowRun: false,
    errorCategory: "execution_error",
  },
];

const alerts: ZeroCopyAlertConfig = {
  triggerId: TRIGGER_ID,
  runtime,
  consecutiveFailuresThreshold: 5,
  lagSecondsThreshold: 900,
  firesPerTickThreshold: 0,
  webhookConfigured: true,
  cooldownSeconds: 1800,
  lastAlertKind: "fires_burst",
  hasLastAlertMessage: true,
};

const dlq: ZeroCopyDLQEntry[] = [
  {
    id: 7,
    triggerId: TRIGGER_ID,
    reason: "unresolved_subscriber",
    retryCount: 2,
    status: "pending",
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:05:00Z",
    hasCursor: true,
    hasProfileKey: true,
    hasPayload: true,
  },
];

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw last;
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
}

function buttonLabels(): string[] {
  return Array.from(document.querySelectorAll("button")).map(
    (candidate) => candidate.textContent?.trim() ?? "",
  );
}

async function click(label: string): Promise<void> {
  const target = button(label);
  if (!target) throw new Error(`Missing button: ${label}`);
  await act(async () => target.click());
}

async function renderPanel(canAdmin = true) {
  mocks.whoami.mockResolvedValue(me);
  mocks.whoamiFresh.mockResolvedValue(me);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, networkMode: "always", gcTime: 0 },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ZeroCopyDraftsPanel
          me={me}
          queryScope={["automation-configuration", TENANT_ID, "admin"]}
          canAdmin={canAdmin}
        />
      </QueryClientProvider>,
    );
  });
  return container;
}

async function openInspect(): Promise<void> {
  await eventually(() =>
    expect(
      document.querySelector('button[aria-label="Inspect Warehouse draft"]'),
    ).not.toBeNull(),
  );
  await act(async () =>
    (
      document.querySelector(
        'button[aria-label="Inspect Warehouse draft"]',
      ) as HTMLButtonElement
    ).click(),
  );
  await eventually(() =>
    expect(document.body.textContent).toContain(
      "SELECT email, updated_at FROM audience",
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listDrafts.mockResolvedValue({ items: [draft] });
  mocks.getDraft.mockResolvedValue(draft);
  mocks.listFires.mockResolvedValue(fires);
  mocks.getAlerts.mockResolvedValue(alerts);
  mocks.listDLQ.mockResolvedValue(dlq);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("trigger inspect dialog operational tabs", () => {
  it("does not request any operational record until its tab is opened", async () => {
    await renderPanel();
    await openInspect();
    expect(mocks.listFires).not.toHaveBeenCalled();
    expect(mocks.getAlerts).not.toHaveBeenCalled();
    expect(mocks.listDLQ).not.toHaveBeenCalled();
  });

  it("lists enqueue records as presence flags and refreshes on demand", async () => {
    await renderPanel();
    await openInspect();
    await click("Enqueue log");
    await eventually(() =>
      expect(mocks.listFires).toHaveBeenCalledWith(
        TRIGGER_ID,
        expect.any(AbortSignal),
      ),
    );
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "cursor, profile key, subscriber",
      ),
    );
    expect(document.body.textContent).toContain(
      "Execution error recorded · details hidden",
    );
    expect(document.body.textContent).toContain("queued");
    expect(
      document.querySelector('[aria-label="Trigger enqueue records"]'),
    ).not.toBeNull();

    await click("Refresh enqueue log");
    await eventually(() => expect(mocks.listFires).toHaveBeenCalledTimes(2));
    // The withheld operational verbs stay withheld.
    expect(buttonLabels()).not.toContain("Poll now");
  });

  it("inspects alert thresholds with editing withheld", async () => {
    await renderPanel();
    await openInspect();
    await click("Alert config");
    await eventually(() =>
      expect(mocks.getAlerts).toHaveBeenCalledWith(
        TRIGGER_ID,
        expect.any(AbortSignal),
      ),
    );
    await eventually(() =>
      expect(document.body.textContent).toContain("Configured (hidden)"),
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("15m");
    expect(text).toContain("30m");
    expect(text).toContain("Rows-per-poll burst");
    expect(text).toContain("Recorded (hidden)");
    expect(text).not.toContain("hooks.example");
    const saving = button("Saving unavailable");
    expect(saving?.disabled).toBe(true);
    expect(saving?.getAttribute("aria-describedby")).toBeTruthy();
    expect(buttonLabels()).not.toContain("Configure alerts");

    await click("Refresh alert config");
    await eventually(() => expect(mocks.getAlerts).toHaveBeenCalledTimes(2));
  });

  it("renders the server's own sentence when alerting is disabled on the deployment", async () => {
    mocks.getAlerts.mockRejectedValueOnce(
      new ApiError("alert repo not wired", 503, undefined, {
        code: "alerts_disabled",
      }),
    );
    await renderPanel();
    await openInspect();
    await click("Alert config");
    await eventually(() =>
      expect(document.body.textContent).toContain("alert repo not wired"),
    );
    expect(document.body.textContent).toContain(
      "Alert configuration is unavailable",
    );
    expect(button("Saving unavailable")).toBeUndefined();
  });

  it("lists recovery entries without a retry control", async () => {
    await renderPanel();
    await openInspect();
    await click("Recovery");
    await eventually(() =>
      expect(mocks.listDLQ).toHaveBeenCalledWith(
        TRIGGER_ID,
        expect.any(AbortSignal),
      ),
    );
    await eventually(() =>
      expect(document.body.textContent).toContain("Subscriber unresolved"),
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("#7");
    expect(text).toContain("cursor, profile key, payload");
    expect(text).toContain("pending");
    expect(
      buttonLabels().filter((label) => /retry/i.test(label)),
    ).toEqual([]);

    await click("Refresh recovery records");
    await eventually(() => expect(mocks.listDLQ).toHaveBeenCalledTimes(2));
  });

  it("requests nothing operational for a non-admin", async () => {
    const container = await renderPanel(false);
    await eventually(() =>
      expect(container.textContent).toContain(
        "Administrator access is required",
      ),
    );
    expect(mocks.listDrafts).not.toHaveBeenCalled();
    expect(mocks.listFires).not.toHaveBeenCalled();
    expect(mocks.getAlerts).not.toHaveBeenCalled();
    expect(mocks.listDLQ).not.toHaveBeenCalled();
  });
});
