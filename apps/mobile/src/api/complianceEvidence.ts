/**
 * api/complianceEvidence.ts — transport for the Compliance screen's
 * evidence reads.
 *
 *   GET /api/v1/audit/retention-activity  (viewer; audit:read+read_pii)
 *   GET /api/v1/audit/stats?actor_type=agent&since=…  (viewer)
 *   GET /api/v1/audit/ai-session/{id}/aivs-bundle  (viewer; binary tar.gz)
 *
 * All are manifest-viewer routes, but they render on the Compliance screen,
 * which the nav registry floors at admin — so the effective audience is
 * admin.
 *
 * THE BUNDLE IS BINARY, so it cannot ride `rawRequest` (the SDK parses a
 * JSON envelope). It uses the app's direct-fetch idiom instead
 * (api/aiGenerate.ts, api/streamCredentials.ts): expo/fetch with the native
 * client headers, bearer-or-cookie auth, and the MFA interceptor — then
 * hands back BYTES for the caller to write and share. The fetch stays
 * press-driven (never a prefetch) and the byte count is bounded before the
 * buffer is materialised.
 */
import { useAuthStore } from "@/store/auth";
import { fetch as expoFetch } from "expo/fetch";

import {
  AIVS_BUNDLE_MAX_BYTES,
  aivsBundleFilename,
  aivsBundleSizeIssue,
  parseRetentionActivity,
  type RetentionActivity,
} from "@/lib/complianceEvidence";
import { WireShapeError } from "@/lib/wireShapeError";

import { ApiRequestError } from "./apiRequestError";
import { interceptMfaRequiredResponse } from "./auth";
import { readBoundedResponseText } from "./eventBusStream";
import { NATIVE_CLIENT_HEADERS } from "./nativeClient";
import { rawRequest, type AIApiError } from "./request";
import { apiUrl } from "./url";

/** Keeps status, code and the server's classified refusal (ApiRequestError). */
export class ComplianceEvidenceError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "ComplianceEvidenceError";
  }
}

export async function fetchRetentionActivity(
  limit = 100,
): Promise<RetentionActivity> {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/audit/retention-activity?${params.toString()}`,
    undefined,
  );
  if (res.error) {
    throw new ComplianceEvidenceError(res.error, "Loading retention activity");
  }
  const parsed = parseRetentionActivity(res.data);
  if (!parsed) {
    throw new WireShapeError(
      "retention activity",
      "The retention-activity response could not be read.",
    );
  }
  return parsed;
}

/**
 * Agent-actor audit stats for the Article 50 window. `since` is RFC3339;
 * the response is the raw AuditStatsResponse for lib/auditStats' normalizer.
 */
export async function fetchAgentAuditStats(since: string): Promise<unknown> {
  const params = new URLSearchParams({ actor_type: "agent", since });
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/audit/stats?${params.toString()}`,
    undefined,
  );
  if (res.error) {
    throw new ComplianceEvidenceError(res.error, "Counting agent activity");
  }
  return res.data;
}

export interface AivsBundle {
  bytes: Uint8Array;
  filename: string;
}

const MAX_AIVS_ERROR_BODY_BYTES = 16 * 1024;

/**
 * The export's time budget, in two phases — the half of the "direct-fetch
 * idiom" this module named and then did not adopt.
 *
 * `api/aiGenerate.ts` and `api/streamCredentials.ts` both wrap their bare
 * fetch in an AbortController on a timer. This one did not, and it is a
 * `press → setBusy(true) → await` path whose button is DISABLED while busy
 * (components/compliance/Article50ReadinessCard.tsx). So a request that never
 * settled — a half-open socket on a phone that changed cell, the case iOS
 * leaves hanging rather than failing — left the spinner turning and the
 * control unusable for the life of the screen. No timeout is not a long tail;
 * it is an unbounded one.
 *
 * Two phases rather than one, because they bound different things. The server
 * has 30s to ANSWER (the same per-attempt budget the SDK gives every other
 * request); once it has, the bytes get their own budget, because a bundle is
 * up to 32 MB and a slow-but-working transfer must not be killed by a clock
 * that started before the response did. 120s is the SDK's own ceiling
 * (`MAX_TIMEOUT_MS`), and for a maximal bundle it works out at ~273 KB/s —
 * below which the screen's existing advice ("collect it from the web admin
 * instead") is the honest answer anyway.
 */
const AIVS_BUNDLE_RESPONSE_TIMEOUT_MS = 30_000;
const AIVS_BUNDLE_BODY_TIMEOUT_MS = 120_000;

/** The sentence a bounded wait ends with. Never a bare "Aborted". */
export const AIVS_BUNDLE_TIMEOUT_MESSAGE =
  "The bundle download timed out. Try again on a stronger connection, or collect it from the web admin.";

/** The slug the server tenant-scopes the session cookie path by. */
function effectiveTenantSlug(): string | null {
  const { mode, tenantId, session } = useAuthStore.getState();
  return session?.workspaceSlug ?? (mode === "api_key" ? tenantId : null);
}

/**
 * Fetch the signed AIVS inspector bundle for one AI session, as bytes.
 *
 * Press-driven only — this read is a deliberate act of evidence collection,
 * never a prefetch. The caller (Article50ReadinessCard) writes the bytes to
 * the app cache and hands the FILE to the share sheet; no session-streamed
 * URL ever reaches the OS (the AuditExportSheet doctrine).
 */
export async function fetchAivsBundle(sessionId: string): Promise<AivsBundle> {
  const sid = sessionId.trim();
  if (!sid) throw new Error("A session id is required.");
  const { apiKey, baseUrl } = useAuthStore.getState();
  if (!baseUrl) throw new Error("Sign in before exporting a bundle.");
  const bearer = apiKey
    ? apiKey.startsWith("pw_")
      ? apiKey
      : `pw_${apiKey}`
    : null;
  const tenantSlug = effectiveTenantSlug();
  const controller = new AbortController();
  let timedOut = false;
  let timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AIVS_BUNDLE_RESPONSE_TIMEOUT_MS);
  try {
    const res = await interceptMfaRequiredResponse(
      await expoFetch(
        apiUrl(
          baseUrl,
          `/api/v1/audit/ai-session/${encodeURIComponent(sid)}/aivs-bundle`,
        ),
        {
          method: "GET",
          headers: {
            Accept: "application/gzip, application/octet-stream, */*",
            ...NATIVE_CLIENT_HEADERS,
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
            ...(tenantSlug ? { "X-Tenant-Slug": tenantSlug } : {}),
          },
          ...(bearer ? {} : { credentials: "include" as const }),
          signal: controller.signal,
        },
      ),
      baseUrl,
    );
    // The server answered; the remaining budget belongs to the BYTES, which is
    // a different amount of time. Restarting the clock here is what keeps a
    // large-but-healthy transfer from being killed by the response deadline.
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, AIVS_BUNDLE_BODY_TIMEOUT_MS);
    if (!res.ok) {
      throw new ComplianceEvidenceError(
        await aivsErrorFromResponse(res),
        "Fetching the AIVS bundle",
      );
    }
    const declared = Number(res.headers.get("content-length") || 0);
    if (Number.isFinite(declared) && declared > AIVS_BUNDLE_MAX_BYTES) {
      throw new Error(
        aivsBundleSizeIssue(declared) ?? "The bundle is too large.",
      );
    }
    const buffer = await res.arrayBuffer();
    const sizeIssue = aivsBundleSizeIssue(buffer.byteLength);
    if (sizeIssue) throw new Error(sizeIssue);
    return {
      bytes: new Uint8Array(buffer),
      filename: aivsBundleFilename(sid, res.headers.get("content-disposition")),
    };
  } catch (err) {
    // An abort raised by OUR timer is a timeout, not a mystery: `aivsExportIssue`
    // falls back to `err.message`, and a bare "Aborted" tells the reader
    // nothing about what to do next.
    if (timedOut) throw new Error(AIVS_BUNDLE_TIMEOUT_MESSAGE);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A refusal body is JSON on this route (`{error:{message,code}}` or flat
 * `{message,code}`); read it BOUNDED — this is an error path, and an endless
 * body from a proxy must not grow the heap — and keep status + code so the
 * card can tell a permission rule (403) and `no_agent_events` apart from an
 * outage.
 */
async function aivsErrorFromResponse(res: {
  status: number;
  headers: { get(name: string): string | null };
  body?: unknown;
  text(): Promise<string>;
}): Promise<AIApiError> {
  let message = "";
  let code: string | undefined;
  try {
    const text = await readBoundedResponseText(
      res as Parameters<typeof readBoundedResponseText>[0],
      MAX_AIVS_ERROR_BODY_BYTES,
    );
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown; code?: unknown };
      message?: unknown;
      code?: unknown;
    };
    const nested = parsed.error;
    if (typeof nested?.message === "string") message = nested.message;
    else if (typeof parsed.message === "string") message = parsed.message;
    if (typeof nested?.code === "string") code = nested.code;
    else if (typeof parsed.code === "string") code = parsed.code;
  } catch {
    /* keep the bare status when the body is missing, huge, or not JSON */
  }
  return {
    status: res.status,
    message: message || `HTTP ${res.status}`,
    ...(code !== undefined ? { code } : {}),
  };
}
