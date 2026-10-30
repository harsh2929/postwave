/**
 * Dependency-inversion seam between the eager transport and deferred route
 * method factories. The route runtime must not statically import api-client:
 * doing so closes the dynamic-import cycle and forces Rollup to preload the
 * supposedly deferred modules.
 */
import type { ApiResult, QueueableApiResult } from "./api/result";

interface RequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
  onResponseHeaders?: (headers: Headers) => void;
}

type Request = <T>(
  path: string,
  init?: RequestInit,
  options?: RequestOptions,
) => Promise<ApiResult<T>>;

type QueueableRequest = <T>(
  path: string,
  init?: RequestInit,
  options?: RequestOptions,
) => Promise<QueueableApiResult<T>>;

interface RouteTransport {
  request: Request;
  queueableRequest: QueueableRequest;
  getApiUrl: () => string;
  buildStreamUrl: (path: string) => Promise<string>;
  getTenantId: () => string | null;
}

let transport: RouteTransport | null = null;

export function registerRouteApiTransport(next: RouteTransport): void {
  transport = next;
}

function getTransport(): RouteTransport {
  if (!transport) {
    throw new Error("Deferred route API transport was used before bootstrap.");
  }
  return transport;
}

export const routeApiRequest: Request = <T>(
  path: string,
  init?: RequestInit,
  options?: RequestOptions,
) => getTransport().request<T>(path, init, options);

export const routeQueueableApiRequest: QueueableRequest = <T>(
  path: string,
  init?: RequestInit,
  options?: RequestOptions,
) => getTransport().queueableRequest<T>(path, init, options);

export function routeGetApiUrl(): string {
  return getTransport().getApiUrl();
}

export function routeBuildStreamUrl(path: string): Promise<string> {
  return getTransport().buildStreamUrl(path);
}

export function routeGetTenantId(): string | null {
  return getTransport().getTenantId();
}
