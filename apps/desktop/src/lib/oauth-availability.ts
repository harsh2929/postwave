import {
  apiIdentityGenerationIsCurrent,
  apiIdentitySignal,
  captureApiIdentityGeneration,
} from "./api-identity-transition";

const OAUTH_PROBE_TIMEOUT_MS = 5_000;

/** Fail open for UI availability while refusing cross-identity dispatch. */
export async function probeOAuthAvailability(url: string): Promise<boolean> {
  const generation = captureApiIdentityGeneration();
  if (generation === null) return true;
  const controller = new AbortController();
  const timer = globalThis.setTimeout(
    () => controller.abort(),
    OAUTH_PROBE_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "include",
      redirect: "manual",
      signal: apiIdentitySignal(controller.signal),
      cache: "no-store",
    });
    if (!apiIdentityGenerationIsCurrent(generation)) return true;
    if (response.type === "opaqueredirect" || response.status === 0) return true;
    if (response.status === 404) return false;
    return true;
  } catch {
    return true;
  } finally {
    globalThis.clearTimeout(timer);
  }
}
