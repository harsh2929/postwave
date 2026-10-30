/**
 * lib/archiveCommentQueue.ts — every decision the archive-comment moderation
 * queue makes, with no React Native import so it is unit-testable in the node
 * vitest environment.
 *
 * The wire shapes and the product framing below are read off the Go source
 * (`apps/api/internal/archive_comments/archive_comments.go`), not off
 * openapi.json. Five server facts shape this module and every one of them is
 * easy to get wrong:
 *
 *  1. COMMENTS PUBLISH THEMSELVES. `PublicPost` calls
 *     `Repo.Insert(…, "visible")` (archive_comments.go:763) — there is no
 *     tenant "require moderation" flag yet, and the package header says so.
 *     So NOTHING ever lands in `pending`, and a queue that opened on Pending
 *     would show an empty screen while spam sat live on the public issue. The
 *     default tab is therefore VISIBLE: the job on a phone is not "approve the
 *     backlog", it is "something is already public — take it down".
 *  2. DELETE CASCADES TO REPLIES. `Repo.Delete` hard-deletes and the FK
 *     cascades (`archive_comments.go:547-551`); the Go comment names the
 *     alternative explicitly — "for remove the comment but keep the reply
 *     tree, flip status to 'hidden'". A confirm sheet that does not say this
 *     is hiding the actual consequence of the tap.
 *  3. THE ADMIN LIST IS FLAT AND CARRIES NO CHILDREN. `Comment.Children` is
 *     populated only by the public tree builder; the moderation projection
 *     leaves it empty (`archive_comments.go:88-90`). A row can say it IS a
 *     reply (it has a parentId) but can never say how many replies it HAS.
 *  4. `total` IS `omitempty`. A zero total is dropped from the JSON entirely,
 *     so "key absent" means zero — but only when the page is also empty.
 *     Absent-with-rows is a shape we do not understand, and that is `null`
 *     (unknown), never 0.
 *  5. THE LIST IS CAPPED, NOT PAGED. `ListForModeration` clamps limit to 200
 *     with no cursor, so `total > items.length` is a real, statable condition
 *     rather than something to page through.
 *
 * The one thing the wire does NOT carry is the issue's name: a moderation row
 * has `campaignId` and nothing else. `issueLabel` therefore takes a lookup
 * built from the archive index and degrades to a truncated id rather than
 * inventing a title.
 */

/** The statuses `validStatus` accepts (archive_comments.go:569-575). */
export const ARCHIVE_COMMENT_STATUSES = [
  "visible",
  "pending",
  "hidden",
  "spam",
] as const;

export type ArchiveCommentStatus = (typeof ARCHIVE_COMMENT_STATUSES)[number];

/**
 * Tab order. Visible first — see fact (1): it is the only tab that can be
 * non-empty on a default deployment, and it is the one holding live text.
 */
export const ARCHIVE_COMMENT_FILTERS = [
  "visible",
  "pending",
  "hidden",
  "spam",
] as const;

export type ArchiveCommentFilter = (typeof ARCHIVE_COMMENT_FILTERS)[number];

export const ARCHIVE_COMMENT_FILTER_LABELS: Record<
  ArchiveCommentFilter,
  string
> = {
  visible: "Live",
  pending: "Pending",
  hidden: "Hidden",
  spam: "Spam",
};

/** `ListForModeration` clamps anything above this back down to 50. */
export const ARCHIVE_COMMENT_LIST_CAP = 200;

export interface MobileArchiveComment {
  id: string;
  campaignId: string;
  /** Non-empty when this row is a reply to another comment. */
  parentId: string;
  /** Non-empty when the author was a signed-in subscriber, not a guest. */
  subscriberId: string;
  displayName: string;
  body: string;
  pinned: boolean;
  status: ArchiveCommentStatus | string;
  upvotes: number;
  downvotes: number;
  createdAt: string | null;
}

export interface ArchiveCommentPage {
  items: readonly MobileArchiveComment[];
  /** `null` = the envelope did not tell us. Never guessed from the page. */
  total: number | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

/** ISO timestamp or null. Go's zero time serialises as "0001-01-01T…". */
function timestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  if (raw.startsWith("0001-01-01")) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

export function parseArchiveComment(
  value: unknown,
): MobileArchiveComment | null {
  const row = record(value);
  const id = str(row["id"]);
  if (!id) return null;
  return {
    id,
    campaignId: str(row["campaignId"]),
    parentId: str(row["parentId"]),
    subscriberId: str(row["subscriberId"]),
    displayName: str(row["displayName"]),
    // Deliberately NOT trimmed to empty-is-null: a blank body is a real (and
    // suspicious) row the moderator still has to be able to see and remove.
    body: typeof row["body"] === "string" ? row["body"] : "",
    pinned: row["pinned"] === true,
    status: str(row["status"]),
    upvotes: count(row["upvotes"]),
    downvotes: count(row["downvotes"]),
    createdAt: timestamp(row["createdAt"]),
  };
}

export function parseArchiveCommentPage(value: unknown): ArchiveCommentPage {
  const envelope = record(value);
  const raw = Array.isArray(envelope["items"]) ? envelope["items"] : [];
  const items = raw
    .map(parseArchiveComment)
    .filter((row): row is MobileArchiveComment => row !== null);
  const totalRaw = envelope["total"];
  let total: number | null;
  if (typeof totalRaw === "number" && Number.isFinite(totalRaw)) {
    total = Math.max(0, Math.round(totalRaw));
  } else if (items.length === 0) {
    // `omitempty` drops a zero total, and a zero total is only possible
    // alongside an empty page. That combination IS the number zero.
    total = 0;
  } else {
    total = null;
  }
  return { items, total };
}

/**
 * Ordering. The server returns `created_at DESC` for every filter
 * (`ListForModeration` … `ORDER BY created_at DESC`).
 *
 * Newest-first is right for the LIVE tab — you are checking what just landed
 * on a public page — and for the two archives of decisions already made. It is
 * wrong for a review queue, which starves the oldest item, so `pending` (which
 * only exists once a deployment gains a pre-moderation flag) flips.
 */
export function orderForFilter(
  rows: readonly MobileArchiveComment[],
  filter: ArchiveCommentFilter,
): MobileArchiveComment[] {
  const copy = [...rows];
  if (filter !== "pending") return copy;
  return copy.sort((a, b) => {
    const at = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
    return at - bt;
  });
}

export interface StatusPresentation {
  label: string;
  tone: "success" | "warning" | "neutral" | "danger";
  /** A sentence, because a pill's word alone is not the state. */
  spoken: string;
}

export function commentStatusPresentation(status: string): StatusPresentation {
  switch (status) {
    case "visible":
      return {
        label: "Live",
        tone: "success",
        spoken: "Live on the published issue",
      };
    case "pending":
      return {
        label: "Pending",
        tone: "warning",
        spoken: "Pending — not shown to readers yet",
      };
    case "hidden":
      return {
        label: "Hidden",
        tone: "neutral",
        spoken: "Hidden from readers",
      };
    case "spam":
      return { label: "Spam", tone: "danger", spoken: "Marked as spam" };
    default:
      return {
        label: status || "Unknown",
        tone: "neutral",
        spoken: status
          ? `Unrecognised status ${status}`
          : "Status missing from the server",
      };
  }
}

/**
 * Who wrote it. `displayName` is required on the guest path and taken from the
 * subscriber record otherwise, but a row written before that validation can
 * still be blank — and an anonymous row is exactly the kind this screen exists
 * to remove, so it must render rather than disappear.
 */
export function authorLabel(comment: MobileArchiveComment): string {
  return comment.displayName || "Unnamed";
}

/**
 * Guest vs subscriber. This is evidence, not decoration: a guest comment
 * carries no identity the workspace can act on, which is what makes a run of
 * them the signature of a spam wave.
 */
export function authorOrigin(comment: MobileArchiveComment): string {
  return comment.subscriberId ? "Subscriber" : "Guest";
}

/** Collapses newlines so a row preview cannot be padded off-screen. */
export function commentPreview(body: string, max = 180): string {
  const flat = body.replace(/\s+/gu, " ").trim();
  if (!flat) return "";
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Net vote score. Public sort is `(upvotes - downvotes) DESC` for "best". */
export function voteScore(comment: MobileArchiveComment): number {
  return comment.upvotes - comment.downvotes;
}

export function voteLabel(comment: MobileArchiveComment): string {
  const score = voteScore(comment);
  const sign = score > 0 ? `+${score}` : `${score}`;
  return `${sign} · ${comment.upvotes} up, ${comment.downvotes} down`;
}

/**
 * The issue a comment belongs to. The moderation projection carries only a
 * campaign UUID, so a name is available exactly when the archive index has
 * been read and still contains that issue. Never invent one.
 */
export function issueLabel(
  campaignId: string,
  titles: ReadonlyMap<string, string> | null | undefined,
): string {
  if (!campaignId) return "Issue unknown";
  const title = titles?.get(campaignId);
  if (title) return title;
  return `Issue ${middleTruncate(campaignId)}`;
}

function middleTruncate(value: string, max = 13): string {
  if (value.length <= max) return value;
  const keep = Math.max(3, Math.floor((max - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

/** The verbs this screen offers. `restore` is a moderate() to "visible". */
export type ArchiveCommentAction =
  | "hide"
  | "spam"
  | "restore"
  | "pin"
  | "unpin"
  | "delete";

/**
 * Which verbs make sense for a row. Pin is deliberately withheld from
 * anything that is not live: pinning floats a comment to the top of the
 * PUBLIC thread, and pinning something readers cannot see is a no-op dressed
 * up as an action.
 */
export function actionsForComment(
  comment: MobileArchiveComment,
): ArchiveCommentAction[] {
  const actions: ArchiveCommentAction[] = [];
  if (comment.status === "visible") {
    actions.push(comment.pinned ? "unpin" : "pin", "hide", "spam");
  } else {
    actions.push("restore");
    if (comment.status !== "spam") actions.push("spam");
    if (comment.status !== "hidden") actions.push("hide");
  }
  actions.push("delete");
  return actions;
}

/** The moderate() status each verb sends; `null` for the non-status verbs. */
export function statusForAction(
  action: ArchiveCommentAction,
): ArchiveCommentStatus | null {
  if (action === "hide") return "hidden";
  if (action === "spam") return "spam";
  if (action === "restore") return "visible";
  return null;
}

export interface ModerationCopy {
  title: string;
  message: string;
  consequence: string;
  confirmLabel: string;
  destructive: boolean;
}

export function moderationCopy(
  action: ArchiveCommentAction,
  comment: MobileArchiveComment,
): ModerationCopy {
  const who = authorLabel(comment);
  switch (action) {
    case "hide":
      return {
        title: `Hide ${who}'s comment?`,
        message:
          "It disappears from the published issue immediately. Replies underneath it are kept.",
        consequence: "You can put it back from the Hidden tab.",
        confirmLabel: "Hide",
        destructive: false,
      };
    case "spam":
      return {
        title: `Mark ${who}'s comment as spam?`,
        message:
          "It disappears from the published issue immediately and is filed under Spam.",
        consequence: "You can put it back from the Spam tab.",
        confirmLabel: "Mark spam",
        destructive: false,
      };
    case "restore":
      return {
        title: `Put ${who}'s comment back?`,
        message: "It becomes visible to everyone reading the published issue.",
        consequence: "This publishes a stranger's words on your archive page.",
        confirmLabel: "Make live",
        destructive: false,
      };
    case "pin":
      return {
        title: `Pin ${who}'s comment?`,
        message: "Pinned comments sit at the top of the public thread.",
        consequence: "Readers see this first.",
        confirmLabel: "Pin",
        destructive: false,
      };
    case "unpin":
      return {
        title: "Unpin this comment?",
        message: "It returns to its place in the thread.",
        consequence: "",
        confirmLabel: "Unpin",
        destructive: false,
      };
    case "delete":
    default:
      return {
        title: `Delete ${who}'s comment?`,
        message:
          "Deleting is permanent, and it takes every reply underneath it with it.",
        consequence:
          "To take the comment down without losing the thread, hide it instead.",
        confirmLabel: "Delete",
        destructive: true,
      };
  }
}

export function moderationSuccessMessage(
  action: ArchiveCommentAction,
  comment: MobileArchiveComment,
): string {
  const who = authorLabel(comment);
  switch (action) {
    case "hide":
      return `Hidden. ${who}'s comment is off the published issue.`;
    case "spam":
      return `Marked as spam. ${who}'s comment is off the published issue.`;
    case "restore":
      return `Live. ${who}'s comment is back on the published issue.`;
    case "pin":
      return "Pinned to the top of the thread.";
    case "unpin":
      return "Unpinned.";
    case "delete":
    default:
      return `Deleted. ${who}'s comment and its replies are gone.`;
  }
}

/**
 * Whether the page we hold is a truncated view of the filter. Requires a real
 * total — with `total === null` we do not know, and saying "showing 200 of
 * 200" would be a claim the server never made.
 */
export function truncationNotice(page: ArchiveCommentPage): string | null {
  if (page.total === null) return null;
  if (page.total <= page.items.length) return null;
  return `Showing the ${page.items.length} newest of ${page.total}. The server caps this list and offers no further pages — filter by issue on desktop to reach the rest.`;
}

/**
 * The line the LIVE tab needs and no other surface says: on a default
 * deployment comments go straight to `visible`, so this list is not a backlog
 * waiting for approval, it is what readers can see right now.
 */
export const LIVE_TAB_NOTE =
  "Comments publish the moment they are posted — there is no approval step yet. Everything here is already on your public issue.";

/** Message for a failed verb, keyed on the status the round trip returned. */
export function moderationFailureMessage(status: number | undefined): string {
  if (status === 403) {
    return "Moderating comments needs an owner or admin role on this workspace.";
  }
  if (status === 404) return "That comment is no longer there.";
  if (status === 401) return "Your session expired. Sign in again.";
  return "Please try again.";
}
