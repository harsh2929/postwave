/**
 * api/migrationEvidence.ts — the RAW verification report, read for its
 * field-level detail.
 *
 * ROUTE (services/migration/internal/handlers/migration.go:2900-2915, and the
 * generated policy manifest):
 *
 *   GET /api/v1/migrations/{job_id}/verification
 *       session_minimum_role admin · api_key scope admin
 *
 * WHY A SECOND READ OF A ROUTE THE SHEET ALREADY CALLS. `useMigrationVerification`
 * parses the same body into COUNTS and throws the detail away, and widening
 * that parser would make every migration screen carry the evidence arrays
 * whether or not anyone opened them. This read is press-driven instead: the
 * evidence section asks for it only when an operator asks to see it, and the
 * report is written once and never edited, so a long cache window is honest
 * rather than a race.
 *
 * THE 404 IS A STATE, NOT A FAILURE — the handler answers it whenever the job
 * has no report yet, which is the normal answer for one that is still running.
 * It resolves to `null` here for the same reason it does in the summary hook.
 */
import {
  parseMigrationEvidence,
  type MigrationEvidence,
} from "@/lib/migrationEvidence";

import { rawRequest } from "./request";

export async function fetchMigrationVerificationEvidence(
  jobId: string,
): Promise<MigrationEvidence | null> {
  const id = (jobId ?? "").trim();
  if (!id) throw new Error("A job id is required to read its evidence.");
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/migrations/${encodeURIComponent(id)}/verification`,
  );
  if (res.error) {
    if (res.error.status === 404) return null;
    throw new Error(
      res.error.message || "Couldn't read the verification evidence.",
    );
  }
  return parseMigrationEvidence(res.data);
}
