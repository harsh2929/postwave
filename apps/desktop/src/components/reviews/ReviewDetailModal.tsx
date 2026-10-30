import {
  type ReactElement,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type Review,
  type ReviewPublicReply,
  reviewsApi,
} from "../../lib/api-client";
import { fmtDateTime } from "../../lib/format-date";
import {
  type RemoteApiError,
  type RemoteFailure,
  remoteFailureFromError,
} from "../../lib/remote-resource";
import {
  REVIEW_REPLY_MAX_CHARS,
  isReviewDecidable,
  parseReviewDetail,
  statusBadgeClass,
  statusLabel,
} from "../../lib/reviews-helpers";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { Notice } from "../Notice";
import { toast } from "../Toast";
import { Stars } from "./Stars";

type DetailTransport = "idle" | "loading" | "ready" | "error";
type DecisionIntent = "publish" | "reject";
type MutationKind = DecisionIntent | "reply";

interface DetailState {
  identity: string | null;
  record: Review | null;
  transport: DetailTransport;
  failure: RemoteFailure | null;
}

export interface ReviewDetailModalProps {
  open: boolean;
  review: Review | null;
  canAdmin: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDecision: (updated: Review) => void;
}

interface ReviewActions {
  mutation: MutationKind | null;
  failure: string | null;
  decisionIntent: DecisionIntent | null;
  replyOpen: boolean;
  replyDraft: string;
  replyPreview: string | null;
  setDecisionIntent: (intent: DecisionIntent | null) => void;
  setReplyOpen: (open: boolean) => void;
  setReplyDraft: (value: string) => void;
  prepareReply: () => void;
  closeReplyPreview: () => void;
  confirmDecision: () => Promise<void>;
  confirmReply: () => Promise<void>;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPublicReply(value: unknown): value is ReviewPublicReply {
  if (!value || typeof value !== "object") return false;
  const reply = value as Record<string, unknown>;
  return (
    typeof reply.body === "string" &&
    Array.from(reply.body.trim()).length > 0 &&
    Array.from(reply.body.trim()).length <= REVIEW_REPLY_MAX_CHARS &&
    nonEmptyText(reply.status) === "published" &&
    (reply.author === undefined || typeof reply.author === "string") &&
    (reply.created_at === undefined || typeof reply.created_at === "string")
  );
}

function verifiedReviewDetail(
  value: unknown,
  expectedId: string,
): Review | null {
  const parsed = parseReviewDetail(value).review;
  return parsed?.id === expectedId ? parsed : null;
}

function safeFailure(error: RemoteApiError): RemoteFailure {
  return remoteFailureFromError(error);
}

function parseFailure(): RemoteFailure {
  return safeFailure({ kind: "parse" });
}

function detailDisplayState(
  state: DetailState,
  snapshot: Review | null,
): Pick<DetailState, "record" | "transport" | "failure"> {
  const snapshotId = nonEmptyText(snapshot?.id);
  if (state.identity === snapshotId) {
    return { ...state, record: state.record ?? snapshot };
  }
  return {
    record: snapshot,
    transport: snapshotId ? "loading" : "error",
    failure: parseFailure(),
  };
}

function useReviewDetail(
  open: boolean,
  snapshot: Review | null,
): {
  state: DetailState;
  retry: () => void;
  replaceRecord: (updated: Review) => void;
  appendReply: (reply: ReviewPublicReply) => void;
} {
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [state, setState] = useState<DetailState>({
    identity: null,
    record: null,
    transport: "idle",
    failure: null,
  });
  const requestGeneration = useRef(0);
  const mounted = useRef(false);
  const snapshotId = nonEmptyText(snapshot?.id);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    if (!open) {
      setState({
        identity: null,
        record: null,
        transport: "idle",
        failure: null,
      });
      return;
    }
    if (!snapshotId) {
      setState({
        identity: null,
        record: null,
        transport: "error",
        failure: parseFailure(),
      });
      return;
    }

    setState({
      identity: snapshotId,
      record: null,
      transport: "loading",
      failure: null,
    });
    void Promise.resolve()
      .then(() => reviewsApi.get(snapshotId))
      .then((result) => {
        if (!mounted.current || generation !== requestGeneration.current) {
          return;
        }
        if (result.error) {
          setState({
            identity: snapshotId,
            record: null,
            transport: "error",
            failure: safeFailure(result.error),
          });
          return;
        }
        const detail = verifiedReviewDetail(result.data, snapshotId);
        if (!detail) {
          setState({
            identity: snapshotId,
            record: null,
            transport: "error",
            failure: parseFailure(),
          });
          return;
        }
        setState({
          identity: snapshotId,
          record: detail,
          transport: "ready",
          failure: null,
        });
      })
      .catch(() => {
        if (!mounted.current || generation !== requestGeneration.current) {
          return;
        }
        setState({
          identity: snapshotId,
          record: null,
          transport: "error",
          failure: safeFailure({ kind: "network" }),
        });
      });
  }, [open, retryGeneration, snapshotId]);

  const replaceRecord = (updated: Review): void => {
    setState((previous) => ({
      identity: updated.id,
      record: {
        ...updated,
        public_replies:
          updated.public_replies ?? previous.record?.public_replies,
      },
      transport: "ready",
      failure: null,
    }));
  };

  const appendReply = (reply: ReviewPublicReply): void => {
    setState((previous) => {
      if (!previous.record) return previous;
      return {
        ...previous,
        record: {
          ...previous.record,
          public_replies: [...(previous.record.public_replies ?? []), reply],
        },
      };
    });
  };

  return {
    state,
    retry: () => setRetryGeneration((value) => value + 1),
    replaceRecord,
    appendReply,
  };
}

function actionFailure(error: RemoteApiError, action: string): string {
  const failure = safeFailure(error);
  return `${action} ${failure.message}`;
}

function useReviewActions({
  open,
  record,
  canAdmin,
  replaceRecord,
  appendReply,
  onDecision,
}: {
  open: boolean;
  record: Review | null;
  canAdmin: boolean;
  replaceRecord: (updated: Review) => void;
  appendReply: (reply: ReviewPublicReply) => void;
  onDecision: (updated: Review) => void;
}): ReviewActions {
  const [mutation, setMutation] = useState<MutationKind | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [decisionIntent, setDecisionIntent] = useState<DecisionIntent | null>(
    null,
  );
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyPreview, setReplyPreview] = useState<string | null>(null);
  const mutationGuard = useRef(false);
  const mounted = useRef(false);
  const activeId = useRef<string | null>(null);
  activeId.current = open ? nonEmptyText(record?.id) : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setFailure(null);
    setDecisionIntent(null);
    setReplyOpen(false);
    setReplyDraft("");
    setReplyPreview(null);
  }, [open, record?.id]);

  const finish = (): void => {
    mutationGuard.current = false;
    if (mounted.current) setMutation(null);
  };

  const reportUnexpectedFailure = (id: string, action: string): void => {
    if (mounted.current && activeId.current === id) {
      const message = actionFailure({ kind: "network" }, action);
      setFailure(message);
      toast.error(message);
    }
  };

  const confirmDecision = async (): Promise<void> => {
    const intent = decisionIntent;
    const id = nonEmptyText(record?.id);
    if (
      mutationGuard.current ||
      !intent ||
      !id ||
      !canAdmin ||
      !record ||
      !isReviewDecidable(record)
    ) {
      return;
    }
    mutationGuard.current = true;
    setMutation(intent);
    setFailure(null);
    try {
      let result;
      try {
        result =
          intent === "publish"
            ? await reviewsApi.approve(id)
            : await reviewsApi.reject(id);
      } catch {
        reportUnexpectedFailure(
          id,
          intent === "publish"
            ? "The review was not published."
            : "The review was not rejected.",
        );
        return;
      }
      if (!mounted.current || activeId.current !== id) return;
      if (result.error) {
        const message = actionFailure(
          result.error,
          intent === "publish"
            ? "The review was not published."
            : "The review was not rejected.",
        );
        setFailure(message);
        toast.error(message);
        return;
      }
      const updated = verifiedReviewDetail(result.data, id);
      if (!updated) {
        const message = actionFailure(
          { kind: "parse" },
          "The decision response could not be verified.",
        );
        setFailure(message);
        toast.error(message);
        return;
      }
      replaceRecord(updated);
      setDecisionIntent(null);
      toast.success(
        intent === "publish"
          ? "Review marked public by the service"
          : "Review rejected",
      );
      onDecision(updated);
    } finally {
      finish();
    }
  };

  const prepareReply = (): void => {
    const body = replyDraft.trim();
    if (
      mutationGuard.current ||
      !canAdmin ||
      record?.status !== "approved" ||
      !nonEmptyText(record.id) ||
      !body ||
      Array.from(body).length > REVIEW_REPLY_MAX_CHARS
    ) {
      return;
    }
    setReplyPreview(body);
  };

  const confirmReply = async (): Promise<void> => {
    const id = nonEmptyText(record?.id);
    const body = replyPreview;
    if (
      mutationGuard.current ||
      !id ||
      !body ||
      Array.from(body).length > REVIEW_REPLY_MAX_CHARS ||
      !canAdmin ||
      record?.status !== "approved"
    ) {
      return;
    }
    mutationGuard.current = true;
    setMutation("reply");
    setFailure(null);
    try {
      let result;
      try {
        result = await reviewsApi.reply(id, body);
      } catch {
        reportUnexpectedFailure(id, "The public reply was not published.");
        return;
      }
      if (!mounted.current || activeId.current !== id) return;
      if (result.error) {
        const message = actionFailure(
          result.error,
          "The reply was not marked public.",
        );
        setFailure(message);
        toast.error(message);
        return;
      }
      if (!isPublicReply(result.data)) {
        const message = actionFailure(
          { kind: "parse" },
          "The reply response could not be verified.",
        );
        setFailure(message);
        toast.error(message);
        return;
      }
      appendReply(result.data);
      setReplyPreview(null);
      setReplyDraft("");
      setReplyOpen(false);
      toast.success("Reply marked public by the service");
    } finally {
      finish();
    }
  };

  return {
    mutation,
    failure,
    decisionIntent,
    replyOpen,
    replyDraft,
    replyPreview,
    setDecisionIntent,
    setReplyOpen,
    setReplyDraft,
    prepareReply,
    closeReplyPreview: () => setReplyPreview(null),
    confirmDecision,
    confirmReply,
  };
}

function evidenceLabel(value: string | null): string {
  if (!value) return "Not supplied";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function DateEvidence({
  label,
  value,
}: {
  label: string;
  value: unknown;
}): ReactElement {
  const timestamp = nonEmptyText(value);
  const verified = timestamp !== null && !Number.isNaN(Date.parse(timestamp));
  return (
    <div className="reviews-detail__evidence-item">
      <dt>{label}</dt>
      <dd>
        {verified && timestamp ? (
          <time dateTime={timestamp}>{fmtDateTime(timestamp)}</time>
        ) : (
          "Not available"
        )}
      </dd>
    </div>
  );
}

function ReviewEvidence({ review }: { review: Review }): ReactElement {
  const replies = Array.isArray(review.public_replies)
    ? review.public_replies.filter(isPublicReply)
    : [];
  const reviewer = nonEmptyText(review.reviewer_name) ?? "Anonymous reviewer";
  const title = nonEmptyText(review.title);
  const body = typeof review.body === "string" ? review.body : "";

  return (
    <article className="reviews-detail" aria-labelledby="reviews-detail-title">
      <header className="reviews-detail__summary">
        <div className="reviews-detail__rating">
          <Stars rating={review.rating} />
          <span>{review.rating} / 5</span>
        </div>
        <span className={statusBadgeClass(review.status)}>
          {statusLabel(review.status)}
        </span>
        <p className="reviews-detail__reviewer">{reviewer}</p>
        <h3 id="reviews-detail-title">{title ?? "Untitled customer review"}</h3>
      </header>

      <section
        className="reviews-detail__body"
        aria-labelledby="reviews-detail-body-title"
      >
        <h4 id="reviews-detail-body-title">Customer’s review</h4>
        {body ? (
          <p dir="auto">{body}</p>
        ) : (
          <p className="muted">No written review was supplied.</p>
        )}
      </section>

      <section
        className="reviews-detail__trust"
        aria-labelledby="reviews-detail-trust-title"
      >
        <h4 id="reviews-detail-trust-title">Reported trust flags</h4>
        <p className="reviews-detail__trust-note">
          These service-supplied fields are not independent proof of buyer
          identity or review authenticity.
        </p>
        <ul className="reviews-detail__trust-list">
          <li data-active={review.verified_buyer || undefined}>
            {review.verified_buyer
              ? "Buyer verification reported"
              : "Buyer verification not reported"}
          </li>
          <li data-active={review.incentivized || undefined}>
            {review.incentivized
              ? "Incentive reported"
              : "No incentive reported"}
          </li>
          <li data-active={review.featured || undefined}>
            {review.featured
              ? "Featured placement reported"
              : "Featured flag not reported"}
          </li>
        </ul>
      </section>

      <details className="reviews-detail__evidence" open>
        <summary>Evidence trail</summary>
        <p className="reviews-detail__evidence-note">
          These are service-reported record values. This screen does not
          independently verify their provenance or timestamps.
        </p>
        <dl className="reviews-detail__evidence-grid">
          <div className="reviews-detail__evidence-item">
            <dt>Reported product</dt>
            <dd>{nonEmptyText(review.product_id) ?? "Not supplied"}</dd>
          </div>
          <div className="reviews-detail__evidence-item">
            <dt>Reported variant</dt>
            <dd>{nonEmptyText(review.variant_id) ?? "Not supplied"}</dd>
          </div>
          <div className="reviews-detail__evidence-item">
            <dt>Reported review type</dt>
            <dd>{evidenceLabel(nonEmptyText(review.review_type))}</dd>
          </div>
          <div className="reviews-detail__evidence-item">
            <dt>Reported source</dt>
            <dd>{evidenceLabel(nonEmptyText(review.source_platform))}</dd>
          </div>
          <DateEvidence
            label="Reported submitted"
            value={review.submitted_at}
          />
          <DateEvidence
            label="Reported public since"
            value={review.published_at}
          />
          <DateEvidence
            label="Reported moderated"
            value={review.moderated_at}
          />
        </dl>
      </details>

      {nonEmptyText(review.moderation_reason) ? (
        <section
          className="reviews-detail__moderation-note"
          aria-labelledby="reviews-detail-note-title"
        >
          <h4 id="reviews-detail-note-title">Moderation note</h4>
          <p dir="auto">{review.moderation_reason}</p>
        </section>
      ) : null}

      <section
        className="reviews-detail__replies"
        aria-labelledby="reviews-detail-replies-title"
      >
        <div className="reviews-detail__section-heading">
          <h4 id="reviews-detail-replies-title">
            Service-reported public replies
          </h4>
          <span>{replies.length}</span>
        </div>
        <p className="reviews-detail__reply-provenance">
          Reply status, author and timestamp come from the service response and
          are not independently verified here.
        </p>
        {replies.length ? (
          <div className="reviews-detail__reply-list">
            {replies.map((reply, index) => (
              <article
                className="reviews-detail__reply"
                key={nonEmptyText(reply.id) ?? `reply-${index}`}
              >
                <header>
                  <strong>
                    Reported author:{" "}
                    {nonEmptyText(reply.author) ?? "Not provided"}
                  </strong>
                  {nonEmptyText(reply.created_at) ? (
                    <time dateTime={reply.created_at}>
                      {fmtDateTime(reply.created_at)}
                    </time>
                  ) : null}
                </header>
                <p dir="auto">{reply.body}</p>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">
            No service-reported public reply is available.
          </p>
        )}
      </section>

      <Notice
        className="reviews-detail__privacy"
        tone="neutral"
        title="Sensitive fields hidden from this view"
        announcement="off"
      >
        Private contact and import payload fields are intentionally withheld
        from this moderation view.
      </Notice>
    </article>
  );
}

function ReplyComposer({
  draft,
  busy,
  textareaRef,
  reviewButtonRef,
  onChange,
  onCancel,
  onReview,
}: {
  draft: string;
  busy: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  reviewButtonRef: RefObject<HTMLButtonElement | null>;
  onChange: (value: string) => void;
  onCancel: () => void;
  onReview: () => void;
}): ReactElement {
  const labelId = useId();
  const helpId = useId();
  const count = Array.from(draft).length;
  return (
    <section className="reviews-detail__composer" aria-labelledby={labelId}>
      <div className="reviews-detail__section-heading">
        <div>
          <h4 id={labelId}>Write a public store reply</h4>
          <p id={helpId}>
            The next step shows the exact public text before anything is
            published.
          </p>
        </div>
        <output aria-live="polite">
          {count.toLocaleString()} / {REVIEW_REPLY_MAX_CHARS.toLocaleString()}
        </output>
      </div>
      <textarea
        ref={textareaRef}
        className="input reviews-detail__reply-input"
        value={draft}
        maxLength={REVIEW_REPLY_MAX_CHARS}
        rows={6}
        disabled={busy}
        aria-describedby={helpId}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Write the response customers will see…"
      />
      <div className="reviews-detail__composer-actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          ref={reviewButtonRef}
          type="button"
          className="btn btn-primary"
          disabled={busy || !draft.trim()}
          onClick={onReview}
        >
          Review public reply
        </button>
      </div>
    </section>
  );
}

export function ReviewDetailModal({
  open,
  review,
  canAdmin,
  returnFocusRef,
  onClose,
  onDecision,
}: ReviewDetailModalProps): ReactElement | null {
  const { state, retry, replaceRecord, appendReply } = useReviewDetail(
    open,
    review,
  );
  const { record, transport, failure } = detailDisplayState(state, review);
  const actions = useReviewActions({
    open,
    record,
    canAdmin,
    replaceRecord,
    appendReply,
    onDecision,
  });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const publishButtonRef = useRef<HTMLButtonElement | null>(null);
  const rejectButtonRef = useRef<HTMLButtonElement | null>(null);
  const replyReviewButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const isBusy = actions.mutation !== null;
  const isPending = record ? isReviewDecidable(record) : false;
  const isPublished = record?.status === "approved";
  const hasId = nonEmptyText(record?.id) !== null;
  const canDecide = canAdmin && isPending && hasId;
  const canReply = canAdmin && isPublished && hasId;

  useEffect(() => {
    if (!actions.replyOpen || !open) return;
    queueMicrotask(() => textareaRef.current?.focus());
  }, [actions.replyOpen, open]);

  if (!open) return null;

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="Review evidence"
        description="Inspect the complete customer submission before making a public decision."
        size="lg"
        initialFocusRef={closeButtonRef}
        returnFocusRef={returnFocusRef}
        closeOnBackdrop={false}
        closeOnEscape={!isBusy}
        closeDisabled={isBusy}
      >
        {transport === "loading" && record ? (
          <Notice
            className="reviews-detail__load-notice"
            tone="info"
            title="Loading the complete evidence"
            announcement="polite"
          >
            This is the partial moderation-queue snapshot. Decision controls
            stay withheld until the server verifies the complete record and its
            public replies.
          </Notice>
        ) : null}

        {transport === "error" ? (
          <Notice
            className="reviews-detail__load-notice"
            tone="danger"
            title={
              record
                ? "Complete evidence unavailable"
                : "Review evidence unavailable"
            }
            announcement="assertive"
            action={
              hasId ? (
                <button type="button" className="btn btn-sm" onClick={retry}>
                  Retry
                </button>
              ) : undefined
            }
          >
            {failure?.message ?? parseFailure().message}
            {record
              ? " The partial queue snapshot remains visible below, but moderation actions are withheld."
              : ""}
          </Notice>
        ) : null}

        {record ? (
          <ReviewEvidence review={record} />
        ) : transport === "loading" ? (
          <div
            className="reviews-detail__skeleton"
            role="status"
            aria-label="Loading review evidence"
          >
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {!canAdmin && record ? (
          <Notice
            className="reviews-detail__authority"
            tone="neutral"
            title="Read-only review evidence"
          >
            Your current workspace role can inspect this record, but only an
            administrator can publish, reject, or post a public store reply.
          </Notice>
        ) : null}

        {canAdmin && record && !hasId ? (
          <Notice
            className="reviews-detail__authority"
            tone="warning"
            title="Actions withheld"
          >
            This snapshot has no stable review identifier, so it cannot be
            moderated safely.
          </Notice>
        ) : null}

        {canAdmin && record && isPublished ? (
          <Notice
            className="reviews-detail__authority"
            tone="warning"
            title="Server status: approved"
          >
            The service reports this review as public. Visibility on any
            storefront integration is not verified here. A store reply is stored
            as public immediately and has no desktop undo.
          </Notice>
        ) : null}

        {canAdmin && record?.status === "rejected" ? (
          <Notice
            className="reviews-detail__authority"
            tone="neutral"
            title="No desktop restore path"
          >
            This review is rejected. The current desktop API cannot restore it
            or add a rejection reason.
          </Notice>
        ) : null}

        {actions.failure ? (
          <Notice
            className="reviews-detail__action-error"
            tone="danger"
            title="Action not completed"
            announcement="assertive"
          >
            {actions.failure}
          </Notice>
        ) : null}

        {actions.replyOpen && canReply ? (
          <ReplyComposer
            draft={actions.replyDraft}
            busy={isBusy}
            textareaRef={textareaRef}
            reviewButtonRef={replyReviewButtonRef}
            onChange={actions.setReplyDraft}
            onCancel={() => {
              actions.setReplyOpen(false);
              actions.setReplyDraft("");
            }}
            onReview={actions.prepareReply}
          />
        ) : null}

        <ModalFooter>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn"
            disabled={isBusy}
            onClick={onClose}
          >
            Close
          </button>
          {canReply && !actions.replyOpen ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={isBusy || transport !== "ready"}
              onClick={() => actions.setReplyOpen(true)}
            >
              Write public reply
            </button>
          ) : null}
          {canDecide ? (
            <>
              <button
                ref={rejectButtonRef}
                type="button"
                className="btn btn-danger"
                disabled={isBusy || transport !== "ready"}
                onClick={() => actions.setDecisionIntent("reject")}
              >
                Reject review
              </button>
              <button
                ref={publishButtonRef}
                type="button"
                className="btn btn-primary"
                disabled={isBusy || transport !== "ready"}
                onClick={() => actions.setDecisionIntent("publish")}
              >
                Publish review
              </button>
            </>
          ) : null}
        </ModalFooter>
      </Modal>

      <ConfirmModal
        open={actions.decisionIntent === "publish"}
        title="Publish this review now?"
        description="The service marks the review public immediately; storefront visibility is not verified here."
        confirmLabel="Publish review now"
        busy={actions.mutation === "publish"}
        returnFocusRef={publishButtonRef}
        onClose={() => actions.setDecisionIntent(null)}
        onConfirm={actions.confirmDecision}
      >
        <Notice
          tone="warning"
          title="Immediate server-side publication"
          announcement="off"
        >
          Any independently working public integration may expose the review as
          soon as the server accepts this decision. The desktop app has no undo
          action.
        </Notice>
      </ConfirmModal>

      <ConfirmModal
        open={actions.decisionIntent === "reject"}
        title="Reject this review?"
        description="The review will leave the pending moderation queue."
        confirmLabel="Reject review now"
        danger
        busy={actions.mutation === "reject"}
        returnFocusRef={rejectButtonRef}
        onClose={() => actions.setDecisionIntent(null)}
        onConfirm={actions.confirmDecision}
      >
        <Notice
          tone="danger"
          title="No desktop recovery path"
          announcement="off"
        >
          The current desktop API has no restore action and no endpoint for
          recording a rejection reason. Confirm only after reviewing the full
          submission.
        </Notice>
      </ConfirmModal>

      <ConfirmModal
        open={actions.replyPreview !== null}
        title="Publish this store reply?"
        description="Review the exact text the service will store as public."
        confirmLabel="Publish reply now"
        busy={actions.mutation === "reply"}
        returnFocusRef={replyReviewButtonRef}
        onClose={actions.closeReplyPreview}
        onConfirm={actions.confirmReply}
      >
        <Notice
          tone="warning"
          title="Immediate server-side publication"
          announcement="off"
        >
          The service stores this reply as public immediately. Storefront
          visibility is not verified here, and the desktop app has no edit or
          undo action.
        </Notice>
        <article
          className="reviews-detail__reply-preview"
          aria-label="Exact public reply preview"
        >
          <h3>Exact public reply</h3>
          <p dir="auto">{actions.replyPreview}</p>
        </article>
      </ConfirmModal>
    </>
  );
}
