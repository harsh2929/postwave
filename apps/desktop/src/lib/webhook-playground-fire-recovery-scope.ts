import { canonicalApiBaseUrl } from "./config";
import { opaqueVaultKey } from "./opaque-vault-key";

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const API_KEY_CREDENTIAL_FINGERPRINT_RE =
  /^(?:[a-f0-9]{64}|api-credential:sha256:[a-f0-9]{64})$/u;
export const WEBHOOK_PLAYGROUND_FIRE_RECOVERY_SCOPE_RE = /^[a-f0-9]{64}$/u;
const OPAQUE_SCOPE_PREFIX = "webhook-fire-recovery:sha256:";

export interface WebhookPlaygroundFireRecoveryScopeIdentity {
  readonly apiBaseUrl: string;
  readonly credentialSource: "session" | "api-key";
  readonly principal: string;
  readonly tenant: string;
}

/**
 * Derive the cryptographic identity scope stored on in-memory Me. The exact
 * API key never enters this function; API-key callers provide only the
 * broker/browser SHA-256 credential fingerprint.
 */
export async function deriveWebhookPlaygroundFireRecoveryScope(
  identity: WebhookPlaygroundFireRecoveryScopeIdentity,
): Promise<string | null> {
  const apiBaseUrl = canonicalApiBaseUrl(identity.apiBaseUrl);
  if (
    !apiBaseUrl ||
    !CANONICAL_UUID_RE.test(identity.tenant) ||
    (identity.credentialSource === "session"
      ? !CANONICAL_UUID_RE.test(identity.principal)
      : !API_KEY_CREDENTIAL_FINGERPRINT_RE.test(identity.principal))
  ) {
    return null;
  }
  const opaque = await opaqueVaultKey(
    "webhook-fire-recovery",
    JSON.stringify([
      1,
      apiBaseUrl,
      identity.credentialSource,
      identity.principal,
      identity.tenant,
    ]),
  );
  if (!opaque?.startsWith(OPAQUE_SCOPE_PREFIX)) return null;
  const scope = opaque.slice(OPAQUE_SCOPE_PREFIX.length);
  return WEBHOOK_PLAYGROUND_FIRE_RECOVERY_SCOPE_RE.test(scope) ? scope : null;
}
