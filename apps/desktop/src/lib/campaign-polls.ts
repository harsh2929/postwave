// SPDX-License-Identifier: AGPL-3.0-only

import { apiRequest } from "./api-client";
import type { ApiResult } from "./api/result";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CURSOR = /^[^\u0000-\u001f\u007f-\u009f]+$/u;
const PAGE_SIZE = 100;

export interface CampaignPollDefinitionOption {
  optionKey: string;
  label: string;
  position: number;
}

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
  options: CampaignPollDefinitionOption[];
  createdAt: string;
}

export interface CampaignPollTally {
  pollId: string;
  pollKey: string;
  contentRevisionId: string;
  question: string;
  options: Array<{ optionKey: string; label: string; counted: number }>;
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

export interface FrozenCampaignPollRevision {
  revisionId: string;
  campaignId: string;
  sourceHash: string;
  pollKeys: string[];
}

export interface CampaignPollMaterializationReceipt {
  revision: FrozenCampaignPollRevision;
  definitions: CampaignPollDefinition[];
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

export function campaignStatusAllowsPollMaterialization(
  status: unknown,
): boolean {
  return (
    typeof status === "string" &&
    ["draft", "scheduled", "paused", "failed"].includes(status.toLowerCase())
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

function parseDefinitionOption(value: unknown): CampaignPollDefinitionOption {
  if (
    !record(value) ||
    !exactKeys(value, ["option_key", "label", "position"]) ||
    typeof value.option_key !== "string" ||
    !STABLE_KEY.test(value.option_key) ||
    !nonEmptyText(value.label) ||
    !count(value.position) ||
    value.position > 9
  ) {
    throw new Error(
      "The campaign poll definition contained an invalid option.",
    );
  }
  return {
    optionKey: value.option_key,
    label: value.label,
    position: value.position,
  };
}

export function parseCampaignPollDefinition(
  value: unknown,
): CampaignPollDefinition {
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
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 10 ||
    !timestamp(value.created_at) ||
    (value.closes_at !== undefined && !timestamp(value.closes_at))
  ) {
    throw new Error("The campaign poll definition response was malformed.");
  }
  const options = value.options.map(parseDefinitionOption);
  if (
    new Set(options.map((option) => option.optionKey)).size !==
      options.length ||
    options.some((option, index) => option.position !== index)
  ) {
    throw new Error("The campaign poll definition options were inconsistent.");
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
    throw new Error("The campaign poll definition register was malformed.");
  }
  const items = payload.items.map(parseCampaignPollDefinition);
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error(
      "The campaign poll definition register contained duplicate IDs.",
    );
  }
  return {
    items,
    nextCursor:
      typeof payload.next_cursor === "string" ? payload.next_cursor : null,
  };
}

export function parseFrozenCampaignPollRevision(
  payload: unknown,
  expectedCampaignId: string,
): FrozenCampaignPollRevision {
  const required = [
    "id",
    "campaign_id",
    "revision_no",
    "source_mode",
    "content_schema_version",
    "subject",
    "semantic_tree",
    "fact_contract",
    "variants",
    "locales",
    "tracking_settings",
    "source_hash",
    "created_at",
  ] as const;
  if (
    !record(payload) ||
    !exactKeys(payload, required, [
      "preview_text",
      "legacy_html",
      "reviewed_plain_text",
      "created_by",
    ]) ||
    typeof payload.id !== "string" ||
    !UUID.test(payload.id) ||
    payload.campaign_id !== expectedCampaignId ||
    typeof payload.revision_no !== "number" ||
    !Number.isSafeInteger(payload.revision_no) ||
    payload.revision_no < 1 ||
    payload.source_mode !== "semantic" ||
    payload.content_schema_version !== 2 ||
    typeof payload.source_hash !== "string" ||
    !SHA256.test(payload.source_hash) ||
    !timestamp(payload.created_at) ||
    !Array.isArray(payload.semantic_tree)
  ) {
    throw new Error(
      "The frozen campaign revision response was not an exact semantic v2 revision.",
    );
  }
  const pollKeys: string[] = [];
  for (const rawNode of payload.semantic_tree) {
    if (!record(rawNode) || typeof rawNode.type !== "string") {
      throw new Error(
        "The frozen semantic revision contained an invalid node.",
      );
    }
    if (rawNode.type !== "poll") continue;
    const content = record(rawNode.content) ? rawNode.content : null;
    const poll = content && record(content.poll) ? content.poll : null;
    if (
      !poll ||
      !exactKeys(poll, ["poll_id", "question", "options"]) ||
      typeof poll.poll_id !== "string" ||
      !STABLE_KEY.test(poll.poll_id) ||
      !record(poll.question) ||
      !Array.isArray(poll.options)
    ) {
      throw new Error(
        "The frozen semantic revision contained an invalid poll identity.",
      );
    }
    pollKeys.push(poll.poll_id);
  }
  if (new Set(pollKeys).size !== pollKeys.length) {
    throw new Error(
      "The frozen semantic revision contained duplicate poll identities.",
    );
  }
  return {
    revisionId: payload.id,
    campaignId: expectedCampaignId,
    sourceHash: payload.source_hash,
    pollKeys,
  };
}

function parseFailure(message: string, code?: string): ApiResult<never> {
  return {
    error: { kind: "parse", message, ...(code ? { code } : {}) },
    retryability: "manual",
  };
}

export async function listCampaignPollDefinitions(
  campaignId: string,
): Promise<ApiResult<CampaignPollDefinition[]>> {
  const base = `/api/v1/campaigns/${encodeURIComponent(campaignId)}/polls`;
  const definitions: CampaignPollDefinition[] = [];
  const seenDefinitionIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await apiRequest<unknown>(
      `${base}?limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (result.error) return result;
    try {
      const page = parseCampaignPollDefinitionPage(result.data);
      for (const definition of page.items) {
        if (seenDefinitionIds.has(definition.id)) {
          return parseFailure(
            "The paginated campaign poll register contained a duplicate definition ID.",
          );
        }
        seenDefinitionIds.add(definition.id);
        definitions.push(definition);
      }
      if (page.nextCursor && seenCursors.has(page.nextCursor)) {
        return parseFailure(
          "The paginated campaign poll register repeated a cursor.",
        );
      }
      if (page.nextCursor) seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } catch (error) {
      return parseFailure(
        error instanceof Error
          ? error.message
          : "Invalid campaign poll register.",
      );
    }
  } while (cursor);
  return { data: definitions };
}

function definitionMatchesRevision(
  definition: CampaignPollDefinition,
  revision: FrozenCampaignPollRevision,
  pollKey: string,
): boolean {
  return (
    definition.campaignId === revision.campaignId &&
    definition.contentRevisionId === revision.revisionId &&
    definition.contentRevisionSourceHash === revision.sourceHash &&
    definition.pollKey === pollKey &&
    definition.twoStepRequired
  );
}

function definitionHasRevisionIdentity(
  definition: CampaignPollDefinition,
  revision: FrozenCampaignPollRevision,
  pollKey: string,
): boolean {
  return (
    definition.campaignId === revision.campaignId &&
    definition.contentRevisionId === revision.revisionId &&
    definition.pollKey === pollKey
  );
}

function pollConflict(pollKey: string): ApiResult<never> {
  return parseFailure(
    `Poll ${pollKey} is already materialized against a different revision or without two-step confirmation. Desktop will not replace immutable poll identity; review the existing receipt before proceeding.`,
    "campaign_poll_revision_conflict",
  );
}

/** Freeze persisted semantic content, then materialize only poll identities
 * read back from that exact revision. Each create is a single wire attempt;
 * the immutable register reconciles an ambiguous response before success. */
export async function materializeCurrentCampaignPolls(
  campaignId: string,
): Promise<ApiResult<CampaignPollMaterializationReceipt>> {
  const frozen = await apiRequest<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/content-revisions`,
    { method: "POST", body: "{}" },
    { requireOnline: true, maxAttempts: 3 },
  );
  if (frozen.error) return frozen;
  let revision: FrozenCampaignPollRevision;
  try {
    revision = parseFrozenCampaignPollRevision(frozen.data, campaignId);
  } catch (error) {
    return parseFailure(
      error instanceof Error
        ? error.message
        : "Invalid frozen campaign revision.",
    );
  }
  if (revision.pollKeys.length === 0) {
    return parseFailure(
      "The frozen semantic revision contains no poll nodes to materialize.",
    );
  }

  const initial = await listCampaignPollDefinitions(campaignId);
  if (initial.error) return initial;
  let register = initial.data;
  const definitions: CampaignPollDefinition[] = [];
  for (const pollKey of revision.pollKeys) {
    const existing = register.find((definition) =>
      definitionHasRevisionIdentity(definition, revision, pollKey),
    );
    if (existing) {
      if (!definitionMatchesRevision(existing, revision, pollKey)) {
        return pollConflict(pollKey);
      }
      definitions.push(existing);
      continue;
    }

    const created = await apiRequest<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/polls`,
      {
        method: "POST",
        body: JSON.stringify({
          content_revision_id: revision.revisionId,
          poll_key: pollKey,
          two_step_required: true,
        }),
      },
      { requireOnline: true, maxAttempts: 1 },
    );
    let createFailure: ApiResult<never> | null = created.error ? created : null;
    if (!created.error) {
      try {
        const definition = parseCampaignPollDefinition(created.data);
        if (!definitionMatchesRevision(definition, revision, pollKey)) {
          createFailure = parseFailure(
            "The poll materialization response did not match the frozen revision.",
          );
        } else {
          definitions.push(definition);
          register = [...register, definition];
          continue;
        }
      } catch (error) {
        createFailure = parseFailure(
          error instanceof Error
            ? error.message
            : "Invalid poll materialization response.",
        );
      }
    }

    const reconciled = await listCampaignPollDefinitions(campaignId);
    if (reconciled.error) return createFailure ?? reconciled;
    const after = reconciled.data.find((definition) =>
      definitionHasRevisionIdentity(definition, revision, pollKey),
    );
    if (after && definitionMatchesRevision(after, revision, pollKey)) {
      definitions.push(after);
      register = reconciled.data;
      continue;
    }
    if (after) return pollConflict(pollKey);
    if (createFailure) return createFailure;
    return parseFailure("The poll materialization result was unavailable.");
  }
  return { data: { revision, definitions } };
}

/** Fail-closed dispatch preflight for an authoritative semantic poll draft. */
export async function ensureCurrentCampaignPollsReady(
  campaignId: string,
): Promise<ApiResult<CampaignPollMaterializationReceipt>> {
  const result = await materializeCurrentCampaignPolls(campaignId);
  if (result.error) return result;
  if (
    result.data.revision.pollKeys.length === 0 ||
    result.data.definitions.length !== result.data.revision.pollKeys.length
  ) {
    return parseFailure(
      "Exact semantic poll contracts could not be verified for every frozen poll.",
      "campaign_poll_materialization_incomplete",
    );
  }
  return result;
}

function parseTallyOption(
  value: unknown,
): CampaignPollTally["options"][number] {
  if (
    !record(value) ||
    !exactKeys(value, ["option_key", "label", "counted"]) ||
    typeof value.option_key !== "string" ||
    !STABLE_KEY.test(value.option_key) ||
    !nonEmptyText(value.label) ||
    !count(value.counted)
  ) {
    throw new Error("The campaign poll tally contained an invalid option.");
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
    throw new Error("The campaign poll tally response was malformed.");
  }
  const options = payload.options.map(parseTallyOption);
  if (
    options.some(
      (option, index) =>
        option.optionKey !== definition.options[index]?.optionKey ||
        option.label !== definition.options[index]?.label,
    )
  ) {
    throw new Error(
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

export async function listCampaignPollReceipts(
  campaignId: string,
): Promise<ApiResult<CampaignPollReceipt[]>> {
  const list = await listCampaignPollDefinitions(campaignId);
  if (list.error) return list;
  const definitions = list.data;
  const receipts: CampaignPollReceipt[] = [];
  for (const definition of definitions) {
    const result = await apiRequest<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/polls/${encodeURIComponent(definition.pollKey)}/tally?content_revision_id=${encodeURIComponent(definition.contentRevisionId)}`,
    );
    if (result.error) return result;
    try {
      receipts.push({
        definition,
        tally: parseCampaignPollTally(result.data, definition),
      });
    } catch (error) {
      return {
        error: {
          kind: "parse",
          message:
            error instanceof Error
              ? error.message
              : "Invalid campaign poll tally.",
        },
        retryability: "manual",
      };
    }
  }
  return { data: receipts };
}
