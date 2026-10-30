// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Receiver-authentication editor for an outbound destination.
 *
 * The credentials the operator types here are write-only: reads answer with a
 * value-free projection (`auth_config` metadata), never the secret. That is
 * why the edit dialog opens in `preserve` mode — an empty field must mean
 * "leave what is stored alone", not "clear it", and only an explicit `none`
 * clears the stored credentials.
 *
 * Validation mirrors apps/desktop/src/components/webhooks/ReceiverAuthFields
 * so an input the server would reject is refused before the request is sent,
 * with the same sentence on both clients.
 */

import { useId } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import type {
  OutboundWebhookAuthConfigInput,
  OutboundWebhookAuthMetadata,
} from "@/lib/outbound-webhooks-api";

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
  return { id: `receiver-auth-header-${authHeaderSequence}`, name: "", value: "" };
}

export function createReceiverAuthDraft(
  mode: ReceiverAuthMode,
): ReceiverAuthDraft {
  return {
    mode,
    bearerToken: "",
    headers: mode === "headers" || mode === "combined" ? [newHeaderDraft()] : [],
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

/** Headers Moosewave owns on every delivery; a receiver cannot replace them. */
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

/**
 * `undefined` = omit the field entirely (preserve what is stored);
 * `null` = send `auth_config: null`, which clears the stored credentials.
 */
export function buildReceiverAuthConfig(
  draft: ReceiverAuthDraft,
): OutboundWebhookAuthConfigInput | null | undefined {
  if (draft.mode === "preserve") return undefined;
  if (draft.mode === "none") return null;
  const methods = selectedMethods(draft);
  const headers = Object.fromEntries(
    draft.headers
      .filter((header) => header.name.trim() !== "" || header.value.trim() !== "")
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

export function receiverAuthSummary(
  metadata: OutboundWebhookAuthMetadata | undefined,
): string {
  if (!metadata?.secret_redacted) return "No receiver authentication is set.";
  const methods: string[] = [];
  if (metadata.bearer_configured) methods.push("Bearer token");
  const headerNames = metadata.header_names ?? [];
  if (headerNames.length > 0) {
    methods.push(
      `custom ${headerNames.length === 1 ? "header" : "headers"} (${headerNames.join(", ")})`,
    );
  }
  if (metadata.mtls_configured) methods.push("mTLS");
  return methods.length > 0
    ? `Currently configured: ${methods.join(" + ")}. Secret values cannot be retrieved.`
    : "Receiver authentication is configured. Secret values cannot be retrieved.";
}

const MODE_LABELS: Array<{ value: ReceiverAuthMode; label: string }> = [
  { value: "preserve", label: "Keep what is stored" },
  { value: "none", label: "None — clear stored credentials" },
  { value: "bearer", label: "Bearer token" },
  { value: "headers", label: "Custom headers" },
  { value: "mtls", label: "Mutual TLS (client certificate)" },
  { value: "combined", label: "Bearer + headers + mTLS" },
];

export function ReceiverAuthFields({
  draft,
  onChange,
  metadata,
  disabled,
  allowPreserve,
  error,
}: {
  draft: ReceiverAuthDraft;
  onChange: (draft: ReceiverAuthDraft) => void;
  /** The value-free projection a read returned, if this destination exists. */
  metadata?: OutboundWebhookAuthMetadata;
  disabled?: boolean;
  /** Only the edit dialog can preserve; a create has nothing to preserve. */
  allowPreserve?: boolean;
  error?: string | null;
}) {
  const id = useId();
  const methods = selectedMethods(draft);
  const options = MODE_LABELS.filter(
    (option) => allowPreserve || option.value !== "preserve",
  );
  return (
    <fieldset className="space-y-3 rounded-lg border p-4" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">Receiver authentication</legend>
      <p className="text-xs text-muted-foreground">
        {receiverAuthSummary(metadata)}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-mode`}>Method</Label>
        <Select
          id={`${id}-mode`}
          value={draft.mode}
          onChange={(event) => {
            const mode = event.target.value as ReceiverAuthMode;
            onChange({
              ...createReceiverAuthDraft(mode),
              bearerToken: draft.bearerToken,
              headers:
                mode === "headers" || mode === "combined"
                  ? draft.headers.length > 0
                    ? draft.headers
                    : [newHeaderDraft()]
                  : draft.headers,
              mtlsCertPEM: draft.mtlsCertPEM,
              mtlsKeyPEM: draft.mtlsKeyPEM,
            });
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      {methods.bearer ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-bearer`}>Bearer token</Label>
          <Input
            id={`${id}-bearer`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft.bearerToken}
            onChange={(event) =>
              onChange({ ...draft, bearerToken: event.target.value })
            }
          />
        </div>
      ) : null}

      {methods.headers ? (
        <div className="space-y-2">
          <span className="text-sm font-medium">Custom headers</span>
          {draft.headers.map((header, index) => (
            <div key={header.id} className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor={`${id}-header-name-${header.id}`}>
                  Header {index + 1} name
                </Label>
                <Input
                  id={`${id}-header-name-${header.id}`}
                  value={header.name}
                  autoComplete="off"
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      headers: draft.headers.map((row) =>
                        row.id === header.id
                          ? { ...row, name: event.target.value }
                          : row,
                      ),
                    })
                  }
                />
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor={`${id}-header-value-${header.id}`}>
                  Header {index + 1} value
                </Label>
                <Input
                  id={`${id}-header-value-${header.id}`}
                  type="password"
                  autoComplete="off"
                  value={header.value}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      headers: draft.headers.map((row) =>
                        row.id === header.id
                          ? { ...row, value: event.target.value }
                          : row,
                      ),
                    })
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove custom header ${index + 1}`}
                onClick={() =>
                  onChange({
                    ...draft,
                    headers: draft.headers.filter((row) => row.id !== header.id),
                  })
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange({ ...draft, headers: [...draft.headers, newHeaderDraft()] })
            }
          >
            Add header
          </Button>
        </div>
      ) : null}

      {methods.mtls ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-cert`}>Client certificate (PEM)</Label>
            <Textarea
              id={`${id}-cert`}
              rows={4}
              spellCheck={false}
              value={draft.mtlsCertPEM}
              onChange={(event) =>
                onChange({ ...draft, mtlsCertPEM: event.target.value })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-key`}>Client private key (PEM)</Label>
            <Textarea
              id={`${id}-key`}
              rows={4}
              spellCheck={false}
              value={draft.mtlsKeyPEM}
              onChange={(event) =>
                onChange({ ...draft, mtlsKeyPEM: event.target.value })
              }
            />
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive-emphasis" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
