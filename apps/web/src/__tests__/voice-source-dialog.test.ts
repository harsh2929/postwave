// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  buildVoiceSourceParams,
  canSubmitVoiceSourceDraft,
  LINKEDIN_CSV_TOO_LARGE,
  MAX_LINKEDIN_CSV_BYTES,
  type VoiceSourceDraftValues,
} from "../app/(dashboard)/app/sequences/voice-profile/add-source-dialog";

function draft(
  patch: Partial<VoiceSourceDraftValues> = {},
): VoiceSourceDraftValues {
  return {
    feedUrl: "",
    handle: "",
    linkedinCsvText: "",
    linkedinFileName: "",
    podcastText: "",
    podcastTitle: "",
    podcastUrl: "",
    sourceError: "",
    text: "",
    type: "newsletter_archive",
    ...patch,
  };
}

describe("voice source dialog helpers", () => {
  it("gates submit by source type and visible validation errors", () => {
    expect(canSubmitVoiceSourceDraft(draft())).toBe(true);
    expect(
      canSubmitVoiceSourceDraft(
        draft({
          sourceError: LINKEDIN_CSV_TOO_LARGE,
        }),
      ),
    ).toBe(false);
    expect(
      canSubmitVoiceSourceDraft(draft({ type: "twitter", handle: " " })),
    ).toBe(false);
    expect(
      canSubmitVoiceSourceDraft(
        draft({ type: "twitter", handle: "@postwave" }),
      ),
    ).toBe(true);
    expect(
      canSubmitVoiceSourceDraft(
        draft({ type: "blog_rss", feedUrl: "https://example.com/feed.xml" }),
      ),
    ).toBe(true);
    expect(
      canSubmitVoiceSourceDraft(
        draft({ type: "linkedin_export", linkedinCsvText: "Date,Text" }),
      ),
    ).toBe(true);
    expect(
      canSubmitVoiceSourceDraft(
        draft({ type: "podcast_transcript", podcastText: "Transcript" }),
      ),
    ).toBe(true);
    expect(
      canSubmitVoiceSourceDraft(draft({ type: "paste", text: "Copy" })),
    ).toBe(true);
  });

  it("builds add-source payloads without dropping source-specific fields", () => {
    expect(buildVoiceSourceParams(draft())).toEqual({
      type: "newsletter_archive",
      label: "Moosewave campaign archive",
    });
    expect(
      buildVoiceSourceParams(draft({ type: "twitter", handle: "@postwave" })),
    ).toEqual({ type: "twitter", handle: "@postwave" });
    expect(
      buildVoiceSourceParams(
        draft({ type: "blog_rss", feedUrl: "https://example.com/feed.xml" }),
      ),
    ).toEqual({ type: "blog_rss", feedUrl: "https://example.com/feed.xml" });
    expect(
      buildVoiceSourceParams(
        draft({
          type: "linkedin_export",
          linkedinCsvText: "Date,Text",
          linkedinFileName: "posts.csv",
        }),
      ),
    ).toEqual({
      type: "linkedin_export",
      csvText: "Date,Text",
      label: "posts.csv",
    });
    expect(
      buildVoiceSourceParams(
        draft({
          type: "podcast_transcript",
          podcastText: "Transcript",
          podcastTitle: "Founder AMA",
          podcastUrl: "https://example.com/ama",
        }),
      ),
    ).toEqual({
      type: "podcast_transcript",
      text: "Transcript",
      title: "Founder AMA",
      url: "https://example.com/ama",
    });
    expect(
      buildVoiceSourceParams(draft({ type: "paste", text: "Copy" })),
    ).toEqual({
      type: "paste",
      text: "Copy",
    });
  });

  it("keeps the LinkedIn upload size limit documented for callers", () => {
    expect(MAX_LINKEDIN_CSV_BYTES).toBe(2 * 1024 * 1024);
    expect(LINKEDIN_CSV_TOO_LARGE).toContain("2 MB");
  });
});
