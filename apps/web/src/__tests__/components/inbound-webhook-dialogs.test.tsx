// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InboundEndpointEditDialog } from "@/components/integrations/inbound-endpoint-edit-dialog";
import { InboundEventsDialog } from "@/components/integrations/inbound-events-dialog";
import type { MeResponse } from "@/lib/auth-api";
import type * as InboundApi from "@/lib/inbound-webhooks-api";
import type { InboundEvent, InboundWebhook } from "@/lib/inbound-webhooks-api";

const mocks = vi.hoisted(() => ({
  listEvents: vi.fn(),
  previewTransform: vi.fn(),
  replayEvent: vi.fn(),
  updateEndpoint: vi.fn(),
  whoamiFresh: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/inbound-webhooks-api", async (importOriginal) => {
  const actual = await importOriginal<typeof InboundApi>();
  return {
    ...actual,
    listInboundWebhookEvents: mocks.listEvents,
    previewInboundTransform: mocks.previewTransform,
    replayInboundEvent: mocks.replayEvent,
    updateInboundWebhook: mocks.updateEndpoint,
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const endpoint: InboundWebhook = {
  id: "endpoint_1",
  tenantId: "tenant_1",
  slug: "quality-hook",
  name: "Quality endpoint",
  enabled: true,
  transform_jq: ".payload",
  createdAt: "2026-08-01T00:00:00.000Z",
};

const adminIdentity: MeResponse = {
  user_id: "user_1",
  tenant_id: "tenant_1",
  email: "admin@example.test",
  role: "admin",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Quality",
  workspace_slug: "quality",
};

const verifiedEvent: InboundEvent = {
  id: 41,
  endpoint_id: endpoint.id,
  headers: { "Content-Type": "application/json" },
  body: '{"email":"person@example.test","markup":"<script>nope()</script>"}',
  signature_valid: true,
  received_at: "2026-08-25T12:00:00.000Z",
};

const unverifiedEvent: InboundEvent = {
  ...verifiedEvent,
  id: 42,
  body: "",
  signature_valid: false,
};

function render(ui: ReactNode): {
  client: QueryClient;
  container: HTMLDivElement;
  root: Root;
} {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return { client, container, root };
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

function input(label: string): HTMLInputElement | HTMLTextAreaElement {
  const target = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const id = target?.htmlFor;
  const control = id ? document.getElementById(id) : null;
  if (
    !(control instanceof HTMLInputElement) &&
    !(control instanceof HTMLTextAreaElement)
  ) {
    throw new Error(`Input not found: ${label}`);
  }
  return control;
}

function change(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
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

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolvePromise) =>
          window.setTimeout(resolvePromise, 0),
        );
      });
    }
  }
  throw lastError;
}

beforeEach(() => {
  mocks.whoamiFresh.mockResolvedValue(adminIdentity);
  mocks.listEvents.mockResolvedValue({ items: [] });
  mocks.previewTransform.mockResolvedValue({ body: { ok: true } });
  mocks.replayEvent.mockResolvedValue({
    ok: true,
    queued: true,
    replay_id: "replay_1",
    matches: [],
  });
  mocks.updateEndpoint.mockResolvedValue(endpoint);
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("InboundEndpointEditDialog", () => {
  it("associates required-name validation and never writes an unchanged draft", async () => {
    const { client, root } = render(
      createElement(InboundEndpointEditDialog, {
        endpoint,
        identity: adminIdentity,
        open: true,
        onOpenChange: vi.fn(),
        onSaved: vi.fn(),
      }),
    );
    try {
      expect(button("Save changes").disabled).toBe(true);
      const name = input("Name") as HTMLInputElement;
      await act(async () => change(name, ""));
      expect(button("Save changes").disabled).toBe(false);
      await act(async () => {
        name.dispatchEvent(new Event("invalid", { bubbles: false }));
      });
      expect(name.getAttribute("aria-invalid")).toBe("true");
      const describedBy = name.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)?.textContent).toContain(
        "Name is required",
      );
      expect(mocks.updateEndpoint).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("submits the complete state once, locks dismissal while pending, and closes only after success", async () => {
    let resolveUpdate: ((value: InboundWebhook) => void) | undefined;
    mocks.updateEndpoint.mockImplementationOnce(
      () =>
        new Promise<InboundWebhook>((resolvePromise) => {
          resolveUpdate = resolvePromise;
        }),
    );
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    const updated = { ...endpoint, name: "Renamed endpoint", enabled: false };
    const editTrigger = document.createElement("button");
    editTrigger.textContent = "Edit endpoint";
    document.body.append(editTrigger);
    function ControlledEditDialog() {
      const [open, setOpen] = useState(true);
      return createElement(InboundEndpointEditDialog, {
        endpoint,
        identity: adminIdentity,
        open,
        onOpenChange: (next) => {
          onOpenChange(next);
          setOpen(next);
        },
        onSaved,
        returnFocusRef: { current: editTrigger },
      });
    }
    const { client, root } = render(createElement(ControlledEditDialog));
    try {
      await act(async () => change(input("Name"), "  Renamed endpoint  "));
      const enabled = document.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      );
      if (!enabled) throw new Error("Enabled checkbox not found");
      await act(async () => enabled.click());

      const save = button("Save changes");
      await act(async () => {
        save.click();
        save.click();
      });
      expect(mocks.updateEndpoint).toHaveBeenCalledTimes(1);
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.updateEndpoint.mock.invocationCallOrder[0]!,
      );
      expect(mocks.updateEndpoint).toHaveBeenCalledWith(endpoint.id, {
        name: "Renamed endpoint",
        enabled: false,
        transform_jq: ".payload",
      });
      expect(
        document.querySelector('[role="dialog"]')?.getAttribute("aria-busy"),
      ).toBe("true");
      expect(button("Cancel").disabled).toBe(true);

      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(onOpenChange).not.toHaveBeenCalled();

      await act(async () => resolveUpdate?.(updated));
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Endpoint updated");
      await act(
        async () =>
          new Promise<void>((resolvePromise) =>
            window.requestAnimationFrame(() => resolvePromise()),
          ),
      );
      expect(document.activeElement).toBe(editTrigger);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("keeps a conflict open with an inline retry path", async () => {
    const updated = { ...endpoint, name: "Retry endpoint" };
    mocks.updateEndpoint
      .mockRejectedValueOnce(new Error("Endpoint changed elsewhere"))
      .mockResolvedValueOnce(updated);
    const onSaved = vi.fn();
    const { client, root } = render(
      createElement(InboundEndpointEditDialog, {
        endpoint,
        identity: adminIdentity,
        open: true,
        onOpenChange: vi.fn(),
        onSaved,
      }),
    );
    try {
      await act(async () => change(input("Name"), "Retry endpoint"));
      await act(async () => button("Save changes").click());
      await waitFor(() => {
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Endpoint changed elsewhere",
        );
      });
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(onSaved).not.toHaveBeenCalled();

      await act(async () => button("Save changes").click());
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
      expect(mocks.updateEndpoint).toHaveBeenCalledTimes(2);
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("rejects an edit before transport after an online authority downgrade", async () => {
    mocks.whoamiFresh.mockResolvedValueOnce({
      ...adminIdentity,
      role: "editor",
      effective_role: "editor",
    });
    const { client, root } = render(
      createElement(InboundEndpointEditDialog, {
        endpoint,
        identity: adminIdentity,
        open: true,
        onOpenChange: vi.fn(),
        onSaved: vi.fn(),
      }),
    );
    try {
      await act(async () => change(input("Name"), "Downgraded edit"));
      await act(async () => button("Save changes").click());
      await waitFor(() =>
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "authority changed",
        ),
      );
      expect(mocks.updateEndpoint).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("validates sample JSON, blocks duplicate tests, and discards stale transform results", async () => {
    let resolvePreview: ((value: { body: unknown }) => void) | undefined;
    mocks.previewTransform.mockImplementationOnce(
      () =>
        new Promise<{ body: unknown }>((resolvePromise) => {
          resolvePreview = resolvePromise;
        }),
    );
    const { client, root } = render(
      createElement(InboundEndpointEditDialog, {
        endpoint,
        identity: adminIdentity,
        open: true,
        onOpenChange: vi.fn(),
        onSaved: vi.fn(),
      }),
    );
    try {
      const sample = input("Sample payload (JSON)");
      await act(async () => change(sample, "{"));
      await act(async () => button("Test transform").click());
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "not valid JSON",
      );
      expect(mocks.previewTransform).not.toHaveBeenCalled();

      await act(async () => change(sample, '{"payload":{"id":1}}'));
      const testButton = button("Test transform");
      await act(async () => {
        testButton.click();
        testButton.click();
      });
      expect(mocks.previewTransform).toHaveBeenCalledTimes(1);
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.previewTransform.mock.invocationCallOrder[0]!,
      );
      await act(async () =>
        change(input("Transform (jq, optional)"), ".payload.id"),
      );
      await act(async () => resolvePreview?.({ body: { stale: true } }));
      expect(document.body.textContent).not.toContain('"stale": true');
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });
});

describe("InboundEventsDialog", () => {
  it("distinguishes loading, failed, and empty event states with a busy retry", async () => {
    mocks.listEvents
      .mockRejectedValueOnce(new Error("Event history unavailable"))
      .mockResolvedValueOnce({ items: [] });
    const { client, root } = render(
      createElement(InboundEventsDialog, {
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        identity: adminIdentity,
        baseKey: ["inbound-webhooks", "tenant_1", "admin"],
        open: true,
        onOpenChange: vi.fn(),
      }),
    );
    try {
      expect(document.querySelector('[role="status"]')).not.toBeNull();
      await waitFor(() => {
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Event history unavailable",
        );
      });
      expect(document.body.textContent).not.toContain("No events yet");
      await act(async () => button("Retry").click());
      await waitFor(() => {
        expect(document.body.textContent).toContain("No events yet");
      });
      expect(mocks.listEvents).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("renders verified and unverified data safely and blocks impossible replay", async () => {
    mocks.listEvents.mockResolvedValue({
      items: [verifiedEvent, unverifiedEvent],
    });
    const { client, root } = render(
      createElement(InboundEventsDialog, {
        endpointId: endpoint.id,
        endpointName: "A very long endpoint name that must wrap safely",
        identity: adminIdentity,
        baseKey: ["inbound-webhooks", "tenant_1", "admin"],
        open: true,
        onOpenChange: vi.fn(),
      }),
    );
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("signature valid");
        expect(document.body.textContent).toContain(
          "signature invalid or missing",
        );
      });
      const region = document.querySelector<HTMLElement>('[role="region"]');
      expect(region?.tabIndex).toBe(0);
      expect(button("Replay unavailable").disabled).toBe(true);

      await act(async () => button("View payload").click());
      const payload = document.querySelector(
        '[aria-label="Inbound event payload"]',
      );
      expect(payload?.textContent).toContain("<script>nope()</script>");
      expect(payload?.querySelector("script")).toBeNull();
      expect(mocks.replayEvent).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("rejects replay before transport after an online authority downgrade", async () => {
    mocks.listEvents.mockResolvedValue({ items: [verifiedEvent] });
    mocks.whoamiFresh.mockResolvedValueOnce({
      ...adminIdentity,
      viewer_mode: true,
    });
    const { client, root } = render(
      createElement(InboundEventsDialog, {
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        identity: adminIdentity,
        baseKey: ["inbound-webhooks", "tenant_1", "admin"],
        open: true,
        onOpenChange: vi.fn(),
      }),
    );
    try {
      await waitFor(() => expect(button("Replay")).toBeTruthy());
      await act(async () => button("Replay").click());
      await act(async () => button("Replay event").click());
      await waitFor(() =>
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "authority changed",
        ),
      );
      expect(mocks.replayEvent).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("keeps replay failure retryable, reuses one idempotency key, and reports queued truth", async () => {
    mocks.listEvents.mockResolvedValue({ items: [verifiedEvent] });
    mocks.replayEvent
      .mockRejectedValueOnce(new Error("Replay receipt conflict"))
      .mockResolvedValueOnce({
        ok: true,
        queued: true,
        replay_id: "replay_1",
        matches: [
          {
            trigger_id: "trigger_1",
            name: "Add launch tag",
            subscriber_email: "person@example.test",
            action_type: "add_tag",
            action_target_id: "launch",
            queued: true,
            executed: false,
          },
        ],
      });
    const onOpenChange = vi.fn();
    const eventsTrigger = document.createElement("button");
    eventsTrigger.textContent = "Events";
    document.body.append(eventsTrigger);
    function ControlledEventsDialog() {
      const [open, setOpen] = useState(true);
      return createElement(InboundEventsDialog, {
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        identity: adminIdentity,
        baseKey: ["inbound-webhooks", "tenant_1", "admin"],
        open,
        returnFocusRef: { current: eventsTrigger },
        onOpenChange: (next) => {
          onOpenChange(next);
          setOpen(next);
        },
      });
    }
    const { client, root } = render(createElement(ControlledEventsDialog));
    try {
      await waitFor(() => expect(button("Replay")).not.toBeNull());
      await act(async () => button("Replay").click());
      const replay = button("Replay event");
      await act(async () => {
        replay.click();
        replay.click();
      });
      await waitFor(() => {
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Replay receipt conflict",
        );
      });
      expect(mocks.replayEvent).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain(
        "reuses this attempt's idempotency key",
      );

      await act(async () => button("Retry replay").click());
      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledWith(
          expect.stringContaining("1 action queued"),
        );
      });
      expect(mocks.replayEvent).toHaveBeenCalledTimes(2);
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(2);
      expect(mocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.replayEvent.mock.invocationCallOrder[0]!,
      );
      expect(mocks.whoamiFresh.mock.invocationCallOrder[1]).toBeLessThan(
        mocks.replayEvent.mock.invocationCallOrder[1]!,
      );
      const firstKey = mocks.replayEvent.mock.calls[0]?.[2];
      const secondKey = mocks.replayEvent.mock.calls[1]?.[2];
      expect(firstKey).toMatch(/^[0-9a-f-]{36}$/u);
      expect(secondKey).toBe(firstKey);
      expect(String(mocks.toastSuccess.mock.calls[0]?.[0])).not.toContain(
        "action executed.",
      );
      expect(onOpenChange).not.toHaveBeenCalled();

      await act(async () => button("Close").click());
      expect(onOpenChange).toHaveBeenCalledWith(false);
      await act(
        async () =>
          new Promise<void>((resolvePromise) =>
            window.requestAnimationFrame(() => resolvePromise()),
          ),
      );
      expect(document.activeElement).toBe(eventsTrigger);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });
});
