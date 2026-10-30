// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  fetchText: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
  fetchTextAuthed: mocks.fetchText,
}));

import {
  AudienceActivationContractError,
  authorizeAudienceActivationAdmin,
} from "@/lib/audience-activation-authority";
import {
  createAudienceDestination,
  disconnectAudienceDestination,
  getAudienceDestinationJobDiagnostics,
  listAudienceDestinations,
  updateAudienceDestination,
  type AudienceDestination,
} from "@/lib/audience-destinations-api";
import {
  getExclusionReceipt,
  listAudienceSyncs,
  updateAudienceSync,
} from "@/lib/audience-syncs-api";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DESTINATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LIST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SYNC = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const RUN = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const JOB = "99999999-9999-4999-8999-999999999999";
const NOW = "2026-08-29T12:00:00Z";

function me() {
  return {
    user_id: USER,
    tenant_id: TENANT,
    email: "admin@example.com",
    role: "admin" as const,
    effective_role: "admin" as const,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Workspace",
    workspace_slug: "workspace",
  };
}

function destination(
  config: Record<string, unknown> = {},
): AudienceDestination {
  return {
    id: DESTINATION,
    tenant_id: TENANT,
    provider: "meta",
    list_id: LIST,
    status: "draft",
    config,
    credential_reference_set: false,
    created_at: NOW,
    updated_at: NOW,
  };
}

function destinationWire(
  config: Record<string, unknown> = {},
): Omit<AudienceDestination, "credential_reference_set"> {
  const { credential_reference_set: _derived, ...wire } = destination(config);
  return wire;
}

function mockVersionedGet(
  value: unknown,
  resource: "audience-destination" | "audience-sync",
  id: string,
  version = 1788000000000000,
): void {
  mocks.get.mockImplementationOnce(
    async (
      _path: string,
      options?: { onResponse?: (response: Response) => void },
    ) => {
      options?.onResponse?.(
        new Response(null, {
          status: 200,
          headers: { etag: `"${resource}:${id}:v${version}"` },
        }),
      );
      return value;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("audience activation API contracts", () => {
  it("fails closed if a destination read echoes credential material", async () => {
    mocks.get.mockResolvedValueOnce({
      items: [destinationWire({ access_token: "live-token" })],
    });

    await expect(
      listAudienceDestinations({ tenantId: TENANT }),
    ).rejects.toBeInstanceOf(AudienceActivationContractError);
  });

  it("strips fixed credential masks before destination data can be cached", async () => {
    mocks.get.mockResolvedValueOnce({
      items: [
        destinationWire({
          credential_ref: "••••",
          audience_id: "aud-1",
        }),
      ],
    });

    const [row] = await listAudienceDestinations({ tenantId: TENANT });
    expect(row?.credential_reference_set).toBe(true);
    expect(row?.config).toEqual({ audience_id: "aud-1" });
    expect(row?.config).not.toHaveProperty("credential_ref");
  });

  it("requires online one-shot writes and rejects stale destination inventory", async () => {
    const authority = authorizeAudienceActivationAdmin(me(), TENANT, USER);
    mockVersionedGet(
      {
        ...destinationWire(),
        updated_at: "2026-08-29T12:01:00Z",
      },
      "audience-destination",
      DESTINATION,
    );

    await expect(
      updateAudienceDestination({
        authority,
        current: destination(),
        patch: { status: "active" },
        idempotencyKey: "test:destination:update",
      }),
    ).rejects.toThrow("changed after it was loaded");
    expect(mocks.patch).not.toHaveBeenCalled();

    mocks.post.mockResolvedValueOnce(destinationWire());
    await createAudienceDestination({
      authority,
      destination: {
        provider: "meta",
        list_id: LIST,
        config: { credential_ref: "vault://meta/main" },
      },
      idempotencyKey: "test:destination:create",
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/audience-destinations",
      expect.objectContaining({ provider: "meta" }),
      expect.objectContaining({
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: "test:destination:create",
      }),
    );
  });

  it("carries the exact fresh strong version into an atomic destination write", async () => {
    const authority = authorizeAudienceActivationAdmin(me(), TENANT, USER);
    const etag = `"audience-destination:${DESTINATION}:v1788000000000000"`;
    mockVersionedGet(
      destinationWire(),
      "audience-destination",
      DESTINATION,
    );
    mocks.patch.mockResolvedValueOnce({
      ...destinationWire(),
      status: "active",
    });

    await updateAudienceDestination({
      authority,
      current: destination(),
      patch: { status: "active" },
      idempotencyKey: "test:destination:atomic-update",
    });

    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/audience-destinations/${DESTINATION}`,
      { status: "active" },
      expect.objectContaining({
        headers: { "If-Match": etag },
        requireOnline: true,
        maxAttempts: 1,
      }),
    );
  });

  it("fails closed when a versioned destination read omits its strong ETag", async () => {
    mocks.get.mockResolvedValueOnce(destinationWire());
    const authority = authorizeAudienceActivationAdmin(me(), TENANT, USER);

    await expect(
      updateAudienceDestination({
        authority,
        current: destination(),
        patch: { status: "active" },
        idempotencyKey: "test:destination:missing-etag",
      }),
    ).rejects.toThrow("strong destination version");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("fails closed when a disconnect receipt contains a malformed optional field", async () => {
    const authority = authorizeAudienceActivationAdmin(me(), TENANT, USER);
    mockVersionedGet(destinationWire(), "audience-destination", DESTINATION);
    mocks.delete.mockResolvedValueOnce({
      ok: true,
      provider_cleanup: {
        provider: "meta",
        status: "operator_action_required",
        recorded_at: NOW,
        postwave_status: "disconnected",
        provider_cleanup_posture: "operator_managed_provider_console",
        managed_provider_cleanup: false,
        audience_cleanup_status: "operator_action_required",
        audience_membership_cleanup_status: "operator_action_required",
        credential_cleanup_status: "operator_action_required",
        credential_ref_present: "yes",
      },
    });

    await expect(
      disconnectAudienceDestination({
        authority,
        current: destination(),
        idempotencyKey: "test:destination:disconnect",
      }),
    ).rejects.toBeInstanceOf(AudienceActivationContractError);
  });

  it("rejects diagnostic secret echoes and drops unused provider bodies", async () => {
    const diagnosticEnvelope = (providerResponse: Record<string, unknown>) => ({
      destination: { ...destinationWire(), provider: "google_ads" },
      job: {
        id: JOB,
        tenant_id: TENANT,
        destination_id: DESTINATION,
        started_at: NOW,
        finished_at: NOW,
        status: "succeeded",
        members_synced: 10,
        external_job_id: "request-1",
        trigger_kind: "manual",
        source_members_observed: 11,
        cap_exceeded: false,
        created_at: NOW,
      },
      diagnostics: {
        provider: "google_ads",
        external_job_id: "request-1",
        provider_status: "SUCCESS",
        provider_response: providerResponse,
      },
    });

    mocks.get.mockResolvedValueOnce(
      diagnosticEnvelope({ access_token: "echoed-token" }),
    );
    await expect(
      getAudienceDestinationJobDiagnostics({
        tenantId: TENANT,
        destinationId: DESTINATION,
        jobId: JOB,
      }),
    ).rejects.toBeInstanceOf(AudienceActivationContractError);

    mocks.get.mockResolvedValueOnce(
      diagnosticEnvelope({ requestId: "request-1", status: "SUCCESS" }),
    );
    const result = await getAudienceDestinationJobDiagnostics({
      tenantId: TENANT,
      destinationId: DESTINATION,
      jobId: JOB,
    });
    expect(result.diagnostics).toEqual({
      provider: "google_ads",
      external_job_id: "request-1",
      provider_status: "SUCCESS",
    });
    expect(result.diagnostics).not.toHaveProperty("provider_response");
  });

  it("redacts webhook URL query data and rejects a secret echo", async () => {
    const sync = {
      id: SYNC,
      name: "Warehouse",
      source: { list_id: LIST },
      destination: {
        type: "webhook",
        url: "https://receiver.example/import?token=secret#fragment",
        secret_set: true,
        secret_hint: "••••1234",
        config: {},
      },
      schedule: "manual",
      enabled: true,
      created_at: NOW,
      updated_at: NOW,
    };
    mocks.get.mockResolvedValueOnce({ items: [sync] });

    const [row] = await listAudienceSyncs();
    expect(row?.destination.url).toBe("https://receiver.example/import");
    expect(row?.destination.url_redacted).toBe(true);
    expect(JSON.stringify(row)).not.toContain("token=secret");

    mocks.get.mockResolvedValueOnce({
      items: [
        {
          ...sync,
          destination: { ...sync.destination, secret: "echoed" },
        },
      ],
    });
    await expect(listAudienceSyncs()).rejects.toBeInstanceOf(
      AudienceActivationContractError,
    );
  });

  it("carries the exact fresh strong version into an atomic sync write", async () => {
    const authority = authorizeAudienceActivationAdmin(me(), TENANT, USER);
    const sync = {
      id: SYNC,
      name: "Warehouse",
      source: { list_id: LIST },
      destination: {
        type: "webhook" as const,
        url: "https://receiver.example/import",
        secret_set: true,
        config: {},
      },
      schedule: "manual" as const,
      enabled: true,
      created_at: NOW,
      updated_at: NOW,
    };
    mockVersionedGet(sync, "audience-sync", SYNC);
    mocks.patch.mockResolvedValueOnce({ ...sync, enabled: false });

    await updateAudienceSync({
      authority,
      current: {
        ...sync,
        destination: {
          ...sync.destination,
          url_redacted: false,
          credential_reference_set: false,
        },
      },
      patch: { enabled: false },
      idempotencyKey: "test:sync:atomic-update",
    });

    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/audience-syncs/${SYNC}`,
      { enabled: false },
      expect.objectContaining({
        headers: {
          "If-Match": `"audience-sync:${SYNC}:v1788000000000000"`,
        },
        requireOnline: true,
        maxAttempts: 1,
      }),
    );
  });

  it("accepts only signed, exact-schema exclusion CSV", async () => {
    const rowSignature = "a".repeat(64);
    const responseSignature = `t=1788000000,v1=${"b".repeat(64)}`;
    const csv =
      "subscriber_email,rule_class,rule_reason,purpose,consent_event_id,excluded_at,signature\n" +
      `ada@example.com,suppression,manual,targeted_ads,,${NOW},${rowSignature}\n`;
    mocks.fetchText.mockImplementationOnce(
      async (_path: string, options: { onResponse?: (response: Response) => void }) => {
        options.onResponse?.(
          new Response(null, {
            status: 200,
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="exclusion-receipt-${RUN}.csv"`,
              "x-postwave-receipt-signature": responseSignature,
            },
          }),
        );
        return csv;
      },
    );

    await expect(getExclusionReceipt(RUN)).resolves.toMatchObject({
      run_id: RUN,
      excluded_rows: 1,
      signature: responseSignature,
    });

    mocks.fetchText.mockImplementationOnce(
      async (_path: string, options: { onResponse?: (response: Response) => void }) => {
        options.onResponse?.(
          new Response(null, {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-disposition": `attachment; filename="exclusion-receipt-${RUN}.csv"`,
            },
          }),
        );
        return "{}";
      },
    );
    await expect(getExclusionReceipt(RUN)).rejects.toBeInstanceOf(
      AudienceActivationContractError,
    );
  });
});
