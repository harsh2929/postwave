/**
 * provider-config-helpers — pure logic for ProviderConfigCard, split out
 * so it can be unit-tested in the node (no-DOM) vitest environment.
 *
 * Provider configuration has two credential boundaries:
 *
 *   • webhook_token — the shared token the deliverability webhook
 *     RECEIVERS verify on inbound bounce/complaint/open/click callbacks.
 *   • credential_ref — a non-secret runtime-secret reference. Mirror clients
 *     resolve the actual Mailchimp / SendGrid API key server-side.
 *
 * A legacy api_key may still be present on an old row. It is read-only
 * compatibility state: the API rejects new raw keys and removes the legacy
 * value when a credential_ref is saved.
 *
 * The providers GET endpoint REDACTS any secret-looking key to the literal
 * string "redacted" (apps/api/internal/webhooks/provider_config.go,
 * redactProviderConfig). So a read never reveals the real value — we can
 * only tell whether a secret is SET, which is exactly the honest-UI state
 * we want to render ("configured ✓" vs "not set"), never the value itself.
 */

/** The sentinel the backend substitutes for any secret-looking config key. */
export const REDACTED_SENTINEL = "redacted";

/**
 * Providers whose mirror clients resolve a runtime-vault credential to pull
 * suppressions.
 * Only Mailchimp + SendGrid have real mirror clients today; the SES /
 * Mailgun / Postmark mirror clients are nil placeholders, so the vault
 * reference input is only meaningful for these two.
 *
 * Source of truth: apps/api/internal/suppressions/mirror_clients.go
 * (MailchimpMirrorClient / SendGridMirrorClient) + mirror.go pickMirrorClient.
 */
export const MIRROR_PROVIDERS = ["mailchimp", "sendgrid"] as const;

export function providerSupportsMirror(provider: string): boolean {
  return (MIRROR_PROVIDERS as readonly string[]).includes(provider);
}

export function credentialRefValidationError(raw: string): string | null {
  const ref = raw.trim();
  if (!ref) return null;
  const lower = ref.toLowerCase();
  const looksLikeCredential = [
    "{",
    "[",
    "bearer",
    "basic",
    "sk_",
    "sg.",
    "xox",
    "eyj",
  ].some((prefix) => lower.startsWith(prefix));
  const namespaced = ref.includes("/") || lower.startsWith("cred_");
  const allowedCharacters = /^[A-Za-z0-9/_+=.@-]+$/u.test(ref);
  const validSegments = ref
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (
    ref.length > 512 ||
    /\s/u.test(ref) ||
    looksLikeCredential ||
    lower.startsWith("tenants/") ||
    !namespaced ||
    !allowedCharacters ||
    !validSegments ||
    ref.startsWith("/") ||
    ref.endsWith("/")
  ) {
    return "Use a tenant-relative runtime-secret name such as deliverability/sendgrid; do not paste an API key.";
  }
  return null;
}

export function webhookTokenValidationError(raw: string): string | null {
  const token = raw.trim();
  if (!token) return null;
  if (
    token.length < 32 ||
    token.length > 512 ||
    /\s/u.test(token) ||
    !/^[\x21-\x7e]+$/u.test(token)
  ) {
    return "Use a 32-512 character, whitespace-free high-entropy token. Generate one here instead of using a password.";
  }
  return null;
}

export function generateSecureWebhookToken(): string {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("Secure random generation is unavailable");
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Is a given config secret SET? True when the value is present and either
 * the redacted sentinel (backend hid a real value) or any other non-empty
 * string (defensive — a future backend that returns a masked tail).
 */
export function isSecretSet(
  config: Record<string, unknown> | undefined,
  key: string,
): boolean {
  if (!config) return false;
  const v = config[key];
  return typeof v === "string" && v.trim() !== "";
}

export interface ProviderSecretState {
  webhookTokenSet: boolean;
  mirrorCredentialRefSet: boolean;
  legacyApiKeySet: boolean;
}

export function providerSecretState(
  config: Record<string, unknown> | undefined,
): ProviderSecretState {
  return {
    webhookTokenSet:
      isSecretSet(config, "webhook_token_hash") ||
      isSecretSet(config, "webhook_token"),
    mirrorCredentialRefSet: isSecretSet(config, "credential_ref"),
    legacyApiKeySet: isSecretSet(config, "api_key"),
  };
}

/**
 * Build the sparse `config` payload for an upsert.
 *
 * Reads redact secrets, so the client must never echo the sentinel as if it
 * were a credential. Typed values are sent; untouched redacted values are
 * omitted. The server's `mergeProviderConfig` contract overlays these sparse
 * keys onto the stored config, which preserves every omitted secret.
 */
export function buildUpsertConfig(args: {
  existing: Record<string, unknown> | undefined;
  webhookTokenInput: string;
  credentialRefInput: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const carry = (key: string, typed: string): void => {
    const trimmed = typed.trim();
    if (trimmed) {
      out[key] = trimmed;
      return;
    }
    // Untouched: re-send only a real stored value, never the sentinel. The
    // normal redacted-read path omits this key and lets the server preserve it.
    const stored = args.existing?.[key];
    if (typeof stored === "string" && stored && stored !== REDACTED_SENTINEL) {
      out[key] = stored;
    }
  };
  carry("webhook_token", args.webhookTokenInput);
  const credentialRef = args.credentialRefInput.trim();
  if (credentialRef) out.credential_ref = credentialRef;
  return out;
}
