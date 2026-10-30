// SPDX-License-Identifier: AGPL-3.0-only
//
// SETA-056 — pure form logic for the audit-sink create/edit dialogs.
//
// This lives beside page.tsx rather than inside it because an App Router page
// module may only export `default` plus Next's fixed config exports; a named
// helper export makes the generated .next/types check fail. The logic is also
// worth isolating on its own merits: buildSinkEditInput and missingRequired
// encode the two data-loss rules below and are unit-tested directly.

import {
  SINK_FIELD_SPECS,
  type OutputFormat,
  type PatchSinkInput,
  type SinkKind,
  type WebhookFormat,
} from "@/lib/audit-sinks-api";

export interface SinkFormValue {
  name: string;
  kind: SinkKind;
  config: Record<string, string>;
  credentials: Record<string, string>;
  outputFormat: OutputFormat;
  webhookFormat: WebhookFormat;
}

// Config/credential keys the server defaults or treats as optional; everything
// else in SINK_FIELD_SPECS is required on create so an operator can't save a
// silently-broken sink (s3/datadog/splunk/http config isn't server-validated
// until the first delivery).
export const OPTIONAL_SINK_KEYS = new Set([
  "prefix",
  "index",
  "bearer_token",
  "hmac_secret",
  "site",
]);

export function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bUrl\b/, "URL")
    .replace(/\bHec\b/, "HEC")
    .replace(/\bAws\b/, "AWS")
    .replace(/\bHmac\b/, "HMAC")
    .replace(/\bId\b/, "ID");
}

/** Non-empty config/credential keys as a plain map for the API body. */
export function collectFilled(
  map: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v.trim() !== "") out[k] = v.trim();
  }
  return out;
}

/**
 * Build the PATCH body for a sink edit. CRITICAL: the backend REPLACES the
 * whole config + credentials envelopes, so we omit config for kinds without a
 * flat form spec (archive/snowflake_shareback — else their nested config is
 * wiped) and omit credentials entirely unless the operator entered some.
 */
export function buildSinkEditInput(form: SinkFormValue): PatchSinkInput {
  const input: PatchSinkInput = {
    name: form.name.trim(),
    output_format: form.outputFormat,
    webhook_format: form.webhookFormat,
  };
  if (SINK_FIELD_SPECS[form.kind].config.length > 0) {
    input.config = collectFilled(form.config);
  }
  const creds = collectFilled(form.credentials);
  if (Object.keys(creds).length > 0) input.credentials = creds;
  return input;
}

/** Whether an edit would be a semantic no-op after API normalization. */
export function sinkEditIsUnchanged(
  current: SinkFormValue,
  initial: SinkFormValue,
): boolean {
  if (Object.keys(collectFilled(current.credentials)).length > 0) return false;
  const normalizeMap = (value: Record<string, string>) =>
    Object.entries(collectFilled(value)).sort(([left], [right]) =>
      left.localeCompare(right),
    );
  return (
    current.name.trim() === initial.name.trim() &&
    current.kind === initial.kind &&
    current.outputFormat === initial.outputFormat &&
    current.webhookFormat === initial.webhookFormat &&
    JSON.stringify(normalizeMap(current.config)) ===
      JSON.stringify(normalizeMap(initial.config))
  );
}

/** Client-side required-field check mirroring the Go validators. */
export function missingRequired(
  value: SinkFormValue,
  isEdit: boolean,
): string | null {
  if (value.name.trim() === "") return "Name is required.";
  const spec = SINK_FIELD_SPECS[value.kind];
  for (const key of spec.config) {
    if (!OPTIONAL_SINK_KEYS.has(key) && !(value.config[key] ?? "").trim()) {
      return `${humanizeKey(key)} is required for a ${value.kind} sink.`;
    }
  }
  if (!isEdit) {
    for (const key of spec.credentials) {
      if (
        !OPTIONAL_SINK_KEYS.has(key) &&
        !(value.credentials[key] ?? "").trim()
      ) {
        return `${humanizeKey(key)} is required for a ${value.kind} sink.`;
      }
    }
  } else if (Object.keys(collectFilled(value.credentials)).length > 0) {
    // The backend REPLACES the entire credential envelope on PATCH — a partial
    // entry would erase the untouched secrets. If the operator is rotating any
    // credential, require the full required set so nothing is silently wiped.
    for (const key of spec.credentials) {
      if (
        !OPTIONAL_SINK_KEYS.has(key) &&
        !(value.credentials[key] ?? "").trim()
      ) {
        return "To change a credential you must re-enter the complete set — saving replaces the entire credential envelope.";
      }
    }
  }
  return null;
}
