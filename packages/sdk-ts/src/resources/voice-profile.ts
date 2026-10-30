import { Resource } from "./_base.js";
import { RequestAbortedError } from "../errors.js";
import type { RegisterVoiceSource, VoiceProfile, VoiceSource } from "../types.js";

/**
 * IngestJob is the polling shape for /sources/{source_id}/ingest.
 * Identical state machine to SequenceJob.
 */
export interface IngestJob {
  id: string;
  tenant_id: string;
  source_id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  item_count: number;
  error_message?: string;
  started_at?: string;
  finished_at?: string;
  created_at: string;
  updated_at: string;
}

export interface IngestWaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class VoiceProfileResource extends Resource {
  get(): Promise<VoiceProfile> {
    return this.client.request("GET", "/api/v1/voice/profile");
  }

  /** Re-build the profile from currently-ingested sources. */
  build(): Promise<VoiceProfile> {
    return this.client.request("POST", "/api/v1/voice/profile/build");
  }

  listSources(): Promise<VoiceSource[]> {
    return this.client.request("GET", "/api/v1/voice/sources");
  }

  addSource(input: RegisterVoiceSource): Promise<{ source_id: string }> {
    return this.client.request("POST", "/api/v1/voice/sources", { body: input });
  }

  /**
   * Kick off ingestion. Returns `{job_id}`; poll `getIngestJob(id)`
   * until terminal status. Job rows are tenant-scoped + RLS-isolated.
   */
  ingestSource(sourceID: string): Promise<{ job_id: string; status?: string }> {
    return this.client.request(
      "POST",
      `/api/v1/voice/sources/${encodeURIComponent(sourceID)}/ingest`,
    );
  }

  /** Poll an ingest job started by `ingestSource(sourceID)`. */
  getIngestJob(
    sourceID: string,
    jobID: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<IngestJob> {
    return this.client.request(
      "GET",
      `/api/v1/voice/sources/${encodeURIComponent(sourceID)}/ingest/${encodeURIComponent(jobID)}`,
      { signal: opts.signal },
    );
  }

  /**
   * Convenience: poll until terminal. Constant 2s backoff, 5 min
   * timeout. Same shape as SequencesResource.waitForJob.
   */
  async waitForIngestJob(
    sourceID: string,
    jobID: string,
    opts: IngestWaitOptions = {},
  ): Promise<IngestJob> {
    const intervalMs = normalizePollInterval(opts.intervalMs);
    const timeoutMs = normalizeWaitTimeout(opts.timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new RequestAbortedError();
      const job = await this.getIngestJob(sourceID, jobID, { signal: opts.signal });
      if (job.status === "succeeded" || job.status === "failed") {
        return job;
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), opts.signal);
    }
    throw new Error(`voice.waitForIngestJob(${jobID}): timed out after ${timeoutMs}ms`);
  }

  removeSource(id: string): Promise<void> {
    return this.client.request("DELETE", `/api/v1/voice/sources/${encodeURIComponent(id)}`);
  }
}

function normalizePollInterval(value: number | undefined): number {
  if (value === undefined) return 2000;
  if (!Number.isFinite(value) || value <= 0) return 2000;
  return Math.min(Math.floor(value), 30_000);
}

function normalizeWaitTimeout(value: number | undefined): number {
  if (value === undefined) return 5 * 60_000;
  if (!Number.isFinite(value) || value <= 0) return 5 * 60_000;
  return Math.min(Math.floor(value), 30 * 60_000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RequestAbortedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new RequestAbortedError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
