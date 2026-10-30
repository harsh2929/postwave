// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CapabilityObservation } from "../../lib/capability-access";
import type { OnlineStatus } from "../../lib/online-manager";
import type { Role, RoleStatus, Section } from "../../lib/store";

const mocks = vi.hoisted(() => ({
  role: "admin" as Role | null,
  roleStatus: "resolved" as RoleStatus,
  online: "online" as OnlineStatus,
  observation: null as CapabilityObservation | null,
  setSection: vi.fn(),
  probeOnline: vi.fn().mockResolvedValue(undefined),
  refreshAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/store")>();
  return {
    ...actual,
    useRole: () => mocks.role,
    useRoleStatus: () => mocks.roleStatus,
    useMe: () => ({
      user: "user-1",
      tenant: "tenant-1",
      role: "admin" as const,
      effectiveRole: mocks.role ?? ("viewer" as const),
    }),
    setSection: mocks.setSection,
    loadMe: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../../lib/online-manager", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/online-manager")>();
  return {
    ...actual,
    useOnline: () => mocks.online,
    probeOnline: mocks.probeOnline,
  };
});
vi.mock("../../lib/auditScopes", () => ({
  useAuditScopes: () => ({
    loading: false,
    isAdmin: true,
    scopes: new Set<string>(["admin"]),
    error: null,
    refresh: mocks.refreshAudit,
  }),
}));
vi.mock("../../lib/capability-observations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/capability-observations")>();
  return {
    ...actual,
    useCapabilityObservation: () => mocks.observation,
    clearCapabilityObservation: vi.fn(),
  };
});

import { DesktopDestinationGate } from "../../components/DesktopDestinationGate";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  mocks.role = "admin";
  mocks.roleStatus = "resolved";
  mocks.online = "online";
  mocks.observation = null;
  mocks.setSection.mockReset();
  mocks.probeOnline.mockClear();
});

function render(section: Section): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <DesktopDestinationGate section={section}>
        <div data-testid="protected-content">Remote content</div>
      </DesktopDestinationGate>,
    ),
  );
}

describe("DesktopDestinationGate", () => {
  it("does not mount remote content when the role is denied", () => {
    mocks.role = "editor";
    render("affiliates");
    expect(
      document.querySelector("[data-testid=protected-content]"),
    ).toBeNull();
    expect(document.body.textContent).toContain("Access required");
    expect(document.body.textContent).toContain("has not loaded");
  });

  it("keeps every retention read unmounted for viewer and editor sessions", () => {
    for (const role of ["viewer", "editor"] as const) {
      if (root) act(() => root?.unmount());
      root = null;
      container?.remove();
      container = null;
      document.body.replaceChildren();
      mocks.role = role;
      render("retentionOffers");
      expect(
        document.querySelector("[data-testid=protected-content]"),
      ).toBeNull();
      expect(document.body.textContent).toContain(
        "This destination requires the admin role.",
      );
      expect(document.body.textContent).not.toContain("Open Integrations");
    }
  });

  it("keeps privacy-incident remote content unmounted outside the admin role", () => {
    for (const role of ["viewer", "editor"] as const) {
      if (root) act(() => root?.unmount());
      root = null;
      container?.remove();
      container = null;
      document.body.replaceChildren();
      mocks.role = role;
      render("privacyIncidents");
      expect(
        document.querySelector("[data-testid=protected-content]"),
      ).toBeNull();
      expect(document.body.textContent).toContain(
        "This destination requires the admin role.",
      );
    }
  });

  it("discloses read-only readiness while preserving accessible content", () => {
    render("discounts");
    expect(
      document.querySelector("[data-testid=protected-content]"),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Read only");
    expect(document.body.textContent).toContain(
      "Historical local-record inspection only",
    );
  });

  it("mounts Helpdesk for a viewer so its inner static-catalog boundary can fail protected reads closed", () => {
    mocks.role = "viewer";
    render("helpdesk");
    expect(
      document.querySelector("[data-testid=protected-content]"),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Mixed readiness");
  });

  it("discloses a partial setup limitation without blocking other tasks", () => {
    mocks.observation = {
      state: "partial-not-configured",
      reason:
        "Webhook sync is unavailable; other audience tools remain usable.",
      observedAt: 1,
    };
    render("audienceSyncs");
    expect(
      document.querySelector("[data-testid=protected-content]"),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Partially available · setup required",
    );
    expect(document.body.textContent).toContain("other audience tools");
  });

  it("blocks online-only routes offline and offers a real retry", () => {
    mocks.online = "offline";
    render("campaigns");
    expect(
      document.querySelector("[data-testid=protected-content]"),
    ).toBeNull();
    const retry = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry connection",
    );
    expect(retry).toBeTruthy();
    act(() => retry?.click());
    expect(mocks.probeOnline).toHaveBeenCalledTimes(1);
  });

  it("keeps the admin Helpdesk mounted only to disclose retained session data offline", () => {
    mocks.online = "offline";
    render("helpdesk");
    expect(
      document.querySelector("[data-testid=protected-content]"),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Offline · retained session only",
    );
    expect(document.body.textContent).toContain("not an offline cache");
    expect(document.body.textContent).toContain("reload clears it");
  });
});
