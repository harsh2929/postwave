import {
  apiIdentityGenerationIsCurrent,
  apiIdentitySignal,
  captureApiIdentityGeneration,
} from "./api-identity-transition";
import { nativeAwareFetch } from "./native-api-fetch";

export { nativeAwareFetch };

/** Identity-safe binary transport for API method bags outside api-client. */
export async function apiIdentityAwareNativeFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const generation = captureApiIdentityGeneration();
  if (generation === null) {
    throw new Error("Workspace identity is changing; API dispatch is paused.");
  }
  const response = await nativeAwareFetch(input, {
    ...init,
    signal: apiIdentitySignal(init.signal ?? null),
  });
  if (!apiIdentityGenerationIsCurrent(generation)) {
    throw new Error("A response from the previous workspace was discarded.");
  }
  return response;
}
