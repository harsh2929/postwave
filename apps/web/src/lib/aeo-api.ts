// SPDX-License-Identifier: AGPL-3.0-only
//
// AEO Sensor client — desktop parity for apps/desktop/src/lib/api/aeo-operations.ts
// (request shapes) and apps/desktop/src/pages/aeo-summary-contract.ts (strict
// parsers). Every read is parsed before it reaches a component: a malformed
// payload throws `AeoContractError`, which the page renders as a contract
// failure. It is never coerced into "no data", because an empty dashboard and
// a broken one must not look the same.
//
// Server: apps/api/internal/aeo/handlers.go. Reads carry read:reports; every
// write and run-now carry admin — the page gates those verbs on owner/admin so
// a member never sends a request the server would 403.

import { api } from "@/lib/api";
import { base, type RoleKey } from "@/lib/query-keys";

/* ---------- types (ported verbatim from desktop) ---------------------- */

export type AEOEngine =
  | "chatgpt"
  | "gemini"
  | "perplexity"
  | "grok"
  | "copilot"
  | "_all";

export type AEOPromptPack = "starter" | "custom" | "starter_plus_custom";
export type AEOPromptCategory =
  | "discovery"
  | "comparison"
  | "buyer"
  | "support"
  | "other";
export type AEOCredentialsStatus = "missing" | "partial" | "ready";
export type AEOProbeStatus = "ok" | "error" | "rate_limited" | "skipped";

export interface AEOEngineConfig {
  key: Exclude<AEOEngine, "_all">;
  enabled: boolean;
}

export interface AEOSettings {
  tenant_id?: string;
  enabled: boolean;
  brand_terms: string[];
  brand_domain: string;
  probe_prompt_pack: AEOPromptPack;
  probe_interval_hours: number;
  engines: AEOEngineConfig[];
  volatility_window_days: number;
  credentials_status: AEOCredentialsStatus;
  last_probe_run_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AEOPrompt {
  id: string;
  tenant_id?: string;
  category: AEOPromptCategory;
  prompt_text: string;
  enabled: boolean;
  source: "starter" | "custom";
  created_at: string;
  updated_at: string;
}

export interface AEOProbe {
  id: number;
  tenant_id?: string;
  prompt_id: string;
  engine: AEOEngine;
  response_text: string;
  mentioned: boolean;
  cited: boolean;
  competitor_hits: Record<string, number>;
  latency_ms: number;
  token_count: number;
  status: AEOProbeStatus;
  probed_at: string;
}

export interface AEODailyRollup {
  tenant_id?: string;
  engine: AEOEngine;
  day: string;
  mention_rate: number;
  citation_rate: number;
  volatility_score: number;
  ai_referral_pct: number;
  sample_size: number;
  computed_at: string;
}

export interface AEOCompetitor {
  id?: string;
  tenant_id?: string;
  competitor_key: string;
  display_name: string;
  terms: string[];
  domain: string;
  created_at?: string;
  updated_at?: string;
}

export interface AEOCompetitorScore {
  key: string;
  display_name: string;
  mention_rate: number;
  domain?: string;
}

export interface AEOSensorSummary {
  settings: AEOSettings;
  latest_rollups: AEODailyRollup[];
  overall_mention_rate: number;
  overall_citation_rate: number;
  volatility_score: number;
  ai_referral_pct: number;
  competitor_board: AEOCompetitorScore[];
  warning_banner?: string;
}

export interface AEOCompetitorList {
  items: AEOCompetitor[];
  max: number;
}

export interface AEORunNowResult {
  probes: number;
  rollups: AEODailyRollup[];
}

/** The settings fields the page edits; the server clamps and defaults the rest. */
export type AEOSettingsInput = Partial<AEOSettings>;

/* ---------- contract error ------------------------------------------- */

export type AeoSurface =
  | "summary"
  | "prompts"
  | "probes"
  | "competitors"
  | "run-now";

/**
 * Thrown when a 2xx body does not match the contract. Distinct from ApiError
 * so the page can say "the server answered, and the answer was wrong" instead
 * of "the request failed" — different remedies.
 */
export class AeoContractError extends Error {
  readonly surface: AeoSurface;
  constructor(surface: AeoSurface) {
    super(`AEO ${surface} response was malformed.`);
    this.name = "AeoContractError";
    this.surface = surface;
  }
}

export function isAeoContractError(err: unknown): err is AeoContractError {
  return err instanceof AeoContractError;
}

/* ---------- strict parsers (ported from aeo-summary-contract.ts) ------ */

const AEO_ENGINES = new Set([
  "chatgpt",
  "gemini",
  "perplexity",
  "grok",
  "copilot",
  "_all",
]);
const PROMPT_CATEGORIES = new Set([
  "discovery",
  "comparison",
  "buyer",
  "support",
  "other",
]);
const PROBE_STATUSES = new Set(["ok", "error", "rate_limited", "skipped"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function isRollup(value: unknown): value is AEODailyRollup {
  if (!isRecord(value)) return false;
  const row = value;
  return (
    typeof row.engine === "string" &&
    AEO_ENGINES.has(row.engine) &&
    typeof row.day === "string" &&
    finite(row.mention_rate) &&
    finite(row.citation_rate) &&
    finite(row.volatility_score) &&
    finite(row.ai_referral_pct) &&
    finite(row.sample_size) &&
    typeof row.computed_at === "string"
  );
}

function isCompetitorScore(value: unknown): value is AEOCompetitorScore {
  if (!isRecord(value)) return false;
  return (
    typeof value.key === "string" &&
    typeof value.display_name === "string" &&
    finite(value.mention_rate) &&
    (value.domain === undefined || typeof value.domain === "string")
  );
}

function isPrompt(value: unknown): value is AEOPrompt {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.category === "string" &&
    PROMPT_CATEGORIES.has(value.category) &&
    typeof value.prompt_text === "string" &&
    typeof value.enabled === "boolean" &&
    (value.source === "starter" || value.source === "custom") &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isProbe(value: unknown): value is AEOProbe {
  if (!isRecord(value) || !isRecord(value.competitor_hits)) return false;
  return (
    finite(value.id) &&
    typeof value.prompt_id === "string" &&
    typeof value.engine === "string" &&
    AEO_ENGINES.has(value.engine) &&
    typeof value.response_text === "string" &&
    typeof value.mentioned === "boolean" &&
    typeof value.cited === "boolean" &&
    Object.values(value.competitor_hits).every(finite) &&
    finite(value.latency_ms) &&
    finite(value.token_count) &&
    typeof value.status === "string" &&
    PROBE_STATUSES.has(value.status) &&
    typeof value.probed_at === "string"
  );
}

function isCompetitor(value: unknown): value is AEOCompetitor {
  if (!isRecord(value)) return false;
  return (
    typeof value.competitor_key === "string" &&
    typeof value.display_name === "string" &&
    Array.isArray(value.terms) &&
    value.terms.every((term) => typeof term === "string") &&
    typeof value.domain === "string" &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.created_at === undefined || typeof value.created_at === "string") &&
    (value.updated_at === undefined || typeof value.updated_at === "string")
  );
}

function parseItems<T>(
  value: unknown,
  predicate: (item: unknown) => item is T,
): T[] | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  return value.items.every(predicate) ? value.items : null;
}

export function parseAeoPrompts(value: unknown): AEOPrompt[] | null {
  return parseItems(value, isPrompt);
}

export function parseAeoProbes(value: unknown): AEOProbe[] | null {
  return parseItems(value, isProbe);
}

export function parseAeoCompetitors(value: unknown): AEOCompetitor[] | null {
  return parseItems(value, isCompetitor);
}

/** The list envelope the server sends: items plus the per-tenant cap. */
export function parseAeoCompetitorList(
  value: unknown,
): AEOCompetitorList | null {
  const items = parseAeoCompetitors(value);
  if (!items || !isRecord(value) || !finite(value.max)) return null;
  return { items, max: value.max };
}

export function parseAeoSummary(value: unknown): AEOSensorSummary | null {
  if (!isRecord(value)) return null;
  const summary = value;
  const settings = summary.settings;
  if (!settings || typeof settings !== "object") return null;
  const config = settings as Record<string, unknown>;
  if (
    typeof config.enabled !== "boolean" ||
    typeof config.brand_domain !== "string" ||
    !Array.isArray(config.brand_terms) ||
    !config.brand_terms.every((term) => typeof term === "string") ||
    !["missing", "partial", "ready"].includes(
      String(config.credentials_status),
    ) ||
    !Array.isArray(summary.latest_rollups) ||
    !summary.latest_rollups.every(isRollup) ||
    !Array.isArray(summary.competitor_board) ||
    !summary.competitor_board.every(isCompetitorScore) ||
    !finite(summary.overall_mention_rate) ||
    !finite(summary.overall_citation_rate) ||
    !finite(summary.volatility_score) ||
    !finite(summary.ai_referral_pct) ||
    (summary.warning_banner !== undefined &&
      typeof summary.warning_banner !== "string")
  ) {
    return null;
  }
  return summary as unknown as AEOSensorSummary;
}

export function parseAeoRunNow(value: unknown): AEORunNowResult | null {
  if (!isRecord(value)) return null;
  if (!finite(value.probes)) return null;
  if (!Array.isArray(value.rollups) || !value.rollups.every(isRollup)) {
    return null;
  }
  return { probes: value.probes, rollups: value.rollups };
}

function contract<T>(
  surface: AeoSurface,
  parse: (value: unknown) => T | null,
): (value: unknown) => T {
  return (value) => {
    const parsed = parse(value);
    if (parsed === null) throw new AeoContractError(surface);
    return parsed;
  };
}

/* ---------- query keys ----------------------------------------------- */

export const aeoKeys = {
  summary: (tenantId: string, role: RoleKey) =>
    [...base("aeo", tenantId, role), "summary"] as const,
  prompts: (tenantId: string, role: RoleKey) =>
    [...base("aeo", tenantId, role), "prompts"] as const,
  probes: (tenantId: string, role: RoleKey, limit: number) =>
    [...base("aeo", tenantId, role), "probes", limit] as const,
  competitors: (tenantId: string, role: RoleKey) =>
    [...base("aeo", tenantId, role), "competitors"] as const,
};

/* ---------- reads (read:reports) ------------------------------------- */

/** GET /api/v1/aeo/summary — headline tile pack + competitor board. */
export function getAeoSummary(): Promise<AEOSensorSummary> {
  return api
    .get<unknown>("/api/v1/aeo/summary")
    .then(contract("summary", parseAeoSummary));
}

/** GET /api/v1/aeo/prompts — prompt rotation library. */
export function listAeoPrompts(): Promise<AEOPrompt[]> {
  return api
    .get<unknown>("/api/v1/aeo/prompts")
    .then(contract("prompts", parseAeoPrompts));
}

/** GET /api/v1/aeo/probes?limit= — audit pane: recent probe responses. */
export function listAeoProbes(limit: number): Promise<AEOProbe[]> {
  return api
    .get<unknown>(`/api/v1/aeo/probes?limit=${encodeURIComponent(limit)}`)
    .then(contract("probes", parseAeoProbes));
}

/** GET /api/v1/aeo/competitors — competitor list plus the tenant cap. */
export function listAeoCompetitors(): Promise<AEOCompetitorList> {
  return api
    .get<unknown>("/api/v1/aeo/competitors")
    .then(contract("competitors", parseAeoCompetitorList));
}

/* ---------- writes (admin) ------------------------------------------- */

/** PUT /api/v1/aeo/settings — upsert tenant configuration (partial object). */
export function putAeoSettings(input: AEOSettingsInput): Promise<unknown> {
  return api.put<unknown>("/api/v1/aeo/settings", input);
}

/** PUT /api/v1/aeo/competitors — upsert by competitor_key. */
export function upsertAeoCompetitor(
  input: Partial<AEOCompetitor>,
): Promise<unknown> {
  return api.put<unknown>("/api/v1/aeo/competitors", input);
}

/** DELETE /api/v1/aeo/competitors/{key} — remove one competitor row. */
export function deleteAeoCompetitor(competitorKey: string): Promise<unknown> {
  return api.delete<unknown>(
    `/api/v1/aeo/competitors/${encodeURIComponent(competitorKey)}`,
  );
}

/** POST /api/v1/aeo/prompts — create a tenant-authored prompt. */
export function createAeoPrompt(input: {
  category: AEOPromptCategory;
  prompt_text: string;
}): Promise<unknown> {
  return api.post<unknown>("/api/v1/aeo/prompts", input);
}

/** POST /api/v1/aeo/prompts/{id}/toggle — enable / disable. */
export function toggleAeoPrompt(id: string, enabled: boolean): Promise<unknown> {
  return api.post<unknown>(
    `/api/v1/aeo/prompts/${encodeURIComponent(id)}/toggle`,
    { enabled },
  );
}

/** DELETE /api/v1/aeo/prompts/{id} — remove a prompt AND its probes. */
export function deleteAeoPrompt(id: string): Promise<unknown> {
  return api.delete<unknown>(`/api/v1/aeo/prompts/${encodeURIComponent(id)}`);
}

/** POST /api/v1/aeo/run-now — admin-scope kick of the probe runner. */
export function runAeoNow(): Promise<AEORunNowResult> {
  return api
    .post<unknown>("/api/v1/aeo/run-now", {})
    .then(contract("run-now", parseAeoRunNow));
}
