/**
 * Evaluation records for a saved segment.
 *
 * The backend retains the predicate, evaluated count, and a bounded member
 * sample. It does not retain every membership row, so this surface must never
 * describe a record as an immutable recipient list or promise an exact replay.
 */

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The bounded member table is a named two-axis scroll region that must remain keyboard-scrollable at narrow desktop widths. */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useRemoteResource } from "../../hooks/useRemoteResource";
import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import { fmtDateTime, fmtRelative } from "../../lib/format-date";
import {
  isInitialRemoteLoad,
  remoteFailureFromError,
  type RemoteApiError,
} from "../../lib/remote-resource";
import { RemoteDataNotice } from "../RemoteDataNotice";
import { toast } from "../Toast";
import {
  type SegmentSnapshot,
  type SnapshotMember,
  type SnapshotMembersPage,
  segmentsClient,
} from "./segmentsClient";

import "../../styles-segment-snapshots.css";

const MEMBERS_PER_PAGE = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundedString(value: unknown, maxLength = 512): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    Number.isFinite(Date.parse(value))
  );
}

function normalizeSnapshot(
  value: unknown,
  expectedSegmentId: string,
): SegmentSnapshot | null {
  if (!isRecord(value)) return null;
  const id = boundedString(value.id);
  const tenantId = boundedString(value.tenant_id);
  const segmentId = boundedString(value.segment_id);
  const evaluatorVersion = boundedString(value.evaluator_version, 128);
  const count = nonNegativeInteger(value.count);
  const sampleSize = nonNegativeInteger(value.sample_size);
  if (
    !id ||
    !tenantId ||
    segmentId !== expectedSegmentId ||
    !evaluatorVersion ||
    count === null ||
    sampleSize === null ||
    sampleSize > count ||
    !validTimestamp(value.evaluated_at) ||
    !validTimestamp(value.created_at)
  ) {
    return null;
  }
  return {
    id,
    tenant_id: tenantId,
    segment_id: segmentId,
    query_ast: value.query_ast,
    count,
    sample_size: sampleSize,
    evaluator_version: evaluatorVersion,
    evaluated_at: value.evaluated_at,
    created_at: value.created_at,
  };
}

async function loadSnapshots(segmentId: string) {
  const result = await segmentsClient.listSnapshots(segmentId);
  if (result.error) return { error: result.error };
  if (!isRecord(result.data) || !Array.isArray(result.data.items)) {
    return invalidResponse("invalid_segment_snapshot_list");
  }
  const items = result.data.items.map((item) =>
    normalizeSnapshot(item, segmentId),
  );
  if (items.some((item) => item === null)) {
    return invalidResponse("invalid_segment_snapshot_record");
  }
  return { data: items as SegmentSnapshot[] };
}

function normalizeMember(value: unknown): SnapshotMember | null {
  if (!isRecord(value)) return null;
  const email = boundedString(value.email, 1_024) ?? "";
  const subscriberId = boundedString(value.subscriber_id) ?? "";
  return email || subscriberId ? { email, subscriber_id: subscriberId } : null;
}

function normalizeMembersPage(
  value: unknown,
  expectedPage: number,
): SnapshotMembersPage | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const page = nonNegativeInteger(value.page);
  const perPage = nonNegativeInteger(value.per_page);
  const total = nonNegativeInteger(value.total);
  const sampleSize = nonNegativeInteger(value.sample_size);
  const items = value.items.map(normalizeMember);
  if (
    page !== expectedPage ||
    perPage === null ||
    perPage < 1 ||
    perPage > 200 ||
    total === null ||
    sampleSize === null ||
    sampleSize > total ||
    typeof value.sample_is_complete !== "boolean" ||
    value.sample_is_complete !== sampleSize >= total ||
    items.length > perPage ||
    items.some((item) => item === null)
  ) {
    return null;
  }
  return {
    items: items as SnapshotMember[],
    page,
    per_page: perPage,
    total,
    sample_size: sampleSize,
    sample_is_complete: value.sample_is_complete,
  };
}

async function loadSnapshotMembers(snapshotId: string, page: number) {
  const result = await segmentsClient.listSnapshotMembers(snapshotId, {
    page,
    perPage: MEMBERS_PER_PAGE,
  });
  if (result.error) return { error: result.error };
  const normalized = normalizeMembersPage(result.data, page);
  return normalized
    ? { data: normalized }
    : invalidResponse("invalid_segment_snapshot_members");
}

function invalidResponse(code: string): { error: RemoteApiError } {
  return { error: { kind: "parse", code } };
}

function diagnostics(error: RemoteApiError): string {
  const failure = remoteFailureFromError(error);
  const reference = [failure.code, failure.requestId]
    .filter(Boolean)
    .join(" · ");
  return `${failure.message}${reference ? ` Reference: ${reference}.` : ""}`;
}

export function SegmentSnapshotsSection({
  segmentId,
  canMutate,
}: {
  segmentId: string;
  canMutate: boolean;
}): ReactElement {
  const headingId = useId();
  const actionHelpId = useId();
  const listId = useId();
  const mountedRef = useRef(true);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const snapshots = useRemoteResource(() => loadSnapshots(segmentId), {
    identity: `segment-snapshots:${segmentId}`,
  });
  const operation = useSingleFlightOperation({
    ownerId: `segment-snapshot-create:${segmentId}`,
    label: "Segment evaluation snapshot",
    detail:
      "Wait for the segment evaluation record and verified list refresh to finish before leaving Moosewave.",
  });

  useEffect(() => {
    mountedRef.current = true;
    setOpenId(null);
    setConfirmation(null);
    return () => {
      mountedRef.current = false;
    };
  }, [segmentId]);

  const refreshSnapshots = useCallback(async (): Promise<void> => {
    if (refreshPromiseRef.current) {
      await refreshPromiseRef.current;
      return;
    }
    let tracked: Promise<void>;
    tracked = snapshots.reload().finally(() => {
      if (refreshPromiseRef.current === tracked)
        refreshPromiseRef.current = null;
    });
    refreshPromiseRef.current = tracked;
    await tracked;
  }, [snapshots.reload]);

  async function recordSnapshot(): Promise<void> {
    if (!canMutate) return;
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setConfirmation(null);
    const request = operation.run(async (): Promise<void> => {
      let result;
      try {
        result = await segmentsClient.createSnapshot(segmentId);
      } catch {
        result = { error: { kind: "network" as const } };
      }
      if (!mountedRef.current) return;
      if (result.error) {
        const failure = remoteFailureFromError(result.error);
        toast.error({
          message:
            failure.access === "denied"
              ? "Your current role cannot record this segment snapshot."
              : "The segment snapshot could not be recorded.",
          detail: `${diagnostics(result.error)} No evaluation record was confirmed.`,
        });
        return;
      }
      const snapshot = normalizeSnapshot(result.data, segmentId);
      if (!snapshot) {
        const invalid = {
          kind: "parse" as const,
          code: "invalid_segment_snapshot_record",
        };
        toast.error({
          message: "The segment snapshot response could not be verified.",
          detail: `${diagnostics(invalid)} Refresh before relying on this record.`,
        });
        return;
      }
      const message = `Recorded snapshot ${snapshot.id}: ${snapshot.count.toLocaleString()} matched, ${snapshot.sample_size.toLocaleString()} cached for browsing.`;
      setConfirmation(message);
      toast.success({
        message: "Segment evaluation snapshot recorded.",
        detail: `${message} This is an evaluation record, not an immutable recipient list.`,
      });
      await refreshSnapshots();
    });
    if (request) await request;
  }

  const recording = operation.active || operation.promiseRef.current !== null;
  const loading = snapshots.transport === "loading";
  const list = snapshots.data;

  return (
    <section className="card segment-snapshots" aria-labelledby={headingId}>
      <header className="segment-snapshots-header">
        <div>
          <h3 id={headingId} className="section-title">
            Evaluation snapshots
          </h3>
          <p className="muted">
            Each record retains the predicate, evaluated count, and a bounded
            browsing sample. It is not a complete immutable recipient list and
            cannot by itself recreate the exact audience later.
          </p>
        </div>
        <div className="segment-snapshots-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost pw-discoverable-unavailable"
            aria-disabled={loading || undefined}
            aria-describedby={actionHelpId}
            onClick={() => {
              if (!loading) void refreshSnapshots();
            }}
          >
            {loading ? "Refreshing…" : "Refresh records"}
          </button>
          <button
            type="button"
            className="btn btn-sm pw-discoverable-unavailable"
            aria-disabled={!canMutate || recording || undefined}
            aria-busy={recording ? "true" : undefined}
            aria-describedby={actionHelpId}
            onClick={() => {
              if (canMutate && !recording) void recordSnapshot();
            }}
          >
            {recording ? "Recording…" : "Record snapshot"}
          </button>
        </div>
      </header>

      <p id={actionHelpId} className="pw-action-status">
        {!canMutate
          ? "An editor or administrator role is required to record a snapshot. Existing records remain available to inspect."
          : recording
            ? "The current predicate is being evaluated. Keep Moosewave open until the record and list refresh finish."
            : loading
              ? "The verified snapshot list is refreshing. Recording remains available when this refresh finishes."
              : "Record the current predicate, evaluated count, and bounded browsing sample without claiming a frozen recipient list."}
      </p>

      {confirmation ? (
        <p className="segment-snapshots-confirmation" role="status">
          {confirmation}
        </p>
      ) : null}

      <RemoteDataNotice
        resource={snapshots}
        label="segment evaluation snapshots"
        onRetry={() => void refreshSnapshots()}
      />

      {isInitialRemoteLoad(snapshots) ? (
        <p className="muted" role="status" aria-busy="true">
          Verifying evaluation snapshots…
        </p>
      ) : list === null ? null : list.length === 0 ? (
        <p className="segment-snapshots-empty">
          No verified evaluation snapshots exist for this segment yet.
        </p>
      ) : (
        <ol id={listId} className="segment-snapshots-list">
          {list.map((snapshot, index) => {
            const memberPanelId = `${listId}-members-${index}`;
            return (
              <li key={snapshot.id}>
                <SnapshotRecord
                  snapshot={snapshot}
                  memberPanelId={memberPanelId}
                  open={openId === snapshot.id}
                  onToggle={() =>
                    setOpenId((current) =>
                      current === snapshot.id ? null : snapshot.id,
                    )
                  }
                />
              </li>
            );
          })}
        </ol>
      )}

      {snapshots.lastVerifiedAt ? (
        <p className="segment-snapshots-verified muted">
          Snapshot list last verified{" "}
          <time dateTime={new Date(snapshots.lastVerifiedAt).toISOString()}>
            {new Date(snapshots.lastVerifiedAt).toLocaleString()}
          </time>
          .
        </p>
      ) : null}
    </section>
  );
}

function SnapshotRecord({
  snapshot,
  memberPanelId,
  open,
  onToggle,
}: {
  snapshot: SegmentSnapshot;
  memberPanelId: string;
  open: boolean;
  onToggle: () => void;
}): ReactElement {
  const headingId = `${memberPanelId}-heading`;
  const sampled = snapshot.sample_size < snapshot.count;
  return (
    <article className="segment-snapshot-record" aria-labelledby={headingId}>
      <div className="segment-snapshot-record-header">
        <div>
          <h4 id={headingId}>
            Snapshot from {fmtDateTime(snapshot.created_at)}
          </h4>
          <span className="muted">
            Created {fmtRelative(snapshot.created_at)}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-expanded={open}
          aria-controls={memberPanelId}
          onClick={onToggle}
        >
          {open ? "Hide cached members" : "View cached members"}
        </button>
      </div>

      <dl className="segment-snapshot-facts">
        <div>
          <dt>Matched at evaluation</dt>
          <dd className="tabular">{snapshot.count.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Cached for browsing</dt>
          <dd className="tabular">{snapshot.sample_size.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Evaluated</dt>
          <dd>
            <time dateTime={snapshot.evaluated_at}>
              {fmtDateTime(snapshot.evaluated_at)}
            </time>{" "}
            <span className="muted">
              ({fmtRelative(snapshot.evaluated_at)})
            </span>
          </dd>
        </div>
        <div>
          <dt>Evaluator version</dt>
          <dd>
            <code>{snapshot.evaluator_version}</code>
          </dd>
        </div>
        <div className="segment-snapshot-wide-fact">
          <dt>Snapshot ID</dt>
          <dd>
            <code>{snapshot.id}</code>
          </dd>
        </div>
      </dl>

      <p
        className={`segment-snapshot-sample-note${
          sampled ? " is-sampled" : ""
        }`}
      >
        <span className={`badge${sampled ? " warning" : ""}`}>
          {sampled ? "Bounded sample" : "Complete browsing cache"}
        </span>
        <span>
          {sampled
            ? `${snapshot.sample_size.toLocaleString()} of ${snapshot.count.toLocaleString()} evaluated members were cached for inspection. The uncached membership rows are not available from this record.`
            : `All ${snapshot.count.toLocaleString()} evaluated member rows are available in this browsing cache. This still does not make the record a reusable recipient list.`}
        </span>
      </p>

      {open ? (
        <SnapshotMembers id={memberPanelId} snapshotId={snapshot.id} />
      ) : null}
    </article>
  );
}

function SnapshotMembers({
  id,
  snapshotId,
}: {
  id: string;
  snapshotId: string;
}): ReactElement {
  const headingId = useId();
  const pagingHelpId = useId();
  const refreshRef = useRef<Promise<void> | null>(null);
  const [page, setPage] = useState(1);
  const members = useRemoteResource(
    () => loadSnapshotMembers(snapshotId, page),
    { identity: `segment-snapshot-members:${snapshotId}:${page}` },
  );
  const pageData = members.data?.page === page ? members.data : null;
  const browseable = pageData
    ? pageData.sample_is_complete
      ? pageData.total
      : pageData.sample_size
    : 0;
  const totalPages = Math.max(1, Math.ceil(browseable / MEMBERS_PER_PAGE));
  const loading =
    members.transport === "loading" || members.data?.page !== page;
  const rows = pageData?.items ?? [];

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshRef.current) {
      await refreshRef.current;
      return;
    }
    let tracked: Promise<void>;
    tracked = members.reload().finally(() => {
      if (refreshRef.current === tracked) refreshRef.current = null;
    });
    refreshRef.current = tracked;
    await tracked;
  }, [members.reload]);

  const previousUnavailable = loading || page <= 1;
  const nextUnavailable = loading || page >= totalPages;
  const firstVisible = rows.length ? (page - 1) * MEMBERS_PER_PAGE + 1 : 0;
  const lastVisible = rows.length ? firstVisible + rows.length - 1 : 0;

  return (
    <section
      id={id}
      className="segment-snapshot-members"
      aria-labelledby={headingId}
    >
      <div className="segment-snapshot-members-header">
        <div>
          <h5 id={headingId}>Cached member sample</h5>
          <p className="muted">
            Snapshot ID: <code>{snapshotId}</code>
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost pw-discoverable-unavailable"
          aria-disabled={loading || undefined}
          onClick={() => {
            if (!loading) void refresh();
          }}
        >
          {loading ? "Refreshing page…" : "Refresh page"}
        </button>
      </div>

      <RemoteDataNotice
        resource={members}
        label="cached snapshot members"
        onRetry={() => void refresh()}
      />

      {isInitialRemoteLoad(members) || (members.data && !pageData) ? (
        <p className="muted" role="status" aria-busy="true">
          Verifying cached members for page {page.toLocaleString()}…
        </p>
      ) : pageData === null ? null : (
        <>
          <p className="segment-snapshot-member-scope">
            {pageData.sample_is_complete
              ? `This cache contains all ${pageData.total.toLocaleString()} evaluated members.`
              : `This record exposes ${pageData.sample_size.toLocaleString()} cached members from ${pageData.total.toLocaleString()} matches at evaluation time. The remaining membership rows were not retained.`}
          </p>

          {rows.length === 0 ? (
            <p className="muted">No cached members exist on this page.</p>
          ) : (
            <div
              className="segment-snapshot-member-table-wrap"
              role="region"
              aria-label="Scrollable cached member table"
              tabIndex={0}
            >
              <table className="segment-snapshot-member-table">
                <caption className="visually-hidden">
                  Cached members for snapshot {snapshotId}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Email address</th>
                    <th scope="col">Subscriber ID</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((member, index) => (
                    <tr
                      key={`${member.subscriber_id || member.email}-${index}`}
                    >
                      <td>
                        {member.email || (
                          <span className="muted">Not recorded</span>
                        )}
                      </td>
                      <td>
                        <code>{member.subscriber_id || "Not recorded"}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <nav
            className="segment-snapshot-pagination"
            aria-label="Cached member pages"
          >
            <button
              type="button"
              className="btn btn-sm btn-ghost pw-discoverable-unavailable"
              aria-disabled={previousUnavailable || undefined}
              aria-describedby={pagingHelpId}
              onClick={() => {
                if (!previousUnavailable) {
                  setPage((current) => Math.max(1, current - 1));
                }
              }}
            >
              Previous page
            </button>
            <span className="muted tabular" aria-live="polite">
              Page {page.toLocaleString()} of {totalPages.toLocaleString()}
              {rows.length
                ? ` · cached rows ${firstVisible.toLocaleString()}–${lastVisible.toLocaleString()} of ${browseable.toLocaleString()}`
                : ""}
            </span>
            <button
              type="button"
              className="btn btn-sm btn-ghost pw-discoverable-unavailable"
              aria-disabled={nextUnavailable || undefined}
              aria-describedby={pagingHelpId}
              onClick={() => {
                if (!nextUnavailable) {
                  setPage((current) => Math.min(totalPages, current + 1));
                }
              }}
            >
              Next page
            </button>
          </nav>
          <p id={pagingHelpId} className="pw-action-status">
            {loading
              ? "Paging is unavailable until the current page has been verified."
              : totalPages === 1
                ? "All cached rows fit on one page."
                : page === 1
                  ? "This is the first cached-member page."
                  : page === totalPages
                    ? "This is the last cached-member page."
                    : "Use Previous page or Next page to inspect the bounded cache."}
          </p>
        </>
      )}
    </section>
  );
}
