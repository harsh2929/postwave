// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// governance-58 / governance-62 reachability: the recovery console mounts the
// circuit legend beside the "Current sink state" facts for every sink, and
// the JWKS-URL copy control inside the signing-key section only for a
// Standard Webhooks HTTP sink. Assertions are consequences: the history the
// legend synthesizes from the sink row the console loaded, and the exact URL
// written to the clipboard (with no fetch of the key material).
import { act, createElement } from "react";
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
  whoami: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/audit-operations-api", () => ({
  getAuditAuthority: mocks.authority,
  listRecoverySinks: mocks.sinks,
  listAuditSinkDLQ: mocks.dlq,
  listAuditSinkReplayJobs: mocks.jobs,
  listAuditSinkSigningKeys: mocks.keys,
  cancelAuditSinkReplayJob: vi.fn(),
  createAuditSinkReplayJob: vi.fn(),
  replayAuditSinkDLQBulk: vi.fn(),
  replayAuditSinkDLQEntry: vi.fn(),
  resetAuditSinkCircuit: vi.fn(),
  rotateAuditSinkSigningKey: vi.fn(),
  setRecoverySinkEnabled: vi.fn(),
  testExistingAuditSink: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { AuditSinkRecoveryPanel } from "@/components/settings/audit-sink-recovery-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FULL_AUTHORITY = {
  scopes: ["audit:read", "audit:configure_sinks", "audit:execute_actions"],
  auditScopes: ["audit:read", "audit:configure_sinks", "audit:execute_actions"],
  isAdmin: true,
};

const WEBHOOK_SINK = {
  id: "snk 42",
  kind: "http",
  name: "SIEM webhook",
  enabled: true,
  outputFormat: "postwave_native",
  webhookFormat: "standard_webhooks",
  consecutiveFailures: 3,
  autoDisableAfter: 5,
  circuitState: "open",
  cooldownUntil: "2026-09-12T10:00:00Z",
  lastSuccessAt: "2026-09-11T09:00:00Z",
  lastFailureAt: "2026-09-12T09:00:00Z",
  hasLastError: true,
};

const HTTP_V1_SINK = {
  ...WEBHOOK_SINK,
  id: "sink-http-v1",
  name: "Legacy webhook",
  webhookFormat: "postwave_v1",
};

const S3_SINK = {
  id: "sink-s3",
  kind: "s3",
  name: "Archive",
  enabled: true,
  outputFormat: "postwave_native",
  webhookFormat: "postwave_v1",
  consecutiveFailures: 0,
  autoDisableAfter: 10,
  circuitState: "closed",
  hasLastError: false,
};

let root: Root | null = null;

function render(): void {
  const container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  act(() => {
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AuditSinkRecoveryPanel, {
          tenantId: "tenant-1",
          userId: "user-1",
          role: "owner",
          identityReady: true,
        }),
      ),
    );
  });
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
      candidate.textContent?.replace(/\s+/g, " ").trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function section(labelledBy: string): HTMLElement {
  const match = document.querySelector<HTMLElement>(
    `section[aria-labelledby="${labelledBy}"]`,
  );
  if (!match) throw new Error(`Section not found: ${labelledBy}`);
  return match;
}

async function loadConsole(): Promise<void> {
  render();
  await act(async () => button("Load recovery console").click());
  await waitFor(() => {
    expect(document.body.textContent).toContain("Current sink state");
    expect(document.querySelector("#audit-recovery-sink")).toBeTruthy();
  });
}

beforeEach(() => {
  setOnlineStatusForTest("online");
  mocks.authority.mockResolvedValue(FULL_AUTHORITY);
  mocks.dlq.mockResolvedValue([]);
  mocks.jobs.mockResolvedValue({ jobs: [] });
  mocks.keys.mockResolvedValue([]);
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: vi.fn(async (_text: string) => undefined) },
    configurable: true,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  setOnlineStatusForTest("connecting");
  vi.clearAllMocks();
  Reflect.deleteProperty(window.navigator, "clipboard");
  document.body.innerHTML = "";
});

describe("AuditSinkRecoveryPanel mounts (governance-58 / governance-62)", () => {
  it("mounts the circuit legend after the sink facts and synthesizes history from the loaded sink row", async () => {
    mocks.sinks.mockResolvedValue([WEBHOOK_SINK]);
    await loadConsole();

    const current = section("sink-recovery-current");
    const facts = current.querySelector("dl");
    const legend = current.querySelector<HTMLElement>(
      '[data-testid="sink-circuit-legend"]',
    );
    expect(facts).toBeTruthy();
    expect(legend).toBeTruthy();
    // The legend sits directly after the Facts <dl>.
    expect(facts!.nextElementSibling).toBe(legend);

    await act(async () => button("Show circuit legend & history").click());
    const entries = Array.from(
      legend!.querySelectorAll('[data-testid="sink-circuit-history"] li'),
    ).map((entry) => entry.textContent?.replace(/\s+/g, " ").trim());
    expect(entries[0]).toContain(
      "Last failed delivery · 3 of 5 consecutive failures",
    );
    expect(entries[2]).toContain("Current state: open · cooldown ends");
    expect(entries[3]).toBe("Auto-disables after 5 consecutive failures.");
  });

  it("mounts Copy JWKS URL in the signing-key section for a Standard Webhooks sink and copies the sink's URL without fetching it", async () => {
    mocks.sinks.mockResolvedValue([WEBHOOK_SINK]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await loadConsole();
      await flush();

      const keys = section("sink-signing-keys");
      const copy = [...keys.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === "Copy JWKS URL",
      );
      expect(copy).toBeTruthy();
      expect(copy!.disabled).toBe(false);
      const expected = `${window.location.origin}/api/v1/audit-sinks/snk%2042/.well-known/jwks.json`;
      expect(keys.querySelector("code")?.textContent).toBe(expected);

      await act(async () => copy!.click());
      await flush();
      const writeText = window.navigator.clipboard.writeText as ReturnType<
        typeof vi.fn
      >;
      expect(writeText.mock.calls).toEqual([[expected]]);
      expect(mocks.toastSuccess).toHaveBeenCalledWith("JWKS URL copied.");
      expect(fetchSpy).not.toHaveBeenCalled();
      // The key-history read is the panel's own; the copy control adds none.
      expect(mocks.keys).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["an S3 sink", S3_SINK],
    ["an HTTP sink on the Moosewave v1 envelope", HTTP_V1_SINK],
  ])(
    "offers no JWKS control for %s, while the legend still mounts",
    async (_label, sink) => {
      mocks.sinks.mockResolvedValue([sink]);
      await loadConsole();

      expect(
        document.querySelector('section[aria-labelledby="sink-signing-keys"]'),
      ).toBeNull();
      expect(document.body.textContent).not.toContain("Copy JWKS URL");
      expect(mocks.keys).not.toHaveBeenCalled();
      expect(
        section("sink-recovery-current").querySelector(
          '[data-testid="sink-circuit-legend"]',
        ),
      ).toBeTruthy();
    },
  );
});
