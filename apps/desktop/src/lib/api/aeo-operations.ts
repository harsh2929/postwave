import type { ApiResult } from "./result";

export interface AeoRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type AeoRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: AeoRequestOptions,
) => Promise<ApiResult<T>>;

export interface AeoOperationsDependencies {
  request: AeoRequester;
}

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

/** GET /api/v1/aeo/settings — per-tenant configuration. */
export function createGetAEOSettings({ request }: AeoOperationsDependencies) {
  return function getAEOSettings(): Promise<ApiResult<AEOSettings>> {
    return request<AEOSettings>("/api/v1/aeo/settings");
  };
}

/** PUT /api/v1/aeo/settings — upsert tenant configuration. */
export function createPutAEOSettings({ request }: AeoOperationsDependencies) {
  return function putAEOSettings(
    input: Partial<AEOSettings>,
  ): Promise<ApiResult<AEOSettings>> {
    return request<AEOSettings>("/api/v1/aeo/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  };
}

/** GET /api/v1/aeo/summary — headline tile pack + competitor board. */
export function createGetAEOSummary({ request }: AeoOperationsDependencies) {
  return function getAEOSummary(): Promise<ApiResult<AEOSensorSummary>> {
    return request<AEOSensorSummary>("/api/v1/aeo/summary");
  };
}

/** GET /api/v1/aeo/rollups — fever chart series. */
export function createListAEORollups({ request }: AeoOperationsDependencies) {
  return function listAEORollups(
    opts: { engine?: string; days?: number } = {},
  ): Promise<ApiResult<{ items: AEODailyRollup[] }>> {
    const params = new URLSearchParams();
    if (opts.engine) params.set("engine", opts.engine);
    if (opts.days) params.set("days", String(opts.days));
    const qs = params.toString();
    return request<{ items: AEODailyRollup[] }>(
      `/api/v1/aeo/rollups${qs ? `?${qs}` : ""}`,
    );
  };
}

/** GET /api/v1/aeo/prompts — prompt rotation library. */
export function createListAEOPrompts({ request }: AeoOperationsDependencies) {
  return function listAEOPrompts(
    opts: { enabledOnly?: boolean } = {},
  ): Promise<ApiResult<{ items: AEOPrompt[] }>> {
    const qs = opts.enabledOnly ? "?enabled_only=true" : "";
    return request<{ items: AEOPrompt[] }>(`/api/v1/aeo/prompts${qs}`);
  };
}

/** POST /api/v1/aeo/prompts — create a tenant-authored prompt. */
export function createCreateAEOPrompt({ request }: AeoOperationsDependencies) {
  return function createAEOPrompt(input: {
    category: AEOPromptCategory;
    prompt_text: string;
  }): Promise<ApiResult<AEOPrompt>> {
    return request<AEOPrompt>("/api/v1/aeo/prompts", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

/** POST /api/v1/aeo/prompts/{id}/toggle — enable / disable. */
export function createToggleAEOPrompt({ request }: AeoOperationsDependencies) {
  return function toggleAEOPrompt(
    id: string,
    enabled: boolean,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/aeo/prompts/${encodeURIComponent(id)}/toggle`,
      { method: "POST", body: JSON.stringify({ enabled }) },
    );
  };
}

/** DELETE /api/v1/aeo/prompts/{id} — remove a prompt + its probes. */
export function createDeleteAEOPrompt({ request }: AeoOperationsDependencies) {
  return function deleteAEOPrompt(
    id: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/aeo/prompts/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

/** GET /api/v1/aeo/probes — audit pane: recent probe responses. */
export function createListAEOProbes({ request }: AeoOperationsDependencies) {
  return function listAEOProbes(
    opts: { engine?: string; promptId?: string; limit?: number } = {},
  ): Promise<ApiResult<{ items: AEOProbe[] }>> {
    const params = new URLSearchParams();
    if (opts.engine) params.set("engine", opts.engine);
    if (opts.promptId) params.set("prompt_id", opts.promptId);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<{ items: AEOProbe[] }>(
      `/api/v1/aeo/probes${qs ? `?${qs}` : ""}`,
    );
  };
}

/** GET /api/v1/aeo/competitors — competitor comparison list. */
export function createListAEOCompetitors({
  request,
}: AeoOperationsDependencies) {
  return function listAEOCompetitors(): Promise<
    ApiResult<{ items: AEOCompetitor[]; max: number }>
  > {
    return request<{ items: AEOCompetitor[]; max: number }>(
      "/api/v1/aeo/competitors",
    );
  };
}

/** PUT /api/v1/aeo/competitors — upsert by competitor_key. */
export function createUpsertAEOCompetitor({
  request,
}: AeoOperationsDependencies) {
  return function upsertAEOCompetitor(
    input: Partial<AEOCompetitor>,
  ): Promise<ApiResult<AEOCompetitor>> {
    return request<AEOCompetitor>("/api/v1/aeo/competitors", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  };
}

/** DELETE /api/v1/aeo/competitors/{key} — remove competitor row. */
export function createDeleteAEOCompetitor({
  request,
}: AeoOperationsDependencies) {
  return function deleteAEOCompetitor(
    competitorKey: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/aeo/competitors/${encodeURIComponent(competitorKey)}`,
      { method: "DELETE" },
    );
  };
}

/** POST /api/v1/aeo/run-now — admin-scope kick of the probe runner. */
export function createRunAEONow({ request }: AeoOperationsDependencies) {
  return function runAEONow(): Promise<
    ApiResult<{ probes: number; rollups: AEODailyRollup[] }>
  > {
    return request<{ probes: number; rollups: AEODailyRollup[] }>(
      "/api/v1/aeo/run-now",
      { method: "POST", body: JSON.stringify({}) },
    );
  };
}

export function createAeoOperationsMethods(
  dependencies: AeoOperationsDependencies,
) {
  return {
    getAEOSettings: createGetAEOSettings(dependencies),
    putAEOSettings: createPutAEOSettings(dependencies),
    getAEOSummary: createGetAEOSummary(dependencies),
    listAEORollups: createListAEORollups(dependencies),
    listAEOPrompts: createListAEOPrompts(dependencies),
    createAEOPrompt: createCreateAEOPrompt(dependencies),
    toggleAEOPrompt: createToggleAEOPrompt(dependencies),
    deleteAEOPrompt: createDeleteAEOPrompt(dependencies),
    listAEOProbes: createListAEOProbes(dependencies),
    listAEOCompetitors: createListAEOCompetitors(dependencies),
    upsertAEOCompetitor: createUpsertAEOCompetitor(dependencies),
    deleteAEOCompetitor: createDeleteAEOCompetitor(dependencies),
    runAEONow: createRunAEONow(dependencies),
  };
}
