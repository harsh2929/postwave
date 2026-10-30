/**
 * Orthogonal state for a server-backed read.
 *
 * `data` answers whether the UI has a verified response (an empty array is
 * verified data). `transport`, `access`, and `stale` answer different
 * questions and must not be collapsed into an "empty" branch.
 */

export type RemoteTransport = "idle" | "loading" | "ready" | "error";
export type RemoteAccess = "unknown" | "allowed" | "denied";

export interface RemoteApiError {
  message?: string;
  status?: number;
  code?: string;
  requestId?: string;
  kind?:
    | "http"
    | "network"
    | "offline"
    | "storage"
    | "timeout"
    | "parse"
    | "invalid_config";
}

export interface RemoteFailure {
  access: RemoteAccess;
  message: string;
  code?: string;
  requestId?: string;
}

export interface RemoteResource<T> {
  data: T | null;
  transport: RemoteTransport;
  access: RemoteAccess;
  stale: boolean;
  failure: RemoteFailure | null;
  lastVerifiedAt: number | null;
}

export function createRemoteResource<T>(): RemoteResource<T> {
  return {
    data: null,
    transport: "idle",
    access: "unknown",
    stale: false,
    failure: null,
    lastVerifiedAt: null,
  };
}

export function createVerifiedRemoteResource<T>(
  data: T,
  now = Date.now(),
): RemoteResource<T> {
  return {
    data,
    transport: "ready",
    access: "allowed",
    stale: false,
    failure: null,
    lastVerifiedAt: now,
  };
}

export function beginRemoteLoad<T>(
  previous: RemoteResource<T>,
): RemoteResource<T> {
  return {
    ...previous,
    transport: "loading",
    failure: null,
  };
}

export function completeRemoteLoad<T>(
  previous: RemoteResource<T>,
  data: T,
  now = Date.now(),
): RemoteResource<T> {
  return {
    ...previous,
    data,
    transport: "ready",
    access: "allowed",
    stale: false,
    failure: null,
    lastVerifiedAt: now,
  };
}

function normalizedCode(error: RemoteApiError): string {
  return (error.code ?? "").trim().toLowerCase();
}

function safeDiagnosticToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  if (!token || token.length > 96) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(token) ? token : undefined;
}

export function isRemotePermissionError(error: RemoteApiError): boolean {
  if (error.status === 401 || error.status === 403) return true;
  return [
    "forbidden",
    "permission_denied",
    "unauthorized",
    "insufficient_scope",
  ].includes(normalizedCode(error));
}

/**
 * Convert an API error into copy that is safe to put in an operator panel.
 * Raw backend messages can include implementation detail or reflected input;
 * the UI exposes only a bounded category plus safe correlation metadata.
 */
export function remoteFailureFromError(error: RemoteApiError): RemoteFailure {
  const access = isRemotePermissionError(error) ? "denied" : "unknown";
  let message = "The server could not verify this data.";
  if (error.status === 401 || normalizedCode(error) === "unauthorized") {
    message = "Your session is no longer authorized to read this data.";
  } else if (access === "denied") {
    message = "Your current role does not have permission to read this data.";
  } else if (error.kind === "network" || error.kind === "offline") {
    message =
      "The service could not be reached. Check the connection and retry.";
  } else if (error.kind === "storage") {
    message = "Local storage could not complete this read. Retry when ready.";
  } else if (error.kind === "timeout") {
    message = "The service did not respond in time. Retry when ready.";
  } else if (error.kind === "invalid_config") {
    message = "This service is not configured for the current environment.";
  } else if (error.status !== undefined && error.status >= 500) {
    message = "The service could not complete the request.";
  }

  return {
    access,
    message,
    ...(safeDiagnosticToken(error.code)
      ? { code: safeDiagnosticToken(error.code) }
      : {}),
    ...(safeDiagnosticToken(error.requestId)
      ? { requestId: safeDiagnosticToken(error.requestId) }
      : {}),
  };
}

export function failRemoteLoad<T>(
  previous: RemoteResource<T>,
  error: RemoteApiError,
): RemoteResource<T> {
  const failure = remoteFailureFromError(error);
  // A newly denied principal must not keep seeing a snapshot obtained under a
  // previous access decision. Other refresh failures retain verified data and
  // label it stale instead of replacing it with an unverified empty state.
  const data = failure.access === "denied" ? null : previous.data;
  return {
    ...previous,
    data,
    transport: "error",
    access:
      failure.access === "denied"
        ? "denied"
        : previous.data === null
          ? "unknown"
          : previous.access,
    stale: data !== null,
    failure,
  };
}

export function hasVerifiedRemoteData<T>(
  resource: RemoteResource<T>,
): resource is RemoteResource<T> & { data: T } {
  return resource.data !== null;
}

export function isInitialRemoteLoad<T>(resource: RemoteResource<T>): boolean {
  return (
    resource.data === null &&
    (resource.transport === "idle" || resource.transport === "loading")
  );
}
