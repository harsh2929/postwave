// SPDX-License-Identifier: AGPL-3.0-only
//
// Bidirectional integration write-back (reverse-ETL) client. Pushes Moosewave
// audience membership + per-member computed traits BACK into the source platform
// (Shopify / HubSpot / Salesforce / Pipedrive / Klaviyo) — direct provider
// two-way sync.
// The whole subsystem was server-only until this UI; backend routes
// (apps/api/internal/integration_writeback/handlers.go::MountRoutes):
//
//   GET    /api/v1/integration-writeback/providers           (admin) adapter availability
//   GET    /api/v1/integration-writeback/targets             (read)  list
//   POST   /api/v1/integration-writeback/targets             (admin) create / upsert
//   GET    /api/v1/integration-writeback/targets/{id}        (read)
//   POST   /api/v1/integration-writeback/targets/{id}/run    (admin) run now -> RunSummary
//   POST   /api/v1/integration-writeback/targets/{id}/pause  (admin)
//   DELETE /api/v1/integration-writeback/targets/{id}        (admin) disconnect
//   GET    /api/v1/integration-writeback/targets/{id}/runs   (read)  run history

import { api } from "./api";

export interface WritebackProvider {
  provider: string;
  available: boolean;
}

export interface WritebackTarget {
  id: string;
  tenant_id?: string;
  provider: string;
  name: string;
  status: string;
  credentials_ref?: string;
  settings?: Record<string, unknown>;
  sync_interval_minutes: number;
  last_run_at?: string | null;
  error_message?: string;
  created_at: string;
  updated_at: string;
}

export interface WritebackTargetInput {
  provider: string;
  name?: string;
  status?: string;
  credentials_ref: string;
  settings?: Record<string, unknown>;
  sync_interval_minutes?: number;
}

/** Aggregate outcome returned synchronously by POST /run. */
export interface WritebackRunSummary {
  run_id?: string;
  status: string;
  members_seen: number;
  matched: number;
  tags_written: number;
  fields_written: number;
  rows_failed: number;
  error_message?: string;
}

/** One audited run row (run history). */
export interface WritebackRun {
  id: string;
  tenant_id?: string;
  target_id?: string;
  run_mode: string;
  status: string;
  members_seen: number;
  matched: number;
  tags_written: number;
  fields_written: number;
  rows_failed: number;
  error_message?: string;
  metadata?: Record<string, unknown>;
  started_at: string;
  completed_at?: string | null;
  created_at: string;
}

interface ItemsEnvelope<T> {
  items: T[];
}

const BASE = "/api/v1/integration-writeback";

export const writebackApi = {
  providers: (): Promise<WritebackProvider[]> =>
    api
      .get<ItemsEnvelope<WritebackProvider>>(`${BASE}/providers`)
      .then((r) => Array.isArray(r.items) ? r.items : []),

  list: (): Promise<WritebackTarget[]> =>
    api
      .get<ItemsEnvelope<WritebackTarget>>(`${BASE}/targets`)
      .then((r) => Array.isArray(r.items) ? r.items : []),

  create: (input: WritebackTargetInput): Promise<WritebackTarget> =>
    api.post<WritebackTarget>(`${BASE}/targets`, input),

  get: (id: string): Promise<WritebackTarget> =>
    api.get<WritebackTarget>(`${BASE}/targets/${encodeURIComponent(id)}`),

  run: (id: string): Promise<WritebackRunSummary> =>
    api.post<WritebackRunSummary>(
      `${BASE}/targets/${encodeURIComponent(id)}/run`,
      {},
    ),

  pause: (id: string): Promise<WritebackTarget> =>
    api.post<WritebackTarget>(
      `${BASE}/targets/${encodeURIComponent(id)}/pause`,
      {},
    ),

  resume: (id: string): Promise<WritebackTarget> =>
    api.post<WritebackTarget>(
      `${BASE}/targets/${encodeURIComponent(id)}/resume`,
      {},
    ),

  disconnect: (id: string): Promise<unknown> =>
    api.delete<unknown>(`${BASE}/targets/${encodeURIComponent(id)}`),

  runs: (id: string, limit = 25): Promise<WritebackRun[]> =>
    api
      .get<ItemsEnvelope<WritebackRun>>(
        `${BASE}/targets/${encodeURIComponent(id)}/runs?limit=${limit}`,
      )
      .then((r) => Array.isArray(r.items) ? r.items : []),
};
