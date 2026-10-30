import { beforeEach, describe, expect, it, vi } from "vitest";

const secureState = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureState.set(key, value);
  }),
  getItemAsync: vi.fn(async (key: string) => secureState.get(key) ?? null),
  deleteItemAsync: vi.fn(async (key: string) => {
    secureState.delete(key);
  }),
}));

// eslint-disable-next-line import/first
import type { OfflineMutationAuthScope } from "./offlineMutationContract";
// eslint-disable-next-line import/first
import {
  clearOfflineMutationFailures,
  listOfflineMutationFailures,
  recordOfflineMutationFailure,
  subscribeOfflineMutationFailures,
} from "./offlineMutationFailures";

function authScope(
  overrides: Partial<OfflineMutationAuthScope> = {},
): OfflineMutationAuthScope {
  const now = Date.now();
  return {
    baseUrl: "https://api.moosewave.com",
    tenantId: "tenant_1",
    principalId: "user_1",
    role: "editor",
    queuedAt: now,
    expiresAt: now + 2 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe("offline mutation failure queue", () => {
  beforeEach(() => {
    secureState.clear();
  });

  it("stores encrypted-vault records without raw server or customer text", async () => {
    const auth = authScope();
    await recordOfflineMutationFailure({
      auth,
      kind: "campaign_update",
      label: "Secret customer campaign: unreleased acquisition",
      operationId: "operation-00000001",
      error: new Error(
        "server rejected secret launch words for reader@example.com",
      ),
    });

    const rows = await listOfflineMutationFailures(auth);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "campaign_update",
      label: "Campaign edit",
      operationId: "operation-00000001",
      message: "The server could not sync this queued change.",
      principalId: "user_1",
      role: "editor",
    });
    const serializedSecureStore = JSON.stringify([...secureState.entries()]);
    expect(serializedSecureStore).not.toContain("secret launch words");
    expect(serializedSecureStore).not.toContain("reader@example.com");
    expect(serializedSecureStore).not.toContain("unreleased acquisition");
  });

  it("maps only allowlisted operational error categories", async () => {
    const auth = authScope();
    await recordOfflineMutationFailure({
      auth,
      kind: "sequence_save",
      label: "ignored",
      operationId: "operation-00000002",
      error: Object.assign(new Error("private upstream response"), {
        status: 403,
      }),
    });

    await expect(listOfflineMutationFailures(auth)).resolves.toMatchObject([
      {
        label: "Sequence changes",
        message: "Authorization changed. Sign in again before retrying.",
      },
    ]);
    expect(JSON.stringify([...secureState.values()])).not.toContain(
      "private upstream response",
    );
  });

  it("names the remedy for a sequence version conflict, not a generic failure", async () => {
    // `executeSequenceSave` catches the 412 itself and rethrows a
    // SequenceSaveAuthorityError, which carries a `code` and NO `status` —
    // so it used to fall past every branch and be filed as "The server could
    // not sync this queued change." The one failure whose cause the app knows
    // exactly was the one described most vaguely.
    const auth = authScope();
    await recordOfflineMutationFailure({
      auth,
      kind: "sequence_save",
      label: "ignored",
      operationId: "operation-00000009",
      error: Object.assign(
        new Error("This sequence changed elsewhere. Reload the latest draft."),
        { code: "sequence_save_requires_reload" },
      ),
    });

    await expect(listOfflineMutationFailures(auth)).resolves.toMatchObject([
      {
        label: "Sequence changes",
        message:
          "This sequence changed elsewhere. Open the sequence to load the latest version, then re-apply this change.",
      },
    ]);
  });

  it("pins the conflict code against the module that throws it", async () => {
    // The literal is duplicated in offlineMutationFailures.ts to avoid an
    // import cycle; this is what stops the two drifting apart into a conflict
    // that silently reads as a generic sync failure again.
    //
    // Asserted against the SOURCE rather than by importing the class:
    // offlineMutations reaches react-native transitively and cannot be loaded
    // in this node environment (house rule 6).
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const thrower = readFileSync(
      join(process.cwd(), "src/lib/offlineMutations.ts"),
      "utf8",
    );
    const reader = readFileSync(
      join(process.cwd(), "src/lib/offlineMutationFailures.ts"),
      "utf8",
    );
    expect(thrower).toContain('readonly code = "sequence_save_requires_reload"');
    expect(reader).toContain(
      'const SEQUENCE_RELOAD_CODE = "sequence_save_requires_reload"',
    );
  });

  it("tells a 409/412 conflict what to DO, not only what happened", async () => {
    const auth = authScope();
    await recordOfflineMutationFailure({
      auth,
      kind: "campaign_update",
      label: "ignored",
      operationId: "operation-00000010",
      error: Object.assign(new Error("upstream"), { status: 412 }),
    });
    const rows = await listOfflineMutationFailures(auth);
    expect(rows[0]?.message).toContain("load the latest version");
  });

  it("isolates failures by origin, workspace, principal, and effective role", async () => {
    const owner = authScope();
    const otherTenant = authScope({ tenantId: "tenant_2" });
    const otherUser = authScope({ principalId: "user_2" });
    const otherRole = authScope({ role: "viewer" });

    await recordOfflineMutationFailure({
      auth: owner,
      kind: "sequence_create",
      label: "ignored",
      operationId: "operation-00000003",
      error: "failed",
    });

    await expect(listOfflineMutationFailures(owner)).resolves.toHaveLength(1);
    await expect(listOfflineMutationFailures(otherTenant)).resolves.toEqual([]);
    await expect(listOfflineMutationFailures(otherUser)).resolves.toEqual([]);
    await expect(listOfflineMutationFailures(otherRole)).resolves.toEqual([]);
  });

  it("dismisses only the current identity and notifies subscribers", async () => {
    const notify = vi.fn();
    const unsubscribe = subscribeOfflineMutationFailures(notify);
    const one = authScope();
    const two = authScope({ tenantId: "tenant_2" });
    await recordOfflineMutationFailure({
      auth: one,
      kind: "sequence_save",
      label: "ignored",
      operationId: "operation-00000004",
      error: "failed one",
    });
    await recordOfflineMutationFailure({
      auth: two,
      kind: "sequence_create",
      label: "ignored",
      operationId: "operation-00000005",
      error: "failed two",
    });

    await clearOfflineMutationFailures(one);
    await expect(listOfflineMutationFailures(one)).resolves.toEqual([]);
    await expect(listOfflineMutationFailures(two)).resolves.toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});
