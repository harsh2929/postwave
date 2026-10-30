// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export type AuditSinkKind = "s3" | "datadog" | "splunk" | "http";

export interface AuditSink {
  id: string;
  kind: AuditSinkKind;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  consecutive_failures: number;
  /** Threshold the worker uses to auto-disable. Defaults to 100. */
  auto_disable_after: number;
  /**
   * Circuit-breaker state. `closed` = healthy, `open` = upstream is
   * unhealthy and deliveries are short-circuiting into the DLQ,
   * `half_open` = the next delivery is a probe.
   */
  circuit_state: "closed" | "open" | "half_open";
  /** Set while circuit_state=open — when the next probe will fire. */
  cooldown_until?: string | null;
  last_success_at?: string | null;
  last_failure_at?: string | null;
  last_error?: string | null;
}

export interface AuditSinkInput {
  kind: AuditSinkKind;
  name: string;
  enabled?: boolean;
  /** Kind-specific configuration. See `AuditSinkConfig*` shapes below. */
  config: Record<string, unknown>;
  /**
   * Credential blob — the server envelope-encrypts these under the
   * tenant's KEK and stores the ciphertext. Never returned by any
   * read endpoint.
   */
  credentials?: Record<string, string>;
}

/**
 * Patch shape — any subset is valid. Credentials, if supplied,
 * REPLACES the stored envelope (no field-level merge). Kind is
 * intentionally not patchable.
 */
export interface AuditSinkPatch {
  enabled?: boolean;
  name?: string;
  config?: Record<string, unknown>;
  credentials?: Record<string, string>;
}

/** A pending or replayed dead-letter-queue entry. */
export interface AuditSinkDLQEntry {
  id: number;
  sink_id: string;
  from_audit_id: number;
  to_audit_id: number;
  last_error: string;
  attempt_count: number;
  first_failed_at: string;
  last_attempt_at: string;
  replayed_at?: string | null;
  replayed_by?: string | null;
}

/** Datadog config: { site: "datadoghq.com" } + credentials: { api_key }. */
export interface AuditSinkConfigDatadog {
  site: string;
}
/** Splunk config: { hec_url, index? } + credentials: { token }. */
export interface AuditSinkConfigSplunk {
  hec_url: string;
  index?: string;
}
/** S3 config: { region, bucket, prefix? } + credentials: { aws_access_key_id, aws_secret_access_key }. */
export interface AuditSinkConfigS3 {
  region: string;
  bucket: string;
  prefix?: string;
}
/** HTTP config: { url } + credentials: { bearer_token? } or { hmac_secret? }. */
export interface AuditSinkConfigHTTP {
  url: string;
}

/**
 * Audit-log streaming destinations. The worker auto-disables a sink
 * after 100 consecutive failures so a broken integration can't pin
 * the worker on its tenant forever. A circuit breaker short-circuits
 * to the DLQ after 10 consecutive failures so the worker doesn't
 * hammer a flapping upstream.
 */
export class AuditSinksResource extends Resource {
  list(): Promise<{ sinks: AuditSink[] }> {
    return this.client.request("GET", "/api/v1/audit-sinks");
  }

  create(input: AuditSinkInput): Promise<AuditSink> {
    return this.client.request("POST", "/api/v1/audit-sinks", { body: input });
  }

  /** Toggle enabled, rename, edit config, or rotate credentials. */
  patch(id: string, patch: AuditSinkPatch): Promise<AuditSink> {
    return this.client.request(
      "PATCH",
      `/api/v1/audit-sinks/${encodeURIComponent(id)}`,
      { body: patch },
    );
  }

  delete(id: string): Promise<{ deleted: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/audit-sinks/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Preflight test: ship one canary event using the supplied config
   * + credentials. Returns 200 on upstream success, 502 with the
   * upstream error on failure. Does not persist.
   */
  test(
    input: AuditSinkInput,
  ): Promise<{ delivered: boolean; kind: string; action: string }> {
    return this.client.request("POST", "/api/v1/audit-sinks/test", {
      body: input,
    });
  }

  /** Probe an existing sink using its stored credentials. */
  testExisting(
    id: string,
  ): Promise<{ delivered: boolean; kind: string; action: string }> {
    return this.client.request(
      "POST",
      `/api/v1/audit-sinks/${encodeURIComponent(id)}/test`,
    );
  }

  /** Pending DLQ entries for this tenant. */
  dlqList(): Promise<{ entries: AuditSinkDLQEntry[]; count: number }> {
    return this.client.request("GET", "/api/v1/audit-sinks/dlq");
  }

  /**
   * Synchronously re-ship the audit_log range captured by this DLQ
   * entry. On success the entry is marked replayed; on failure the
   * attempt counter bumps.
   */
  dlqReplay(
    id: number,
  ): Promise<{ replayed: boolean; rows: number; note?: string }> {
    return this.client.request(
      "POST",
      `/api/v1/audit-sinks/dlq/${id}/replay`,
    );
  }

  /** Force-close the breaker without waiting for the cooldown. */
  circuitReset(id: string): Promise<{ reset: boolean }> {
    return this.client.request(
      "POST",
      `/api/v1/audit-sinks/${encodeURIComponent(id)}/circuit/reset`,
    );
  }
}
