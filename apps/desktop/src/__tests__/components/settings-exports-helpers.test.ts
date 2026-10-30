// Data-exports section helpers (full-surface wiring #34): include
// options mirror exports.SupportedResources server-side, download
// affordances only appear for live signed URLs, and statuses map to
// honest badge tones.

import { describe, expect, it } from "vitest";

import {
  EXPORT_INCLUDE_OPTIONS,
  exportStatusTone,
  fmtExportBytes,
  isDownloadExpired,
  isDownloadReady,
  summarizeInclude,
} from "../../components/settings/exports-helpers";

describe("EXPORT_INCLUDE_OPTIONS", () => {
  it("mirrors the server's SupportedResources set exactly", () => {
    // Keep in lockstep with exports.SupportedResources (apps/api). The
    // last five are the "take everything / no lock-in" resources.
    expect(EXPORT_INCLUDE_OPTIONS.map((o) => o.key)).toEqual([
      "subscribers",
      "campaigns",
      "automations",
      "audit_log",
      "lists",
      "tags",
      "events",
      "templates",
      "segments",
      "forms",
      "suppressions",
      "consent",
    ]);
  });
});

describe("exportStatusTone", () => {
  it("maps the worker lifecycle to tones", () => {
    expect(exportStatusTone("queued")).toBe("");
    expect(exportStatusTone("running")).toBe("warning");
    expect(exportStatusTone("ready")).toBe("success");
    expect(exportStatusTone("failed")).toBe("danger");
  });

  it("renders unknown statuses neutrally instead of guessing", () => {
    expect(exportStatusTone("archived")).toBe("");
  });
});

describe("isDownloadReady", () => {
  it("requires BOTH ready status and a populated download_url", () => {
    expect(
      isDownloadReady({ status: "ready", download_url: "https://x/y.zip" }),
    ).toBe(true);
    expect(isDownloadReady({ status: "ready", download_url: undefined })).toBe(
      false,
    );
    expect(
      isDownloadReady({ status: "running", download_url: "https://x/y.zip" }),
    ).toBe(false);
  });
});

describe("isDownloadExpired", () => {
  const now = new Date("2026-06-11T12:00:00Z");

  it("flags past expiry, keeps future links live", () => {
    expect(
      isDownloadExpired({ expires_at: "2026-06-11T11:00:00Z" }, now),
    ).toBe(true);
    expect(
      isDownloadExpired({ expires_at: "2026-06-11T13:00:00Z" }, now),
    ).toBe(false);
  });

  it("treats a missing expiry as not-expired", () => {
    expect(isDownloadExpired({ expires_at: undefined }, now)).toBe(false);
  });
});

describe("summarizeInclude", () => {
  it("lists small sets and truncates large ones", () => {
    expect(summarizeInclude(["subscribers", "tags"])).toBe(
      "subscribers, tags",
    );
    expect(
      summarizeInclude(["a", "b", "c", "d", "e"]),
    ).toBe("a, b, c +2 more");
  });

  it("falls back honestly for the server's default-everything case", () => {
    expect(summarizeInclude([])).toBe("everything");
  });
});

describe("fmtExportBytes", () => {
  it("scales units", () => {
    expect(fmtExportBytes(0)).toBe("0 B");
    expect(fmtExportBytes(512)).toBe("512 B");
    expect(fmtExportBytes(2048)).toBe("2.0 KB");
    expect(fmtExportBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(fmtExportBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
});
