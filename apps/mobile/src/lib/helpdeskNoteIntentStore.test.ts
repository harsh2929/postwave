import { createHash } from "node:crypto";

import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HELPDESK_NOTE_INTENT_GLOBAL_CAPACITY,
  HELPDESK_NOTE_INTENT_PRINCIPAL_CAPACITY,
  completeHelpdeskNoteIntent,
  inspectHelpdeskNoteIntent,
  prepareHelpdeskNoteIntent,
  type HelpdeskNoteIntentScope,
} from "./helpdeskNoteIntentStore";

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: vi.fn(),
  randomUUID: vi.fn(),
}));

const RECOVERY_PRINCIPAL = JSON.stringify([
  "postwave.mobile.helpdesk-note-recovery.v2",
  "session-user",
  "https://api.postwave.test",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
]);
const OTHER_RECOVERY_PRINCIPAL = JSON.stringify([
  "postwave.mobile.helpdesk-note-recovery.v2",
  "session-user",
  "https://api.postwave.test",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
]);

function conversation(index: number): string {
  return `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
}

function scope(
  index: number,
  recoveryPrincipal = RECOVERY_PRINCIPAL,
): HelpdeskNoteIntentScope {
  return { recoveryPrincipal, conversationId: conversation(index) };
}

let stored: string | null;
let uuidCounter: number;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

beforeEach(() => {
  vi.clearAllMocks();
  stored = null;
  uuidCounter = 0;
  vi.mocked(Crypto.randomUUID).mockImplementation(() => {
    uuidCounter += 1;
    return `22222222-2222-4222-8222-${String(uuidCounter).padStart(12, "0")}`;
  });
  vi.mocked(Crypto.digestStringAsync).mockImplementation(
    async (_algorithm, value) => hash(value),
  );
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async () => stored);
  vi.mocked(SecureStore.setItemAsync).mockImplementation(
    async (_key, value) => {
      stored = value;
    },
  );
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => {
    stored = null;
  });
});

describe("Helpdesk internal-note recovery", () => {
  it("stores a bounded v2 envelope without principal, conversation, or note text", async () => {
    const first = await prepareHelpdeskNoteIntent({
      scope: scope(1),
      body: "Private note",
    });
    expect(stored).not.toContain("Private note");
    expect(stored).not.toContain(RECOVERY_PRINCIPAL);
    expect(stored).not.toContain(conversation(1));
    expect(first.idempotencyKey).toContain("mobile-helpdesk-note-");
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "postwave.mobile.helpdesk.note-intents.v2",
      expect.any(String),
      expect.any(Object),
    );
    expect(JSON.parse(stored ?? "null")).toMatchObject({
      version: 2,
      intents: [
        expect.objectContaining({ idempotencyKey: first.idempotencyKey }),
      ],
    });
  });

  it("reuses one key for exact same-thread text and holds different text", async () => {
    const first = await prepareHelpdeskNoteIntent({
      scope: scope(1),
      body: "Private note",
    });
    await expect(
      prepareHelpdeskNoteIntent({ scope: scope(1), body: "Private note" }),
    ).resolves.toEqual(first);
    await expect(
      prepareHelpdeskNoteIntent({ scope: scope(1), body: "Different note" }),
    ).rejects.toThrow(/exact unresolved note/u);
    expect(Crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it("does not let an ambiguous intent on A block unrelated conversation B", async () => {
    const first = await prepareHelpdeskNoteIntent({
      scope: scope(1),
      body: "Conversation A note",
    });
    await expect(inspectHelpdeskNoteIntent(scope(2))).resolves.toEqual({
      status: "none",
    });
    const second = await prepareHelpdeskNoteIntent({
      scope: scope(2),
      body: "Conversation B note",
    });
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    await expect(inspectHelpdeskNoteIntent(scope(1))).resolves.toMatchObject({
      status: "current",
      record: { idempotencyKey: first.idempotencyKey },
    });
    await expect(inspectHelpdeskNoteIntent(scope(2))).resolves.toMatchObject({
      status: "current",
      record: { idempotencyKey: second.idempotencyKey },
    });
  });

  it("keeps the same stable principal recoverable across request epochs", async () => {
    const epochAScope = scope(1);
    const epochBScope = { ...scope(1) };
    const first = await prepareHelpdeskNoteIntent({
      scope: epochAScope,
      body: "Private note",
    });
    await expect(inspectHelpdeskNoteIntent(epochBScope)).resolves.toMatchObject(
      {
        status: "current",
        record: { idempotencyKey: first.idempotencyKey },
      },
    );
    await completeHelpdeskNoteIntent(epochBScope, first.idempotencyKey);
    await expect(inspectHelpdeskNoteIntent(epochAScope)).resolves.toEqual({
      status: "none",
    });
  });

  it("does not let a different principal consume or settle another key", async () => {
    const first = await prepareHelpdeskNoteIntent({
      scope: scope(1),
      body: "Private note",
    });
    const otherScope = scope(1, OTHER_RECOVERY_PRINCIPAL);
    await expect(inspectHelpdeskNoteIntent(otherScope)).resolves.toEqual({
      status: "none",
    });
    await expect(
      completeHelpdeskNoteIntent(otherScope, first.idempotencyKey),
    ).rejects.toThrow(/record changed/u);
    const other = await prepareHelpdeskNoteIntent({
      scope: otherScope,
      body: "Private note",
    });
    expect(other.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("caps one principal without letting its signed-out orphans block another principal", async () => {
    for (
      let index = 1;
      index <= HELPDESK_NOTE_INTENT_PRINCIPAL_CAPACITY;
      index += 1
    ) {
      await prepareHelpdeskNoteIntent({
        scope: scope(index),
        body: `Private note ${index}`,
      });
    }
    const samePrincipalNextThread = scope(99);
    await expect(
      inspectHelpdeskNoteIntent(samePrincipalNextThread),
    ).resolves.toEqual({
      status: "principal_capacity_reached",
      capacity: HELPDESK_NOTE_INTENT_PRINCIPAL_CAPACITY,
    });
    await expect(
      prepareHelpdeskNoteIntent({
        scope: samePrincipalNextThread,
        body: "Another note",
      }),
    ).rejects.toThrow(/account already holds 4 unresolved/u);

    const laterUser = scope(100, OTHER_RECOVERY_PRINCIPAL);
    await expect(inspectHelpdeskNoteIntent(laterUser)).resolves.toEqual({
      status: "none",
    });
    await expect(
      prepareHelpdeskNoteIntent({ scope: laterUser, body: "Later user note" }),
    ).resolves.toMatchObject({ idempotencyKey: expect.any(String) });
  });

  it("fails closed at the independent global ceiling without evicting any orphan", async () => {
    for (
      let index = 1;
      index <= HELPDESK_NOTE_INTENT_GLOBAL_CAPACITY;
      index += 1
    ) {
      const principalIndex = Math.ceil(
        index / HELPDESK_NOTE_INTENT_PRINCIPAL_CAPACITY,
      );
      await prepareHelpdeskNoteIntent({
        scope: scope(index, `stable-principal-${principalIndex}`),
        body: `Private note ${index}`,
      });
    }
    const nextScope = scope(99, "new-stable-principal");
    await expect(inspectHelpdeskNoteIntent(nextScope)).resolves.toEqual({
      status: "device_capacity_reached",
      capacity: HELPDESK_NOTE_INTENT_GLOBAL_CAPACITY,
    });
    await expect(
      prepareHelpdeskNoteIntent({ scope: nextScope, body: "Another note" }),
    ).rejects.toThrow(/device already holds 16 unresolved/u);
    expect(JSON.parse(stored ?? "null").intents).toHaveLength(
      HELPDESK_NOTE_INTENT_GLOBAL_CAPACITY,
    );
  });

  it("exact completion removes only A and leaves B recoverable", async () => {
    const first = await prepareHelpdeskNoteIntent({
      scope: scope(1),
      body: "Conversation A note",
    });
    const second = await prepareHelpdeskNoteIntent({
      scope: scope(2),
      body: "Conversation B note",
    });
    await completeHelpdeskNoteIntent(scope(1), first.idempotencyKey);
    await expect(inspectHelpdeskNoteIntent(scope(1))).resolves.toEqual({
      status: "none",
    });
    await expect(inspectHelpdeskNoteIntent(scope(2))).resolves.toMatchObject({
      status: "current",
      record: { idempotencyKey: second.idempotencyKey },
    });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    await completeHelpdeskNoteIntent(scope(2), second.idempotencyKey);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
  });
});
