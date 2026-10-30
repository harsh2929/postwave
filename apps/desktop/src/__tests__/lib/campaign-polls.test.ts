import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock("../../lib/api-client", () => ({ apiRequest: mocks.apiRequest }));

import {
  campaignHasAuthoritativeSemanticPoll,
  campaignStatusAllowsPollMaterialization,
  ensureCurrentCampaignPollsReady,
  listCampaignPollDefinitions,
  listCampaignPollReceipts,
  materializeCurrentCampaignPolls,
  parseCampaignPollDefinitionPage,
  parseCampaignPollDefinitions,
  parseFrozenCampaignPollRevision,
  parseCampaignPollTally,
} from "../../lib/campaign-polls";

const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const POLL = "22222222-2222-4222-8222-222222222222";
const REVISION = "33333333-3333-4333-8333-333333333333";
const OLD_REVISION = "44444444-4444-4444-8444-444444444444";
const definition = {
  id: POLL,
  campaign_id: CAMPAIGN,
  content_revision_id: REVISION,
  content_revision_source_hash: "a".repeat(64),
  poll_contract_sha256: "b".repeat(64),
  poll_key: "launch-rsvp",
  question: "Will you attend?",
  two_step_required: true,
  options: [
    { option_key: "yes", label: "Yes", position: 0 },
    { option_key: "no", label: "No", position: 1 },
  ],
  created_at: "2026-08-30T10:00:00Z",
};
const tally = {
  poll_id: POLL,
  poll_key: "launch-rsvp",
  content_revision_id: REVISION,
  question: "Will you attend?",
  options: [
    { option_key: "yes", label: "Yes", counted: 7 },
    { option_key: "no", label: "No", counted: 2 },
  ],
  machine_excluded: 3,
  unclassified_excluded: 4,
  voided_multi_option: 1,
  superseded_choices: 2,
  previewed_only: 0,
  submission_receipts: 19,
};
const frozenRevision = {
  id: REVISION,
  campaign_id: CAMPAIGN,
  revision_no: 3,
  source_mode: "semantic",
  content_schema_version: 2,
  subject: "Launch",
  semantic_tree: [
    {
      id: "poll-node",
      type: "poll",
      content: {
        poll: {
          poll_id: "launch-rsvp",
          question: { runs: [{ text: "Will you attend?" }] },
          options: [
            { option_id: "yes", label: { runs: [{ text: "Yes" }] } },
            { option_id: "no", label: { runs: [{ text: "No" }] } },
          ],
        },
      },
    },
  ],
  fact_contract: {},
  variants: [],
  locales: [],
  tracking_settings: {},
  source_hash: "a".repeat(64),
  created_at: "2026-08-30T09:00:00Z",
};

beforeEach(() => mocks.apiRequest.mockReset());

describe("desktop campaign poll receipts", () => {
  it("recognizes only authoritative semantic v2 poll content and editable lifecycle states", () => {
    expect(
      campaignHasAuthoritativeSemanticPoll("semantic", 2, [{ type: "poll" }]),
    ).toBe(true);
    expect(
      campaignHasAuthoritativeSemanticPoll("legacy", 2, [{ type: "poll" }]),
    ).toBe(false);
    expect(
      campaignHasAuthoritativeSemanticPoll("semantic", 1, [{ type: "poll" }]),
    ).toBe(false);
    expect(campaignStatusAllowsPollMaterialization("paused")).toBe(true);
    expect(campaignStatusAllowsPollMaterialization("sent")).toBe(false);
  });

  it("accepts a maximum-sized page and semantic rich text without invented text caps", () => {
    const longQuestion = "Question ".repeat(700);
    const longLabel = "Option ".repeat(500);
    const items = Array.from({ length: 100 }, (_, index) => ({
      ...definition,
      id: `22222222-2222-4222-8222-${(index + 1).toString(16).padStart(12, "0")}`,
      poll_key: `poll-${index + 1}`,
      question: longQuestion,
      options: [
        { ...definition.options[0], label: longLabel },
        { ...definition.options[1], label: longLabel },
      ],
    }));
    const parsed = parseCampaignPollDefinitions({ items });
    expect(parsed).toHaveLength(100);
    expect(parsed[0]?.question).toBe(longQuestion);
    expect(
      parseCampaignPollTally(
        {
          ...tally,
          poll_id: items[0]?.id,
          poll_key: items[0]?.poll_key,
          question: longQuestion,
          options: [
            { option_key: "yes", label: longLabel, counted: 7 },
            { option_key: "no", label: longLabel, counted: 2 },
          ],
        },
        parsed[0]!,
      ).question,
    ).toBe(longQuestion);
  });

  it("strictly decodes the bounded opaque page cursor", () => {
    expect(
      parseCampaignPollDefinitionPage({
        items: [definition],
        next_cursor: "opaque/page+2=",
      }),
    ).toMatchObject({ nextCursor: "opaque/page+2=" });
    expect(() =>
      parseCampaignPollDefinitionPage({
        items: [definition],
        next_cursor: "trailing-space ",
      }),
    ).toThrow("malformed");
    expect(() =>
      parseCampaignPollDefinitionPage({
        items: [definition],
        next_cursor: "😀".repeat(129),
      }),
    ).toThrow("malformed");
  });

  it("consumes every register page before returning definitions", async () => {
    const second = {
      ...definition,
      id: "55555555-5555-4555-8555-555555555555",
      poll_key: "follow-up",
    };
    mocks.apiRequest
      .mockResolvedValueOnce({
        data: { items: [definition], next_cursor: "page-two" },
      })
      .mockResolvedValueOnce({ data: { items: [second] } });

    await expect(listCampaignPollDefinitions(CAMPAIGN)).resolves.toMatchObject(
      {
        data: [
          expect.objectContaining({ pollKey: "launch-rsvp" }),
          expect.objectContaining({ pollKey: "follow-up" }),
        ],
      },
    );
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      1,
      `/api/v1/campaigns/${CAMPAIGN}/polls?limit=100`,
    );
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      2,
      `/api/v1/campaigns/${CAMPAIGN}/polls?limit=100&cursor=page-two`,
    );
  });

  it("decodes immutable definition and excluded outcomes", () => {
    const [parsed] = parseCampaignPollDefinitions({ items: [definition] });
    expect(parsed).toMatchObject({
      contentRevisionId: REVISION,
      contentRevisionSourceHash: "a".repeat(64),
      pollContractSha256: "b".repeat(64),
    });
    expect(parseCampaignPollTally(tally, parsed!)).toMatchObject({
      machineExcluded: 3,
      unclassifiedExcluded: 4,
      submissionReceipts: 19,
    });
  });

  it("fails closed on revision drift and secret-bearing definition rows", () => {
    const [parsed] = parseCampaignPollDefinitions({ items: [definition] });
    expect(() =>
      parseCampaignPollTally(
        { ...tally, content_revision_id: CAMPAIGN },
        parsed!,
      ),
    ).toThrow("malformed");
    expect(() =>
      parseCampaignPollDefinitions({
        items: [{ ...definition, recipient_hash: "must-not-be-listable" }],
      }),
    ).toThrow("malformed");
  });

  it("requests the tally with the exact frozen revision", async () => {
    mocks.apiRequest
      .mockResolvedValueOnce({ data: { items: [definition] } })
      .mockResolvedValueOnce({ data: tally });
    await expect(listCampaignPollReceipts(CAMPAIGN)).resolves.toMatchObject({
      data: [{ tally: { submissionReceipts: 19 } }],
    });
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      2,
      `/api/v1/campaigns/${CAMPAIGN}/polls/launch-rsvp/tally?content_revision_id=${REVISION}`,
    );
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      1,
      `/api/v1/campaigns/${CAMPAIGN}/polls?limit=100`,
    );
  });

  it("extracts poll identity only from the exact frozen semantic revision", () => {
    expect(parseFrozenCampaignPollRevision(frozenRevision, CAMPAIGN)).toEqual({
      revisionId: REVISION,
      campaignId: CAMPAIGN,
      sourceHash: "a".repeat(64),
      pollKeys: ["launch-rsvp"],
    });
  });

  it("freezes before a single-attempt two-step materialization", async () => {
    mocks.apiRequest
      .mockResolvedValueOnce({ data: frozenRevision })
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: definition });

    await expect(materializeCurrentCampaignPolls(CAMPAIGN)).resolves.toEqual({
      data: {
        revision: {
          revisionId: REVISION,
          campaignId: CAMPAIGN,
          sourceHash: "a".repeat(64),
          pollKeys: ["launch-rsvp"],
        },
        definitions: [
          expect.objectContaining({
            pollKey: "launch-rsvp",
            contentRevisionId: REVISION,
            twoStepRequired: true,
          }),
        ],
      },
    });
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      1,
      `/api/v1/campaigns/${CAMPAIGN}/content-revisions`,
      { method: "POST", body: "{}" },
      { requireOnline: true, maxAttempts: 3 },
    );
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      3,
      `/api/v1/campaigns/${CAMPAIGN}/polls`,
      {
        method: "POST",
        body: JSON.stringify({
          content_revision_id: REVISION,
          poll_key: "launch-rsvp",
          two_step_required: true,
        }),
      },
      { requireOnline: true, maxAttempts: 1 },
    );
  });

  it("reconciles an ambiguous create against exact immutable register identity", async () => {
    mocks.apiRequest
      .mockResolvedValueOnce({ data: frozenRevision })
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({
        error: { kind: "network", message: "response lost" },
        retryability: "manual",
      })
      .mockResolvedValueOnce({ data: { items: [definition] } });

    await expect(materializeCurrentCampaignPolls(CAMPAIGN)).resolves.toEqual({
      data: expect.objectContaining({
        definitions: [
          expect.objectContaining({
            contentRevisionId: REVISION,
            pollKey: "launch-rsvp",
            twoStepRequired: true,
          }),
        ],
      }),
    });
    expect(mocks.apiRequest).toHaveBeenCalledTimes(4);
  });

  it("materializes the same semantic poll key independently for a newer revision", async () => {
    mocks.apiRequest
      .mockResolvedValueOnce({ data: frozenRevision })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              ...definition,
              id: "55555555-5555-4555-8555-555555555555",
              content_revision_id: OLD_REVISION,
            },
          ],
        },
      })
      .mockResolvedValueOnce({ data: definition });

    await expect(materializeCurrentCampaignPolls(CAMPAIGN)).resolves.toEqual({
      data: expect.objectContaining({
        definitions: [expect.objectContaining({ contentRevisionId: REVISION })],
      }),
    });
    expect(mocks.apiRequest).toHaveBeenCalledTimes(3);
  });

  it("fails the dispatch preflight when any frozen poll remains ambiguous", async () => {
    const twoPollRevision = {
      ...frozenRevision,
      semantic_tree: [
        ...frozenRevision.semantic_tree,
        {
          id: "poll-node-two",
          type: "poll",
          content: {
            poll: {
              poll_id: "meal-choice",
              question: { runs: [{ text: "Choose a meal" }] },
              options: [
                { option_id: "veg", label: { runs: [{ text: "Veg" }] } },
                {
                  option_id: "regular",
                  label: { runs: [{ text: "Regular" }] },
                },
              ],
            },
          },
        },
      ],
    };
    mocks.apiRequest
      .mockResolvedValueOnce({ data: twoPollRevision })
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: definition })
      .mockResolvedValueOnce({
        error: { kind: "network", message: "second poll response lost" },
        retryability: "manual",
      })
      .mockResolvedValueOnce({ data: { items: [definition] } });

    await expect(ensureCurrentCampaignPollsReady(CAMPAIGN)).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: "second poll response lost",
        }),
      }),
    );
    expect(mocks.apiRequest).toHaveBeenCalledTimes(5);
  });
});
