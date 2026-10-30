// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../../lib/secure-vault", () => ({
  vaultReadJSON: vault.read,
  vaultSetJSON: vault.write,
  vaultDelete: vault.remove,
}));

import {
  internalNoteOutcomeIsUnknown,
  internalNoteRecovery,
  sessionNoteRecoveryAuthority,
  sessionNoteRecoveryScope,
} from "../../components/helpdesk/internal-note-recovery";
import { desktopRouteIdentityScope } from "../../lib/desktop-route-runtime";
import { resetInternalNoteOperationExclusionForTests } from "../../lib/helpdesk-internal-note-operation";

const SESSION_USER = "11111111-1111-4111-8111-111111111111";
const SESSION_TENANT = "22222222-2222-4222-8222-222222222222";
const API_BASE = "https://api.example.test/gateway";
const AUTHORITY = sessionNoteRecoveryAuthority(
  SESSION_USER,
  SESSION_TENANT,
  API_BASE,
  0,
)!;
const IDENTITY = AUTHORITY.scope;
const CONVERSATION = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  resetInternalNoteOperationExclusionForTests();
  window.localStorage.clear();
  vault.read.mockReset();
  vault.write.mockReset();
  vault.remove.mockReset();
  vault.read.mockResolvedValue({ status: "missing" });
  vault.write.mockResolvedValue(undefined);
});

describe("internal note durable recovery", () => {
  it("domain-separates v3 by session principal and canonical full API base", () => {
    const legacyActorScope = desktopRouteIdentityScope(
      SESSION_USER,
      SESSION_TENANT,
    );
    const sameCanonicalBase = sessionNoteRecoveryScope(
      SESSION_USER,
      SESSION_TENANT,
      "https://API.EXAMPLE.test:443/gateway/",
    );
    const otherOrigin = sessionNoteRecoveryScope(
      SESSION_USER,
      SESSION_TENANT,
      "https://staging.example.test/gateway",
    );
    const otherBasePath = sessionNoteRecoveryScope(
      SESSION_USER,
      SESSION_TENANT,
      "https://api.example.test/other-gateway",
    );

    expect(IDENTITY).toMatch(/^v3-session-[0-9a-f]{16}$/u);
    expect(IDENTITY).not.toBe(legacyActorScope);
    expect(sameCanonicalBase).toBe(IDENTITY);
    expect(otherOrigin).not.toBe(IDENTITY);
    expect(otherBasePath).not.toBe(IDENTITY);
    expect(
      sessionNoteRecoveryScope("human", SESSION_TENANT, API_BASE),
    ).toBeNull();
    expect(
      sessionNoteRecoveryScope(SESSION_USER, `${SESSION_TENANT} `, API_BASE),
    ).toBeNull();
    expect(
      sessionNoteRecoveryScope(
        SESSION_USER,
        SESSION_TENANT,
        "https://user:secret@api.example.test/gateway",
      ),
    ).toBeNull();
  });

  it("holds an originless v2 checkpoint without adopting or replaying it", async () => {
    const legacyEnvelope = {
      version: 2,
      intents: [
        {
          signature: "a".repeat(43),
          conversationId: CONVERSATION,
          idempotencyKey: "legacy-key",
          state: "unknown",
          createdAt: "2026-08-24T00:00:00Z",
          updatedAt: "2026-08-24T00:00:00Z",
        },
      ],
    };
    vault.read.mockImplementation(async (key: string) =>
      key.includes("helpdesk-internal-note-intents.v2")
        ? { status: "ready", value: legacyEnvelope }
        : { status: "missing" },
    );

    await expect(
      internalNoteRecovery.prepare(
        IDENTITY,
        CONVERSATION,
        "private body",
        AUTHORITY.legacyV2Scope,
      ),
    ).resolves.toEqual({ status: "held", reason: "legacy-scope-held" });
    await expect(
      internalNoteRecovery.reviewExactReplay(
        IDENTITY,
        CONVERSATION,
        "private body",
        AUTHORITY.legacyV2Scope,
      ),
    ).resolves.toEqual({ status: "held", reason: "legacy-scope-held" });
    expect(vault.write).not.toHaveBeenCalled();
  });

  it("durably quarantines low-level corrupt v2 ciphertext before a later missing read", async () => {
    vault.read.mockResolvedValueOnce({ status: "corrupt" });

    await expect(
      internalNoteRecovery.prepare(
        IDENTITY,
        CONVERSATION,
        "private body",
        AUTHORITY.legacyV2Scope,
      ),
    ).resolves.toEqual({ status: "held", reason: "vault-corrupt" });
    expect(vault.read).toHaveBeenCalledWith(
      expect.stringContaining("helpdesk-internal-note-intents.v2."),
      { preserveCorrupt: true },
    );
    expect(
      window.localStorage.getItem(
        `postwave.helpdesk-note-quarantine.v2:${AUTHORITY.legacyV2Scope}`,
      ),
    ).toBe("1");

    vault.read.mockResolvedValue({ status: "missing" });
    await expect(
      internalNoteRecovery.prepare(
        IDENTITY,
        CONVERSATION,
        "private body",
        AUTHORITY.legacyV2Scope,
      ),
    ).resolves.toEqual({ status: "held", reason: "vault-corrupt" });
    expect(vault.read).toHaveBeenCalledTimes(1);
    expect(vault.write).not.toHaveBeenCalled();
  });

  it("holds an erased committed result instead of deleting its checkpoint", () => {
    expect(
      internalNoteOutcomeIsUnknown({
        kind: "http",
        status: 410,
        code: "internal_note_result_unavailable",
        message: "result tombstoned",
      }),
    ).toBe(true);
  });

  it("treats an unparseable 2xx mutation response as commit-ambiguous", () => {
    expect(
      internalNoteOutcomeIsUnknown({
        kind: "parse",
        message: "invalid JSON",
      }),
    ).toBe(true);
  });

  it("treats an unrecognized 409 as ambiguous and retains the original key", async () => {
    const prepared = await internalNoteRecovery.prepare(
      IDENTITY,
      CONVERSATION,
      "private body",
    );
    if (prepared.status !== "ready") throw new Error("prepare failed");
    expect(
      internalNoteOutcomeIsUnknown({
        kind: "http",
        status: 409,
        code: "new_unrecognized_conflict",
        message: "conflict semantics not frozen",
      }),
    ).toBe(true);

    const preparedEnvelope = vault.write.mock.calls[0]?.[1];
    vault.read.mockResolvedValue({ status: "ready", value: preparedEnvelope });
    await internalNoteRecovery.markUnknown(IDENTITY, prepared.signature);
    const heldEnvelope = vault.write.mock.calls.at(-1)?.[1];
    vault.read.mockResolvedValue({ status: "ready", value: heldEnvelope });
    vault.write.mockClear();

    await expect(
      internalNoteRecovery.reviewExactReplay(
        IDENTITY,
        CONVERSATION,
        "private body",
      ),
    ).resolves.toEqual({
      status: "ready",
      signature: prepared.signature,
      idempotencyKey: prepared.idempotencyKey,
    });
    expect(vault.write).not.toHaveBeenCalled();
  });

  it("keeps the same conversation held after a 410 outcome and restart", async () => {
    const prepared = await internalNoteRecovery.prepare(
      IDENTITY,
      CONVERSATION,
      "private body",
    );
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("prepare failed");

    const preparedEnvelope = vault.write.mock.calls[0]?.[1];
    vault.read.mockResolvedValue({ status: "ready", value: preparedEnvelope });
    expect(
      await internalNoteRecovery.markUnknown(IDENTITY, prepared.signature),
    ).toBe(true);
    const unknownEnvelope = vault.write.mock.calls.at(-1)?.[1];

    // Simulate a fresh renderer process reading the encrypted checkpoint.
    vault.read.mockResolvedValue({ status: "ready", value: unknownEnvelope });
    vault.write.mockClear();
    await expect(
      internalNoteRecovery.prepare(IDENTITY, CONVERSATION, "changed body"),
    ).resolves.toEqual({ status: "held", reason: "unresolved-intent" });
    await expect(
      internalNoteRecovery.reviewExactReplay(
        IDENTITY,
        CONVERSATION,
        "changed body",
      ),
    ).resolves.toEqual({ status: "held", reason: "unresolved-intent" });
    await expect(
      internalNoteRecovery.reviewExactReplay(
        IDENTITY,
        CONVERSATION,
        "private body",
      ),
    ).resolves.toEqual({
      status: "ready",
      signature: prepared.signature,
      idempotencyKey: prepared.idempotencyKey,
    });
    expect(vault.write).not.toHaveBeenCalled();
  });

  it("checkpoints only a body hash, conversation, and encrypted idempotency key", async () => {
    const body = "Confidential customer escalation";
    const prepared = await internalNoteRecovery.prepare(
      IDENTITY,
      CONVERSATION,
      body,
    );

    expect(prepared.status).toBe("ready");
    expect(vault.write).toHaveBeenCalledTimes(1);
    const [, envelope] = vault.write.mock.calls[0] as [string, unknown];
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(body);
    expect(serialized).not.toContain("runtimeId");
    expect(serialized).toContain(CONVERSATION);
    expect(serialized).toMatch(/"signature":"[A-Za-z0-9_-]{43}"/u);
    expect(serialized).toMatch(
      /"idempotencyKey":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/u,
    );
  });

  it("holds a recovered conversation indefinitely instead of minting a new key", async () => {
    await internalNoteRecovery.prepare(IDENTITY, CONVERSATION, "first body");
    const stored = vault.write.mock.calls[0]?.[1];
    vault.read.mockResolvedValue({ status: "ready", value: stored });
    vault.write.mockClear();

    await expect(
      internalNoteRecovery.prepare(IDENTITY, CONVERSATION, "changed body"),
    ).resolves.toEqual({ status: "held", reason: "unresolved-intent" });
    expect(vault.write).not.toHaveBeenCalled();
  });

  it("does not report a checkpoint settled until encrypted deletion succeeds", async () => {
    const prepared = await internalNoteRecovery.prepare(
      IDENTITY,
      CONVERSATION,
      "private body",
    );
    if (prepared.status !== "ready") throw new Error("prepare failed");
    const stored = vault.write.mock.calls[0]?.[1];
    vault.read.mockResolvedValue({ status: "ready", value: stored });
    vault.remove.mockImplementationOnce(() => {
      throw new Error("vault delete interrupted");
    });

    await expect(
      internalNoteRecovery.settle(IDENTITY, prepared.signature),
    ).resolves.toBe(false);
    expect(vault.remove).toHaveBeenCalledTimes(1);
  });

  it("quarantines corrupt recovery state and never treats it as empty", async () => {
    vault.read.mockResolvedValue({ status: "corrupt" });
    await expect(
      internalNoteRecovery.prepare(IDENTITY, CONVERSATION, "private note"),
    ).resolves.toEqual({ status: "held", reason: "vault-corrupt" });
    expect(vault.read).toHaveBeenCalledWith(
      expect.stringContaining("helpdesk-internal-note-intents.v3."),
      { preserveCorrupt: true },
    );

    vault.read.mockResolvedValue({ status: "missing" });
    await expect(
      internalNoteRecovery.prepare(IDENTITY, CONVERSATION, "private note"),
    ).resolves.toEqual({ status: "held", reason: "vault-corrupt" });
    expect(vault.write).not.toHaveBeenCalled();
  });
});
