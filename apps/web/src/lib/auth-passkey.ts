// SPDX-License-Identifier: AGPL-3.0-only
//
// WebAuthn / passkey ceremony, split out of auth-api.ts.
//
// auth-api.ts is imported by ~148 modules for `whoami` and `effectiveAuthRole`.
// Keeping the ceremony there meant every one of those modules also pulled the
// base64url codecs, credential-descriptor decoders and PublicKeyCredential
// serialisers: the passkey module was emitted into 68 separate chunks, ~352 KiB
// of duplicated client JS, to serve two call sites (the security settings card
// and passkey sign-in). Importing from here keeps it on the routes that use it.

import { api } from "./api";

// WebAuthn / passkeys (AUTH-023)
// ---------------------------------------------------------------------------
//
// The backend speaks the standard WebAuthn JSON dialect (github.com/go-webauthn):
// challenge / credential ids travel as base64url strings, but the browser
// `navigator.credentials` API works in ArrayBuffers. These helpers translate
// both ways so no third-party runtime dependency is needed.

export interface Passkey {
  id: string;
  name: string;
  created_at: string;
  last_used_at?: string | null;
  /** True when the authenticator syncs this passkey across the user's devices. */
  backed_up: boolean;
}

export interface PasskeyRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
  /** Rebind authority after the native authenticator prompt, before finish. */
  beforeFinish?: () => Promise<void>;
}

/** True when this browser can create/use platform passkeys. */
export function passkeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.create === "function" &&
    typeof navigator.credentials?.get === "function"
  );
}

// Returns an ArrayBuffer-backed array so the result satisfies `BufferSource`
// (TS 5.7+ distinguishes Uint8Array<ArrayBuffer> from Uint8Array<ArrayBufferLike>).
function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (
    value.length === 0 ||
    value.length > 64 * 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error("Passkey ceremony returned invalid binary data.");
  }
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const base64 = (value + pad).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

interface ServerCredentialDescriptor {
  type: string;
  id: string;
  transports?: string[];
}

// The `publicKey` block the server sends for a create ceremony, with the
// base64url fields still encoded.
interface ServerCreationOptions {
  publicKey: {
    challenge: string;
    user: { id: string; name: string; displayName: string };
    excludeCredentials?: ServerCredentialDescriptor[];
    [key: string]: unknown;
  };
}

interface ServerRequestOptions {
  publicKey: {
    challenge: string;
    allowCredentials?: ServerCredentialDescriptor[];
    [key: string]: unknown;
  };
}

function decodeDescriptors(
  list: ServerCredentialDescriptor[] | undefined,
): PublicKeyCredentialDescriptor[] | undefined {
  if (!list?.length) return undefined;
  if (list.length > 1_000) {
    throw new Error("Passkey ceremony returned too many credentials.");
  }
  return list.map((d) => ({
    type: "public-key" as const,
    id: base64urlToBytes(d.id),
    transports: d.transports as AuthenticatorTransport[] | undefined,
  }));
}

// Serialize a browser PublicKeyCredential back into the WebAuthn JSON the
// server parses. Handles both attestation (register) and assertion (login)
// responses by feature-detecting the response fields.
function serializeCredential(
  cred: PublicKeyCredential,
): Record<string, unknown> {
  const response = cred.response as
    | AuthenticatorAttestationResponse
    | AuthenticatorAssertionResponse;
  const out: Record<string, unknown> = {
    id: cred.id,
    rawId: bytesToBase64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
  };
  if (cred.authenticatorAttachment) {
    out.authenticatorAttachment = cred.authenticatorAttachment;
  }
  const inner: Record<string, unknown> = {
    clientDataJSON: bytesToBase64url(response.clientDataJSON),
  };
  if ("attestationObject" in response && response.attestationObject) {
    inner.attestationObject = bytesToBase64url(response.attestationObject);
    if (typeof response.getTransports === "function") {
      const transports = response.getTransports();
      if (transports?.length) inner.transports = transports;
    }
  } else {
    const assertion = response as AuthenticatorAssertionResponse;
    inner.authenticatorData = bytesToBase64url(assertion.authenticatorData);
    inner.signature = bytesToBase64url(assertion.signature);
    inner.userHandle = assertion.userHandle
      ? bytesToBase64url(assertion.userHandle)
      : "";
  }
  out.response = inner;
  return out;
}

/**
 * Enroll a new passkey for the authenticated user. Runs the full ceremony:
 * begin (server) → navigator.credentials.create → finish (server). Throws if
 * the user cancels the platform prompt.
 */
export async function registerPasskey(
  name?: string,
  requestOptions: PasskeyRequestOptions = {},
): Promise<Passkey> {
  const serverOptions = await api.post<ServerCreationOptions>(
    "/api/v1/auth/webauthn/register/begin",
    undefined,
    passkeyMutationOptions(requestOptions),
  );
  validateCreationOptions(serverOptions);
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...(serverOptions.publicKey as unknown as PublicKeyCredentialCreationOptions),
    challenge: base64urlToBytes(serverOptions.publicKey.challenge),
    user: {
      ...serverOptions.publicKey.user,
      id: base64urlToBytes(serverOptions.publicKey.user.id),
    },
    excludeCredentials: decodeDescriptors(
      serverOptions.publicKey.excludeCredentials,
    ),
  };
  throwIfAborted(requestOptions.signal);
  const cred = (await navigator.credentials.create({
    publicKey,
    signal: requestOptions.signal,
  })) as PublicKeyCredential | null;
  throwIfAborted(requestOptions.signal);
  if (!cred) throw new Error("Passkey creation was cancelled.");
  await requestOptions.beforeFinish?.();
  throwIfAborted(requestOptions.signal);
  return parsePasskey(
    await api.post<unknown>(
      "/api/v1/auth/webauthn/register/finish",
      { name, credential: serializeCredential(cred) },
      passkeyMutationOptions(requestOptions),
    ),
  );
}

/**
 * Passwordless sign-in with a passkey (discoverable / usernameless). Runs
 * begin → navigator.credentials.get → finish; on success the session cookie is
 * set. Returns the resolved workspace so the caller can route accordingly.
 */
export async function loginWithPasskey(): Promise<{
  ok: true;
  tenant_id?: string;
  tenant_slug?: string;
}> {
  const options = await api.post<ServerRequestOptions>(
    "/api/v1/auth/webauthn/login/begin",
    undefined,
    { requireOnline: true, maxAttempts: 1, cache: "no-store" },
  );
  validateRequestOptions(options);
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...(options.publicKey as unknown as PublicKeyCredentialRequestOptions),
    challenge: base64urlToBytes(options.publicKey.challenge),
    allowCredentials: decodeDescriptors(options.publicKey.allowCredentials),
  };
  const cred = (await navigator.credentials.get({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey sign-in was cancelled.");
  return api.post<{ ok: true; tenant_id?: string; tenant_slug?: string }>(
    "/api/v1/auth/webauthn/login/finish",
    serializeCredential(cred),
    { requireOnline: true, maxAttempts: 1, cache: "no-store" },
  );
}

export async function listPasskeys(
  options: Pick<PasskeyRequestOptions, "signal"> = {},
): Promise<Passkey[]> {
  const body = await api.get<unknown>("/api/v1/auth/webauthn/credentials", {
    cache: "no-store",
    requireOnline: true,
    maxAttempts: 1,
    signal: options.signal,
  });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Passkey response was malformed.");
  }
  const items = (body as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length > 1_000) {
    throw new Error("Passkey response was malformed.");
  }
  const parsed = items.map(parsePasskey);
  if (new Set(parsed.map((passkey) => passkey.id)).size !== parsed.length) {
    throw new Error("Passkey response repeated a credential.");
  }
  return parsed;
}

export async function renamePasskey(
  id: string,
  name: string,
  options: PasskeyRequestOptions = {},
): Promise<{ ok: true; name: string }> {
  const receipt = await api.patch<unknown>(
    `/api/v1/auth/webauthn/credentials/${encodeURIComponent(id)}`,
    { name },
    passkeyMutationOptions(options),
  );
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("Passkey rename returned an invalid receipt.");
  }
  const row = receipt as Record<string, unknown>;
  if (
    row.ok !== true ||
    typeof row.name !== "string" ||
    row.name.length === 0 ||
    row.name.length > 100
  ) {
    throw new Error("Passkey rename returned an invalid receipt.");
  }
  return { ok: true, name: row.name };
}

export async function deletePasskey(
  id: string,
  options: PasskeyRequestOptions = {},
): Promise<{ ok: true }> {
  const receipt = await api.delete<unknown>(
    `/api/v1/auth/webauthn/credentials/${encodeURIComponent(id)}`,
    passkeyMutationOptions(options),
  );
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    (receipt as Record<string, unknown>).ok !== true
  ) {
    throw new Error("Passkey removal returned an invalid receipt.");
  }
  return { ok: true };
}

function passkeyMutationOptions(options: PasskeyRequestOptions) {
  return {
    cache: "no-store" as const,
    requireOnline: true,
    maxAttempts: 1,
    signal: options.signal,
    idempotencyKey: options.idempotencyKey,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Passkey operation was cancelled.", "AbortError");
}

function validateCreationOptions(value: ServerCreationOptions): void {
  if (
    !value ||
    typeof value !== "object" ||
    !value.publicKey ||
    typeof value.publicKey.challenge !== "string" ||
    !value.publicKey.user ||
    typeof value.publicKey.user.id !== "string" ||
    typeof value.publicKey.user.name !== "string" ||
    typeof value.publicKey.user.displayName !== "string"
  ) {
    throw new Error("Passkey enrollment returned invalid ceremony options.");
  }
}

function validateRequestOptions(value: ServerRequestOptions): void {
  if (
    !value ||
    typeof value !== "object" ||
    !value.publicKey ||
    typeof value.publicKey.challenge !== "string"
  ) {
    throw new Error("Passkey sign-in returned invalid ceremony options.");
  }
}

function parsePasskey(value: unknown): Passkey {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Passkey response contained an invalid credential.");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    row.id.length > 4_096 ||
    typeof row.name !== "string" ||
    row.name.length === 0 ||
    row.name.length > 100 ||
    typeof row.created_at !== "string" ||
    row.created_at.length > 128 ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    !(
      row.last_used_at === undefined ||
      row.last_used_at === null ||
      (typeof row.last_used_at === "string" &&
        row.last_used_at.length <= 128 &&
        Number.isFinite(Date.parse(row.last_used_at)))
    ) ||
    typeof row.backed_up !== "boolean"
  ) {
    throw new Error("Passkey response contained an invalid credential.");
  }
  return row as unknown as Passkey;
}
