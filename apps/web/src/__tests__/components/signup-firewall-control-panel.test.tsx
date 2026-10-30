// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFirewallSettings: vi.fn(),
  listFirewallEvents: vi.fn(),
  runFirewallSurgeDetection: vi.fn(),
  updateFirewallSettings: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/signup-protection-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/signup-protection-api")>()),
  getFirewallSettings: mocks.getFirewallSettings,
  listFirewallEvents: mocks.listFirewallEvents,
  runFirewallSurgeDetection: mocks.runFirewallSurgeDetection,
  updateFirewallSettings: mocks.updateFirewallSettings,
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: mocks.whoamiFresh,
}));

import { FirewallControlPanel } from "@/app/(dashboard)/app/signup-protection/firewall-control-panel";
import type { MeResponse } from "@/lib/auth-api";
import type { FirewallSettings } from "@/lib/signup-protection-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "018f0000-0000-7000-8000-000000000001";
const USER = "018f0000-0000-7000-8000-000000000002";
const UPDATED = "2026-08-30T10:00:00Z";

const identity: MeResponse = {
  user_id: USER,
  tenant_id: TENANT,
  email: "admin@example.test",
  role: "admin",
  effective_role: "admin",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Firewall QA",
  workspace_slug: "firewall-qa",
};

function settings(override: Partial<FirewallSettings> = {}): FirewallSettings {
  return {
    attack_mode_enabled: false,
    auto_attack_mode: true,
    fingerprint_required: false,
    attack_mode_threshold: 50,
    surge_multiplier: 5,
    surge_min_per_hour: 50,
    attack_mode_auto_enabled_at: null,
    attack_mode_auto_cooldown_until: null,
    updated_at: UPDATED,
    ...override,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await flush();
    }
  }
  throw failure;
}

async function mount(role: MeResponse["role"] = "admin"): Promise<{
  container: HTMLElement;
  root: Root;
  onRefresh: ReturnType<typeof vi.fn>;
  onSettingsUpdated: ReturnType<typeof vi.fn>;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onRefresh = vi.fn();
  const onSettingsUpdated = vi.fn();
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(FirewallControlPanel, {
          identity: { ...identity, role, effective_role: role },
          settings: settings(),
          onRefresh,
          onSettingsUpdated,
        }),
      ),
    );
  });
  await flush();
  return { container, root, onRefresh, onSettingsUpdated };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listFirewallEvents.mockResolvedValue({ events: [], count: 0 });
  mocks.whoamiFresh.mockResolvedValue(identity);
  mocks.getFirewallSettings.mockResolvedValue(settings());
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("signup firewall control panel", () => {
  it("keeps every mutation disabled for a read-only role", async () => {
    const { container, root } = await mount("viewer");
    try {
      expect(container.textContent).toContain("only an owner or admin");
      for (const label of [
        "Save firewall settings",
        "Discard changes",
        "Check for surge",
      ]) {
        const button = [...container.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === label,
        );
        expect(button?.disabled).toBe(true);
      }
      expect(mocks.whoamiFresh).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("fresh-checks authority and version before saving only the dirty field", async () => {
    mocks.updateFirewallSettings.mockResolvedValue(
      settings({
        attack_mode_threshold: 60,
        updated_at: "2026-08-30T10:01:00Z",
      }),
    );
    const { container, root, onSettingsUpdated } = await mount();
    try {
      const threshold = container.querySelector<HTMLInputElement>(
        "#firewall-risk-threshold",
      );
      expect(threshold).not.toBeNull();
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(threshold, "60");
        threshold?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const save = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save firewall settings",
      );
      expect(save?.disabled).toBe(false);
      await act(async () => {
        save?.click();
      });
      await waitFor(() =>
        expect(mocks.updateFirewallSettings).toHaveBeenCalledWith(
          { attack_mode_threshold: 60 },
          TENANT,
          expect.objectContaining({
            signal: expect.any(AbortSignal),
            idempotencyKey: expect.stringMatching(/^firewall-save:/),
          }),
        ),
      );
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.getFirewallSettings).toHaveBeenCalledWith({
        tenantId: TENANT,
        signal: expect.any(AbortSignal),
      });
      expect(onSettingsUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ attack_mode_threshold: 60 }),
      );
      expect(container.textContent).toContain("Firewall settings saved");
    } finally {
      act(() => root.unmount());
    }
  });

  it("refuses a known concurrent edit and keeps the local draft", async () => {
    mocks.getFirewallSettings.mockResolvedValueOnce(
      settings({ updated_at: "2026-08-30T10:02:00Z", surge_multiplier: 6 }),
    );
    const { container, root, onSettingsUpdated } = await mount();
    try {
      const threshold = container.querySelector<HTMLInputElement>(
        "#firewall-risk-threshold",
      );
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(threshold, "60");
        threshold?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const save = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save firewall settings",
      );
      await act(async () => save?.click());
      await waitFor(() =>
        expect(container.textContent).toContain(
          "changed after this form loaded",
        ),
      );
      expect(mocks.updateFirewallSettings).not.toHaveBeenCalled();
      expect(threshold?.value).toBe("60");
      expect(onSettingsUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ surge_multiplier: 6 }),
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("distinguishes a completed no-flip surge check from a failed check", async () => {
    mocks.runFirewallSurgeDetection.mockResolvedValue({ flipped: false });
    const { container, root, onRefresh } = await mount();
    try {
      const detect = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Check for surge",
      );
      await act(async () => detect?.click());
      await waitFor(() =>
        expect(container.textContent).toContain("completed and did not change"),
      );
      expect(onRefresh).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });
});
