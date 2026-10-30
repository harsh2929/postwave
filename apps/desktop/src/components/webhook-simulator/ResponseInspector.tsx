/**
 * ResponseInspector — replaces the bare response panel with three
 * tabs and two extra affordances:
 *
 *   1. Body tab     — the upstream's response body (existing)
 *   2. Headers tab  — every request header postwave sent (new)
 *   3. cURL tab     — a copy-pasteable, credential-redacted scaffold
 *                     containing the request signature + body. Receiver
 *                     credentials must be added through an approved local
 *                     secret workflow and are never revealed here.
 *
 * When the response indicates a delivery failure (status >= 400 or
 * any error string), we additionally render the platform's retry
 * schedule so the operator knows what would happen in production.
 */

import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  clipboardSuccessDetail,
  writeClipboardText,
} from "../../lib/clipboard";
import { toast } from "../Toast";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";

export interface FireResponse {
  fire_id?: string;
  event_id?: string;
  delivery_id?: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signature: string;
  requested_at: string;
  status_code: number;
  response_body: string;
  latency_ms: number;
  error?: string;
  filtered?: boolean;
  outcome?: "filtered" | "receiver_responded" | "transport_ambiguous";
  ambiguous?: boolean;
  response_body_truncated?: boolean;
  redacted_header_count?: number;
  redacted_response_count?: number;
  redacted_url_count?: number;
  redacted_body_count?: number;
}

// Mirrors apps/api/internal/outbound_webhooks/playground.go::BackoffSchedule.
const RETRY_SCHEDULE = ["30s", "5m", "30m", "2h", "8h", "24h", "24h"];

type Tab = "body" | "headers" | "curl";
const INSPECTOR_TABS = [
  { value: "body" },
  { value: "headers" },
  { value: "curl" },
] as const;

interface Props {
  response: FireResponse;
}

export const REDACTED_WEBHOOK_VALUE = "[REDACTED]";

const SAFE_REQUEST_AUTH_PROTOCOL_HEADERS = new Set([
  "x-postwave-signature",
  "postwave-signature",
]);

function normalizedCredentialName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[_.\s]+/g, "-");
}

export function isSensitiveInspectableHeaderName(name: string): boolean {
  const normalized = normalizedCredentialName(name);
  if (SAFE_REQUEST_AUTH_PROTOCOL_HEADERS.has(normalized)) return false;
  if (
    [
      "authorization",
      "proxy-authorization",
      "cookie",
      "set-cookie",
      "authentication-info",
      "key",
      "sig",
    ].includes(normalized)
  ) {
    return true;
  }
  if (normalized.includes("api-key") || normalized.includes("apikey")) {
    return true;
  }
  const joined = normalized.replace(/[^a-z]/g, "");
  if (
    [
      "authorization",
      "authentication",
      "authtoken",
      "accesstoken",
      "refreshtoken",
      "sessiontoken",
      "clientsecret",
      "apikey",
      "password",
      "credential",
      "cookie",
      "signature",
      "hmac",
    ].some((marker) => joined.includes(marker))
  ) {
    return true;
  }
  return normalized
    .split(/[^a-z]+/)
    .some((part) =>
      [
        "auth",
        "authorization",
        "token",
        "secret",
        "password",
        "credential",
        "cookie",
        "signature",
        "hmac",
      ].includes(part),
    );
}

export function isCredentialLikeInspectableValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === REDACTED_WEBHOOK_VALUE.toLowerCase()) return true;
  if (
    [
      "bearer ",
      "basic ",
      "digest ",
      "token ",
      "ghp_",
      "github_pat_",
      "xoxb-",
      "xoxp-",
      "xoxa-",
      "sk_live_",
      "sk_test_",
      "rk_live_",
      "rk_test_",
      "whsec_",
      "glpat-",
      "npm_",
      "akia",
      "asia",
      "-----begin private key-----",
      "-----begin rsa private key-----",
    ].some((prefix) => normalized.startsWith(prefix))
  ) {
    return true;
  }
  if (
    [
      "api_key=",
      "api-key=",
      "access_token=",
      "refresh_token=",
      "client_secret=",
      "password=",
      "session_token=",
      "token=",
      "secret=",
    ].some((marker) => normalized.includes(marker))
  ) {
    return true;
  }
  return normalized.startsWith("eyj") && normalized.split(".").length === 3;
}

const CREDENTIAL_TEXT_PATTERNS = [
  /\b(?:Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:ghp_|github_pat_|xox[bpa]-|sk_(?:live|test)_|rk_(?:live|test)_|whsec_|glpat-|npm_)[A-Za-z0-9._~-]+/giu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/gu,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|session[_-]?token|auth(?:orization)?|token|secret|credential|cookie|signature|hmac)\s*[:=]\s*["']?[^\s&"',;}]+/giu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
];
const URL_IN_TEXT_PATTERN = /\bhttps?:\/\/[^\s<>"']+/giu;

function redactCredentialPatterns(raw: string): {
  text: string;
  redactedCount: number;
} {
  let text = raw;
  let redactedCount = 0;
  for (const pattern of CREDENTIAL_TEXT_PATTERNS) {
    text = text.replace(pattern, () => {
      redactedCount += 1;
      return REDACTED_WEBHOOK_VALUE;
    });
  }
  return { text, redactedCount };
}

export function sanitizeInspectableText(raw: string): {
  text: string;
  redactedCount: number;
} {
  if (raw === REDACTED_WEBHOOK_VALUE) {
    return { text: raw, redactedCount: 1 };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const sanitized = sanitizeInspectableBody(parsed);
    if (sanitized.redactedCount > 0) {
      return {
        text: JSON.stringify(sanitized.body, null, 2),
        redactedCount: sanitized.redactedCount,
      };
    }
  } catch {
    // Non-JSON receiver output is scrubbed with credential-shape patterns.
  }
  const credentialSafe = redactCredentialPatterns(raw);
  let redactedCount = credentialSafe.redactedCount;
  const text = credentialSafe.text.replace(URL_IN_TEXT_PATTERN, (url) => {
    const sanitized = sanitizeInspectableUrl(url);
    redactedCount += sanitized.redactedCount;
    return sanitized.url;
  });
  return { text, redactedCount };
}

export interface SanitizedWebhookHeaders {
  headers: Record<string, string>;
  redactedCount: number;
}

export function sanitizeInspectableHeaders(
  headers: Record<string, string> | null | undefined,
): SanitizedWebhookHeaders {
  const sanitized = Object.create(null) as Record<string, string>;
  let redactedCount = 0;
  for (const [name, rawValue] of Object.entries(headers ?? {})) {
    const value = typeof rawValue === "string" ? rawValue : String(rawValue);
    const shapedValue = redactCredentialPatterns(value);
    if (
      isSensitiveInspectableHeaderName(name) ||
      isCredentialLikeInspectableValue(value) ||
      shapedValue.redactedCount > 0
    ) {
      sanitized[name] = REDACTED_WEBHOOK_VALUE;
      redactedCount += 1;
    } else {
      sanitized[name] = value;
    }
  }
  return { headers: sanitized, redactedCount };
}

export function sanitizeInspectableUrl(raw: string): {
  url: string;
  redactedCount: number;
} {
  try {
    const parsed = new URL(raw);
    let redactedCount = 0;
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { url: REDACTED_WEBHOOK_VALUE, redactedCount: 1 };
    }
    if (parsed.username || parsed.password) {
      parsed.username = REDACTED_WEBHOOK_VALUE;
      parsed.password = REDACTED_WEBHOOK_VALUE;
      redactedCount += 1;
    }
    let decodedPath = parsed.pathname;
    try {
      decodedPath = decodeURIComponent(decodedPath);
    } catch {
      // Keep the URL parser's normalized path when percent decoding fails.
    }
    const sanitizedPath = sanitizeInspectableText(decodedPath);
    if (sanitizedPath.redactedCount > 0) {
      parsed.pathname = sanitizedPath.text;
      redactedCount += sanitizedPath.redactedCount;
    }
    for (const name of new Set(parsed.searchParams.keys())) {
      const values = parsed.searchParams.getAll(name);
      if (
        isSensitiveInspectableHeaderName(name) ||
        values.some(
          (value) =>
            isCredentialLikeInspectableValue(value) ||
            redactCredentialPatterns(value).redactedCount > 0,
        )
      ) {
        parsed.searchParams.delete(name);
        parsed.searchParams.set(name, REDACTED_WEBHOOK_VALUE);
        redactedCount += 1;
      }
    }
    let fragment = parsed.hash.slice(1);
    try {
      fragment = decodeURIComponent(fragment);
    } catch {
      // Keep the URL parser's normalized fragment when decoding fails.
    }
    const sanitizedFragment = sanitizeInspectableText(fragment);
    if (
      fragment &&
      (sanitizedFragment.redactedCount > 0 ||
        isCredentialLikeInspectableValue(fragment) ||
        fragment
          .split(/[&=]/)
          .some((part) => isSensitiveInspectableHeaderName(part)))
    ) {
      parsed.hash = REDACTED_WEBHOOK_VALUE;
      redactedCount += Math.max(1, sanitizedFragment.redactedCount);
    }
    return { url: parsed.toString(), redactedCount };
  } catch {
    // Do not re-enter sanitizeInspectableText here: it detects URL-shaped
    // tokens and delegates back to this function. A malformed URL therefore
    // must terminate at this boundary and be withheld fail-closed.
    const credentialSafe = redactCredentialPatterns(raw);
    if (credentialSafe.redactedCount > 0) {
      return {
        url: credentialSafe.text,
        redactedCount: credentialSafe.redactedCount,
      };
    }
    return { url: REDACTED_WEBHOOK_VALUE, redactedCount: 1 };
  }
}

export interface SanitizedWebhookBody {
  body: unknown;
  redactedCount: number;
}

export function sanitizeInspectableBody(body: unknown): SanitizedWebhookBody {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): SanitizedWebhookBody => {
    if (typeof value === "string") {
      const sanitizedText = redactCredentialPatterns(value);
      if (sanitizedText.redactedCount > 0) {
        return {
          body: sanitizedText.text,
          redactedCount: sanitizedText.redactedCount,
        };
      }
      return isCredentialLikeInspectableValue(value)
        ? { body: REDACTED_WEBHOOK_VALUE, redactedCount: 1 }
        : { body: value, redactedCount: 0 };
    }
    if (!value || typeof value !== "object") {
      return { body: value, redactedCount: 0 };
    }
    if (seen.has(value)) {
      return { body: REDACTED_WEBHOOK_VALUE, redactedCount: 1 };
    }
    seen.add(value);
    if (Array.isArray(value)) {
      let redactedCount = 0;
      const items = value.map((item) => {
        const result = visit(item);
        redactedCount += result.redactedCount;
        return result.body;
      });
      return { body: items, redactedCount };
    }
    let redactedCount = 0;
    const result = Object.create(null) as Record<string, unknown>;
    for (const [name, item] of Object.entries(value)) {
      if (isSensitiveInspectableHeaderName(name)) {
        result[name] = REDACTED_WEBHOOK_VALUE;
        redactedCount += 1;
        continue;
      }
      const sanitized = visit(item);
      result[name] = sanitized.body;
      redactedCount += sanitized.redactedCount;
    }
    return { body: result, redactedCount };
  };
  return visit(body);
}

function shellEscape(s: string): string {
  // POSIX-safe: wrap in single quotes, escape any embedded single quote
  // via the standard "'\''" idiom.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildSafeCurl(r: FireResponse): string {
  const sanitizedHeaders = sanitizeInspectableHeaders(r.headers).headers;
  const sanitizedBody = sanitizeInspectableBody(r.body).body;
  const method = /^[A-Z]+$/.test(r.method ?? "") ? r.method : "POST";
  // Never combine a live destination, captured signature, and request body in
  // one executable command. This is intentionally a verification scaffold:
  // the operator must supply an isolated receiver URL and regenerate a fresh
  // signature for the exact bytes they choose to send.
  const parts: string[] = [
    `curl -X ${method} ${shellEscape("https://YOUR_RECEIVER.example/postwave-webhook")}`,
  ];
  for (const [k, v] of Object.entries(sanitizedHeaders)) {
    const value = SAFE_REQUEST_AUTH_PROTOCOL_HEADERS.has(
      normalizedCredentialName(k),
    )
      ? "REGENERATE_SIGNATURE_FOR_THE_EXACT_BODY"
      : v;
    parts.push(`  -H ${shellEscape(`${k}: ${value}`)}`);
  }
  // Body — JSON-stringify the parsed object so the curl looks like
  // what the operator would actually send.
  let bodyStr: string;
  try {
    bodyStr =
      typeof sanitizedBody === "string"
        ? sanitizedBody
        : JSON.stringify(sanitizedBody ?? {}, null, 2);
  } catch {
    bodyStr = JSON.stringify({
      omitted: "Request body couldn't be represented safely.",
    });
  }
  parts.push(`  --data-raw ${shellEscape(bodyStr)}`);
  return parts.join(" \\\n");
}

function InspectorMetadata({
  error,
  signature,
}: {
  error: string | null;
  signature: string;
}): ReactElement {
  return (
    <>
      {error ? (
        <div
          style={{
            fontSize: 12,
            color: "var(--pw-fg)",
            background: "color-mix(in srgb, var(--pw-danger) 8%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--pw-danger) 28%, transparent)",
            padding: "8px 10px",
            borderRadius: 4,
          }}
        >
          {error}
        </div>
      ) : null}
      <div
        className="muted"
        style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}
      >
        Signature:{" "}
        <code
          style={{
            fontSize: 10,
            background: "var(--pw-bg-elev-2)",
            padding: "2px 6px",
            borderRadius: 3,
            wordBreak: "break-all",
          }}
        >
          {signature}
        </code>
      </div>
    </>
  );
}

interface RedactionNoticeProps {
  headerCount: number;
  responseCount: number;
  urlCount: number;
  bodyCount: number;
}

function CredentialRedactionNotice({
  headerCount,
  responseCount,
  urlCount,
  bodyCount,
}: RedactionNoticeProps): ReactElement | null {
  if (headerCount + responseCount + urlCount + bodyCount === 0) return null;
  return (
    <div className="notice" role="status">
      <span>
        {headerCount > 0 ? (
          <>
            <strong>
              {headerCount.toLocaleString()} credential-bearing header
              {headerCount === 1 ? "" : "s"} redacted.
            </strong>{" "}
            Header values stay redacted in this inspector and in the copied cURL
            command. Add receiver credentials only inside your approved local
            secret workflow; Moosewave does not provide a reveal action.
          </>
        ) : null}
        {urlCount > 0
          ? ` ${urlCount} sensitive URL detail${urlCount === 1 ? " was" : "s were"} also redacted from cURL.`
          : ""}
        {responseCount > 0
          ? ` Moosewave removed ${responseCount} echoed credential value${responseCount === 1 ? "" : "s"} from receiver output.`
          : ""}
        {bodyCount > 0
          ? ` ${bodyCount} sensitive request-body field${bodyCount === 1 ? " was" : "s were"} replaced in the safe cURL scaffold, so its request signature must be regenerated before use.`
          : ""}
      </span>
    </div>
  );
}

function RetryScheduleNotice(): ReactElement {
  return (
    <div
      style={{
        fontSize: 11,
        background: "color-mix(in srgb, var(--pw-warning) 8%, transparent)",
        border:
          "1px solid color-mix(in srgb, var(--pw-warning) 28%, transparent)",
        padding: "8px 10px",
        borderRadius: 4,
        color: "var(--pw-fg)",
      }}
    >
      <div style={{ fontWeight: 500, marginBottom: 4 }}>
        Production retry schedule
      </div>
      <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>
        This simulator fire is never retried automatically. For comparison, an
        equivalent event admitted to the production outbox can retry up to 7
        times before giving up. Its configured next attempts are:{" "}
        <span
          className="tabular"
          style={{
            fontFamily:
              "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          }}
        >
          {RETRY_SCHEDULE.join(" · ")}
        </span>
        . Auto-disables after 100 consecutive failures.
      </div>
    </div>
  );
}

function responseStatusColor(response: FireResponse): string {
  if (response.ambiguous) return "var(--pw-danger)";
  if (response.filtered) return "var(--pw-info, var(--pw-accent))";
  if (response.error) return "var(--pw-danger)";
  if (response.status_code >= 200 && response.status_code < 300) {
    return "var(--pw-success)";
  }
  if (response.status_code >= 400) return "var(--pw-warning)";
  return "var(--pw-fg-muted)";
}

function inspectableJSON(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "The evaluated request body could not be represented safely.";
  }
}

function FilteredOutcome({ body }: { body: unknown }): ReactElement {
  return (
    <>
      <div className="notice" role="status">
        <strong>Filtered before delivery.</strong> The destination policy did
        not match this event, so Moosewave made no receiver request and produced
        no signature, receiver response, or retry.
      </div>
      <div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          Evaluated event body
        </div>
        <pre
          style={{
            background: "var(--pw-bg-elev-2)",
            padding: 10,
            borderRadius: 4,
            fontSize: 11,
            margin: 0,
            maxHeight: 240,
            overflow: "auto",
            fontFamily:
              "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            color: "var(--pw-fg)",
          }}
        >
          <code>{inspectableJSON(body)}</code>
        </pre>
      </div>
    </>
  );
}

interface InspectionModel {
  headers: SanitizedWebhookHeaders;
  body: SanitizedWebhookBody;
  responseBody: { text: string; redactedCount: number };
  error: { text: string; redactedCount: number } | null;
  signature: { text: string; redactedCount: number };
  curl: string;
  redactedHeaderCount: number;
  redactedResponseCount: number;
  redactedUrlCount: number;
  redactedBodyCount: number;
}

function useInspectionModel(response: FireResponse): InspectionModel {
  const headers = useMemo(
    () => sanitizeInspectableHeaders(response.headers),
    [response.headers],
  );
  const url = useMemo(
    () => sanitizeInspectableUrl(response.url),
    [response.url],
  );
  const body = useMemo(
    () => sanitizeInspectableBody(response.body),
    [response.body],
  );
  const responseBody = useMemo(
    () => sanitizeInspectableText(response.response_body),
    [response.response_body],
  );
  const error = useMemo(
    () => (response.error ? sanitizeInspectableText(response.error) : null),
    [response.error],
  );
  const signature = useMemo(
    () => sanitizeInspectableText(response.signature),
    [response.signature],
  );
  const curl = useMemo(() => buildSafeCurl(response), [response]);
  return {
    headers,
    body,
    responseBody,
    error,
    signature,
    curl,
    redactedHeaderCount: Math.max(
      headers.redactedCount,
      response.redacted_header_count ?? 0,
    ),
    redactedResponseCount: Math.max(
      responseBody.redactedCount +
        (error?.redactedCount ?? 0) +
        signature.redactedCount,
      response.redacted_response_count ?? 0,
    ),
    redactedUrlCount: Math.max(
      url.redactedCount,
      response.redacted_url_count ?? 0,
    ),
    redactedBodyCount: Math.max(
      body.redactedCount,
      response.redacted_body_count ?? 0,
    ),
  };
}

interface CurlCopyState {
  copied: boolean;
  copying: boolean;
  copy: () => Promise<void>;
}

function useCurlCopy(curl: string): CurlCopyState {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const copyFlightRef = useRef<Promise<void> | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copyFlightRef.current = null;
    };
  }, []);
  function copy(): Promise<void> {
    if (copyFlightRef.current) return copyFlightRef.current;
    setCopying(true);
    const request = (async (): Promise<void> => {
      try {
        const result = await writeClipboardText(curl, {
          contentClass: "secret",
          label: "Redacted signed webhook cURL command",
          clearIfUnchangedAfterMs: 60_000,
        });
        if (!activeRef.current) return;
        if (result.ok) {
          setCopied(true);
          if (copiedTimerRef.current !== null) {
            window.clearTimeout(copiedTimerRef.current);
          }
          copiedTimerRef.current = window.setTimeout(() => {
            setCopied(false);
            copiedTimerRef.current = null;
          }, 1500);
          toast.success({
            message: "Safe cURL command copied",
            detail: clipboardSuccessDetail(result),
          });
        } else toast.error(result.message);
      } catch {
        if (activeRef.current) {
          toast.error(
            "The safe cURL command wasn't copied. Focus Moosewave and try again.",
          );
        }
      } finally {
        if (activeRef.current) setCopying(false);
      }
    })();
    copyFlightRef.current = request;
    void request.finally(() => {
      if (copyFlightRef.current === request) copyFlightRef.current = null;
    });
    return request;
  }
  return { copied, copying, copy };
}

type InspectorTabs = ReturnType<typeof useTabsInteraction<Tab>>;

function InspectorHeading({
  response,
  tab,
  tabs,
}: {
  response: FireResponse;
  tab?: Tab;
  tabs?: InspectorTabs;
}): ReactElement {
  const statusColor = responseStatusColor(response);
  const statusLabel = response.filtered
    ? "FILTERED"
    : response.ambiguous
      ? "AMBIGUOUS"
      : response.error
        ? "ERR"
        : response.status_code;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      <div
        className="section-title"
        style={{
          flex: 1,
          marginBottom: 0,
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <span>Response</span>
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            background: `color-mix(in srgb, ${statusColor} 14%, transparent)`,
            color: statusColor,
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {statusLabel}
        </span>
        {!response.filtered ? (
          <span
            className="muted tabular"
            style={{ fontSize: 11, fontWeight: 400 }}
          >
            {response.latency_ms}ms
          </span>
        ) : null}
      </div>
      {tabs && tab ? <InspectorTabList tab={tab} tabs={tabs} /> : null}
    </div>
  );
}

function InspectorTabList({
  tab,
  tabs,
}: {
  tab: Tab;
  tabs: InspectorTabs;
}): ReactElement {
  return (
    <div
      ref={tabs.listRef}
      {...tabs.listProps}
      aria-label="Inspector tab"
      style={{ display: "flex", gap: 4 }}
    >
      {(["body", "headers", "curl"] as Tab[]).map((candidate) => {
        const selected = tab === candidate;
        return (
          <button
            key={candidate}
            type="button"
            {...tabs.getTabProps(candidate)}
            style={{
              padding: "4px 10px",
              background: selected
                ? "color-mix(in srgb, var(--pw-accent) 14%, transparent)"
                : "var(--pw-bg-elev-2)",
              border: "1px solid",
              borderColor: selected ? "var(--pw-accent)" : "var(--pw-border)",
              borderRadius: 4,
              color: selected ? "var(--pw-fg)" : "var(--pw-fg-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: selected ? 600 : 500,
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            {candidate}
          </button>
        );
      })}
    </div>
  );
}

function ResponseBodyPanel({
  tabs,
  text,
}: {
  tabs: InspectorTabs;
  text: string;
}): ReactElement {
  return (
    <pre
      {...tabs.getPanelProps("body")}
      style={{
        background: "var(--pw-bg-elev-2)",
        padding: 10,
        borderRadius: 4,
        fontSize: 11,
        margin: 0,
        maxHeight: 240,
        overflow: "auto",
        fontFamily:
          "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        color: "var(--pw-fg)",
      }}
    >
      <code>{text || "(empty response body)"}</code>
    </pre>
  );
}

function HeadersPanel({
  tabs,
  active,
  headers,
}: {
  tabs: InspectorTabs;
  active: boolean;
  headers: Record<string, string>;
}): ReactElement {
  const entries = Object.entries(headers);
  return (
    <div
      {...tabs.getPanelProps("headers")}
      style={{
        display: active ? "flex" : "none",
        flexDirection: "column",
        gap: 2,
        background: "var(--pw-bg-elev-2)",
        padding: 10,
        borderRadius: 4,
        fontSize: 11,
        maxHeight: 240,
        overflow: "auto",
        fontFamily:
          "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      }}
    >
      {entries.map(([name, value]) => (
        <div
          key={name}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(140px, auto) 1fr",
            gap: 8,
            wordBreak: "break-all",
          }}
        >
          <span style={{ color: "var(--pw-fg-muted)" }}>{name}</span>
          <span style={{ color: "var(--pw-fg)" }}>{value}</span>
        </div>
      ))}
      {entries.length === 0 ? (
        <span className="muted">(no headers captured)</span>
      ) : null}
    </div>
  );
}

function CurlPanel({
  tabs,
  active,
  curl,
  copyState,
}: {
  tabs: InspectorTabs;
  active: boolean;
  curl: string;
  copyState: CurlCopyState;
}): ReactElement {
  return (
    <div
      {...tabs.getPanelProps("curl")}
      style={{
        display: active ? "flex" : "none",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <pre
        style={{
          background: "var(--pw-bg-elev-2)",
          padding: 10,
          borderRadius: 4,
          fontSize: 11,
          margin: 0,
          maxHeight: 240,
          overflow: "auto",
          fontFamily:
            "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          color: "var(--pw-fg)",
          whiteSpace: "pre",
        }}
      >
        <code>{curl}</code>
      </pre>
      <p className="muted small" style={{ margin: 0 }}>
        Non-executable verification scaffold: the live destination and captured
        signature are deliberately withheld. Use an isolated receiver and
        regenerate the signature for the exact body.
      </p>
      <div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => void copyState.copy()}
          aria-disabled={copyState.copying ? "true" : "false"}
          aria-busy={copyState.copying ? "true" : undefined}
        >
          {copyState.copying
            ? "Copying…"
            : copyState.copied
              ? "✓ Copied safely"
              : "Copy safe curl"}
        </button>
      </div>
    </div>
  );
}

function InspectorCard({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      className="card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 12,
      }}
    >
      {children}
    </div>
  );
}

function DeliveredInspector({
  response,
  inspection,
  copyState,
}: {
  response: FireResponse;
  inspection: InspectionModel;
  copyState: CurlCopyState;
}): ReactElement {
  const [tab, setTab] = useState<Tab>("body");
  const tabs = useTabsInteraction({
    value: tab,
    items: INSPECTOR_TABS,
    onChange: setTab,
  });
  const isFailure =
    !!response.error ||
    response.status_code === 0 ||
    response.status_code >= 400;
  return (
    <InspectorCard>
      <InspectorHeading response={response} tab={tab} tabs={tabs} />
      {response.ambiguous ? (
        <div className="field-error" role="alert">
          No receiver status was observed. This is not proof of failure: the
          receiver may already have processed fire{" "}
          {response.fire_id ?? "(ID unavailable)"}.
        </div>
      ) : null}
      {response.response_body_truncated ? (
        <div className="notice" role="status">
          The receiver body exceeded the inspection limit. Its partial content
          is withheld so a cut-through secret or malformed JSON cannot leak.
        </div>
      ) : null}
      <InspectorMetadata
        error={inspection.error?.text ?? null}
        signature={inspection.signature.text}
      />
      <InspectionRedactionNotice inspection={inspection} />
      <ResponseBodyPanel tabs={tabs} text={inspection.responseBody.text} />
      <HeadersPanel
        tabs={tabs}
        active={tab === "headers"}
        headers={inspection.headers.headers}
      />
      <CurlPanel
        tabs={tabs}
        active={tab === "curl"}
        curl={inspection.curl}
        copyState={copyState}
      />
      {isFailure ? <RetryScheduleNotice /> : null}
    </InspectorCard>
  );
}

function InspectionRedactionNotice({
  inspection,
}: {
  inspection: InspectionModel;
}): ReactElement {
  return (
    <CredentialRedactionNotice
      headerCount={inspection.redactedHeaderCount}
      responseCount={inspection.redactedResponseCount}
      urlCount={inspection.redactedUrlCount}
      bodyCount={inspection.redactedBodyCount}
    />
  );
}

export function ResponseInspector({ response }: Props): ReactElement {
  const inspection = useInspectionModel(response);
  const copyState = useCurlCopy(inspection.curl);
  if (!response.filtered) {
    return (
      <DeliveredInspector
        response={response}
        inspection={inspection}
        copyState={copyState}
      />
    );
  }
  return (
    <InspectorCard>
      <InspectorHeading response={response} />
      <InspectionRedactionNotice inspection={inspection} />
      <FilteredOutcome body={inspection.body.body} />
    </InspectorCard>
  );
}
