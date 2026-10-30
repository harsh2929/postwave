// SPDX-License-Identifier: AGPL-3.0-only
//
// opsIncidentApi.ts — server-side proxies for the incident-timeline writes
// (open an incident, append an update). Same security envelope as the other ops
// action proxies (opsSecurity.forwardOpsMutation): forwards the operator cookie,
// same-origin CSRF gate, bounded body, no outcome laundering. These target
// ops-owned platform tables, so there is no tenant scoping — but a missing
// incident on the update path is passed through as the API's 404, never invented.

import { forwardOpsMutation, MAX_INCIDENT_BODY_BYTES, safeJSON } from "./opsSecurity";
import {
  hasOnlyKeys,
  isBoundedMultilineText,
  isBoundedText,
  isCanonicalUUID,
  isRecord,
} from "./viewSchema";

export function isIncidentID(id: string): boolean {
  return isCanonicalUUID(id);
}

type IncidentKind = "open" | "update";

// forwardIncidentWrite proxies one POST to the given ops path. The API validates
// the body (title/severity/status); this layer forwards and reports.
function forwardIncidentWrite(
  req: Request,
  path: string,
  kind: IncidentKind,
): Promise<Response> {
  return forwardOpsMutation<IncidentKind>(req, {
    path,
    bodyLimit: MAX_INCIDENT_BODY_BYTES,
    unreachableMessage:
      "the ops service did not provide a definitive answer; retrying this intent reuses its idempotency key",
    validate: (parsed) =>
      isValidIncidentWrite(parsed, kind) ? { body: parsed, context: kind } : null,
    normalize: (payload, ctx) => normalizeIncidentSuccess(payload, ctx),
  });
}

export function normalizeIncidentSuccess(
  payload: unknown,
  kind: IncidentKind,
): Record<string, unknown> | undefined {
  if (!isRecord(payload) || typeof payload.replayed !== "boolean") return undefined;
  if (kind === "open") {
    if (!hasOnlyKeys(payload, ["id", "status", "replayed"])) return undefined;
    if (!isIncidentID(String(payload.id ?? "")) || payload.status !== "open") return undefined;
    return { id: payload.id, status: "open", replayed: payload.replayed };
  }
  if (!hasOnlyKeys(payload, ["incident_id", "status", "replayed"])) return undefined;
  if (!isIncidentID(String(payload.incident_id ?? "")) || payload.status !== "applied") {
    return undefined;
  }
  return {
    incident_id: payload.incident_id,
    status: "applied",
    replayed: payload.replayed,
  };
}

function isValidIncidentWrite(
  payload: unknown,
  kind: IncidentKind,
): payload is Record<string, unknown> {
  if (!isRecord(payload)) return false;
  if (kind === "open") {
    return (
      hasOnlyKeys(payload, ["title", "severity", "body", "idempotency_key"]) &&
      isBoundedText(payload.title, 256, 1024) &&
      (payload.severity === "sev1" || payload.severity === "sev2" || payload.severity === "sev3") &&
      isBoundedMultilineText(payload.body, 4096, 16384) &&
      isCanonicalUUID(payload.idempotency_key)
    );
  }
  return (
    hasOnlyKeys(payload, ["body", "status", "idempotency_key"]) &&
    isBoundedMultilineText(payload.body, 4096, 16384) &&
    (payload.status === "" ||
      payload.status === "open" ||
      payload.status === "monitoring" ||
      payload.status === "resolved") &&
    isCanonicalUUID(payload.idempotency_key)
  );
}

// forwardIncidentOpen: POST /api/internal/ops/views/incidents
export function forwardIncidentOpen(req: Request): Promise<Response> {
  return forwardIncidentWrite(req, "/api/internal/ops/views/incidents", "open");
}

// forwardIncidentUpdate: POST /api/internal/ops/views/incidents/{id}/updates
export function forwardIncidentUpdate(req: Request, incidentID: string): Promise<Response> {
  if (!isIncidentID(incidentID)) {
    return Promise.resolve(safeJSON(400, "bad_incident_id", "that is not an incident id"));
  }
  return forwardIncidentWrite(
    req,
    `/api/internal/ops/views/incidents/${encodeURIComponent(incidentID)}/updates`,
    "update",
  );
}
