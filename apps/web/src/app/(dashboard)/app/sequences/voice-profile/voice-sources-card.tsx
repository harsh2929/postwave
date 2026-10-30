// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  ClipboardPaste,
  FileText,
  Mic2,
  Newspaper,
  Plus,
  RefreshCw,
  Rss,
  Trash2,
  Twitter,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/relative-time";
import type { SourceType, VoiceSource } from "@/lib/voice-types";

export function VoiceSourcesCard({
  loading,
  onAddClick,
  onIngest,
  onRemove,
  sources,
}: {
  loading: boolean;
  onAddClick: () => void;
  onIngest: (id: string) => void;
  onRemove: (id: string) => void;
  sources: VoiceSource[];
}) {
  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="font-medium">Sources</h2>
            <p className="text-sm text-muted-foreground">
              {sources.length} source{sources.length === 1 ? "" : "s"} feeding
              the profile.
            </p>
          </div>
          <Button size="sm" onClick={onAddClick} className="w-full sm:w-auto">
            <Plus className="h-4 w-4" />
            Add source
          </Button>
        </div>
        {loading ? (
          <ul className="divide-y rounded-md border">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-3">
                <Skeleton className="h-8 w-8 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
              </li>
            ))}
          </ul>
        ) : sources.length === 0 ? (
          <EmptyState
            icon={Mic2}
            title="Teach Moosewave your voice"
            description="A voice profile is built from your own writing — newsletters, tweets, a blog feed, a podcast transcript, or pasted text. Add a source or two and Moosewave learns your tone, vocabulary, and rhythm so every generated email sounds like you."
            action={
              <Button size="sm" onClick={onAddClick}>
                <Plus className="h-4 w-4" />
                Add your first source
              </Button>
            }
          />
        ) : (
          <ul className="divide-y rounded-md border">
            {sources.map((source) => (
              <li
                key={source.id}
                className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap"
              >
                <SourceIcon type={source.type} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{source.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {source.itemCount} items
                    {source.lastIngestedAt ? (
                      <>
                        {" "}
                        - last ingested{" "}
                        <RelativeTime iso={source.lastIngestedAt} />
                      </>
                    ) : (
                      " - pending first ingest"
                    )}
                  </p>
                </div>
                <Badge
                  className="ml-11 sm:ml-0"
                  variant={source.status === "ready" ? "success" : "secondary"}
                >
                  {source.status}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto sm:ml-0"
                  onClick={() => onIngest(source.id)}
                  aria-label="Re-ingest source"
                >
                  <RefreshCw className="h-4 w-4" />
                  <span className="hidden sm:inline">Re-ingest</span>
                </Button>
                <ConfirmDialog
                  trigger={
                    <IconButton size="sm" aria-label={`Remove ${source.label}`}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </IconButton>
                  }
                  title="Remove this source?"
                  description="The profile stops learning from this source. You can re-add it later, but it will need to be ingested again, which can take a while."
                  confirmLabel="Remove source"
                  onConfirm={() => onRemove(source.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SourceIcon({ type }: { type: SourceType }) {
  const Icon =
    type === "twitter"
      ? Twitter
      : type === "blog_rss"
        ? Rss
        : type === "newsletter_archive"
          ? Newspaper
          : type === "linkedin_export"
            ? FileText
            : type === "podcast_transcript"
              ? Mic2
              : ClipboardPaste;
  return (
    <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}
