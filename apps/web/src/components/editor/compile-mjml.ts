// SPDX-License-Identifier: AGPL-3.0-only

const MAX_RESPONSE_BYTES = 512 * 1024;

export interface MjmlCompileResult {
  html: string;
  errors: Array<{ formattedMessage?: string; message?: string; line?: number }>;
}

/** Compile exactly the source the author is reviewing or saving. */
export async function compileMjmlSource(
  mjml: string,
  signal?: AbortSignal,
): Promise<MjmlCompileResult> {
  const response = await fetch("/api/mjml", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ mjml }),
  });
  const payload = await readJsonLimited(response);
  if (!response.ok) {
    const detail =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `MJML compile failed (${response.status})`;
    throw new Error(detail);
  }
  if (!isRecord(payload) || typeof payload.html !== "string") {
    throw new Error("MJML compile response was incomplete");
  }
  return {
    html: payload.html,
    errors: Array.isArray(payload.errors)
      ? payload.errors
          .filter(isRecord)
          .slice(0, 100)
          .map((issue) => ({
            formattedMessage:
              typeof issue.formattedMessage === "string"
                ? issue.formattedMessage
                : undefined,
            message:
              typeof issue.message === "string" ? issue.message : undefined,
            line: typeof issue.line === "number" ? issue.line : undefined,
          }))
      : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonLimited(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("MJML compile response too large");
  }
  if (!response.body) {
    const source = await response.text();
    if (new TextEncoder().encode(source).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("MJML compile response too large");
    }
    return parseCompileJson(source);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let source = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("MJML compile response too large");
    }
    source += decoder.decode(value, { stream: true });
  }
  source += decoder.decode();
  return parseCompileJson(source);
}

function parseCompileJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("MJML compile response was not valid JSON");
  }
}
