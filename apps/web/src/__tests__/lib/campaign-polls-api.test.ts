import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { get: mocks.get, post: mocks.post },
}));

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
} from "@/lib/campaign-polls-api";

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

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
});

describe("campaign poll receipt codec", () => {
  it("recognizes only authoritative semantic v2 poll content", () => {
    expect(
      campaignHasAuthoritativeSemanticPoll("semantic", 2, [{ type: "poll" }]),
    ).toBe(true);
    expect(
      campaignHasAuthoritativeSemanticPoll("legacy", 2, [{ type: "poll" }]),
    ).toBe(false);
    expect(
      campaignHasAuthoritativeSemanticPoll("semantic", 1, [{ type: "poll" }]),
    ).toBe(false);
    expect(campaignStatusAllowsPollMaterialization("scheduled")).toBe(true);
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
        next_cursor: " leading-space",
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
    mocks.get
      .mockResolvedValueOnce({ items: [definition], next_cursor: "page-two" })
      .mockResolvedValueOnce({ items: [second] });

    await expect(listCampaignPollDefinitions(CAMPAIGN)).resolves.toHaveLength(
      2,
    );
    expect(mocks.get).toHaveBeenNthCalledWith(
      1,
      `/api/v1/campaigns/${CAMPAIGN}/polls?limit=100`,
      { cache: "no-store" },
    );
    expect(mocks.get).toHaveBeenNthCalledWith(
      2,
      `/api/v1/campaigns/${CAMPAIGN}/polls?limit=100&cursor=page-two`,
      { cache: "no-store" },
    );
  });

  it("keeps immutable revision and exclusion receipts distinct", () => {
    const [parsed] = parseCampaignPollDefinitions({ items: [definition] });
    expect(parsed).toMatchObject({
      contentRevisionId: REVISION,
      contentRevisionSourceHash: "a".repeat(64),
      pollContractSha256: "b".repeat(64),
      twoStepRequired: true,
    });
    expect(parseCampaignPollTally(tally, parsed!)).toMatchObject({
      machineExcluded: 3,
      unclassifiedExcluded: 4,
      submissionReceipts: 19,
    });
  });

  it("fails closed when a tally drifts from its frozen revision or options", () => {
    const [parsed] = parseCampaignPollDefinitions({ items: [definition] });
    expect(() =>
      parseCampaignPollTally(
        { ...tally, content_revision_id: CAMPAIGN },
        parsed!,
      ),
    ).toThrow("malformed");
    expect(() =>
      parseCampaignPollTally(
        {
          ...tally,
          options: [tally.options[1], tally.options[0]],
        },
        parsed!,
      ),
    ).toThrow("did not match");
    expect(() =>
      parseCampaignPollDefinitions({
        items: [{ ...definition, response_token: "secret" }],
      }),
    ).toThrow("malformed");
  });

  it("reads every tally with the exact revision query", async () => {
    mocks.get
      .mockResolvedValueOnce({ items: [definition] })
      .mockResolvedValueOnce(tally);
    await expect(listCampaignPollReceipts(CAMPAIGN)).resolves.toHaveLength(1);
    expect(mocks.get).toHaveBeenNthCalledWith(
      2,
      `/api/v1/campaigns/${CAMPAIGN}/polls/launch-rsvp/tally?content_revision_id=${REVISION}`,
      { cache: "no-store" },
    );
    expect(mocks.get).toHaveBeenNthCalledWith(
      1,
      `/api/v1/campaigns/${CAMPAIGN}/polls?limit=100`,
      { cache: "no-store" },
    );
  });

  it("derives the poll key only from the exact frozen semantic revision", async () => {
    expect(parseFrozenCampaignPollRevision(frozenRevision, CAMPAIGN)).toEqual({
      revisionId: REVISION,
      campaignId: CAMPAIGN,
      sourceHash: "a".repeat(64),
      pollKeys: ["launch-rsvp"],
    });
    expect(() =>
      parseFrozenCampaignPollRevision(
        {
          ...frozenRevision,
          semantic_tree: [
            {
              type: "poll",
              content: { poll: { poll_id: "", question: {}, options: [] } },
            },
          ],
        },
        CAMPAIGN,
      ),
    ).toThrow("invalid poll identity");
  });

  it("freezes first and materializes a two-step poll with no copied question or options", async () => {
    const beforeWrite = vi.fn().mockResolvedValue(undefined);
    mocks.post
      .mockResolvedValueOnce(frozenRevision)
      .mockResolvedValueOnce(definition);
    mocks.get.mockResolvedValueOnce({ items: [] });

    await expect(
      materializeCurrentCampaignPolls(CAMPAIGN, { beforeWrite }),
    ).resolves.toEqual({
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
    });
    expect(mocks.post).toHaveBeenNthCalledWith(
      1,
      `/api/v1/campaigns/${CAMPAIGN}/content-revisions`,
      {},
      { requireOnline: true, maxAttempts: 3 },
    );
    expect(mocks.post).toHaveBeenNthCalledWith(
      2,
      `/api/v1/campaigns/${CAMPAIGN}/polls`,
      {
        content_revision_id: REVISION,
        poll_key: "launch-rsvp",
        two_step_required: true,
      },
      { requireOnline: true, maxAttempts: 1 },
    );
    expect(beforeWrite).toHaveBeenCalledTimes(2);
    expect(beforeWrite.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.post.mock.invocationCallOrder[0]!,
    );
    expect(beforeWrite.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.post.mock.invocationCallOrder[1]!,
    );
  });

  it("rechecks authority before each poll write and stops a later write on downgrade", async () => {
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
    const beforeWrite = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("campaign authority changed"));
    mocks.post
      .mockResolvedValueOnce(twoPollRevision)
      .mockResolvedValueOnce(definition);
    mocks.get.mockResolvedValueOnce({ items: [] });

    await expect(
      materializeCurrentCampaignPolls(CAMPAIGN, { beforeWrite }),
    ).rejects.toThrow("campaign authority changed");
    expect(beforeWrite).toHaveBeenCalledTimes(3);
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it("reconciles an ambiguous single-attempt create through the exact register", async () => {
    mocks.post
      .mockResolvedValueOnce(frozenRevision)
      .mockRejectedValueOnce(new Error("response lost"));
    mocks.get
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [definition] });

    await expect(materializeCurrentCampaignPolls(CAMPAIGN)).resolves.toEqual(
      expect.objectContaining({
        definitions: [
          expect.objectContaining({
            contentRevisionId: REVISION,
            pollKey: "launch-rsvp",
            twoStepRequired: true,
          }),
        ],
      }),
    );
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenNthCalledWith(
      2,
      `/api/v1/campaigns/${CAMPAIGN}/polls?limit=100`,
      { cache: "no-store" },
    );
  });

  it("allows the same semantic poll key to materialize for a newer revision", async () => {
    mocks.post
      .mockResolvedValueOnce(frozenRevision)
      .mockResolvedValueOnce(definition);
    mocks.get.mockResolvedValueOnce({
      items: [
        {
          ...definition,
          id: "55555555-5555-4555-8555-555555555555",
          content_revision_id: OLD_REVISION,
        },
      ],
    });

    await expect(materializeCurrentCampaignPolls(CAMPAIGN)).resolves.toEqual(
      expect.objectContaining({
        definitions: [expect.objectContaining({ contentRevisionId: REVISION })],
      }),
    );
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it("fails the dispatch preflight when any frozen poll has an ambiguous unresolved outcome", async () => {
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
    mocks.post
      .mockResolvedValueOnce(twoPollRevision)
      .mockResolvedValueOnce(definition)
      .mockRejectedValueOnce(new Error("second poll response lost"));
    mocks.get
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [definition] });

    await expect(ensureCurrentCampaignPollsReady(CAMPAIGN)).rejects.toThrow(
      "second poll response lost",
    );
    expect(mocks.post).toHaveBeenCalledTimes(3);
  });
});
