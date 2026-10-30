import {
  QueryClient,
  onlineManager,
  type MutationState,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OFFLINE_MUTATION_KEYS,
  type OfflineMutationAuthScope,
} from "./offlineMutationContract";
import { listOfflineMutationQueue } from "./offlineMutationQueue";
import {
  discardQueuedWrite,
  findQueuedWriteDetail,
  listQueuedWriteDetails,
  rebuildQueuedVariables,
  reissueQueuedWrite,
  type QueuedWriteDetail,
} from "./queuedWriteDetail";

const NOW = 1_750_000_000_000;
const META = { offlineSafe: true } as const;

function scope(
  overrides: Partial<OfflineMutationAuthScope> = {},
): OfflineMutationAuthScope {
  return {
    baseUrl: "https://api.moosewave.com",
    tenantId: "tenant_1",
    principalId: "user_1",
    role: "editor",
    queuedAt: NOW,
    expiresAt: NOW + 2 * 60 * 60 * 1000,
    ...overrides,
  };
}

function addMutation(
  client: QueryClient,
  input: {
    key: readonly string[];
    variables: Record<string, unknown>;
    status?: MutationState["status"];
    paused?: boolean;
    error?: unknown;
  },
) {
  return client.getMutationCache().build(
    client,
    { mutationKey: [...input.key], mutationFn: async () => ({ ok: true }) },
    {
      context: undefined,
      data: undefined,
      error: input.status === "error" ? (input.error ?? new Error("failed")) : null,
      failureCount: input.status === "error" ? 1 : 0,
      failureReason: null,
      isPaused: input.paused ?? false,
      status: input.status ?? "pending",
      variables: input.variables,
      submittedAt: NOW,
    },
  );
}

function entityVars(overrides: Record<string, unknown> = {}) {
  return {
    auth: scope(),
    operationId: "operation-00000001",
    method: "PATCH",
    path: "/api/v1/tags/12",
    body: { name: "VIP" },
    invalidateRoots: ["tags"],
    label: "Rename tag",
    queuedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  onlineManager.setOnline(true);
});

describe("listQueuedWriteDetails", () => {
  it("reads the verb, path and body of every kind the queue can hold", () => {
    const client = new QueryClient();
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.entityWrite,
      variables: entityVars(),
      paused: true,
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.campaignUpdate,
      variables: {
        auth: scope(),
        operationId: "operation-00000002",
        id: "c 1",
        subject: "Old",
        fields: { subject: "New", preview_text: "P" },
      },
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.campaignUpdate,
      variables: {
        auth: scope(),
        operationId: "operation-00000003",
        id: "c2",
        subject: "Legacy subject",
      },
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.sequenceCreate,
      variables: { auth: scope(), operationId: "operation-00000004", name: "Welcome" },
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.sequenceSave,
      variables: {
        auth: scope(),
        operationId: "operation-00000005",
        id: "s1",
        baseVersion: 3,
        steps: [{ kind: "wait" }],
      },
    });

    const details = listQueuedWriteDetails(client, scope(), NOW);
    const byOp = new Map(details.map((d) => [d.operationId, d]));

    expect(byOp.get("operation-00000001")).toMatchObject({
      kind: "entity_write",
      method: "PATCH",
      path: "/api/v1/tags/12",
      body: { name: "VIP" },
      label: "Rename tag",
      status: "queued",
      editable: true,
      failure: null,
    });
    expect(byOp.get("operation-00000002")).toMatchObject({
      kind: "campaign_update",
      method: "PATCH",
      path: "/api/v1/campaigns/c%201",
      body: { subject: "New", preview_text: "P" },
      status: "syncing",
    });
    // A record queued by an older build carries only `subject`.
    expect(byOp.get("operation-00000003")?.body).toEqual({ subject: "Legacy subject" });
    expect(byOp.get("operation-00000004")).toMatchObject({
      kind: "sequence_create",
      method: "POST",
      path: "/api/v1/voice/sequences",
      body: { name: "Welcome" },
    });
    expect(byOp.get("operation-00000005")).toMatchObject({
      kind: "sequence_save",
      method: "PATCH",
      path: "/api/v1/voice/sequences/s1",
      editable: false,
    });
  });

  it("reads the failure's status and server code off the mutation error", () => {
    const client = new QueryClient();
    const error = Object.assign(new Error("slug is taken"), {
      status: 409,
      code: "slug_taken",
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.entityWrite,
      variables: entityVars({ path: "/api/v1/forms/9", body: { slug: "x" } }),
      status: "error",
      error,
    });
    const [detail] = listQueuedWriteDetails(client, scope(), NOW);
    expect(detail?.status).toBe("failed");
    expect(detail?.failure).toEqual({
      status: 409,
      code: "slug_taken",
      message: "slug is taken",
    });
  });

  it("never lists another identity's writes, and finds one by operation id", () => {
    const client = new QueryClient();
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.entityWrite,
      variables: entityVars({ auth: scope({ principalId: "someone_else" }) }),
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.entityWrite,
      variables: entityVars({ operationId: "operation-00000009" }),
    });
    expect(listQueuedWriteDetails(client, scope(), NOW)).toHaveLength(1);
    expect(
      findQueuedWriteDetail(client, scope(), "operation-00000009", NOW)?.path,
    ).toBe("/api/v1/tags/12");
    expect(findQueuedWriteDetail(client, scope(), "operation-00000001", NOW)).toBeNull();
  });

  it("ignores entity writes whose persisted verb or path is malformed", () => {
    const client = new QueryClient();
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.entityWrite,
      variables: entityVars({ method: "DELETE" }),
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.entityWrite,
      variables: entityVars({ path: 42, operationId: "operation-00000002" }),
    });
    expect(listQueuedWriteDetails(client, scope(), NOW)).toEqual([]);
  });
});

describe("rebuildQueuedVariables", () => {
  const fresh = scope({ queuedAt: NOW + 5_000, expiresAt: NOW + 7_205_000 });

  function detailOf(
    kind: QueuedWriteDetail["kind"],
    variables: Record<string, unknown>,
    extra: Partial<QueuedWriteDetail> = {},
  ): QueuedWriteDetail {
    return {
      mutationId: 1,
      operationId: "operation-00000001",
      kind,
      label: "x",
      status: "failed",
      method: "PATCH",
      path: "/api/v1/tags/12",
      body: variables.body,
      failure: null,
      editable: kind !== "sequence_save",
      variables,
      ...extra,
    };
  }

  it("keeps the operation id and route, restarts the TTL, and swaps the body", () => {
    const result = rebuildQueuedVariables(
      detailOf("entity_write", entityVars()),
      { name: "VIP customers" },
      fresh,
    );
    expect(result).toEqual({
      ok: true,
      variables: {
        auth: fresh,
        operationId: "operation-00000001",
        method: "PATCH",
        path: "/api/v1/tags/12",
        body: { name: "VIP customers" },
        invalidateRoots: ["tags"],
        label: "Rename tag",
        queuedAt: new Date(NOW + 5_000).toISOString(),
      },
    });
  });

  it("omits the body key entirely when the edit removed the body", () => {
    const result = rebuildQueuedVariables(
      detailOf("entity_write", entityVars()),
      undefined,
      fresh,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect("body" in result.variables).toBe(false);
  });

  it("refuses a non-object entity body", () => {
    const result = rebuildQueuedVariables(
      detailOf("entity_write", entityVars()),
      ["not", "an", "object"],
      fresh,
    );
    expect(result).toEqual({ ok: false, error: "The body must be a JSON object." });
  });

  it("rebuilds a campaign edit only from the four queueable fields", () => {
    const original = {
      auth: scope(),
      operationId: "operation-00000001",
      id: "c1",
      subject: "Old",
      fields: { subject: "Old", from_name: "Us" },
    };
    const ok = rebuildQueuedVariables(
      detailOf("campaign_update", original),
      { from_name: "Team" },
      fresh,
    );
    expect(ok).toEqual({
      ok: true,
      variables: {
        auth: fresh,
        operationId: "operation-00000001",
        id: "c1",
        // Falls back to the original subject when the edit no longer carries one.
        subject: "Old",
        fields: { from_name: "Team" },
      },
    });
    expect(
      rebuildQueuedVariables(detailOf("campaign_update", original), { status: "scheduled" }, fresh),
    ).toMatchObject({ ok: false, error: expect.stringContaining('"status"') });
    expect(
      rebuildQueuedVariables(detailOf("campaign_update", original), { subject: 3 }, fresh),
    ).toMatchObject({ ok: false, error: '"subject" must be text.' });
    expect(
      rebuildQueuedVariables(detailOf("campaign_update", original), {}, fresh),
    ).toMatchObject({ ok: false });
  });

  it("rebuilds a sequence create from a trimmed name and refuses an empty one", () => {
    const original = { auth: scope(), operationId: "operation-00000001", name: "Old" };
    expect(
      rebuildQueuedVariables(detailOf("sequence_create", original), { name: "  Welcome  " }, fresh),
    ).toEqual({
      ok: true,
      variables: { auth: fresh, operationId: "operation-00000001", name: "Welcome" },
    });
    expect(
      rebuildQueuedVariables(detailOf("sequence_create", original), { name: "   " }, fresh),
    ).toMatchObject({ ok: false });
  });

  it("never rebuilds a sequence save — the builder owns the step list", () => {
    const result = rebuildQueuedVariables(
      detailOf("sequence_save", { auth: scope(), operationId: "operation-00000001", id: "s1", steps: [] }),
      { steps: [] },
      fresh,
    );
    expect(result.ok).toBe(false);
  });
});

describe("reissueQueuedWrite", () => {
  it("replaces the failed mutation with one that runs the registered executor", async () => {
    const client = new QueryClient();
    const executor = vi.fn(async (vars: unknown) => ({ echoed: vars }));
    client.setMutationDefaults([...OFFLINE_MUTATION_KEYS.entityWrite], {
      mutationFn: executor,
    });
    const failed = addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.entityWrite,
      variables: entityVars(),
      status: "error",
    });
    const [detail] = listQueuedWriteDetails(client, scope(), NOW);
    expect(detail).toBeDefined();
    const variables = { ...entityVars(), body: { name: "Fixed" } };

    const reissued = reissueQueuedWrite(client, detail!, variables, { ...META });
    await expect(reissued.settled).resolves.toBe("sent");

    const all = client.getMutationCache().getAll();
    expect(all.some((m) => m.mutationId === failed.mutationId)).toBe(false);
    const replacement = all.find((m) => m.mutationId === reissued.mutationId);
    expect(replacement?.options.mutationKey).toEqual(OFFLINE_MUTATION_KEYS.entityWrite);
    expect(replacement?.options.meta).toEqual(META);
    // TanStack passes a second `{ client, meta, mutationKey }` context argument;
    // the assertion is about the VARIABLES the executor received.
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]?.[0]).toEqual(variables);
    expect(replacement?.state.status).toBe("success");
  });

  it("pauses as a queued, cancellable row while offline and does not run the executor", () => {
    const client = new QueryClient();
    const executor = vi.fn(async () => ({}));
    client.setMutationDefaults([...OFFLINE_MUTATION_KEYS.entityWrite], {
      mutationFn: executor,
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.entityWrite,
      variables: entityVars(),
      status: "error",
    });
    const [detail] = listQueuedWriteDetails(client, scope(), NOW);
    onlineManager.setOnline(false);

    const reissued = reissueQueuedWrite(client, detail!, entityVars(), { ...META });

    const rows = listOfflineMutationQueue(client, scope(), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mutationId: reissued.mutationId,
      status: "queued",
      cancellable: true,
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it("reports a rejecting executor as failed without an unhandled rejection", async () => {
    const client = new QueryClient();
    client.setMutationDefaults([...OFFLINE_MUTATION_KEYS.entityWrite], {
      mutationFn: async () => {
        throw Object.assign(new Error("still conflicting"), { status: 409 });
      },
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.entityWrite,
      variables: entityVars(),
      status: "error",
    });
    const [detail] = listQueuedWriteDetails(client, scope(), NOW);
    const reissued = reissueQueuedWrite(client, detail!, entityVars(), { ...META });
    await expect(reissued.settled).resolves.toBe("failed");
    const replacement = client
      .getMutationCache()
      .getAll()
      .find((m) => m.mutationId === reissued.mutationId);
    expect(replacement?.state.status).toBe("error");
    expect(findQueuedWriteDetail(client, scope(), "operation-00000001", NOW)?.failure).toMatchObject({
      status: 409,
    });
  });
});

describe("discardQueuedWrite", () => {
  it("removes a failed or queued write but leaves one that is on the wire", () => {
    const client = new QueryClient();
    const failed = addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.entityWrite,
      variables: entityVars(),
      status: "error",
    });
    const syncing = addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.entityWrite,
      variables: entityVars({ operationId: "operation-00000002" }),
    });
    expect(discardQueuedWrite(client, { mutationId: failed.mutationId, status: "failed" })).toBe(true);
    expect(discardQueuedWrite(client, { mutationId: syncing.mutationId, status: "syncing" })).toBe(false);
    expect(discardQueuedWrite(client, { mutationId: 999, status: "failed" })).toBe(false);
    const remaining = client.getMutationCache().getAll();
    expect(remaining.map((m) => m.mutationId)).toEqual([syncing.mutationId]);
  });
});
