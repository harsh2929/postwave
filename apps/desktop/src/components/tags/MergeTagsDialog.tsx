/**
 * MergeTagsDialog — pick one or more source tags + a destination,
 * confirm, fire the merges. Refined Tags PR 1; reworked for the
 * full-surface wiring #27 pass:
 *
 *   - Multi-source: the taxonomy merge endpoint takes one `from` per
 *     call, so N sources fan out as N sequential POSTs against the
 *     same `into`.
 *   - A ConfirmModal now sits between "Merge" and the request(s),
 *     citing the predicted affected count from the usage map (labelled
 *     as approximate — counts can drift until the merge runs).
 *   - The result toast reads the server's real response field
 *     (`subscribers_updated` — the old code read `merged`, which the
 *     Go handler never sent, so every toast claimed "0 subscribers").
 *     Copy builders live in merge-tags-helpers.ts and are unit-tested.
 *
 * The legacy merge removes each source registry row after rewriting the
 * legacy subscriber projection. The route currently keeps this dialog
 * unreachable until a versioned plan/commit contract is available.
 */

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";

import { type Tag, type TagUsage, api } from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import {
  type MergeOutcome,
  mergePlanCopy,
  mergeResultToastCopy,
} from "./merge-tags-helpers";

interface Props {
  open: boolean;
  /** All tag rows so the pickers can show options. */
  tags: Tag[];
  /** Optional usage map — when present, surface counts inline. */
  usage?: Record<string, TagUsage>;
  /** Pre-selected source tag(s) (when invoked from a row / bulk bar). */
  initialFrom?: string | string[];
  onClose: () => void;
  onMerged: () => void;
}

export function MergeTagsDialog({
  open,
  tags,
  usage,
  initialFrom,
  onClose,
  onMerged,
}: Props): ReactElement {
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [into, setInto] = useState<string>("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);
  const operationRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset on open so re-opening from a different row picks up the new initial.
  useEffect(() => {
    if (!open) return;
    const initial = (
      typeof initialFrom === "string" ? [initialFrom] : (initialFrom ?? [])
    ).filter(Boolean);
    setSources(new Set(initial));
    setInto("");
    setConfirming(false);
    setSubmitting(false);
    operationRef.current = false;
  }, [open, initialFrom]);

  const sourceNames = useMemo(
    () => tags.filter((t) => sources.has(t.name)).map((t) => t.name),
    [tags, sources],
  );
  const valid = sourceNames.length > 0 && !!into && !sources.has(into);
  const plan = valid ? mergePlanCopy(sourceNames, into, usage) : null;

  const toggleSource = (name: string): void => {
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    // Picking a tag as a source disqualifies it as the destination.
    if (into === name) setInto("");
  };

  const submit = async (): Promise<void> => {
    if (!valid || operationRef.current) return;
    operationRef.current = true;
    setSubmitting(true);
    const outcomes: MergeOutcome[] = [];
    try {
      for (const from of sourceNames) {
        try {
          const res = await api.mergeTags({ from, into });
          if (res.error) {
            outcomes.push({ from, ok: false, error: res.error.message });
            continue;
          }
          outcomes.push({
            from,
            ok: true,
            subscribersUpdated:
              res.data?.subscribers_updated ?? res.data?.merged,
          });
        } catch {
          outcomes.push({ from, ok: false, error: "request failed" });
        }
      }
    } finally {
      operationRef.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
        setConfirming(false);
      }
    }
    if (!mountedRef.current) return;
    const copy = mergeResultToastCopy(into, outcomes);
    if (copy.ok) {
      toast.success({ message: copy.message, detail: copy.detail });
    } else {
      toast.error({ message: copy.message, detail: copy.detail });
    }
    // Any success changed subscriber data — let the page refresh even
    // if some sources failed.
    if (outcomes.some((o) => o.ok)) {
      onMerged();
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={() => {
          if (!submitting && !confirming) onClose();
        }}
        closeOnBackdrop={!submitting && !confirming}
        closeOnEscape={!submitting && !confirming}
        closeDisabled={submitting || confirming}
        title="Merge tags"
        description="A successful legacy merge removes every source tag from the catalogue. This flow stays unavailable until the server can provide an authoritative, idempotent impact plan."
      >
        <div className="field">
          <span className="field-label">From</span>
          <div
            role="group"
            aria-label="Source tags"
            style={{
              maxHeight: 180,
              overflowY: "auto",
              border: "1px solid var(--pw-border)",
              borderRadius: 4,
              padding: 6,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {tags.map((t) => (
              <label
                key={t.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  padding: "3px 4px",
                  cursor: "pointer",
                  opacity: t.name === into ? 0.5 : 1,
                }}
                title={
                  t.name === into
                    ? "Already picked as the destination"
                    : undefined
                }
              >
                <input
                  type="checkbox"
                  checked={sources.has(t.name)}
                  disabled={t.name === into}
                  onChange={() => toggleSource(t.name)}
                />
                <span
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.name}
                </span>
                {usage?.[t.name] ? (
                  <span
                    className="muted tabular"
                    style={{ marginLeft: "auto", fontSize: 11 }}
                  >
                    {usage[t.name].subscribers.toLocaleString()}
                  </span>
                ) : null}
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="merge-into">
            Into
          </label>
          <select
            id="merge-into"
            className="input"
            value={into}
            onChange={(e) => setInto(e.target.value)}
          >
            <option value="">Pick a destination tag…</option>
            {tags.map((t) => (
              <option key={t.id} value={t.name} disabled={sources.has(t.name)}>
                {t.name}
                {usage?.[t.name] ? ` (${usage[t.name].subscribers})` : ""}
              </option>
            ))}
          </select>
        </div>

        {plan ? (
          <div
            className="notice"
            style={{ marginTop: 8, fontSize: 12 }}
            role="status"
          >
            Will move ~<strong>{plan.predicted.toLocaleString()}</strong>{" "}
            subscriber{plan.predicted === 1 ? "" : "s"} from{" "}
            <strong>{sourceNames.join('", "')}</strong> into{" "}
            <strong>{into}</strong>. The exact count is confirmed by the server
            after the merge.
          </div>
        ) : null}

        <ModalFooter>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setConfirming(true)}
            disabled={submitting || !valid}
          >
            {sourceNames.length > 1
              ? `Merge ${sourceNames.length} tags…`
              : "Merge tags…"}
          </button>
        </ModalFooter>
      </Modal>

      <ConfirmModal
        open={confirming && valid}
        title={plan?.title ?? "Merge tags?"}
        description={plan?.description ?? ""}
        confirmLabel={submitting ? "Merging…" : "Merge"}
        busy={submitting}
        onClose={() => (submitting ? undefined : setConfirming(false))}
        onConfirm={() => void submit()}
      />
    </>
  );
}
