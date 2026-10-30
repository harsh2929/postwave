// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: apiMock };
});

import type { MeResponse } from "@/lib/auth-api";
import {
  authorizePrivacyIncidentAdmin,
  createPrivacyIncident,
  decodePrivacyIncidentPage,
  getPrivacyIncident,
  listPrivacyIncidentEvents,
  listPrivacyIncidents,
  mergePrivacyIncidentPages,
  transitionPrivacyIncident,
} from "@/lib/privacy-incidents-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const INCIDENT_ONE = "77777777-7777-4777-8777-777777777777";
const INCIDENT_TWO = "66666666-6666-4666-8666-666666666666";
const EVENT_ONE = "33333333-3333-4333-8333-333333333333";
const EVENT_TWO = "44444444-4444-4444-8444-444444444444";

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

function incident(
  id = INCIDENT_ONE,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
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
    summary: "Possible export\n\nReview started.",
    created_at: "2026-08-29T10:00:00Z",
    updated_at: "2026-08-29T10:00:00Z",
    ...over,
  };
}

function resolution() {
  return {
    status: "release_held",
    release_hold_code: "jurisdiction_rules_release_hold",
    recognized: [{ code: "GDPR", name: "European Union / EEA" }],
  };
}

function listBody(rows: unknown[], over: Record<string, unknown> = {}) {
  return {
    incidents: rows,
    known_jurisdictions: [
      { code: "CA", name: "California" },
      { code: "GDPR", name: "European Union / EEA" },
    ],
    ...over,
  };
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
});

describe("privacy incident authority", () => {
  it("mints write authority only for the exact active tenant/user admin", () => {
    expect(authorizePrivacyIncidentAdmin(me(), TENANT, USER)).toMatchObject({
      tenantId: TENANT,
      userId: USER,
    });
    for (const candidate of [
      me({ role: "viewer" }),
      me({ effective_role: "viewer" }),
      me({ viewer_mode: true }),
      me({ tenant_id: "99999999-9999-4999-8999-999999999999" }),
      me({ user_id: "88888888-8888-4888-8888-888888888888" }),
    ]) {
      expect(() =>
        authorizePrivacyIncidentAdmin(candidate, TENANT, USER),
      ).toThrow(/identity|admin role/iu);
    }
  });

  it("refuses unbranded authority before any write transport", async () => {
    await expect(
      createPrivacyIncident({
        authority: { tenantId: TENANT, userId: USER } as never,
        incident: { summary: "Possible incident" },
        idempotencyKey: "stable-create-key",
      }),
    ).rejects.toThrow(/authorization/iu);
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});

describe("privacy incident read contracts", () => {
  it("decodes, tenant-scopes and continuously merges keyset pages", async () => {
    apiMock.get
      .mockResolvedValueOnce(
        listBody([incident()], { nextCursor: "cursor_one" }),
      )
      .mockResolvedValueOnce(
        listBody([
          incident(INCIDENT_TWO, {
            detected_at: "2026-08-28T10:00:00Z",
            created_at: "2026-08-28T10:00:00Z",
            updated_at: "2026-08-28T10:00:00Z",
          }),
        ]),
      );

    const first = await listPrivacyIncidents({ tenantId: TENANT, limit: 1 });
    const second = await listPrivacyIncidents({
      tenantId: TENANT,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(mergePrivacyIncidentPages([first, second]).incidents).toHaveLength(
      2,
    );
    expect(apiMock.get).toHaveBeenNthCalledWith(
      1,
      "/api/v1/privacy/incidents?limit=1",
      { signal: undefined, cache: "no-store" },
    );
    expect(apiMock.get).toHaveBeenNthCalledWith(
      2,
      "/api/v1/privacy/incidents?limit=1&cursor=cursor_one",
      { signal: undefined, cache: "no-store" },
    );
  });

  it("fails closed on extra fields, detail leakage, duplicates and order drift", () => {
    for (const body of [
      listBody([], { extra: true }),
      listBody([incident(INCIDENT_ONE), incident(INCIDENT_ONE)]),
      listBody([incident(INCIDENT_TWO), incident(INCIDENT_ONE)]),
      listBody([
        incident(INCIDENT_ONE, { jurisdiction_resolution: resolution() }),
      ]),
      listBody([], { nextCursor: "cursor" }),
    ]) {
      expect(() =>
        decodePrivacyIncidentPage(body, { tenantId: TENANT, limit: 100 }),
      ).toThrow(/unverifiable/iu);
    }
  });

  it("cross-binds detail and requires a matching release-held resolution", async () => {
    apiMock.get.mockResolvedValue({
      ...incident(),
      jurisdiction_resolution: resolution(),
    });
    await expect(
      getPrivacyIncident({ tenantId: TENANT, incidentId: INCIDENT_ONE }),
    ).resolves.toMatchObject({ id: INCIDENT_ONE });

    apiMock.get.mockResolvedValue({
      ...incident(INCIDENT_TWO),
      jurisdiction_resolution: resolution(),
    });
    await expect(
      getPrivacyIncident({ tenantId: TENANT, incidentId: INCIDENT_ONE }),
    ).rejects.toThrow(/unverifiable/iu);

    apiMock.get.mockResolvedValue({
      ...incident(),
      jurisdiction_resolution: { ...resolution(), recognized: [] },
    });
    await expect(
      getPrivacyIncident({ tenantId: TENANT, incidentId: INCIDENT_ONE }),
    ).rejects.toThrow(/unverifiable/iu);
  });

  it("cross-binds and orders the exact merged event ledger", async () => {
    apiMock.get.mockResolvedValue({
      incident_id: INCIDENT_ONE,
      events: [
        {
          event_id: EVENT_ONE,
          source: "incident_state_transitions",
          schema_version: 1,
          kind: "transition",
          at: "2026-08-29T10:00:00Z",
          to_state: "open",
          actor: "admin@example.test",
          reason: "incident opened",
        },
        {
          event_id: EVENT_TWO,
          source: "incident_notifications",
          schema_version: 1,
          kind: "notification",
          at: "2026-08-29T11:00:00Z",
          audience: "authority",
          actor: "legacy-operator",
        },
      ],
    });
    await expect(
      listPrivacyIncidentEvents({ tenantId: TENANT, incidentId: INCIDENT_ONE }),
    ).resolves.toMatchObject({
      incidentId: INCIDENT_ONE,
      events: [{ kind: "transition" }, { kind: "notification" }],
    });

    apiMock.get.mockResolvedValue({ incident_id: INCIDENT_TWO, events: [] });
    await expect(
      listPrivacyIncidentEvents({ tenantId: TENANT, incidentId: INCIDENT_ONE }),
    ).rejects.toThrow(/unverifiable/iu);
  });
});

describe("privacy incident mutation receipts", () => {
  it("creates online with the caller's stable key and verifies the detail receipt", async () => {
    const authority = authorizePrivacyIncidentAdmin(me(), TENANT, USER);
    apiMock.post.mockResolvedValue({
      ...incident(),
      jurisdiction_resolution: resolution(),
    });
    await expect(
      createPrivacyIncident({
        authority,
        incident: { summary: "Possible export", severity: "high" },
        idempotencyKey: "stable-create-key",
      }),
    ).resolves.toMatchObject({ id: INCIDENT_ONE, status: "open" });
    expect(apiMock.post).toHaveBeenCalledWith(
      "/api/v1/privacy/incidents",
      { summary: "Possible export", severity: "high" },
      {
        signal: undefined,
        requireOnline: true,
        idempotencyKey: "stable-create-key",
      },
    );
  });

  it("accepts only an exact transition receipt and never sends closure", async () => {
    const authority = authorizePrivacyIncidentAdmin(me(), TENANT, USER);
    apiMock.post.mockResolvedValue({
      incident_id: INCIDENT_ONE,
      from: "open",
      to: "contained",
      at: "2026-08-29T12:00:00Z",
    });
    await expect(
      transitionPrivacyIncident({
        authority,
        incidentId: INCIDENT_ONE,
        expectedFrom: "open",
        to: "contained",
        reason: "Access revoked",
        idempotencyKey: "stable-transition-key",
      }),
    ).resolves.toMatchObject({ from: "open", to: "contained" });

    apiMock.post.mockResolvedValue({
      incident_id: INCIDENT_ONE,
      from: "open",
      to: "notifications_pending",
      at: "2026-08-29T12:00:00Z",
    });
    await expect(
      transitionPrivacyIncident({
        authority,
        incidentId: INCIDENT_ONE,
        expectedFrom: "open",
        to: "contained",
        reason: "Access revoked",
        idempotencyKey: "stable-transition-key",
      }),
    ).rejects.toThrow(/exact transition receipt/iu);

    apiMock.post.mockClear();
    await expect(
      transitionPrivacyIncident({
        authority,
        incidentId: INCIDENT_ONE,
        expectedFrom: "open",
        to: "closed",
        reason: "Done",
        idempotencyKey: "stable-transition-key",
      }),
    ).rejects.toThrow(/release-held/iu);
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});
