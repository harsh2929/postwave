import { QueryClient, type MutationState } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  OFFLINE_MUTATION_KEYS,
  type OfflineMutationAuthScope,
} from "./offlineMutationContract";
import {
  discardPausedOfflineMutations,
  dismissSettledOfflineMutationHistory,
  listOfflineMutationQueue,
} from "./offlineMutationQueue";

const NOW = 1_750_000_000_000;

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
    auth?: OfflineMutationAuthScope;
    operationId?: string;
    status?: MutationState["status"];
    paused?: boolean;
  },
) {
  const auth = input.auth ?? scope();
  const variables = {
    auth,
    operationId: input.operationId ?? "operation-00000001",
    name: "Safe metadata only",
  };
  return client.getMutationCache().build(
    client,
    {
      mutationKey: input.key,
      mutationFn: async () => ({ ok: true }),
    },
    {
      context: undefined,
      data: input.status === "success" ? { ok: true } : undefined,
      error: input.status === "error" ? new Error("failed") : null,
      failureCount: input.status === "error" ? 1 : 0,
      failureReason: input.status === "error" ? new Error("failed") : null,
      isPaused: input.paused ?? false,
      status: input.status ?? "pending",
      variables,
      submittedAt: auth.queuedAt,
    },
  );
}

describe("offline mutation queue visibility", () => {
  it("reports queued, syncing, sent, and failed states with expiry metadata", () => {
    const client = new QueryClient();
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.sequenceCreate,
      paused: true,
      operationId: "operation-00000001",
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.sequenceSave,
      operationId: "operation-00000002",
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.campaignUpdate,
      operationId: "operation-00000003",
      status: "success",
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.sequenceSave,
      operationId: "operation-00000004",
      status: "error",
    });

    expect(listOfflineMutationQueue(client, scope(), NOW)).toMatchObject([
      { status: "queued", cancellable: true, retrySafe: true },
      { status: "syncing", cancellable: false, retrySafe: true },
      { status: "sent", cancellable: false, retrySafe: true },
      { status: "failed", cancellable: false, retrySafe: true },
    ]);
  });

  it("hides every operation from another origin, tenant, user, or role", () => {
    const client = new QueryClient();
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.sequenceCreate,
      auth: scope({ principalId: "user_2" }),
      paused: true,
    });
    addMutation(client, {
      key: ["not", "allowlisted"],
      paused: true,
    });

    expect(listOfflineMutationQueue(client, scope(), NOW)).toEqual([]);
  });

  it("cancels only explicitly selected paused operations for this identity", () => {
    const client = new QueryClient();
    const paused = addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.sequenceCreate,
      paused: true,
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.sequenceSave,
      paused: false,
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.campaignUpdate,
      auth: scope({ tenantId: "tenant_2" }),
      paused: true,
    });

    expect(
      discardPausedOfflineMutations(
        client,
        scope(),
        new Set([paused.mutationId]),
      ),
    ).toBe(1);
    expect(client.getMutationCache().getAll()).toHaveLength(2);
  });

  it("dismisses settled history without removing active or queued writes", () => {
    const client = new QueryClient();
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.sequenceCreate,
      paused: true,
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.sequenceSave,
      status: "success",
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.campaignUpdate,
      status: "error",
    });

    expect(dismissSettledOfflineMutationHistory(client, scope())).toBe(2);
    expect(listOfflineMutationQueue(client, scope(), NOW)).toMatchObject([
      { status: "queued" },
    ]);
  });

  it("expires sent confirmations but keeps queued operations visible", () => {
    const client = new QueryClient();
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.sequenceCreate,
      paused: true,
    });
    addMutation(client, {
      key: OFFLINE_MUTATION_KEYS.sequenceSave,
      status: "success",
    });

    expect(
      listOfflineMutationQueue(client, scope(), NOW + 60_001),
    ).toMatchObject([{ status: "queued" }]);
  });
});
