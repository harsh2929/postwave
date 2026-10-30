/**
 * lib/campaignSendPreview.ts — the wire shape and the pure reading of
 * GET /api/v1/campaigns/{id}/send-preview.
 *
 * The Go handler (apps/api/internal/campaigns/send_preview.go) answers "who
 * would actually receive this campaign if you pressed Send right now":
 * recipients, suppressed_excluded, deliverable, the tier cap, and an
 * `over_cap` boolean. Critically, several counts use **-1 as an
 * "unavailable" sentinel** rather than zero, and the wire contract says a
 * client must render those as a dash so the operator sees the gap rather
 * than an inflated zero.
 *
 * Mobile previously showed no audience at all before a send — the recipient
 * count appeared only in the success alert, AFTER the send. On a phone,
 * where a mis-tap is likeliest, this is the one number that matters.
 */
import { num, plural } from "@/lib/format";

export interface SendPreviewResponse {
  campaign_id?: string;
  audience_kind?: string;
  segment_label?: string;
  recipients?: number;
  suppressed_excluded?: number;
  deliverable?: number;
  tier_cap_today?: number;
  tier_cap_remaining?: number;
  tier_cap_remaining_after?: number;
  over_cap?: boolean;
  counted_at?: string;
}

/** A count that the server may report as unavailable via the -1 sentinel. */
export type PreviewCount = number | null;

/** -1 (and any non-finite value) means "unavailable", NOT zero. */
export function previewCount(value: unknown): PreviewCount {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

/** Render a possibly-unavailable count, honouring the -1 sentinel. */
export function previewCountLabel(value: unknown, fallback = "—"): string {
  const n = previewCount(value);
  return n === null ? fallback : num(n);
}

/**
 * Human name for the audience the campaign targets. `segment_label` is
 * populated by the handler's SegmentResolver so the operator reads
 * "Black Friday VIPs" rather than a uuid.
 */
export function audienceLabel(
  preview: SendPreviewResponse | null | undefined,
): string {
  const label = preview?.segment_label?.trim();
  if (label) return label;
  switch ((preview?.audience_kind ?? "").trim().toLowerCase()) {
    case "segment":
      return "A segment";
    case "list":
      return "A list";
    case "workspace":
      return "Everyone in the workspace";
    default:
      return "Not resolved yet";
  }
}

/** Short qualifier under the audience name ("Segment" / "List" / …). */
export function audienceKindLabel(
  preview: SendPreviewResponse | null | undefined,
): string | null {
  switch ((preview?.audience_kind ?? "").trim().toLowerCase()) {
    case "segment":
      return "Segment";
    case "list":
      return "List";
    case "workspace":
      return "Whole workspace";
    default:
      return null;
  }
}

export interface SendPreviewSummary {
  /** The number of people who will actually be emailed, when known. */
  deliverable: PreviewCount;
  recipients: PreviewCount;
  suppressed: PreviewCount;
  capRemaining: PreviewCount;
  overCap: boolean;
  /** One sentence stating the real audience, for the confirm sheet. */
  sentence: string;
  /** Non-null when the send would exceed today's sending cap. */
  capWarning: string | null;
}

/**
 * The whole point of the endpoint, compressed to what a confirm sheet needs:
 * "12,483 recipients · 214 suppressed · within today's cap".
 */
export function summarizeSendPreview(
  preview: SendPreviewResponse | null | undefined,
): SendPreviewSummary {
  const recipients = previewCount(preview?.recipients);
  const suppressed = previewCount(preview?.suppressed_excluded);
  const deliverableRaw = previewCount(preview?.deliverable);
  const deliverable =
    deliverableRaw !== null
      ? deliverableRaw
      : recipients !== null && suppressed !== null
        ? Math.max(0, recipients - suppressed)
        : recipients;
  const capRemaining = previewCount(preview?.tier_cap_remaining);
  const overCap = preview?.over_cap === true;

  const parts: string[] = [];
  parts.push(
    deliverable === null
      ? "Recipient count unavailable"
      : plural(deliverable, "recipient"),
  );
  if (suppressed !== null && suppressed > 0) {
    parts.push(`${num(suppressed)} suppressed`);
  }
  if (overCap) {
    parts.push("over today's sending cap");
  } else if (capRemaining !== null) {
    parts.push("within today's cap");
  }

  const capWarning = overCap
    ? capRemaining !== null
      ? `This send exceeds today's sending cap — only ${num(capRemaining)} more message${capRemaining === 1 ? "" : "s"} can go out today. The remainder will be held.`
      : "This send exceeds today's sending cap. The remainder will be held until tomorrow."
    : null;

  return {
    deliverable,
    recipients,
    suppressed,
    capRemaining,
    overCap,
    sentence: parts.join(" · "),
    capWarning,
  };
}

/** True when the preview proves the campaign would reach nobody. */
export function sendPreviewReachesNobody(
  preview: SendPreviewResponse | null | undefined,
): boolean {
  if (!preview) return false;
  const summary = summarizeSendPreview(preview);
  return summary.deliverable === 0;
}

/**
 * The single line the detail screen prints under "Audience".
 *
 * THE CASE THIS EXISTS FOR. When the send-preview read has not answered, the
 * row used to fall back to the campaign's own `list_id` / `segment_id`, and
 * with NEITHER present it printed "Not set — this campaign has no list or
 * segment". Both of those ids are absent on a workspace-wide send, and the
 * read does not answer when it 500s or when the online gate is closed — so a
 * failed fetch, or airplane mode, turned "Everyone in the workspace" into
 * "nobody", directly above the Send button. A claim about the audience made
 * from a lack of signal is the one thing this screen must never do.
 *
 * `unavailable` is that state: the read errored, or never ran.
 */
export function campaignAudienceHeadline(input: {
  preview: SendPreviewResponse | null | undefined;
  loading: boolean;
  unavailable: boolean;
  listId?: string | undefined;
  segmentId?: string | undefined;
}): string {
  if (input.preview) return audienceLabel(input.preview);
  if (input.loading) return "Resolving…";
  // An id is proof an audience is set, whether or not the preview answered.
  if (input.segmentId) return "A segment (open the web app to see which)";
  if (input.listId) return "A list (open the web app to see which)";
  if (input.unavailable) {
    return "Couldn't be read — check the audience on the web app before sending";
  }
  return "Not set — this campaign has no list or segment";
}
