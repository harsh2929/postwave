// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Product event -> sequence draft handoff (desktop TrackEventSlideover parity).
 *
 * Creates ONE inactive sequence draft whose single step is a
 * `product_event` condition on the chosen event name. Nothing is activated,
 * enrolled or sent: the voice service stores `status: "draft"` and web has no
 * qualified sequence runtime (SEQUENCE_RUNTIME_AVAILABLE is false), so the
 * draft can only be designed and reviewed.
 *
 * The create route has no proven server-side idempotency, so the request is
 * single-attempt and online-only. A failure whose outcome cannot be known
 * (transport loss, timeout, 5xx, an unverifiable 2xx body) is reported as
 * UNCERTAIN so the caller blocks a blind retry that could create a duplicate.
 */

import { api, ApiError } from "@/lib/api";
import { newUUIDv7 } from "@/lib/http-fetch";

/** Mirrors desktop's AUTOMATION_EVENT_NAME_RE and the 128-char feed bound. */
const AUTOMATION_EVENT_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const MAX_EVENT_NAME_LENGTH = 128;
const MAX_RESOURCE_ID_LENGTH = 512;

export interface TrackSequenceDraft {
  id: string;
  name: string;
}

/** The server accepted the request but its reply could not be verified. */
export class TrackSequenceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackSequenceContractError";
  }
}

export function canAutomateTrackEvent(eventName: string): boolean {
  return (
    eventName.length > 0 &&
    eventName.length <= MAX_EVENT_NAME_LENGTH &&
    AUTOMATION_EVENT_NAME_RE.test(eventName)
  );
}

export function trackSequenceDraftName(eventName: string): string {
  return `Follow up: ${eventName}`;
}

/**
 * True when the create request may or may not have been applied. A certain
 * refusal (4xx such as 400/403/409/429, or an offline refusal that never left
 * the browser) is safe to correct and retry; everything else is not.
 */
export function isUncertainTrackSequenceFailure(error: unknown): boolean {
  if (error instanceof TrackSequenceContractError) return true;
  if (error instanceof ApiError) {
    return (
      error.kind === "network" ||
      error.kind === "timeout" ||
      error.kind === "parse" ||
      error.status === 408 ||
      error.status >= 500
    );
  }
  return true;
}

function validResourceId(value: unknown): string | null {
  if (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= MAX_RESOURCE_ID_LENGTH
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return null;
}

export async function createTrackEventSequenceDraft(input: {
  eventName: string;
  signal?: AbortSignal;
}): Promise<TrackSequenceDraft> {
  const eventName = input.eventName.trim();
  if (!canAutomateTrackEvent(eventName)) {
    throw new Error(
      "This event has no valid event name, so an automation trigger cannot be created.",
    );
  }
  const name = trackSequenceDraftName(eventName);
  const response = await api.post<unknown>(
    "/api/v1/voice/sequences",
    {
      name,
      description: "",
      status: "draft",
      steps: [
        {
          type: "condition",
          position: 1,
          condition: {
            predicate: "product_event",
            value: eventName,
            yes_branch: [],
            no_branch: [],
          },
        },
      ],
    },
    {
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey: newUUIDv7(),
      signal: input.signal,
    },
  );
  const row =
    response !== null &&
    typeof response === "object" &&
    !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : null;
  const id = validResourceId(row?.id);
  if (!row || !id) {
    throw new TrackSequenceContractError(
      "The service accepted the sequence request but returned no valid sequence ID. Open Sequences to verify the result before retrying.",
    );
  }
  if (row.status !== "draft") {
    throw new TrackSequenceContractError(
      "The service did not confirm that the new sequence was created as an inactive draft. Open Sequences to verify the result before retrying.",
    );
  }
  return { id, name: typeof row.name === "string" ? row.name : name };
}
