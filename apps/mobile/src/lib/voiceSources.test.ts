import { describe, expect, it } from "vitest";

import {
  MOBILE_VOICE_SOURCE_OPTIONS,
  buildVoiceSourceBody,
  ingestJobInFlight,
  ingestStatusMessage,
  normalizeIngestStatus,
  voiceSourceDetail,
  voiceSourceErrorMessage,
  voiceSourceLabel,
} from "./voiceSources";

describe("buildVoiceSourceBody", () => {
  it("sends Go field names, not snake_case — IngestParams has no json tags", () => {
    const built = buildVoiceSourceBody("blog_rss", " https://example.com/feed.xml ");
    expect(built.error).toBeNull();
    expect(built.body).toEqual({
      type: "blog_rss",
      params: { FeedURL: "https://example.com/feed.xml" },
    });
    // The single easiest wire mistake here: a snake_case key silently
    // produces a source with an empty FeedURL that fails every ingest.
    expect(Object.keys(built.body?.params ?? {})).not.toContain("feed_url");
  });

  it("refuses a URL the server's SSRF guard could never accept", () => {
    for (const bad of ["", "   ", "example.com/feed", "ftp://x.com/f", "file:///etc/passwd"]) {
      expect(buildVoiceSourceBody("blog_rss", bad).error).toBeTruthy();
    }
  });

  it("requires a real paragraph for pasted writing", () => {
    expect(buildVoiceSourceBody("paste_in", "hi there").error).toContain(
      "at least a paragraph",
    );
    const ok = buildVoiceSourceBody("paste_in", "x".repeat(60));
    expect(ok.error).toBeNull();
    expect(ok.body?.params).toEqual({ RawText: "x".repeat(60) });
  });

  it("sends empty params for the archive source, which needs none", () => {
    const built = buildVoiceSourceBody("newsletter_archive", "");
    expect(built.error).toBeNull();
    expect(built.body).toEqual({ type: "newsletter_archive", params: {} });
  });

  it("refuses types mobile deliberately does not offer", () => {
    expect(buildVoiceSourceBody("twitter", "anything").error).toContain(
      "can't be added from mobile",
    );
    expect(buildVoiceSourceBody("linkedin_export", "x").body).toBeNull();
  });

  it("offers only phone-completable source types", () => {
    expect(MOBILE_VOICE_SOURCE_OPTIONS.map((o) => o.type)).toEqual([
      "blog_rss",
      "paste_in",
      "newsletter_archive",
    ]);
  });
});

describe("voiceSourceLabel", () => {
  it("names every server source type, including ones mobile can't add", () => {
    expect(voiceSourceLabel("linkedin_export")).toBe("LinkedIn export");
    expect(voiceSourceLabel("twitter")).toBe("X / Twitter archive");
    expect(voiceSourceLabel("newsletter_archive")).toBe("Sent campaigns");
  });

  it("echoes an unknown type rather than hiding it", () => {
    expect(voiceSourceLabel("mastodon")).toBe("mastodon");
    expect(voiceSourceLabel(undefined)).toBe("Unknown source");
  });
});

describe("voiceSourceDetail", () => {
  it("shows the item count and the feed when there is one", () => {
    expect(
      voiceSourceDetail({
        id: "s",
        last_item_count: 12,
        params: { FeedURL: "https://a.co/rss" },
      }),
    ).toBe("12 items · https://a.co/rss");
  });

  it("singularises and tolerates a missing count", () => {
    expect(voiceSourceDetail({ id: "s", last_item_count: 1 })).toBe("1 item");
    expect(voiceSourceDetail({ id: "s" })).toBe("0 items");
  });
});

describe("ingest job status", () => {
  it("normalises only the statuses the job store emits", () => {
    expect(normalizeIngestStatus("running")).toBe("running");
    expect(normalizeIngestStatus("SUCCEEDED")).toBe("succeeded");
    expect(normalizeIngestStatus("weird")).toBe("unknown");
    expect(normalizeIngestStatus(undefined)).toBe("unknown");
  });

  it("keeps polling only while in flight", () => {
    expect(ingestJobInFlight("pending")).toBe(true);
    expect(ingestJobInFlight("running")).toBe(true);
    expect(ingestJobInFlight("succeeded")).toBe(false);
    expect(ingestJobInFlight("unknown")).toBe(false);
  });

  it("reports the item count on success and the reason on failure", () => {
    expect(ingestStatusMessage("succeeded", 1)).toBe("Ingested 1 item.");
    expect(ingestStatusMessage("succeeded", 9)).toBe("Ingested 9 items.");
    expect(ingestStatusMessage("failed", 0, "feed 404")).toBe("feed 404");
    expect(ingestStatusMessage("failed", 0, "  ")).toBe("The ingest run failed.");
  });

  it("explains an unknown job instead of claiming success", () => {
    // The polling route 404s when the job store is unwired (dev mode), which
    // must never read as "done".
    expect(ingestStatusMessage("unknown", 0)).toContain("no longer available");
  });
});

describe("voiceSourceErrorMessage", () => {
  it("passes the server's 400 reason through — it is the validation text", () => {
    expect(voiceSourceErrorMessage(400, "blog_rss: private address")).toBe(
      "blog_rss: private address",
    );
  });

  it("names a role problem and a missing deployment", () => {
    expect(voiceSourceErrorMessage(403)).toContain("Ask an admin");
    expect(voiceSourceErrorMessage(501)).toContain("doesn't expose");
  });

  it("falls back", () => {
    expect(voiceSourceErrorMessage(500, "boom")).toBe("boom");
    expect(voiceSourceErrorMessage(0)).toBe("Couldn't reach the voice service.");
  });
});
