// SPDX-License-Identifier: AGPL-3.0-only
import type { WritebackTargetInput } from "@/lib/writeback-api";

// Settings keys the create form owns; the advanced-JSON escape hatch must not
// silently override them. It is only for provider-specific extras like
// shop_domain / list_id / event_name / object.
export const RESERVED_SETTING_KEYS = [
  "source_segment_id",
  "source_list_id",
  "tags",
  "field_map",
  "trait_field_map",
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface KeyValueRow {
  id: string;
  key: string;
  value: string;
}

export interface BuildWritebackTargetInputArgs {
  advancedJson: string;
  credentialsRef: string;
  fieldRows: KeyValueRow[];
  name: string;
  provider: string;
  sourceKind: "segment" | "list";
  sourceListId: string;
  sourceSegmentId: string;
  syncInterval: string;
  tags: string;
  traitRows: KeyValueRow[];
}

export type BuildWritebackTargetInputResult =
  | { ok: true; input: WritebackTargetInput }
  | { ok: false; error: string };

export function newWritebackRow(): KeyValueRow {
  return { id: crypto.randomUUID(), key: "", value: "" };
}

export function rowsToMap(rows: KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (k) out[k] = row.value.trim();
  }
  return out;
}

// A row with exactly one of key/value filled is almost certainly a mistake.
// rowsToMap (and the backend) would silently drop it, so we surface it instead.
export function hasIncompleteRow(rows: KeyValueRow[]): boolean {
  return rows.some((row) => {
    const k = row.key.trim();
    const v = row.value.trim();
    return (k === "" && v !== "") || (k !== "" && v === "");
  });
}

export function buildWritebackTargetInput({
  advancedJson,
  credentialsRef,
  fieldRows,
  name,
  provider,
  sourceKind,
  sourceListId,
  sourceSegmentId,
  syncInterval,
  tags,
  traitRows,
}: BuildWritebackTargetInputArgs): BuildWritebackTargetInputResult {
  if (!provider) {
    return { ok: false, error: "Pick a provider." };
  }
  if (!credentialsRef.trim()) {
    return { ok: false, error: "A vault credential reference is required." };
  }

  const settings: Record<string, unknown> = {};
  if (sourceKind === "segment") {
    if (!sourceSegmentId) {
      return { ok: false, error: "Choose a source segment." };
    }
    settings.source_segment_id = sourceSegmentId;
  } else {
    const listId = sourceListId.trim();
    if (!listId) {
      return { ok: false, error: "Enter a source list id." };
    }
    if (!UUID_RE.test(listId)) {
      return { ok: false, error: "Source list id must be a valid UUID." };
    }
    settings.source_list_id = listId;
  }

  if (hasIncompleteRow(fieldRows)) {
    return {
      ok: false,
      error: "Every static field needs both a platform field and a value.",
    };
  }
  if (hasIncompleteRow(traitRows)) {
    return {
      ok: false,
      error: "Every trait mapping needs both a platform field and a trait key.",
    };
  }

  const tagList = tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tagList.length) settings.tags = tagList;

  const fieldMap = rowsToMap(fieldRows);
  if (Object.keys(fieldMap).length) settings.field_map = fieldMap;
  const traitMap = rowsToMap(traitRows);
  if (Object.keys(traitMap).length) settings.trait_field_map = traitMap;

  if (advancedJson.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(advancedJson);
    } catch {
      return { ok: false, error: "Advanced settings must be valid JSON." };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error: "Advanced settings must be a JSON object.",
      };
    }
    const parsedSettings = parsed as Record<string, unknown>;
    const clashes = Object.keys(parsedSettings).filter((key) =>
      RESERVED_SETTING_KEYS.includes(key),
    );
    if (clashes.length) {
      return {
        ok: false,
        error: `Advanced settings can't override ${clashes.join(", ")} - use the fields above.`,
      };
    }
    Object.assign(settings, parsedSettings);
  }

  const interval = Number.parseInt(syncInterval, 10);

  return {
    ok: true,
    input: {
      provider,
      name: name.trim() || undefined,
      status: "active",
      credentials_ref: credentialsRef.trim(),
      settings,
      sync_interval_minutes:
        Number.isFinite(interval) && interval > 0 ? interval : 0,
    },
  };
}
