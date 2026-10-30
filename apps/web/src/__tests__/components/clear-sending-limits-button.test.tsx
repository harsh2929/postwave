// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// deliverability-17 — "Clear limit & quiet hours". The host card
// (settings/sender/sending-limits-card.tsx) is another session's WIP, so the
// component is driven directly through the REAL transport (global fetch is
// the only stub), which means the asserted request is the one the browser
// would send: method, path, full-replace body, and no idempotency key.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClearSendingLimitsButton } from "@/components/settings/ClearSendingLimitsButton";
import type { MeResponse } from "@/lib/auth-api";
import type { SendingSettings } from "@/lib/sending-settings-api";

const mocks = vi.hoisted(() => ({
  verifyFresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyFresh,
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    info: mocks.toastInfo,
    error: mocks.toastError,
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "22222222-2222-4222-8222-222222222222";
const IDENTITY = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: TENANT,
  email: "owner@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
} as unknown as MeResponse;

const R1: SendingSettings = {
  tenant_id: TENANT,
  max_sends_per_hour: 500,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "Europe/London",
  quiet_hours_per_recipient: false,
  updated_at: "2026-09-03T10:00:00Z",
};

const CLEARED = {
  tenant_id: TENANT,
  max_sends_per_hour: null,
  quiet_hours_start: "",
  quiet_hours_end: "",
  quiet_hours_tz: "",
  quiet_hours_per_recipient: false,
  updated_at: "2026-09-03T10:05:00Z",
};

interface Seen {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

let seen: Seen[] = [];
let putResponse: () => Response;

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

beforeEach(() => {
  seen = [];
  mocks.verifyFresh.mockResolvedValue(IDENTITY);
  putResponse = () =>
    json(CLEARED, 200, { "x-postwave-sending-cap-outcome": "committed" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
        .replace(/^https?:\/\/[^/]+/, "")
        .split("?")[0]!;
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({
        method,
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        headers: new Headers(init?.headers),
      });
      if (path === "/api/v1/settings/sending" && method === "PUT") {
        return putResponse();
      }
      if (path === "/api/v1/settings/sending" && method === "GET") {
        // Reconciliation read: the prior revision is still visible.
        return json(R1);
      }
      if (path === "/api/v1/settings/sending/status") {
        return json({ tenant_id: TENANT, quiet_hours_per_recipient: false });
      }
      return json({ error: { code: "not_found", message: "" } }, 404);
    }),
  );
});

let root: Root | null = null;

function render(
  props: Partial<Parameters<typeof ClearSendingLimitsButton>[0]> = {},
) {
  const onCleared = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container);
    root.render(
      <ClearSendingLimitsButton
        settings={R1}
        canWrite
        identity={IDENTITY}
        onCleared={onCleared}
        {...props}
      />,
    );
  });
  return { container, onCleared };
}

function trigger(): HTMLButtonElement {
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === "Clear limit & quiet hours" &&
      !candidate.closest('[role="dialog"]'),
  );
  if (!node) throw new Error("missing trigger");
  return node;
}

function dialog(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!node) throw new Error("dialog not open");
  return node;
}

async function flush() {
  for (let turn = 0; turn < 8; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function confirm() {
  const button = [
    ...dialog().querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (candidate) =>
      candidate.textContent?.trim() === "Clear limit & quiet hours",
  );
  if (!button) throw new Error("missing confirm");
  await act(async () => {
    button.click();
  });
  await flush();
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ClearSendingLimitsButton", () => {
  it("names the consequence, then PUTs the cleared full-replace payload once", async () => {
    const { onCleared } = render({ dirty: true });
    act(() => trigger().click());

    expect(dialog().textContent).toContain(
      "Clear hourly limit and quiet hours?",
    );
    expect(dialog().textContent).toContain(
      "no longer have an hourly ceiling or be held by a quiet-hours window",
    );
    expect(dialog().textContent).toContain(
      "Frequency caps, sending identity, IP assignments, and send-time settings are not changed.",
    );
    expect(dialog().textContent).toContain(
      "Your unsaved draft will also be replaced if this clear succeeds.",
    );
    expect(seen).toHaveLength(0);

    await confirm();

    const puts = seen.filter((request) => request.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.path).toBe("/api/v1/settings/sending");
    expect(puts[0]!.body).toEqual({
      max_sends_per_hour: null,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "",
      // Preserved, exactly like desktop's clearedSendingInput.
      quiet_hours_per_recipient: false,
      expected_updated_at: "2026-09-03T10:00:00Z",
    });
    expect(puts[0]!.headers.has("Idempotency-Key")).toBe(false);
    expect(mocks.verifyFresh).toHaveBeenCalledTimes(1);
    expect(onCleared).toHaveBeenCalledWith(CLEARED);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Hourly cap and quiet hours cleared.",
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("withholds the verb with its reason when nothing is saved", () => {
    render({
      settings: {
        ...R1,
        max_sends_per_hour: null,
        quiet_hours_start: "",
        quiet_hours_end: "",
        quiet_hours_tz: "",
      },
    });
    expect(trigger().disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "No hourly cap or quiet-hours window is saved, so there is nothing to clear.",
    );
    expect(seen).toHaveLength(0);
  });

  it("withholds the verb from a role that cannot write", () => {
    render({ canWrite: false });
    expect(trigger().disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Only an owner or admin can clear sending limits.",
    );
  });

  it("holds an ambiguous clear for read-only reconciliation instead of replaying the PUT", async () => {
    // A 503 with no cap-outcome receipt cannot prove whether it committed.
    putResponse = () =>
      json({ error: { code: "upstream", message: "Bad gateway" } }, 503);
    const { onCleared } = render();
    act(() => trigger().click());
    await confirm();

    expect(seen.filter((request) => request.method === "PUT")).toHaveLength(1);
    // Reconciliation only READ canonical state.
    expect(
      seen.filter(
        (request) =>
          request.method === "GET" &&
          request.path === "/api/v1/settings/sending",
      ).length,
    ).toBeGreaterThan(0);
    expect(onCleared).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Editing remains held until a fresh reconciliation.",
    );
    expect(trigger().disabled).toBe(true);

    const refresh = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (candidate) => candidate.textContent?.trim() === "Refresh to reconcile",
    )!;
    await act(async () => {
      refresh.click();
    });
    await flush();
    expect(seen.filter((request) => request.method === "PUT")).toHaveLength(1);
  });
});
