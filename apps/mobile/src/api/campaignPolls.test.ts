import { beforeEach, describe, expect, it, vi } from "vitest";

import { listCampaignPollReceipts } from "./campaignPolls";

const mocks = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest: mocks.rawRequest }));

const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const REVISION = "33333333-3333-4333-8333-333333333333";

beforeEach(() => mocks.rawRequest.mockReset());

describe("mobile campaign poll API", () => {
  it("binds tally reads to the listed immutable revision", async () => {
    mocks.rawRequest
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              id: "22222222-2222-4222-8222-222222222222",
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
            },
          ],
          next_cursor: "opaque/page+2=",
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { items: [] }, error: null })
      .mockResolvedValueOnce({
        data: {
          poll_id: "22222222-2222-4222-8222-222222222222",
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
        },
        error: null,
      });

    await expect(listCampaignPollReceipts(CAMPAIGN)).resolves.toMatchObject([
      { tally: { submissionReceipts: 19 } },
    ]);
    expect(mocks.rawRequest).toHaveBeenNthCalledWith(
      3,
      "GET",
      `/api/v1/campaigns/${CAMPAIGN}/polls/launch-rsvp/tally?content_revision_id=${REVISION}`,
    );
    expect(mocks.rawRequest).toHaveBeenNthCalledWith(
      1,
      "GET",
      `/api/v1/campaigns/${CAMPAIGN}/polls?limit=100`,
    );
    expect(mocks.rawRequest).toHaveBeenNthCalledWith(
      2,
      "GET",
      `/api/v1/campaigns/${CAMPAIGN}/polls?limit=100&cursor=opaque%2Fpage%2B2%3D`,
    );
  });
});
