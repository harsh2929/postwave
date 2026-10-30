// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
  readResponseTextLimited,
  ResponseBodyTooLargeError,
} from "../../src/lib/http.js";

describe("VS Code HTTP helpers", () => {
  it("reads small response bodies", async () => {
    const response = new Response("hello", {
      headers: { "content-length": "5" },
    });

    await expect(readResponseTextLimited(response, 16)).resolves.toBe("hello");
  });

  it("rejects oversized bodies from content-length", async () => {
    const response = new Response("hello", {
      headers: { "content-length": "99" },
    });

    await expect(readResponseTextLimited(response, 16)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
  });

  it("rejects oversized streamed bodies without trusting character length", async () => {
    const response = new Response("é".repeat(10));

    await expect(readResponseTextLimited(response, 12)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
  });
});
