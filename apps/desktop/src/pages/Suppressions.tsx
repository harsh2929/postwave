/**
 * Suppressions — the tenant's anti-spam / compliance list.
 *
 * Layout mirrors Subscribers.tsx: page header w/ primary action, a
 * search input + reason filter chips row, a paginated list, plus
 * "Add" and "Bulk import" modals.
 *
 * Backend reality:
 *   - GET    /api/v1/suppressions       — list (legacy email_suppressions)
 *   - POST   /api/v1/suppressions       — single add
 *   - POST   /api/v1/suppressions/bulk  — bulk add
 *   - DELETE /api/v1/suppressions/:id   — un-suppress (legacy rows)
 *   - GET    /api/v1/deliverability/suppressions?email=&q=
 *                                       — server-side search (X1 store)
 *   - POST   /api/v1/suppressions/bulk-delete / bulk-action
 *                                       — admin bulk verbs (by email)
 *   - POST   /api/v1/suppressions/mirror/{provider}
 *   - GET    /api/v1/suppressions/trend
 *
 * We still tolerate 404 / 405 for older self-hosted API builds and keep a
 * local session cache so adds remain visible after the mutation succeeds.
 *
 * Search is server-side when the query is usable as a server filter:
 * a full email goes through the `email=` exact filter, prefixes ≥3
 * chars go through `q=`. Client-side substring filtering of the
 * loaded page remains only as instant feedback while the request is
 * in flight (and for 1–2 char queries / older servers without the
 * filterable route).
 *
 * The un-suppress (delete) action and the bulk/mirror consoles are
 * admin-only — wired through the `useCanAdmin()` role helper. API-key
 * sessions (which can't surface a role today) default to permissive;
 * cookie sessions gate strictly.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { FieldError, FormField, useFormErrors } from "../components/FormField";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { HERO } from "../lib/heroAssets";
import { InlineHelp } from "../components/InlineHelp";

import { ImportSuppressionsModal } from "../components/suppressions/ImportSuppressionsModal";
import { BulkImportSuppressionsModal } from "../components/suppressions/BulkImportSuppressionsModal";
import { ConfirmModal } from "../components/ConfirmModal";
import { Modal, ModalFooter } from "../components/Modal";
import { BulkActionsMenu } from "../components/suppressions/BulkActionsMenu";
import { DateRangePopover } from "../components/suppressions/DateRangePopover";
import { MirrorFromEspModal } from "../components/suppressions/MirrorFromEspModal";
import { SuppressionDetailSlideover } from "../components/suppressions/SuppressionDetailSlideover";
import { SuppressionsStatStrip } from "../components/suppressions/SuppressionsStatStrip";
import { SuppressionsTrendChart } from "../components/suppressions/SuppressionsTrendChart";
import {
  classifySearchQuery,
  FILTER_REASON_ALIASES,
  reasonMatchesFilter,
  SERVER_SEARCH_MIN_PREFIX,
  type SuppressionFilter,
} from "../components/suppressions/suppression-search";
import { toast } from "../components/Toast";
import {
  buildStreamUrl,
  SUPPRESSION_REASONS,
  type SuppressionEntry,
  type SuppressionRow,
  suppressionsApi,
  suppressionsConvergedApi,
} from "../lib/api-client";
import { downloadUrlToFile } from "../lib/file-transfer";
import {
  consumePendingDeepLinkTarget,
  onPendingDeepLinkTarget,
} from "../lib/deep-link";
import { fmtDate } from "../lib/format-date";
import { useCanAdmin, useCanWrite } from "../lib/store";

type Filter = SuppressionFilter;

/**
 * A table row plus the store it came from. Rows loaded through the
 * legacy list live in `email_suppressions` (delete by id via the
 * legacy DELETE); rows surfaced by server-side search come from the
 * converged X1 table whose ids the legacy DELETE doesn't know — those
 * are removed by email via the converged endpoint instead.
 */
type Row = SuppressionRow & { x1?: boolean };

/** Map a converged X1 entry onto the table's row shape. */
function entryToRow(e: SuppressionEntry): Row {
  return {
    id: e.id,
    email: e.email,
    reason: e.reason,
    created_at: e.created_at,
    x1: true,
  };
}

/** Debounce before a server-side search round-trip fires. */
const SEARCH_DEBOUNCE_MS = 300;

const PAGE_SIZE = 25;
/**
 * Server fetch size. 200 is the backend's hard `per_page` cap
 * (apps/api/internal/subscribers/repo.go normalizePage). When the
 * tenant has more rows than this, the UI labels itself "first N
 * loaded" and surfaces the server `total` instead of pretending the
 * loaded sample is the whole list.
 */
const FETCH_SIZE = 200;
const COLS = "1.6fr 140px 1.2fr 80px";
/** Same grid plus the leading multi-select checkbox column (admins). */
const COLS_SELECT = `28px ${COLS}`;

// SUB-047 / SUB-048: extended from 4 to 8 reason categories to surface
// the Klaviyo-compatible taxonomy. "Soft bounce" / "Spam trap" get their
// own chips; the address-quality signals (role account, DNS failure,
// invalid address, list-unsubscribe header) fold into "Delivery issues".
const FILTER_CHIPS: Array<{
  value: Filter;
  label: string;
  description: string;
}> = [
  { value: "all", label: "All", description: "Every suppression reason" },
  {
    value: "hard_bounce",
    label: "Bounces",
    description: "Permanent hard bounces",
  },
  {
    value: "soft_bounce",
    label: "Soft bounces",
    description: "Transient delivery failures and soft-bounce thresholds",
  },
  {
    value: "complaint",
    label: "Complaints",
    description: "Spam and feedback-loop complaints",
  },
  {
    value: "spamtrap",
    label: "Spam traps",
    description: "Known spam-trap and honeypot recipients",
  },
  {
    value: "delivery_issue",
    label: "Delivery issues",
    description:
      "Role accounts, DNS failures, invalid addresses, list-unsubscribe headers, and auto-blocklist hits",
  },
  {
    value: "manual",
    label: "Manual",
    description: "Addresses blocked manually by an operator",
  },
  {
    value: "unsubscribe",
    label: "Unsubscribed",
    description: "Global, manual, and list-unsubscribe requests",
  },
];

function reasonBadge(reason: string | undefined): ReactElement {
  const r = (reason ?? "").toLowerCase();
  // Legacy free-form values AND the canonical X1 enum (server-side
  // search returns converged rows). SUB-047 / SUB-048 extended this with
  // the Klaviyo-compatible taxonomy; each reason gets a semantic tone:
  //   danger  → permanent / abuse signals (hard bounce, complaint,
  //             spam trap, DNS failure, invalid address, auto-blocklist)
  //   warning → transient / address-quality signals (soft bounce,
  //             unsubscribes, role account)
  //   info    → RFC 8058 one-click list-unsubscribe header
  //   neutral → manual operator blocks
  switch (r) {
    case "hard_bounce":
      return <span className="badge danger">Bounce</span>;
    case "complaint":
    case "spam_complaint":
      return <span className="badge warning">Complaint</span>;
    case "spam_trap":
    case "spamtrap":
      return <span className="badge danger">Spam trap</span>;
    case "blocklist_auto":
      return <span className="badge danger">Auto blocklist</span>;
    case "dns_failure":
      return <span className="badge danger">DNS failure</span>;
    case "invalid_address":
    case "invalid_email":
      return <span className="badge danger">Invalid address</span>;
    case "soft_bounce":
    case "soft_bounce_threshold":
      return <span className="badge warning">Soft bounce</span>;
    case "role_account":
    case "role_address":
      return <span className="badge warning">Role account</span>;
    case "list_unsub_header":
      return <span className="badge info">List-unsub header</span>;
    case "unsubscribe":
    case "manual_unsubscribe":
    case "global_unsubscribe":
      return <span className="badge warning">Unsub</span>;
    case "manual":
    case "list_manual":
      return <span className="badge">Manual</span>;
    default:
      return <span className="badge">{reason || "—"}</span>;
  }
}

/** Defensive payload unwrap — same chain as the rest of the app. */
function pickRows(payload: unknown): SuppressionRow[] {
  if (Array.isArray(payload)) return payload as SuppressionRow[];
  if (payload && typeof payload === "object") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = payload as any;
    const list = r.items ?? r.results ?? r.data ?? [];
    return Array.isArray(list) ? (list as SuppressionRow[]) : [];
  }
  return [];
}

function describeSuppressionFailure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function serverReason(filter: Filter): string | undefined {
  return filter !== "all" && FILTER_REASON_ALIASES[filter].includes(filter)
    ? filter
    : undefined;
}

export function filterSuppressionRows({
  rows,
  searchRows,
  usingServerSearch,
  filter,
  query,
  dateFrom,
  dateTo,
}: {
  rows: Row[];
  searchRows: Row[];
  usingServerSearch: boolean;
  filter: Filter;
  query: string;
  dateFrom: string;
  dateTo: string;
}): Row[] {
  let output = usingServerSearch ? searchRows : rows;
  if (filter !== "all") {
    output = output.filter((row) => reasonMatchesFilter(row.reason, filter));
  }
  if (query.trim() && !usingServerSearch) {
    const normalized = query.trim().toLowerCase();
    output = output.filter((row) =>
      row.email.toLowerCase().includes(normalized),
    );
  }
  if (dateFrom || dateTo) {
    output = output.filter((row) => {
      const date = (row.created_at ?? "").slice(0, 10);
      return Boolean(
        date && (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo),
      );
    });
  }
  return output;
}

export function buildSuppressionTotalLabel({
  rows,
  filtered,
  serverTotal,
  usingServerSearch,
  searchRows,
  searchTotal,
  searchTruncated,
  clientFilterActive,
  partial,
}: {
  rows: Row[] | null;
  filtered: Row[];
  serverTotal: number | null;
  usingServerSearch: boolean;
  searchRows: Row[] | null;
  searchTotal: number | null;
  searchTruncated: boolean;
  clientFilterActive: boolean;
  partial: boolean;
}): string {
  if (!rows) return "Loading…";
  if (usingServerSearch) {
    const truncation =
      searchTruncated && searchRows && searchTotal != null
        ? ` · first ${searchRows.length.toLocaleString()} of ${searchTotal.toLocaleString()} loaded`
        : "";
    return `${filtered.length.toLocaleString()} ${filtered.length === 1 ? "match" : "matches"}${truncation}`;
  }
  if (clientFilterActive) {
    const scope = partial
      ? ` · searching first ${rows.length.toLocaleString()} loaded`
      : "";
    return `${filtered.length.toLocaleString()} ${filtered.length === 1 ? "match" : "matches"}${scope}`;
  }
  const total = serverTotal ?? filtered.length;
  const scope = partial
    ? ` · first ${rows.length.toLocaleString()} loaded`
    : "";
  return `${total.toLocaleString()} ${total === 1 ? "address" : "addresses"}${scope}`;
}

function useSuppressionDirectory() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [listUnavailable, setListUnavailable] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [searchRows, setSearchRows] = useState<Row[] | null>(null);
  const [searchTotal, setSearchTotal] = useState<number | null>(null);
  const [searchPending, setSearchPending] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searchUnsupported, setSearchUnsupported] = useState(false);
  const [searchRefresh, setSearchRefresh] = useState(0);
  const listSeqRef = useRef(0);
  const searchSeqRef = useRef(0);
  const loadBusyRef = useRef(false);
  const loadOwnerRef = useRef(0);

  const load = useCallback(
    async (scope: Filter, force = false): Promise<void> => {
      if (!force && loadBusyRef.current) return;
      const owner = ++loadOwnerRef.current;
      loadBusyRef.current = true;
      const seq = ++listSeqRef.current;
      setLoading(true);
      setErr(null);
      try {
        const result = await suppressionsApi.list({
          reason: serverReason(scope),
          perPage: FETCH_SIZE,
        });
        if (seq !== listSeqRef.current) return;
        if (result.error) {
          const status = result.error.status ?? 0;
          if (status === 404 || status === 405) {
            setListUnavailable(true);
            setRows((previous) => previous ?? []);
          } else {
            setErr(result.error.message);
          }
          // A failed refresh does not invalidate the last verified coverage
          // boundary. Retaining rows while clearing their authoritative total
          // would silently reframe a sampled first page as the whole store.
          // Filter changes explicitly clear both rows and total before their
          // fresh request, so preserving the value here is only the stale-data
          // path (initial failures still begin at null).
          return;
        }
        setListUnavailable(false);
        setRows(pickRows(result.data));
        const total =
          result.data && typeof result.data === "object"
            ? (result.data as { total?: unknown }).total
            : undefined;
        setServerTotal(typeof total === "number" ? total : null);
      } catch (error) {
        if (seq === listSeqRef.current) {
          setErr(
            describeSuppressionFailure(
              error,
              "The suppression list could not load.",
            ),
          );
        }
      } finally {
        if (seq === listSeqRef.current) setLoading(false);
        if (owner === loadOwnerRef.current) loadBusyRef.current = false;
      }
    },
    [],
  );

  useEffect(() => {
    setRows(null);
    setServerTotal(null);
    setErr(null);
    void load(filter, true);
  }, [filter, load]);

  useEffect(() => {
    setPage(1);
  }, [query, dateFrom, dateTo]);

  useEffect(() => {
    const classification = classifySearchQuery(query);
    if (
      searchUnsupported ||
      (classification.mode !== "exact" && classification.mode !== "prefix")
    ) {
      searchSeqRef.current += 1;
      setSearchRows(null);
      setSearchTotal(null);
      setSearchPending(false);
      setSearchErr(null);
      return;
    }
    const seq = ++searchSeqRef.current;
    setSearchPending(true);
    setSearchErr(null);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await suppressionsConvergedApi.list(
            classification.mode === "exact"
              ? { email: classification.value, size: FETCH_SIZE }
              : { q: classification.value, size: FETCH_SIZE },
          );
          if (seq !== searchSeqRef.current) return;
          if (result.error) {
            const status = result.error.status ?? 0;
            if (
              result.error.kind === "http" &&
              [400, 404, 405, 501].includes(status)
            ) {
              setSearchUnsupported(true);
            } else {
              setSearchErr(result.error.message);
            }
            setSearchRows(null);
            setSearchTotal(null);
          } else {
            setSearchRows((result.data.items ?? []).map(entryToRow));
            setSearchTotal(
              typeof result.data.total === "number" ? result.data.total : null,
            );
          }
        } catch (error) {
          if (seq === searchSeqRef.current) {
            setSearchRows(null);
            setSearchTotal(null);
            setSearchErr(
              describeSuppressionFailure(
                error,
                "Server search could not complete.",
              ),
            );
          }
        } finally {
          if (seq === searchSeqRef.current) setSearchPending(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, searchRefresh, searchUnsupported]);

  const searchMode = classifySearchQuery(query).mode;
  const usingServerSearch =
    searchRows !== null &&
    !searchPending &&
    (searchMode === "exact" || searchMode === "prefix");
  const filtered = useMemo(
    () =>
      filterSuppressionRows({
        rows: rows ?? [],
        searchRows: searchRows ?? [],
        usingServerSearch,
        filter,
        query,
        dateFrom,
        dateTo,
      }),
    [dateFrom, dateTo, filter, query, rows, searchRows, usingServerSearch],
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  );
  const partial =
    serverTotal != null && rows != null && serverTotal > rows.length;
  const clientFilterActive = Boolean(query.trim() || dateFrom || dateTo);
  const searchTruncated =
    usingServerSearch &&
    searchTotal != null &&
    searchRows != null &&
    searchTotal > searchRows.length;
  const totalLabel = buildSuppressionTotalLabel({
    rows,
    filtered,
    serverTotal,
    usingServerSearch,
    searchRows,
    searchTotal,
    searchTruncated,
    clientFilterActive,
    partial,
  });

  return {
    rows,
    setRows,
    serverTotal,
    loading,
    err,
    listUnavailable,
    query,
    setQuery,
    filter,
    setFilter,
    dateFrom,
    setDateFrom,
    dateTo,
    setDateTo,
    page: safePage,
    setPage,
    searchRows,
    setSearchRows,
    searchTotal,
    setSearchTotal,
    searchPending,
    searchErr,
    searchUnsupported,
    setSearchRefresh,
    searchMode,
    usingServerSearch,
    filtered,
    totalPages,
    pageRows,
    partial,
    clientFilterActive,
    searchTruncated,
    totalLabel,
    load,
    reload: (force = false) => load(filter, force),
  };
}

type SuppressionDirectory = ReturnType<typeof useSuppressionDirectory>;

function useSuppressionSelection(directory: SuppressionDirectory) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  useEffect(() => {
    setSelectedIds(new Set());
  }, [
    directory.dateFrom,
    directory.dateTo,
    directory.filter,
    directory.query,
    directory.usingServerSearch,
  ]);
  const selectedRows = useMemo(
    () =>
      directory.filtered.filter(
        (row) =>
          row.x1 === true && row.id != null && selectedIds.has(String(row.id)),
      ),
    [directory.filtered, selectedIds],
  );
  const pageIds = directory.pageRows
    .filter((row) => row.x1 === true)
    .map((row) => String(row.id ?? ""))
    .filter(Boolean);
  const allPageSelected =
    pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageIds.some((id) => selectedIds.has(id));
  const toggleRowSelected = (id: string): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const togglePageSelected = (): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const id of pageIds) {
        if (allPageSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };
  return {
    selectedIds,
    setSelectedIds,
    selectedRows,
    pageIds,
    allPageSelected,
    somePageSelected,
    toggleRowSelected,
    togglePageSelected,
  };
}

type SuppressionSelection = ReturnType<typeof useSuppressionSelection>;

function useSuppressionDetails(
  directory: SuppressionDirectory,
  selection: SuppressionSelection,
) {
  const [detailRow, setDetailRow] = useState<Row | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const acceptTarget = useCallback(
    (target: { section: string; id: string } | null): void => {
      if (!target || target.section !== "suppressions" || !target.id) return;
      setPendingId(target.id);
      setDetailRow(null);
      directory.setQuery(target.id.includes("@") ? target.id : "");
      directory.setFilter("all");
      directory.setDateFrom("");
      directory.setDateTo("");
      directory.setPage(1);
      selection.setSelectedIds(new Set());
    },
    [
      directory.setDateFrom,
      directory.setDateTo,
      directory.setFilter,
      directory.setPage,
      directory.setQuery,
      selection.setSelectedIds,
    ],
  );
  useEffect(() => {
    acceptTarget(consumePendingDeepLinkTarget());
    return onPendingDeepLinkTarget((target) => {
      if (target.section !== "suppressions") return;
      consumePendingDeepLinkTarget();
      acceptTarget(target);
    });
  }, [acceptTarget]);
  useEffect(() => {
    if (!pendingId) return;
    const normalized = pendingId.toLowerCase();
    const match = directory.filtered.find(
      (row) =>
        String(row.id ?? "") === pendingId ||
        row.email.toLowerCase() === normalized,
    );
    if (match) {
      setDetailRow(match);
      setPendingId(null);
      return;
    }
    const waitForSearch =
      pendingId.includes("@") &&
      !directory.searchUnsupported &&
      (directory.searchMode === "exact" || directory.searchMode === "prefix") &&
      directory.searchRows === null;
    if (directory.loading || directory.searchPending || waitForSearch) return;
    setPendingId(null);
    toast.error("Couldn't find that suppression — it may have been removed.");
  }, [
    directory.filtered,
    directory.loading,
    directory.searchMode,
    directory.searchPending,
    directory.searchRows,
    directory.searchUnsupported,
    pendingId,
  ]);
  return { detailRow, setDetailRow };
}

type SuppressionDetails = ReturnType<typeof useSuppressionDetails>;

export function parseBulkSuppressionEmails(value: string): string[] {
  const unique = new Set(
    value
      .split(/[\n,]/)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry)),
  );
  return Array.from(unique);
}

function useSuppressionMutations({
  canDelete,
  canMutate,
  directory,
  selection,
  details,
}: {
  canDelete: boolean;
  canMutate: boolean;
  directory: SuppressionDirectory;
  selection: SuppressionSelection;
  details: SuppressionDetails;
}) {
  const [mirrorOpen, setMirrorOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addReason, setAddReason] = useState("manual");
  const [adding, setAdding] = useState(false);
  const addBusyRef = useRef(false);
  const errors = useFormErrors();
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkReason, setBulkReason] = useState("manual");
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkSummary, setBulkSummary] = useState<string | null>(null);
  const bulkBusyRef = useRef(false);
  const [importOpen, setImportOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteBusyRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const exportBusyRef = useRef(false);

  const prependLocal = (row: Row): void => {
    directory.setRows((previous) => {
      const rows = previous ?? [];
      return rows.some((candidate) => candidate.email === row.email)
        ? rows
        : [row, ...rows];
    });
  };
  const refreshAfterExternalMutation = (): void => {
    if (!directory.listUnavailable) void directory.reload(true);
    directory.setSearchRefresh((value) => value + 1);
  };
  const openAdd = (): void => {
    setAddEmail("");
    setAddReason("manual");
    errors.clear();
    setAddOpen(true);
  };
  const submitAdd = async (): Promise<void> => {
    if (!canMutate || addBusyRef.current) return;
    const email = addEmail.trim().toLowerCase();
    errors.clear();
    if (!email) {
      errors.set("email", "Email is required.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.set("email", "Enter a valid email address.");
      return;
    }
    addBusyRef.current = true;
    setAdding(true);
    try {
      const result = await suppressionsApi.add({ email, reason: addReason });
      if (result.error) {
        errors.set("_form", result.error.message);
        return;
      }
      setAddOpen(false);
      toast.success(`${email} suppressed`);
      if (result.data) prependLocal(result.data);
      if (!directory.listUnavailable) await directory.reload(true);
    } catch (error) {
      errors.set(
        "_form",
        describeSuppressionFailure(
          error,
          "The suppression could not be added.",
        ),
      );
    } finally {
      addBusyRef.current = false;
      setAdding(false);
    }
  };
  const openBulk = (): void => {
    setBulkText("");
    setBulkReason("manual");
    setBulkErr(null);
    setBulkSummary(null);
    setBulkOpen(true);
  };
  const submitBulk = async (): Promise<void> => {
    if (!canMutate || bulkBusyRef.current) return;
    const emails = parseBulkSuppressionEmails(bulkText);
    if (emails.length === 0) {
      setBulkErr("Paste at least one valid email address (one per line).");
      return;
    }
    if (emails.length > 50_000) {
      setBulkErr("Maximum 50,000 unique addresses per import.");
      return;
    }
    const entries = emails.map((email) => ({ email, reason: bulkReason }));
    bulkBusyRef.current = true;
    setBulkSubmitting(true);
    setBulkErr(null);
    try {
      const result = await suppressionsApi.bulkAdd(entries);
      if (result.error) {
        setBulkErr(result.error.message);
        return;
      }
      const added = result.data?.imported ?? result.data?.added ?? 0;
      const skipped = result.data?.skipped ?? 0;
      const errorCount = result.data?.errors?.length ?? 0;
      setBulkSummary(
        `Imported ${added.toLocaleString()} · skipped ${skipped.toLocaleString()}${
          errorCount
            ? ` · ${errorCount.toLocaleString()} error${errorCount === 1 ? "" : "s"}`
            : ""
        }`,
      );
      toast.success({
        message: `${added.toLocaleString()} suppressed`,
        detail: `${skipped.toLocaleString()} skipped${
          errorCount ? `, ${errorCount.toLocaleString()} errors` : ""
        }.`,
      });
      if (directory.listUnavailable) {
        const createdAt = new Date().toISOString();
        for (const entry of entries) {
          prependLocal({
            id: `local-${entry.email}`,
            email: entry.email,
            reason: entry.reason,
            created_at: createdAt,
          });
        }
      } else {
        await directory.reload(true);
      }
    } catch (error) {
      setBulkErr(
        describeSuppressionFailure(
          error,
          "The bulk import could not complete.",
        ),
      );
    } finally {
      bulkBusyRef.current = false;
      setBulkSubmitting(false);
    }
  };
  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget || !canDelete || deleteBusyRef.current) return;
    const target = deleteTarget;
    deleteBusyRef.current = true;
    setDeleting(true);
    try {
      const result = target.x1
        ? await suppressionsConvergedApi.remove(target.email)
        : await suppressionsApi.remove(target.id);
      if (result.error) {
        toast.error({
          message: "Couldn't remove suppression",
          detail: result.error.message,
        });
        return;
      }
      toast.success({
        message: `${target.email} suppression record removed`,
        detail:
          "Subscriber status and consent were not restored. Other suppression evidence or provider state may still block delivery.",
      });
      directory.setRows(
        (previous) =>
          previous?.filter((row) => row.email !== target.email) ?? previous,
      );
      directory.setSearchRows(
        (previous) =>
          previous?.filter((row) => row.email !== target.email) ?? previous,
      );
      directory.setSearchTotal((total) =>
        target.x1 && total != null ? Math.max(0, total - 1) : total,
      );
      selection.setSelectedIds((previous) => {
        const next = new Set(previous);
        if (target.id != null) next.delete(String(target.id));
        return next;
      });
      setDeleteTarget(null);
    } catch (error) {
      toast.error({
        message: "Couldn't remove suppression",
        detail: describeSuppressionFailure(
          error,
          "The request did not complete.",
        ),
      });
    } finally {
      deleteBusyRef.current = false;
      setDeleting(false);
    }
  };
  const exportSuppressions = async (): Promise<void> => {
    if (exportBusyRef.current) return;
    exportBusyRef.current = true;
    setExporting(true);
    const canonical =
      directory.filter !== "all" &&
      FILTER_REASON_ALIASES[directory.filter].includes(directory.filter);
    const query = canonical
      ? `?reason=${encodeURIComponent(directory.filter)}`
      : "";
    try {
      const url = await buildStreamUrl(`/api/v1/suppressions/export${query}`);
      const saved = await downloadUrlToFile({
        url,
        suggestedName: `suppressions-${
          canonical ? directory.filter : "all"
        }-${new Date().toISOString().slice(0, 10)}.csv`,
        label: "Suppression list export",
        privacy: "confidential",
        mimeType: "text/csv;charset=utf-8",
      });
      if (!saved.ok) throw new Error(saved.message);
      if (saved.status !== "cancelled")
        toast.success("Suppression export saved.");
    } catch (error) {
      toast.error(
        `Couldn't open export: ${describeSuppressionFailure(error, "unknown error")}`,
      );
    } finally {
      exportBusyRef.current = false;
      setExporting(false);
    }
  };

  return {
    mirrorOpen,
    setMirrorOpen,
    addOpen,
    setAddOpen,
    addEmail,
    setAddEmail,
    addReason,
    setAddReason,
    adding,
    errors,
    bulkOpen,
    setBulkOpen,
    bulkText,
    setBulkText,
    bulkReason,
    setBulkReason,
    bulkErr,
    bulkSubmitting,
    bulkSummary,
    importOpen,
    setImportOpen,
    bulkImportOpen,
    setBulkImportOpen,
    deleteTarget,
    setDeleteTarget,
    deleting,
    exporting,
    openAdd,
    submitAdd,
    openBulk,
    submitBulk,
    confirmDelete,
    exportSuppressions,
    refreshAfterExternalMutation,
    beginDelete: (row: Row) => {
      if (canDelete) setDeleteTarget(row);
    },
    removeFromDetails: () => {
      if (!details.detailRow || !canDelete) return;
      setDeleteTarget(details.detailRow);
      details.setDetailRow(null);
    },
  };
}

type SuppressionMutations = ReturnType<typeof useSuppressionMutations>;

export function Suppressions(): ReactElement {
  const canDelete = useCanAdmin();
  const canMutate = useCanWrite();
  const directory = useSuppressionDirectory();
  const selection = useSuppressionSelection(directory);
  const details = useSuppressionDetails(directory, selection);
  const mutations = useSuppressionMutations({
    canDelete,
    canMutate,
    directory,
    selection,
    details,
  });
  return (
    <SuppressionsView
      canDelete={canDelete}
      canMutate={canMutate}
      directory={directory}
      selection={selection}
      details={details}
      mutations={mutations}
    />
  );
}

interface SuppressionsViewProps {
  canDelete: boolean;
  canMutate: boolean;
  directory: SuppressionDirectory;
  selection: SuppressionSelection;
  details: SuppressionDetails;
  mutations: SuppressionMutations;
}

function SuppressionsView(props: SuppressionsViewProps): ReactElement {
  return (
    <>
      <SuppressionsHeaderAndFilters {...props} />
      <SuppressionsTable {...props} />
      <SuppressionsDialogs {...props} />
    </>
  );
}

function SuppressionsHeaderAndFilters({
  canDelete,
  canMutate,
  directory,
  selection,
  mutations,
}: SuppressionsViewProps): ReactElement {
  const activeFilter =
    FILTER_CHIPS.find((chip) => chip.value === directory.filter) ??
    FILTER_CHIPS[0]!;
  const exportScope =
    directory.filter === "all"
      ? "all suppression reasons"
      : `${activeFilter.label.toLowerCase()} suppressions`;
  const metricScope = [
    directory.filter !== "all" ? activeFilter.label : "",
    directory.query.trim() ? `Search “${directory.query.trim()}”` : "",
    directory.dateFrom || directory.dateTo ? "Selected date range" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const metricTotal = directory.usingServerSearch
    ? directory.filter === "all" && !directory.dateFrom && !directory.dateTo
      ? directory.searchTotal
      : null
    : !directory.query.trim() && !directory.dateFrom && !directory.dateTo
      ? directory.filter === "all" || serverReason(directory.filter)
        ? directory.serverTotal
        : null
      : null;
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Suppressions</h1>
          <div className="page-subtitle" aria-live="polite">
            {directory.totalLabel}
            {directory.loading && directory.rows ? " · refreshing" : ""}
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className={`btn${canDelete ? "" : " pw-discoverable-unavailable"}`}
            onClick={() => {
              if (canDelete) mutations.setMirrorOpen(true);
            }}
            aria-disabled={!canDelete || undefined}
            aria-describedby="suppressions-sync-description"
          >
            Sync from ESP
          </button>
          <button
            type="button"
            className={`btn${canMutate ? "" : " pw-discoverable-unavailable"}`}
            onClick={() => {
              if (canMutate) mutations.setImportOpen(true);
            }}
            aria-disabled={!canMutate || undefined}
            aria-describedby="suppressions-csv-description"
          >
            Import CSV
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void mutations.exportSuppressions()}
            disabled={mutations.exporting}
            aria-describedby="suppressions-export-description"
          >
            {mutations.exporting ? "Exporting…" : "Export"}
          </button>
          <button
            type="button"
            className={`btn btn-ghost${canMutate ? "" : " pw-discoverable-unavailable"}`}
            onClick={() => {
              if (canMutate) mutations.openBulk();
            }}
            aria-disabled={!canMutate || undefined}
            aria-describedby="suppressions-paste-description"
          >
            Paste list
          </button>
          <button
            type="button"
            className={`btn${canMutate ? "" : " pw-discoverable-unavailable"}`}
            onClick={() => {
              if (canMutate) mutations.setBulkImportOpen(true);
            }}
            aria-disabled={!canMutate || undefined}
            aria-describedby="suppressions-bulk-description"
          >
            Bulk import
          </button>
          <button
            type="button"
            className={`btn btn-primary${canMutate ? "" : " pw-discoverable-unavailable"}`}
            onClick={() => {
              if (canMutate) mutations.openAdd();
            }}
            aria-disabled={!canMutate || undefined}
            aria-describedby="suppressions-add-description"
          >
            Add suppression
          </button>
          <div
            className="muted small"
            style={{ flexBasis: "100%", maxWidth: 900, lineHeight: 1.45 }}
          >
            <span id="suppressions-sync-description">
              {canDelete
                ? "Sync re-imports bounces, complaints, and unsubscribes from a sending provider."
                : "Sync unavailable: an admin role is required."}
            </span>{" "}
            <span id="suppressions-csv-description">
              {canMutate
                ? "Import CSV accepts an email column and optional reason column."
                : "CSV import unavailable: write permission is required."}
            </span>{" "}
            <span id="suppressions-export-description">
              {mutations.exporting
                ? "Preparing one suppression export now."
                : `Export downloads ${exportScope} as CSV.`}
            </span>{" "}
            <span id="suppressions-paste-description">
              {canMutate
                ? "Paste list accepts one address per line."
                : "Paste import unavailable: write permission is required."}
            </span>{" "}
            <span id="suppressions-bulk-description">
              {canMutate
                ? "Bulk import accepts pasted emails, CSV rows, or a JSON array."
                : "Bulk import unavailable: write permission is required."}
            </span>{" "}
            <span id="suppressions-add-description">
              {canMutate
                ? "Add suppression blocks one address from outbound email."
                : "Adding suppressions is unavailable with read-only access."}
            </span>
          </div>
        </div>
      </div>

      {directory.rows && directory.rows.length > 0 ? (
        <SuppressionsStatStrip
          rows={directory.filtered}
          total={metricTotal}
          reasonScope={metricScope || undefined}
        />
      ) : null}
      <SuppressionsTrendChart />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <input
          type="search"
          className="input"
          style={{ width: 280, maxWidth: "100%" }}
          aria-label="Search suppressed email addresses"
          placeholder="Search email…"
          value={directory.query}
          onChange={(event) => directory.setQuery(event.target.value)}
        />
        <div className="chips" aria-label="Suppression reason" role="group">
          {FILTER_CHIPS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              className={`chip${directory.filter === chip.value ? " is-active" : ""}`}
              aria-pressed={directory.filter === chip.value}
              aria-describedby={
                directory.filter === chip.value
                  ? "suppression-active-filter-description"
                  : `suppression-filter-${chip.value}-description`
              }
              onClick={() => directory.setFilter(chip.value)}
            >
              {chip.label}
            </button>
          ))}
          {FILTER_CHIPS.map((chip) => (
            <span
              key={`${chip.value}-description`}
              id={`suppression-filter-${chip.value}-description`}
              className="sr-only"
            >
              {chip.description}.
            </span>
          ))}
        </div>
        <span
          id="suppression-active-filter-description"
          className="muted small"
          role="status"
        >
          {activeFilter.description}.
        </span>
        <DateRangePopover
          from={directory.dateFrom}
          to={directory.dateTo}
          onChange={({ from, to }) => {
            directory.setDateFrom(from);
            directory.setDateTo(to);
          }}
        />
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          onClick={() => void directory.reload()}
          disabled={directory.loading}
          aria-describedby="suppressions-refresh-description"
        >
          {directory.loading ? "Refreshing…" : "Refresh"}
        </button>
        <span
          id="suppressions-refresh-description"
          className="muted small"
          role="status"
        >
          {directory.loading
            ? "Refreshing the current reason scope; existing rows stay visible."
            : "Reload the current reason scope and refresh active server search. The date range remains a local view."}
        </span>
      </div>

      <SuppressionSearchDisclosure directory={directory} />
      {directory.err ? (
        <div className="notice" role="alert">
          <span>
            {directory.rows ? "Refresh failed" : "Couldn't load suppressions"}:{" "}
            {directory.err}
            {directory.rows ? " The last loaded rows remain visible." : ""}
          </span>
        </div>
      ) : null}
      {directory.listUnavailable ? (
        <div className="notice" role="status">
          <span>
            This server does not expose the suppression list route yet. Adds and
            bulk imports still work, but this view only shows entries created in
            this session.
          </span>
        </div>
      ) : null}
      {canDelete ? (
        <BulkActionsMenu
          selected={selection.selectedRows}
          onClear={() => selection.setSelectedIds(new Set())}
          onAfterMutate={() => {
            mutations.refreshAfterExternalMutation();
          }}
        />
      ) : null}
    </>
  );
}

function SuppressionSearchDisclosure({
  directory,
}: {
  directory: SuppressionDirectory;
}): ReactElement | null {
  if (directory.searchErr) {
    return (
      <div className="notice" role="status" style={{ marginBottom: 12 }}>
        Server search failed: {directory.searchErr}. Showing client-side matches
        over the first {(directory.rows ?? []).length.toLocaleString()} loaded
        rows instead.
      </div>
    );
  }
  if (directory.usingServerSearch) {
    return (
      <div className="notice" role="status" style={{ marginBottom: 12 }}>
        {directory.searchMode === "exact"
          ? "Exact-match search across the whole suppression store."
          : "Prefix search across the whole suppression store; mid-address matches are excluded."}
        {directory.searchTruncated && directory.searchRows
          ? ` Showing the first ${directory.searchRows.length.toLocaleString()} of ${directory.searchTotal?.toLocaleString()} matches.`
          : ""}
      </div>
    );
  }
  if (directory.searchPending && directory.partial && directory.rows) {
    return (
      <div className="notice" role="status" style={{ marginBottom: 12 }}>
        Searching the server… meanwhile showing instant matches from the first{" "}
        {directory.rows.length.toLocaleString()} loaded rows.
      </div>
    );
  }
  if (!directory.clientFilterActive || !directory.partial || !directory.rows) {
    return null;
  }
  return (
    <div className="notice" role="status" style={{ marginBottom: 12 }}>
      Searching the first {directory.rows.length.toLocaleString()} loaded rows
      of {directory.serverTotal?.toLocaleString()}. Matches beyond this sample
      will not appear
      {directory.query.trim().length > 0 &&
      directory.query.trim().length < SERVER_SEARCH_MIN_PREFIX &&
      !directory.searchUnsupported
        ? ` until you type at least ${SERVER_SEARCH_MIN_PREFIX} characters`
        : ""}
      .
    </div>
  );
}

function SuppressionsTable({
  canDelete,
  canMutate,
  directory,
  selection,
  details,
  mutations,
}: SuppressionsViewProps): ReactElement {
  const showInitialLoading = directory.loading && directory.rows === null;
  const hasRows = directory.pageRows.length > 0;
  // The ordinary library is backed by email_suppressions while bulk actions
  // mutate canonical subscriber_suppressions rows. Until the route has one
  // decision identity, only canonical server-search results are selectable.
  const showSelection = canDelete && directory.usingServerSearch;
  return (
    <>
      <div
        className="list"
        role={hasRows ? "table" : "region"}
        aria-label="Suppressed email addresses"
        aria-busy={directory.loading}
      >
        {hasRows ? (
          <div
            className="list-header"
            role="row"
            style={{ gridTemplateColumns: showSelection ? COLS_SELECT : COLS }}
          >
            {showSelection ? (
              <div role="columnheader">
                <input
                  type="checkbox"
                  aria-label={
                    selection.allPageSelected
                      ? "Deselect all rows on this page"
                      : selection.pageIds.length === 0
                        ? "No selectable rows on this page"
                        : "Select all rows on this page"
                  }
                  checked={selection.allPageSelected}
                  ref={(element) => {
                    if (element) {
                      element.indeterminate =
                        selection.somePageSelected &&
                        !selection.allPageSelected;
                    }
                  }}
                  onChange={selection.togglePageSelected}
                  disabled={selection.pageIds.length === 0}
                />
              </div>
            ) : null}
            <div role="columnheader">Email</div>
            <div role="columnheader">Reason</div>
            <div role="columnheader">Added</div>
            <div role="columnheader" aria-label="Actions" />
          </div>
        ) : null}
        {showInitialLoading ? (
          <div style={{ padding: 12 }} role="status">
            <span className="sr-only">Loading suppressions</span>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div key={index} className="skel-row" aria-hidden="true" />
            ))}
          </div>
        ) : directory.pageRows.length === 0 ? (
          <SuppressionEmptyState
            canMutate={canMutate}
            directory={directory}
            onAdd={mutations.openAdd}
            onImport={() => mutations.setImportOpen(true)}
          />
        ) : (
          directory.pageRows.map((row, index) => (
            <div
              key={String(row.id ?? row.email ?? index)}
              className="list-row"
              role="row"
              style={{
                gridTemplateColumns: showSelection ? COLS_SELECT : COLS,
              }}
            >
              {showSelection ? (
                <div role="cell">
                  <input
                    type="checkbox"
                    aria-label={
                      row.x1 !== true || row.id == null
                        ? `${row.email} is not a canonical search result and cannot be selected for bulk actions`
                        : `Select ${row.email}`
                    }
                    checked={
                      row.x1 === true &&
                      row.id != null &&
                      selection.selectedIds.has(String(row.id))
                    }
                    disabled={row.x1 !== true || row.id == null}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                    onChange={() => {
                      if (row.x1 === true && row.id != null) {
                        selection.toggleRowSelected(String(row.id));
                      }
                    }}
                  />
                </div>
              ) : null}
              <div
                role="cell"
                title={row.email}
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {row.email}
              </div>
              <div role="cell">{reasonBadge(row.reason)}</div>
              <div role="cell" className="muted tabular">
                {fmtDate(row.created_at)}
              </div>
              <div role="cell" style={{ textAlign: "right" }}>
                <div className="list-row-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost list-row-action"
                    onClick={() => details.setDetailRow(row)}
                    aria-label={`View details for ${row.email}`}
                  >
                    Open
                  </button>
                  {canDelete ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost list-row-action"
                      onClick={() => mutations.beginDelete(row)}
                      aria-label={`Un-suppress ${row.email}`}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <nav className="pagination" aria-label="Suppression pages">
        <button
          type="button"
          className="btn btn-sm"
          disabled={directory.page <= 1}
          onClick={() => directory.setPage((page) => Math.max(1, page - 1))}
          aria-describedby="suppression-pagination-status"
        >
          Prev
        </button>
        <span id="suppression-pagination-status" aria-live="polite">
          Page {directory.page} of {directory.totalPages}
          {directory.usingServerSearch && directory.searchTruncated
            ? ` · first ${directory.searchRows?.length.toLocaleString()} of ${directory.searchTotal?.toLocaleString()} matches loaded`
            : directory.partial && directory.rows
              ? ` · first ${directory.rows.length.toLocaleString()} of ${directory.serverTotal?.toLocaleString()} loaded`
              : ""}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={directory.page >= directory.totalPages}
          onClick={() =>
            directory.setPage((page) =>
              Math.min(directory.totalPages, page + 1),
            )
          }
          aria-describedby="suppression-pagination-status"
        >
          Next
        </button>
      </nav>
    </>
  );
}

function SuppressionEmptyState({
  canMutate,
  directory,
  onAdd,
  onImport,
}: {
  canMutate: boolean;
  directory: SuppressionDirectory;
  onAdd: () => void;
  onImport: () => void;
}): ReactElement {
  if (directory.clientFilterActive || directory.filter !== "all") {
    let detail = "Try a different reason filter.";
    if (directory.query) {
      detail = directory.usingServerSearch
        ? directory.searchMode === "exact"
          ? "No suppression with that exact address; the whole store was checked."
          : "No addresses start with that prefix; the whole store was checked."
        : directory.partial
          ? `Only the first ${(directory.rows ?? []).length.toLocaleString()} loaded rows were searched.`
          : "Clear search to see all suppressions.";
    } else if (directory.dateFrom || directory.dateTo) {
      detail = "Try a wider date range.";
    }
    return (
      <div className="list-empty" role="status">
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            ·
          </div>
          <h3>
            {directory.query
              ? `No matches for "${directory.query}"`
              : "No matching suppressions"}
          </h3>
          <p>{detail}</p>
        </div>
      </div>
    );
  }
  return (
    <HeroEmptyState
      tone="mint"
      eyebrow="Hygiene"
      title="Never send to who shouldn't be sent to."
      subtitle="Hard bounces, complaints, and manual blocks are applied across every send."
      primaryCta={
        canMutate ? { label: "Add suppression", onClick: onAdd } : undefined
      }
      secondaryCta={
        canMutate ? { label: "Import list", onClick: onImport } : undefined
      }
      imageSrc={HERO.suppressions}
      imageAlt="An envelope marked with a teal X ribbon"
    />
  );
}

function SuppressionsDialogs({
  canDelete,
  directory,
  details,
  mutations,
}: SuppressionsViewProps): ReactElement {
  return (
    <>
      <AddSuppressionDialog mutations={mutations} />
      <PasteSuppressionsDialog mutations={mutations} />
      <ImportSuppressionsModal
        open={mutations.importOpen}
        onClose={() => mutations.setImportOpen(false)}
        onImported={mutations.refreshAfterExternalMutation}
      />
      <BulkImportSuppressionsModal
        open={mutations.bulkImportOpen}
        onClose={() => mutations.setBulkImportOpen(false)}
        onImported={mutations.refreshAfterExternalMutation}
      />
      <MirrorFromEspModal
        open={mutations.mirrorOpen}
        onClose={() => mutations.setMirrorOpen(false)}
        onAfterMirror={mutations.refreshAfterExternalMutation}
      />
      {details.detailRow ? (
        <SuppressionDetailSlideover
          row={details.detailRow}
          onRemove={canDelete ? mutations.removeFromDetails : undefined}
          onClose={() => details.setDetailRow(null)}
        />
      ) : null}
      <ConfirmModal
        open={mutations.deleteTarget !== null}
        title="Un-suppress address?"
        description={
          mutations.deleteTarget
            ? `${mutations.deleteTarget.email} is removed from this suppression list. Subscriber-level or provider suppressions may still block mail, and a prior bounce or complaint can recur.`
            : ""
        }
        confirmLabel="Un-suppress"
        danger
        busy={mutations.deleting}
        onClose={() =>
          mutations.deleting ? undefined : mutations.setDeleteTarget(null)
        }
        onConfirm={() => void mutations.confirmDelete()}
      />
      {directory.loading && directory.rows ? (
        <span className="sr-only" role="status">
          Refreshing suppressions while keeping the last loaded rows visible.
        </span>
      ) : null}
    </>
  );
}

function AddSuppressionDialog({
  mutations,
}: {
  mutations: SuppressionMutations;
}): ReactElement {
  return (
    <Modal
      open={mutations.addOpen}
      onClose={() =>
        mutations.adding ? undefined : mutations.setAddOpen(false)
      }
      title="Add suppression"
      description="Block outbound email to one address."
      closeOnBackdrop={!mutations.adding}
      closeOnEscape={!mutations.adding}
      closeDisabled={mutations.adding}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutations.submitAdd();
        }}
      >
        <FormField
          label="Email"
          required
          htmlFor="supp-email"
          error={mutations.errors.get("email")}
        >
          <input
            id="supp-email"
            type="email"
            className="input"
            placeholder="user@example.com"
            autoComplete="email"
            value={mutations.addEmail}
            onChange={(event) => mutations.setAddEmail(event.target.value)}
            disabled={mutations.adding}
          />
        </FormField>
        <FormField
          label="Reason"
          htmlFor="supp-reason"
          helpTooltip="Bounce and complaint reasons are normally recorded automatically. Use Manual for an operator block."
        >
          <select
            id="supp-reason"
            className="input"
            value={mutations.addReason}
            onChange={(event) => mutations.setAddReason(event.target.value)}
            disabled={mutations.adding}
          >
            {SUPPRESSION_REASONS.map((reason) => (
              <option key={reason.value} value={reason.value}>
                {reason.label}
              </option>
            ))}
          </select>
        </FormField>
        {mutations.errors.get("_form") ? (
          <FieldError>{mutations.errors.get("_form")}</FieldError>
        ) : null}
        <div
          id="suppression-add-action-status"
          className="field-help"
          role="status"
        >
          {mutations.adding
            ? "Adding the suppression. Keep this dialog open until it finishes."
            : "Suppress blocks this address from outbound email; subscriber-level and provider blocks may also apply."}
        </div>
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={() => mutations.setAddOpen(false)}
            disabled={mutations.adding}
            aria-describedby="suppression-add-action-status"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={mutations.adding}
            aria-describedby="suppression-add-action-status"
          >
            {mutations.adding ? "Adding…" : "Suppress"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function BulkSuppressionPreview({
  emails,
  reason,
}: {
  emails: string[];
  reason: string;
}): ReactElement | null {
  if (emails.length === 0) return null;
  const reasonLabel =
    SUPPRESSION_REASONS.find((candidate) => candidate.value === reason)
      ?.label ?? reason;
  return (
    <div
      className={emails.length >= 1_000 ? "wizard-risk" : "muted"}
      style={{ marginTop: 8, fontSize: 12 }}
      role="status"
    >
      You&apos;re about to suppress{" "}
      <strong>{emails.length.toLocaleString()}</strong> unique address
      {emails.length === 1 ? "" : "es"} as <strong>{reasonLabel}</strong>.
    </div>
  );
}

function PasteSuppressionsDialog({
  mutations,
}: {
  mutations: SuppressionMutations;
}): ReactElement {
  const emails = parseBulkSuppressionEmails(mutations.bulkText);
  const completed = mutations.bulkSummary !== null;
  const actionStatus = mutations.bulkSubmitting
    ? "Import in progress. Keep this dialog open until the batch finishes."
    : completed
      ? "This import is complete. Close the dialog to start another batch."
      : emails.length === 0
        ? "Enter at least one valid email address before importing."
        : `Ready to import ${emails.length.toLocaleString()} unique address${emails.length === 1 ? "" : "es"}.`;
  return (
    <Modal
      open={mutations.bulkOpen}
      onClose={() =>
        mutations.bulkSubmitting ? undefined : mutations.setBulkOpen(false)
      }
      title="Bulk import suppressions"
      description="Paste one email per line. Duplicate or invalid entries are ignored."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutations.submitBulk();
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="supp-bulk-reason">
            Reason
            <InlineHelp text="Applied to every address in this batch. Mix reasons by importing separate batches." />
          </label>
          <select
            id="supp-bulk-reason"
            className="input"
            value={mutations.bulkReason}
            onChange={(event) => mutations.setBulkReason(event.target.value)}
            disabled={mutations.bulkSubmitting || completed}
          >
            {SUPPRESSION_REASONS.map((reason) => (
              <option key={reason.value} value={reason.value}>
                {reason.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="supp-bulk-text">
            Email addresses
            <InlineHelp text="One email per line or comma-separated. Use Import CSV for header-bearing files." />
          </label>
          <textarea
            id="supp-bulk-text"
            className="input"
            rows={10}
            style={{
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 12,
              resize: "vertical",
              minHeight: 160,
              padding: 8,
            }}
            placeholder={"user1@example.com\nuser2@example.com"}
            value={mutations.bulkText}
            onChange={(event) => mutations.setBulkText(event.target.value)}
            disabled={mutations.bulkSubmitting || completed}
          />
          <div className="field-help">
            Up to 50,000 unique valid addresses per import.
          </div>
        </div>
        <BulkSuppressionPreview emails={emails} reason={mutations.bulkReason} />
        {mutations.bulkErr ? (
          <div className="field-error" role="alert">
            {mutations.bulkErr}
          </div>
        ) : null}
        {mutations.bulkSummary ? (
          <div className="notice" role="status" style={{ marginTop: 8 }}>
            <span>{mutations.bulkSummary}</span>
          </div>
        ) : null}
        <div
          id="suppression-paste-action-status"
          className="field-help"
          aria-live={mutations.bulkSubmitting || completed ? "polite" : "off"}
        >
          {actionStatus}
        </div>
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={() => mutations.setBulkOpen(false)}
            disabled={mutations.bulkSubmitting}
            aria-describedby="suppression-paste-action-status"
          >
            {completed ? "Close" : "Cancel"}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              mutations.bulkSubmitting || completed || emails.length === 0
            }
            aria-describedby="suppression-paste-action-status"
          >
            {mutations.bulkSubmitting ? "Importing…" : "Import"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
