/**
 * CampaignRepliesSection (G3 of the campaigns 2026 pack)
 *
 * Reply-loop view threaded against one campaign. Lists inbound emails
 * whose In-Reply-To matched the campaign's outbound Message-ID — the
 * backend join is already in place via inbound_emails.campaign_id; we
 * just surface the rows in the slideover so the operator stops
 * needing to dig through the Inbox.
 *
 * Ships the read view, clickable intent-filter tabs (question / praise
 * / unsub / ooo / other, backed by the ?intent= list param), and the
 * on-demand Classify action. The "Quote a reader reply" editor block
 * lives in DynamicContentPanel via ReplyQuotePicker.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { toast } from "./Toast";
import { type CampaignReply, api } from "../lib/api-client";
import { Notice } from "./Notice";

interface Props {
  campaignId: string | number;
  canAdmin: boolean;
  canMutate: boolean;
}

function fmtRel(s: string | undefined): string {
  if (!s) return "—";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

/** Trim to the first sentence/paragraph for the preview pane. */
function previewBody(text: string): string {
  if (!text) return "";
  const trimmed = text.trim().slice(0, 320);
  return trimmed.length === text.trim().length ? trimmed : `${trimmed}…`;
}

/** Fixed display order for the intent filter tabs. */
const INTENT_ORDER = ["question", "praise", "unsub", "ooo", "other"] as const;

export function CampaignRepliesSection({
  campaignId,
  canAdmin,
  canMutate,
}: Props): ReactElement {
  if (!canAdmin) {
    return (
      <div className="campaign-replies-section" style={{ marginTop: 16 }}>
        <div className="label">Replies</div>
        <Notice tone="warning" title="Reply content is restricted">
          Raw replies can contain private correspondence and direct identifiers.
          Until a least-privilege reply permission exists, only workspace admins
          can load this section.
        </Notice>
      </div>
    );
  }
  return (
    <AdminCampaignRepliesSection
      campaignId={campaignId}
      canMutate={canMutate}
    />
  );
}

function AdminCampaignRepliesSection({
  campaignId,
  canMutate,
}: {
  campaignId: string | number;
  canMutate: boolean;
}): ReactElement {
  const [replies, setReplies] = useState<CampaignReply[]>([]);
  // Unfiltered intent counts drive the filter tab headers; they stay
  // stable when a filter narrows the visible rows.
  const [allIntentCounts, setAllIntentCounts] = useState<
    Record<string, number>
  >({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadedCampaignKey, setLoadedCampaignKey] = useState<string | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);
  const [classifying, setClassifying] = useState<string | null>(null);
  const [classifyError, setClassifyError] = useState<string | null>(null);
  const campaignKey = String(campaignId);
  const [intentFilter, setIntentFilter] = useState<{
    campaignKey: string;
    intent: string | null;
  }>(() => ({ campaignKey, intent: null }));
  const activeIntent =
    intentFilter.campaignKey === campaignKey ? intentFilter.intent : null;
  const activeRef = useRef(true);
  const loadedCampaignKeyRef = useRef<string | null>(null);
  const loadBusyRef = useRef(false);
  const loadSeqRef = useRef(0);
  const classifyBusyRef = useRef(false);
  const classifySeqRef = useRef(0);
  const canMutateRef = useRef(canMutate);
  canMutateRef.current = canMutate;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      loadSeqRef.current += 1;
      classifySeqRef.current += 1;
      loadBusyRef.current = false;
      classifyBusyRef.current = false;
    };
  }, []);

  const loadReplies = useCallback(async (): Promise<void> => {
    if (loadBusyRef.current) return;
    loadBusyRef.current = true;
    const request = ++loadSeqRef.current;
    classifySeqRef.current += 1;
    classifyBusyRef.current = false;
    setLoading(true);
    setErr(null);
    setClassifying(null);
    setClassifyError(null);
    setReplies([]);
    if (loadedCampaignKeyRef.current !== campaignKey) {
      setTotal(0);
      setAllIntentCounts({});
    }
    if (!activeIntent) {
      if (loadedCampaignKeyRef.current !== campaignKey) {
        setTotal(0);
        setAllIntentCounts({});
      }
    }
    try {
      const result = await api.listCampaignReplies(campaignId, {
        intent: activeIntent ?? undefined,
      });
      if (!activeRef.current || request !== loadSeqRef.current) return;
      if (result.error) {
        setErr(result.error.message);
        return;
      }
      setReplies(result.data.replies);
      // Only the unfiltered fetch refreshes the tab counts.
      if (!activeIntent) {
        setTotal(result.data.count);
        setAllIntentCounts(result.data.intent_counts ?? {});
      }
    } catch (error) {
      if (activeRef.current && request === loadSeqRef.current) {
        setErr(
          error instanceof Error && error.message
            ? error.message
            : "Campaign replies could not be loaded.",
        );
      }
    } finally {
      if (activeRef.current && request === loadSeqRef.current) {
        loadBusyRef.current = false;
        loadedCampaignKeyRef.current = campaignKey;
        setLoadedCampaignKey(campaignKey);
        setLoading(false);
      }
    }
  }, [activeIntent, campaignId, campaignKey]);

  useEffect(() => {
    loadSeqRef.current += 1;
    loadBusyRef.current = false;
    void loadReplies();
  }, [loadReplies]);

  const classify = async (reply: CampaignReply): Promise<void> => {
    if (!canMutateRef.current) {
      toast.error({
        message: "Couldn't classify reply",
        detail: "Your current role cannot change reply classifications.",
      });
      return;
    }
    if (classifyBusyRef.current) return;
    classifyBusyRef.current = true;
    const request = ++classifySeqRef.current;
    const replyId = reply.id;
    setClassifying(reply.id);
    setClassifyError(null);
    try {
      const result = await api.classifyCampaignReply(campaignId, replyId);
      if (!activeRef.current || request !== classifySeqRef.current) return;
      if (result.error) {
        setClassifyError(result.error.message);
        toast.error({
          message: "Couldn't classify reply",
          detail: result.error.message,
        });
        return;
      }
      setReplies((current) =>
        current.map((item) => (item.id === replyId ? result.data : item)),
      );
      if (result.data.intent_label) {
        setAllIntentCounts((current) => ({
          ...current,
          [result.data.intent_label as string]:
            (current[result.data.intent_label as string] ?? 0) + 1,
        }));
      }
    } catch (error) {
      if (activeRef.current && request === classifySeqRef.current) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Reply classification failed.";
        setClassifyError(message);
        toast.error({ message: "Couldn't classify reply", detail: message });
      }
    } finally {
      if (activeRef.current && request === classifySeqRef.current) {
        classifyBusyRef.current = false;
        setClassifying(null);
      }
    }
  };

  const changeIntent = (intent: string | null): void => {
    setIntentFilter({ campaignKey, intent });
  };

  if (loading && loadedCampaignKey !== campaignKey) {
    return (
      <div
        className="campaign-replies-section"
        style={{ marginTop: 16 }}
        role="status"
        aria-live="polite"
      >
        <div className="label">Replies</div>
        <div className="skel" style={{ height: 40 }} />
        <span className="visually-hidden">Loading campaign replies…</span>
      </div>
    );
  }

  if (err && !activeIntent) {
    return (
      <div className="campaign-replies-section" style={{ marginTop: 16 }}>
        <div className="label">Replies</div>
        <Notice
          tone="danger"
          announcement="assertive"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void loadReplies()}
            >
              Retry
            </button>
          }
        >
          Reply list unavailable: {err}
        </Notice>
      </div>
    );
  }

  // Truly empty (no replies at all, no filter): the onboarding hint.
  if (!loading && replies.length === 0 && !activeIntent) {
    return (
      <div className="campaign-replies-section" style={{ marginTop: 16 }}>
        <div className="label">Replies</div>
        <div className="muted" style={{ fontSize: 12 }}>
          No replies yet. Replies show up here when subscribers respond to this
          campaign (matched via the outbound Message-ID).
        </div>
      </div>
    );
  }

  const intentTabs = INTENT_ORDER.filter((k) => (allIntentCounts[k] ?? 0) > 0);

  return (
    <div className="campaign-replies-section" style={{ marginTop: 16 }}>
      <div
        className="label"
        style={{ display: "flex", alignItems: "center", gap: 8 }}
      >
        Replies
        <span
          className="muted tabular"
          style={{ fontWeight: 400, fontSize: 11 }}
        >
          · {total} total {total === 1 ? "reply" : "replies"}
        </span>
      </div>

      {intentTabs.length > 0 ? (
        <div
          role="group"
          aria-label="Reply intent filter"
          style={{ display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" }}
        >
          <button
            type="button"
            className={`badge${activeIntent === null ? " accent" : ""}`}
            style={{ cursor: "pointer", border: "none" }}
            onClick={() => changeIntent(null)}
            aria-pressed={activeIntent === null}
          >
            All
          </button>
          {intentTabs.map((label) => (
            <button
              key={label}
              type="button"
              className={`badge${activeIntent === label ? " accent" : ""}`}
              style={{ cursor: "pointer", border: "none" }}
              onClick={() => changeIntent(label)}
              aria-pressed={activeIntent === label}
            >
              {label} · {allIntentCounts[label]}
            </button>
          ))}
        </div>
      ) : null}

      {loading ? (
        <div
          className="muted"
          style={{ fontSize: 12, marginTop: 8 }}
          role="status"
          aria-live="polite"
        >
          Loading {activeIntent ? `${activeIntent} ` : ""}replies…
        </div>
      ) : replies.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          No {activeIntent} replies.
        </div>
      ) : null}

      {!loading && replies.length > 0 ? (
        <CampaignReplyList
          replies={replies}
          classifying={classifying}
          canMutate={canMutate}
          onClassify={classify}
        />
      ) : null}
      {err && activeIntent ? (
        <Notice
          tone="danger"
          announcement="assertive"
          style={{ marginTop: 8 }}
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void loadReplies()}
            >
              Retry filter
            </button>
          }
        >
          Couldn&apos;t load {activeIntent} replies: {err}
        </Notice>
      ) : null}
      {classifyError ? (
        <div className="field-error" role="alert" style={{ marginTop: 6 }}>
          Couldn&apos;t classify the reply: {classifyError}
        </div>
      ) : null}
      {!canMutate && replies.some((reply) => !reply.intent_label) ? (
        <div className="muted" role="status" style={{ marginTop: 6 }}>
          Reply classification is read-only with your current role.
        </div>
      ) : null}
    </div>
  );
}

function CampaignReplyList({
  replies,
  classifying,
  canMutate,
  onClassify,
}: {
  replies: CampaignReply[];
  classifying: string | null;
  canMutate: boolean;
  onClassify: (reply: CampaignReply) => Promise<void>;
}): ReactElement {
  return (
    <ul
      className="campaign-replies-list"
      style={{
        margin: "8px 0 0",
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        maxHeight: 360,
        overflowY: "auto",
        padding: 0,
        listStyle: "none",
      }}
    >
      {replies.map((reply, index) => (
        <li
          key={reply.id}
          style={{
            padding: "10px 12px",
            borderTop: index > 0 ? "1px solid var(--pw-border)" : undefined,
            fontSize: 13,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <div
              className="mono"
              style={{ fontSize: 12, overflowWrap: "anywhere" }}
            >
              {reply.from_email}
            </div>
            <time
              className="muted tabular"
              style={{ fontSize: 11, whiteSpace: "nowrap" }}
              dateTime={reply.received_at}
            >
              {fmtRel(reply.received_at)}
            </time>
          </div>
          {reply.subject ? (
            <div
              style={{
                fontWeight: 500,
                marginTop: 4,
                overflowWrap: "anywhere",
              }}
            >
              {reply.subject}
            </div>
          ) : null}
          <div
            className="muted"
            style={{ marginTop: 4, fontSize: 12, whiteSpace: "pre-wrap" }}
          >
            {previewBody(reply.body_text)}
          </div>
          {reply.intent_label ? (
            <span className="badge" style={{ marginTop: 6, fontSize: 10 }}>
              Intent: {reply.intent_label}
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ marginTop: 6 }}
              disabled={classifying !== null || !canMutate}
              onClick={() => {
                if (!canMutate) return;
                void onClassify(reply);
              }}
            >
              {classifying === reply.id ? "Classifying…" : "Classify"}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
