/**
 * lib/omnichannelDefinitions.ts — reading a cross-channel campaign DEFINITION.
 *
 * BACKS the three read routes in apps/api/internal/omnichannel/omnichannel.go:
 *
 *   GET /api/v1/omnichannel/catalog          (:145)  — the channel schema
 *   GET /api/v1/omnichannel/campaigns        (:146)  — every definition, newest first
 *   GET /api/v1/omnichannel/campaigns/{id}   (:147)  — one definition
 *
 * THE ONE FACT THIS WHOLE SURFACE HANGS ON. Omnichannel EXECUTION is
 * deliberately fail-closed: `omnichannelRuntimeQualified` is the constant
 * `false` (omnichannel.go:22), every catalog channel is emitted with
 * `runtime_status: "unavailable"` (:236-242), and every campaign response is
 * stamped with the same `runtimecapability.Descriptor` by
 * `annotateCampaignRuntime` (:436). Nothing here is running. A definition's
 * `status` — "scheduled", "sending", "sent" — is PERSISTED METADATA on a row,
 * not a report from a dispatcher, and a mobile screen that renders those as
 * live campaign states would be inventing a delivery system that does not
 * exist. `runtimeIsExecuting` exists so no component has to remember that, and
 * `pathStatusIsRuntimeClaim` marks the specific status values that would read
 * as a live claim if they were shown without the caveat.
 *
 * WHAT A DEFINITION ACTUALLY IS. A campaign holds up to ten PATHS, each pinned
 * to one channel (email / sms / whatsapp / rcs / push) with a traffic weight in
 * basis points. `Validate` requires a multi-path campaign's weights to total
 * exactly 10000 (:355) — so a stored definition whose weights do not is one
 * that was written before the rule, or written past it, and the screen should
 * say so rather than render a pie that does not close. `trafficSplit` returns
 * that verdict alongside the percentages.
 *
 * WHAT IS DELIBERATELY NOT MODELLED HERE. `audience_strategy`, `schedule`,
 * `send_strategy`, per-path `audience` and per-path `settings` are free-form
 * `map[string]any` on the wire with no schema anywhere in the package. They are
 * carried through as opaque records so a detail view can show that they exist
 * and how many keys they hold, and they are never interpreted — inventing a
 * shape for an unschema'd map is how a phone starts confidently mis-describing
 * a definition somebody's desktop wrote.
 *
 * Import-free (house rule 5); the rules are exercised by
 * omnichannelDefinitions.test.ts in the node vitest environment.
 */

/** The 10000-basis-point total `Validate` requires of a multi-path campaign. */
export const TRAFFIC_BASIS_POINT_TOTAL = 10000;

/** Ceiling enforced by `Validate` (omnichannel.go:277). */
export const MAX_CAMPAIGN_PATHS = 10;

export interface OmniRuntime {
  capability: string;
  runtimeStatus: string;
  executionEnabled: boolean;
  code: string;
  message: string;
  prerequisites: string[];
}

export interface OmniCatalogItem {
  key: string;
  label: string;
  runtimeStatus: string;
  provider: string | null;
  requiredFields: string[];
}

export interface OmniCatalog {
  schemaVersion: string | null;
  runtime: OmniRuntime | null;
  channels: OmniCatalogItem[];
  sendStrategies: OmniCatalogItem[];
  snapshotModes: OmniCatalogItem[];
  pathStatuses: string[];
}

export interface OmniPath {
  id: string;
  pathKey: string;
  name: string;
  channel: string;
  status: string;
  messageTemplateId: string | null;
  fallbackPathKey: string | null;
  trafficWeightBasisPoints: number;
  sequence: number;
  /** Key count only — the map itself has no schema anywhere in the package. */
  audienceKeys: number;
  settingsKeys: number;
}

export interface OmniCampaignDefinition {
  id: string;
  name: string;
  status: string;
  objective: string;
  recipientSnapshotMode: string;
  sourceCampaignId: string | null;
  paths: OmniPath[];
  audienceStrategyKeys: number;
  scheduleKeys: number;
  sendStrategyMode: string | null;
  runtime: OmniRuntime | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonEmpty(value: unknown): string | null {
  const text = str(value);
  return text === "" ? null : text;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function keyCount(value: unknown): number {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).length
    : 0;
}

/**
 * A Go `time.Time` zero value marshals as "0001-01-01T00:00:00Z". Printing that
 * as a date says a definition was written in the year 1; anything before 1970
 * is treated as absent.
 */
export function timestampOrNull(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return parsed <= 0 ? null : text;
}

export function parseOmniRuntime(raw: unknown): OmniRuntime | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const capability = str(row["capability"]);
  const runtimeStatus = str(row["runtime_status"]);
  if (!capability && !runtimeStatus) return null;
  const prerequisites = Array.isArray(row["prerequisites"])
    ? (row["prerequisites"] as unknown[]).map(str).filter((item) => item !== "")
    : [];
  return {
    capability,
    runtimeStatus,
    // Absent is FALSE here on purpose: the field is the permission to claim a
    // campaign is running, and a missing permission is a denied one.
    executionEnabled: row["execution_enabled"] === true,
    code: str(row["code"]),
    message: str(row["message"]),
    prerequisites,
  };
}

/**
 * Is anything actually dispatching?
 *
 * `false` for a null descriptor, which is the important case: a response that
 * carried no runtime block must not be read as "runtime fine".
 */
export function runtimeIsExecuting(runtime: OmniRuntime | null): boolean {
  return runtime !== null && runtime.executionEnabled;
}

function parseCatalogItem(raw: unknown): OmniCatalogItem | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const key = str(row["key"]);
  if (!key) return null;
  const fields = Array.isArray(row["fields"]) ? row["fields"] : [];
  const requiredFields: string[] = [];
  for (const entry of fields) {
    if (!entry || typeof entry !== "object") continue;
    const field = entry as Record<string, unknown>;
    if (field["required"] === true) {
      const name = str(field["key"]);
      if (name) requiredFields.push(name);
    }
  }
  return {
    key,
    label: str(row["label"]) || key,
    runtimeStatus: str(row["runtime_status"]) || "unspecified",
    provider: nonEmpty(row["provider"]),
    requiredFields,
  };
}

function parseCatalogItems(raw: unknown): OmniCatalogItem[] {
  if (!Array.isArray(raw)) return [];
  const out: OmniCatalogItem[] = [];
  for (const entry of raw) {
    const item = parseCatalogItem(entry);
    if (item) out.push(item);
  }
  return out;
}

export function parseOmniCatalog(raw: unknown): OmniCatalog | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (!Array.isArray(row["channels"])) return null;
  return {
    schemaVersion: nonEmpty(row["schema_version"]),
    runtime: parseOmniRuntime(row["runtime"]),
    channels: parseCatalogItems(row["channels"]),
    sendStrategies: parseCatalogItems(row["send_strategies"]),
    snapshotModes: parseCatalogItems(row["recipient_snapshot_modes"]),
    pathStatuses: Array.isArray(row["path_statuses"])
      ? (row["path_statuses"] as unknown[]).map(str).filter((s) => s !== "")
      : [],
  };
}

function parsePath(raw: unknown): OmniPath | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const pathKey = str(row["path_key"]);
  const channel = str(row["channel"]);
  if (!pathKey && !channel) return null;
  return {
    id: str(row["id"]),
    pathKey: pathKey || channel,
    name: str(row["name"]) || pathKey || channel,
    channel: channel || "unknown",
    // `Validate` defaults an empty status to "draft" on the way in, so an empty
    // one on the way out is a row that predates the normaliser.
    status: str(row["status"]) || "draft",
    messageTemplateId: nonEmpty(row["message_template_id"]),
    fallbackPathKey: nonEmpty(row["fallback_path_key"]),
    trafficWeightBasisPoints: int(row["traffic_weight_basis_points"]),
    sequence: int(row["sequence"]),
    audienceKeys: keyCount(row["audience"]),
    settingsKeys: keyCount(row["settings"]),
  };
}

export function parseOmniCampaign(raw: unknown): OmniCampaignDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = str(row["id"]);
  if (!id) return null;
  const paths: OmniPath[] = [];
  if (Array.isArray(row["paths"])) {
    for (const entry of row["paths"]) {
      const path = parsePath(entry);
      if (path) paths.push(path);
    }
  }
  paths.sort((a, b) =>
    a.sequence === b.sequence
      ? a.pathKey.localeCompare(b.pathKey)
      : a.sequence - b.sequence,
  );
  const sendStrategy = row["send_strategy"];
  const mode =
    sendStrategy && typeof sendStrategy === "object"
      ? nonEmpty((sendStrategy as Record<string, unknown>)["mode"])
      : null;
  return {
    id,
    name: str(row["name"]) || "Untitled definition",
    status: str(row["status"]) || "draft",
    objective: str(row["objective"]) || "marketing",
    recipientSnapshotMode: str(row["recipient_snapshot_mode"]) || "send_time",
    sourceCampaignId: nonEmpty(row["source_campaign_id"]),
    paths,
    audienceStrategyKeys: keyCount(row["audience_strategy"]),
    scheduleKeys: keyCount(row["schedule"]),
    sendStrategyMode: mode,
    runtime: parseOmniRuntime(row["runtime"]),
    createdAt: timestampOrNull(row["created_at"]),
    updatedAt: timestampOrNull(row["updated_at"]),
  };
}

/**
 * The list envelope is `{"items": [...]}` (omnichannel.go:186). Returns null —
 * not [] — when that key is missing or is not an array, so "the request came
 * back wrong" stays separable from "this workspace has no definitions".
 */
export function parseOmniCampaignList(
  raw: unknown,
): OmniCampaignDefinition[] | null {
  if (!raw || typeof raw !== "object") return null;
  const items = (raw as Record<string, unknown>)["items"];
  if (!Array.isArray(items)) return null;
  const out: OmniCampaignDefinition[] = [];
  for (const entry of items) {
    const campaign = parseOmniCampaign(entry);
    if (campaign) out.push(campaign);
  }
  return out;
}

/** The distinct channels a definition spans, in path order. */
export function channelSpan(campaign: OmniCampaignDefinition): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of campaign.paths) {
    if (seen.has(path.channel)) continue;
    seen.add(path.channel);
    out.push(path.channel);
  }
  return out;
}

export interface TrafficSplitEntry {
  path: OmniPath;
  /** 0..100, one decimal. Null when this definition declares no weights. */
  percent: number | null;
}

export interface TrafficSplit {
  entries: TrafficSplitEntry[];
  totalBasisPoints: number;
  /**
   * Does the split obey `Validate`'s rule? Single-path definitions are exempt —
   * the rule only applies when `len(paths) > 1` (omnichannel.go:355).
   */
  balanced: boolean;
  /** True when NO path declares a weight: absent, not "0% each". */
  declared: boolean;
}

export function trafficSplit(campaign: OmniCampaignDefinition): TrafficSplit {
  const total = campaign.paths.reduce(
    (sum, path) => sum + path.trafficWeightBasisPoints,
    0,
  );
  const declared = total > 0;
  return {
    entries: campaign.paths.map((path) => ({
      path,
      percent: declared
        ? Math.round((path.trafficWeightBasisPoints / 100) * 10) / 10
        : null,
    })),
    totalBasisPoints: total,
    balanced:
      campaign.paths.length <= 1 || total === TRAFFIC_BASIS_POINT_TOTAL,
    declared,
  };
}

/**
 * Statuses that read as a live claim about delivery. Shown ONLY alongside the
 * "persisted metadata, not a runtime monitor" caveat, because no dispatcher
 * exists to have produced them.
 */
const RUNTIME_CLAIM_STATUSES = new Set([
  "scheduled",
  "sending",
  "sent",
  "paused",
]);

export function pathStatusIsRuntimeClaim(status: string): boolean {
  return RUNTIME_CLAIM_STATUSES.has(status.trim().toLowerCase());
}

/** Does this definition contain any status that would read as live? */
export function claimsRuntimeState(campaign: OmniCampaignDefinition): boolean {
  if (pathStatusIsRuntimeClaim(campaign.status)) return true;
  return campaign.paths.some((path) => pathStatusIsRuntimeClaim(path.status));
}

/** A path whose declared channel is absent from the catalog cannot be sent. */
export function unknownChannels(
  campaign: OmniCampaignDefinition,
  catalog: OmniCatalog | null,
): string[] {
  if (!catalog) return [];
  const known = new Set(catalog.channels.map((channel) => channel.key));
  const out: string[] = [];
  for (const channel of channelSpan(campaign)) {
    if (!known.has(channel) && !out.includes(channel)) out.push(channel);
  }
  return out;
}

/**
 * An RCS path must name an SMS fallback (omnichannel.go:333, :347-352). A
 * stored definition can violate it — the rule is enforced on the validate and
 * create routes, not on the table — so the read surface checks it too.
 */
export function brokenFallbacks(campaign: OmniCampaignDefinition): string[] {
  const byKey = new Map(campaign.paths.map((path) => [path.pathKey, path]));
  const out: string[] = [];
  for (const path of campaign.paths) {
    if (path.channel === "rcs" && !path.fallbackPathKey) {
      out.push(path.pathKey);
      continue;
    }
    if (!path.fallbackPathKey) continue;
    const target = byKey.get(path.fallbackPathKey);
    if (!target) {
      out.push(path.pathKey);
      continue;
    }
    if (path.channel === "rcs" && target.channel !== "sms") out.push(path.pathKey);
  }
  return out;
}

/** Filter keys the list screen offers. Mirrors the status set `Validate` allows. */
export const OMNI_STATUS_FILTERS = [
  "all",
  "draft",
  "scheduled",
  "sent",
  "paused",
] as const;
export type OmniStatusFilter = (typeof OMNI_STATUS_FILTERS)[number];

export function matchesOmniStatus(
  campaign: OmniCampaignDefinition,
  filter: OmniStatusFilter,
): boolean {
  return filter === "all" || campaign.status === filter;
}

export function matchesOmniQuery(
  campaign: OmniCampaignDefinition,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (campaign.name.toLowerCase().includes(needle)) return true;
  return campaign.paths.some(
    (path) =>
      path.channel.includes(needle) ||
      path.name.toLowerCase().includes(needle) ||
      path.pathKey.includes(needle),
  );
}
