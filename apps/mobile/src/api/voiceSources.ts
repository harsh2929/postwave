/**
 * api/voiceSources.ts — the corpus behind the measured voice profile.
 *
 *   GET    /api/v1/voice/sources                       (read:campaigns)
 *   POST   /api/v1/voice/sources                       (write:campaigns) → 201
 *   POST   /api/v1/voice/sources/{id}/ingest           (write:campaigns) → 202
 *   GET    /api/v1/voice/sources/{id}/ingest/{job_id}  (read:campaigns)
 *   DELETE /api/v1/voice/sources/{id}                  (write:campaigns)
 *
 * All five confirmed at apps/api/main.go:3885, 3913-3916, handlers at
 * services/voice/internal/handlers/voice.go:315-319.
 *
 * ONLINE-ONLY writes, deliberately. `lib/offlineQueueSafety` denies every
 * DELETE by design, and an ingest is a server-side job whose whole point is
 * that the operator watches it finish — firing one silently on reconnect
 * hours later is not what was asked for. The card hides these affordances
 * while the online gate is closed rather than queueing them.
 *
 * The ingest POST answers 202 with `{job_id, status}` and the poll answers the
 * full job row. When the job store is unwired (dev mode) the poll 404s even
 * though the POST returned an id — `lib/voiceSources.ingestStatusMessage`
 * renders that as "no longer available", never as success.
 */
import { rawRequest, type AIApiResult } from "./request";
import type {
  VoiceSourceParamsWire,
  VoiceSourceType,
  VoiceSourceWire,
} from "@/lib/voiceSources";

const BASE = "/api/v1/voice/sources";

/** The handler writes the row array directly, with no envelope. */
export function listVoiceSources(): Promise<AIApiResult<VoiceSourceWire[]>> {
  return rawRequest<VoiceSourceWire[]>("GET", BASE);
}

export function createVoiceSource(
  body: { type: VoiceSourceType; params: VoiceSourceParamsWire },
  idempotencyKey?: string | undefined,
): Promise<AIApiResult<{ source_id: string }>> {
  return rawRequest<{ source_id: string }>(
    "POST",
    BASE,
    body,
    idempotencyKey !== undefined ? { idempotencyKey } : undefined,
  );
}

export interface IngestJobWire {
  id?: string;
  source_id?: string;
  status?: string;
  item_count?: number;
  error_message?: string;
  started_at?: string;
  finished_at?: string;
}

export function startVoiceSourceIngest(
  id: string,
  idempotencyKey?: string | undefined,
): Promise<AIApiResult<{ job_id: string; status: string }>> {
  return rawRequest<{ job_id: string; status: string }>(
    "POST",
    `${BASE}/${encodeURIComponent(id)}/ingest`,
    {},
    idempotencyKey !== undefined ? { idempotencyKey } : undefined,
  );
}

export function getVoiceSourceIngestJob(
  id: string,
  jobId: string,
): Promise<AIApiResult<IngestJobWire>> {
  return rawRequest<IngestJobWire>(
    "GET",
    `${BASE}/${encodeURIComponent(id)}/ingest/${encodeURIComponent(jobId)}`,
  );
}

export function deleteVoiceSource(id: string): Promise<AIApiResult<null>> {
  return rawRequest<null>("DELETE", `${BASE}/${encodeURIComponent(id)}`);
}
