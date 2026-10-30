import { describe, expect, it } from "vitest";

import {
  campaignHasAuthoritativeSemanticPoll,
  parseCampaignPollDefinitionPage,
  parseCampaignPollDefinitions,
  parseCampaignPollTally,
} from "./campaignPolls";

const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const POLL = "22222222-2222-4222-8222-222222222222";
const REVISION = "33333333-3333-4333-8333-333333333333";
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

describe("mobile campaign poll receipt codec", () => {
  it("ignores stale poll-shaped blocks outside authoritative semantic v2 content", () => {
    expect(
      campaignHasAuthoritativeSemanticPoll("semantic", 2, [{ type: "poll" }]),
    ).toBe(true);
    expect(
      campaignHasAuthoritativeSemanticPoll("legacy", 2, [{ type: "poll" }]),
    ).toBe(false);
    expect(
      campaignHasAuthoritativeSemanticPoll("semantic", 1, [{ type: "poll" }]),
    ).toBe(false);
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
        next_cursor: "line\nbreak",
      }),
    ).toThrow("malformed");
    expect(() =>
      parseCampaignPollDefinitionPage({
        items: [definition],
        next_cursor: "😀".repeat(129),
      }),
    ).toThrow("malformed");
  });

  it("keeps immutable revision hashes and exclusions", () => {
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

  it("fails closed on revision drift or PII-bearing list rows", () => {
    const [parsed] = parseCampaignPollDefinitions({ items: [definition] });
    expect(() =>
      parseCampaignPollTally(
        { ...tally, content_revision_id: CAMPAIGN },
        parsed!,
      ),
    ).toThrow("malformed");
    expect(() =>
      parseCampaignPollDefinitions({
        items: [{ ...definition, recipient_reference: "must-not-leak" }],
      }),
    ).toThrow("malformed");
  });
});
