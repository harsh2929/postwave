export function normalizePublicUploadPresignResponse(payload: unknown): {
  upload_id: string;
  put_url: string;
  put_headers: Record<string, string>;
  field_value: string;
} {
  if (!payload || typeof payload !== "object") {
    throw new Error("upload presign returned an invalid response");
  }
  const record = payload as Record<string, unknown>;
  const uploadID = typeof record.upload_id === "string" ? record.upload_id : "";
  const putURL = typeof record.put_url === "string" ? record.put_url : "";
  const fieldValue =
    typeof record.field_value === "string" ? record.field_value : "";
  if (!uploadID || !putURL || !fieldValue) {
    throw new Error("upload presign returned an incomplete response");
  }

  const putHeaders: Record<string, string> = {};
  const rawHeaders = record.put_headers;
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
      throw new Error("upload presign returned invalid PUT headers");
    }
    const allowedHeaders = new Set([
      "content-type",
      "x-amz-server-side-encryption",
      "x-amz-server-side-encryption-aws-kms-key-id",
    ]);
    for (const [name, value] of Object.entries(
      rawHeaders as Record<string, unknown>,
    )) {
      if (
        !allowedHeaders.has(name.toLowerCase()) ||
        typeof value !== "string" ||
        value.length === 0 ||
        /[\u0000-\u001f\u007f]/.test(name) ||
        /[\r\n]/.test(value)
      ) {
        throw new Error("upload presign returned invalid PUT headers");
      }
      putHeaders[name] = value;
    }
  }

  return {
    upload_id: uploadID,
    put_url: putURL,
    put_headers: putHeaders,
    field_value: fieldValue,
  };
}

export function safePresignedUploadURL(raw: string): string | null {
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  if (raw.startsWith("/")) {
    if (raw.startsWith("//")) return null;
    const rawPath = raw.split(/[?#]/, 1)[0] ?? "";
    for (const part of rawPath.split("/")) {
      let decoded = part;
      for (let i = 0; i < 2; i += 1) {
        try {
          decoded = decodeURIComponent(decoded);
        } catch {
          break;
        }
      }
      if (decoded === "." || decoded === "..") return null;
    }
    try {
      const local = new URL(raw, "http://postwave.local");
      if (local.origin !== "http://postwave.local") return null;
      if (!local.pathname.startsWith("/api/internal/uploads/")) return null;
      if (
        local.pathname.split("/").some((part) => part === "." || part === "..")
      ) {
        return null;
      }
      local.hash = "";
      return `${local.pathname}${local.search}`;
    } catch {
      return null;
    }
  }
  try {
    const url = new URL(raw);
    const isLocalHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]");
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && !isLocalHttp) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
