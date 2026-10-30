import { apiIdentityGenerationIsCurrent } from "./api-identity-transition";

const AUTHORITY_SCOPE_RE = /^v1-(?:session|api-key)-[a-f0-9]{64}$/u;
const RECOVERY_SCOPE_RE = /^[a-f0-9]{64}$/u;

interface VerifiedWebhookPlaygroundFireScope {
  readonly apiIdentityGeneration: number;
  readonly authorityScope: string;
}

let verifiedScope: VerifiedWebhookPlaygroundFireScope | null = null;

/**
 * Publish only a server-qualified, cryptographically scoped identity. The
 * registry is process-local so credential transitions can classify encrypted
 * recovery evidence without importing the user store or API client.
 */
export function registerVerifiedWebhookPlaygroundFireScope(
  value: {
    apiIdentityGeneration: number;
    credentialSource: "session" | "api-key";
    recoveryScope: string;
  } | null,
): void {
  if (
    !value ||
    !Number.isSafeInteger(value.apiIdentityGeneration) ||
    value.apiIdentityGeneration < 0 ||
    !RECOVERY_SCOPE_RE.test(value.recoveryScope)
  ) {
    verifiedScope = null;
    return;
  }
  verifiedScope = Object.freeze({
    apiIdentityGeneration: value.apiIdentityGeneration,
    authorityScope: `v1-${value.credentialSource}-${value.recoveryScope}`,
  });
}

export function currentVerifiedWebhookPlaygroundFireScope(): string | null {
  if (
    !verifiedScope ||
    !AUTHORITY_SCOPE_RE.test(verifiedScope.authorityScope) ||
    !apiIdentityGenerationIsCurrent(verifiedScope.apiIdentityGeneration)
  ) {
    return null;
  }
  return verifiedScope.authorityScope;
}

/** @internal Test isolation for the process-local verified scope. */
export function resetVerifiedWebhookPlaygroundFireScopeForTests(): void {
  verifiedScope = null;
}
