/**
 * CommentsModerationCard — admin moderation dashboard for the
 * archive-comments-threaded feature (P2). Renders alongside the
 * Archive issues list so an operator can see incoming comments,
 * triage by status, and pin/hide/spam/delete inline.
 *
 * Inspired by 2026 SOTA:
 *   - Ghost (Members → Comments admin tab: status tabs + bulk approve)
 *   - Buttondown (Comments admin: per-issue moderation queue)
 *   - Substack (Notes moderation: pin/hide/report-spam toolbar)
 *
 * Backend surface (apps/api/internal/archive_comments):
 *   GET   /api/v1/archive/comments?status=&campaignId=&limit=
 *   POST  /api/v1/archive/comments/{id}/moderate     {status}
 *   POST  /api/v1/archive/comments/{id}/pin
 *   POST  /api/v1/archive/comments/{id}/unpin
 *   DEL   /api/v1/archive/comments/{id}
 *
 * The card is unconditionally rendered — there's no "comments
 * disabled" tenant flag yet (a follow-up will add one to
 * tenant_public_settings). When no comments exist, the body
 * collapses to an empty-state hint so the card doesn't dominate
 * the page.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { ConfirmModal } from "../ConfirmModal";
import { ChoiceGroup } from "../ChoiceGroup";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import { type ArchiveComment, api } from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";

/** Order of tabs on the moderation header. "pending" is first
 *  because it's the only status that requires operator action;
 *  the rest are reference views (visible = published, hidden /
 *  spam = soft-removed). */
const STATUS_TABS: Array<{
  key: "pending" | "visible" | "hidden" | "spam";
  label: string;
}> = [
  { key: "pending", label: "Pending" },
  { key: "visible", label: "Visible" },
  { key: "hidden", label: "Hidden" },
  { key: "spam", label: "Spam" },
];

interface Props {
  /** Optional campaign id filter — when set, the card scopes its
   *  list to that single issue. Used by the per-issue slideover
   *  view; the standalone "Comments" tab on the Archive page leaves
   *  this undefined to show every issue's queue. */
  campaignId?: string;
  /** Auto-refresh interval in ms. Defaults to 30s — comments are
   *  not a hot-path surface so polling rather than SSE is fine.
   *  Set to 0 to disable polling (test harness). */
  pollIntervalMs?: number;
}

export function CommentsModerationCard({
  campaignId,
  pollIntervalMs = 30000,
}: Props): ReactElement {
  const [status, setStatus] = useState<
    "pending" | "visible" | "hidden" | "spam"
  >("pending");
  const [items, setItems] = useState<ArchiveComment[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ArchiveComment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(
    async (which: typeof status) => {
      setLoading(true);
      const res = await api.listArchiveComments({
        status: which,
        campaignId,
        limit: 100,
      });
      setLoading(false);
      if (res.error) {
        setErr(res.error.message);
        return;
      }
      setErr(null);
      setItems(res.data?.items ?? []);
      // Stash the count for the active tab so the badge stays fresh
      // without re-fetching every tab on every poll. Other tabs'
      // counts populate lazily as the user clicks through.
      setCounts((prev) => ({ ...prev, [which]: res.data?.total ?? 0 }));
    },
    [campaignId],
  );

  useEffect(() => {
    void load(status);
  }, [status, load]);

  useEffect(() => {
    if (!pollIntervalMs) return;
    const id = setInterval(() => {
      void load(status);
    }, pollIntervalMs);
    return () => clearInterval(id);
  }, [status, pollIntervalMs, load]);

  const handleModerate = useCallback(
    async (id: string, next: "visible" | "hidden" | "spam") => {
      const res = await api.moderateArchiveComment(id, next);
      if (res.error) {
        toast.error(`Could not update comment: ${res.error.message}`);
        return;
      }
      toast.success(`Comment moved to ${next}`);
      void load(status);
    },
    [load, status],
  );

  const handleTogglePin = useCallback(
    async (c: ArchiveComment) => {
      const res = c.pinned
        ? await api.unpinArchiveComment(c.id)
        : await api.pinArchiveComment(c.id);
      if (res.error) {
        toast.error(`Pin toggle failed: ${res.error.message}`);
        return;
      }
      toast.success(c.pinned ? "Unpinned" : "Pinned to top");
      void load(status);
    },
    [load, status],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const res = await api.deleteArchiveComment(deleteTarget.id);
    setDeleting(false);
    if (res.error) {
      toast.error(`Delete failed: ${res.error.message}`);
      return;
    }
    toast.success("Comment deleted");
    setDeleteTarget(null);
    void load(status);
  }, [deleteTarget, load, status]);

  const handleDelete = useCallback((comment: ArchiveComment) => {
    setDeleteTarget(comment);
  }, []);

  const closeDeleteConfirm = useCallback(() => {
    if (deleting) return;
    setDeleteTarget(null);
  }, [deleting]);

  const empty = !loading && items !== null && items.length === 0;

  return (
    <section className="card">
      <SectionHeader
        title="Comment moderation"
        description="Triage incoming threaded comments from your public archive issues."
      />

      <ChoiceGroup
        legend="Comment status"
        value={status}
        onChange={setStatus}
        className="comment-status-choice"
        optionClassName="btn"
        style={{
          display: "flex",
          gap: 6,
          padding: "0 16px 12px",
          borderBottom: "1px solid var(--pw-border)",
        }}
        options={STATUS_TABS.map((tab) => {
          const active = tab.key === status;
          const count = counts[tab.key];
          return {
            value: tab.key,
            className: active ? "btn-primary" : undefined,
            label: (
              <>
              {tab.label}
              {typeof count === "number" && count > 0 ? (
                <span
                  aria-label={`${count} ${tab.label.toLowerCase()}`}
                  style={{
                    marginLeft: 8,
                    padding: "1px 6px",
                    borderRadius: 999,
                    background: active
                      ? "color-mix(in srgb, var(--pw-bg-elev-2) 25%, transparent)"
                      : "var(--pw-bg-elev-2)",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  {count}
                </span>
              ) : null}
              </>
            ),
          };
        })}
      />

      <div style={{ padding: 16 }}>
        {err ? (
          <div role="alert" className="alert alert-danger">
            {err}
          </div>
        ) : null}
        {loading && items === null ? (
          <p className="muted">Loading comments…</p>
        ) : null}
        {empty ? (
          <EmptyHint status={status} />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {(items ?? []).map((c) => (
              <ModerationRow
                key={c.id}
                comment={c}
                status={status}
                onModerate={(...args) => void handleModerate(...args)}
                onTogglePin={(comment) => void handleTogglePin(comment)}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        )}
      </div>
      <ConfirmModal
        key={deleteTarget?.id ?? "archive-comment-delete"}
        open={!!deleteTarget}
        title="Delete comment?"
        description="This removes the comment and its replies from the public archive."
        confirmLabel="Delete comment"
        danger
        busy={deleting}
        onClose={closeDeleteConfirm}
        onConfirm={confirmDelete}
      >
        {deleteTarget ? (
          <p className="muted" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {deleteTarget.body}
          </p>
        ) : null}
      </ConfirmModal>
    </section>
  );
}

interface RowProps {
  comment: ArchiveComment;
  status: "pending" | "visible" | "hidden" | "spam";
  onModerate: (id: string, next: "visible" | "hidden" | "spam") => void;
  onTogglePin: (c: ArchiveComment) => void;
  onDelete: (comment: ArchiveComment) => void;
}

function ModerationRow({
  comment,
  status,
  onModerate,
  onTogglePin,
  onDelete,
}: RowProps): ReactElement {
  // Score is exposed because the smart-sort default ("best") uses it,
  // so operators can sanity-check why a particular comment is at the
  // top of the public thread.
  const score = comment.upvotes - comment.downvotes;
  return (
    <li
      style={{
        padding: "12px 0",
        borderBottom: "1px solid var(--pw-border)",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <strong>{comment.displayName || "Anonymous"}</strong>
          {comment.pinned ? (
            <span className="pill pill-info" title="Pinned to top of thread">
              Pinned
            </span>
          ) : null}
          {comment.parentId ? (
            <span className="pill pill-muted" title="Reply to another comment">
              Reply
            </span>
          ) : null}
          <span className="muted" style={{ fontSize: 12 }}>
            {fmtDate(comment.createdAt)}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            +{comment.upvotes} / −{comment.downvotes} · score {score}
          </span>
        </div>
        <p
          style={{
            margin: "6px 0 0",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {comment.body}
        </p>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          flexShrink: 0,
        }}
      >
        {status !== "visible" ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onModerate(comment.id, "visible")}
          >
            Approve
          </button>
        ) : null}
        {status !== "hidden" ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onModerate(comment.id, "hidden")}
          >
            Hide
          </button>
        ) : null}
        {status !== "spam" ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onModerate(comment.id, "spam")}
          >
            Spam
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onTogglePin(comment)}
        >
          {comment.pinned ? "Unpin" : "Pin"}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => onDelete(comment)}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function EmptyHint({
  status,
}: {
  status: "pending" | "visible" | "hidden" | "spam";
}): ReactElement {
  const copy = useMemo(() => {
    switch (status) {
      case "pending":
        return "No comments are awaiting moderation right now.";
      case "visible":
        return "No comments have been posted on your public issues yet.";
      case "hidden":
        return "You haven't hidden any comments.";
      case "spam":
        return "No comments have been flagged as spam.";
    }
  }, [status]);
  return (
    <p className="muted" style={{ margin: 0 }}>
      {copy}
    </p>
  );
}
