import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import {
  createCampaignSequenceOperationsMethods,
  type CampaignSequenceOperationsDependencies,
  type CampaignSequenceRequester,
  type CampaignSequenceRequestOptions,
  type SequenceRegeneratedEmail,
} from "../../lib/api/campaign-sequence-operations";
import type { ApiErr, ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: CampaignSequenceRequestOptions | undefined;
}

const LLM_OPTIONS = { timeoutMs: 60_000, maxAttempts: 1 } as const;

const METHOD_NAMES = [
  "getCampaign",
  "updateCampaign",
  "patchCampaignPSTO",
  "sendCampaign",
  "testSendCampaignEmail",
  "deleteCampaign",
  "listCampaignFolders",
  "createCampaignFolder",
  "updateCampaignFolder",
  "deleteCampaignFolder",
  "moveCampaignToFolder",
  "listCampaignFeedback",
  "createCampaignFeedback",
  "resolveCampaignFeedback",
  "getCampaignChecklist",
  "getCampaignSendPreview",
  "listCampaignReplies",
  "previewCampaignAsSubscriber",
  "freezeCampaignAudience",
  "bulkTagCampaigns",
  "listCampaignTranslations",
  "upsertCampaignTranslation",
  "deleteCampaignTranslation",
  "audienceCount",
  "getCampaignReply",
  "classifyCampaignReply",
  "getCampaignSummary",
  "regenerateCampaignSummary",
  "getCampaignRegions",
  "getSequence",
  "updateSequence",
  "regenerateSequenceStep",
  "deleteSequence",
] as const;

const METHOD_NAME_SET = new Set<string>(METHOD_NAMES);

function createHarness(
  options: {
    responses?: ApiResult<unknown>[];
    pollError?: ApiErr["error"];
    extractedEmail?: SequenceRegeneratedEmail | null;
    positionResolver?: (position: number) => string | null;
  } = {},
) {
  const calls: RequestCall[] = [];
  const positions: number[] = [];
  const polledJobs: string[] = [];
  const extractCalls: Array<{
    detail: { steps?: unknown[]; emails?: unknown[] } | undefined;
    position: number;
  }> = [];
  const responses = [...(options.responses ?? [])];

  const request: CampaignSequenceRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: CampaignSequenceRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (responses.shift() ?? { data: {} }) as ApiResult<T>;
  };

  const dependencies: CampaignSequenceOperationsDependencies = {
    request,
    llmRequestOptions: LLM_OPTIONS,
    sequencePositionPathSegment: (position) => {
      positions.push(position);
      return options.positionResolver
        ? options.positionResolver(position)
        : Number.isSafeInteger(position) && position > 0
          ? String(position)
          : null;
    },
    pollSequenceJob: async (jobId) => {
      polledJobs.push(jobId);
      return options.pollError;
    },
    extractSequenceEmailAt: (detail, position) => {
      extractCalls.push({ detail, position });
      return "extractedEmail" in options
        ? (options.extractedEmail ?? null)
        : { subject: "Extracted", body: "Extracted body" };
    },
  };

  return {
    calls,
    extractCalls,
    methods: createCampaignSequenceOperationsMethods(dependencies),
    polledJobs,
    positions,
  };
}

describe("campaign and sequence operations API extraction contracts", () => {
  it("retains the exact ordered 33-method inventory without eager work", () => {
    const { calls, extractCalls, methods, polledJobs, positions } =
      createHarness();

    expect(Object.keys(methods)).toEqual(METHOD_NAMES);
    expect(
      Object.keys(api).filter((name) => METHOD_NAME_SET.has(name)),
    ).toEqual(METHOD_NAMES);
    for (const name of METHOD_NAMES) {
      expect(typeof methods[name]).toBe("function");
      expect(methods[name].name).toBe(name);
      expect(typeof api[name]).toBe("function");
      expect(api[name].name).toBe(name);
    }
    expect(calls).toEqual([]);
    expect(positions).toEqual([]);
    expect(polledJobs).toEqual([]);
    expect(extractCalls).toEqual([]);
  });

  it("preserves campaign CRUD, PSTO, and double-send-safe request policies", async () => {
    const { calls, methods } = createHarness();
    const patch = {
      subject: "Updated subject",
      scheduled_at: "2026-07-18T08:00:00Z",
      goal_event: "purchase",
    };
    const psto = {
      per_recipient_optimize: true,
      send_window_start: "2026-07-18T08:00:00Z",
      send_window_end: "2026-07-18T20:00:00Z",
    };
    const testSend = {
      campaign_id: "campaign/one",
      to_email: "ada@example.com",
      subject: "Preview",
      body_html: "<p>Hello Ada</p>",
    };

    await methods.getCampaign("campaign/one");
    await methods.updateCampaign("campaign/one", patch);
    await methods.patchCampaignPSTO("campaign/one", psto);
    await methods.sendCampaign("campaign/one");
    await methods.testSendCampaignEmail(testSend);
    await methods.deleteCampaign("campaign/one");

    const root = "/api/v1/campaigns/campaign%2Fone";
    expect(calls).toEqual([
      { path: root, init: undefined, opts: undefined },
      {
        path: root,
        init: { method: "PATCH", body: JSON.stringify(patch) },
        opts: undefined,
      },
      {
        path: `${root}/psto`,
        init: { method: "PATCH", body: JSON.stringify(psto) },
        opts: undefined,
      },
      {
        path: `${root}/send`,
        init: { method: "POST", body: "{}" },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: "/api/v1/campaigns/test-send",
        init: { method: "POST", body: JSON.stringify(testSend) },
        opts: { maxAttempts: 1 },
      },
      {
        path: root,
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("preserves folders, feedback, checklist, and audience-preview transports", async () => {
    const { calls, methods } = createHarness();

    await methods.listCampaignFolders();
    await methods.createCampaignFolder("Launches");
    await methods.updateCampaignFolder("folder/one", "Evergreen");
    await methods.deleteCampaignFolder("folder/one");
    await methods.moveCampaignToFolder("campaign/one", "folder/one");
    await methods.listCampaignFeedback("campaign/one");
    await methods.createCampaignFeedback("campaign/one", "Tighten intro");
    await methods.resolveCampaignFeedback("campaign/one", "feedback/one");
    await methods.getCampaignChecklist("campaign/one");
    await methods.getCampaignSendPreview("campaign/one");

    const campaign = "/api/v1/campaigns/campaign%2Fone";
    const folders = "/api/v1/campaigns/folders";
    expect(calls).toEqual([
      { path: folders, init: undefined, opts: undefined },
      {
        path: folders,
        init: {
          method: "POST",
          body: JSON.stringify({ name: "Launches" }),
        },
        opts: undefined,
      },
      {
        path: `${folders}/folder%2Fone`,
        init: {
          method: "PATCH",
          body: JSON.stringify({ name: "Evergreen" }),
        },
        opts: undefined,
      },
      {
        path: `${folders}/folder%2Fone`,
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: `${campaign}/folder`,
        init: {
          method: "PATCH",
          body: JSON.stringify({ folder_id: "folder/one" }),
        },
        opts: undefined,
      },
      {
        path: `${campaign}/feedback`,
        init: undefined,
        opts: undefined,
      },
      {
        path: `${campaign}/feedback`,
        init: {
          method: "POST",
          body: JSON.stringify({ body: "Tighten intro" }),
        },
        opts: undefined,
      },
      {
        path: `${campaign}/feedback/feedback%2Fone/resolve`,
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: `${campaign}/checklist`,
        init: undefined,
        opts: undefined,
      },
      {
        path: `${campaign}/send-preview`,
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves replies, previews, audience controls, translations, summaries, and regions", async () => {
    const { calls, methods } = createHarness();
    const preview = { subscriber_email: "ada@example.com" };
    const translation = {
      subject: "Bonjour",
      body_html: "<p>Bonjour</p>",
      body_mjml: "<mjml />",
    };
    const audience = {
      list_id: "list/one",
      segment_id: "segment/one",
      exclude_list_ids: ["list/two"],
      exclude_segment_ids: ["segment/two"],
    };

    await methods.listCampaignReplies("campaign/one", {
      limit: 25,
      intent: "purchase",
    });
    await methods.previewCampaignAsSubscriber("campaign/one", preview);
    await methods.freezeCampaignAudience("campaign/one");
    await methods.bulkTagCampaigns(["campaign-one", "campaign-two"], "vip");
    await methods.listCampaignTranslations("campaign/one");
    await methods.upsertCampaignTranslation(
      "campaign/one",
      "fr/CA",
      translation,
    );
    await methods.deleteCampaignTranslation("campaign/one", "fr/CA");
    await methods.audienceCount(audience);
    await methods.getCampaignReply("campaign/one", "reply/one");
    await methods.classifyCampaignReply("campaign/one", "reply/one");
    await methods.getCampaignSummary("campaign/one");
    await methods.regenerateCampaignSummary("campaign/one", { force: true });
    await methods.getCampaignRegions("campaign/one");

    const root = "/api/v1/campaigns/campaign%2Fone";
    const reply = `${root}/replies/reply%2Fone`;
    const translations = `${root}/translations`;
    expect(calls).toEqual([
      {
        path: `${root}/replies?limit=25&intent=purchase`,
        init: undefined,
        opts: undefined,
      },
      {
        path: `${root}/preview-as`,
        init: { method: "POST", body: JSON.stringify(preview) },
        opts: undefined,
      },
      {
        path: `${root}/audience/freeze`,
        init: { method: "POST" },
        opts: undefined,
      },
      {
        path: "/api/v1/campaigns/org-tags/bulk",
        init: {
          method: "POST",
          body: JSON.stringify({
            campaign_ids: ["campaign-one", "campaign-two"],
            tag: "vip",
          }),
        },
        opts: undefined,
      },
      { path: translations, init: undefined, opts: undefined },
      {
        path: `${translations}/fr%2FCA`,
        init: { method: "PUT", body: JSON.stringify(translation) },
        opts: undefined,
      },
      {
        path: `${translations}/fr%2FCA`,
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/audiences/count",
        init: { method: "POST", body: JSON.stringify(audience) },
        opts: undefined,
      },
      { path: reply, init: undefined, opts: undefined },
      {
        path: `${reply}/classify`,
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      { path: `${root}/summary`, init: undefined, opts: undefined },
      {
        path: `${root}/summary/regenerate`,
        init: {
          method: "POST",
          body: JSON.stringify({ force: true }),
        },
        opts: undefined,
      },
      { path: `${root}/regions`, init: undefined, opts: undefined },
    ]);
  });

  it("preserves sequence concurrency, LLM policy, synchronous regeneration, and deletion", async () => {
    const invalid = createHarness();
    await expect(
      invalid.methods.updateSequence("sequence/one", { name: "Unsafe" }, 0),
    ).resolves.toMatchObject({
      error: { kind: "invalid_config", message: expect.stringMatching(/fresh sequence version/i) },
    });
    await expect(
      invalid.methods.deleteSequence("sequence/one", Number.NaN),
    ).resolves.toMatchObject({
      error: { kind: "invalid_config", message: expect.stringMatching(/fresh sequence version/i) },
    });
    expect(invalid.calls).toEqual([]);

    const { calls, extractCalls, methods, polledJobs, positions } =
      createHarness({
        responses: [
          { data: {} },
          { data: {} },
          {
            data: {
              subject: "Regenerated subject",
              body_html: "<p>Regenerated body</p>",
            },
          },
          { data: {} },
        ],
      });
    const patch = {
      name: "Welcome flow",
      status: "active",
      ops: [{ op: "delete" as const, step_id: 2 }],
    };

    await methods.getSequence("sequence/one");
    await methods.updateSequence("sequence/one", patch, 7);
    await expect(
      methods.regenerateSequenceStep("sequence/one", 2),
    ).resolves.toEqual({
      data: {
        subject: "Regenerated subject",
        body: "<p>Regenerated body</p>",
      },
    });
    await methods.deleteSequence("sequence/one", 8);

    const root = "/api/v1/voice/sequences/sequence%2Fone";
    expect(calls).toEqual([
      { path: root, init: undefined, opts: undefined },
      {
        path: root,
        init: {
          method: "PATCH",
          body: JSON.stringify(patch),
          headers: { "If-Match": '"7"' },
        },
        opts: undefined,
      },
      {
        path: `${root}/regenerate/2`,
        init: { method: "POST", body: "{}" },
        opts: LLM_OPTIONS,
      },
      {
        path: root,
        init: { method: "DELETE", headers: { "If-Match": '"8"' } },
        opts: undefined,
      },
    ]);
    expect(positions).toEqual([2]);
    expect(polledJobs).toEqual([]);
    expect(extractCalls).toEqual([]);
  });

  it("keeps unsupported-folder fallback narrow and preserves other errors", async () => {
    const notFound: ApiErr = {
      error: { kind: "http", status: 404, message: "not found" },
    };
    const unavailable: ApiErr = {
      error: { kind: "http", status: 501, message: "not implemented" },
    };
    const forbidden: ApiErr = {
      error: { kind: "http", status: 403, message: "forbidden" },
    };
    const { methods } = createHarness({
      responses: [notFound, unavailable, forbidden],
    });

    await expect(methods.listCampaignFolders()).resolves.toEqual({
      data: { items: [] },
    });
    await expect(methods.listCampaignFolders()).resolves.toEqual({
      data: { items: [] },
    });
    await expect(methods.listCampaignFolders()).resolves.toEqual(forbidden);
  });

  it("preserves invalid, async-job, polling-error, extraction, and parse branches", async () => {
    const invalid = createHarness();
    await expect(
      invalid.methods.regenerateSequenceStep("sequence/one", 0),
    ).resolves.toEqual({
      error: {
        kind: "invalid_config",
        message: "Sequence email position must be a positive integer.",
      },
    });
    expect(invalid.calls).toEqual([]);

    const asyncSuccess = createHarness({
      responses: [
        { data: { job_id: "job/one" } },
        { data: { steps: [{ type: "email", position: 3 }] } },
      ],
      extractedEmail: { subject: "Polled", body: "Polled body" },
    });
    await expect(
      asyncSuccess.methods.regenerateSequenceStep("sequence/one", 3),
    ).resolves.toEqual({
      data: { subject: "Polled", body: "Polled body" },
    });
    expect(asyncSuccess.polledJobs).toEqual(["job/one"]);
    expect(asyncSuccess.extractCalls).toEqual([
      {
        detail: { steps: [{ type: "email", position: 3 }] },
        position: 3,
      },
    ]);

    const pollError = {
      kind: "timeout" as const,
      message: "AI regenerate timed out.",
    };
    const asyncFailure = createHarness({
      responses: [{ data: { job_id: "job/two" } }],
      pollError,
    });
    await expect(
      asyncFailure.methods.regenerateSequenceStep("sequence/one", 4),
    ).resolves.toEqual({ error: pollError });
    expect(asyncFailure.calls).toHaveLength(1);

    const parseFailure = createHarness({
      responses: [{ data: { steps: [] } }],
      extractedEmail: null,
    });
    await expect(
      parseFailure.methods.regenerateSequenceStep("sequence/one", 1),
    ).resolves.toEqual({
      error: {
        kind: "parse",
        message: "AI regenerate returned no editable email content.",
      },
    });
  });
});
