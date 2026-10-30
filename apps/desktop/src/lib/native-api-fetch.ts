import { tauriApi } from "./tauri";

/**
 * Fetch through Rust when the URL matches an active origin-bound desktop
 * credential. Browser/cookie requests and explicit caller credentials retain
 * normal fetch semantics.
 */
export async function nativeAwareFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const effectiveInit =
    input instanceof Request
      ? {
          method: input.method,
          headers: input.headers,
          body: input.body,
          ...init,
        }
      : init;
  const native =
    (await tauriApi.fetchWithApiBroker(url, effectiveInit)) ??
    (await tauriApi.fetchWithSessionBroker(url, effectiveInit));
  return native ?? fetch(input, init);
}
