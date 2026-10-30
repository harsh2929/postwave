// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed client for the reporting backend (apps/api/internal/reporting).
//
// Mirrors the shapes desktop already consumes, deliberately including the two
// PROVENANCE fields, which are the reason this surface is worth having on web
// at all: a saved report opened here must say the same thing it says on
// desktop, and a number with no statement of what it measured or when it was
// true cannot be compared across two screens.
//
//   metric_version   a fingerprint DERIVED from the metric registry, not a
//                    constant somebody remembers to bump — it changes when the
//                    arithmetic changes and not when a label is renamed.
//   computed_as_of   read from the DATA (max(at) over the reporting source),
//                    never from the clock. Stamping now() would claim a
//                    six-hour-old answer is current, which is exactly how two
//                    surfaces disagree about one report with no way to tell a
//                    lag from a defect.

import { api } from "./api";

export interface ReportingReadOptions {
  signal?: AbortSignal;
  /** Bypass offline/cache replay for post-operation confirmation reads. */
  fresh?: boolean;
}

export interface ReportingWriteOptions {
  signal?: AbortSignal;
  /** Stable for one frozen user intent, including an ambiguous retry. */
  idempotencyKey?: string;
}

function readOptions(options: ReportingReadOptions = {}) {
  return options.fresh
    ? {
        signal: options.signal,
        cache: "no-store" as const,
        requireOnline: true,
        maxAttempts: 1,
      }
    : { signal: options.signal };
}

function writeOptions(options: ReportingWriteOptions = {}) {
  return {
    signal: options.signal,
    idempotencyKey: options.idempotencyKey,
    requireOnline: true,
    maxAttempts: 1,
  };
}

export interface ReportMetricSpec {
  /**
   * `key`, not `id`.
   *
   * The gateway sends `reporting.MetricSpec{Key, Alias, Aggregation}`. The first
   * version of this file declared `id`, which would have read `undefined` for
   * every metric on every saved report — rendering an empty metric list while
   * nothing errored. That is the exact drift class the SDK shape gate was built
   * for this session, committed here by hand an hour later, and caught only by
   * reading the Go struct before adding the builder.
   */
  key: string;
  alias?: string;
  aggregation?: string;
}

/** One metric the tenant may select, from the server-side registry. */
export interface ReportMetricDefinition {
  key: string;
  label: string;
  product_area: string;
  aggregation: string;
  value_type: string;
  dimensions?: string[];
  runtime_status: string;
  help?: string;
}

/** POST body for preview and save (reporting.ReportRequest). */
export interface ReportRequest {
  name?: string;
  description?: string;
  product_area?: string;
  metrics: ReportMetricSpec[];
  dimensions?: string[];
  filters?: Record<string, unknown>;
  time_range?: ReportTimeRange;
  visualization?: string;
}

export interface ReportPreview {
  rows: Array<Record<string, unknown>>;
  warnings?: string[];
  errors?: string[];
  valid?: boolean;
  metric_version?: string;
  computed_as_of?: string;
}

export interface ReportTimeRange {
  preset?: string;
  /** `from`/`to`, matching reporting.TimeRange — not start/end. */
  from?: string;
  to?: string;
}

export interface ReportDefinition {
  id: string;
  name: string;
  description: string;
  product_area: string;
  status: string;
  metrics: ReportMetricSpec[];
  dimensions: string[];
  filters: Record<string, unknown>;
  time_range: ReportTimeRange;
  visualization: string;
  created_at: string;
  updated_at: string;
  /** Absent on definitions saved before provenance existed — see below. */
  metric_version?: string;
}

export interface ReportRun {
  id: string;
  definition_id?: string;
  status: string;
  rows: Array<Record<string, unknown>>;
  warnings?: string[];
  errors?: string[];
  /**
   * NULL-able and un-backfilled on purpose. "Provenance unknown" is honest for
   * a historical run; an invented value is not, and would be indistinguishable
   * from a real one.
   */
  metric_version?: string;
  computed_as_of?: string;
  created_at?: string;
}

export const reportingApi = {
  listDefinitions: (options: ReportingReadOptions = {}) =>
    api
      .get<{
        items: ReportDefinition[];
      }>("/api/v1/reporting/definitions", readOptions(options))
      .then((r) => (Array.isArray(r.items) ? r.items : [])),
  getDefinition: (id: string, options: ReportingReadOptions = {}) =>
    api.get<ReportDefinition>(
      `/api/v1/reporting/definitions/${encodeURIComponent(id)}`,
      readOptions(options),
    ),
  listRuns: (options: ReportingReadOptions = {}) =>
    api
      .get<{
        items: ReportRun[];
      }>("/api/v1/reporting/runs", readOptions(options))
      .then((r) => (Array.isArray(r.items) ? r.items : [])),
  getRun: (id: string, options: ReportingReadOptions = {}) =>
    api.get<ReportRun>(
      `/api/v1/reporting/runs/${encodeURIComponent(id)}`,
      readOptions(options),
    ),
  metricRegistry: (options: ReportingReadOptions = {}) =>
    api
      .get<{
        items: ReportMetricDefinition[];
      }>("/api/v1/reporting/metric-registry", readOptions(options))
      .then((r) => (Array.isArray(r.items) ? r.items : [])),
  /** Run a DRAFT without saving it — the builder's feedback loop. */
  preview: (req: ReportRequest, options: ReportingWriteOptions = {}) =>
    api.post<ReportPreview>(
      "/api/v1/reporting/preview",
      req,
      writeOptions(options),
    ),
  saveDefinition: (req: ReportRequest, options: ReportingWriteOptions = {}) =>
    api.post<ReportDefinition>(
      "/api/v1/reporting/definitions",
      req,
      writeOptions(options),
    ),
  run: (definitionId: string, options: ReportingWriteOptions = {}) =>
    api.post<ReportRun>(
      `/api/v1/reporting/definitions/${encodeURIComponent(definitionId)}/runs`,
      {},
      writeOptions(options),
    ),
};
