// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  campaignTemplateDesignMutationFingerprint,
  clearAllCampaignTemplateDesignSessions,
  clearCampaignTemplateDesignSession,
  readCampaignTemplateDesignSession,
  writeCampaignTemplateDesignSession,
  type CampaignTemplateDesignPendingMutation,
  type CampaignTemplateDesignRecoveryScope,
  type CampaignTemplateDesignSessionInput,
} from "@/lib/campaign-template-design-session";

const SCOPE_A: CampaignTemplateDesignRecoveryScope = {
  tenantId: "tenant-a",
  userId: "user-a",
};
const SCOPE_B: CampaignTemplateDesignRecoveryScope = {
  tenantId: "tenant-a",
  userId: "user-b",
};
const SCOPE_C: CampaignTemplateDesignRecoveryScope = {
  tenantId: "tenant-b",
  userId: "user-a",
};
const SOURCE_ID = "reference-1";
const DESIGN_ID = "design-1";
const HASH = "a".repeat(64);

function fingerprint(
  operation: CampaignTemplateDesignPendingMutation["operation"],
  payload: CampaignTemplateDesignPendingMutation["payload"],
): string {
  return campaignTemplateDesignMutationFingerprint(
    operation,
    DESIGN_ID,
    payload,
  );
}

function adaptSession(
  overrides: Partial<CampaignTemplateDesignSessionInput> = {},
): CampaignTemplateDesignSessionInput {
  return {
    mode: "adapt",
    sourceTemplateId: SOURCE_ID,
    designIds: [DESIGN_ID],
    selectedDesignId: DESIGN_ID,
    ...overrides,
  };
}

function storedRecord(): { key: string; raw: string } {
  const result = writeCampaignTemplateDesignSession(SCOPE_A, adaptSession());
  expect(result.persisted).toBe(true);
  const key = window.localStorage.key(0);
  if (!key) throw new Error("Expected one recovery key");
  const raw = window.localStorage.getItem(key);
  if (!raw) throw new Error("Expected a persisted recovery record");
  return { key, raw };
}

function memoryStorage(
  overrides: Partial<Pick<Storage, "getItem" | "removeItem" | "setItem">> = {},
): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("campaign template design durable recovery", () => {
  it("persists and read-back verifies the complete scoped recovery record", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T10:00:00Z"));
    const createdAt = Date.now();

    const result = writeCampaignTemplateDesignSession(
      SCOPE_A,
      adaptSession({
        pendingCreate: {
          input: {
            mode: "adapt",
            source_template_id: SOURCE_ID,
            instructions: "Keep it concise",
            tone: "Confident",
            sections: ["Signal", "Takeaway"],
            variables: { first_name: "Ada", interests: ["design", "email"] },
            reference_template_ids: ["reference-2"],
          },
          idempotencyKeys: ["stable-create-key"],
        },
        pendingArchiveKeys: {
          [DESIGN_ID]: "stable-archive-key",
          "not-in-session": "must-not-survive",
        },
        pendingMutations: [
          {
            operation: "refine",
            designId: DESIGN_ID,
            fingerprint: fingerprint("refine", {
              instructions: "Shorter hero",
              base_revision: 1,
            }),
            payload: {
              instructions: "Shorter hero",
              base_revision: 1,
            },
            idempotencyKey: "stable-refine-key",
            createdAt,
          },
          {
            operation: "retry",
            designId: DESIGN_ID,
            fingerprint: fingerprint("retry", { base_attempt_count: 1 }),
            payload: { base_attempt_count: 1 },
            idempotencyKey: "stable-retry-key",
            createdAt,
          },
          {
            operation: "save",
            designId: DESIGN_ID,
            fingerprint: fingerprint("save", {
              revision: 2,
              output_hash: HASH,
              slug: "weekly-signal",
              name: "Weekly Signal",
            }),
            payload: {
              revision: 2,
              output_hash: HASH,
              slug: "weekly-signal",
              name: "Weekly Signal",
            },
            idempotencyKey: "stable-save-key",
            createdAt,
          },
          {
            operation: "create-campaign",
            designId: DESIGN_ID,
            fingerprint: fingerprint("create-campaign", {
              revision: 2,
              output_hash: HASH,
              name: "Weekly campaign",
              variables: { first_name: "Ada" },
              list_id: "00042",
            }),
            payload: {
              revision: 2,
              output_hash: HASH,
              name: "Weekly campaign",
              variables: { first_name: "Ada" },
              list_id: "00042",
            },
            idempotencyKey: "stable-campaign-key",
            createdAt,
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      status: "verified",
      persisted: true,
      session: {
        version: 2,
        scope: SCOPE_A,
        mode: "adapt",
        sourceTemplateId: SOURCE_ID,
        designIds: [DESIGN_ID],
        pendingArchiveKeys: {
          [DESIGN_ID]: "stable-archive-key",
        },
      },
    });
    expect(
      result.session?.pendingMutations?.map((item) => item.operation),
    ).toEqual(["refine", "retry", "save", "create-campaign"]);
    expect(
      readCampaignTemplateDesignSession(SCOPE_A, "adapt", SOURCE_ID),
    ).toEqual(result.session);
    expect(window.localStorage.length).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("never adopts another user or tenant record and clears one exact scope", () => {
    writeCampaignTemplateDesignSession(SCOPE_A, adaptSession());
    writeCampaignTemplateDesignSession(SCOPE_B, adaptSession());
    writeCampaignTemplateDesignSession(SCOPE_C, adaptSession());

    expect(
      readCampaignTemplateDesignSession(SCOPE_A, "adapt", SOURCE_ID)?.scope,
    ).toEqual(SCOPE_A);
    expect(
      readCampaignTemplateDesignSession(SCOPE_B, "adapt", SOURCE_ID)?.scope,
    ).toEqual(SCOPE_B);
    expect(
      readCampaignTemplateDesignSession(SCOPE_C, "adapt", SOURCE_ID)?.scope,
    ).toEqual(SCOPE_C);
    expect(
      readCampaignTemplateDesignSession(
        { tenantId: "tenant-c", userId: "user-c" },
        "adapt",
        SOURCE_ID,
      ),
    ).toBeNull();

    clearCampaignTemplateDesignSession(SCOPE_A, "adapt", SOURCE_ID);
    expect(
      readCampaignTemplateDesignSession(SCOPE_A, "adapt", SOURCE_ID),
    ).toBeNull();
    expect(
      readCampaignTemplateDesignSession(SCOPE_B, "adapt", SOURCE_ID),
    ).not.toBeNull();
    expect(
      readCampaignTemplateDesignSession(SCOPE_C, "adapt", SOURCE_ID),
    ).not.toBeNull();
  });

  it("rejects oversized raw storage before attempting JSON.parse", () => {
    const { key } = storedRecord();
    window.localStorage.setItem(key, "x".repeat(1_024 * 1_024 + 1));
    const parse = vi.spyOn(JSON, "parse");

    expect(
      readCampaignTemplateDesignSession(SCOPE_A, "adapt", SOURCE_ID),
    ).toBeNull();
    expect(parse).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("rejects and removes cross-scope, unknown, and structurally tampered records", () => {
    const { key, raw } = storedRecord();

    const expectRejected = (
      mutate: (record: Record<string, unknown>) => void,
    ) => {
      const record = JSON.parse(raw) as Record<string, unknown>;
      mutate(record);
      window.localStorage.setItem(key, JSON.stringify(record));
      expect(
        readCampaignTemplateDesignSession(SCOPE_A, "adapt", SOURCE_ID),
      ).toBeNull();
      expect(window.localStorage.getItem(key)).toBeNull();
    };

    expectRejected((record) => {
      (record.scope as Record<string, unknown>).userId = "user-b";
    });
    expectRejected((record) => {
      record.unbounded = "unknown";
    });
    expectRejected((record) => {
      record.designIds = [DESIGN_ID, DESIGN_ID];
    });
    expectRejected((record) => {
      record.selectedDesignId = "not-in-session";
    });
    expectRejected((record) => {
      record.pendingCreate = {
        input: {
          mode: "adapt",
          source_template_id: SOURCE_ID,
          instructions: "x".repeat(4_001),
        },
        idempotencyKeys: ["stable-create-key"],
      };
    });
    expectRejected((record) => {
      record.pendingMutations = [
        {
          operation: "save",
          designId: DESIGN_ID,
          fingerprint: "save-fingerprint",
          payload: {
            revision: 1,
            output_hash: "not-a-hash",
            slug: "weekly",
          },
          idempotencyKey: "save-key",
          createdAt: record.updatedAt,
        },
      ];
    });
  });

  it("rejects a pending mutation whose fingerprint no longer matches its payload", () => {
    const payload = { base_attempt_count: 1 };
    const result = writeCampaignTemplateDesignSession(
      SCOPE_A,
      adaptSession({
        pendingMutations: [
          {
            operation: "retry",
            designId: DESIGN_ID,
            fingerprint: fingerprint("retry", payload),
            payload,
            idempotencyKey: "retry-key",
            createdAt: Date.now(),
          },
        ],
      }),
    );
    expect(result.persisted).toBe(true);
    const key = window.localStorage.key(0)!;
    const record = JSON.parse(window.localStorage.getItem(key)!) as {
      pendingMutations: Array<{ payload: { base_attempt_count: number } }>;
    };
    record.pendingMutations[0]!.payload.base_attempt_count = 2;
    window.localStorage.setItem(key, JSON.stringify(record));

    expect(
      readCampaignTemplateDesignSession(SCOPE_A, "adapt", SOURCE_ID),
    ).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("rejects invalid or unbounded write inputs without touching storage", () => {
    const longBrief = writeCampaignTemplateDesignSession(SCOPE_A, {
      mode: "generate",
      designIds: [],
      pendingCreate: {
        input: {
          mode: "generate",
          brief: "x".repeat(8_001),
        },
        idempotencyKeys: ["create-key"],
      },
    });
    expect(longBrief).toEqual({
      status: "invalid",
      persisted: false,
      session: null,
    });

    const oversizedMap = writeCampaignTemplateDesignSession(SCOPE_A, {
      mode: "generate",
      designIds: [],
      pendingCreate: {
        input: {
          mode: "generate",
          brief: "Newsletter",
          variables: { payload: "x".repeat(128 * 1_024) },
        },
        idempotencyKeys: ["create-key"],
      },
    });
    expect(oversizedMap.status).toBe("invalid");

    const badMutation = writeCampaignTemplateDesignSession(
      SCOPE_A,
      adaptSession({
        pendingMutations: [
          {
            operation: "retry",
            designId: DESIGN_ID,
            fingerprint: "retry-fingerprint",
            payload: {
              base_attempt_count: 1,
              unexpected: true,
            } as { base_attempt_count: number },
            idempotencyKey: "bad\nkey",
            createdAt: Date.now(),
          },
        ],
      }),
    );
    expect(badMutation.status).toBe("invalid");

    expect(
      writeCampaignTemplateDesignSession(
        { tenantId: "anon", userId: "user-a" },
        adaptSession(),
      ).status,
    ).toBe("invalid");
    expect(window.localStorage.length).toBe(0);
  });

  it("reports unavailable, failed, and unverifiable persistence distinctly", () => {
    const unavailable = vi
      .spyOn(window, "localStorage", "get")
      .mockImplementation(() => {
        throw new Error("privacy mode");
      });
    const unavailableResult = writeCampaignTemplateDesignSession(
      SCOPE_A,
      adaptSession(),
    );
    expect(unavailableResult).toMatchObject({
      status: "storage_unavailable",
      persisted: false,
      session: { scope: SCOPE_A },
    });
    unavailable.mockRestore();

    const writeFailureStorage = memoryStorage({
      setItem() {
        throw new Error("quota");
      },
    });
    const writeFailure = vi
      .spyOn(window, "localStorage", "get")
      .mockReturnValue(writeFailureStorage);
    expect(
      writeCampaignTemplateDesignSession(SCOPE_A, adaptSession()),
    ).toMatchObject({
      status: "write_failed",
      persisted: false,
      session: { designIds: [DESIGN_ID] },
    });
    writeFailure.mockRestore();

    const ignoredWriteStorage = memoryStorage({
      setItem() {
        // Simulate a host that accepts the call without storing the bytes.
      },
    });
    const ignoredWrite = vi
      .spyOn(window, "localStorage", "get")
      .mockReturnValue(ignoredWriteStorage);
    expect(
      writeCampaignTemplateDesignSession(SCOPE_A, adaptSession()),
    ).toMatchObject({
      status: "verification_failed",
      persisted: false,
      session: { designIds: [DESIGN_ID] },
    });
    expect(ignoredWriteStorage.length).toBe(0);
    ignoredWrite.mockRestore();
  });

  it("expires records and future-dated pending mutations fail closed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00Z"));
    writeCampaignTemplateDesignSession(SCOPE_A, adaptSession());
    vi.setSystemTime(new Date("2026-07-30T00:00:00.001Z"));
    expect(
      readCampaignTemplateDesignSession(SCOPE_A, "adapt", SOURCE_ID),
    ).toBeNull();

    vi.setSystemTime(new Date("2026-07-30T12:00:00Z"));
    expect(
      writeCampaignTemplateDesignSession(
        SCOPE_A,
        adaptSession({
          pendingMutations: [
            {
              operation: "retry",
              designId: DESIGN_ID,
              fingerprint: fingerprint("retry", { base_attempt_count: 1 }),
              payload: { base_attempt_count: 1 },
              idempotencyKey: "retry-key",
              createdAt: Date.now() + 60_001,
            },
          ],
        }),
      ).status,
    ).toBe("invalid");
  });

  it("clears every v2 recovery record while preserving unrelated storage", () => {
    writeCampaignTemplateDesignSession(SCOPE_A, adaptSession());
    writeCampaignTemplateDesignSession(SCOPE_B, adaptSession());
    window.localStorage.setItem("unrelated", "preserve");

    clearAllCampaignTemplateDesignSessions();

    expect(
      readCampaignTemplateDesignSession(SCOPE_A, "adapt", SOURCE_ID),
    ).toBeNull();
    expect(
      readCampaignTemplateDesignSession(SCOPE_B, "adapt", SOURCE_ID),
    ).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("preserve");
  });
});
