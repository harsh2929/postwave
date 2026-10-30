// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";

import { sequencesGenerate } from "../src/commands/sequences.js";

describe("sequences generate", () => {
  it("rejects invalid variables instead of silently dropping them", async () => {
    const oldExitCode = process.exitCode;
    process.exitCode = undefined;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await sequencesGenerate({
        templateId: "welcome",
        variables: "{bad",
        apiKey: "pw_1234567890abcdef",
      });

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse sequence variables JSON"),
      );
    } finally {
      errorSpy.mockRestore();
      process.exitCode = oldExitCode;
    }
  });
});
