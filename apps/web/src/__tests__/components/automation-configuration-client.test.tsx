// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AutomationApi from "@/lib/automation-configuration-api";
import type * as AuthApi from "@/lib/auth-api";
import { ApiError } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import type {
  ZeroCopyDraft,
  ZeroCopyDraftInput,
} from "@/lib/automation-configuration-api";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  listDrafts: vi.fn(),
  getDraft: vi.fn(),
  validateDraft: vi.fn(),
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  deleteDraft: vi.fn(),
  getDelay: vi.fn(),
  putDelay: vi.fn(),
  uuid: vi.fn(),
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
  validateZeroCopyDraft: mocks.validateDraft,
  createZeroCopyDraft: mocks.createDraft,
  updateZeroCopyDraft: mocks.updateDraft,
  deleteZeroCopyDraft: mocks.deleteDraft,
  getTriggerDelayPreference: mocks.getDelay,
  putTriggerDelayPreference: mocks.putDelay,
}));

import { AutomationConfigurationClient } from "@/app/(dashboard)/app/flows/configuration/automation-configuration-client";
import { assertFreshAutomationAdmin } from "@/app/(dashboard)/app/flows/configuration/automation-configuration-authority";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const TRIGGER_ID = "00000000-0000-4000-8000-000000000002";
const SUBSCRIBER_ID = "00000000-0000-4000-8000-000000000003";
const OPERATION_ID = "00000000-0000-4000-8000-000000000004";
const roots: Root[] = [];

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
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
    ...overrides,
  };
}

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

function draftReceipt(value: ZeroCopyDraftInput): ZeroCopyDraft {
  return {
    ...draft,
    name: value.name,
    description: value.description ?? "",
    status: value.status,
    provider: value.provider,
    query: value.query,
    cursorColumn: value.cursor_column,
    profileKeyColumn: value.profile_key_column,
    pollingIntervalSeconds: value.polling_interval_seconds,
    maxRowsPerTick: value.max_rows_per_tick,
    config: value.config,
    ...(value.connection_id ? { connectionId: value.connection_id } : {}),
    ...(value.journey_id ? { journeyId: value.journey_id } : {}),
  };
}

/**
 * Retries until the assertion holds or a real-time deadline passes. The drafts
 * panel is a lazily imported chunk (`next/dynamic`); a budget counted in
 * zero-delay ticks is a few milliseconds of wall time and flakes whenever the
 * machine is loaded, so the wait is bounded by elapsed time instead.
 */
async function eventually(
  assertion: () => void,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    }
  }
  assertion();
  throw last;
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
}

function input(labelText: string): HTMLInputElement | HTMLTextAreaElement {
  const label = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim().startsWith(labelText),
  );
  const control = label?.htmlFor
    ? document.getElementById(label.htmlFor)
    : undefined;
  if (
    !(
      control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement
    )
  )
    throw new Error(`Missing input for ${labelText}`);
  return control;
}

function setValue(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    control,
    value,
  );
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

async function renderClient(identity = me()) {
  mocks.whoami.mockResolvedValue(identity);
  mocks.whoamiFresh.mockResolvedValue(identity);
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
        <AutomationConfigurationClient />
      </QueryClientProvider>,
    );
  });
  return { container, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listDrafts.mockResolvedValue({ items: [draft] });
  mocks.getDraft.mockResolvedValue(draft);
  mocks.validateDraft.mockResolvedValue({
    valid: true,
    errors: [],
    warnings: ["Configuration validation only."],
    runtime,
  });
  mocks.createDraft.mockImplementation(
    ({ value }: { value: ZeroCopyDraftInput }) =>
      Promise.resolve(draftReceipt(value)),
  );
  mocks.getDelay.mockResolvedValue(null);
  mocks.putDelay.mockResolvedValue({
    kind: "manual",
    subscriberId: SUBSCRIBER_ID,
    eventName: "order.created",
    optimalDelaySeconds: 900,
    reason: "Operator review",
    computedAt: "2026-08-30T11:00:00Z",
    updatedAt: "2026-08-30T11:00:00Z",
  });
  mocks.uuid.mockReturnValue(OPERATION_ID);
  vi.stubGlobal("crypto", { randomUUID: mocks.uuid });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("automation configuration client", () => {
  it("rejects identity, tenant, role, and viewer drift before admin writes", () => {
    const opened = me();
    for (const changed of [
      me({ user_id: "different" }),
      me({ tenant_id: "00000000-0000-4000-8000-000000000099" }),
      me({ role: "editor", effective_role: "editor" }),
      me({ viewer_mode: true, effective_role: "viewer" }),
    ]) {
      expect(() => assertFreshAutomationAdmin(opened, changed)).toThrow(
        /authority changed|administrator/i,
      );
    }
  });

  it("does not request or render warehouse definitions for a non-admin", async () => {
    const { container } = await renderClient(
      me({ role: "viewer", effective_role: "viewer" }),
    );
    await eventually(() =>
      expect(container.textContent).toContain(
        "Administrator access is required",
      ),
    );
    expect(mocks.listDrafts).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Draft-only operational boundary");
  });

  it("renders only draft controls and lazily inspects a fresh definition", async () => {
    const { container } = await renderClient();
    await eventually(() =>
      expect(
        container.querySelector('button[aria-label="Inspect Warehouse draft"]'),
      ).not.toBeNull(),
    );
    const labels = Array.from(container.querySelectorAll("button")).map(
      (candidate) => candidate.textContent?.trim(),
    );
    expect(labels).not.toContain("Activate");
    expect(labels).not.toContain("Poll now");
    expect(labels).not.toContain("Configure alerts");
    expect(labels).not.toContain("Retry DLQ");
    expect(container.textContent).toContain(
      "Activation, polling, alert editing, and DLQ retry",
    );

    const inspect = container.querySelector(
      'button[aria-label="Inspect Warehouse draft"]',
    ) as HTMLButtonElement;
    await act(async () => inspect.click());
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "SELECT email, updated_at FROM audience",
      ),
    );
    expect(mocks.getDraft).toHaveBeenCalledWith(
      TENANT_ID,
      TRIGGER_ID,
      expect.any(AbortSignal),
    );
    expect(document.body.textContent).not.toContain("private-cursor");
  });

  it("requires current server validation before creating an inert draft", async () => {
    await renderClient();
    await eventually(() => expect(button("New trigger draft")).toBeDefined());
    await act(async () => button("New trigger draft")!.click());
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "New warehouse trigger draft",
      ),
    );
    await act(async () => {
      setValue(input("Name"), "New inert draft");
      setValue(
        input("Read-only SELECT"),
        "SELECT email, updated_at FROM audience",
      );
    });
    expect(button("Save inert draft")?.disabled).toBe(true);
    await act(async () => button("Validate draft")!.click());
    await eventually(() =>
      expect(button("Save inert draft")?.disabled).toBe(false),
    );
    const save = button("Save inert draft")!;
    await act(async () => {
      save.click();
      save.click();
    });
    await eventually(() => expect(mocks.createDraft).toHaveBeenCalledTimes(1));
    expect(mocks.validateDraft).toHaveBeenCalledTimes(2);
    const createCall = mocks.createDraft.mock.calls[0]?.[0];
    expect(createCall.value.status).toBe("draft");
    expect(createCall).not.toHaveProperty("active");
    expect(createCall.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
  });

  it("retains one create operation identity across an uncertain retry", async () => {
    mocks.createDraft.mockRejectedValueOnce(new Error("Response was lost"));
    await renderClient();
    await eventually(() => expect(button("New trigger draft")).toBeDefined());
    await act(async () => button("New trigger draft")!.click());
    await act(async () => {
      setValue(input("Name"), "Retry-safe inert draft");
      setValue(
        input("Read-only SELECT"),
        "SELECT email, updated_at FROM audience",
      );
      button("Validate draft")!.click();
    });
    await eventually(() =>
      expect(button("Save inert draft")?.disabled).toBe(false),
    );
    await act(async () => button("Save inert draft")!.click());
    await eventually(() => expect(mocks.createDraft).toHaveBeenCalledTimes(1));
    await act(async () => button("Save inert draft")!.click());
    await eventually(() => expect(mocks.createDraft).toHaveBeenCalledTimes(2));
    expect(mocks.createDraft.mock.calls[0]?.[0].idempotencyKey).toBe(
      mocks.createDraft.mock.calls[1]?.[0].idempotencyKey,
    );
    expect(mocks.uuid).toHaveBeenCalledTimes(1);
  });

  it("freezes every trigger field while a captured draft is being saved", async () => {
    let release: (() => void) | undefined;
    mocks.createDraft.mockImplementationOnce(
      ({ value }: { value: ZeroCopyDraftInput }) =>
        new Promise<ZeroCopyDraft>((resolve) => {
          release = () => resolve(draftReceipt(value));
        }),
    );
    await renderClient();
    await eventually(() => expect(button("New trigger draft")).toBeDefined());
    await act(async () => button("New trigger draft")!.click());
    await act(async () => {
      setValue(input("Name"), "Captured inert draft");
      setValue(
        input("Read-only SELECT"),
        "SELECT email, updated_at FROM audience",
      );
      button("Validate draft")!.click();
    });
    await eventually(() =>
      expect(button("Save inert draft")?.disabled).toBe(false),
    );
    await act(async () => button("Save inert draft")!.click());
    await eventually(() => expect(mocks.createDraft).toHaveBeenCalledTimes(1));
    expect(input("Name").closest("fieldset")?.disabled).toBe(true);
    expect(input("Read-only SELECT").closest("fieldset")?.disabled).toBe(true);
    expect(button("Validate draft")?.disabled).toBe(true);
    await act(async () => release?.());
  });

  it("requires explicit discard before closing an edited trigger draft", async () => {
    await renderClient();
    await eventually(() => expect(button("New trigger draft")).toBeDefined());
    await act(async () => button("New trigger draft")!.click());
    await act(async () => setValue(input("Name"), "Unsaved trigger"));
    await act(async () => button("Cancel")!.click());
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "Discard trigger draft changes?",
      ),
    );
    expect(document.body.textContent).toContain("Unsaved SQL");
    await act(async () => button("Discard trigger draft")!.click());
    await eventually(() =>
      expect(document.body.textContent).not.toContain(
        "New warehouse trigger draft",
      ),
    );
  });

  it("recovers an uncertain confirmed delete when fresh readback is absent", async () => {
    mocks.deleteDraft.mockRejectedValueOnce(new Error("Response was lost"));
    await renderClient();
    await eventually(() =>
      expect(
        document.querySelector('button[aria-label="Delete Warehouse draft"]'),
      ).not.toBeNull(),
    );
    await act(async () =>
      (
        document.querySelector(
          'button[aria-label="Delete Warehouse draft"]',
        ) as HTMLButtonElement
      ).click(),
    );
    await eventually(() =>
      expect(document.body.textContent).toContain("Delete trigger definition?"),
    );
    const tokenLabel = Array.from(document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.includes(draft.name),
    ) as HTMLLabelElement;
    const tokenInput = document.getElementById(
      tokenLabel.htmlFor,
    ) as HTMLInputElement;
    await act(async () => setValue(tokenInput, draft.name));
    await act(async () => button("Delete definition")!.click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Response was lost"),
    );
    mocks.getDraft.mockRejectedValueOnce(
      new ApiError("The trigger was not found.", 404),
    );
    await act(async () => button("Delete definition")!.click());
    await eventually(() =>
      expect(document.body.textContent).not.toContain(
        "Delete trigger definition?",
      ),
    );
    expect(mocks.getDraft).toHaveBeenCalledTimes(2);
    expect(mocks.deleteDraft).toHaveBeenCalledTimes(1);
    expect(mocks.uuid).toHaveBeenCalledTimes(1);
  });

  it("retains manual timing input while reviewing the other configuration tab", async () => {
    await renderClient();
    await eventually(() =>
      expect(button("Manual timing override")).toBeDefined(),
    );
    await act(async () => button("Manual timing override")!.click());
    await eventually(() =>
      expect(input("Subscriber UUID")).toBeInstanceOf(HTMLInputElement),
    );
    await act(async () => setValue(input("Subscriber UUID"), SUBSCRIBER_ID));
    await act(async () => button("Warehouse drafts")!.click());
    await act(async () => button("Manual timing override")!.click());
    expect(input("Subscriber UUID").value).toBe(SUBSCRIBER_ID);
  });

  it("rechecks the exact timing pair before an idempotent manual override", async () => {
    await renderClient();
    await eventually(() =>
      expect(button("Manual timing override")).toBeDefined(),
    );
    await act(async () => button("Manual timing override")!.click());
    await eventually(() => expect(button("Look up")).toBeDefined());
    await act(async () => {
      setValue(input("Subscriber UUID"), SUBSCRIBER_ID);
      setValue(input("Event name"), "order.created");
      button("Look up")!.click();
    });
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "No preference is stored for this verified pair",
      ),
    );
    await act(async () => {
      setValue(input("Delay seconds"), "900");
      setValue(input("Operator reason"), "Operator review");
      button("Save manual override")!.click();
    });
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "Type order.created to confirm",
      ),
    );
    const tokenLabel = Array.from(document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.includes("order.created"),
    ) as HTMLLabelElement;
    const tokenInput = document.getElementById(
      tokenLabel.htmlFor,
    ) as HTMLInputElement;
    await act(async () => setValue(tokenInput, "order.created"));
    await act(async () => button("Save override")!.click());
    await eventually(() => expect(mocks.putDelay).toHaveBeenCalledTimes(1));
    expect(mocks.getDelay).toHaveBeenCalledTimes(2);
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.putDelay.mock.calls[0]?.[0]).toMatchObject({
      subscriberId: SUBSCRIBER_ID,
      eventName: "order.created",
      optimalDelaySeconds: 900,
      reason: "Operator review",
    });
    expect(mocks.putDelay.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it("runs a fresh lookup when the submitted timing pair is unchanged", async () => {
    await renderClient();
    await eventually(() =>
      expect(button("Manual timing override")).toBeDefined(),
    );
    await act(async () => button("Manual timing override")!.click());
    await act(async () => {
      setValue(input("Subscriber UUID"), SUBSCRIBER_ID);
      setValue(input("Event name"), "order.created");
      button("Look up")!.click();
    });
    await eventually(() => expect(mocks.getDelay).toHaveBeenCalledTimes(1));
    await eventually(() => expect(button("Look up")).toBeDefined());
    await act(async () => button("Look up")!.click());
    await eventually(() => expect(mocks.getDelay).toHaveBeenCalledTimes(2));
    expect(mocks.getDelay).toHaveBeenNthCalledWith(2, {
      subscriberId: SUBSCRIBER_ID,
      eventName: "order.created",
      signal: expect.any(AbortSignal),
    });
  });

  it("blocks invalid manual-delay ranges and UTF-8-oversized reasons before review", async () => {
    await renderClient();
    await eventually(() =>
      expect(button("Manual timing override")).toBeDefined(),
    );
    await act(async () => button("Manual timing override")!.click());

    await act(async () => {
      setValue(input("Subscriber UUID"), "not-a-subscriber");
      setValue(input("Event name"), "order.created");
    });
    expect(button("Look up")?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Subscriber ID must be a canonical UUID.",
    );
    expect(mocks.getDelay).not.toHaveBeenCalled();

    await act(async () => {
      setValue(input("Subscriber UUID"), SUBSCRIBER_ID);
      button("Look up")!.click();
    });
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "No preference is stored for this verified pair",
      ),
    );

    for (const invalid of ["-1", "1.5", "2592001"]) {
      await act(async () => setValue(input("Delay seconds"), invalid));
      expect(button("Save manual override")?.disabled).toBe(true);
      expect(document.body.textContent).toContain(
        "Manual delay must be a whole number from 0 through 2,592,000 seconds.",
      );
    }

    await act(async () => {
      setValue(input("Delay seconds"), "900");
      setValue(input("Operator reason"), "é".repeat(251));
    });
    expect(button("Save manual override")?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Operator reason must use 500 UTF-8 bytes or fewer.",
    );
    expect(mocks.whoamiFresh).not.toHaveBeenCalled();
    expect(mocks.putDelay).not.toHaveBeenCalled();
  });

  it("guards an edited manual timing override from navigation loss", async () => {
    await renderClient();
    await eventually(() =>
      expect(button("Manual timing override")).toBeDefined(),
    );
    await act(async () => button("Manual timing override")!.click());
    await act(async () => {
      setValue(input("Subscriber UUID"), SUBSCRIBER_ID);
      setValue(input("Event name"), "order.created");
      button("Look up")!.click();
    });
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "No preference is stored for this verified pair",
      ),
    );
    await act(async () => setValue(input("Delay seconds"), "900"));
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(beforeUnload)).toBe(false);
    expect(beforeUnload.defaultPrevented).toBe(true);
  });
});
