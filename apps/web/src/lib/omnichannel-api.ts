/**
 * lib/omnichannel-api.ts — omnichannel campaigns.
 *
 * Four `/api/v1/omnichannel/*` paths were reached by desktop and by no web
 * file.
 *
 * THE SERVER SAYS THIS IS TURNED OFF, IN SO MANY WORDS. `/catalog` answers
 * with a `runtime` block:
 *
 *     "runtime": { "capability": "omnichannel_campaign_execution",
 *                  "runtime_status": "unavailable",
 *                  "execution_enabled": false,
 *                  "code": "omnichannel_runtime_unavailable",
 *                  "message": "..." }
 *
 * A UI that lists the channels without that block invites somebody to build a
 * campaign that cannot be executed. The runtime is carried through and the
 * page leads with the server's own message.
 *
 * COVERAGE: this module wires 3 of them:
 *   GET /api/v1/omnichannel/catalog
 *   GET /api/v1/omnichannel/campaigns
 *   GET /api/v1/omnichannel/campaigns/{id}   (stored path summary)
 * POST /campaigns is not called from web: draft creation is release-held.
 */
import { api } from "@/lib/api";

export interface OmnichannelRuntime {
  capability?: string;
  runtime_status?: string;
  execution_enabled?: boolean;
  code?: string;
  /** The server's own explanation. Render verbatim. */
  message?: string;
}

export interface OmnichannelCatalog {
  schema_version?: string;
  runtime: OmnichannelRuntime;
  channels: unknown[];
  send_strategies: unknown[];
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function getOmnichannelCatalog(): Promise<OmnichannelCatalog> {
  const res = await api.get<OmnichannelCatalog>("/api/v1/omnichannel/catalog");
  return {
    ...res,
    runtime:
      res?.runtime && typeof res.runtime === "object" ? res.runtime : {},
    channels: asArray(res?.channels),
    send_strategies: asArray(res?.send_strategies),
  };
}

/** True when the server reports execution is not available. */
export function omnichannelIsUnavailable(rt: OmnichannelRuntime): boolean {
  return rt.execution_enabled === false || rt.runtime_status === "unavailable";
}

/** Cross-channel campaigns. */
export async function listOmnichannelCampaigns(): Promise<unknown[]> {
  const r = await api.get<{ items?: unknown }>("/api/v1/omnichannel/campaigns");
  return Array.isArray(r?.items) ? r.items : [];
}

// ---------------------------------------------------------------------------
// Stored campaign detail — the "partial path summary".
//
// GET /campaigns/{id} returns the whole stored definition. Only the identity,
// stored status, snapshot mode, timestamps, and PATH rows are carried through:
// objective, audience strategy, schedule, send strategy, template identity,
// and per-path settings are not represented, and the dialog says so.
// ---------------------------------------------------------------------------

export interface OmnichannelCampaignPath {
  id?: string;
  path_key: string;
  name: string;
  channel: string;
  status?: string;
  fallback_path_key?: string;
  message_template_id?: string;
  traffic_weight_basis_points?: number;
  sequence?: number;
}

export interface OmnichannelCampaign {
  id: string;
  name: string;
  status?: string;
  recipient_snapshot_mode?: string;
  created_at?: string;
  updated_at?: string;
  /** Path definitions only — see the module note above. */
  paths: OmnichannelCampaignPath[];
}

export class OmnichannelContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmnichannelContractError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonBlank(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 512
  );
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!nonBlank(value))
    throw new OmnichannelContractError(
      `The server returned a malformed campaign ${field}.`,
    );
  return value.trim();
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  const normalized = optionalText(value, field);
  if (normalized !== undefined && !Number.isFinite(Date.parse(normalized)))
    throw new OmnichannelContractError(
      `The server returned a malformed campaign ${field}.`,
    );
  return normalized;
}

function optionalInteger(
  value: unknown,
  field: string,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max)
    throw new OmnichannelContractError(
      `The server returned a malformed campaign ${field}.`,
    );
  return Number(value);
}

function normalizePaths(value: unknown): OmnichannelCampaignPath[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new OmnichannelContractError(
      "The server returned malformed campaign paths.",
    );
  const keys = new Set<string>();
  return value.map((candidate) => {
    const path = asRecord(candidate);
    if (
      !path ||
      !nonBlank(path.path_key) ||
      !nonBlank(path.name) ||
      !nonBlank(path.channel)
    )
      throw new OmnichannelContractError(
        "The server returned an incomplete campaign path.",
      );
    const key = path.path_key.trim();
    if (keys.has(key))
      throw new OmnichannelContractError(
        "The server returned duplicate campaign path keys.",
      );
    keys.add(key);
    const id = optionalText(path.id, "path identity");
    const status = optionalText(path.status, "path status");
    const fallback = optionalText(path.fallback_path_key, "path fallback");
    const template = optionalText(path.message_template_id, "path template");
    const weight = optionalInteger(
      path.traffic_weight_basis_points,
      "path traffic weight",
      10_000,
    );
    const sequence = optionalInteger(
      path.sequence,
      "path sequence",
      Number.MAX_SAFE_INTEGER,
    );
    return {
      ...(id ? { id } : {}),
      path_key: key,
      name: path.name.trim(),
      channel: path.channel.trim(),
      ...(status ? { status } : {}),
      ...(fallback ? { fallback_path_key: fallback } : {}),
      ...(template ? { message_template_id: template } : {}),
      ...(weight !== undefined ? { traffic_weight_basis_points: weight } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
    };
  });
}

export function normalizeOmnichannelCampaign(input: unknown): OmnichannelCampaign {
  const campaign = asRecord(input);
  if (!campaign || !nonBlank(campaign.id) || !nonBlank(campaign.name))
    throw new OmnichannelContractError(
      "The server returned an incomplete campaign definition.",
    );
  const status = optionalText(campaign.status, "status");
  const snapshotMode = optionalText(
    campaign.recipient_snapshot_mode,
    "snapshot mode",
  );
  const createdAt = optionalTimestamp(campaign.created_at, "creation time");
  const updatedAt = optionalTimestamp(campaign.updated_at, "update time");
  return {
    id: campaign.id.trim(),
    name: campaign.name.trim(),
    ...(status ? { status } : {}),
    ...(snapshotMode ? { recipient_snapshot_mode: snapshotMode } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    paths: normalizePaths(campaign.paths),
  };
}

/** GET /api/v1/omnichannel/campaigns/{id} — one stored definition with its paths. */
export async function getOmnichannelCampaign(
  id: string,
  signal?: AbortSignal,
): Promise<OmnichannelCampaign> {
  const campaignId = id.trim();
  if (!campaignId)
    throw new OmnichannelContractError("A campaign identity is required.");
  const campaign = normalizeOmnichannelCampaign(
    await api.get<unknown>(
      `/api/v1/omnichannel/campaigns/${encodeURIComponent(campaignId)}`,
      { signal },
    ),
  );
  if (campaign.id !== campaignId)
    throw new OmnichannelContractError(
      "The server returned a different campaign definition.",
    );
  return campaign;
}
