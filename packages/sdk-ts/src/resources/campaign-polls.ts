// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

const STABLE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE_CURSOR = /^[A-Za-z0-9._-]+$/;
const MATERIALIZATION_FIELDS = new Set([
  "content_revision_id",
  "poll_key",
  "two_step_required",
  "closes_at",
]);

/** Runtime settings for a poll that already exists in a semantic-v2 AST. */
export interface CampaignPollMaterializationInput {
  content_revision_id: string;
  poll_key: string;
  /** Defaults to true at the API. */
  two_step_required?: boolean;
  /** Future RFC 3339 instant. */
  closes_at?: string;
}

export interface CampaignPollDefinitionOption {
  option_key: string;
  label: string;
  position: number;
}

/** Immutable response contract projected from the campaign AST. */
export interface CampaignPollDefinition {
  id: string;
  campaign_id: string;
  poll_key: string;
  question: string;
  two_step_required: boolean;
  closes_at?: string;
  options: CampaignPollDefinitionOption[];
  created_at: string;
}

export interface CampaignPollList {
  items: CampaignPollDefinition[];
  /** Omitted by the API on the terminal page. */
  next_cursor?: string;
}

export interface CampaignPollListOptions {
  /** Defaults to and is capped at 100. */
  limit?: number;
  /** Copy exactly from the preceding page's next_cursor. */
  cursor?: string;
}

export interface CampaignPollOptionTally {
  option_key: string;
  label: string;
  /** Explicitly human-classified, uncontaminated confirmations only. */
  counted: number;
}

/** Aggregate result; unknown classifier output stays visible and excluded. */
export interface CampaignPollTally {
  poll_id: string;
  poll_key: string;
  question: string;
  options: CampaignPollOptionTally[];
  machine_excluded: number;
  /** Missing or unknown classification. Never treated as human. */
  unclassified_excluded: number;
  voided_multi_option: number;
  previewed_only: number;
}

/** Authenticated campaign poll authoring and aggregate-report operations. */
export class CampaignPollsResource extends Resource {
  /**
   * Materialize one existing semantic poll. Question/options cannot be sent;
   * they are read only from the exact immutable content revision.
   */
  materialize(
    campaignId: string,
    input: CampaignPollMaterializationInput,
  ): Promise<CampaignPollDefinition> {
    const campaign = pathSegment(campaignId, "campaign ID");
    const body = materializationBody(input);
    return this.client.request("POST", `/api/v1/campaigns/${campaign}/polls`, {
      body,
    });
  }

  /** List one bounded keyset page owned by one campaign. */
  list(
    campaignId: string,
    options: CampaignPollListOptions = {},
  ): Promise<CampaignPollList> {
    const campaign = pathSegment(campaignId, "campaign ID");
    return this.client.request("GET", `/api/v1/campaigns/${campaign}/polls`, {
      query: campaignPollListQuery(options),
    });
  }

  /** Read counted votes and every excluded population. */
  tally(campaignId: string, pollKey: string): Promise<CampaignPollTally> {
    const campaign = pathSegment(campaignId, "campaign ID");
    const poll = stableReferenceSegment(pollKey, "poll key");
    return this.client.request(
      "GET",
      `/api/v1/campaigns/${campaign}/polls/${poll}/tally`,
    );
  }
}

function campaignPollListQuery(
  options: CampaignPollListOptions,
): Record<string, string | number | undefined> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("campaign poll list options must be an object");
  }
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
  ) {
    throw new TypeError("campaign poll list limit must be an integer from 1 to 100");
  }
  if (options.cursor !== undefined) validateOpaqueCursor(options.cursor);
  return { limit: options.limit, cursor: options.cursor };
}

function validateOpaqueCursor(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    !OPAQUE_CURSOR.test(value)
  ) {
    throw new TypeError(
      "campaign poll list cursor must be a 1-512 byte opaque ASCII cursor",
    );
  }
}

function materializationBody(
  input: CampaignPollMaterializationInput,
): CampaignPollMaterializationInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(
      "campaign poll materialization input must be an object",
    );
  }
  const extras = Object.keys(input).filter(
    (field) => !MATERIALIZATION_FIELDS.has(field),
  );
  if (extras.length > 0) {
    throw new TypeError(
      "campaign poll materialization accepts runtime settings only; question and options come from the semantic AST",
    );
  }
  const contentRevision = requiredString(
    input.content_revision_id,
    "content revision ID",
  );
  const pollKey = stableReference(input.poll_key, "poll key");
  if (
    input.two_step_required !== undefined &&
    typeof input.two_step_required !== "boolean"
  ) {
    throw new TypeError("campaign poll two_step_required must be a boolean");
  }
  if (
    input.closes_at !== undefined &&
    (typeof input.closes_at !== "string" || input.closes_at.trim() === "")
  ) {
    throw new TypeError(
      "campaign poll closes_at must be a non-empty timestamp",
    );
  }
  const body: CampaignPollMaterializationInput = {
    content_revision_id: contentRevision,
    poll_key: pollKey,
  };
  if (input.two_step_required !== undefined) {
    body.two_step_required = input.two_step_required;
  }
  if (input.closes_at !== undefined) body.closes_at = input.closes_at;
  return body;
}

function requiredString(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`campaign poll ${label} is required`);
  }
  return value;
}

function stableReference(value: string, label: string): string {
  if (typeof value !== "string" || !STABLE_REFERENCE.test(value)) {
    throw new TypeError(
      `campaign poll ${label} must be a 1-128 byte stable ASCII reference`,
    );
  }
  return value;
}

function pathSegment(value: string, label: string): string {
  return encodeURIComponent(requiredString(value, label));
}

function stableReferenceSegment(value: string, label: string): string {
  return encodeURIComponent(stableReference(value, label));
}
