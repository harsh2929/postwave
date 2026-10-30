/**
 * Pure helpers for the Omnichannel campaigns section (#30).
 *
 * The channel catalog drives the create form dynamically: each
 * OmniCatalogItem may carry a `fields` spec (key/type/required/
 * options) that we map to form controls and coerce back to typed
 * values for the path's `settings` object. None of this imports
 * React — it is unit-tested under the node vitest environment.
 */

import type {
  OmniCampaign,
  OmniCampaignPath,
  OmniCatalogItem,
  OmniCatalogResponse,
} from "../../lib/api-client";

export function basisPointsToPercent(bp?: number): string {
  if (bp == null || !Number.isFinite(bp)) return "—";
  return `${(bp / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

/* ---------- untrusted response normalization ---------- */

export type OmniNormalization<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

function record(value: unknown): Record<string, unknown> | null {
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

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  return nonBlank(value) ? value.trim() : null;
}

function optionalTimestamp(value: unknown): string | undefined | null {
  const normalized = optionalString(value);
  if (normalized === null || normalized === undefined) return normalized;
  return Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

function normalizeCatalogItems(value: unknown): OmniCatalogItem[] | null {
  if (!Array.isArray(value)) return null;
  const keys = new Set<string>();
  const items: OmniCatalogItem[] = [];
  for (const candidate of value) {
    const item = record(candidate);
    if (
      !item ||
      !nonBlank(item.key) ||
      !nonBlank(item.label) ||
      !nonBlank(item.runtime_status)
    ) {
      return null;
    }
    const key = item.key.trim();
    if (keys.has(key)) return null;
    keys.add(key);
    let fields: OmniCatalogItem["fields"];
    if (item.fields !== undefined) {
      if (!Array.isArray(item.fields)) return null;
      const fieldKeys = new Set<string>();
      fields = [];
      for (const fieldCandidate of item.fields) {
        const field = record(fieldCandidate);
        if (!field || !nonBlank(field.key) || !nonBlank(field.type)) {
          return null;
        }
        const fieldKey = field.key.trim();
        if (fieldKeys.has(fieldKey)) return null;
        fieldKeys.add(fieldKey);
        if (
          field.required !== undefined &&
          typeof field.required !== "boolean"
        ) {
          return null;
        }
        if (
          field.options !== undefined &&
          (!Array.isArray(field.options) ||
            !field.options.every((option) => nonBlank(option)))
        ) {
          return null;
        }
        fields.push({
          key: fieldKey,
          type: field.type.trim(),
          ...(typeof field.required === "boolean"
            ? { required: field.required }
            : {}),
          ...(Array.isArray(field.options)
            ? { options: field.options.map((option) => option.trim()) }
            : {}),
        });
      }
    }
    items.push({
      key,
      label: item.label.trim(),
      runtime_status: item.runtime_status.trim(),
      ...(nonBlank(item.provider) ? { provider: item.provider.trim() } : {}),
      ...(fields ? { fields } : {}),
    });
  }
  return items;
}

export function normalizeOmniCatalog(
  input: unknown,
): OmniNormalization<OmniCatalogResponse> {
  const source = record(input);
  if (!source || !nonBlank(source.schema_version)) {
    return {
      ok: false,
      message: "The server returned a malformed channel schema.",
    };
  }
  const channels = normalizeCatalogItems(source.channels);
  const sendStrategies = normalizeCatalogItems(source.send_strategies);
  const snapshotModes = normalizeCatalogItems(source.recipient_snapshot_modes);
  const pathStatuses = source.path_statuses;
  if (
    !channels ||
    !sendStrategies ||
    !snapshotModes ||
    !Array.isArray(pathStatuses) ||
    !pathStatuses.every((status) => nonBlank(status))
  ) {
    return {
      ok: false,
      message: "The server returned a malformed channel schema.",
    };
  }
  return {
    ok: true,
    value: {
      schema_version: source.schema_version.trim(),
      channels,
      send_strategies: sendStrategies,
      recipient_snapshot_modes: snapshotModes,
      path_statuses: pathStatuses.map((status) => status.trim()),
    },
  };
}

function normalizeCampaignPaths(value: unknown): OmniCampaignPath[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const keys = new Set<string>();
  const paths: OmniCampaignPath[] = [];
  for (const candidate of value) {
    const path = record(candidate);
    if (
      !path ||
      !nonBlank(path.path_key) ||
      !nonBlank(path.name) ||
      !nonBlank(path.channel)
    ) {
      return null;
    }
    const key = path.path_key.trim();
    const id = nonBlank(path.id) ? path.id.trim() : undefined;
    const status = optionalString(path.status);
    const fallback = optionalString(path.fallback_path_key);
    const template = optionalString(path.message_template_id);
    if (keys.has(key) || (id !== undefined && ids.has(id))) return null;
    keys.add(key);
    if (id) ids.add(id);
    if (
      path.sequence !== undefined &&
      (typeof path.sequence !== "number" ||
        !Number.isInteger(path.sequence) ||
        path.sequence < 0)
    ) {
      return null;
    }
    if (
      path.traffic_weight_basis_points !== undefined &&
      (typeof path.traffic_weight_basis_points !== "number" ||
        !Number.isFinite(path.traffic_weight_basis_points) ||
        path.traffic_weight_basis_points < 0 ||
        path.traffic_weight_basis_points > 10_000)
    ) {
      return null;
    }
    if (status === null || fallback === null || template === null) return null;
    paths.push({
      ...(id ? { id } : {}),
      path_key: key,
      name: path.name.trim(),
      channel: path.channel.trim(),
      ...(status ? { status } : {}),
      ...(fallback ? { fallback_path_key: fallback } : {}),
      ...(template ? { message_template_id: template } : {}),
      ...(typeof path.sequence === "number" ? { sequence: path.sequence } : {}),
      ...(typeof path.traffic_weight_basis_points === "number"
        ? { traffic_weight_basis_points: path.traffic_weight_basis_points }
        : {}),
    });
  }
  return paths;
}

export function normalizeOmniCampaignList(
  input: unknown,
): OmniNormalization<OmniCampaign[]> {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      message: "The server returned a malformed campaign definition list.",
    };
  }
  const ids = new Set<string>();
  const campaigns: OmniCampaign[] = [];
  for (const candidate of input) {
    const campaign = record(candidate);
    if (!campaign || !nonBlank(campaign.id) || !nonBlank(campaign.name)) {
      return {
        ok: false,
        message: "The server returned incomplete campaign identities.",
      };
    }
    const id = campaign.id.trim();
    const name = campaign.name.trim();
    const paths = normalizeCampaignPaths(campaign.paths);
    const status = optionalString(campaign.status);
    const snapshotMode = optionalString(campaign.recipient_snapshot_mode);
    const createdAt = optionalTimestamp(campaign.created_at);
    const updatedAt = optionalTimestamp(campaign.updated_at);
    if (
      ids.has(id) ||
      paths === null ||
      status === null ||
      snapshotMode === null ||
      createdAt === null ||
      updatedAt === null
    ) {
      return {
        ok: false,
        message:
          "The server returned duplicate or malformed campaign identities.",
      };
    }
    ids.add(id);
    campaigns.push({
      id,
      name,
      paths,
      ...(status ? { status } : {}),
      ...(snapshotMode ? { recipient_snapshot_mode: snapshotMode } : {}),
      ...(createdAt ? { created_at: createdAt } : {}),
      ...(updatedAt ? { updated_at: updatedAt } : {}),
    });
  }
  return { ok: true, value: campaigns };
}

export function normalizeOmniCampaign(
  input: unknown,
): OmniNormalization<OmniCampaign> {
  const normalized = normalizeOmniCampaignList([input]);
  return normalized.ok ? { ok: true, value: normalized.value[0]! } : normalized;
}
