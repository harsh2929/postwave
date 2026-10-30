// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  apiRequest: mocks.apiRequest,
}));

import {
  campaignTemplateDesignsApi,
  campaignTemplateDesignCreateAttemptKey,
  campaignTemplateDesignResumeKey,
  clearCampaignTemplateDesignCreateAttempt,
  clearCampaignTemplateDesignResume,
  decodeCampaignTemplateDesignDraft,
  decodeCampaignTemplateDesignSummary,
  pollCampaignTemplateDesign,
  readCampaignTemplateDesignCreateAttempt,
  readCampaignTemplateDesignResume,
  writeCampaignTemplateDesignCreateAttempt,
  writeCampaignTemplateDesignResume,
  type CampaignTemplateDesignDraft,
} from "../../lib/api/campaign-template-designs";
import { purgePrivateSessionState } from "../../lib/private-session-state";

const OUTPUT_HASH = "a".repeat(64);
const SCOPE = "0123456789abcdef";
const OTHER_SCOPE = "fedcba9876543210";

function design(
  status: CampaignTemplateDesignDraft["status"] = "ready",
): CampaignTemplateDesignDraft {
  return {
    id: "design-1",
    mode: "generate",
    status,
    reference_template_ids: [],
    current_revision: status === "queued" ? 0 : 1,
    ...(status === "queued"
      ? {}
      : {
          revision: {
            id: "revision-1",
            draft_id: "design-1",
            revision: 1,
            operation: "initial",
            output: {
              name: "Monthly notes",
              subject: "July notes",
              body_html: "<h1>July notes</h1>",
              variables: {},
              unresolved_variables: [],
              reference_template_ids: [],
              warnings: [],
            },
            output_hash: OUTPUT_HASH,
            validation: {
              status: "pass",
              checks: [
                {
                  code: "active_content",
                  status: "pass",
                  message: "No active content was found.",
                },
              ],
            },
            warnings: [],
            created_at: "2026-07-29T00:00:00Z",
          },
        }),
    attempt_count: 1,
    ...(status === "failed"
      ? {
          last_error_code: "generator_failed",
          last_error_message: "The generator failed.",
        }
      : {}),
    capabilities: {
      can_refine: status === "ready",
      can_retry: status === "failed",
      can_save: status === "ready",
      can_create_campaign: status === "ready",
      can_archive: status !== "generating" && status !== "archived",
    },
    recommended_action:
      status === "ready"
        ? "review_campaign_template_design"
        : status === "failed"
          ? "retry_campaign_template_design"
          : "poll_campaign_template_design",
    ...(status === "queued" ? { retry_after_seconds: 2 } : {}),
    expires_at: "2026-08-20T00:00:00Z",
    created_at: "2026-07-29T00:00:00Z",
    updated_at: "2026-07-29T00:00:00Z",
    request: { mode: "generate", brief: "Monthly notes" },
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("campaign template design runtime contract", () => {
  beforeEach(() => {
    mocks.apiRequest.mockReset();
    vi.setSystemTime(Date.parse("2026-07-30T00:00:00Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("decodes the immutable revision/hash and fails closed on malformed data", () => {
    const valid = design();
    expect(decodeCampaignTemplateDesignDraft(valid)).toEqual(valid);
    expect(
      decodeCampaignTemplateDesignDraft({
        ...valid,
        revision: { ...valid.revision, output_hash: "not-a-sha256" },
      }),
    ).toBeNull();
    expect(
      decodeCampaignTemplateDesignDraft({
        ...valid,
        capabilities: {
          ...valid.capabilities,
          can_save: "yes",
        },
      }),
    ).toBeNull();
    expect(
      decodeCampaignTemplateDesignDraft({
        ...valid,
        revision: undefined,
      }),
    ).toBeNull();
    expect(
      decodeCampaignTemplateDesignDraft({
        ...valid,
        status: "saved",
        saved_template_id: "template-1",
      }),
    ).toBeNull();
  });

  it("decodes only compact, non-archived server recovery summaries", () => {
    const ready = design();
    const summary = {
      id: ready.id,
      mode: ready.mode,
      status: ready.status,
      current_revision: ready.current_revision,
      attempt_count: ready.attempt_count,
      capabilities: ready.capabilities,
      recommended_action: ready.recommended_action,
      expires_at: ready.expires_at,
      created_at: ready.created_at,
      updated_at: ready.updated_at,
    };
    expect(decodeCampaignTemplateDesignSummary(summary)).toEqual(summary);
    expect(
      decodeCampaignTemplateDesignSummary({
        ...summary,
        status: "archived",
      }),
    ).toBeNull();
    expect(
      decodeCampaignTemplateDesignSummary({
        ...summary,
        capabilities: { ...summary.capabilities, can_save: "yes" },
      }),
    ).toBeNull();
    expect(
      decodeCampaignTemplateDesignSummary({
        ...summary,
        status: "campaign_created",
        created_campaign_id: "campaign-1",
      }),
    ).toBeNull();
  });

  it("fails closed on duplicate or cyclic recovery pages", async () => {
    const ready = design();
    const summary = {
      id: ready.id,
      mode: ready.mode,
      status: ready.status,
      current_revision: ready.current_revision,
      attempt_count: ready.attempt_count,
      capabilities: ready.capabilities,
      recommended_action: ready.recommended_action,
      expires_at: ready.expires_at,
      created_at: ready.created_at,
      updated_at: ready.updated_at,
    };
    mocks.apiRequest.mockResolvedValueOnce({
      data: { items: [summary, { ...summary }] },
    });
    await expect(campaignTemplateDesignsApi.list()).resolves.toMatchObject({
      error: { code: "invalid_design_recovery_response" },
      retryability: "manual",
    });

    mocks.apiRequest.mockResolvedValueOnce({
      data: { items: [summary], next_cursor: "same-cursor" },
    });
    await expect(
      campaignTemplateDesignsApi.list({ cursor: "same-cursor" }),
    ).resolves.toMatchObject({
      error: { code: "invalid_design_recovery_response" },
      retryability: "manual",
    });
  });

  it("rejects malformed cursors before dispatch and cross-design revision history", async () => {
    await expect(
      campaignTemplateDesignsApi.list({ cursor: " padded " }),
    ).resolves.toMatchObject({
      error: { code: "invalid_design_recovery_page" },
      retryability: "not-retryable",
    });
    expect(mocks.apiRequest).not.toHaveBeenCalled();

    const current = design().revision;
    if (!current) throw new Error("expected a current revision");
    mocks.apiRequest.mockResolvedValueOnce({
      data: {
        items: [{ ...current, draft_id: "another-design" }],
      },
    });
    await expect(
      campaignTemplateDesignsApi.revisions("design-1"),
    ).resolves.toMatchObject({
      error: { code: "invalid_design_revisions_response" },
      retryability: "manual",
    });
  });

  it("persists only a workspace-scoped resumable design pointer and expires it", () => {
    const storage = memoryStorage();
    expect(writeCampaignTemplateDesignResume(SCOPE, design(), storage)).toBe(
      true,
    );
    expect(campaignTemplateDesignResumeKey(SCOPE)).toBe(
      `postwave:campaign-template-design:active:${SCOPE}`,
    );
    expect(
      readCampaignTemplateDesignResume(
        SCOPE,
        storage,
        Date.parse("2026-07-30T00:00:00Z"),
      ),
    ).toEqual({
      designId: "design-1",
      mode: "generate",
      expiresAt: "2026-08-20T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
    });
    expect(
      readCampaignTemplateDesignResume(
        OTHER_SCOPE,
        storage,
        Date.parse("2026-07-30T00:00:00Z"),
      ),
    ).toBeNull();

    clearCampaignTemplateDesignResume(SCOPE, "another-design", storage);
    expect(
      storage.getItem(campaignTemplateDesignResumeKey(SCOPE)),
    ).not.toBeNull();
    expect(
      readCampaignTemplateDesignResume(
        SCOPE,
        storage,
        Date.parse("2026-08-21T00:00:00Z"),
      ),
    ).toBeNull();
  });

  it("persists one bounded pending create key across a cold restart", async () => {
    const storage = memoryStorage();
    const input = {
      mode: "generate" as const,
      brief: "A monthly product brief",
    };
    const createdAt = Date.parse("2026-07-29T00:00:00Z");
    const attempt = await writeCampaignTemplateDesignCreateAttempt(
      SCOPE,
      input,
      "0198-ambiguous-create",
      storage,
      createdAt,
    );
    expect(attempt).toMatchObject({
      input,
      serializedInput: JSON.stringify(input),
      idempotencyKey: "0198-ambiguous-create",
      createdAt: "2026-07-29T00:00:00.000Z",
    });
    expect(
      await readCampaignTemplateDesignCreateAttempt(
        SCOPE,
        storage,
        createdAt + 60_000,
      ),
    ).toEqual(attempt);
    expect(
      await readCampaignTemplateDesignCreateAttempt(
        OTHER_SCOPE,
        storage,
        createdAt + 60_000,
      ),
    ).toBeNull();

    expect(
      await clearCampaignTemplateDesignCreateAttempt(
        SCOPE,
        "different-key",
        storage,
      ),
    ).toBe(false);
    expect(
      storage.getItem(campaignTemplateDesignCreateAttemptKey(SCOPE)),
    ).not.toBeNull();
    expect(
      await readCampaignTemplateDesignCreateAttempt(
        SCOPE,
        storage,
        createdAt + 24 * 60 * 60 * 1_000 + 1,
      ),
    ).toBeNull();
  });

  it("encrypts authored pending-create content in the production vault", async () => {
    window.localStorage.clear();
    const input = {
      mode: "generate" as const,
      brief: "Confidential launch direction",
      audience: "Private beta customers",
    };
    const attempt = await writeCampaignTemplateDesignCreateAttempt(
      SCOPE,
      input,
      "encrypted-create-key",
      undefined,
      Date.parse("2026-07-30T00:00:00Z"),
    );
    expect(attempt).not.toBeNull();

    const logicalKey = campaignTemplateDesignCreateAttemptKey(SCOPE);
    expect(window.localStorage.getItem(logicalKey)).toBeNull();
    const envelope = window.localStorage.getItem(
      `postwave.desktop.vault.v1:${logicalKey}`,
    );
    expect(envelope).not.toBeNull();
    expect(envelope).not.toContain("Confidential launch direction");
    expect(envelope).not.toContain("Private beta customers");
    await expect(
      readCampaignTemplateDesignCreateAttempt(
        SCOPE,
        undefined,
        Date.parse("2026-07-30T00:01:00Z"),
      ),
    ).resolves.toMatchObject({ input, idempotencyKey: "encrypted-create-key" });
    await expect(
      clearCampaignTemplateDesignCreateAttempt(SCOPE, "encrypted-create-key"),
    ).resolves.toBe(true);
    expect(
      window.localStorage.getItem(`postwave.desktop.vault.v1:${logicalKey}`),
    ).toBeNull();
  });

  it("does not mint a new create key after corrupt ciphertext is removed", async () => {
    window.localStorage.clear();
    const logicalKey = campaignTemplateDesignCreateAttemptKey(SCOPE);
    const envelopeKey = `postwave.desktop.vault.v1:${logicalKey}`;
    await expect(
      writeCampaignTemplateDesignCreateAttempt(
        SCOPE,
        {
          mode: "generate",
          brief: "Confidential ambiguous direction",
        },
        "original-create-key",
        undefined,
        Date.parse("2026-07-30T00:00:00Z"),
      ),
    ).resolves.not.toBeNull();

    window.localStorage.setItem(envelopeKey, "{broken");
    await expect(
      readCampaignTemplateDesignCreateAttempt(
        SCOPE,
        undefined,
        Date.parse("2026-07-30T00:01:00Z"),
      ),
    ).resolves.toBeNull();
    expect(window.localStorage.getItem(envelopeKey)).toBeNull();
    expect(window.localStorage.getItem(`${logicalKey}:invalid`)).toBe("1");

    await expect(
      writeCampaignTemplateDesignCreateAttempt(
        SCOPE,
        {
          mode: "generate",
          brief: "A different direction must stay paused",
        },
        "replacement-create-key",
        undefined,
        Date.parse("2026-07-30T00:02:00Z"),
      ),
    ).resolves.toBeNull();
    await expect(clearCampaignTemplateDesignCreateAttempt(SCOPE)).resolves.toBe(
      false,
    );
    expect(window.localStorage.getItem(envelopeKey)).toBeNull();

    purgePrivateSessionState();
    expect(window.localStorage.getItem(`${logicalKey}:invalid`)).toBeNull();
  });

  it("keeps the server workflow usable when webview storage is unavailable", async () => {
    const unavailable = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    };
    expect(() =>
      writeCampaignTemplateDesignResume(SCOPE, design(), unavailable),
    ).not.toThrow();
    expect(
      writeCampaignTemplateDesignResume(SCOPE, design(), unavailable),
    ).toBe(false);
    expect(() =>
      clearCampaignTemplateDesignResume(SCOPE, "design-1", unavailable),
    ).not.toThrow();
    expect(
      await clearCampaignTemplateDesignCreateAttempt(
        SCOPE,
        undefined,
        unavailable,
      ),
    ).toBe(false);
    expect(
      readCampaignTemplateDesignResume(
        SCOPE,
        unavailable,
        Date.parse("2026-07-30T00:00:00Z"),
      ),
    ).toBeNull();
  });

  it("rejects raw scopes, verifies pointer writes, and purges both prefixes on logout", async () => {
    const ignoredWrite = {
      getItem: () => null,
      setItem: vi.fn(),
    };
    expect(
      writeCampaignTemplateDesignResume("tenant:user", design(), ignoredWrite),
    ).toBe(false);
    expect(ignoredWrite.setItem).not.toHaveBeenCalled();
    expect(() => campaignTemplateDesignResumeKey("tenant:user")).toThrow(
      "verified workspace and user scope",
    );

    window.localStorage.clear();
    expect(
      writeCampaignTemplateDesignResume(SCOPE, design(), window.localStorage),
    ).toBe(true);
    expect(
      await writeCampaignTemplateDesignCreateAttempt(
        SCOPE,
        { mode: "generate", brief: "Logout purge" },
        "logout-create-key",
        window.localStorage,
      ),
    ).not.toBeNull();
    window.localStorage.setItem("unrelated-key", "keep");

    purgePrivateSessionState();

    expect(
      window.localStorage.getItem(campaignTemplateDesignResumeKey(SCOPE)),
    ).toBeNull();
    expect(
      window.localStorage.getItem(
        campaignTemplateDesignCreateAttemptKey(SCOPE),
      ),
    ).toBeNull();
    expect(window.localStorage.getItem("unrelated-key")).toBe("keep");
  });

  it("polls queued and generating states with server-aware backoff until ready", async () => {
    const delays: number[] = [];
    const updates: string[] = [];
    const load = vi
      .fn()
      .mockResolvedValueOnce({ data: design("generating") })
      .mockResolvedValueOnce({ data: design("ready") });
    const result = await pollCampaignTemplateDesign("design-1", {
      initial: design("queued"),
      load,
      now: () => Date.parse("2026-07-30T00:00:00Z"),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      onUpdate: (draft) => updates.push(draft.status),
    });

    expect(result).toEqual({ data: design("ready") });
    expect(delays).toEqual([2_000, 1_200]);
    expect(updates).toEqual(["generating", "ready"]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("treats failed and expired jobs as terminal without endless polling", async () => {
    const load = vi.fn();
    await expect(
      pollCampaignTemplateDesign("design-1", {
        initial: design("failed"),
        load,
      }),
    ).resolves.toEqual({ data: design("failed") });
    expect(load).not.toHaveBeenCalled();

    const expired = await pollCampaignTemplateDesign("design-1", {
      initial: design("queued"),
      now: () => Date.parse("2026-08-21T00:00:00Z"),
      load,
    });
    expect(expired.error?.code).toBe("design_expired");
    expect(expired.error?.status).toBe(410);
    expect(load).not.toHaveBeenCalled();
  });

  it("cancels the local wait without mutating or archiving the server job", async () => {
    const controller = new AbortController();
    const waiting = pollCampaignTemplateDesign("design-1", {
      initial: design("queued"),
      signal: controller.signal,
      now: () => Date.parse("2026-07-30T00:00:00Z"),
      sleep: (_milliseconds, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});
