const MAX_STREAM_PAYLOAD_BYTES = 128 * 1024;

export type StreamPayloadParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export function parseJsonStreamPayload<T>(
  raw: string,
): StreamPayloadParseResult<T> {
  if (utf8ByteLength(raw) > MAX_STREAM_PAYLOAD_BYTES) {
    return { ok: false, message: "Stream payload is too large" };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false, message: "Failed to parse JSON stream payload" };
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
