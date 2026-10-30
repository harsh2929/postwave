// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AddSourceParams, SourceType } from "@/lib/voice-types";

export const MAX_LINKEDIN_CSV_BYTES = 2 * 1024 * 1024;
export const LINKEDIN_CSV_TOO_LARGE =
  "LinkedIn CSV exports must be 2 MB or smaller.";

export interface VoiceSourceDraftValues {
  feedUrl: string;
  handle: string;
  linkedinCsvText: string;
  linkedinFileName: string;
  podcastText: string;
  podcastTitle: string;
  podcastUrl: string;
  sourceError: string;
  text: string;
  type: SourceType;
}

const SOURCE_OPTIONS: Array<[SourceType, string]> = [
  ["newsletter_archive", "Newsletter archive"],
  ["twitter", "Twitter / X"],
  ["blog_rss", "Blog RSS"],
  ["linkedin_export", "LinkedIn export"],
  ["podcast_transcript", "Podcast transcript"],
  ["paste", "Paste-in"],
];

export function canSubmitVoiceSourceDraft({
  feedUrl,
  handle,
  linkedinCsvText,
  podcastText,
  sourceError,
  text,
  type,
}: VoiceSourceDraftValues): boolean {
  if (sourceError !== "") return false;
  if (type === "newsletter_archive") return true;
  if (type === "twitter") return handle.trim() !== "";
  if (type === "blog_rss") return feedUrl.trim() !== "";
  if (type === "linkedin_export") return linkedinCsvText.trim() !== "";
  if (type === "podcast_transcript") return podcastText.trim() !== "";
  return text.trim() !== "";
}

export function buildVoiceSourceParams({
  feedUrl,
  handle,
  linkedinCsvText,
  linkedinFileName,
  podcastText,
  podcastTitle,
  podcastUrl,
  text,
  type,
}: VoiceSourceDraftValues): AddSourceParams {
  if (type === "newsletter_archive") {
    return { type, label: "Moosewave campaign archive" };
  }
  if (type === "twitter") return { type, handle };
  if (type === "blog_rss") return { type, feedUrl };
  if (type === "linkedin_export") {
    return {
      type,
      csvText: linkedinCsvText,
      label: linkedinFileName || "LinkedIn CSV export",
    };
  }
  if (type === "podcast_transcript") {
    return {
      type,
      text: podcastText,
      title: podcastTitle,
      url: podcastUrl,
    };
  }
  return { type, text };
}

export function AddSourceDialog({
  onAdd,
  onOpenChange,
  open,
}: {
  onAdd: (params: AddSourceParams) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [type, setType] = useState<SourceType>("newsletter_archive");
  const [handle, setHandle] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [text, setText] = useState("");
  const [linkedinCsvText, setLinkedinCsvText] = useState("");
  const [linkedinFileName, setLinkedinFileName] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [podcastText, setPodcastText] = useState("");
  const [podcastTitle, setPodcastTitle] = useState("");
  const [podcastUrl, setPodcastUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const draft: VoiceSourceDraftValues = {
    feedUrl,
    handle,
    linkedinCsvText,
    linkedinFileName,
    podcastText,
    podcastTitle,
    podcastUrl,
    sourceError,
    text,
    type,
  };
  const canSubmit = canSubmitVoiceSourceDraft(draft);

  const readLinkedInFile = async (file: File | null) => {
    if (!file) return;
    if (file.size > MAX_LINKEDIN_CSV_BYTES) {
      setLinkedinFileName("");
      setLinkedinCsvText("");
      setSourceError(LINKEDIN_CSV_TOO_LARGE);
      return;
    }
    setSourceError("");
    setLinkedinFileName(file.name);
    try {
      setLinkedinCsvText(await file.text());
    } catch {
      setLinkedinFileName("");
      setLinkedinCsvText("");
      setSourceError(
        "Could not read that LinkedIn CSV file. Try exporting it again.",
      );
    }
  };

  const resetDraft = () => {
    setType("newsletter_archive");
    setHandle("");
    setFeedUrl("");
    setText("");
    setLinkedinCsvText("");
    setLinkedinFileName("");
    setSourceError("");
    setPodcastText("");
    setPodcastTitle("");
    setPodcastUrl("");
  };

  const submit = async () => {
    if (busy || !canSubmit) return;
    setBusy(true);
    try {
      setSourceError("");
      await onAdd(buildVoiceSourceParams(draft));
      // Clear on success so reopening the dialog starts fresh (SEQ-054).
      resetDraft();
    } catch (err) {
      setSourceError(
        err instanceof Error ? err.message : "Could not add that source.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy && !next) return;
        if (!next && !busy) resetDraft();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add source</DialogTitle>
          <DialogDescription>
            Choose one source type, then provide the writing Moosewave should
            learn from. Nothing is submitted until you select Add source.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div
            role="radiogroup"
            aria-label="Source type"
            className="grid grid-cols-2 gap-2"
          >
            {SOURCE_OPTIONS.map(([key, label], index) => (
              <button
                type="button"
                key={key}
                role="radio"
                aria-checked={type === key}
                tabIndex={type === key ? 0 : -1}
                disabled={busy}
                onClick={() => {
                  setType(key);
                  setSourceError("");
                }}
                onKeyDown={(event) => {
                  if (
                    ![
                      "ArrowRight",
                      "ArrowDown",
                      "ArrowLeft",
                      "ArrowUp",
                    ].includes(event.key)
                  ) {
                    return;
                  }
                  event.preventDefault();
                  const direction =
                    event.key === "ArrowRight" || event.key === "ArrowDown"
                      ? 1
                      : -1;
                  const nextIndex =
                    (index + direction + SOURCE_OPTIONS.length) %
                    SOURCE_OPTIONS.length;
                  setType(SOURCE_OPTIONS[nextIndex][0]);
                  setSourceError("");
                  const buttons =
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                      '[role="radio"]',
                    );
                  buttons?.[nextIndex]?.focus();
                }}
                className={`min-h-10 rounded-md border px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 ${
                  type === key
                    ? "border-foreground bg-accent"
                    : "hover:bg-muted/40"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {type === "newsletter_archive" && (
            <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
              Uses the campaigns already sent or imported into this Moosewave
              workspace. No external archive URL is needed.
            </p>
          )}
          {type === "twitter" && (
            <div className="space-y-1.5">
              <Label htmlFor="handle">Handle</Label>
              <Input
                id="handle"
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                placeholder="@yourhandle"
                required
              />
            </div>
          )}
          {type === "blog_rss" && (
            <div className="space-y-1.5">
              <Label htmlFor="feed">Feed URL</Label>
              <Input
                id="feed"
                type="url"
                inputMode="url"
                value={feedUrl}
                onChange={(event) => setFeedUrl(event.target.value)}
                placeholder="https://yourblog.com/feed"
                required
              />
            </div>
          )}
          {type === "linkedin_export" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="linkedin-file">LinkedIn posts CSV</Label>
                <Input
                  id="linkedin-file"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) =>
                    void readLinkedInFile(
                      event.currentTarget.files?.[0] ?? null,
                    )
                  }
                  aria-invalid={sourceError ? true : undefined}
                  aria-describedby={
                    sourceError ? "voice-source-error" : undefined
                  }
                />
                {linkedinFileName ? (
                  <p className="text-xs text-muted-foreground">
                    Loaded {linkedinFileName}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="linkedin">CSV preview / paste fallback</Label>
                <Textarea
                  id="linkedin"
                  value={linkedinCsvText}
                  onChange={(event) => {
                    setLinkedinCsvText(event.target.value);
                    setSourceError("");
                    if (linkedinFileName) setLinkedinFileName("");
                  }}
                  rows={5}
                  required
                  aria-invalid={sourceError ? true : undefined}
                  aria-describedby={
                    sourceError ? "voice-source-error" : undefined
                  }
                  placeholder={
                    'Date,ShareCommentary,URL\n2026-05-01,"Your post text",https://linkedin.com/...'
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Upload the LinkedIn posts CSV export or paste its CSV content.
                Moosewave reads it directly without needing a shared server path.
              </p>
            </div>
          )}
          {type === "podcast_transcript" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="podcast-title">Title</Label>
                <Input
                  id="podcast-title"
                  value={podcastTitle}
                  onChange={(event) => setPodcastTitle(event.target.value)}
                  placeholder="Founder AMA"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="podcast-url">URL</Label>
                <Input
                  id="podcast-url"
                  type="url"
                  inputMode="url"
                  value={podcastUrl}
                  onChange={(event) => setPodcastUrl(event.target.value)}
                  placeholder="https://example.com/episode"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="podcast-text">Transcript</Label>
                <Textarea
                  id="podcast-text"
                  value={podcastText}
                  onChange={(event) => setPodcastText(event.target.value)}
                  rows={7}
                  placeholder="Paste the cleaned transcript. Blank-line sections become source items."
                  required
                />
              </div>
            </div>
          )}
          {type === "paste" && (
            <div className="space-y-1.5">
              <Label htmlFor="paste">Paste your writing</Label>
              <Textarea
                id="paste"
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={6}
                placeholder="Drop in 3-10 representative pieces. Quality beats volume."
                required
              />
            </div>
          )}
          {sourceError ? (
            <p
              id="voice-source-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {sourceError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!canSubmit}>
              Add source
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
