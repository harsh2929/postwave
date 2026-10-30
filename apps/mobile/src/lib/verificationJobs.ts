/**
 * lib/verificationJobs.ts — bulk email-verification jobs, which spend money.
 *
 * VERB#5: mobile's only verification calls were GET /health and POST /health/batch
 * (api/emailHealth.ts). The JOBS half — list, detail, results, and cancel — had no
 * client, so a bulk verification burning third-party credits could be neither seen
 * nor stopped from a phone.
 *
 * That is the same shape as the SMS gap: an operation with a per-unit vendor cost
 * and no brake. The difference is that this one is easier to start by accident,
 * because a large list looks the same as a small one until the invoice arrives.
 *
 * Cancel is `editor`; everything else is `viewer` (both reviewed). So a viewer
 * watches and an editor stops it.
 *
 * Import-free of react-native, so it is node-tested.
 */

import { WireShapeError } from "./deliverabilityContracts";

export type VerificationJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export interface VerificationJob {
  id: string;
  status: VerificationJobStatus;
  total: number;
  processed: number;
  createdAt: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const JOB_STATUSES = new Set<VerificationJobStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "canceled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
  );
}

/** Statuses whose work is finished; cancelling one is a no-op. */
const TERMINAL = new Set([
  "complete",
  "completed",
  "failed",
  "cancelled",
  "canceled",
]);

export function verificationJobIsRunning(status: string): boolean {
  return !TERMINAL.has(status.trim().toLowerCase());
}

/**
 * True when cancelling can still save money.
 *
 * The point of the button is the SPEND, not tidiness: a job that has finished has
 * already cost what it will cost, so offering Cancel there is a control with no
 * effect and an implied refund that is not coming.
 */
export function verificationJobIsCancellable(job: VerificationJob): boolean {
  return verificationJobIsRunning(job.status) && job.processed < job.total;
}

export function parseVerificationJobs(payload: unknown): VerificationJob[] {
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    throw new WireShapeError("verification jobs");
  }
  return payload.jobs.map((raw) => {
    if (!isRecord(raw)) throw new WireShapeError("verification jobs");
    const id = typeof raw.id === "string" ? raw.id : "";
    const status = raw.status;
    const createdAt = typeof raw.created_at === "string" ? raw.created_at : "";
    if (
      !UUID_PATTERN.test(id) ||
      typeof status !== "string" ||
      !JOB_STATUSES.has(status as VerificationJobStatus) ||
      !isCount(raw.total) ||
      raw.total < 1 ||
      !isCount(raw.processed) ||
      raw.processed > raw.total ||
      !createdAt ||
      !Number.isFinite(Date.parse(createdAt))
    ) {
      throw new WireShapeError("verification jobs");
    }
    return {
      id,
      status: status as VerificationJobStatus,
      total: raw.total,
      processed: raw.processed,
      createdAt,
    };
  });
}

/**
 * Progress said in terms of what remains to be SPENT.
 *
 * "412 of 5,000" is a progress bar; "4,588 addresses still to verify" is the number
 * that decides whether to hit Cancel.
 */
export function verificationJobSummary(job: VerificationJob): string {
  if (!verificationJobIsRunning(job.status)) {
    return `${job.status || "finished"} · ${job.processed} of ${job.total} verified.`;
  }
  const remaining = Math.max(0, job.total - job.processed);
  return remaining > 0
    ? `${remaining} address${remaining === 1 ? "" : "es"} still to verify — remaining work can still use provider credits.`
    : `${job.processed} of ${job.total} verified.`;
}
