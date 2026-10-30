import { describe, expect, it } from "vitest";

import {
  exportDownloadState,
  exportStateLabel,
  exportStatusTone,
  isOpenableDownloadUrl,
  summarizeInclude,
} from "@/lib/exportRows";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function row(over: Partial<Parameters<typeof exportDownloadState>[0]> = {}) {
  return {
    status: "ready",
    download_url: "https://cdn.example.com/exports/a.zip?sig=x",
    expires_at: "2026-07-26T12:00:00.000Z",
    error: "",
    ...over,
  };
}

describe("exportDownloadState", () => {
  it("offers the signed URL while it is live", () => {
    expect(exportDownloadState(row(), NOW)).toEqual({
      kind: "ready",
      url: "https://cdn.example.com/exports/a.zip?sig=x",
    });
  });

  it("reports expiry BEFORE offering the URL", () => {
    // The regression this guards: an expired presigned URL is still a
    // perfectly well-formed string in the payload and 403s on tap.
    expect(
      exportDownloadState(
        row({ expires_at: "2026-07-25T11:59:59.000Z" }),
        NOW,
      ),
    ).toEqual({ kind: "expired" });
  });

  it("treats the boundary instant as expired", () => {
    expect(
      exportDownloadState(row({ expires_at: NOW.toISOString() }), NOW).kind,
    ).toBe("expired");
  });

  it("never offers a download for queued or running rows", () => {
    expect(exportDownloadState(row({ status: "queued" }), NOW).kind).toBe(
      "pending",
    );
    expect(exportDownloadState(row({ status: "running" }), NOW).kind).toBe(
      "pending",
    );
  });

  it("carries the server's failure reason", () => {
    expect(
      exportDownloadState(
        row({ status: "failed", error: "storage unreachable" }),
        NOW,
      ),
    ).toEqual({ kind: "failed", reason: "storage unreachable" });
  });

  it("handles the server's empty-string nulls", () => {
    // derefStr flattens NULL to "" — Date.parse("") is NaN, so an absent
    // expiry must not read as expired.
    expect(
      exportDownloadState(row({ expires_at: "", download_url: "" }), NOW).kind,
    ).toBe("unavailable");
    expect(
      exportDownloadState(row({ expires_at: "" }), NOW),
    ).toMatchObject({ kind: "ready" });
  });
});

describe("isOpenableDownloadUrl", () => {
  it("accepts http(s) and rejects the dev file:// form", () => {
    expect(isOpenableDownloadUrl("https://x/y.zip")).toBe(true);
    expect(isOpenableDownloadUrl("HTTP://x/y.zip")).toBe(true);
    expect(isOpenableDownloadUrl("file:///tmp/y.zip")).toBe(false);
    expect(isOpenableDownloadUrl("  ")).toBe(false);
  });
});

describe("summarizeInclude", () => {
  it("names an empty include set as everything (the server default)", () => {
    expect(summarizeInclude([])).toBe("everything");
    expect(summarizeInclude(undefined)).toBe("everything");
  });

  it("truncates long sets", () => {
    expect(summarizeInclude(["a", "b", "c", "d", "e"])).toBe("a, b, c +2 more");
    expect(summarizeInclude(["a", "b"])).toBe("a, b");
  });
});

describe("labels", () => {
  it("never describes an expired row as downloadable", () => {
    expect(exportStateLabel({ kind: "expired" })).toContain("expired");
    expect(exportStateLabel({ kind: "expired" })).not.toContain("Tap to");
  });

  it("falls back to a generic sentence when the server sent no reason", () => {
    expect(exportStateLabel({ kind: "failed", reason: "" })).toBe(
      "Export failed",
    );
  });

  it("maps statuses to tones", () => {
    expect(exportStatusTone("ready")).toBe("success");
    expect(exportStatusTone("failed")).toBe("danger");
    expect(exportStatusTone("running")).toBe("warning");
    expect(exportStatusTone("queued")).toBe("neutral");
    expect(exportStatusTone("something-new")).toBe("neutral");
  });
});
