// Typed client for the tenant send-settings surface, mounted at
// /api/v1/send-settings (apps/api/internal/handlers/send_settings.go, backed by
// tenant_send_settings / migration 0299). The engine shipped GET + PUT with the
// route pinned to ScopeAdmin in main.go, but no client called it — operators
// could not see or pin their workspace-wide send-time-optimization default from
// either app. This is the client layer the desktop Settings > Send defaults
// panel drives.
//
// Wire shapes verified field-by-field against the Go SendSettings struct: both
// GET 200 and PUT 200 return a BARE SendSettings JSON object (no {items} / no
// envelope), so there is nothing to unwrap — the ApiResult data IS the object.
import type { ApiRequester, ApiResult } from "./result";

// STOStrategy is the workspace-level send-time-optimization default. The DB
// CHECK constraint (migration 0299) and the handler's validStrategy() pin the
// vocabulary. An empty string in the DB is normalized to "none" by the server,
// so callers only ever observe the three concrete values on a GET.
export type STOStrategy = "none" | "modal_hour" | "per_recipient";

// SendSettings mirrors the Go SendSettings struct exactly.
export interface SendSettings {
  // default_sto_strategy: which STO strategy /campaigns/{id}/schedule-by-best-time
  // falls back to when the request omits `strategy`. "" is accepted on write
  // (coerced to "none" server-side) but never returned by a GET.
  default_sto_strategy: STOStrategy;
  // newsletters_force_per_recipient: when true, the API auto-flips
  // send_time_strategy to "per_recipient" for newsletter-type campaigns.
  newsletters_force_per_recipient: boolean;
}

// SendSettingsInput is the PUT request body. Same shape as SendSettings, but the
// strategy also permits "" (the server coerces it to "none").
export interface SendSettingsInput {
  default_sto_strategy: STOStrategy | "";
  newsletters_force_per_recipient: boolean;
}

const BASE = "/api/v1/send-settings";

function putJson(body: unknown): RequestInit {
  return { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// createSendSettingsApi wires typed methods over the GET + PUT routes.
export function createSendSettingsApi(request: ApiRequester) {
  return {
    // GET /api/v1/send-settings — the tenant's send defaults. A never-touched
    // tenant lazily resolves to {default_sto_strategy:"none", newsletters_force_per_recipient:false}.
    get(): Promise<ApiResult<SendSettings>> {
      return request<SendSettings>(BASE);
    },

    // PUT /api/v1/send-settings — upsert the send defaults (ScopeAdmin). Echoes
    // back the stored SendSettings on 200. A 400 {code:"bad_strategy"} surfaces
    // through the ApiErr branch when default_sto_strategy is out of vocabulary.
    update(input: SendSettingsInput): Promise<ApiResult<SendSettings>> {
      return request<SendSettings>(BASE, putJson(input));
    },
  };
}

export type SendSettingsApi = ReturnType<typeof createSendSettingsApi>;
