// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  events: vi.fn(),
  create: vi.fn(),
  transition: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/privacy-incidents-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/privacy-incidents-api")>()),
  listPrivacyIncidents: mocks.list,
  getPrivacyIncident: mocks.get,
  listPrivacyIncidentEvents: mocks.events,
  createPrivacyIncident: mocks.create,
  transitionPrivacyIncident: mocks.transition,
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.success, warning: mocks.warning },
}));

import PrivacyIncidentsPage from "@/app/(dashboard)/app/privacy-incidents/page";
import { PrivacyIncidentDetailClient } from "@/app/(dashboard)/app/privacy-incidents/[id]/privacy-incident-detail-client";
import { ApiError } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import type {
  PrivacyIncident,
  PrivacyIncidentEvent,
  PrivacyIncidentPage,
} from "@/lib/privacy-incidents-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const INCIDENT = "77777777-7777-4777-8777-777777777777";
const EVENT = "33333333-3333-4333-8333-333333333333";

function me(over: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: USER,
    tenant_id: TENANT,
    email: "admin@example.test",
    role: "admin",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Workspace",
    workspace_slug: "workspace",
    ...over,
  };
}

function detail(over: Partial<PrivacyIncident> = {}): PrivacyIncident {
  return {
    id: INCIDENT,
    severity: "high",
    status: "open",
    detected_at: "2026-08-29T10:00:00Z",
    clock_started_at: "2026-08-29T10:00:00Z",
    gdpr_72h_deadline: "2026-09-01T10:00:00Z",
    template_version: "v1",
    affected_regions: ["Europe"],
    affected_data_categories: ["email"],
    affected_subject_count: 12,
    notification_decisions: {},
    jurisdictions: ["GDPR"],
    summary: "Possible subscriber export\n\nReview started.",
    created_at: "2026-08-29T10:00:00Z",
    updated_at: "2026-08-29T10:00:00Z",
    jurisdiction_resolution: {
      status: "release_held",
      release_hold_code: "jurisdiction_rules_release_hold",
      recognized: [{ code: "GDPR", name: "European Union / EEA" }],
    },
    ...over,
  };
}

function listPage(rows: PrivacyIncident[] = [detail()]): PrivacyIncidentPage {
  return {
    tenantId: TENANT,
    incidents: rows.map(({ jurisdiction_resolution: _, ...row }) => row),
    knownJurisdictions: [
      { code: "CA", name: "California" },
      { code: "GDPR", name: "European Union / EEA" },
    ],
  };
}

const openingEvent: PrivacyIncidentEvent = {
  event_id: EVENT,
  source: "incident_state_transitions",
  schema_version: 1,
  kind: "transition",
  at: "2026-08-29T10:00:00Z",
  to_state: "open",
  actor: "admin@example.test",
  reason: "incident opened",
};

async function flush(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(
  Component: ComponentType<Record<string, never>>,
): Promise<{ root: Root; container: HTMLDivElement }>;
async function render<P extends object>(
  Component: ComponentType<P>,
  props: P,
): Promise<{ root: Root; container: HTMLDivElement }>;
async function render<P extends object>(
  Component: ComponentType<P>,
  props?: P,
): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Component, props ?? ({} as P)),
      ),
    );
  });
  await flush();
  return { root, container };
}

function setValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush();
}

async function unmount(root: Root): Promise<void> {
  await act(async () => root.unmount());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue(me());
  mocks.list.mockResolvedValue(listPage());
  mocks.get.mockResolvedValue(detail());
  mocks.events.mockResolvedValue({
    tenantId: TENANT,
    incidentId: INCIDENT,
    events: [openingEvent],
  });
  mocks.create.mockResolvedValue(detail());
  mocks.transition.mockResolvedValue({
    incident_id: INCIDENT,
    from: "open",
    to: "contained",
    at: "2026-08-29T11:00:00Z",
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("privacy incident register interactions", () => {
  it("fails closed for an effective viewer without requesting the register", async () => {
    mocks.whoami.mockResolvedValue(me({ effective_role: "viewer" }));
    const { root, container } = await render(PrivacyIncidentsPage);
    try {
      expect(container.textContent).toContain("Admin access required");
      expect(mocks.list).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Possible subscriber export");
    } finally {
      await unmount(root);
    }
  });

  it("renders loaded-only evidence and creates through fresh identity checks", async () => {
    const { root, container } = await render(PrivacyIncidentsPage);
    try {
      expect(container.textContent).toContain("Possible subscriber export");
      // governance-106: the stat strip scopes every count to loaded rows.
      expect(container.textContent).toContain(
        "Every count covers only the 1 row loaded in this browser.",
      );
      expect(container.textContent).toContain("closure remain release-held");

      const openButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.includes("New preliminary record"),
      );
      expect(openButton).toBeTruthy();
      await click(openButton!);

      const title = document.querySelector<HTMLInputElement>(
        "#privacy-incident-title",
      );
      expect(title).toBeTruthy();
      await act(async () => setValue(title!, "Potential profile export"));
      const submit = [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Create preliminary record"),
      );
      expect(submit).toBeTruthy();
      await click(submit!);

      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
        incident: {
          summary: "Potential profile export",
          severity: "medium",
          affected_data_categories: ["unknown"],
        },
      });
      expect(mocks.whoami.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(mocks.success).toHaveBeenCalledWith(
        "Preliminary incident record created",
      );
    } finally {
      await unmount(root);
    }
  });

  it("mounts the stat strip over the loaded rows with hints and the workflow explainer (governance-106)", async () => {
    // Two loaded rows: one open + high (needs attention), one closed. The
    // fixture deadline (2026-09-01) is in the past, so the open row's
    // operational target has passed as well.
    mocks.list.mockResolvedValue(
      listPage([
        detail(),
        detail({
          id: "88888888-8888-4888-8888-888888888888",
          status: "closed",
          severity: "low",
          summary: "Closed drill",
          // Pages must arrive newest-first for the merge contract.
          detected_at: "2026-08-28T10:00:00Z",
        }),
      ]),
    );
    const { root, container } = await render(PrivacyIncidentsPage);
    try {
      const strip = container.querySelector<HTMLElement>(
        'section[aria-label="Loaded incident evidence summary"]',
      );
      expect(strip).toBeTruthy();
      expect(strip!.textContent).toContain(
        "Every count covers only the 2 rows loaded in this browser.",
      );
      const cells = [...strip!.querySelectorAll("dl > div")].map((cell) => ({
        label: cell.querySelector("dt")?.textContent,
        value: cell.querySelector("dd")?.textContent,
      }));
      expect(cells).toEqual([
        { label: "Needs attention", value: "1" },
        { label: "Operational target passed", value: "1" },
        { label: "Loaded non-terminal", value: "1" },
        { label: "Scope fields complete", value: "2 / 2" },
      ]);
      expect(strip!.textContent).toContain(
        "This is a triage signal, not a legal determination.",
      );
      // The legacy four-tile summary is gone with its copy.
      expect(container.textContent).not.toContain("This browser window only");

      const learn = [...strip!.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Learn the workflow"),
      );
      expect(learn).toBeTruthy();
      await click(learn!);
      expect(document.body.textContent).toContain(
        "The breach-response workflow",
      );
      expect(document.body.textContent).toContain("Closed (release-held)");
    } finally {
      await unmount(root);
    }
  });
});

describe("privacy incident detail interactions", () => {
  it("shows independent event evidence and records a current-state transition", async () => {
    mocks.get
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail())
      .mockResolvedValue(
        detail({ status: "contained", updated_at: "2026-08-29T11:00:00Z" }),
      );
    const { root, container } = await render(PrivacyIncidentDetailClient, {
      incidentId: INCIDENT,
    });
    try {
      expect(container.textContent).toContain("incident opened");
      expect(container.textContent).toContain("Closure unavailable");
      expect(container.textContent).toContain("Evidence packets");
      // governance-103/-104: the counsel sign-off and notification-delivery
      // holds render as release-held cards, and no control offers either verb.
      expect(container.textContent).toContain("Counsel sign-off");
      expect(container.textContent).toContain("Notification delivery");
      const verbs = [...container.querySelectorAll("button")].map((b) =>
        (b.textContent ?? "").trim(),
      );
      expect(verbs.some((v) => /sign[- ]off|record.*sent|packet|close incident/i.test(v))).toBe(false);

      const transition = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.includes("Move to Contained"),
      );
      expect(transition).toBeTruthy();
      await click(transition!);

      const reason = document.querySelector<HTMLTextAreaElement>(
        "#privacy-incident-transition-reason",
      );
      const confirmation = document.querySelector<HTMLInputElement>(
        "#privacy-incident-transition-confirmation",
      );
      expect(reason).toBeTruthy();
      expect(confirmation).toBeTruthy();
      await act(async () => {
        setValue(reason!, "Access revoked and source isolated");
        setValue(confirmation!, "MOVE TO CONTAINED");
      });
      const submit = [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Record transition"),
      );
      expect(submit).toBeTruthy();
      await click(submit!);

      expect(mocks.transition).toHaveBeenCalledTimes(1);
      expect(mocks.transition.mock.calls[0]?.[0]).toMatchObject({
        incidentId: INCIDENT,
        expectedFrom: "open",
        to: "contained",
        reason: "Access revoked and source isolated",
      });
      expect(mocks.get).toHaveBeenCalledTimes(3);
      expect(mocks.events.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mocks.success).toHaveBeenCalledWith("Incident moved to Contained");
    } finally {
      await unmount(root);
    }
  });

  it("does not turn an event-ledger failure into an empty-history claim", async () => {
    mocks.events.mockRejectedValue(
      new ApiError("ledger unavailable", 404, undefined, {
        code: "not_found",
      }),
    );
    const { root, container } = await render(PrivacyIncidentDetailClient, {
      incidentId: INCIDENT,
    });
    try {
      expect(container.textContent).toContain(
        "Incident activity could not be verified",
      );
      expect(container.textContent).toContain(
        "Notification context could not be verified",
      );
      expect(container.textContent).not.toContain(
        "complete loaded event response contains no rows",
      );
    } finally {
      await unmount(root);
    }
  });
});
