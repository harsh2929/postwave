import type {
  NormalizedPlaygroundOperation,
  PlaygroundMethod,
} from "./api-playground-openapi";

export type PlaygroundEffect = "read" | "effectful" | "destructive";
export type PlaygroundRole = "viewer" | "editor" | "admin";

export interface PlaygroundExecutionPolicy {
  operationKey: string;
  method: PlaygroundMethod;
  pathTemplate: string;
  executable: boolean;
  effect: PlaygroundEffect;
  reason?: string;
  contractFingerprint: string;
  authMode: "workspace" | "session" | "unsupported";
  requiredRole: PlaygroundRole;
  idempotency: "none" | "optional" | "required";
  responseKind: "json" | "empty" | "stream" | "binary" | "unsupported";
  responseMediaTypesByStatus: Readonly<Record<string, readonly string[]>>;
}

interface ReviewedExecutionContract {
  effect: PlaygroundEffect;
  fingerprint: string;
}

// Live execution is deliberately tied to the exact normalized safety contract.
// An intentional OpenAPI change must be independently reviewed before updating
// one of these fingerprints; matching only a familiar method/path is not enough.
const REVIEWED_EXECUTION = new Map<string, ReviewedExecutionContract>([
  [
    "GET /api/v1/accounts",
    { effect: "read", fingerprint: "527:2f2b5cd00dcee3e0" },
  ],
  [
    "GET /api/v1/api-keys/me",
    { effect: "read", fingerprint: "591:a3f40dcff0a397b0" },
  ],
  [
    "GET /api/v1/campaigns",
    { effect: "read", fingerprint: "956:8f2e1bcb1258c182" },
  ],
  [
    "GET /api/v1/campaigns/{id}",
    { effect: "read", fingerprint: "785:046d1b85d2a4c58f" },
  ],
  [
    "GET /api/v1/segments",
    { effect: "read", fingerprint: "705:da9393780eeea93e" },
  ],
  [
    "GET /api/v1/segments/{id}",
    { effect: "read", fingerprint: "717:237616b1f784461e" },
  ],
  [
    "GET /api/v1/subscribers",
    { effect: "read", fingerprint: "3058:b60c688377d47ab2" },
  ],
  [
    "GET /api/v1/subscribers/{id}",
    { effect: "read", fingerprint: "741:8c738f76283646bd" },
  ],
  [
    "GET /api/v1/tags",
    { effect: "read", fingerprint: "1193:b404302def9af8f2" },
  ],
  [
    "GET /api/v1/tags/{id}/history",
    { effect: "read", fingerprint: "1204:113c3a2a1d432d44" },
  ],
  [
    "POST /api/v1/tags",
    { effect: "effectful", fingerprint: "1681:85f1ec4398f9ec5d" },
  ],
  [
    "PATCH /api/v1/tags/{id}",
    { effect: "effectful", fingerprint: "2186:1e32e83e26573aed" },
  ],
  [
    "DELETE /api/v1/tags/{id}",
    { effect: "destructive", fingerprint: "994:97c063ae36746f64" },
  ],
]);

const ROLE_RANK: Record<PlaygroundRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

const JSON_MEDIA = /^(application\/json|application\/[^;]+\+json)(?:;|$)/i;
const STREAM_MEDIA = /^(text\/event-stream|application\/x-ndjson)(?:;|$)/i;
const BINARY_MEDIA =
  /^(image\/|audio\/|video\/|application\/(octet-stream|zip|pdf)|text\/csv)/i;

function operationKey(method: PlaygroundMethod, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function canonicalContractValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return '"<undefined>"';
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : '"<non-finite>"';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalContractValue).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalContractValue(record[key])}`,
      )
      .join(",")}}`;
  }
  return `"<${typeof value}>"`;
}

function reviewedContractShape(
  operation: NormalizedPlaygroundOperation,
): Record<string, unknown> {
  return {
    method: operation.method,
    path: operation.path,
    operationId: operation.operationId,
    deprecated: operation.deprecated,
    parameters: operation.parameters,
    requestBody: operation.requestBody,
    responses: operation.responses,
    security: operation.security,
    explicitlyPublic: operation.explicitlyPublic,
    requiredRole: operation.requiredRole,
    requiredScopes: operation.requiredScopes,
    requiredScopeMode: operation.requiredScopeMode,
    releaseHold: operation.releaseHold,
    maxBodyBytes: operation.maxBodyBytes,
    bodyless: operation.bodyless,
    contractIssues: operation.contractIssues,
  };
}

export function reviewedContractFingerprint(
  operation: NormalizedPlaygroundOperation,
): string {
  const canonical = canonicalContractValue(reviewedContractShape(operation));
  const bytes = new TextEncoder().encode(canonical);
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${bytes.byteLength}:${hash.toString(16).padStart(16, "0")}`;
}

function requiredRole(
  operation: NormalizedPlaygroundOperation,
): PlaygroundRole {
  const explicit = operation.requiredRole?.toLowerCase();
  if (explicit === "admin" || explicit === "owner") return "admin";
  if (explicit === "editor" || explicit === "member") return "editor";
  if (operation.requiredScopes.some((scope) => scope === "admin"))
    return "admin";
  if (operation.requiredScopes.some((scope) => scope.startsWith("write:"))) {
    return "editor";
  }
  return "viewer";
}

function authMode(
  operation: NormalizedPlaygroundOperation,
): PlaygroundExecutionPolicy["authMode"] {
  if (operation.explicitlyPublic || operation.security.length === 0) {
    return "unsupported";
  }
  const supported = operation.security.find(
    (requirement) =>
      requirement.schemes.length === 1 &&
      requirement.schemes.every(
        (scheme) => scheme === "bearerAuth" || scheme === "sessionCookie",
      ),
  );
  if (!supported) return "unsupported";
  return supported.schemes.includes("bearerAuth") ? "workspace" : "session";
}

function responseKind(
  operation: NormalizedPlaygroundOperation,
): PlaygroundExecutionPolicy["responseKind"] {
  const media = operation.responses.mediaTypes;
  if (media.some((item) => STREAM_MEDIA.test(item))) return "stream";
  if (media.some((item) => BINARY_MEDIA.test(item))) return "binary";
  if (media.length === 0) return "empty";
  return media.every((item) => JSON_MEDIA.test(item)) ? "json" : "unsupported";
}

function idempotencyPolicy(
  operation: NormalizedPlaygroundOperation,
): PlaygroundExecutionPolicy["idempotency"] {
  const parameter = operation.parameters.find(
    (item) =>
      item.location === "header" &&
      item.name.toLowerCase() === "idempotency-key",
  );
  return parameter ? (parameter.required ? "required" : "optional") : "none";
}

function unsupportedParameterReason(
  operation: NormalizedPlaygroundOperation,
): string | undefined {
  for (const parameter of operation.parameters) {
    const type = parameter.schema?.type;
    if (type === "array" || type === "object") {
      return `${parameter.location} parameter ${parameter.name} needs structured serialization that the runner does not approximate.`;
    }
    if (
      (parameter.location === "path" || parameter.location === "header") &&
      parameter.style !== undefined &&
      parameter.style !== "simple"
    ) {
      return `${parameter.location} parameter ${parameter.name} uses unsupported ${parameter.style} serialization.`;
    }
    if (
      parameter.location === "query" &&
      parameter.style !== undefined &&
      parameter.style !== "form"
    ) {
      return `query parameter ${parameter.name} uses unsupported ${parameter.style} serialization.`;
    }
  }
  return undefined;
}

function unsupportedReason(
  operation: NormalizedPlaygroundOperation,
  mode: PlaygroundExecutionPolicy["authMode"],
  response: PlaygroundExecutionPolicy["responseKind"],
): string | undefined {
  if (operation.releaseHold) {
    return `Release hold: ${operation.releaseHold}`;
  }
  if (operation.contractIssues.length > 0) {
    return `Catalog contract issue: ${operation.contractIssues[0]}`;
  }
  if (operation.deprecated) return "Deprecated operations are reference-only.";
  if (operation.explicitlyPublic) {
    return "Public capability and callback routes are reference-only.";
  }
  if (mode === "unsupported") {
    return "This route uses an authentication scheme the desktop runner cannot represent safely.";
  }
  if (operation.requestBody && !operation.requestBody.selectedMediaType) {
    return `Unsupported request media: ${operation.requestBody.mediaTypes.join(", ") || "none"}.`;
  }
  const parameterReason = unsupportedParameterReason(operation);
  if (parameterReason) return parameterReason;
  if (response === "stream")
    return "Streaming responses require a dedicated client.";
  if (response === "binary")
    return "Downloads and binary responses are reference-only.";
  if (response === "unsupported") {
    return `Unsupported response media: ${operation.responses.mediaTypes.join(", ")}.`;
  }
  if (
    response === "empty" &&
    operation.responses.statuses.some(
      (status) =>
        /^2(?:\d\d|xx)$/i.test(status) && status !== "204" && status !== "205",
    )
  ) {
    return "Successful response media is not declared, so the live preview cannot verify its contract.";
  }
  const reviewed = REVIEWED_EXECUTION.get(
    operationKey(operation.method, operation.path),
  );
  if (!reviewed) {
    return "Not yet reviewed for live execution; the complete contract remains available in Reference.";
  }
  if (reviewed.fingerprint !== reviewedContractFingerprint(operation)) {
    return "Reviewed runner contract changed; independent re-review is required.";
  }
  return undefined;
}

export function executionPolicyFor(
  operation: NormalizedPlaygroundOperation,
): PlaygroundExecutionPolicy {
  const key = operationKey(operation.method, operation.path);
  const reviewed = REVIEWED_EXECUTION.get(key);
  const contractFingerprint = reviewedContractFingerprint(operation);
  const mode = authMode(operation);
  const response = responseKind(operation);
  const reason = unsupportedReason(operation, mode, response);
  const responseMediaTypesByStatus = Object.freeze(
    Object.fromEntries(
      Object.entries(operation.responses.mediaTypesByStatus).map(
        ([status, mediaTypes]) => [status, Object.freeze([...mediaTypes])],
      ),
    ),
  );
  return Object.freeze({
    operationKey: key,
    method: operation.method,
    pathTemplate: operation.path,
    executable: reason === undefined && reviewed !== undefined,
    effect: reviewed?.effect ?? "destructive",
    reason,
    contractFingerprint,
    authMode: mode,
    requiredRole: requiredRole(operation),
    idempotency: idempotencyPolicy(operation),
    responseKind: response,
    responseMediaTypesByStatus,
  });
}

export function isExactReviewedExecution(
  policy: PlaygroundExecutionPolicy,
): boolean {
  return (
    policy.operationKey === operationKey(policy.method, policy.pathTemplate) &&
    REVIEWED_EXECUTION.get(policy.operationKey)?.effect === policy.effect &&
    REVIEWED_EXECUTION.get(policy.operationKey)?.fingerprint ===
      policy.contractFingerprint
  );
}

export function playgroundRoleAllows(
  actual: string | null | undefined,
  required: PlaygroundRole,
): boolean {
  if (actual !== "admin" && actual !== "editor" && actual !== "viewer") {
    return false;
  }
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function reviewedExecutionKeys(): readonly string[] {
  return [...REVIEWED_EXECUTION.keys()].sort();
}

export function isPortablePlaygroundHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "accept" || normalized === "if-match";
}
