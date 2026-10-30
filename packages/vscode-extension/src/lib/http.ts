// SPDX-License-Identifier: MIT

export class ResponseBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Response body is too large; limit is ${maxBytes} bytes.`);
    this.name = "ResponseBodyTooLargeError";
  }
}

export async function readResponseTextLimited(
  response: Pick<Response, "headers" | "body" | "text">,
  maxBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const size = Number(declaredLength);
    if (Number.isFinite(size) && size > maxBytes) {
      throw new ResponseBodyTooLargeError(maxBytes);
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ResponseBodyTooLargeError(maxBytes);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyTooLargeError(maxBytes);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total).toString("utf8");
}
