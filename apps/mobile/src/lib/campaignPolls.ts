/** Strict, PII-free codecs for F14's immutable poll definitions and tallies. */
import { WireShapeError } from "./wireShapeError";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CURSOR = /^[^\u0000-\u001f\u007f-\u009f]+$/u;
const PAGE_SIZE = 100;

export interface CampaignPollDefinition {
  id: string;
  campaignId: string;
  contentRevisionId: string;
  contentRevisionSourceHash: string;
  pollContractSha256: string;
  pollKey: string;
  question: string;
  twoStepRequired: boolean;
  closesAt: string | null;
  options: { optionKey: string; label: string; position: number }[];
  createdAt: string;
}

export interface CampaignPollTally {
  pollId: string;
  pollKey: string;
  contentRevisionId: string;
  question: string;
  options: { optionKey: string; label: string; counted: number }[];
  machineExcluded: number;
  unclassifiedExcluded: number;
  voidedMultiOption: number;
  supersededChoices: number;
  previewedOnly: number;
  submissionReceipts: number;
}

export interface CampaignPollReceipt {
  definition: CampaignPollDefinition;
  tally: CampaignPollTally;
}

export interface CampaignPollDefinitionPage {
  items: CampaignPollDefinition[];
  nextCursor: string | null;
}

export function campaignHasAuthoritativeSemanticPoll(
  sourceMode: unknown,
  contentSchemaVersion: unknown,
  contentBlocks: unknown,
): boolean {
  return (
    sourceMode === "semantic" &&
    contentSchemaVersion === 2 &&
    Array.isArray(contentBlocks) &&
    contentBlocks.some((node) => record(node) && node.type === "poll")
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function timestamp(value: unknown): value is string {
  return bounded(value, 128) && Number.isFinite(Date.parse(value));
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validCursor(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !CURSOR.test(value)
  ) {
    return false;
  }
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes <= 512;
}

function definitionOptions(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 10;
}

function parseDefinitionOption(value: unknown) {
  if (
    !record(value) ||
    !exactKeys(value, ["option_key", "label", "position"]) ||
    typeof value.option_key !== "string" ||
    !STABLE_KEY.test(value.option_key) ||
    !nonEmptyText(value.label) ||
    !count(value.position) ||
    value.position > 9
  ) {
    throw new WireShapeError(
      "campaign poll definition",
      "The campaign poll definition contained an invalid option.",
    );
  }
  return {
    optionKey: value.option_key,
    label: value.label,
    position: value.position,
  };
}

function parseDefinition(value: unknown): CampaignPollDefinition {
  const required = [
    "id",
    "campaign_id",
    "content_revision_id",
    "content_revision_source_hash",
    "poll_contract_sha256",
    "poll_key",
    "question",
    "two_step_required",
    "options",
    "created_at",
  ] as const;
  if (
    !record(value) ||
    !exactKeys(value, required, ["closes_at"]) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    typeof value.campaign_id !== "string" ||
    !UUID.test(value.campaign_id) ||
    typeof value.content_revision_id !== "string" ||
    !UUID.test(value.content_revision_id) ||
    typeof value.content_revision_source_hash !== "string" ||
    !SHA256.test(value.content_revision_source_hash) ||
    typeof value.poll_contract_sha256 !== "string" ||
    !SHA256.test(value.poll_contract_sha256) ||
    typeof value.poll_key !== "string" ||
    !STABLE_KEY.test(value.poll_key) ||
    !nonEmptyText(value.question) ||
    typeof value.two_step_required !== "boolean" ||
    !definitionOptions(value.options) ||
    !timestamp(value.created_at) ||
    (value.closes_at !== undefined && !timestamp(value.closes_at))
  ) {
    throw new WireShapeError(
      "campaign poll definition",
      "The campaign poll definition response was malformed.",
    );
  }
  const options = value.options.map(parseDefinitionOption);
  if (
    new Set(options.map((option) => option.optionKey)).size !==
      options.length ||
    options.some((option, index) => option.position !== index)
  ) {
    throw new WireShapeError(
      "campaign poll definition",
      "The campaign poll definition options were inconsistent.",
    );
  }
  return {
    id: value.id,
    campaignId: value.campaign_id,
    contentRevisionId: value.content_revision_id,
    contentRevisionSourceHash: value.content_revision_source_hash,
    pollContractSha256: value.poll_contract_sha256,
    pollKey: value.poll_key,
    question: value.question,
    twoStepRequired: value.two_step_required,
    closesAt: value.closes_at ?? null,
    options,
    createdAt: value.created_at,
  };
}

export function parseCampaignPollDefinitions(
  payload: unknown,
): CampaignPollDefinition[] {
  return parseCampaignPollDefinitionPage(payload).items;
}

export function parseCampaignPollDefinitionPage(
  payload: unknown,
): CampaignPollDefinitionPage {
  if (
    !record(payload) ||
    !exactKeys(payload, ["items"], ["next_cursor"]) ||
    !Array.isArray(payload.items) ||
    payload.items.length > PAGE_SIZE ||
    (payload.next_cursor !== undefined &&
      !validCursor(payload.next_cursor))
  ) {
    throw new WireShapeError(
      "campaign poll definition register",
      "The campaign poll definition register was malformed.",
    );
  }
  const items = payload.items.map(parseDefinition);
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new WireShapeError(
      "campaign poll definition register",
      "The campaign poll definition register contained duplicate IDs.",
    );
  }
  return {
    items,
    nextCursor:
      typeof payload.next_cursor === "string" ? payload.next_cursor : null,
  };
}

function parseTallyOption(value: unknown) {
  if (
    !record(value) ||
    !exactKeys(value, ["option_key", "label", "counted"]) ||
    typeof value.option_key !== "string" ||
    !STABLE_KEY.test(value.option_key) ||
    !nonEmptyText(value.label) ||
    !count(value.counted)
  ) {
    throw new WireShapeError(
      "campaign poll tally",
      "The campaign poll tally contained an invalid option.",
    );
  }
  return {
    optionKey: value.option_key,
    label: value.label,
    counted: value.counted,
  };
}

export function parseCampaignPollTally(
  payload: unknown,
  definition: CampaignPollDefinition,
): CampaignPollTally {
  const keys = [
    "poll_id",
    "poll_key",
    "content_revision_id",
    "question",
    "options",
    "machine_excluded",
    "unclassified_excluded",
    "voided_multi_option",
    "superseded_choices",
    "previewed_only",
    "submission_receipts",
  ] as const;
  if (
    !record(payload) ||
    !exactKeys(payload, keys) ||
    payload.poll_id !== definition.id ||
    payload.poll_key !== definition.pollKey ||
    payload.content_revision_id !== definition.contentRevisionId ||
    payload.question !== definition.question ||
    !Array.isArray(payload.options) ||
    payload.options.length !== definition.options.length ||
    !count(payload.machine_excluded) ||
    !count(payload.unclassified_excluded) ||
    !count(payload.voided_multi_option) ||
    !count(payload.superseded_choices) ||
    !count(payload.previewed_only) ||
    !count(payload.submission_receipts)
  ) {
    throw new WireShapeError(
      "campaign poll tally",
      "The campaign poll tally response was malformed.",
    );
  }
  const options = payload.options.map(parseTallyOption);
  if (
    options.some(
      (option, index) =>
        option.optionKey !== definition.options[index]?.optionKey ||
        option.label !== definition.options[index]?.label,
    )
  ) {
    throw new WireShapeError(
      "campaign poll tally",
      "The campaign poll tally did not match its immutable definition.",
    );
  }
  return {
    pollId: payload.poll_id,
    pollKey: payload.poll_key,
    contentRevisionId: payload.content_revision_id,
    question: payload.question,
    options,
    machineExcluded: payload.machine_excluded,
    unclassifiedExcluded: payload.unclassified_excluded,
    voidedMultiOption: payload.voided_multi_option,
    supersededChoices: payload.superseded_choices,
    previewedOnly: payload.previewed_only,
    submissionReceipts: payload.submission_receipts,
  };
}
