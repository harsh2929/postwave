/**
 * CampaignFeedback — Workstream 2 (B) sidepanel showing the per-
 * campaign comment thread + a new-comment textarea + a "Resolve"
 * action on each unresolved row.
 *
 * Mounted inside the campaign slideover as a collapsed section so it
 * doesn't push the performance panel below the fold. The component
 * owns its own load / mutate state — parents pass only the campaign id.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { usePersistentLifecycleOperation } from "../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
} from "../hooks/useSettingsDraftLifecycle";
import {
  type CampaignFeedback as CampaignFeedbackRow,
  api,
} from "../lib/api-client";
import { SectionHeader } from "./SectionHeader";
import { toast } from "./Toast";

interface Props {
  campaignID: string | number;
  canMutate: boolean;
}

function fmtWhen(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function CampaignFeedback({
  campaignID,
  canMutate,
}: Props): ReactElement {
  const [rows, setRows] = useState<CampaignFeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const mountedRef = useRef(true);
  const canMutateRef = useRef(canMutate);
  const loadSequenceRef = useRef(0);
  const feedbackInputId = useId();
  const operation = usePersistentLifecycleOperation({
    ownerId: `campaign-feedback-${String(campaignID)}`,
    label: "Campaign feedback request",
    detail:
      "Wait for the campaign feedback request to finish before leaving Moosewave.",
  });
  canMutateRef.current = canMutate;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadSequenceRef.current += 1;
    };
  }, []);

  const discardDraft = useCallback((): void => {
    setDraft("");
  }, []);
  useDiscardOnlyDraftLifecycle({
    ownerId: `campaign-feedback-${String(campaignID)}`,
    label: "Campaign feedback draft",
    dirty: draft !== "",
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail:
      "This feedback comment has not been posted. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the campaign feedback request to finish before leaving Moosewave.",
  });

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++loadSequenceRef.current;
    setLoading(true);
    try {
      const res = await api.listCampaignFeedback(campaignID);
      if (!mountedRef.current || requestId !== loadSequenceRef.current) return;
      if (res.error) {
        setErr(res.error.message);
        setRows([]);
      } else {
        setRows(res.data?.items ?? []);
        setErr(null);
      }
    } catch (loadError) {
      if (mountedRef.current && requestId === loadSequenceRef.current) {
        setErr(
          lifecycleOperationError(
            loadError,
            "Campaign feedback could not be loaded.",
          ),
        );
        setRows([]);
      }
    } finally {
      if (mountedRef.current && requestId === loadSequenceRef.current) {
        setLoading(false);
      }
    }
  }, [campaignID]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (): Promise<void> => {
    if (!canMutateRef.current) {
      toast.error("Your current role cannot post campaign feedback.");
      return;
    }
    const body = draft.trim();
    if (!body) return;
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setPosting(true);
    const request = operation.run(async (): Promise<void> => {
      try {
        const res = await api.createCampaignFeedback(campaignID, body);
        if (!mountedRef.current) return;
        if (res.error) {
          toast.error(`Couldn't post: ${res.error.message}`);
          return;
        }
        if (res.data) {
          setRows((prev) => [res.data!, ...prev]);
        }
        setDraft((current) => (current.trim() === body ? "" : current));
      } catch (postError) {
        if (mountedRef.current) {
          toast.error(
            `Couldn't post: ${lifecycleOperationError(
              postError,
              "The feedback request did not complete.",
            )}`,
          );
        }
      } finally {
        if (mountedRef.current) setPosting(false);
      }
    });
    if (request) await request;
  };

  const resolve = async (fid: string): Promise<void> => {
    if (!canMutateRef.current) {
      toast.error("Your current role cannot resolve campaign feedback.");
      return;
    }
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setResolvingId(fid);
    const request = operation.run(async (): Promise<void> => {
      try {
        const res = await api.resolveCampaignFeedback(campaignID, fid);
        if (!mountedRef.current) return;
        if (res.error) {
          toast.error(`Couldn't resolve: ${res.error.message}`);
          return;
        }
        if (res.data) {
          const updated = res.data;
          setRows((prev) => prev.map((r) => (r.id === fid ? updated : r)));
        }
      } catch (resolveError) {
        if (mountedRef.current) {
          toast.error(
            `Couldn't resolve: ${lifecycleOperationError(
              resolveError,
              "The feedback request did not complete.",
            )}`,
          );
        }
      } finally {
        if (mountedRef.current) setResolvingId(null);
      }
    });
    if (request) await request;
  };

  const unresolved = rows.filter((r) => !r.resolved_at);
  const resolved = rows.filter((r) => r.resolved_at);
  const visible = showResolved ? rows : unresolved;

  return (
    <div style={{ marginTop: 16 }}>
      <SectionHeader
        title="Feedback"
        description="Collaborate with reviewers on this draft. Mark items resolved as you address them."
        actions={
          resolved.length > 0 ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setShowResolved((v) => !v)}
            >
              {showResolved
                ? "Hide resolved"
                : `Show resolved (${resolved.length})`}
            </button>
          ) : undefined
        }
      />

      {!canMutate ? (
        <div className="notice" role="status" style={{ marginBottom: 8 }}>
          Feedback is read-only with your current role. Your unposted comment is
          kept so you can copy it or discard it before leaving.
        </div>
      ) : null}

      <div className="field" style={{ marginBottom: 8 }}>
        <label className="visually-hidden" htmlFor={feedbackInputId}>
          New campaign feedback comment
        </label>
        <textarea
          id={feedbackInputId}
          className="input"
          rows={3}
          placeholder="Leave a comment for the team…"
          value={draft}
          onChange={(e) => {
            if (!canMutateRef.current) return;
            setDraft(e.target.value);
          }}
          disabled={operation.active}
          readOnly={!canMutate}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 4,
          }}
        >
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={operation.active || !canMutate || !draft.trim()}
            onClick={() => {
              if (!canMutate) return;
              void submit();
            }}
          >
            {posting ? "Posting…" : "Post comment"}
          </button>
        </div>
      </div>

      {err ? (
        <div className="notice">Couldn&apos;t load feedback: {err}</div>
      ) : null}

      {loading ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Loading comments…
        </div>
      ) : visible.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {unresolved.length === 0 && resolved.length > 0
            ? "All comments resolved."
            : "No comments yet. Be the first to leave feedback."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {visible.map((row) => (
            <div
              key={row.id}
              className="card"
              style={{
                padding: 10,
                opacity: row.resolved_at ? 0.7 : 1,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 4,
                  fontSize: 12,
                }}
              >
                <strong>{row.author_label || "Anonymous"}</strong>
                <span className="muted">·</span>
                <span className="muted">{fmtWhen(row.created_at)}</span>
                {row.resolved_at ? (
                  <span className="badge accent">Resolved</span>
                ) : null}
              </div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
                {row.body}
              </div>
              {!row.resolved_at ? (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    marginTop: 6,
                  }}
                >
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => void resolve(row.id)}
                    disabled={operation.active || !canMutate}
                  >
                    {resolvingId === row.id ? "Resolving…" : "Mark resolved"}
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
