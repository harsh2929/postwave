import { type ReactElement, useId } from "react";

import type {
  OutboundWebhookAuthConfigInput,
  OutboundWebhookAuthMetadata,
  OutboundWebhookAuthConfigStatus,
} from "../../lib/api-client";
import { Notice } from "../Notice";

export type ReceiverAuthMode =
  | "preserve"
  | "none"
  | "bearer"
  | "headers"
  | "mtls"
  | "combined";

export interface ReceiverAuthHeaderDraft {
  id: string;
  name: string;
  value: string;
}

export interface ReceiverAuthDraft {
  mode: ReceiverAuthMode;
  bearerToken: string;
  headers: ReceiverAuthHeaderDraft[];
  mtlsCertPEM: string;
  mtlsKeyPEM: string;
}

let authHeaderSequence = 0;

function newHeaderDraft(): ReceiverAuthHeaderDraft {
  authHeaderSequence += 1;
  return {
    id: `receiver-auth-header-${authHeaderSequence}`,
    name: "",
    value: "",
  };
}

export function createReceiverAuthDraft(
  mode: ReceiverAuthMode,
): ReceiverAuthDraft {
  return {
    mode,
    bearerToken: "",
    headers:
      mode === "headers" || mode === "combined" ? [newHeaderDraft()] : [],
    mtlsCertPEM: "",
    mtlsKeyPEM: "",
  };
}

export function receiverAuthDraftIsDirty(draft: ReceiverAuthDraft): boolean {
  const credentialsEntered =
    draft.bearerToken !== "" ||
    draft.headers.some((header) => header.name !== "" || header.value !== "") ||
    draft.mtlsCertPEM !== "" ||
    draft.mtlsKeyPEM !== "";
  return (
    (draft.mode !== "none" && draft.mode !== "preserve") || credentialsEntered
  );
}

const RESERVED_HEADER_NAMES = new Set(
  [
    "content-type",
    "user-agent",
    "x-postwave-signature",
    "x-postwave-key-id",
    "x-postwave-event",
    "x-postwave-event-id",
    "x-postwave-delivery",
    "x-postwave-test",
    "postwave-signature",
    "postwave-event",
    "postwave-idempotency-key",
  ].map((value) => value.toLowerCase()),
);

function selectedMethods(draft: ReceiverAuthDraft): {
  bearer: boolean;
  headers: boolean;
  mtls: boolean;
} {
  return {
    bearer: draft.mode === "bearer" || draft.mode === "combined",
    headers: draft.mode === "headers" || draft.mode === "combined",
    mtls: draft.mode === "mtls" || draft.mode === "combined",
  };
}

export function validateReceiverAuthDraft(
  draft: ReceiverAuthDraft,
): string | null {
  if (draft.mode === "preserve" || draft.mode === "none") return null;
  const methods = selectedMethods(draft);
  const bearer = draft.bearerToken.trim();
  if (methods.bearer && !bearer) {
    return "Enter the Bearer token, or choose a different receiver-auth method.";
  }
  if (methods.bearer && /[\u0000-\u001f\u007f]/u.test(`Bearer ${bearer}`)) {
    return "The Bearer token contains a character that is not valid in an HTTP header.";
  }

  const populatedHeaders = draft.headers.filter(
    (header) => header.name.trim() !== "" || header.value.trim() !== "",
  );
  if (methods.headers && populatedHeaders.length === 0) {
    return "Add at least one complete custom header, or choose a different receiver-auth method.";
  }
  if (populatedHeaders.length > 32) {
    return "Receiver authentication supports at most 32 custom headers.";
  }
  const names = new Set<string>();
  for (const header of populatedHeaders) {
    const name = header.name.trim();
    const value = header.value.trim();
    if (!name || !value) {
      return "Every custom header needs both a name and a value.";
    }
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)) {
      return `“${name}” is not a valid HTTP header name.`;
    }
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)) {
      return `“${name}” contains a value that is not valid in an HTTP header.`;
    }
    const identity = name.toLowerCase();
    if (RESERVED_HEADER_NAMES.has(identity)) {
      return `“${name}” is owned by Moosewave and cannot be replaced.`;
    }
    if (names.has(identity)) {
      return `“${name}” is configured more than once.`;
    }
    names.add(identity);
  }
  if (methods.bearer && names.has("authorization")) {
    return "Choose either the Bearer token field or a custom Authorization header, not both.";
  }

  const cert = draft.mtlsCertPEM.trim();
  const key = draft.mtlsKeyPEM.trim();
  if (methods.mtls && (!cert || !key)) {
    return "mTLS requires both the certificate chain and its private key.";
  }
  if (methods.mtls && !cert.includes("BEGIN CERTIFICATE")) {
    return "The mTLS certificate must be PEM encoded.";
  }
  if (
    methods.mtls &&
    !key.includes("BEGIN PRIVATE KEY") &&
    !key.includes("BEGIN RSA PRIVATE KEY") &&
    !key.includes("BEGIN EC PRIVATE KEY")
  ) {
    return "The mTLS private key must be PEM encoded.";
  }

  const config = buildReceiverAuthConfig(draft);
  if (
    config &&
    new TextEncoder().encode(JSON.stringify(config)).byteLength > 64 * 1024
  ) {
    return "Receiver credentials exceed the 64 KiB encrypted configuration limit.";
  }
  return null;
}

export function buildReceiverAuthConfig(
  draft: ReceiverAuthDraft,
): OutboundWebhookAuthConfigInput | null | undefined {
  if (draft.mode === "preserve") return undefined;
  if (draft.mode === "none") return null;
  const methods = selectedMethods(draft);
  const headers = Object.fromEntries(
    draft.headers
      .filter(
        (header) => header.name.trim() !== "" || header.value.trim() !== "",
      )
      .map((header) => [header.name.trim(), header.value.trim()]),
  );
  return {
    type: draft.mode,
    ...(methods.bearer ? { bearer_token: draft.bearerToken.trim() } : {}),
    ...(methods.headers ? { headers } : {}),
    ...(methods.mtls
      ? {
          mtls_cert_pem: draft.mtlsCertPEM.trim(),
          mtls_key_pem: draft.mtlsKeyPEM.trim(),
        }
      : {}),
  };
}

function configuredSummary(
  metadata: OutboundWebhookAuthMetadata | undefined,
): string {
  if (!metadata?.secret_redacted) return "No receiver authentication is set.";
  const methods: string[] = [];
  if (metadata.bearer_configured) methods.push("Bearer token");
  if ((metadata.header_names?.length ?? 0) > 0) {
    methods.push(
      `custom ${metadata.header_names!.length === 1 ? "header" : "headers"} (${metadata.header_names!.join(", ")})`,
    );
  }
  if (metadata.mtls_configured) methods.push("mTLS");
  return methods.length > 0
    ? `Currently configured: ${methods.join(" + ")}. Secret values cannot be retrieved.`
    : "Receiver authentication is configured. Secret values cannot be retrieved.";
}

export function ReceiverAuthFields({
  draft,
  onChange,
  allowPreserve = false,
  current,
  status,
  error,
}: {
  draft: ReceiverAuthDraft;
  onChange: (draft: ReceiverAuthDraft) => void;
  allowPreserve?: boolean;
  current?: OutboundWebhookAuthMetadata;
  status?: OutboundWebhookAuthConfigStatus;
  error?: string | null;
}): ReactElement {
  const fieldId = useId();
  const methods = selectedMethods(draft);
  const updateMode = (mode: ReceiverAuthMode): void => {
    const next = createReceiverAuthDraft(mode);
    onChange(next);
  };

  return (
    <fieldset className="wh-auth-fieldset">
      <legend className="field-label">Receiver authentication</legend>
      <p className="field-help" style={{ marginTop: 0 }}>
        These credentials authenticate Moosewave to your receiver. They are
        encrypted at rest, used only at delivery time, and never returned by the
        API.
      </p>
      {allowPreserve ? (
        <p className="muted small">{configuredSummary(current)}</p>
      ) : null}
      {status === "legacy_pending" ? (
        <Notice tone="warning">
          Existing credentials are awaiting encrypted migration. Choose a new
          method below to replace them now, or keep them unchanged while the
          migration worker finishes.
        </Notice>
      ) : null}
      {status === "invalid" ? (
        <Notice tone="danger">
          Existing credentials are invalid and block live delivery. Replace or
          clear them before relying on this destination.
        </Notice>
      ) : null}

      <label className="field-label" htmlFor={`${fieldId}-mode`}>
        Authentication method
      </label>
      <select
        id={`${fieldId}-mode`}
        className="select"
        value={draft.mode}
        onChange={(event) => updateMode(event.target.value as ReceiverAuthMode)}
      >
        {allowPreserve ? (
          <option value="preserve">Keep current configuration</option>
        ) : null}
        <option value="none">
          {allowPreserve ? "Clear receiver authentication" : "None"}
        </option>
        <option value="bearer">Bearer token</option>
        <option value="headers">Custom headers</option>
        <option value="mtls">mTLS certificate</option>
        <option value="combined">Bearer + headers + mTLS</option>
      </select>

      {methods.bearer ? (
        <div className="field">
          <label className="field-label" htmlFor={`${fieldId}-bearer`}>
            Bearer token
          </label>
          <input
            id={`${fieldId}-bearer`}
            className="input mono"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={16_384}
            value={draft.bearerToken}
            onChange={(event) =>
              onChange({ ...draft, bearerToken: event.target.value })
            }
            data-1p-ignore
            data-lpignore="true"
          />
          <p className="field-help">
            Moosewave sends <code>Authorization: Bearer …</code>. The value is
            write-only.
          </p>
        </div>
      ) : null}

      {methods.headers ? (
        <div className="field">
          <div className="wh-auth-header-heading">
            <span className="field-label">Custom secret headers</span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={draft.headers.length >= 32}
              onClick={() =>
                onChange({
                  ...draft,
                  headers: [...draft.headers, newHeaderDraft()],
                })
              }
            >
              Add header
            </button>
          </div>
          <div className="wh-auth-headers" role="group" aria-label="Headers">
            {draft.headers.map((header, index) => (
              <div className="wh-auth-header-row" key={header.id}>
                <label
                  className="sr-only"
                  htmlFor={`${fieldId}-${header.id}-n`}
                >
                  Header {index + 1} name
                </label>
                <input
                  id={`${fieldId}-${header.id}-n`}
                  className="input mono"
                  placeholder="X-Api-Key"
                  maxLength={256}
                  spellCheck={false}
                  value={header.name}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      headers: draft.headers.map((item) =>
                        item.id === header.id
                          ? { ...item, name: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
                <label
                  className="sr-only"
                  htmlFor={`${fieldId}-${header.id}-v`}
                >
                  Header {index + 1} secret value
                </label>
                <input
                  id={`${fieldId}-${header.id}-v`}
                  className="input mono"
                  type="password"
                  placeholder="Secret value"
                  autoComplete="new-password"
                  spellCheck={false}
                  maxLength={16_384}
                  value={header.value}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      headers: draft.headers.map((item) =>
                        item.id === header.id
                          ? { ...item, value: event.target.value }
                          : item,
                      ),
                    })
                  }
                  data-1p-ignore
                  data-lpignore="true"
                />
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  aria-label={`Remove header ${index + 1}`}
                  onClick={() =>
                    onChange({
                      ...draft,
                      headers: draft.headers.filter(
                        (item) => item.id !== header.id,
                      ),
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <p className="field-help">
            Moosewave identity and content headers are reserved. Custom
            Authorization cannot be combined with the Bearer field.
          </p>
        </div>
      ) : null}

      {methods.mtls ? (
        <div className="wh-auth-mtls-grid">
          <div className="field">
            <label className="field-label" htmlFor={`${fieldId}-cert`}>
              Certificate chain (PEM)
            </label>
            <textarea
              id={`${fieldId}-cert`}
              className="textarea mono"
              rows={6}
              spellCheck={false}
              maxLength={65_536}
              value={draft.mtlsCertPEM}
              onChange={(event) =>
                onChange({ ...draft, mtlsCertPEM: event.target.value })
              }
              data-1p-ignore
              data-lpignore="true"
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${fieldId}-key`}>
              Private key (PEM)
            </label>
            <textarea
              id={`${fieldId}-key`}
              className="textarea mono"
              rows={6}
              autoComplete="off"
              spellCheck={false}
              maxLength={65_536}
              value={draft.mtlsKeyPEM}
              onChange={(event) =>
                onChange({ ...draft, mtlsKeyPEM: event.target.value })
              }
              data-1p-ignore
              data-lpignore="true"
            />
          </div>
          <p className="field-help wh-auth-mtls-help">
            The API validates that the certificate and private key form one
            X.509 key pair before encrypting them.
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
