// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const postRaw = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ api: { postRaw } }));

import {
  GLOSSARY_CSV_MAX_BYTES,
  importGlossaryCsv,
} from "@/lib/translations-api";

describe("glossary CSV import client", () => {
  beforeEach(() => postRaw.mockReset());

  it("sends multipart once and parses the exact result envelope", async () => {
    postRaw.mockResolvedValue({
      imported: 2,
      skipped: 1,
      errors: ["row 4: missing term"],
    });
    const file = new File(["term,fr\nHello,Bonjour\n"], "glossary.csv", {
      type: "text/csv",
    });

    await expect(importGlossaryCsv(file)).resolves.toEqual({
      imported: 2,
      skipped: 1,
      errors: ["row 4: missing term"],
    });
    expect(postRaw).toHaveBeenCalledOnce();
    const [path, body, options] = postRaw.mock.calls[0]!;
    expect(path).toBe("/api/v1/translations/dictionary/import");
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("file")).toBe(file);
    expect(options).toMatchObject({ requireOnline: true, maxAttempts: 1 });
  });

  it("rejects empty and oversized files before transport", async () => {
    await expect(
      importGlossaryCsv(new File([], "empty.csv", { type: "text/csv" })),
    ).rejects.toThrow(/non-empty/u);
    await expect(
      importGlossaryCsv(
        new File([new Uint8Array(GLOSSARY_CSV_MAX_BYTES + 1)], "large.csv"),
      ),
    ).rejects.toThrow(/5 MiB/u);
    expect(postRaw).not.toHaveBeenCalled();
  });

  it("fails closed on malformed success envelopes", async () => {
    const file = new File(["term\nHello\n"], "glossary.csv");
    postRaw.mockResolvedValueOnce({ imported: -1, skipped: 0, errors: [] });
    await expect(importGlossaryCsv(file)).rejects.toThrow(/imported count/u);
    postRaw.mockResolvedValueOnce({ imported: 1, skipped: 0, errors: [3] });
    await expect(importGlossaryCsv(file)).rejects.toThrow(/errors list/u);
  });

  it("normalizes the server's omitted empty errors field", async () => {
    postRaw.mockResolvedValue({ imported: 1, skipped: 0 });
    const file = new File(["term\nHello\n"], "glossary.csv");
    await expect(importGlossaryCsv(file)).resolves.toEqual({
      imported: 1,
      skipped: 0,
      errors: [],
    });
  });
});
