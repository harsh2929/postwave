/**
 * SmsSuppressions — SMS channel suppression list.
 *
 * Mirrors `Suppressions.tsx` (email) but for `sms_suppressions` rows
 * (migration 0253). Adds the SMS-specific reason enum
 * (manual / stop_keyword / help_keyword / carrier_block / complaint /
 * quiet_hours / expired) and an E.164 phone display.
 *
 * Sub-cards rendered below the list:
 *   - SmsQuietHoursCard       (GAP-LS-145) — stored tenant gate policy;
 *     hosted dispatch and scheduling remain release-held
 *   - SmsKeywordResponsesCard (GAP-LS-146 / GAP-LS-147) — stored custom
 *     opt-out rules and built-in semantic reference; provider callbacks
 *     and automatic replies remain release-held
 *
 * Backend reality (spec):
 *   - GET    /api/v1/sms/suppressions
 *   - POST   /api/v1/sms/suppressions/query (exact phone; body only)
 *   - POST   /api/v1/sms/suppressions
 *   - DELETE /api/v1/sms/suppressions/:id
 *
 * The list fails closed when the authoritative route or strict response
 * contract is unavailable. Manual mutations remain disabled in that state.
 *
 * Gaps: GAP-LS-014 / GAP-LS-100 / GAP-LS-109 / GAP-LS-145 /
 *       GAP-LS-146 / GAP-LS-147.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { FieldError, FormField, useFormErrors } from "../components/FormField";
import { Modal, ModalFooter } from "../components/Modal";
import { ConfirmModal } from "../components/ConfirmModal";
import { SmsQuietHoursCard } from "../components/sms/SmsQuietHoursCard";
import { SmsKeywordResponsesCard } from "../components/sms/SmsKeywordResponsesCard";
import { SmsA2PRegistrationCard } from "../components/sms/SmsA2PRegistrationCard";
import { TapToTextBlockEditor } from "../components/sms/TapToTextBlockEditor";
import { normalizeSMSUSCA } from "../components/sms/sms-reply-intent";
import { toast } from "../components/Toast";
import { type SmsSuppressionRow, smsSuppressionsApi } from "../lib/api-client";
import { onContextEpochObserved, readContextEpoch } from "../lib/context-epoch";
import { desktopRouteIdentityScope } from "../lib/desktop-router";
import { fmtDate } from "../lib/format-date";
import { useCanAdmin, useMe } from "../lib/store";

import "../styles-sms-suppressions.css";

type Filter =
  | "all"
  | "manual"
  | "stop_keyword"
  | "help_keyword"
  | "carrier_block"
  | "complaint"
  | "quiet_hours"
  | "expired";

const PAGE_SIZE = 25;
const COLS = "1.6fr 160px 1.2fr 80px";

const FILTER_CHIPS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "stop_keyword", label: "STOP" },
  { value: "help_keyword", label: "HELP" },
  { value: "carrier_block", label: "Carrier" },
  { value: "complaint", label: "Complaint" },
  { value: "quiet_hours", label: "Quiet hrs" },
  { value: "manual", label: "Manual" },
];

function reasonBadge(reason: string | undefined): ReactElement {
  const r = (reason ?? "").toLowerCase();
  if (r === "stop_keyword") return <span className="badge danger">STOP</span>;
  if (r === "help_keyword") return <span className="badge warning">HELP</span>;
  if (r === "carrier_block")
    return <span className="badge danger">Carrier</span>;
  if (r === "complaint") return <span className="badge danger">Complaint</span>;
  if (r === "quiet_hours") return <span className="badge">Quiet hrs</span>;
  if (r === "expired") return <span className="badge">Expired</span>;
  if (r === "manual") return <span className="badge">Manual</span>;
  return <span className="badge">{reason || "—"}</span>;
}

function suppressionIsReversible(row: SmsSuppressionRow): boolean {
  return (
    row.reason?.toLowerCase() === "manual" &&
    (row as SmsSuppressionRow & { reversible?: boolean }).reversible === true
  );
}

function verifiedManualSuppression(
  value: unknown,
  phone: string,
): value is SmsSuppressionRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SmsSuppressionRow>;
  return (
    typeof row.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      row.id,
    ) &&
    row.phone_e164 === phone &&
    row.reason === "manual" &&
    row.source === "manual" &&
    row.reversible === true &&
    row.locked_reason === undefined &&
    typeof row.created_at === "string" &&
    Number.isFinite(Date.parse(row.created_at))
  );
}

function suppressionAuthority(row: SmsSuppressionRow): string {
  const reason = row.reason?.toLowerCase();
  if (suppressionIsReversible(row)) return "Manual · removable by an admin";
  if (reason === "stop_keyword") {
    return "STOP-classified · locked";
  }
  if (reason === "carrier_block") {
    return "Carrier-block-classified · locked";
  }
  if (reason === "complaint") {
    return "Complaint-classified · locked";
  }
  return "System-classified · locked";
}

/**
 * Format an E.164 phone for display. Returns "+1 (415) 555-0118" style
 * for US/CA numbers; falls back to a space-grouped version for the rest
 * so dense lists stay scannable.
 */
function fmtPhone(e164: string | undefined): string {
  const v = (e164 || "").trim();
  if (!v) return "—";
  // US/CA: +1XXXYYYZZZZ → "+1 (XXX) YYY-ZZZZ"
  const us = v.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (us) return `+1 (${us[1]}) ${us[2]}-${us[3]}`;
  // Otherwise group every 3 after the country prefix.
  const m = v.match(/^\+(\d{1,3})(\d+)$/);
  if (m) {
    const cc = m[1];
    const rest = (m[2] ?? "").match(/.{1,3}/g)?.join(" ") ?? m[2] ?? "";
    return `+${cc} ${rest}`;
  }
  return v;
}

/**
 * D05-consent-suppressions#7: normalize a manually entered number to E.164
 * using the same strict grammar as the server-side send gate
 * (sms.NormalizePhoneUSCA): canonical digits or reviewed ASCII formatting
 * separators around 10 digits, optionally prefixed by 1/+1. Letters, controls,
 * bidi marks, and unreviewed punctuation are rejected instead of stripped or
 * reinterpreted. Manual suppressions used to POST the raw string, but
 * the STOP/compliance gate matches `phone_e164 = NormalizePhoneUSCA(recipient)`
 * exactly, so a formatted ("+1 (415) 555-0118") or plus-less ("14155550118")
 * entry never matched — the number stayed suppressible on the dashboard yet
 * kept receiving SMS (TCPA exposure). Normalizing here makes the stored row
 * match what the gate computes. US/CA-only, mirroring the backend (the SMS
 * launch surface is US/CA-only); returns null for anything the gate can't
 * normalize so we reject it instead of storing a row that can never match.
 */
function normalizeUsCaE164(raw: string): string | null {
  return normalizeSMSUSCA(raw);
}

interface SmsSuppressionToolbarProps {
  filter: Filter;
  loading: boolean;
  query: string;
  onFilterChange: (filter: Filter) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
}

function SmsSuppressionToolbar({
  filter,
  loading,
  query,
  onFilterChange,
  onQueryChange,
  onRefresh,
}: SmsSuppressionToolbarProps): ReactElement {
  return (
    <div className="sms-suppression-toolbar" role="search">
      <input
        type="search"
        className="input sms-suppression-search"
        aria-label="Filter by exact US/Canada phone"
        placeholder="Exact US/Canada phone…"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        autoComplete="off"
        inputMode="tel"
        maxLength={32}
        spellCheck={false}
      />
      <div className="chips sms-suppression-filters" aria-label="Reason filter">
        {FILTER_CHIPS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`chip${filter === option.value ? " is-active" : ""}`}
            onClick={() => onFilterChange(option.value)}
            aria-pressed={filter === option.value}
          >
            {option.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn sms-suppression-refresh"
        onClick={onRefresh}
        disabled={loading}
        aria-busy={loading || undefined}
      >
        {loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}

interface SmsSuppressionListProps {
  canAdd: boolean;
  canDelete: boolean;
  filter: Filter;
  loading: boolean;
  verified: boolean;
  page: number;
  rows: SmsSuppressionRow[];
  query: string;
  total: number | null;
  snapshotAt: string | null;
  hasNext: boolean;
  onAdd: () => void;
  onDelete: (row: SmsSuppressionRow, trigger: HTMLButtonElement) => void;
  onNext: () => void;
  onPrevious: () => void;
}

interface VerifiedSuppressionPage {
  criteriaKey: string;
  cursor?: string;
  items: SmsSuppressionRow[];
  nextCursor: string | null;
  snapshotAt: string;
  total: number;
}

function SmsSuppressionList({
  canAdd,
  canDelete,
  filter,
  loading,
  verified,
  page,
  rows,
  query,
  total,
  snapshotAt,
  hasNext,
  onAdd,
  onDelete,
  onNext,
  onPrevious,
}: SmsSuppressionListProps): ReactElement {
  const showInitialSkeleton = loading && !verified;
  return (
    <>
      <div
        className="list sms-suppression-list"
        role="table"
        aria-label="Authoritative SMS suppression records"
        aria-busy={loading || undefined}
      >
        <div
          className="list-header sms-suppression-list-header"
          style={{ gridTemplateColumns: COLS }}
          role="row"
        >
          <div role="columnheader">Phone</div>
          <div role="columnheader">Reason and authority</div>
          <div role="columnheader">Added</div>
          <div role="columnheader" className="visually-hidden">
            Actions
          </div>
        </div>
        {showInitialSkeleton ? (
          <div role="row">
            <div
              className="sms-suppression-loading"
              role="cell"
              aria-colspan={4}
            >
              <div role="status">
                <span className="visually-hidden">
                  Loading suppression records
                </span>
                {[0, 1, 2, 3, 4].map((index) => (
                  <div key={index} className="skel-row" />
                ))}
              </div>
            </div>
          </div>
        ) : !verified ? (
          <div role="row">
            <div className="list-empty" role="cell" aria-colspan={4}>
              <span role="status">
                No decoded suppression rows are available. Refresh after the
                authoritative service is restored.
              </span>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div role="row">
            <div className="list-empty" role="cell" aria-colspan={4}>
              <div className="empty-state">
                <div className="empty-state-icon" aria-hidden="true">
                  ·
                </div>
                <h3>
                  {query
                    ? "No record matches this exact phone"
                    : filter !== "all"
                      ? "No matching SMS suppressions"
                      : "No SMS suppressions yet"}
                </h3>
                <p>
                  {query
                    ? "Clear search to return to the paginated registry."
                    : filter !== "all"
                      ? "Try a different reason filter."
                      : "Verified STOP records appear here when ingested; hosted provider callbacks remain release-held."}
                </p>
                {!query && filter === "all" && canAdd ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={onAdd}
                  >
                    Add a manual suppression
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          rows.map((row, index) => (
            <div
              key={String(row.id ?? row.phone_e164 ?? index)}
              className="list-row sms-suppression-row"
              style={{ gridTemplateColumns: COLS }}
              role="row"
            >
              <div
                className="tabular sms-suppression-phone"
                role="cell"
                data-label="Phone"
              >
                <bdi dir="ltr">{fmtPhone(row.phone_e164)}</bdi>
              </div>
              <div
                className="sms-suppression-authority"
                role="cell"
                data-label="Authority"
              >
                {reasonBadge(row.reason)}
                <span className="muted small">{suppressionAuthority(row)}</span>
                <span className="muted small">
                  Source: <bdi>{row.source}</bdi>
                </span>
              </div>
              <div
                className="muted tabular sms-suppression-date"
                role="cell"
                data-label="Added"
              >
                {fmtDate(row.created_at)}
              </div>
              <div
                className="sms-suppression-row-action"
                role="cell"
                data-label="Action"
              >
                {suppressionIsReversible(row) ? (
                  <div className="list-row-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={(event) => onDelete(row, event.currentTarget)}
                      disabled={!canDelete}
                      aria-disabled={!canDelete}
                      aria-label={`Remove suppression for ${fmtPhone(row.phone_e164)}`}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <span className="muted small" aria-label="Locked suppression">
                    Locked
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      {loading && verified ? (
        <p className="muted small sms-suppression-refreshing" role="status">
          Refreshing; the last verified page remains visible and changes are
          paused.
        </p>
      ) : null}
      <nav className="pagination" aria-label="Suppression pages">
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading || !verified || page <= 1}
          onClick={onPrevious}
        >
          Prev
        </button>
        <span className="muted small tabular">
          Page {page}
          {total === null ? "" : ` · ${total.toLocaleString()} matching total`}
          {snapshotAt
            ? ` · insertion cutoff ${new Date(snapshotAt).toLocaleString()}`
            : ""}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading || !verified || !hasNext}
          onClick={onNext}
        >
          Next
        </button>
      </nav>
      {snapshotAt ? (
        <p className="muted small">
          Pages share a created-at cutoff, not a repeatable database snapshot.
          Authoritative rows can change, and late commits at or before the
          cutoff may differ after refresh.
        </p>
      ) : null}
    </>
  );
}

interface SmsSuppressionAddModalProps {
  adding: boolean;
  changesAllowed: boolean;
  errors: ReturnType<typeof useFormErrors>;
  open: boolean;
  phone: string;
  onClose: () => void;
  onPhoneChange: (phone: string) => void;
  onSubmit: () => void;
}

function SmsSuppressionAddModal({
  adding,
  changesAllowed,
  errors,
  open,
  phone,
  onClose,
  onPhoneChange,
  onSubmit,
}: SmsSuppressionAddModalProps): ReactElement {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add SMS suppression"
      description="Block outbound SMS to one phone number."
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!adding && changesAllowed) onSubmit();
        }}
        onKeyDownCapture={(event) => {
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing || event.keyCode === 229)
          ) {
            event.preventDefault();
          }
        }}
      >
        <FormField
          label="US/Canada phone"
          required
          htmlFor="sms-supp-phone"
          error={errors.get("phone")}
          helpTooltip="This launch supports US/Canada NANP numbers only. Example: +12025550118."
        >
          <input
            id="sms-supp-phone"
            type="tel"
            className="input"
            placeholder="+12025550118"
            value={phone}
            onChange={(event) => {
              onPhoneChange(event.target.value);
              errors.clear("phone");
              errors.clear("_form");
            }}
            autoComplete="tel"
            inputMode="tel"
            maxLength={32}
            spellCheck={false}
          />
        </FormField>
        <div className="notice" role="note">
          This creates a manual suppression. STOP, carrier, complaint, and other
          system reasons can only be recorded by their authoritative workflows.
        </div>
        {errors.get("_form") ? (
          <FieldError>{errors.get("_form")}</FieldError>
        ) : null}
        {!changesAllowed ? (
          <div className="notice" role="note">
            The current registry view is loading or stale. Close this dialog and
            refresh before changing the send-safety boundary.
          </div>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={adding}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={adding || !changesAllowed}
          >
            {adding ? "Adding…" : "Suppress"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

export function SmsSuppressions(): ReactElement {
  const canAdmin = useCanAdmin();
  return canAdmin ? (
    <SmsSuppressionsAdminRoute />
  ) : (
    <SmsSuppressionsAccessBoundary />
  );
}

function SmsSuppressionsAdminRoute(): ReactElement {
  const me = useMe();
  const contextEpoch = useSyncExternalStore(
    onContextEpochObserved,
    readContextEpoch,
    readContextEpoch,
  );
  const durableScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  const identityScope = `${durableScope ?? "unresolved"}:${
    me?.effectiveRole ?? "unknown"
  }:${contextEpoch ?? "unobserved"}`;
  return <SmsSuppressionsAdmin key={identityScope} />;
}

function SmsSuppressionsAccessBoundary(): ReactElement {
  return (
    <section
      className="page sms-suppressions-route sms-suppressions-access-boundary"
      aria-labelledby="sms-suppressions-access-title"
    >
      <div className="page-header-v2">
        <div>
          <div className="page-header-v2-eyebrow">Audience protection</div>
          <h1
            id="sms-suppressions-access-title"
            className="page-header-v2-title"
          >
            SMS suppressions
          </h1>
          <div className="page-header-v2-subtitle">
            Admin-scoped consent authority
          </div>
        </div>
      </div>
      <div className="notice" role="note">
        SMS suppression records can expose phone numbers, consent revocations,
        complaints, and carrier actions. Your current role cannot read or change
        this authority list; no protected suppression or supporting SMS settings
        requests were started.
      </div>
    </section>
  );
}

function SmsSuppressionsAdmin(): ReactElement {
  const canAdmin = true;
  const mountedRef = useRef(true);
  const [rows, setRows] = useState<SmsSuppressionRow[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [listUnavailable, setListUnavailable] = useState<boolean>(false);
  const loadSequenceRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [loadedCriteriaKey, setLoadedCriteriaKey] = useState<string | null>(
    null,
  );

  const [query, setQuery] = useState<string>("");
  const [filter, setFilter] = useState<Filter>("all");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCache, setPageCache] = useState<VerifiedSuppressionPage[]>([]);

  /* Add modal state */
  const [addOpen, setAddOpen] = useState<boolean>(false);
  const [addPhone, setAddPhone] = useState<string>("");
  const [adding, setAdding] = useState<boolean>(false);
  const addingRef = useRef(false);
  const errors = useFormErrors();

  /* Delete confirm */
  const [deleteTarget, setDeleteTarget] = useState<SmsSuppressionRow | null>(
    null,
  );
  const [deleting, setDeleting] = useState<boolean>(false);
  const deletingRef = useRef(false);
  const deleteReturnFocusRef = useRef<HTMLButtonElement | null>(null);

  const queryPresent = query.length > 0;
  const normalizedQuery = queryPresent ? normalizeUsCaE164(query) : undefined;
  const queryInvalid = queryPresent && normalizedQuery === null;
  const criteriaKey = `${filter}\u0000${normalizedQuery ?? ""}`;
  const criteriaVerified =
    rows !== null && loadedCriteriaKey === criteriaKey && !queryInvalid;
  const authorityCurrent =
    criteriaVerified && !loading && err === null && !listUnavailable;
  const registryDialogActive = addOpen || deleteTarget !== null;
  const registryOperationActive = adding || deleting;
  const registryMutationReady =
    authorityCurrent && !registryDialogActive && !registryOperationActive;

  const load = useCallback(
    async ({
      filterReason,
      phone,
      cursor,
      index,
      expectedSnapshot,
      requestCriteriaKey,
    }: {
      filterReason: Filter;
      phone?: string;
      cursor?: string;
      index: number;
      expectedSnapshot?: string | null;
      requestCriteriaKey: string;
    }): Promise<boolean> => {
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      const requestId = ++loadSequenceRef.current;
      setLoading(true);
      setErr(null);
      const reason = filterReason === "all" ? undefined : filterReason;
      try {
        const res = await smsSuppressionsApi.list({
          reason,
          phone,
          ...(phone ? {} : { cursor, limit: PAGE_SIZE }),
          signal: controller.signal,
        });
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          requestId !== loadSequenceRef.current
        ) {
          return false;
        }
        if (res.error) {
          const status = res.error.status ?? 0;
          if (status === 404 || status === 405) {
            setListUnavailable(true);
            setErr(
              "This server does not expose an authoritative SMS suppression list.",
            );
          } else if (res.error.code === "invalid_sms_suppression_response") {
            setListUnavailable(false);
            setErr(
              "The suppression response failed its private row and pagination contract. No unverified rows were shown.",
            );
            setRows(null);
            setLoadedCriteriaKey(null);
            setTotal(null);
            setNextCursor(null);
            setSnapshotAt(null);
          } else {
            setListUnavailable(false);
            setErr(
              "The authoritative SMS suppression list could not be loaded.",
            );
          }
          return false;
        }
        if (expectedSnapshot && res.data.snapshotAt !== expectedSnapshot) {
          setNextCursor(null);
          setErr(
            "The suppression insertion boundary changed between pages. Refresh from the first page before continuing.",
          );
          return false;
        }
        setListUnavailable(false);
        setRows(res.data.items);
        setLoadedCriteriaKey(requestCriteriaKey);
        setTotal(res.data.total);
        setNextCursor(res.data.nextCursor ?? null);
        setSnapshotAt(res.data.snapshotAt);
        setPageIndex(index);
        const verifiedPage: VerifiedSuppressionPage = {
          criteriaKey: requestCriteriaKey,
          cursor,
          items: res.data.items,
          nextCursor: res.data.nextCursor ?? null,
          snapshotAt: res.data.snapshotAt,
          total: res.data.total,
        };
        setPageCache((current) => {
          if (index === 0) return [verifiedPage];
          const next = current.slice(0, index + 1);
          next[index] = verifiedPage;
          return next;
        });
        return true;
      } catch {
        if (
          mountedRef.current &&
          !controller.signal.aborted &&
          requestId === loadSequenceRef.current
        ) {
          setListUnavailable(false);
          setErr("The authoritative SMS suppression list could not be loaded.");
        }
        return false;
      } finally {
        if (
          mountedRef.current &&
          !controller.signal.aborted &&
          requestId === loadSequenceRef.current
        ) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    setPageIndex(0);
    setNextCursor(null);
    setSnapshotAt(null);
    setTotal(null);
    setPageCache([]);
    if (queryInvalid) {
      loadAbortRef.current?.abort();
      loadSequenceRef.current += 1;
      setLoading(false);
      setRows(null);
      setLoadedCriteriaKey(null);
      setErr(
        "Phone filtering is exact and US/Canada-only. Enter 10 digits, optionally prefixed with +1, or clear the field.",
      );
      return;
    }
    const request = (): void => {
      void load({
        filterReason: filter,
        phone: normalizedQuery ?? undefined,
        index: 0,
        requestCriteriaKey: criteriaKey,
      });
    };
    if (!queryPresent) {
      request();
      return;
    }
    const timer = window.setTimeout(request, 250);
    return () => window.clearTimeout(timer);
  }, [
    criteriaKey,
    filter,
    load,
    normalizedQuery,
    query,
    queryInvalid,
    queryPresent,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadAbortRef.current?.abort();
      loadSequenceRef.current += 1;
    };
  }, []);

  const refreshFirstPage = (): Promise<boolean> =>
    load({
      filterReason: filter,
      phone: normalizedQuery ?? undefined,
      index: 0,
      requestCriteriaKey: criteriaKey,
    });

  const restoreVerifiedPage = (index: number): boolean => {
    const cached = pageCache[index];
    if (
      !cached ||
      cached.criteriaKey !== criteriaKey ||
      (snapshotAt !== null && cached.snapshotAt !== snapshotAt)
    ) {
      return false;
    }
    loadAbortRef.current?.abort();
    loadSequenceRef.current += 1;
    setLoading(false);
    setErr(null);
    setListUnavailable(false);
    setRows(cached.items);
    setLoadedCriteriaKey(cached.criteriaKey);
    setTotal(cached.total);
    setNextCursor(cached.nextCursor);
    setSnapshotAt(cached.snapshotAt);
    setPageIndex(index);
    return true;
  };

  const openAdd = (): void => {
    if (!authorityCurrent || registryDialogActive || registryOperationActive)
      return;
    setAddPhone("");
    errors.clear();
    setAddOpen(true);
  };

  const submitAdd = async (): Promise<void> => {
    const raw = addPhone;
    errors.clear();
    if (raw.replace(/^ +| +$/gu, "") === "") {
      errors.set("phone", "Phone number is required.");
      return;
    }
    // D05: normalize to E.164 exactly as the send gate does BEFORE POSTing,
    // so the stored row matches `phone_e164` at enforcement time. Reject
    // anything the gate can't normalize (non-US/CA) rather than store a row
    // that would silently never match.
    const phone = normalizeUsCaE164(raw);
    if (!phone) {
      errors.set(
        "phone",
        "Enter a valid US/Canada number (e.g. +14155550118 or 4155550118) — 10 digits, or 11 starting with 1.",
      );
      return;
    }
    if (!canAdmin || !authorityCurrent || addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    try {
      const res = await smsSuppressionsApi.add({ phone, reason: "manual" });
      if (!mountedRef.current) return;
      if (res.error) {
        errors.set(
          "_form",
          res.error.code === "identity_changed"
            ? "Workspace identity changed while this request was in flight. Its server outcome is unknown; return to the original workspace and verify this exact phone before retrying. Do not assume the suppression failed."
            : res.error.status === 409
              ? "This number already has an authoritative suppression. Refresh before making another change."
              : res.error.status === 400 || res.error.status === 422
                ? "The server rejected this manual suppression. Verify the US/Canada number and retry."
                : "The manual suppression outcome could not be verified. Refresh this exact phone before retrying; do not assume no row was created.",
        );
        return;
      }
      if (!verifiedManualSuppression(res.data, phone)) {
        errors.set(
          "_form",
          "The server returned an unverified suppression receipt. Refresh this exact phone before retrying; do not assume no row was created.",
        );
        return;
      }
      setAddOpen(false);
      toast.success(`${phone} manually suppressed`);
      await refreshFirstPage();
    } catch {
      errors.set(
        "_form",
        "The manual suppression outcome could not be verified. Refresh this exact phone before retrying; do not assume no row was created.",
      );
    } finally {
      addingRef.current = false;
      if (mountedRef.current) setAdding(false);
    }
  };

  const onDeleteClicked = (
    row: SmsSuppressionRow,
    trigger: HTMLButtonElement,
  ): void => {
    if (
      !canAdmin ||
      !authorityCurrent ||
      registryDialogActive ||
      registryOperationActive ||
      !suppressionIsReversible(row)
    )
      return;
    deleteReturnFocusRef.current = trigger;
    setDeleteTarget(row);
  };

  const confirmDelete = async (): Promise<void> => {
    if (
      !deleteTarget ||
      !canAdmin ||
      !authorityCurrent ||
      !suppressionIsReversible(deleteTarget) ||
      deletingRef.current
    ) {
      return;
    }
    deletingRef.current = true;
    setDeleting(true);
    try {
      const res = await smsSuppressionsApi.remove(deleteTarget.id);
      if (!mountedRef.current) return;
      if (res.error) {
        const knownRemovalRejection =
          res.error.status === 400 ||
          res.error.status === 409 ||
          res.error.status === 422 ||
          res.error.code === "suppression_authoritative" ||
          res.error.code === "suppression_locked";
        toast.error({
          message:
            res.error.code === "identity_changed"
              ? "Manual suppression removal outcome unknown"
              : knownRemovalRejection
                ? "Couldn't remove manual SMS suppression"
                : "Manual suppression removal outcome unverified",
          detail:
            res.error.code === "identity_changed"
              ? "Workspace identity changed while removal was in flight. Its server outcome is unknown; reload the original workspace and verify the exact row before retrying."
              : res.error.status === 409 ||
                  res.error.code === "suppression_authoritative" ||
                  res.error.code === "suppression_locked"
                ? "The server identifies this as an authoritative system suppression. It remains locked."
                : res.error.status === 400 || res.error.status === 422
                  ? "The server refused this removal. Refresh the suppression record before retrying."
                  : "The removal outcome could not be verified. Refresh this exact row before retrying; do not assume it remains or was removed.",
        });
        return;
      }
      if (res.data?.ok !== true || res.data.id !== deleteTarget.id) {
        toast.error({
          message: "Couldn't remove manual SMS suppression",
          detail:
            "The server returned an unverified removal receipt. Refresh this exact row before retrying; do not assume it remains or was removed.",
        });
        return;
      }
      const label = fmtPhone(deleteTarget.phone_e164);
      toast.success(`${label} manual suppression removed`);
      setDeleteTarget(null);
      await refreshFirstPage();
    } catch {
      toast.error({
        message: "Manual suppression removal outcome unverified",
        detail:
          "Refresh this exact row before retrying; do not assume it remains or was removed.",
      });
    } finally {
      deletingRef.current = false;
      if (mountedRef.current) setDeleting(false);
    }
  };

  const totalLabel =
    criteriaVerified && total !== null
      ? `${total.toLocaleString()} matching ${total === 1 ? "number" : "numbers"} at the verified insertion cutoff`
      : queryInvalid
        ? "Enter a complete US/Canada phone for exact lookup"
        : "Loading the authoritative registry…";

  return (
    <section
      className="page sms-suppressions-route"
      aria-labelledby="sms-suppressions-title"
    >
      <header className="page-header-v2 sms-suppression-masthead">
        <div className="page-header-v2-text">
          <div className="page-header-v2-eyebrow">Audience protection</div>
          <h1 id="sms-suppressions-title" className="page-header-v2-title">
            SMS suppressions
          </h1>
          <div className="page-header-v2-subtitle">{totalLabel}</div>
          <div className="page-header-v2-meta sms-suppression-assurances">
            <span className="badge">Exact phone lookup</span>
            <span className="badge">Admin-only private rows</span>
            <span className="badge">Manual removal only</span>
          </div>
        </div>
        <div className="page-header-v2-actions">
          <div className="page-header-v2-action">
            <button
              type="button"
              className="btn btn-primary"
              onClick={openAdd}
              disabled={!registryMutationReady}
              aria-describedby="sms-suppression-write-reason"
            >
              Add manual suppression
            </button>
            <span
              id="sms-suppression-write-reason"
              className="page-header-v2-action-reason"
            >
              {registryMutationReady
                ? "Creates only a reversible manual row."
                : "Changes unlock only after this exact registry view is verified."}
            </span>
          </div>
        </div>
      </header>

      <section
        className="sms-suppression-registry"
        aria-labelledby="sms-suppression-registry-title"
      >
        <div className="sms-suppression-section-heading">
          <div>
            <h2 id="sms-suppression-registry-title">
              Authoritative suppression registry
            </h2>
            <p>
              Active rows only. Carrier, complaint, consent, and system rows
              stay locked; this screen can create or remove manual rows only.
            </p>
          </div>
          <span className="sms-suppression-sensitivity">
            Contains phone data
          </span>
        </div>

        <SmsSuppressionToolbar
          filter={filter}
          loading={loading}
          query={query}
          onFilterChange={setFilter}
          onQueryChange={setQuery}
          onRefresh={() => void refreshFirstPage()}
        />

        {err ? (
          <div className="notice sms-suppression-error" role="alert">
            <span>
              {criteriaVerified
                ? `Suppression refresh failed: ${err} The last verified page remains visible, is explicitly stale, and cannot be changed.`
                : `Couldn't load SMS suppressions: ${err}`}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void refreshFirstPage()}
              disabled={loading || queryInvalid}
            >
              Retry
            </button>
          </div>
        ) : null}

        <SmsSuppressionList
          canAdd={registryMutationReady}
          canDelete={registryMutationReady}
          filter={filter}
          loading={loading}
          verified={criteriaVerified}
          page={pageIndex + 1}
          rows={criteriaVerified ? (rows ?? []) : []}
          query={query}
          total={criteriaVerified ? total : null}
          snapshotAt={criteriaVerified ? snapshotAt : null}
          hasNext={criteriaVerified && nextCursor !== null}
          onAdd={openAdd}
          onDelete={onDeleteClicked}
          onPrevious={() => {
            if (pageIndex <= 0) return;
            if (!restoreVerifiedPage(pageIndex - 1)) {
              setErr(
                "The earlier verified page is no longer available in this snapshot. Refresh from the first page.",
              );
            }
          }}
          onNext={() => {
            if (!nextCursor) return;
            void load({
              filterReason: filter,
              phone: normalizedQuery ?? undefined,
              cursor: nextCursor,
              index: pageIndex + 1,
              expectedSnapshot: snapshotAt,
              requestCriteriaKey: criteriaKey,
            });
          }}
        />
      </section>

      <section
        className="sms-suppression-secondary-section"
        aria-labelledby="sms-suppression-policy-title"
      >
        <div className="sms-suppression-section-heading">
          <div>
            <h2 id="sms-suppression-policy-title">Stored policy controls</h2>
            <p>
              Valid enabled quiet-hours and custom opt-out rules are enforced by
              internal eligibility and inbound-state evaluators when invoked.
              Hosted provider callbacks, scheduling, dispatch, and automatic
              replies remain release-held; configuration is not proof of live
              traffic.
            </p>
          </div>
          <span className="badge warning">
            Internal policy active · hosted traffic held
          </span>
        </div>
        <div className="sms-suppression-card-stack">
          <SmsQuietHoursCard />
          <SmsKeywordResponsesCard />
        </div>
      </section>

      <section
        className="sms-suppression-secondary-section"
        aria-labelledby="sms-suppression-tools-title"
      >
        <div className="sms-suppression-section-heading">
          <div>
            <h2 id="sms-suppression-tools-title">
              Setup and local creative tools
            </h2>
            <p>
              Registration remains held. Tap-to-text output is generated on this
              device and does not configure a provider, enroll a person, or
              create consent evidence.
            </p>
          </div>
          <span className="badge">No live enrollment claim</span>
        </div>
        <div className="sms-suppression-tools-grid">
          <SmsA2PRegistrationCard />
          <TapToTextBlockEditor />
        </div>
      </section>

      <SmsSuppressionAddModal
        open={addOpen}
        adding={adding}
        changesAllowed={authorityCurrent}
        errors={errors}
        phone={addPhone}
        onClose={() => {
          if (!addingRef.current) setAddOpen(false);
        }}
        onPhoneChange={setAddPhone}
        onSubmit={() => void submitAdd()}
      />

      <ConfirmModal
        open={!!deleteTarget}
        title="Remove manual suppression?"
        description={
          deleteTarget
            ? `Remove the manual suppression for ${fmtPhone(deleteTarget.phone_e164)}? This does not prove the number is eligible: current consent, carrier, complaint, and system suppressions still apply.`
            : ""
        }
        confirmLabel="Remove manual suppression"
        danger
        busy={deleting}
        confirmDisabled={!authorityCurrent}
        typeToConfirm={deleteTarget?.phone_e164}
        returnFocusRef={deleteReturnFocusRef}
        onClose={() =>
          deletingRef.current ? undefined : setDeleteTarget(null)
        }
        onConfirm={confirmDelete}
      >
        {!authorityCurrent ? (
          <div className="notice" role="note">
            The registry is no longer current. Close this confirmation and
            refresh before changing the send-safety boundary.
          </div>
        ) : null}
      </ConfirmModal>
    </section>
  );
}
