/**
 * lib/voiceSources.ts — policy for the voice corpus SOURCES.
 *
 * The Voice tab showed a measured profile and a rebuild button and nothing
 * about where the measurement came FROM. That made the profile a dead end: an
 * operator who disagreed with it had no way to see, add or refresh the corpus
 * feeding it.
 *
 * Two contract details this module exists to hold:
 *
 *  1. `IngestParams` (services/voice/internal/ingest/source.go:36) carries NO
 *     json tags, so Go marshals it with the GO FIELD NAMES — `FeedURL`,
 *     `RawText`, `Limit`, `TenantID`, `ArchivePath`, `Extra`. Sending
 *     `feed_url` produces a source that validates as empty and then fails
 *     every ingest. This is the single easiest thing to get wrong here.
 *  2. Only a SUBSET of the six source types is a phone gesture. `twitter`,
 *     `linkedin_export` and `podcast_transcript` all require an uploaded
 *     export file or a pasted transcript of real length
 *     (ingest/validation.go:82-101). Offering them on mobile would produce a
 *     picker whose options mostly cannot be completed. Mobile offers the three
 *     that CAN be: an RSS/blog feed URL, pasted text, and the tenant's own
 *     newsletter archive (which needs no parameters at all).
 *
 * Import-free so the params builder and the validation are unit-testable.
 */

export type VoiceSourceType =
  | "newsletter_archive"
  | "twitter"
  | "blog_rss"
  | "podcast_transcript"
  | "linkedin_export"
  | "paste_in";

/** What a source needs from the operator. */
export type VoiceSourceInputKind = "none" | "url" | "text";

export interface VoiceSourceOption {
  type: VoiceSourceType;
  label: string;
  description: string;
  input: VoiceSourceInputKind;
  placeholder?: string;
}

/**
 * The source types mobile offers to ADD. Every other type still RENDERS
 * correctly in the list (`voiceSourceLabel`) — an operator who added a
 * LinkedIn export on desktop must still see it here.
 */
export const MOBILE_VOICE_SOURCE_OPTIONS: readonly VoiceSourceOption[] = [
  {
    type: "blog_rss",
    label: "Blog or RSS feed",
    description: "Moosewave reads recent posts from a public feed URL.",
    input: "url",
    placeholder: "https://example.com/feed.xml",
  },
  {
    type: "paste_in",
    label: "Pasted writing",
    description: "Paste a few paragraphs that sound like you.",
    input: "text",
    placeholder: "Paste a newsletter, a post, anything you wrote…",
  },
  {
    type: "newsletter_archive",
    label: "Your sent campaigns",
    description: "Measures the newsletters this workspace has already sent.",
    input: "none",
  },
];

const SOURCE_LABELS: Record<VoiceSourceType, string> = {
  newsletter_archive: "Sent campaigns",
  twitter: "X / Twitter archive",
  blog_rss: "Blog or RSS feed",
  podcast_transcript: "Podcast transcript",
  linkedin_export: "LinkedIn export",
  paste_in: "Pasted writing",
};

export function voiceSourceLabel(type: string | undefined): string {
  const key = (type ?? "").trim() as VoiceSourceType;
  return SOURCE_LABELS[key] ?? (type?.trim() || "Unknown source");
}

/** Wire params. Field names are Go's, deliberately — see the module header. */
export interface VoiceSourceParamsWire {
  FeedURL?: string;
  RawText?: string;
  Limit?: number;
  ArchivePath?: string;
  Extra?: Record<string, string>;
}

export interface VoiceSourceWire {
  id: string;
  tenant_id?: string;
  type?: string;
  params?: VoiceSourceParamsWire;
  last_ingested_at?: string;
  last_item_count?: number;
}

/**
 * Validate + build the create body for one source type.
 *
 * Returns `{ error }` rather than throwing so the sheet can render the reason
 * beside the field. The URL check is deliberately conservative and mirrors the
 * server's intent (`validateRSSURL` refuses anything that could reach a
 * private network): http/https only, a host present. The server remains the
 * authority — this only avoids a round trip for input that cannot possibly
 * pass.
 */
export function buildVoiceSourceBody(
  type: VoiceSourceType,
  value: string,
):
  | { body: { type: VoiceSourceType; params: VoiceSourceParamsWire }; error: null }
  | { body: null; error: string } {
  const option = MOBILE_VOICE_SOURCE_OPTIONS.find((o) => o.type === type);
  if (!option) {
    return { body: null, error: "That source type can't be added from mobile." };
  }
  const trimmed = value.trim();
  if (option.input === "url") {
    if (!trimmed) return { body: null, error: "Enter the feed URL." };
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(trimmed)) {
      return {
        body: null,
        error: "Enter a full public feed URL starting with http:// or https://.",
      };
    }
    return { body: { type, params: { FeedURL: trimmed } }, error: null };
  }
  if (option.input === "text") {
    if (trimmed.length < 40) {
      return {
        body: null,
        error: "Paste at least a paragraph — a line or two isn't enough to measure.",
      };
    }
    return { body: { type, params: { RawText: trimmed } }, error: null };
  }
  return { body: { type, params: {} }, error: null };
}

/** One line describing what a stored source currently holds. */
export function voiceSourceDetail(source: VoiceSourceWire): string {
  const count =
    typeof source.last_item_count === "number" &&
    Number.isFinite(source.last_item_count)
      ? Math.max(0, Math.trunc(source.last_item_count))
      : 0;
  const feed = source.params?.FeedURL?.trim();
  const items = `${count} ${count === 1 ? "item" : "items"}`;
  return feed ? `${items} · ${feed}` : items;
}

export type IngestJobStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown";

export function normalizeIngestStatus(raw: string | undefined): IngestJobStatus {
  const status = (raw ?? "").trim().toLowerCase();
  if (
    status === "pending" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed"
  ) {
    return status;
  }
  return "unknown";
}

/** True while the job is still worth polling. */
export function ingestJobInFlight(status: IngestJobStatus): boolean {
  return status === "pending" || status === "running";
}

export function ingestStatusMessage(
  status: IngestJobStatus,
  itemCount: number,
  errorMessage?: string | undefined,
): string {
  if (status === "succeeded") {
    const n = Math.max(0, Math.trunc(itemCount));
    return `Ingested ${n} ${n === 1 ? "item" : "items"}.`;
  }
  if (status === "failed") {
    return errorMessage?.trim() || "The ingest run failed.";
  }
  if (status === "running") return "Reading the source…";
  if (status === "pending") return "Queued…";
  return "This run's status is no longer available.";
}

/** Human sentence for a failed source read/write. */
export function voiceSourceErrorMessage(
  status: number,
  fallback?: string | undefined,
): string {
  if (status === 400) {
    // The server echoes its validation reason verbatim for these routes.
    return fallback?.trim() || "That source was rejected. Check the details.";
  }
  if (status === 403) {
    return "Your role can't change voice sources. Ask an admin.";
  }
  if (status === 404) {
    return "That source no longer exists.";
  }
  if (status === 405 || status === 501) {
    return "This deployment doesn't expose voice sources.";
  }
  if (status === 503) {
    return "The voice service is unavailable right now. Try again shortly.";
  }
  return fallback?.trim() || "Couldn't reach the voice service.";
}
