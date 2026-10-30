// SPDX-License-Identifier: AGPL-3.0-only

import { sanitizeCSPReport } from "./sanitize";
import { shouldLogCSPReport } from "./rate-limit";

const MAX_CSP_REPORT_BYTES = 16 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "application/csp-report",
  "application/json",
  "application/reports+json",
]);

/**
 * Reads at most MAX_CSP_REPORT_BYTES of the body. A chunked upload carries no
 * Content-Length for the check above, so the limit is enforced while reading
 * rather than after buffering everything. An upload the client aborts
 * mid-stream (browsers send reports without waiting, and drop them on page
 * unload) rejects the read; it used to escape as an unhandled
 * "[Error: aborted] ECONNRESET" log line per report.
 */
async function readReportBody(
  request: Request,
): Promise<Uint8Array | "too_large" | "aborted"> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CSP_REPORT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return "aborted";
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
    return Response.json(
      { error: "unsupported content type" },
      { status: 415 },
    );
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_CSP_REPORT_BYTES) {
    return Response.json({ error: "report too large" }, { status: 413 });
  }
  const body = await readReportBody(request);
  if (body === "too_large") {
    return Response.json({ error: "report too large" }, { status: 413 });
  }
  if (body === "aborted") {
    // The browser gave up on the upload (reports are fire-and-forget). There
    // is nobody to answer; the status is only for the access log.
    return Response.json({ error: "report upload aborted" }, { status: 400 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json({ error: "invalid report" }, { status: 400 });
  }
  const reports = sanitizeCSPReport(parsed);
  if (shouldLogCSPReport(reports)) {
    // Structured and scrubbed before logging: violation URLs often contain
    // OAuth state or customer identifiers in query strings.
    console.warn("[csp-violation]", JSON.stringify(reports));
  }
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
}
