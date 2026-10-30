// SPDX-License-Identifier: AGPL-3.0-only
//
// A poll definition or tally the app cannot read says so, whichever check
// refused it. The envelope checks already threw a WireShapeError; the option,
// consistency, uniqueness and definition-match checks threw bare Errors, so a
// new server field on an OPTION read as "Something went wrong loading this"
// while the same field on the definition read as "update the app".
//
// Each case keeps the parser's own sentence and adds the code errorCopy reads.
import { describe, expect, it } from "vitest";

import {
  parseCampaignPollDefinitionPage,
  parseCampaignPollDefinitions,
  parseCampaignPollTally,
  type CampaignPollDefinition,
} from "./campaignPolls";
import { errorPresentation } from "./errorCopy";
import { WireShapeError } from "./wireShapeError";

const WIRE_SHAPE_COPY = {
  message:
    "Moosewave sent a response this version of the app can't read. If this keeps happening, update the app.",
  retryable: true,
};

const POLL = "22222222-2222-4222-8222-222222222222";
const REVISION = "33333333-3333-4333-8333-333333333333";
const DEFINITION = {
  id: POLL,
  campaign_id: "11111111-1111-4111-8111-111111111111",
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
const TALLY = {
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

function refusal(parse: () => unknown): unknown {
  try {
    parse();
  } catch (err) {
    return err;
  }
  return new Error("the poll codec accepted a body it should refuse");
}

function parsedDefinition(): CampaignPollDefinition {
  const [definition] = parseCampaignPollDefinitions({ items: [DEFINITION] });
  if (!definition) throw new Error("fixture definition did not parse");
  return definition;
}

describe("campaign poll codecs: every refused body is a wire-shape failure", () => {
  it("a new server field on a definition option reads as 'update the app'", () => {
    const err = refusal(() =>
      parseCampaignPollDefinitions({
        items: [
          {
            ...DEFINITION,
            options: [
              { ...DEFINITION.options[0], color: "green" },
              DEFINITION.options[1],
            ],
          },
        ],
      }),
    );
    expect(err).toBeInstanceOf(WireShapeError);
    expect(err).toMatchObject({
      code: "wire_shape",
      message: "The campaign poll definition contained an invalid option.",
    });
    expect(errorPresentation(err)).toEqual(WIRE_SHAPE_COPY);
  });

  it("options out of position order are the same failure", () => {
    expect(
      refusal(() =>
        parseCampaignPollDefinitions({
          items: [
            {
              ...DEFINITION,
              options: [
                { option_key: "no", label: "No", position: 1 },
                { option_key: "yes", label: "Yes", position: 0 },
              ],
            },
          ],
        }),
      ),
    ).toMatchObject({
      name: "WireShapeError",
      code: "wire_shape",
      message: "The campaign poll definition options were inconsistent.",
    });
  });

  it("a register listing one definition twice is the same failure", () => {
    expect(
      refusal(() =>
        parseCampaignPollDefinitionPage({ items: [DEFINITION, DEFINITION] }),
      ),
    ).toMatchObject({
      name: "WireShapeError",
      code: "wire_shape",
      message: "The campaign poll definition register contained duplicate IDs.",
    });
  });

  it("a new server field on a tally option is the same failure", () => {
    const definition = parsedDefinition();
    const err = refusal(() =>
      parseCampaignPollTally(
        {
          ...TALLY,
          options: [{ ...TALLY.options[0], share: 0.78 }, TALLY.options[1]],
        },
        definition,
      ),
    );
    expect(err).toMatchObject({
      name: "WireShapeError",
      code: "wire_shape",
      message: "The campaign poll tally contained an invalid option.",
    });
    expect(errorPresentation(err, { online: false })).toEqual(WIRE_SHAPE_COPY);
  });

  it("a tally whose options disagree with the definition is the same failure", () => {
    const definition = parsedDefinition();
    expect(
      refusal(() =>
        parseCampaignPollTally(
          {
            ...TALLY,
            options: [
              { option_key: "yes", label: "Yes, definitely", counted: 7 },
              TALLY.options[1],
            ],
          },
          definition,
        ),
      ),
    ).toMatchObject({
      name: "WireShapeError",
      code: "wire_shape",
      message:
        "The campaign poll tally did not match its immutable definition.",
    });
  });

  it("control: the fixtures without the drift still parse", () => {
    const definition = parsedDefinition();
    expect(definition.options.map((option) => option.optionKey)).toEqual([
      "yes",
      "no",
    ]);
    expect(
      parseCampaignPollTally(TALLY, definition).options.map(
        (option) => option.counted,
      ),
    ).toEqual([7, 2]);
  });
});
