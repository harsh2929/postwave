/**
 * PostwaveError hierarchy. Every method on the SDK raises a subclass of
 * PostwaveError so callers can do precise instanceof matching:
 *
 *   try {
 *     await pw.subscribers.get(id);
 *   } catch (e) {
 *     if (e instanceof NotFoundError) { ... }
 *   }
 */

export interface ErrorPayload {
  code: string;
  message: string;
  request_id?: string;
}

export type SendingCapOutcome =
  | "not-committed"
  | "committed"
  | "committed-conservatively-fenced"
  | "commit-outcome-unknown-conservatively-fenced";

/** Reviewed response metadata used by sending-cap control-plane recovery. */
export interface PostwaveResponseMetadata {
  /**
   * Present only when the response carried one of the four recognized
   * X-Postwave-Sending-Cap-Outcome values. Missing or malformed headers stay
   * absent and therefore cannot be mistaken for proof of a durable outcome.
   */
  readonly sendingCapOutcome?: SendingCapOutcome;
}

interface ErrorResponseContext {
  requestId?: string;
  payload?: unknown;
  responseMetadata?: PostwaveResponseMetadata;
}

export class PostwaveError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly payload: unknown;
  readonly responseMetadata: PostwaveResponseMetadata | undefined;

  constructor(
    message: string,
    opts: {
      status: number;
      code: string;
      requestId?: string;
      payload?: unknown;
      responseMetadata?: PostwaveResponseMetadata;
    },
  ) {
    super(message);
    this.name = "PostwaveError";
    this.status = opts.status;
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.payload = opts.payload;
    this.responseMetadata = opts.responseMetadata;
  }
}

export class AuthError extends PostwaveError {
  constructor(opts: { message: string; code: string } & ErrorResponseContext) {
    super(opts.message, {
      status: 401,
      code: opts.code,
      requestId: opts.requestId,
      payload: opts.payload,
      responseMetadata: opts.responseMetadata,
    });
    this.name = "AuthError";
  }
}

export class ForbiddenError extends PostwaveError {
  constructor(opts: { message: string; code: string } & ErrorResponseContext) {
    super(opts.message, {
      status: 403,
      code: opts.code,
      requestId: opts.requestId,
      payload: opts.payload,
      responseMetadata: opts.responseMetadata,
    });
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends PostwaveError {
  constructor(opts: { message: string; code: string } & ErrorResponseContext) {
    super(opts.message, {
      status: 404,
      code: opts.code,
      requestId: opts.requestId,
      payload: opts.payload,
      responseMetadata: opts.responseMetadata,
    });
    this.name = "NotFoundError";
  }
}

export class ConflictError extends PostwaveError {
  constructor(opts: { message: string; code: string } & ErrorResponseContext) {
    super(opts.message, {
      status: 409,
      code: opts.code,
      requestId: opts.requestId,
      payload: opts.payload,
      responseMetadata: opts.responseMetadata,
    });
    this.name = "ConflictError";
  }
}

export class ValidationError extends PostwaveError {
  readonly fields: Array<{ path: string; message: string }>;
  constructor(
    opts: {
      message: string;
      code: string;
      fields?: Array<{ path: string; message: string }>;
    } & ErrorResponseContext,
  ) {
    super(opts.message, {
      status: 422,
      code: opts.code,
      requestId: opts.requestId,
      payload: opts.payload,
      responseMetadata: opts.responseMetadata,
    });
    this.name = "ValidationError";
    this.fields = opts.fields ?? [];
  }
}

export class RateLimitError extends PostwaveError {
  readonly retryAfterSeconds: number | undefined;
  constructor(
    opts: {
      message: string;
      code: string;
      retryAfterSeconds?: number;
    } & ErrorResponseContext,
  ) {
    super(opts.message, {
      status: 429,
      code: opts.code,
      requestId: opts.requestId,
      payload: opts.payload,
      responseMetadata: opts.responseMetadata,
    });
    this.name = "RateLimitError";
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export class ServerError extends PostwaveError {
  constructor(
    opts: {
      message: string;
      code: string;
      status: number;
    } & ErrorResponseContext,
  ) {
    super(opts.message, {
      status: opts.status,
      code: opts.code,
      requestId: opts.requestId,
      payload: opts.payload,
      responseMetadata: opts.responseMetadata,
    });
    this.name = "ServerError";
  }
}

export class NetworkError extends PostwaveError {
  constructor(
    opts: { message: string; code?: string } & Pick<
      ErrorResponseContext,
      "payload"
    >,
  ) {
    super(opts.message, {
      status: 0,
      code: opts.code ?? "network_error",
      payload: opts.payload,
    });
    this.name = "NetworkError";
  }
}

export class TimeoutError extends NetworkError {
  constructor(opts: { message?: string; payload?: unknown } = {}) {
    super({
      message: opts.message ?? "Request timed out",
      code: "request_timeout",
      payload: opts.payload,
    });
    this.name = "TimeoutError";
  }
}

export class RequestAbortedError extends NetworkError {
  constructor(opts: { message?: string; payload?: unknown } = {}) {
    super({
      message: opts.message ?? "Request was cancelled",
      code: "request_aborted",
      payload: opts.payload,
    });
    this.name = "RequestAbortedError";
  }
}

/**
 * WrongRegionError is thrown when the API responds with 421 Misdirected
 * Request — the tenant's data lives in a different region than the
 * instance we contacted. The error carries the canonical SDK host for
 * the tenant's region so callers can immediately re-point their client:
 *
 *   try {
 *     await pw.subscribers.list();
 *   } catch (e) {
 *     if (e instanceof WrongRegionError) {
 *       const eu = new PostwaveClient({ ...opts, baseUrl: e.correctEndpoint });
 *       return eu.subscribers.list();
 *     }
 *     throw e;
 *   }
 */
export class WrongRegionError extends PostwaveError {
  /** SDK host for the tenant's region (https://eu-central-1.api.moosewave.com). */
  readonly correctEndpoint: string;
  /** Tenant's pinned region, e.g. "eu-central-1". */
  readonly region: string;
  constructor(opts: {
    message: string;
    code: string;
    correctEndpoint: string;
    region: string;
    requestId?: string;
    payload?: unknown;
    responseMetadata?: PostwaveResponseMetadata;
  }) {
    super(opts.message, {
      status: 421,
      code: opts.code,
      requestId: opts.requestId,
      payload: opts.payload,
      responseMetadata: opts.responseMetadata,
    });
    this.name = "WrongRegionError";
    this.correctEndpoint = opts.correctEndpoint;
    this.region = opts.region;
  }
}

export class ParseError extends PostwaveError {
  constructor(
    opts: {
      message?: string;
      status?: number;
      payload?: unknown;
      requestId?: string;
      responseMetadata?: PostwaveResponseMetadata;
    } = {},
  ) {
    super(
      opts.message ??
        "API returned invalid JSON. Please refresh and try again.",
      {
        status: opts.status ?? 0,
        code: "invalid_json",
        requestId: opts.requestId,
        payload: opts.payload,
        responseMetadata: opts.responseMetadata,
      },
    );
    this.name = "ParseError";
  }
}

/**
 * mapError translates an HTTP response payload into the right PostwaveError
 * subclass. The gateway's standard envelope is `{ error: { code, message } }`
 * — we accept either that shape or a flat `{ error: "msg" }` (used by a few
 * legacy handlers) and synthesize a code when missing.
 */
export function mapError(
  status: number,
  body: unknown,
  requestId?: string,
  headers?: Headers,
): PostwaveError {
  const env = parseErrorBody(body);
  const message = env.message || `HTTP ${status}`;
  const code = env.code || `http_${status}`;
  const responseMetadata = responseMetadataFromHeaders(headers);
  const common = {
    message,
    code,
    requestId: requestId ?? env.requestId,
    payload: body,
    responseMetadata,
  } as const;

  if (status === 401) return new AuthError(common);
  if (status === 403) return new ForbiddenError(common);
  if (status === 404 || status === 410) return new NotFoundError(common);
  if (status === 409) return new ConflictError(common);
  if (status === 421) {
    const correctEndpoint =
      headers?.get("location") ?? env.correctEndpoint ?? "";
    const region = headers?.get("x-postwave-region") ?? env.region ?? "";
    return new WrongRegionError({
      ...common,
      correctEndpoint,
      region,
    });
  }
  if (status === 422)
    return new ValidationError({ ...common, fields: env.fields });
  if (status === 429)
    return new RateLimitError({
      ...common,
      retryAfterSeconds: env.retryAfterSeconds,
    });
  if (status >= 500) return new ServerError({ ...common, status });
  return new PostwaveError(message, {
    status,
    code,
    requestId: common.requestId,
    payload: body,
    responseMetadata,
  });
}

export function responseMetadataFromHeaders(
  headers?: Headers,
): PostwaveResponseMetadata | undefined {
  const raw = headers?.get("x-postwave-sending-cap-outcome");
  switch (raw) {
    case "not-committed":
    case "committed":
    case "committed-conservatively-fenced":
    case "commit-outcome-unknown-conservatively-fenced":
      return { sendingCapOutcome: raw };
    default:
      return undefined;
  }
}

function parseErrorBody(body: unknown): {
  code?: string;
  message?: string;
  requestId?: string;
  fields?: Array<{ path: string; message: string }>;
  retryAfterSeconds?: number;
  correctEndpoint?: string;
  region?: string;
} {
  if (typeof body === "string") return { message: body };
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const errVal = b.error;
  if (typeof errVal === "string") {
    const flatMessage = typeof b.message === "string" ? b.message : undefined;
    return flatMessage
      ? { code: errVal, message: flatMessage }
      : { message: errVal };
  }
  if (errVal && typeof errVal === "object") {
    const e = errVal as Record<string, unknown>;
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : undefined,
      requestId:
        typeof e.request_id === "string"
          ? e.request_id
          : typeof e.requestId === "string"
            ? e.requestId
            : undefined,
      fields: Array.isArray(e.fields)
        ? (e.fields as Array<{ path: string; message: string }>)
        : undefined,
      retryAfterSeconds:
        typeof e.retry_after_seconds === "number"
          ? e.retry_after_seconds
          : typeof e.retryAfterSeconds === "number"
            ? e.retryAfterSeconds
            : undefined,
      correctEndpoint:
        typeof e.correct_endpoint === "string" ? e.correct_endpoint : undefined,
      region: typeof e.region === "string" ? e.region : undefined,
    };
  }
  return {
    code: typeof b.code === "string" ? b.code : undefined,
    message: typeof b.message === "string" ? b.message : undefined,
    requestId:
      typeof b.request_id === "string"
        ? b.request_id
        : typeof b.requestId === "string"
          ? b.requestId
          : undefined,
    fields: Array.isArray(b.fields)
      ? (b.fields as Array<{ path: string; message: string }>)
      : undefined,
    retryAfterSeconds:
      typeof b.retry_after_seconds === "number"
        ? b.retry_after_seconds
        : typeof b.retryAfterSeconds === "number"
          ? b.retryAfterSeconds
          : undefined,
  };
}
