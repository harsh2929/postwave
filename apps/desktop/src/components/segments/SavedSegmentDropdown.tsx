/** Saved-segment picker with race-safe, explicit membership insight. */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type SavedSegment,
  type SavedSegmentPreview,
  previewSavedSegmentDetail,
} from "../../lib/api-client";
import {
  remoteFailureFromError,
  type RemoteFailure,
} from "../../lib/remote-resource";

import "../../styles-saved-segment-dropdown.css";

type PreviewEntry =
  | { kind: "loading" }
  | { kind: "ok"; preview: SavedSegmentPreview }
  | { kind: "unevaluable" }
  | { kind: "err"; failure: RemoteFailure };

const SAVED_PREVIEW_STALE_MS = 5 * 60 * 1_000;

interface Props {
  id?: string;
  value: string;
  segments: SavedSegment[] | null;
  onChange: (segmentId: string) => void;
  disabled?: boolean;
  disabledReason?: string;
  ariaLabel?: string;
  placeholder?: string;
  emptyText?: string;
  error?: string;
  onRetry?: () => void;
}

export function SavedSegmentDropdown({
  id,
  value,
  segments,
  onChange,
  disabled = false,
  disabledReason,
  ariaLabel,
  placeholder = "Pick a segment…",
  emptyText = "No saved segments yet — create one first",
  error,
  onRetry,
}: Props): ReactElement {
  const loading = segments === null && !error;
  const statusId = useId();
  const previewStatusId = useId();
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const sorted = useMemo(
    () =>
      [...(segments ?? [])].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      ),
    [segments],
  );
  const segmentSignature = useMemo(
    () =>
      JSON.stringify(
        sorted.map(({ id: segmentId, tenant_id, updated_at }) => [
          segmentId,
          tenant_id,
          updated_at,
        ]),
      ),
    [sorted],
  );
  const selected = sorted.find((segment) => segment.id === value);
  const selectUnavailable =
    disabled || segments === null || sorted.length === 0;
  const [previews, setPreviews] = useState<Record<string, PreviewEntry>>({});
  const previewsRef = useRef(previews);
  const generationsRef = useRef(new Map<string, number>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const segmentSignatureRef = useRef(segmentSignature);
  const mountedRef = useRef(true);
  previewsRef.current = previews;
  segmentSignatureRef.current = segmentSignature;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationsRef.current.clear();
      for (const controller of controllersRef.current.values()) {
        controller.abort();
      }
      controllersRef.current.clear();
    };
  }, []);

  const loadPreview = useCallback(
    async (segmentId: string, force = false): Promise<void> => {
      const existing = previewsRef.current[segmentId];
      if (
        !force &&
        existing &&
        (existing.kind !== "ok" || previewIsFresh(existing.preview))
      ) {
        return;
      }
      if (existing?.kind === "loading") return;
      const generation = (generationsRef.current.get(segmentId) ?? 0) + 1;
      generationsRef.current.set(segmentId, generation);
      const loadingEntry: PreviewEntry = { kind: "loading" };
      previewsRef.current = {
        ...previewsRef.current,
        [segmentId]: loadingEntry,
      };
      setPreviews(previewsRef.current);
      const ownerSignature = segmentSignatureRef.current;
      const controller = new AbortController();
      controllersRef.current.set(segmentId, controller);
      const releaseController = (): void => {
        if (controllersRef.current.get(segmentId) === controller) {
          controllersRef.current.delete(segmentId);
        }
      };

      let next: PreviewEntry;
      try {
        const result = await previewSavedSegmentDetail(segmentId, {
          signal: controller.signal,
        });
        if (result.error) {
          next =
            result.error.kind === "http" && result.error.status === 422
              ? { kind: "unevaluable" }
              : {
                  kind: "err",
                  failure: remoteFailureFromError(result.error),
                };
        } else if (validPreview(result.data) && result.data.id === segmentId) {
          next = { kind: "ok", preview: result.data };
        } else {
          next = {
            kind: "err",
            failure: remoteFailureFromError({
              kind: "parse",
              code: "invalid_saved_segment_preview",
            }),
          };
        }
      } catch {
        if (controller.signal.aborted) {
          releaseController();
          return;
        }
        next = {
          kind: "err",
          failure: remoteFailureFromError({ kind: "network" }),
        };
      }
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        segmentSignatureRef.current !== ownerSignature ||
        generationsRef.current.get(segmentId) !== generation
      ) {
        releaseController();
        return;
      }
      previewsRef.current = { ...previewsRef.current, [segmentId]: next };
      setPreviews(previewsRef.current);
      releaseController();
    },
    [],
  );

  useEffect(() => {
    for (const controller of controllersRef.current.values()) {
      controller.abort();
    }
    controllersRef.current.clear();
    generationsRef.current.clear();
    previewsRef.current = {};
    setPreviews({});
  }, [segmentSignature]);

  useEffect(() => {
    if (value) void loadPreview(value);
  }, [loadPreview, segmentSignature, value]);

  return (
    <div className="saved-segment-picker">
      <select
        ref={selectRef}
        id={id}
        className="input pw-discoverable-unavailable"
        aria-label={ariaLabel ?? (id ? undefined : "Saved segment")}
        value={selected ? value : ""}
        aria-disabled={selectUnavailable || undefined}
        aria-busy={loading ? "true" : undefined}
        aria-describedby={`${statusId}${value ? ` ${previewStatusId}` : ""}`}
        onChange={(event) => {
          if (!selectUnavailable) onChange(event.target.value);
        }}
      >
        <option value="">
          {loading
            ? "Loading segments…"
            : error && segments === null
              ? "Saved segments unavailable"
              : sorted.length === 0
                ? emptyText
                : placeholder}
        </option>
        {sorted.map((segment) => (
          <option key={segment.id} value={segment.id}>
            {segment.name}
          </option>
        ))}
      </select>

      <small
        id={statusId}
        className="pw-action-status"
        role={error ? "alert" : undefined}
      >
        {error
          ? `Saved segments could not be verified: ${error}`
          : disabled
            ? (disabledReason ??
              "Segment selection is unavailable while the parent action is in progress.")
            : loading
              ? "Verifying saved segments. The picker remains focusable so this status can be discovered."
              : sorted.length === 0
                ? emptyText
                : `${sorted.length.toLocaleString()} saved segment${sorted.length === 1 ? "" : "s"} available in alphabetical order.`}
      </small>

      {error && onRetry ? (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            selectRef.current?.focus();
            onRetry();
          }}
        >
          Retry saved segments
        </button>
      ) : null}

      {value && !selected && !loading && !error ? (
        <div className="saved-segment-preview-error" role="alert">
          The previously selected segment is no longer in the verified option
          list. Choose another segment before continuing.
        </div>
      ) : null}

      {value && selected ? (
        <PreviewInsight
          id={previewStatusId}
          segment={selected}
          entry={previews[value]}
          onRetry={() => {
            selectRef.current?.focus();
            void loadPreview(value, true);
          }}
        />
      ) : null}
    </div>
  );
}

function PreviewInsight({
  id,
  segment,
  entry,
  onRetry,
}: {
  id: string;
  segment: SavedSegment;
  entry: PreviewEntry | undefined;
  onRetry: () => void;
}): ReactElement {
  if (!entry || entry.kind === "loading") {
    return (
      <div
        id={id}
        className="saved-segment-preview"
        role="status"
        aria-busy="true"
      >
        Counting members for {segment.name}…
      </div>
    );
  }
  if (entry.kind === "unevaluable") {
    return (
      <div id={id} className="saved-segment-preview-error" role="status">
        <span>
          {segment.name} uses an older query format, so no verified live count
          is available.
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onRetry}
        >
          Retry preview
        </button>
      </div>
    );
  }
  if (entry.kind === "err") {
    const diagnostics = [entry.failure.code, entry.failure.requestId]
      .filter(Boolean)
      .join(" · ");
    return (
      <div id={id} className="saved-segment-preview-error" role="alert">
        <span>
          <strong>Couldn&apos;t verify live membership.</strong>{" "}
          {entry.failure.message}
          {diagnostics ? (
            <span className="muted"> Reference: {diagnostics}.</span>
          ) : null}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onRetry}
        >
          Retry preview
        </button>
      </div>
    );
  }

  const preview = entry.preview;
  return (
    <div id={id} className="saved-segment-preview">
      <div role="status" aria-live="polite">
        <div className="saved-segment-preview-summary">
          <span>
            <strong>{segment.name}</strong>
            <code>{segment.id}</code>
          </span>
          <span className="badge">
            {preview.count.toLocaleString()} member
            {preview.count === 1 ? "" : "s"}
          </span>
        </div>
        <span className="pw-action-status">
          {preview.count.toLocaleString()} of{" "}
          {preview.workspace_total.toLocaleString()} workspace subscribers ·{" "}
          {preview.workspace_percentage.toLocaleString()}% of workspace
        </span>
      </div>
      <span className="pw-action-status">
        Aggregate only · generated {formatPreviewTime(preview.generated_at)}. No
        member identities are exposed in this preview.
      </span>
    </div>
  );
}

function validPreview(
  value: SavedSegmentPreview | null | undefined,
): value is SavedSegmentPreview {
  const expectedPercentage =
    value && value.workspace_total > 0
      ? Math.round((value.count / value.workspace_total) * 1_000) / 10
      : 0;
  return Boolean(
    value &&
    typeof value.id === "string" &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    Number.isSafeInteger(value.workspace_total) &&
    value.workspace_total >= 0 &&
    value.count <= value.workspace_total &&
    Number.isFinite(value.workspace_percentage) &&
    value.workspace_percentage >= 0 &&
    value.workspace_percentage <= 100 &&
    Math.abs(value.workspace_percentage - expectedPercentage) < 0.05 &&
    typeof value.generated_at === "string" &&
    !Number.isNaN(Date.parse(value.generated_at)),
  );
}

function previewIsFresh(
  preview: SavedSegmentPreview,
  now = Date.now(),
): boolean {
  const generatedAt = Date.parse(preview.generated_at);
  return (
    Number.isFinite(generatedAt) &&
    Math.abs(now - generatedAt) <= SAVED_PREVIEW_STALE_MS
  );
}

function formatPreviewTime(value: string): string {
  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
