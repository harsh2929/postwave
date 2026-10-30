// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// IntegrationLifecycleActions: each verb sends the request desktop's
// lifecycle controller sends — the native family route for a native row with
// one exact connection, the generic facade otherwise — and renders the
// server's outcome. Destructive verbs confirm and re-verify the target; the
// withheld cases (role, support hold, ambiguous target) send nothing.

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONN,
  CONN_2,
  actionBody,
  buttonNamed,
  catalogItem,
  click,
  connectionRow,
  detailBody,
  identity,
  installFetchRouter,
  mount,
  text,
  unmountAll,
  waitFor,
  type FetchRouter,
} from "../helpers/integrations-lifecycle-harness";
import { IntegrationLifecycleActions } from "@/components/integrations/integration-lifecycle-actions";
import { ADMIN_REQUIRED_REASON } from "@/components/integrations/use-integration-lifecycle-authority";
import {
  parseConnectionsReport,
  type IntegrationConnection,
} from "@/lib/integrations-lifecycle-api";

const auth = vi.hoisted(() => ({
  me: null as unknown,
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/auth-api", () => ({
  whoami: async () => auth.me,
  whoamiFresh: (...args: unknown[]) => auth.whoamiFresh(...args),
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));

const ALL = ["connect/start", "sync", "backfill", "pause", "disconnect"];

function conn(overrides: Record<string, unknown> = {}): IntegrationConnection {
  return parseConnectionsReport({ items: [connectionRow(overrides)] })
    .items[0] as IntegrationConnection;
}

function render(
  item: ReturnType<typeof catalogItem>,
  connection: IntegrationConnection | null,
  onChanged = vi.fn(),
) {
  mount(
    createElement(IntegrationLifecycleActions, {
      item,
      actions: ALL,
      connection,
      onChanged,
    }),
  );
  return onChanged;
}

function dialogButton(label: string): HTMLButtonElement | undefined {
  const dialog = document.querySelector('[role="dialog"]');
  return [...(dialog?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

let router: FetchRouter;

beforeEach(() => {
  auth.me = identity("admin");
  auth.whoamiFresh.mockReset();
  auth.whoamiFresh.mockImplementation(async () => auth.me);
  router = installFetchRouter({});
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe("native family dispatch", () => {
  it("Backfill re-verifies authority then POSTs the CRM family backfill for the exact connection", async () => {
    router.route(`POST /api/v1/crm/integrations/${CONN}/backfill`, {
      status: 202,
      body: { status: "queued", run_id: "run-42" },
    });
    const onChanged = render(catalogItem(), conn());

    await waitFor(() => expect(buttonNamed("Backfill")?.disabled).toBe(false));
    await click(buttonNamed("Backfill"));

    await waitFor(() =>
      expect(text()).toContain("HubSpot Backfill request accepted"),
    );
    expect(text()).toContain("Status queued · Run run-42");
    expect(auth.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(router.writes()).toEqual([
      {
        method: "POST",
        path: `/api/v1/crm/integrations/${CONN}/backfill`,
        search: "",
        body: {},
      },
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("Sync now and Pause run on the lead-capture family for a lead row", async () => {
    router.route(`POST /api/v1/lead-integrations/${CONN}/sync`, {
      body: { status: "completed" },
    });
    router.route(`POST /api/v1/lead-integrations/${CONN}/pause`, {
      body: { status: "paused" },
    });
    render(
      catalogItem({ slug: "typeform", name: "Typeform", sources: ["lead_capture"] }),
      conn({ slug: "typeform" }),
    );

    await waitFor(() => expect(buttonNamed("Sync now")?.disabled).toBe(false));
    await click(buttonNamed("Sync now"));
    await waitFor(() => expect(text()).toContain("Status completed"));
    await click(buttonNamed("Pause"));
    await waitFor(() => expect(text()).toContain("Status paused"));

    expect(
      router.writes().map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      `POST /api/v1/lead-integrations/${CONN}/sync`,
      `POST /api/v1/lead-integrations/${CONN}/pause`,
    ]);
  });

  it("Disconnect names its consequence, re-reads the detail, then DELETEs the exact connection", async () => {
    router.route("GET /api/v1/integrations/hubspot", { body: detailBody() });
    router.route(`DELETE /api/v1/crm/integrations/${CONN}`, {
      body: { status: "disconnected", id: CONN },
    });
    render(catalogItem(), conn());

    await waitFor(() =>
      expect(buttonNamed("Disconnect")?.disabled).toBe(false),
    );
    await click(buttonNamed("Disconnect"));
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        `Moosewave will stop syncing HubSpot (connection ${CONN})`,
      ),
    );
    expect(router.writes()).toEqual([]);

    await click(dialogButton("Disconnect"));
    await waitFor(() => expect(text()).toContain("Status disconnected"));
    expect(
      router.requests
        .filter((request) => request.path !== "/api/v1/auth/me")
        .map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "GET /api/v1/integrations/hubspot",
      `DELETE /api/v1/crm/integrations/${CONN}`,
    ]);
  });

  it("refuses to disconnect when the re-verified connection is no longer the one named", async () => {
    router.route("GET /api/v1/integrations/hubspot", {
      body: detailBody({
        connection: connectionRow({
          primary_connection_id: CONN_2,
          connection_ids: [CONN_2],
        }),
      }),
    });
    render(catalogItem(), conn());

    await waitFor(() =>
      expect(buttonNamed("Disconnect")?.disabled).toBe(false),
    );
    await click(buttonNamed("Disconnect"));
    await waitFor(() => expect(dialogButton("Disconnect")).toBeDefined());
    await click(dialogButton("Disconnect"));

    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "The connection changed since this page loaded. Nothing was disconnected",
      ),
    );
    expect(router.writes()).toEqual([]);
  });
});

describe("generic facade dispatch", () => {
  it("Sync now on a bridge row asks the facade and renders its handoff verbatim", async () => {
    router.route("POST /api/v1/integrations/zapier/sync", {
      status: 202,
      body: actionBody("zapier", "sync", {
        message:
          "Use API keys plus inbound or outbound webhooks for this bridge recipe.",
        delegated_to:
          "POST /api/v1/inbound-webhooks/endpoints or POST /api/v1/outbound-webhooks",
        required_fields: [],
      }),
    });
    render(
      catalogItem({
        slug: "zapier",
        name: "Zapier",
        badge: "zapier",
        native: false,
        sources: ["zapier_package"],
      }),
      conn({ slug: "zapier" }),
    );

    await waitFor(() => expect(buttonNamed("Sync now")?.disabled).toBe(false));
    await click(buttonNamed("Sync now"));

    await waitFor(() =>
      expect(text()).toContain("Zapier Sync now handoff is ready"),
    );
    expect(text()).toContain(
      "Use API keys plus inbound or outbound webhooks for this bridge recipe.",
    );
    expect(text()).toContain(
      "POST /api/v1/inbound-webhooks/endpoints or POST /api/v1/outbound-webhooks",
    );
    expect(text()).toContain("Continue in Integrations");
    expect(router.writes()).toEqual([
      {
        method: "POST",
        path: "/api/v1/integrations/zapier/sync",
        search: "",
        body: {},
      },
    ]);
  });

  it("Connect POSTs connect/start and renders the fields the owning surface needs", async () => {
    router.route("POST /api/v1/integrations/hubspot/connect/start", {
      status: 202,
      body: actionBody("hubspot", "connect/start", {
        message: "Start HubSpot OAuth through the CRM surface.",
        delegated_to: "GET /api/v1/crm/hubspot/oauth/start",
        required_fields: ["credentials_ref"],
      }),
    });
    render(catalogItem(), null);

    await waitFor(() => expect(buttonNamed("Connect")?.disabled).toBe(false));
    await click(buttonNamed("Connect"));

    await waitFor(() =>
      expect(text()).toContain("HubSpot Connect handoff is ready"),
    );
    expect(text()).toContain("GET /api/v1/crm/hubspot/oauth/start");
    expect(text()).toContain("credentials_ref");
    expect(router.writes()).toEqual([
      {
        method: "POST",
        path: "/api/v1/integrations/hubspot/connect/start",
        search: "",
        body: {},
      },
    ]);
  });

  it("renders the server's refusal sentence when the facade says the row is planned", async () => {
    router.route("POST /api/v1/integrations/zapier/backfill", {
      status: 409,
      body: actionBody("zapier", "backfill", {
        status: "unavailable",
        message: "Zapier is a roadmap preview and exposes no connection lifecycle.",
      }),
    });
    render(
      catalogItem({ slug: "zapier", name: "Zapier", badge: "zapier", sources: [] }),
      conn({ slug: "zapier" }),
    );
    await waitFor(() => expect(buttonNamed("Backfill")?.disabled).toBe(false));
    await click(buttonNamed("Backfill"));
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Zapier is a roadmap preview and exposes no connection lifecycle.",
      ),
    );
  });
});

describe("withheld verbs send nothing", () => {
  it("an editor sees every verb disabled with the reason", async () => {
    auth.me = identity("editor");
    render(catalogItem(), conn());
    await waitFor(() => expect(text()).toContain(ADMIN_REQUIRED_REASON));
    for (const label of ["Connect", "Sync now", "Backfill", "Pause", "Disconnect"]) {
      expect(buttonNamed(label)?.disabled).toBe(true);
    }
    await click(buttonNamed("Backfill"));
    expect(router.writes()).toEqual([]);
    expect(auth.whoamiFresh).not.toHaveBeenCalled();
  });

  it("a support provider shows the release hold and sends no runtime request", async () => {
    render(
      catalogItem({
        slug: "zendesk",
        name: "Zendesk",
        category: "customer_service",
        badge: "planned",
        sources: ["support_integration"],
      }),
      null,
    );
    await waitFor(() =>
      expect(text()).toContain("support_integration_runtime_held"),
    );
    expect(buttonNamed("Sync now")).toBeUndefined();
    expect(router.requests).toEqual([]);
  });

  it("several accounts for one row withhold the account-specific verbs", async () => {
    render(
      catalogItem(),
      conn({ count: 2, connection_ids: [CONN, CONN_2] }),
    );
    await waitFor(() =>
      expect(text()).toContain("This workspace has several HubSpot accounts"),
    );
    expect(buttonNamed("Backfill")?.disabled).toBe(true);
    expect(buttonNamed("Connect")?.disabled).toBe(false);
    await click(buttonNamed("Backfill"));
    expect(router.writes()).toEqual([]);
  });
});
