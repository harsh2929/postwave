/**
 * HelpdeskInbox — the conversation inbox surface for the Helpdesk
 * (Klaviyo-parity KLV-10). A two-pane layout:
 *
 *   · Left  — status-filter chips (catalog statuses + "All") over a
 *             conversation list. Each row shows the requester, subject,
 *             a channel-type chip, status + priority badges, and the
 *             (guarded) last-message timestamp.
 *   · Right — the selected thread: a conversation header, the message
 *             history rendered inbound-left / outbound-right, and an
 *             action bar (reply composer, assign, status, macros).
 *
 * HONEST framing: inbound email is NOT auto-bridged into conversations
 * yet — only SMS / web-chat / manually-created conversations populate.
 * A small note in the list makes that explicit so the inbox never
 * implies a unified email inbox that isn't wired.
 *
 * Bodies render as TEXT (body_text, or body_html stripped to readable
 * text) — NEVER dangerouslySetInnerHTML. See helpdesk-helpers.ts.
 *
 * Writes (reply / assign / status / use-macro) need ADMIN scope; the UI
 * gates on useCanAdmin and a 403 surfaces a clear toast.
 */

import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type ServiceConversation,
  type ServiceMacro,
  type ServiceMessage,
  type ServiceSuiteCatalog,
  type ServiceTicket,
  getApiUrl,
  serviceSuiteApi,
} from "../../lib/api-client";
import { fmtDateTime } from "../../lib/format-date";
import { apiIdentityGenerationIsCurrent } from "../../lib/api-identity-transition";
import { tryAcquireInternalNoteOperationLease } from "../../lib/helpdesk-internal-note-operation";
import { readNoteRecoveryPrincipal, useCanAdmin } from "../../lib/store";
import { ChoiceGroup } from "../ChoiceGroup";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { decodeMacroList } from "./agent-helpers";
import {
  canonicalNoteRecoveryApiBaseUrl,
  type InternalNoteRecoveryAuthority,
  internalNoteOutcomeIsUnknown,
  internalNoteRecovery,
  sessionNoteRecoveryAuthority,
} from "./internal-note-recovery";
import {
  ALL_STATUS,
  INTERNAL_NOTE_MAX_BYTES,
  type RecordedDueDateDescriptor,
  assignmentReasonValidationError,
  conversationMatchesQuery,
  decodeConversation,
  decodeConversationList,
  decodeMessage,
  decodeMessageList,
  decodeTicketList,
  describeTicketDueDate,
  isVerifiedInternalNote,
  internalNoteValidationError,
  utf8ByteLength,
  messageText,
  requesterLabel,
  statusBadgeClass,
  statusChips,
  titleizeStatus,
} from "./helpdesk-helpers";

/** Turn an ApiErr into a human toast, calling out the admin-scope 403. */
function writeErrorToast(
  action: string,
  err: { message: string; status?: number },
): void {
  if (err.status === 403) {
    toast.error(
      `${action} needs admin access — your account doesn't have permission.`,
    );
    return;
  }
  toast.error(`${action} failed: ${err.message}`);
}

function mutationOutcomeNeedsReview(error: {
  kind?: string;
  status?: number;
}): boolean {
  return (
    error.kind === "network" ||
    error.kind === "timeout" ||
    error.status === 409 ||
    error.status === 412 ||
    error.status === 428 ||
    (typeof error.status === "number" && error.status >= 500)
  );
}

interface VerifiedHelpdeskPageWindow {
  asOf: string;
  consistency: string;
}

function pageWindow(
  page: { asOf: string; consistency: string } | null,
): VerifiedHelpdeskPageWindow | null {
  return page ? { asOf: page.asOf, consistency: page.consistency } : null;
}

function samePageWindow(
  first: VerifiedHelpdeskPageWindow | null,
  next: VerifiedHelpdeskPageWindow | null,
): boolean {
  return Boolean(
    first &&
    next &&
    first.asOf === next.asOf &&
    first.consistency === next.consistency,
  );
}

const HELPDESK_PAGE_SIZE = 100;
const HELPDESK_MAX_JOIN_PAGES = 20;
const HELPDESK_MAX_JOIN_ROWS = HELPDESK_PAGE_SIZE * HELPDESK_MAX_JOIN_PAGES;

interface VerifiedTicketWindow {
  items: ServiceTicket[];
  rejected: number;
  complete: boolean;
  problem: string | null;
}

async function readVerifiedTicketWindow({
  tenantId,
  conversationId,
  signal,
}: {
  tenantId: string;
  conversationId?: string;
  signal: AbortSignal;
}): Promise<VerifiedTicketWindow> {
  const items: ServiceTicket[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let rejected = 0;
  let cursor: string | undefined;
  let window: VerifiedHelpdeskPageWindow | null = null;

  for (
    let pageNumber = 0;
    pageNumber < HELPDESK_MAX_JOIN_PAGES;
    pageNumber += 1
  ) {
    const result = await serviceSuiteApi.listTickets({
      ...(conversationId ? { conversationId } : {}),
      ...(cursor ? { cursor } : {}),
      limit: HELPDESK_PAGE_SIZE,
      signal,
    });
    if (signal.aborted) {
      return {
        items,
        rejected,
        complete: false,
        problem: "Ticket verification was canceled.",
      };
    }
    if (result.error) {
      return {
        items,
        rejected,
        complete: false,
        problem:
          result.error.message ||
          "A ticket page could not be verified; timing coverage is partial.",
      };
    }
    const decoded = decodeTicketList(result.data as unknown, tenantId);
    if (decoded.envelopeError || !decoded.page) {
      return {
        items,
        rejected,
        complete: false,
        problem:
          decoded.envelopeError ||
          "A ticket page omitted its verified pagination window.",
      };
    }
    const nextWindow = pageWindow(decoded.page);
    if (window === null) window = nextWindow;
    else if (!samePageWindow(window, nextWindow)) {
      return {
        items,
        rejected,
        complete: false,
        problem:
          "A ticket cursor page changed its verified window; existing timing rows were retained as partial.",
      };
    }
    rejected += decoded.rejected;
    for (const ticket of decoded.items) {
      const id = ticket.id ?? "";
      if (!id || ids.has(id)) {
        return {
          items,
          rejected,
          complete: false,
          problem:
            "A ticket cursor page repeated a record; the complete timing window was withheld.",
        };
      }
      ids.add(id);
      items.push(ticket);
    }
    if (items.length > HELPDESK_MAX_JOIN_ROWS) {
      return {
        items: items.slice(0, HELPDESK_MAX_JOIN_ROWS),
        rejected,
        complete: false,
        problem:
          "Ticket timing exceeded the bounded verification row limit; coverage is partial.",
      };
    }
    const nextCursor = decoded.page.nextCursor;
    if (!nextCursor) {
      return {
        items,
        rejected,
        complete: rejected === 0,
        problem:
          rejected > 0
            ? `${rejected} ticket row(s) failed strict validation; timing coverage is partial.`
            : null,
      };
    }
    if (cursors.has(nextCursor)) {
      return {
        items,
        rejected,
        complete: false,
        problem:
          "Ticket pagination repeated an opaque cursor; timing coverage is partial.",
      };
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  return {
    items,
    rejected,
    complete: false,
    problem:
      "Ticket timing exceeded the bounded verification page limit; coverage is partial.",
  };
}

export function HelpdeskInbox({
  catalog,
  tenantId,
  identityScope,
  noteRecoveryAuthority,
  accessAllowed,
  online = true,
  catalogVerified,
  selectedConversationId,
  statusFilter,
  onSelectedConversationChange,
  onStatusFilterChange,
}: {
  catalog: ServiceSuiteCatalog | null;
  tenantId: string | null;
  identityScope: string | null;
  noteRecoveryAuthority: InternalNoteRecoveryAuthority | null;
  accessAllowed: boolean;
  online?: boolean;
  catalogVerified: boolean;
  selectedConversationId: string | null;
  statusFilter: string | null;
  onSelectedConversationChange: (id: string | null) => void;
  onStatusFilterChange: (status: string | null) => void;
}): ReactElement {
  const canAdmin = useCanAdmin();
  const statuses = useMemo(
    () =>
      Array.isArray(catalog?.conversation_statuses)
        ? catalog.conversation_statuses
        : [],
    [catalog],
  );
  const chips = statusChips(statuses);
  const allowedStatus = statusFilter
    ? statuses.includes(statusFilter)
      ? statusFilter
      : ALL_STATUS
    : ALL_STATUS;
  useEffect(() => {
    if (catalogVerified && statusFilter && !statuses.includes(statusFilter)) {
      onStatusFilterChange(null);
    }
  }, [catalogVerified, onStatusFilterChange, statusFilter, statuses]);

  const [conversations, setConversations] = useState<
    ServiceConversation[] | null
  >(null);
  const [tickets, setTickets] = useState<ServiceTicket[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [ticketErr, setTicketErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextConversationCursor, setNextConversationCursor] = useState<
    string | null
  >(null);
  const [stale, setStale] = useState(false);
  const [rejectedRows, setRejectedRows] = useState(0);
  const [query, setQuery] = useState("");
  const queueA11yPrefix = useId();
  const listGenerationRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const moreAbortRef = useRef<AbortController | null>(null);
  const conversationWindowRef = useRef<VerifiedHelpdeskPageWindow | null>(null);
  const identityScopeRef = useRef<string | null>(identityScope);
  const hasQueueDataRef = useRef(false);
  const queueFilterRef = useRef(statusFilter);
  const queueRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousSelectedIdRef = useRef<string | null>(selectedConversationId);

  useEffect(() => {
    const previous = identityScopeRef.current;
    identityScopeRef.current = identityScope;
    if (previous !== identityScope || !accessAllowed) {
      listGenerationRef.current += 1;
      listAbortRef.current?.abort();
      moreAbortRef.current?.abort();
      hasQueueDataRef.current = false;
      setConversations(null);
      setTickets(null);
      setListErr(null);
      setTicketErr(null);
      setNextConversationCursor(null);
      conversationWindowRef.current = null;
      setStale(false);
      setRefreshing(false);
      setLoadingMore(false);
      setQuery("");
      setRejectedRows(0);
      if (selectedConversationId) onSelectedConversationChange(null);
    }
  }, [
    accessAllowed,
    identityScope,
    onSelectedConversationChange,
    selectedConversationId,
  ]);

  useEffect(() => {
    if (queueFilterRef.current === statusFilter) return;
    queueFilterRef.current = statusFilter;
    listGenerationRef.current += 1;
    listAbortRef.current?.abort();
    moreAbortRef.current?.abort();
    hasQueueDataRef.current = false;
    setConversations(null);
    setTickets(null);
    setListErr(null);
    setTicketErr(null);
    setNextConversationCursor(null);
    conversationWindowRef.current = null;
    setRejectedRows(0);
    setQuery("");
    setStale(false);
  }, [statusFilter]);

  const loadConversations = useCallback(async (): Promise<void> => {
    if (
      !accessAllowed ||
      !online ||
      !tenantId ||
      !identityScope ||
      (statusFilter !== null &&
        (!catalogVerified || !statuses.includes(statusFilter)))
    ) {
      return;
    }
    const generation = ++listGenerationRef.current;
    listAbortRef.current?.abort();
    moreAbortRef.current?.abort();
    setLoadingMore(false);
    setNextConversationCursor(null);
    conversationWindowRef.current = null;
    const controller = new AbortController();
    listAbortRef.current = controller;
    setRefreshing(true);
    setListErr(null);
    setTicketErr(null);
    setRejectedRows(0);
    const [conversationResult, ticketWindow] = await Promise.all([
      serviceSuiteApi.listConversations(
        allowedStatus === ALL_STATUS
          ? { signal: controller.signal }
          : { status: allowedStatus, signal: controller.signal },
      ),
      readVerifiedTicketWindow({
        tenantId,
        signal: controller.signal,
      }),
    ]);
    if (controller.signal.aborted) return;
    if (generation !== listGenerationRef.current) return;

    let failed = false;
    if (conversationResult.error) {
      failed = true;
      setListErr(
        conversationResult.error.message || "Conversation read failed.",
      );
    } else {
      const decoded = decodeConversationList(
        conversationResult.data as unknown,
        tenantId,
      );
      if (decoded.envelopeError) {
        failed = true;
        setListErr(decoded.envelopeError);
      } else {
        setConversations(decoded.items);
        hasQueueDataRef.current = true;
        conversationWindowRef.current = pageWindow(decoded.page);
        setNextConversationCursor(decoded.page?.nextCursor ?? null);
        setRejectedRows((previous) => previous + decoded.rejected);
      }
    }
    if (!ticketWindow.complete) {
      failed = true;
      setTicketErr(
        ticketWindow.problem ||
          "Ticket due-date coverage could not be completely verified.",
      );
    }
    setTickets((current) =>
      ticketWindow.complete
        ? ticketWindow.items
        : (current ?? ticketWindow.items),
    );
    setRejectedRows((previous) => previous + ticketWindow.rejected);
    setStale(failed);
    setRefreshing(false);
  }, [
    accessAllowed,
    allowedStatus,
    catalogVerified,
    online,
    statusFilter,
    statuses,
    tenantId,
    identityScope,
  ]);

  const loadMoreConversations = useCallback(async (): Promise<void> => {
    if (
      !accessAllowed ||
      !online ||
      !tenantId ||
      !identityScope ||
      (statusFilter !== null &&
        (!catalogVerified || !statuses.includes(statusFilter))) ||
      !nextConversationCursor ||
      loadingMore
    ) {
      return;
    }
    setLoadingMore(true);
    const generation = listGenerationRef.current;
    moreAbortRef.current?.abort();
    const controller = new AbortController();
    moreAbortRef.current = controller;
    const res = await serviceSuiteApi.listConversations({
      ...(allowedStatus === ALL_STATUS ? {} : { status: allowedStatus }),
      cursor: nextConversationCursor,
      signal: controller.signal,
    });
    if (controller.signal.aborted || generation !== listGenerationRef.current)
      return;
    if (res.error) {
      setListErr(res.error.message || "The next queue page could not load.");
      setStale(true);
      setLoadingMore(false);
      return;
    }
    const decoded = decodeConversationList(res.data as unknown, tenantId);
    if (decoded.envelopeError) {
      setListErr(decoded.envelopeError);
      setStale(true);
      setLoadingMore(false);
      return;
    }
    const nextWindow = pageWindow(decoded.page);
    if (!samePageWindow(conversationWindowRef.current, nextWindow)) {
      setListErr(
        "The next queue page did not share the first verified cursor window. Existing rows were retained; refresh the queue before continuing.",
      );
      setNextConversationCursor(null);
      setStale(true);
      setLoadingMore(false);
      return;
    }
    const existingIds = new Set(
      (conversations ?? []).map((conversation) => conversation.id),
    );
    if (
      decoded.items.some((conversation) => existingIds.has(conversation.id))
    ) {
      setListErr(
        "The next queue page overlapped an already loaded conversation. The mutable queue is partial; refresh before continuing.",
      );
      setNextConversationCursor(null);
      setStale(true);
      setLoadingMore(false);
      return;
    }
    setConversations((current) => {
      return [...(current ?? []), ...decoded.items];
    });
    setRejectedRows((previous) => previous + decoded.rejected);
    setNextConversationCursor(decoded.page?.nextCursor ?? null);
    setLoadingMore(false);
  }, [
    accessAllowed,
    allowedStatus,
    catalogVerified,
    conversations,
    loadingMore,
    nextConversationCursor,
    online,
    statusFilter,
    statuses,
    tenantId,
    identityScope,
  ]);

  useEffect(() => {
    if (
      !accessAllowed ||
      !tenantId ||
      !identityScope ||
      (statusFilter !== null &&
        (!catalogVerified || !statuses.includes(statusFilter)))
    ) {
      listGenerationRef.current += 1;
      listAbortRef.current?.abort();
      moreAbortRef.current?.abort();
      setConversations(null);
      setTickets(null);
      hasQueueDataRef.current = false;
      setListErr(null);
      setTicketErr(null);
      setNextConversationCursor(null);
      conversationWindowRef.current = null;
      setStale(false);
      setRefreshing(false);
      return;
    }
    if (!online) {
      listGenerationRef.current += 1;
      listAbortRef.current?.abort();
      moreAbortRef.current?.abort();
      setRefreshing(false);
      setLoadingMore(false);
      setStale(hasQueueDataRef.current);
      if (!hasQueueDataRef.current) {
        setListErr("Helpdesk is offline; reconnect to verify conversations.");
      }
      return;
    }
    void loadConversations();
    return () => {
      listGenerationRef.current += 1;
      listAbortRef.current?.abort();
      moreAbortRef.current?.abort();
    };
  }, [
    accessAllowed,
    catalogVerified,
    loadConversations,
    online,
    statusFilter,
    statuses,
    tenantId,
    identityScope,
  ]);

  const ticketByConversation = useMemo(() => {
    const map = new Map<string, ServiceTicket>();
    if (ticketErr) return map;
    for (const ticket of tickets ?? []) {
      const id = (ticket.conversation_id ?? "").trim();
      if (id && !map.has(id)) map.set(id, ticket);
    }
    return map;
  }, [ticketErr, tickets]);
  const visibleConversations = useMemo(
    () =>
      (conversations ?? []).filter((conversation) =>
        conversationMatchesQuery(conversation, query),
      ),
    [conversations, query],
  );
  const selectedId = selectedConversationId;

  useEffect(() => {
    const previous = previousSelectedIdRef.current;
    previousSelectedIdRef.current = selectedId;
    if (!selectedId && previous) {
      window.requestAnimationFrame(() =>
        queueRowRefs.current.get(previous)?.focus(),
      );
    }
  }, [selectedId]);

  if (!accessAllowed || !tenantId || !canAdmin) {
    return (
      <div
        className="card helpdesk-locked-panel"
        data-helpdesk-state="access-denied"
      >
        <div className="helpdesk-state-icon" aria-hidden="true">
          ⌁
        </div>
        <h2>Inbox records are admin-only</h2>
        <p>
          No conversations, tickets, messages, macros, or requester identities
          were requested. Switch to an exact admin context to triage this
          workspace.
        </p>
      </div>
    );
  }

  return (
    <div
      className={`helpdesk-inbox-layout${selectedId ? " has-selection" : ""}`}
    >
      {/* ---- Left rail: filters + conversation list ------------------ */}
      <aside className="card helpdesk-queue" aria-label="Conversation queue">
        <div className="helpdesk-queue-toolbar">
          <div>
            <h2>Queue</h2>
            <span className="muted" role="status" aria-live="polite">
              {conversations === null
                ? online
                  ? "Loading records…"
                  : "Verification paused offline"
                : `${visibleConversations.length} of ${conversations.length} loaded conversations`}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void loadConversations()}
            disabled={!online || refreshing}
            aria-disabled={!online || refreshing}
            aria-label="Refresh conversation and ticket records"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <div className="helpdesk-search-field">
          <label className="sr-only" htmlFor="helpdesk-queue-search">
            Search loaded conversations
          </label>
          <input
            id="helpdesk-queue-search"
            className="input"
            type="search"
            value={query}
            maxLength={128}
            onChange={(event) => setQuery(event.target.value.slice(0, 128))}
            placeholder="Search this loaded queue"
            autoComplete="off"
          />
          <span className="muted">
            Local to this view; search text is not placed in route history.
          </span>
        </div>
        <ChoiceGroup
          legend="Conversation status filter"
          value={allowedStatus}
          onChange={(next) =>
            onStatusFilterChange(next === ALL_STATUS ? null : next)
          }
          className="tabs helpdesk-status-filters"
          optionClassName="tab"
          options={chips.map((chip) => ({
            value: chip.value,
            label: chip.label,
            className: allowedStatus === chip.value ? "is-active" : undefined,
          }))}
        />

        <div className="helpdesk-scope-note">
          <strong>Foundation records only.</strong> No authenticated email or
          storefront runtime is connected here. Channel labels describe stored
          source records, not a live channel connection. Ticket linkage is a
          bounded provisional window; an absent row never proves “no ticket” or
          “no recorded due date.” A due_at value is recorded timing evidence,
          not a governed service-level policy.
        </div>

        {stale || rejectedRows > 0 || ticketErr ? (
          <div className="helpdesk-partial-notice" role="status">
            {stale
              ? online
                ? "Current verification is partial. Previously verified records, if any, are retained and marked stale."
                : "Helpdesk is offline. Previously verified records are retained and marked stale."
              : rejectedRows > 0
                ? "Some untrusted rows were omitted."
                : "Ticket due-date coverage is partial."}
            {rejectedRows > 0
              ? ` ${rejectedRows} invalid row(s) rejected.`
              : ""}
            {ticketErr
              ? ` ${ticketErr} Absent ticket records and due dates remain unverified.`
              : ""}
            {listErr && conversations !== null
              ? ` Queue continuation held: ${listErr}`
              : ""}
          </div>
        ) : null}

        <div className="helpdesk-queue-scroll">
          {listErr && conversations === null ? (
            <div className="helpdesk-state-block" role="alert">
              <div>Couldn&apos;t verify conversations: {listErr}</div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!online}
                onClick={() => {
                  if (online) void loadConversations();
                }}
              >
                Retry
              </button>
            </div>
          ) : statusFilter !== null && !catalogVerified ? (
            <div className="helpdesk-state-block" role="status">
              Waiting to verify the route-backed status filter from the catalog.
              No protected queue request has started.
            </div>
          ) : conversations === null ? (
            <div className="helpdesk-state-block" role="status">
              <div className="skel-row" />
              <div className="skel-row" />
              <span>Loading tenant-scoped conversations…</span>
            </div>
          ) : visibleConversations.length === 0 ? (
            <div
              className="helpdesk-state-block"
              data-remote-state="verified-empty"
            >
              <strong>No matching conversations</strong>
              <span>
                {query.trim()
                  ? "Clear or change the local search."
                  : allowedStatus !== ALL_STATUS
                    ? `No verified records have status “${titleizeStatus(allowedStatus)}”.`
                    : "This workspace has no verified conversation records."}
              </span>
              {query.trim() ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setQuery("")}
                >
                  Clear search
                </button>
              ) : null}
            </div>
          ) : (
            <ul className="helpdesk-queue-list">
              {visibleConversations.map((c, index) => {
                const id = c.id ?? "";
                const isSel = id !== "" && id === selectedId;
                const a11yBase = `${queueA11yPrefix}-row-${index}`;
                const dueDate = describeTicketDueDate(
                  ticketByConversation.get(id),
                );
                return (
                  <li key={id}>
                    <button
                      type="button"
                      ref={(node) => {
                        if (node) queueRowRefs.current.set(id, node);
                        else queueRowRefs.current.delete(id);
                      }}
                      onClick={() => onSelectedConversationChange(id)}
                      className={`helpdesk-queue-row${isSel ? " is-selected" : ""}`}
                      aria-pressed={isSel}
                      aria-labelledby={`${a11yBase}-open ${a11yBase}-requester ${a11yBase}-requester-end`}
                      aria-describedby={`${a11yBase}-subject-start ${a11yBase}-subject ${a11yBase}-subject-end ${a11yBase}-recorded`}
                    >
                      <span id={`${a11yBase}-open`} className="sr-only">
                        Open conversation record {index + 1}. Begin
                        requester-provided identity.
                      </span>
                      <div className="helpdesk-queue-row-head">
                        <span
                          id={`${a11yBase}-requester`}
                          className="helpdesk-requester"
                        >
                          {requesterLabel(c)}
                        </span>
                        <span
                          id={`${a11yBase}-requester-end`}
                          className="sr-only"
                        >
                          End requester-provided identity.
                        </span>
                        <span className="muted tabular helpdesk-row-time">
                          {fmtDateTime(c.last_message_at)}
                        </span>
                      </div>
                      <span
                        id={`${a11yBase}-subject-start`}
                        className="sr-only"
                      >
                        Begin requester-provided subject.
                      </span>
                      <div
                        id={`${a11yBase}-subject`}
                        className="muted helpdesk-row-subject"
                      >
                        {(c.subject ?? "").trim() || "(no subject)"}
                      </div>
                      <span id={`${a11yBase}-subject-end`} className="sr-only">
                        End requester-provided subject.
                      </span>
                      <div className="helpdesk-row-badges">
                        <span className="badge">
                          {titleizeStatus(c.channel_type ?? "—")}
                        </span>
                        <span className={statusBadgeClass(c.status)}>
                          {titleizeStatus(c.status ?? "—")}
                        </span>
                        {(c.priority ?? "").trim() ? (
                          <span className="badge">
                            {titleizeStatus(c.priority)}
                          </span>
                        ) : null}
                        <span
                          className={`helpdesk-due-date is-${dueDate.kind}`}
                          title={dueDate.detail}
                        >
                          {dueDate.label}
                        </span>
                      </div>
                      <span id={`${a11yBase}-recorded`} className="sr-only">
                        Server-recorded fields. Channel{" "}
                        {titleizeStatus(c.channel_type ?? "—")}. Status{" "}
                        {titleizeStatus(c.status ?? "—")}. Priority{" "}
                        {titleizeStatus(c.priority ?? "—")}. Ticket timing{" "}
                        {dueDate.label}.
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {nextConversationCursor && !query.trim() ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost helpdesk-load-more"
              disabled={!online || loadingMore}
              aria-disabled={!online || loadingMore}
              onClick={() => {
                if (online) void loadMoreConversations();
              }}
            >
              {loadingMore
                ? "Loading older queue records…"
                : "Load older queue records"}
            </button>
          ) : null}
        </div>
      </aside>

      {/* ---- Right pane: the selected thread ------------------------- */}
      <main className="helpdesk-thread-column">
        {selectedId ? (
          <ConversationThread
            key={selectedId}
            conversationId={selectedId}
            tenantId={tenantId}
            identityScope={identityScope}
            noteRecoveryAuthority={noteRecoveryAuthority}
            statuses={statuses}
            canAdmin={canAdmin}
            online={online}
            onBack={() => onSelectedConversationChange(null)}
            onMutated={() => void loadConversations()}
          />
        ) : (
          <div className="card helpdesk-empty-detail">
            <div className="helpdesk-state-icon" aria-hidden="true">
              ↗
            </div>
            <h2>Pick a conversation</h2>
            <p>
              Inspect the verified message window, assignment, status, and any
              ticket&apos;s recorded due date. A recorded due date is not a
              governed service-level promise. This foundation can save internal
              notes; it cannot send a customer reply.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

/* ----------------------------------------------------------------------
 * Thread view — owns the conversation header, messages, and the
 * reply / assign / status / macro action bar.
 * -------------------------------------------------------------------- */

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The named message overflow viewport is intentionally keyboard-focusable so keyboard-only operators can scroll verified records. */
function ConversationThread({
  conversationId,
  tenantId,
  identityScope,
  noteRecoveryAuthority,
  statuses,
  canAdmin,
  online,
  onBack,
  onMutated,
}: {
  conversationId: string;
  tenantId: string;
  identityScope: string | null;
  noteRecoveryAuthority: InternalNoteRecoveryAuthority | null;
  statuses: string[];
  canAdmin: boolean;
  online: boolean;
  onBack: () => void;
  onMutated: () => void;
}): ReactElement {
  const [conversation, setConversation] = useState<ServiceConversation | null>(
    null,
  );
  const [messages, setMessages] = useState<ServiceMessage[] | null>(null);
  const [threadTickets, setThreadTickets] = useState<ServiceTicket[] | null>(
    null,
  );
  const [ticketWindowHasMore, setTicketWindowHasMore] = useState(false);
  const [ticketPartial, setTicketPartial] = useState<string | null>(null);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<string | null>(null);
  const [latestRefreshing, setLatestRefreshing] = useState(false);
  const [latestStale, setLatestStale] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [partial, setPartial] = useState<string | null>(null);
  const [rejectedRows, setRejectedRows] = useState(0);
  const [olderMessageCursor, setOlderMessageCursor] = useState<string | null>(
    null,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Monotonic generation token guarding the thread load. Switching
  // conversations fast can leave a slow in-flight response racing a
  // newer one; we bump `gen` on every (re)load and drop any response
  // whose token is stale, so a slow fetch can never paint the wrong
  // thread. Switching threads also remounts via `key`, but the guard
  // additionally protects the in-place refetch after a reply/assign.
  const genRef = useRef(0);
  const threadAbortRef = useRef<AbortController | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const latestRefreshPromiseRef = useRef<Promise<boolean> | null>(null);
  const messageWindowRef = useRef<VerifiedHelpdeskPageWindow | null>(null);
  const threadHeadingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!online || !identityScope) return;
    const gen = ++genRef.current;
    threadAbortRef.current?.abort();
    const controller = new AbortController();
    threadAbortRef.current = controller;
    messageWindowRef.current = null;
    setOlderMessageCursor(null);
    setErr(null);
    setPartial(null);
    setTicketPartial(null);
    const [convRes, msgRes, ticketWindow] = await Promise.all([
      serviceSuiteApi.getConversation(conversationId, {
        signal: controller.signal,
      }),
      serviceSuiteApi.listMessages(conversationId, {
        order: "desc",
        signal: controller.signal,
      }),
      readVerifiedTicketWindow({
        tenantId,
        conversationId,
        signal: controller.signal,
      }),
    ]);
    // Stale — a newer load superseded this one. Drop it on the floor.
    if (controller.signal.aborted || gen !== genRef.current) return;
    if (convRes.error) {
      setConversation(null);
      setMessages(null);
      setErr(convRes.error.message);
      return;
    }
    const decodedConversation = decodeConversation(
      convRes.data as unknown,
      tenantId,
    );
    if (!decodedConversation || decodedConversation.id !== conversationId) {
      setConversation(null);
      setMessages(null);
      setErr(
        "The server returned a conversation outside this workspace or route identity.",
      );
      return;
    }
    setConversation(decodedConversation);
    let messagesVerified = false;
    if (msgRes.error) {
      setMessages(null);
      setPartial(
        msgRes.error.message || "The message window could not be verified.",
      );
    } else {
      const decodedMessages = decodeMessageList(
        msgRes.data as unknown,
        tenantId,
        conversationId,
      );
      if (decodedMessages.envelopeError) {
        setMessages(null);
        setPartial(decodedMessages.envelopeError);
      } else {
        messagesVerified = true;
        setRejectedRows(decodedMessages.rejected);
        messageWindowRef.current = pageWindow(decodedMessages.page);
        setOlderMessageCursor(decodedMessages.page?.nextCursor ?? null);
        setPartial(null);
        setMessages(sortMessagesChronologically(decodedMessages.items));
      }
    }
    const linkedTickets = ticketWindow.items.filter(
      (ticket) => ticket.conversation_id === conversationId,
    );
    const crossBoundTicketRows =
      ticketWindow.items.length - linkedTickets.length;
    setThreadTickets(linkedTickets);
    setTicketWindowHasMore(!ticketWindow.complete || crossBoundTicketRows > 0);
    setTicketPartial(
      crossBoundTicketRows > 0
        ? "The conversation-bound ticket response included another conversation; timing coverage is partial."
        : ticketWindow.problem,
    );
    if (messagesVerified) {
      setLastVerifiedAt(new Date(Date.now()).toISOString());
      setLatestStale(false);
    }
  }, [conversationId, identityScope, online, tenantId]);

  useEffect(() => {
    if (!online) {
      genRef.current += 1;
      threadAbortRef.current?.abort();
      refreshAbortRef.current?.abort();
      setLoadingOlder(false);
      setLatestRefreshing(false);
      setLatestStale(true);
      setPartial(
        "Helpdesk is offline. Any last verified thread window is retained as stale; refresh and writes are paused.",
      );
      return;
    }
    setConversation(null);
    setMessages(null);
    messageWindowRef.current = null;
    setThreadTickets(null);
    setTicketWindowHasMore(false);
    setTicketPartial(null);
    setLastVerifiedAt(null);
    setLatestStale(false);
    void load();
    return () => {
      genRef.current += 1;
      threadAbortRef.current?.abort();
      refreshAbortRef.current?.abort();
    };
  }, [load, online]);

  const refreshLatest = useCallback((): Promise<boolean> => {
    if (!online || !identityScope || loadingOlder)
      return Promise.resolve(false);
    if (latestRefreshPromiseRef.current) {
      return latestRefreshPromiseRef.current;
    }
    const operation = (async (): Promise<boolean> => {
      const gen = genRef.current;
      refreshAbortRef.current?.abort();
      const controller = new AbortController();
      refreshAbortRef.current = controller;
      setLatestRefreshing(true);
      const problems: string[] = [];
      try {
        const [convRes, msgRes, ticketWindow] = await Promise.all([
          serviceSuiteApi.getConversation(conversationId, {
            signal: controller.signal,
          }),
          serviceSuiteApi.listMessages(conversationId, {
            order: "desc",
            signal: controller.signal,
          }),
          readVerifiedTicketWindow({
            tenantId,
            conversationId,
            signal: controller.signal,
          }),
        ]);
        if (controller.signal.aborted || gen !== genRef.current) return false;

        let conversationVerified = false;
        if (convRes.error) {
          problems.push("conversation metadata refresh failed");
        } else {
          const decoded = decodeConversation(convRes.data as unknown, tenantId);
          if (decoded?.id === conversationId) {
            setConversation(decoded);
            conversationVerified = true;
          } else {
            problems.push("conversation metadata response was unverified");
          }
        }

        let messagesVerified = false;
        if (msgRes.error) {
          problems.push("latest message refresh failed");
        } else {
          const decoded = decodeMessageList(
            msgRes.data as unknown,
            tenantId,
            conversationId,
          );
          if (decoded.envelopeError) {
            problems.push(decoded.envelopeError);
          } else {
            messagesVerified = true;
            // A latest refresh deliberately restarts the bounded window; older
            // pages are not mixed with a new mutable snapshot.
            setMessages(sortMessagesChronologically(decoded.items));
            setRejectedRows(decoded.rejected);
            messageWindowRef.current = pageWindow(decoded.page);
            setOlderMessageCursor(decoded.page?.nextCursor ?? null);
          }
        }

        const linkedTickets = ticketWindow.items.filter(
          (ticket) => ticket.conversation_id === conversationId,
        );
        const crossBoundRows = ticketWindow.items.length - linkedTickets.length;
        const ticketsVerified = ticketWindow.complete && crossBoundRows === 0;
        if (ticketsVerified) {
          setThreadTickets(linkedTickets);
          setTicketWindowHasMore(false);
          setTicketPartial(null);
        } else {
          setTicketWindowHasMore(true);
          setTicketPartial(
            crossBoundRows > 0
              ? "The conversation-bound ticket response included another conversation; timing coverage is partial."
              : ticketWindow.problem ||
                  "Conversation-bound ticket timing refresh was partial; the last verified result is stale.",
          );
          problems.push("ticket timing coverage was partial");
        }

        const latestVerified = conversationVerified && messagesVerified;
        if (latestVerified)
          setLastVerifiedAt(new Date(Date.now()).toISOString());
        setLatestStale(
          !latestVerified || !ticketsVerified || problems.length > 0,
        );
        setPartial(
          problems.length > 0
            ? `Refresh partial: ${problems.join("; ")}. Last verified records were retained where possible.`
            : null,
        );
        return conversationVerified;
      } catch {
        if (controller.signal.aborted || gen !== genRef.current) return false;
        setLatestStale(true);
        setPartial(
          "Refresh partial: the latest request failed unexpectedly. Last verified records were retained.",
        );
        return false;
      } finally {
        if (!controller.signal.aborted && gen === genRef.current) {
          setLatestRefreshing(false);
        }
      }
    })();
    latestRefreshPromiseRef.current = operation;
    void operation.finally(() => {
      if (latestRefreshPromiseRef.current === operation) {
        latestRefreshPromiseRef.current = null;
      }
    });
    return operation;
  }, [conversationId, identityScope, loadingOlder, online, tenantId]);

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    if (!online || !olderMessageCursor || loadingOlder || latestRefreshing)
      return;
    setLoadingOlder(true);
    const controller = new AbortController();
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = controller;
    const res = await serviceSuiteApi.listMessages(conversationId, {
      order: "desc",
      cursor: olderMessageCursor,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    if (res.error) {
      setPartial("An older message page could not be verified.");
      setLoadingOlder(false);
      return;
    }
    const decoded = decodeMessageList(
      res.data as unknown,
      tenantId,
      conversationId,
    );
    if (decoded.envelopeError) {
      setPartial(decoded.envelopeError);
      setLoadingOlder(false);
      return;
    }
    const nextWindow = pageWindow(decoded.page);
    if (!samePageWindow(messageWindowRef.current, nextWindow)) {
      setPartial(
        "The older message page did not share the first verified cursor window. Existing records were retained; refresh latest before continuing.",
      );
      setOlderMessageCursor(null);
      setLatestStale(true);
      setLoadingOlder(false);
      return;
    }
    const existingIds = new Set((messages ?? []).map((message) => message.id));
    if (decoded.items.some((message) => existingIds.has(message.id))) {
      setPartial(
        "The older message page repeated an already loaded record, so the complete page was withheld. Refresh latest before continuing.",
      );
      setOlderMessageCursor(null);
      setLatestStale(true);
      setLoadingOlder(false);
      return;
    }
    setMessages((current) => {
      return sortMessagesChronologically([
        ...(current ?? []),
        ...decoded.items,
      ]);
    });
    setRejectedRows((current) => current + decoded.rejected);
    setOlderMessageCursor(decoded.page?.nextCursor ?? null);
    setLoadingOlder(false);
  }, [
    conversationId,
    latestRefreshing,
    loadingOlder,
    messages,
    olderMessageCursor,
    online,
    tenantId,
  ]);

  useEffect(() => {
    if (!conversation?.id) return;
    window.requestAnimationFrame(() => threadHeadingRef.current?.focus());
  }, [conversation?.id]);

  if (!online && !conversation) {
    return (
      <div className="card helpdesk-empty-detail" data-helpdesk-state="offline">
        <div className="helpdesk-state-icon" aria-hidden="true">
          ⌁
        </div>
        <h2>Thread verification paused offline</h2>
        <p>Reconnect to load protected conversation and message records.</p>
      </div>
    );
  }

  if (err) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <div
          className="muted"
          style={{ color: "var(--pw-danger)", marginBottom: 8 }}
        >
          Couldn&apos;t load this conversation: {err}
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void load()}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      className="card helpdesk-thread-card"
      style={{
        padding: 0,
        display: "flex",
        flexDirection: "column",
        maxHeight: "calc(100vh - 220px)",
        overflow: "hidden",
      }}
    >
      <ThreadHeader
        conversation={conversation}
        tickets={threadTickets}
        ticketWindowHasMore={ticketWindowHasMore}
        ticketPartial={ticketPartial}
        headingRef={threadHeadingRef}
        onBack={onBack}
      />

      <div className="helpdesk-message-window-label">
        <div>
          <span>Latest verified message window</span>
          <span className="muted" role="status" aria-live="polite">
            {lastVerifiedAt
              ? `${latestStale ? "Stale · " : ""}Last verified ${fmtDateTime(lastVerifiedAt)}. `
              : "Not yet verified. "}
            Newest records are fetched on request; no real-time subscription.
          </span>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={!online || loadingOlder}
          aria-disabled={!online || latestRefreshing || loadingOlder}
          onClick={() => void refreshLatest()}
        >
          {latestRefreshing ? "Refreshing latest…" : "Refresh latest"}
        </button>
      </div>

      {partial || ticketPartial || rejectedRows > 0 ? (
        <div className="helpdesk-thread-partial" role="status">
          Current verification is partial.
          {partial
            ? ` Latest window is partial: ${partial}`
            : rejectedRows > 0
              ? ` ${rejectedRows} message row(s) failed workspace or shape validation and were omitted.`
              : ""}
          {ticketPartial ? ` Ticket timing: ${ticketPartial}` : ""}
        </div>
      ) : null}

      <div
        className="helpdesk-message-scroll"
        role="region"
        aria-label="Verified message records"
        tabIndex={0}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 16,
          background: "var(--pw-bg-elev)",
        }}
      >
        {olderMessageCursor ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost helpdesk-load-older-messages"
            disabled={!online || loadingOlder}
            onClick={() => void loadOlderMessages()}
          >
            {loadingOlder ? "Loading older messages…" : "Load older messages"}
          </button>
        ) : null}
        {messages === null ? (
          <div className="muted">Loading messages…</div>
        ) : messages.length === 0 ? (
          <div className="muted">No messages in this conversation yet.</div>
        ) : (
          messages.map((m, i) => (
            <MessageBubble key={m.id || `msg-${i}`} message={m} />
          ))
        )}
      </div>

      <ActionBar
        conversation={conversation}
        tenantId={tenantId}
        noteRecoveryAuthority={noteRecoveryAuthority}
        statuses={statuses}
        canAdmin={canAdmin}
        online={online}
        onReplySent={() => {
          void refreshLatest();
          onMutated();
        }}
        onConversationChanged={(updated) => {
          setConversation(updated);
          onMutated();
        }}
        onRefreshRequested={refreshLatest}
      />
    </div>
  );
}
/* eslint-enable jsx-a11y/no-noninteractive-tabindex */

function sortMessagesChronologically(
  messages: ServiceMessage[],
): ServiceMessage[] {
  return [...messages].sort((left, right) => {
    const leftAt = Date.parse(left.sent_at ?? left.created_at ?? "");
    const rightAt = Date.parse(right.sent_at ?? right.created_at ?? "");
    if (leftAt !== rightAt) return leftAt - rightAt;
    return (left.id ?? "").localeCompare(right.id ?? "");
  });
}

function describeConversationTicketTiming(
  tickets: ServiceTicket[] | null,
  hasMore: boolean,
  partial: string | null,
): RecordedDueDateDescriptor {
  if (tickets === null) {
    return {
      kind: "unknown",
      label: "Due date unverified",
      detail:
        partial ?? "Conversation-bound ticket timing is still being verified.",
    };
  }
  if (tickets.length === 0) {
    return partial || hasMore
      ? {
          kind: "unknown",
          label: "Due date unverified",
          detail:
            partial ??
            "The bounded conversation ticket window is incomplete, so an absent record cannot prove that no recorded due date exists.",
        }
      : describeTicketDueDate(null, Date.now(), true);
  }
  if (hasMore || tickets.length > 1) {
    return {
      kind: "unknown",
      label: `${tickets.length}${hasMore ? "+" : ""} linked ticket records`,
      detail:
        "Multiple or paginated conversation-bound ticket records exist. No single recorded due date is presented as authoritative.",
    };
  }
  return describeTicketDueDate(tickets[0]);
}

function ThreadHeader({
  conversation,
  tickets,
  ticketWindowHasMore,
  ticketPartial,
  headingRef,
  onBack,
}: {
  conversation: ServiceConversation | null;
  tickets: ServiceTicket[] | null;
  ticketWindowHasMore: boolean;
  ticketPartial: string | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
}): ReactElement {
  if (!conversation) {
    return (
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--pw-border)",
        }}
      >
        <div className="muted">Loading…</div>
      </div>
    );
  }
  const verifiedAssignee = (conversation.assigned_to_user_id ?? "").trim();
  const dueDate = describeConversationTicketTiming(
    tickets,
    ticketWindowHasMore,
    ticketPartial,
  );
  return (
    <div className="helpdesk-thread-header">
      <button
        type="button"
        className="btn btn-sm btn-ghost helpdesk-thread-back"
        onClick={onBack}
      >
        ← Queue
      </button>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "baseline",
        }}
      >
        <h2 ref={headingRef} tabIndex={-1} className="helpdesk-thread-title">
          {requesterLabel(conversation)}
        </h2>
        <span className={statusBadgeClass(conversation.status)}>
          {titleizeStatus(conversation.status ?? "—")}
        </span>
      </div>
      <div
        className={`helpdesk-thread-due-date is-${dueDate.kind}`}
        title={dueDate.detail}
      >
        <span>Ticket timing</span>
        <strong>{dueDate.label}</strong>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {(conversation.subject ?? "").trim() || "(no subject)"}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 8,
          fontSize: 12,
        }}
        className="muted"
      >
        <span>
          Channel:{" "}
          <span className="mono">
            {(conversation.channel_type ?? "").trim() || "—"}
          </span>
        </span>
        {(conversation.requester_email ?? "").trim() ? (
          <span>
            Email: <span className="mono">{conversation.requester_email}</span>
          </span>
        ) : null}
        {(conversation.requester_phone ?? "").trim() ? (
          <span>
            Phone: <span className="mono">{conversation.requester_phone}</span>
          </span>
        ) : null}
        <span>
          Assignee:{" "}
          {verifiedAssignee ? (
            <span className="mono">Verified user {verifiedAssignee}</span>
          ) : conversation.assignment_state === "legacy_unverified" ? (
            "Historical assignment exists · identity unverified"
          ) : (
            "Unassigned"
          )}
        </span>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ServiceMessage }): ReactElement {
  const outbound = (message.direction ?? "").trim() === "outbound";
  const internal =
    (message.direction ?? "").trim() === "internal" ||
    (message.record_kind ?? "").trim() === "internal_note";
  const text = messageText(message);
  const sender =
    (message.sender ?? "").trim() || titleizeStatus(message.sender_type ?? "—");
  const when = message.sent_at ?? message.created_at ?? null;
  return (
    <div
      className={`helpdesk-message-row${outbound ? " is-outbound" : ""}${internal ? " is-internal" : ""}`}
    >
      <div className="helpdesk-message-bubble">
        <div
          style={{
            fontSize: 11,
            opacity: 0.85,
            marginBottom: 3,
            display: "flex",
            gap: 8,
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontWeight: 600 }}>{sender}</span>
          <span className="tabular">{fmtDateTime(when)}</span>
        </div>
        <div className="helpdesk-message-truth">
          {internal
            ? "Internal note · delivery not applicable"
            : outbound
              ? "Stored outbound record · customer delivery unverified"
              : "Stored inbound record"}
        </div>
        {message.projection_truncated ||
        (message.attachment_count ?? 0) > 0 ||
        message.body_omitted_reason ? (
          <div className="helpdesk-message-projection">
            {message.projection_truncated
              ? "Text projection truncated by the server. "
              : ""}
            {(message.attachment_count ?? 0) > 0
              ? `${message.attachment_count} attachment record(s) are not displayed. `
              : ""}
            {message.body_omitted_reason
              ? `Text unavailable: ${titleizeStatus(message.body_omitted_reason)}.`
              : ""}
          </div>
        ) : null}
        <div
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 13,
          }}
        >
          {text || <span style={{ opacity: 0.7 }}>(no text)</span>}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------
 * Action bar — reply composer + assign + status + macros. Every write
 * is admin-gated; the controls are disabled (with a hint) for non-admins.
 * -------------------------------------------------------------------- */

interface ActionBarProps {
  conversation: ServiceConversation | null;
  tenantId: string;
  noteRecoveryAuthority: InternalNoteRecoveryAuthority | null;
  statuses: string[];
  canAdmin: boolean;
  online: boolean;
  onReplySent: () => void;
  onConversationChanged: (updated: ServiceConversation) => void;
  onRefreshRequested: () => Promise<boolean>;
}

const STATUS_REVIEW_REQUIRED = new Set([
  "resolved",
  "closed",
  "spam",
  "archived",
]);

type PendingMutationReview =
  | {
      kind: "status";
      current: string;
      next: string;
    }
  | {
      kind: "unassign";
      assignmentState:
        | "tenant_active_user"
        | "unassigned"
        | "legacy_unverified";
      assignedToUserId: string | null;
    };

function useActionBarController({
  conversation,
  tenantId,
  noteRecoveryAuthority,
  statuses,
  canAdmin,
  online,
  onReplySent,
  onConversationChanged,
  onRefreshRequested,
}: ActionBarProps) {
  const id = conversation?.id ?? "";
  const noteRecoveryScope = noteRecoveryAuthority?.scope ?? null;
  const noteRecoveryLegacyV2Scope =
    noteRecoveryAuthority?.legacyV2Scope ?? null;
  const noteRecoveryApiBaseUrl = noteRecoveryAuthority?.apiBaseUrl ?? null;
  const noteRecoveryApiIdentityGeneration =
    noteRecoveryAuthority?.apiIdentityGeneration ?? null;
  const noteRecoveryUser = noteRecoveryAuthority?.user ?? null;
  const noteRecoveryTenant = noteRecoveryAuthority?.tenant ?? null;
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [noteRecoveryState, setNoteRecoveryState] = useState<
    | "loading"
    | "clear"
    | "held"
    | "legacy"
    | "reviewing"
    | "unavailable"
    | "corrupt"
  >("loading");
  const sendOperationRef = useRef(false);
  const noteOperationContextRef = useRef({
    apiBaseUrl: noteRecoveryApiBaseUrl,
    apiIdentityGeneration: noteRecoveryApiIdentityGeneration,
    id,
    legacyV2Scope: noteRecoveryLegacyV2Scope,
    mounted: false,
    scope: noteRecoveryScope,
    tenantId,
    tenant: noteRecoveryTenant,
    user: noteRecoveryUser,
  });

  const [assignmentReason, setAssignmentReason] = useState("");
  const [assigning, setAssigning] = useState(false);
  const assignOperationRef = useRef(false);

  const [statusBusy, setStatusBusy] = useState(false);
  const statusOperationRef = useRef(false);
  const [mutationHold, setMutationHold] = useState<string | null>(null);
  const [pendingMutationReview, setPendingMutationReview] =
    useState<PendingMutationReview | null>(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const confirmationOperationRef = useRef(false);

  const [macros, setMacros] = useState<ServiceMacro[] | null>(null);
  const [macrosLoading, setMacrosLoading] = useState(false);
  const [macroLoadError, setMacroLoadError] = useState<string | null>(null);
  const macrosRequestRef = useRef<Promise<void> | null>(null);
  const macrosAbortRef = useRef<AbortController | null>(null);
  const macrosGenerationRef = useRef(0);
  const assignmentReasonId = useId();
  const statusId = useId();
  const macroId = useId();
  const replyId = useId();
  const actionHintId = useId();
  const assignHintId = useId();
  const statusHintId = useId();
  const replyHintId = useId();
  const replyPrivacyId = useId();

  useEffect(() => {
    const context = {
      apiBaseUrl: noteRecoveryApiBaseUrl,
      apiIdentityGeneration: noteRecoveryApiIdentityGeneration,
      id,
      legacyV2Scope: noteRecoveryLegacyV2Scope,
      mounted: true,
      scope: noteRecoveryScope,
      tenantId,
      tenant: noteRecoveryTenant,
      user: noteRecoveryUser,
    };
    noteOperationContextRef.current = context;
    return () => {
      if (noteOperationContextRef.current === context) {
        noteOperationContextRef.current = { ...context, mounted: false };
      }
      // A prepared-but-not-dispatched intent stays encrypted. The asynchronous
      // action keeps its process lease until its continuation checkpoints the
      // outcome; this mounted-instance flag bars it from updating the new UI.
      sendOperationRef.current = false;
    };
  }, [
    id,
    noteRecoveryApiBaseUrl,
    noteRecoveryApiIdentityGeneration,
    noteRecoveryLegacyV2Scope,
    noteRecoveryScope,
    noteRecoveryTenant,
    noteRecoveryUser,
    tenantId,
  ]);

  useEffect(() => {
    let current = true;
    setBody("");
    setNoteRecoveryState("loading");
    if (!id || !noteRecoveryScope) {
      setNoteRecoveryState("unavailable");
      return () => {
        current = false;
      };
    }
    void internalNoteRecovery
      .hasHeldConversation(noteRecoveryScope, id, noteRecoveryLegacyV2Scope)
      .then((state) => {
        if (current) setNoteRecoveryState(state);
      });
    return () => {
      current = false;
    };
  }, [id, noteRecoveryLegacyV2Scope, noteRecoveryScope]);

  useEffect(() => {
    setAssignmentReason("");
    setMacros(null);
    setMacroLoadError(null);
    setMutationHold(null);
    macrosGenerationRef.current += 1;
    macrosAbortRef.current?.abort();
    macrosRequestRef.current = null;
    return () => {
      macrosGenerationRef.current += 1;
      macrosAbortRef.current?.abort();
    };
  }, [id, tenantId]);

  useEffect(() => {
    confirmationOperationRef.current = false;
    setConfirmationBusy(false);
    setPendingMutationReview(null);
  }, [conversation?.version, id]);

  const sendReply = async (): Promise<void> => {
    const text = body.trim();
    const exactReplayReviewed = noteRecoveryState === "reviewing";
    if (
      !id ||
      !noteRecoveryScope ||
      !online ||
      (noteRecoveryState !== "clear" && !exactReplayReviewed) ||
      internalNoteValidationError(body) ||
      sendOperationRef.current
    )
      return;
    const operationContext = noteOperationContextRef.current;
    let operationLease = tryAcquireInternalNoteOperationLease();
    if (!operationLease) {
      setNoteRecoveryState("unavailable");
      toast.error(
        "No internal-note request was sent because destructive sign-out has started.",
      );
      return;
    }
    const releaseOperationLease = (): void => {
      operationLease?.release();
      operationLease = null;
    };
    const sameMountedContext = (): boolean =>
      noteOperationContextRef.current === operationContext &&
      operationContext.mounted;
    const authorityIsCurrent = (): boolean => {
      if (
        !sameMountedContext() ||
        !operationContext.apiBaseUrl ||
        operationContext.apiIdentityGeneration === null ||
        !operationContext.scope ||
        !operationContext.user ||
        !operationContext.tenant
      ) {
        return false;
      }
      try {
        const principal = readNoteRecoveryPrincipal();
        const current = sessionNoteRecoveryAuthority(
          principal?.user,
          principal?.tenant,
          principal?.apiBaseUrl,
          principal?.apiIdentityGeneration,
        );
        const currentTransportBase =
          canonicalNoteRecoveryApiBaseUrl(getApiUrl());
        return (
          current?.scope === operationContext.scope &&
          current.apiIdentityGeneration ===
            operationContext.apiIdentityGeneration &&
          apiIdentityGenerationIsCurrent(
            operationContext.apiIdentityGeneration,
          ) &&
          current.apiBaseUrl === operationContext.apiBaseUrl &&
          currentTransportBase === operationContext.apiBaseUrl &&
          current.user === operationContext.user &&
          current.tenant === operationContext.tenant
        );
      } catch {
        return false;
      }
    };
    const holdBeforeTransport = (): void => {
      releaseOperationLease();
      if (!sameMountedContext()) return;
      sendOperationRef.current = false;
      setSending(false);
      setNoteRecoveryState("unavailable");
      toast.error(
        "No internal-note request was sent because the signed-in recovery principal or API workspace changed. The encrypted checkpoint remains held for its original authority.",
      );
    };
    if (!authorityIsCurrent()) {
      holdBeforeTransport();
      return;
    }
    sendOperationRef.current = true;
    setSending(true);
    let prepared: Awaited<ReturnType<typeof internalNoteRecovery.prepare>>;
    try {
      prepared = exactReplayReviewed
        ? await internalNoteRecovery.reviewExactReplay(
            noteRecoveryScope,
            id,
            text,
            operationContext.legacyV2Scope,
          )
        : await internalNoteRecovery.prepare(
            noteRecoveryScope,
            id,
            text,
            operationContext.legacyV2Scope,
          );
    } catch {
      if (!authorityIsCurrent()) {
        holdBeforeTransport();
        return;
      }
      setNoteRecoveryState("unavailable");
      sendOperationRef.current = false;
      setSending(false);
      toast.error("Encrypted internal-note recovery could not be prepared.");
      releaseOperationLease();
      return;
    }
    if (!authorityIsCurrent()) {
      holdBeforeTransport();
      return;
    }
    if (prepared.status === "held") {
      setNoteRecoveryState(
        prepared.reason === "vault-corrupt"
          ? "corrupt"
          : prepared.reason === "legacy-scope-held"
            ? "legacy"
            : prepared.reason === "unresolved-intent"
              ? "held"
              : "unavailable",
      );
      toast.error(
        exactReplayReviewed
          ? "No request was sent: the re-entered note did not exactly match the encrypted unresolved intent, or recovery could not be verified."
          : "Internal note held before the request: durable recovery is unavailable or an earlier outcome is unresolved.",
      );
      sendOperationRef.current = false;
      setSending(false);
      releaseOperationLease();
      return;
    }
    // This is the final synchronous authority check immediately adjacent to
    // transport creation. A delayed vault operation can never dispatch under
    // whichever credential happens to be current after an identity/base swap.
    if (!authorityIsCurrent()) {
      holdBeforeTransport();
      return;
    }
    try {
      const res = await serviceSuiteApi.postInternalNote(
        id,
        { body_text: text },
        prepared.idempotencyKey,
      );
      if (res.error) {
        if (internalNoteOutcomeIsUnknown(res.error)) {
          await internalNoteRecovery.markUnknown(
            operationContext.scope,
            prepared.signature,
          );
          if (authorityIsCurrent()) setNoteRecoveryState("held");
        } else {
          const cleared = await internalNoteRecovery.settle(
            operationContext.scope,
            prepared.signature,
          );
          if (authorityIsCurrent()) {
            setNoteRecoveryState(cleared ? "clear" : "unavailable");
          }
        }
        if (authorityIsCurrent())
          writeErrorToast("Adding internal note", res.error);
        return;
      }
      const note = decodeMessage(res.data as unknown, tenantId, id);
      if (!note || !isVerifiedInternalNote(note)) {
        await internalNoteRecovery.markUnknown(
          operationContext.scope,
          prepared.signature,
        );
        if (authorityIsCurrent()) {
          toast.error(
            "The server did not confirm an internal-only, non-delivery record. The note remains in the composer.",
          );
          setNoteRecoveryState("held");
        }
        return;
      }
      const cleared = await internalNoteRecovery.settle(
        operationContext.scope,
        prepared.signature,
      );
      if (!authorityIsCurrent()) return;
      setBody("");
      setNoteRecoveryState(cleared ? "clear" : "held");
      toast.success(
        exactReplayReviewed
          ? cleared
            ? "Earlier internal note confirmed — customer delivery was not attempted"
            : "Earlier internal note confirmed; its local recovery checkpoint remains held"
          : cleared
            ? "Internal note added — customer delivery was not attempted"
            : "Internal note added; its local recovery checkpoint remains held",
      );
      onReplySent();
    } catch (error) {
      await internalNoteRecovery.markUnknown(
        operationContext.scope,
        prepared.signature,
      );
      if (!authorityIsCurrent()) return;
      setNoteRecoveryState("held");
      toast.error(
        error instanceof Error
          ? `Adding internal note failed: ${error.message}`
          : "Adding internal note failed unexpectedly.",
      );
    } finally {
      releaseOperationLease();
      if (sameMountedContext()) {
        sendOperationRef.current = false;
        setSending(false);
        if (!authorityIsCurrent()) setNoteRecoveryState("unavailable");
      }
    }
  };

  const beginExactReplayReview = (): void => {
    if (!online || noteRecoveryState !== "held") return;
    setBody("");
    setNoteRecoveryState("reviewing");
  };

  const cancelExactReplayReview = (): void => {
    if (noteRecoveryState !== "reviewing") return;
    setBody("");
    setNoteRecoveryState("held");
  };

  const doAssign = async (
    action: "assign_self" | "unassign",
  ): Promise<void> => {
    if (
      !id ||
      !online ||
      !conversation?.version ||
      assignmentReasonValidationError(assignmentReason) ||
      assignOperationRef.current ||
      mutationHold
    )
      return;
    assignOperationRef.current = true;
    setAssigning(true);
    try {
      const reason = assignmentReason.trim();
      const res = await serviceSuiteApi.assign(
        id,
        {
          action,
          ...(reason ? { reason } : {}),
        },
        conversation.version,
      );
      if (res.error) {
        if (mutationOutcomeNeedsReview(res.error)) {
          setMutationHold(
            "Assignment outcome or resource version could not be confirmed. Refresh and review before another write.",
          );
        }
        writeErrorToast("Assigning", res.error);
        return;
      }
      const updated = decodeConversation(res.data as unknown, tenantId);
      const confirmed =
        updated?.id === id &&
        (action === "unassign"
          ? updated.assignment_state === "unassigned"
          : updated.assignment_state === "tenant_active_user" &&
            Boolean((updated.assigned_to_user_id ?? "").trim()));
      if (!confirmed) {
        setMutationHold(
          "The assignment response could not be verified. Refresh and review before another write.",
        );
        toast.error(
          "The server did not confirm the requested assignment state.",
        );
        return;
      }
      setAssignmentReason("");
      setMutationHold(null);
      toast.success(
        action === "unassign"
          ? "Conversation unassigned"
          : "Conversation assigned to your authenticated identity",
      );
      onConversationChanged(updated);
    } catch (error) {
      setMutationHold(
        "Assignment outcome is unknown. Refresh and review before another write.",
      );
      toast.error(
        error instanceof Error
          ? `Assigning failed: ${error.message}`
          : "Assigning failed unexpectedly.",
      );
    } finally {
      assignOperationRef.current = false;
      setAssigning(false);
    }
  };

  const changeStatus = async (next: string): Promise<void> => {
    if (
      !id ||
      !online ||
      !next ||
      !conversation?.version ||
      statusOperationRef.current ||
      mutationHold
    )
      return;
    if (next === (conversation?.status ?? "")) return;
    statusOperationRef.current = true;
    setStatusBusy(true);
    try {
      const res = await serviceSuiteApi.setStatus(
        id,
        next,
        conversation.version,
      );
      if (res.error) {
        if (mutationOutcomeNeedsReview(res.error)) {
          setMutationHold(
            "Status outcome or resource version could not be confirmed. Refresh and review before another write.",
          );
        }
        writeErrorToast("Changing status", res.error);
        return;
      }
      const updated = decodeConversation(res.data as unknown, tenantId);
      if (updated?.id !== id || updated.status !== next) {
        setMutationHold(
          "The status response could not be verified. Refresh and review before another write.",
        );
        toast.error("The server did not confirm the requested status.");
        return;
      }
      toast.success(`Status set to ${titleizeStatus(next)}`);
      setMutationHold(null);
      onConversationChanged(updated);
    } catch (error) {
      setMutationHold(
        "Status outcome is unknown. Refresh and review before another write.",
      );
      toast.error(
        error instanceof Error
          ? `Changing status failed: ${error.message}`
          : "Changing status failed unexpectedly.",
      );
    } finally {
      statusOperationRef.current = false;
      setStatusBusy(false);
    }
  };

  const requestAssignment = (action: "assign_self" | "unassign"): void => {
    if (action === "assign_self") {
      void doAssign(action);
      return;
    }
    if (
      !conversation ||
      conversation.assignment_state === "unassigned" ||
      assigning ||
      statusBusy ||
      mutationHold ||
      pendingMutationReview
    ) {
      return;
    }
    setPendingMutationReview({
      kind: "unassign",
      assignmentState: conversation.assignment_state,
      assignedToUserId:
        conversation.assignment_state === "tenant_active_user"
          ? (conversation.assigned_to_user_id ?? null)
          : null,
    });
  };

  const requestStatusChange = (next: string): void => {
    const current = conversation?.status ?? "";
    if (
      !next ||
      next === current ||
      assigning ||
      statusBusy ||
      mutationHold ||
      pendingMutationReview
    ) {
      return;
    }
    if (STATUS_REVIEW_REQUIRED.has(next)) {
      setPendingMutationReview({ kind: "status", current, next });
      return;
    }
    void changeStatus(next);
  };

  const cancelMutationReview = (): void => {
    if (confirmationBusy) return;
    setPendingMutationReview(null);
  };

  const confirmMutationReview = async (): Promise<void> => {
    if (
      !pendingMutationReview ||
      confirmationOperationRef.current ||
      confirmationBusy
    ) {
      return;
    }
    const review = pendingMutationReview;
    confirmationOperationRef.current = true;
    setConfirmationBusy(true);
    try {
      if (review.kind === "status") await changeStatus(review.next);
      else await doAssign("unassign");
    } finally {
      confirmationOperationRef.current = false;
      setConfirmationBusy(false);
      setPendingMutationReview((current) =>
        current === review ? null : current,
      );
    }
  };

  const loadMacros = useCallback((): Promise<void> => {
    if (!online || macros !== null) return Promise.resolve();
    if (macrosRequestRef.current) return macrosRequestRef.current;
    setMacrosLoading(true);
    const generation = ++macrosGenerationRef.current;
    macrosAbortRef.current?.abort();
    const controller = new AbortController();
    macrosAbortRef.current = controller;
    setMacroLoadError(null);
    const operation = (async (): Promise<void> => {
      try {
        const loaded: ServiceMacro[] = [];
        const ids = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        let window: VerifiedHelpdeskPageWindow | null = null;
        let failure: string | null = null;
        for (
          let pageNumber = 0;
          pageNumber < HELPDESK_MAX_JOIN_PAGES;
          pageNumber += 1
        ) {
          const res = await serviceSuiteApi.listMacros({
            ...(cursor ? { cursor } : {}),
            limit: HELPDESK_PAGE_SIZE,
            signal: controller.signal,
          });
          if (
            controller.signal.aborted ||
            generation !== macrosGenerationRef.current
          )
            return;
          if (res.error) {
            failure = `Macro pagination failed: ${res.error.message}`;
            break;
          }
          const decoded = decodeMacroList(res.data as unknown, tenantId);
          if (decoded.envelopeError || !decoded.page) {
            failure =
              decoded.envelopeError ||
              "The macro page omitted its verified pagination window.";
            break;
          }
          const nextWindow = pageWindow(decoded.page);
          if (window === null) window = nextWindow;
          else if (!samePageWindow(window, nextWindow)) {
            failure =
              "A macro cursor page changed its verified window. No partial macro picker was exposed.";
            break;
          }
          if (decoded.rejected > 0) {
            failure = `${decoded.rejected} macro row(s) failed strict validation. No partial macro picker was exposed.`;
            break;
          }
          if (decoded.items.some((macro) => !macro.id || ids.has(macro.id))) {
            failure =
              "A macro cursor page repeated a record. No partial macro picker was exposed.";
            break;
          }
          for (const macro of decoded.items) {
            ids.add(macro.id ?? "");
            loaded.push(macro);
          }
          if (loaded.length > HELPDESK_MAX_JOIN_ROWS) {
            failure =
              "The macro list exceeded the bounded verification row limit. No partial macro picker was exposed.";
            break;
          }
          const nextCursor = decoded.page.nextCursor;
          if (!nextCursor) break;
          if (cursors.has(nextCursor)) {
            failure =
              "Macro pagination repeated an opaque cursor. No partial macro picker was exposed.";
            break;
          }
          cursors.add(nextCursor);
          cursor = nextCursor;
          if (pageNumber === HELPDESK_MAX_JOIN_PAGES - 1) {
            failure =
              "The macro list exceeded the bounded verification page limit. No partial macro picker was exposed.";
          }
        }
        if (failure) {
          toast.error(failure);
          setMacroLoadError(failure);
          setMacros([]);
          return;
        }
        setMacroLoadError(null);
        setMacros(loaded);
      } catch (error) {
        if (
          controller.signal.aborted ||
          generation !== macrosGenerationRef.current
        )
          return;
        const message =
          error instanceof Error
            ? `Couldn't load macros: ${error.message}`
            : "Couldn't load macros unexpectedly.";
        toast.error(message);
        setMacroLoadError(message);
        setMacros([]);
      } finally {
        if (
          !controller.signal.aborted &&
          generation === macrosGenerationRef.current
        )
          setMacrosLoading(false);
      }
    })();
    macrosRequestRef.current = operation;
    void operation.finally(() => {
      if (macrosRequestRef.current === operation)
        macrosRequestRef.current = null;
    });
    return operation;
  }, [macros, online, tenantId]);

  const retryMacros = (): void => {
    if (!online || macrosLoading) return;
    macrosGenerationRef.current += 1;
    macrosAbortRef.current?.abort();
    macrosRequestRef.current = null;
    setMacroLoadError(null);
    setMacros(null);
  };

  useEffect(() => {
    if (canAdmin && id) void loadMacros();
  }, [canAdmin, id, loadMacros]);

  const applyMacro = (macro: ServiceMacro): void => {
    // Insert the macro body into the composer immediately — the UI win
    // shouldn't wait on the (admin-gated) use-count bump.
    setBody((prev) => {
      const insert = (macro.body ?? "").toString();
      if (!prev.trim()) return insert;
      return `${prev.replace(/\s+$/, "")}\n\n${insert}`;
    });
    // Local insertion only. The server intentionally holds macro usage
    // evidence and returns 409; do not call it or imply an analytics event.
  };

  const statusList = Array.isArray(statuses) ? statuses : [];
  const noteValidation = internalNoteValidationError(body);
  const noteBytes = utf8ByteLength(body.trim());
  const assignmentValidation =
    assignmentReasonValidationError(assignmentReason);
  const actionHint = !canAdmin
    ? "Internal notes, assignment, templates, and status changes need admin access."
    : !online
      ? "Helpdesk is offline. Reads and writes are paused; nothing is queued."
      : !id
        ? "Conversation details are still loading."
        : null;
  const assignHint =
    actionHint ??
    (assigning
      ? "Assignment is in progress."
      : mutationHold
        ? mutationHold
        : assignmentValidation
          ? assignmentValidation
          : "Assignment targets are server-derived: assign to your authenticated identity or unassign.");
  const statusHint =
    actionHint ??
    (statusBusy ? "The status change is still in progress." : mutationHold);
  const replyHint =
    actionHint ??
    (sending
      ? "The internal note is being saved."
      : noteValidation
        ? noteValidation
        : noteRecoveryState === "held"
          ? "A prior note outcome is unresolved. An exact-body same-key replay requires a separate review step; no replacement key can be created."
          : noteRecoveryState === "legacy"
            ? "An originless legacy recovery checkpoint exists for this conversation. Its authority cannot be proven, so replay and replacement keys are blocked."
            : noteRecoveryState === "reviewing"
              ? "Re-enter the exact prior note. Add will reuse its encrypted key only if conversation and body hash match; no new key or automatic retry is allowed."
              : noteRecoveryState === "unavailable" ||
                  noteRecoveryState === "corrupt"
                ? "Encrypted recovery is unavailable. No note request can start."
                : "Ready to store as an internal record only.");

  const refreshHeldMutation = async (): Promise<void> => {
    if (!online || !mutationHold || assigning || statusBusy) return;
    setStatusBusy(true);
    let verified = false;
    try {
      verified = await onRefreshRequested();
    } catch {
      verified = false;
    } finally {
      setStatusBusy(false);
    }
    if (verified) setMutationHold(null);
    else {
      setMutationHold(
        "The conversation could not be refreshed. Writes remain held against the last verified version.",
      );
    }
  };

  return {
    actionHint,
    actionHintId,
    applyMacro,
    assignmentReason,
    assignmentReasonId,
    assignHint,
    assignHintId,
    assigning,
    beginExactReplayReview,
    body,
    cancelExactReplayReview,
    canAdmin,
    online,
    cancelMutationReview,
    confirmationBusy,
    conversation,
    confirmMutationReview,
    id,
    loadMacros,
    macroId,
    macroLoadError,
    macros,
    macrosLoading,
    mutationHold,
    noteRecoveryScope,
    pendingMutationReview,
    requestAssignment,
    requestStatusChange,
    retryMacros,
    refreshHeldMutation,
    noteRecoveryState,
    replyHint,
    replyHintId,
    replyPrivacyId,
    replyId,
    sendReply,
    sending,
    setAssignmentReason,
    setBody,
    statusBusy,
    statusHint,
    statusHintId,
    statusId,
    statusList,
    assignmentValidation,
    noteValidation,
    noteBytes,
  };
}

type ActionBarController = ReturnType<typeof useActionBarController>;

function ActionBar(props: ActionBarProps): ReactElement {
  return <ActionBarView controller={useActionBarController(props)} />;
}

function ActionBarHints({
  actionHint,
  actionHintId,
  assignHint,
  assignHintId,
  statusHint,
  statusHintId,
}: Pick<
  ActionBarController,
  | "actionHint"
  | "actionHintId"
  | "assignHint"
  | "assignHintId"
  | "statusHint"
  | "statusHintId"
>): ReactElement | null {
  if (!actionHint && !assignHint && !statusHint) return null;
  return (
    <div className="muted" style={{ display: "grid", gap: 2, fontSize: 11 }}>
      {actionHint ? <span id={actionHintId}>{actionHint}</span> : null}
      {assignHint ? (
        <span
          id={assignHintId}
          className={assignHint === actionHint ? "sr-only" : undefined}
        >
          {assignHint}
        </span>
      ) : null}
      {statusHint ? (
        <span
          id={statusHintId}
          className={statusHint === actionHint ? "sr-only" : undefined}
        >
          {statusHint}
        </span>
      ) : null}
    </div>
  );
}

function ActionBarView({
  controller,
}: {
  controller: ActionBarController;
}): ReactElement {
  const {
    actionHint,
    actionHintId,
    applyMacro,
    assignmentReason,
    assignmentReasonId,
    assignHint,
    assignHintId,
    assigning,
    beginExactReplayReview,
    body,
    cancelMutationReview,
    canAdmin,
    cancelExactReplayReview,
    confirmationBusy,
    confirmMutationReview,
    conversation,
    id,
    loadMacros,
    macroId,
    macroLoadError,
    macros,
    macrosLoading,
    mutationHold,
    noteRecoveryScope,
    pendingMutationReview,
    noteRecoveryState,
    noteBytes,
    noteValidation,
    assignmentValidation,
    refreshHeldMutation,
    replyHint,
    replyHintId,
    replyPrivacyId,
    replyId,
    requestAssignment,
    requestStatusChange,
    retryMacros,
    sendReply,
    sending,
    setAssignmentReason,
    setBody,
    statusBusy,
    statusHint,
    statusHintId,
    statusId,
    statusList,
    online,
  } = controller;
  const statusSelectRef = useRef<HTMLSelectElement>(null);
  const unassignButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  const macroErrorId = useId();

  return (
    <div
      className="helpdesk-action-bar"
      style={{
        borderTop: "1px solid var(--pw-border)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Assign + status + macros row */}
      <div
        className="helpdesk-action-row"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
        }}
      >
        <div className="field helpdesk-assignment-controls">
          <label className="sr-only" htmlFor={assignmentReasonId}>
            Assignment reason (optional)
          </label>
          <input
            id={assignmentReasonId}
            className="input"
            placeholder="Assignment reason (optional)"
            value={assignmentReason}
            disabled={
              !canAdmin ||
              !online ||
              !id ||
              assigning ||
              Boolean(mutationHold) ||
              Boolean(pendingMutationReview)
            }
            aria-invalid={Boolean(assignmentValidation)}
            aria-describedby={assignHint ? assignHintId : undefined}
            onChange={(e) => setAssignmentReason(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={
              !canAdmin ||
              !online ||
              !id ||
              assigning ||
              Boolean(assignmentValidation) ||
              Boolean(mutationHold) ||
              Boolean(pendingMutationReview)
            }
            aria-describedby={assignHint ? assignHintId : undefined}
            onClick={() => requestAssignment("assign_self")}
          >
            {assigning ? "Updating…" : "Assign to me"}
          </button>
          <button
            ref={unassignButtonRef}
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={
              !canAdmin ||
              !online ||
              !id ||
              assigning ||
              Boolean(assignmentValidation) ||
              Boolean(mutationHold) ||
              Boolean(pendingMutationReview) ||
              conversation?.assignment_state === "unassigned"
            }
            aria-describedby={assignHint ? assignHintId : undefined}
            onClick={() => requestAssignment("unassign")}
          >
            Unassign
          </button>
        </div>

        <div className="field">
          <label className="sr-only" htmlFor={statusId}>
            Conversation status
          </label>
          <select
            ref={statusSelectRef}
            id={statusId}
            className="input"
            value={(conversation?.status ?? "") || ""}
            disabled={
              !canAdmin ||
              !online ||
              !id ||
              statusBusy ||
              Boolean(mutationHold) ||
              Boolean(pendingMutationReview)
            }
            aria-describedby={statusHint ? statusHintId : undefined}
            onChange={(e) => requestStatusChange(e.target.value)}
          >
            {/* While the thread is still loading there is no status yet.
                Without a value="" option the controlled select would fall
                back to displaying the FIRST catalog status (e.g. "Open") —
                fabricating a status the conversation may not have — and
                React would warn about the value not matching any option. */}
            {!conversation ? <option value="">Loading…</option> : null}
            {/* Render the current status even if it isn't in the catalog
                list, so the select always reflects reality. */}
            {(conversation?.status ?? "").trim() &&
            !statusList.includes(conversation?.status ?? "") ? (
              <option value={conversation?.status ?? ""}>
                {titleizeStatus(conversation?.status ?? "—")}
              </option>
            ) : null}
            {statusList.length === 0 && !(conversation?.status ?? "").trim() ? (
              <option value="">No statuses</option>
            ) : null}
            {statusList.map((s, i) => (
              <option key={s || `st-${i}`} value={s}>
                {titleizeStatus(s)}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="sr-only" htmlFor={macroId}>
            Insert macro text into internal note
          </label>
          <select
            id={macroId}
            className="input"
            value=""
            disabled={
              !canAdmin ||
              !online ||
              !id ||
              macrosLoading ||
              Boolean(macroLoadError) ||
              Boolean(pendingMutationReview)
            }
            aria-describedby={
              [
                actionHint ? actionHintId : null,
                macroLoadError ? macroErrorId : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            onFocus={() => void loadMacros()}
            onPointerDown={() => void loadMacros()}
            onChange={(event) => {
              const index = Number.parseInt(event.target.value, 10);
              const macro = macros?.[index];
              if (macro) applyMacro(macro);
            }}
          >
            <option value="">
              {macrosLoading
                ? "Loading macros…"
                : macroLoadError
                  ? "Macro list unavailable"
                  : macros?.length === 0
                    ? "No macros available"
                    : "Insert macro text…"}
            </option>
            {(macros ?? []).map((macro, index) => (
              <option key={macro.id || `macro-${index}`} value={index}>
                {(macro.name ?? "").trim() || "(unnamed macro)"}
              </option>
            ))}
          </select>
        </div>
      </div>

      {macroLoadError ? (
        <div
          id={macroErrorId}
          className="helpdesk-partial-notice"
          role="status"
        >
          <span>{macroLoadError}</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={!online || macrosLoading}
            onClick={retryMacros}
          >
            Retry complete macro list
          </button>
        </div>
      ) : null}

      {pendingMutationReview ? (
        <Modal
          open
          role="alertdialog"
          title={
            pendingMutationReview.kind === "status"
              ? "Review recorded status change"
              : "Review unassignment"
          }
          description="Review this recorded change before it is applied."
          size="sm"
          initialFocusRef={confirmationCancelRef}
          returnFocusRef={
            pendingMutationReview.kind === "status"
              ? statusSelectRef
              : unassignButtonRef
          }
          closeOnBackdrop={false}
          closeOnEscape={!confirmationBusy}
          closeDisabled={confirmationBusy}
          onClose={cancelMutationReview}
        >
          <div className="helpdesk-mutation-review">
            <p>
              Begin requester-provided identity:{" "}
              <span className="helpdesk-untrusted-text">
                {requesterLabel(conversation)}
              </span>
              . End requester-provided identity.{" "}
              {pendingMutationReview.kind === "status" ? (
                <>
                  Server-recorded transition:{" "}
                  <strong>
                    {titleizeStatus(pendingMutationReview.current)} →{" "}
                    {titleizeStatus(pendingMutationReview.next)}
                  </strong>
                  . This transition can remove the conversation from active work
                  queues.
                </>
              ) : (
                <>
                  Server-recorded assignment:{" "}
                  <strong>
                    {pendingMutationReview.assignmentState ===
                      "tenant_active_user" &&
                    pendingMutationReview.assignedToUserId
                      ? `verified tenant user ${pendingMutationReview.assignedToUserId}`
                      : "historical assignment identity unverified"}
                  </strong>
                  . Confirming removes that assignment from the conversation.
                </>
              )}
            </p>
          </div>
          <ModalFooter>
            <div className="helpdesk-mutation-review-actions">
              <button
                ref={confirmationCancelRef}
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={confirmationBusy}
                onClick={cancelMutationReview}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={confirmationBusy}
                onClick={() => void confirmMutationReview()}
              >
                {confirmationBusy
                  ? "Applying…"
                  : pendingMutationReview.kind === "status"
                    ? "Confirm status change"
                    : "Confirm unassign"}
              </button>
            </div>
          </ModalFooter>
        </Modal>
      ) : null}

      <ActionBarHints
        actionHint={actionHint}
        actionHintId={actionHintId}
        assignHint={assignHint}
        assignHintId={assignHintId}
        statusHint={statusHint}
        statusHintId={statusHintId}
      />

      {mutationHold ? (
        <div className="helpdesk-note-hold" role="alert">
          <span>{mutationHold}</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={!online || assigning || statusBusy}
            onClick={() => void refreshHeldMutation()}
          >
            {statusBusy ? "Refreshing…" : "Refresh and review"}
          </button>
        </div>
      ) : null}

      {/* Internal-note composer. Customer delivery is deliberately absent. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <p id={replyPrivacyId} className="helpdesk-note-privacy-notice">
          It cannot currently be edited or deleted through Helpdesk, and its
          complete privacy lifecycle remains held. Delivery is not applicable
          and no customer channel is contacted.
        </p>
        <label className="sr-only" htmlFor={replyId}>
          Internal note
        </label>
        <textarea
          id={replyId}
          className="input"
          rows={3}
          placeholder={
            canAdmin
              ? "Add an internal note… (no customer delivery)"
              : "Internal notes need admin access."
          }
          value={body ?? ""}
          aria-invalid={Boolean(noteValidation && body.trim())}
          disabled={
            !canAdmin ||
            !online ||
            !id ||
            (noteRecoveryState !== "clear" &&
              noteRecoveryState !== "reviewing") ||
            sending
          }
          aria-describedby={`${replyHintId} ${replyPrivacyId}`}
          onChange={(e) => setBody(e.target.value)}
        />
        {noteRecoveryState !== "clear" ? (
          <div className="helpdesk-note-hold" role="status">
            <span>
              {noteRecoveryState === "loading"
                ? "Checking encrypted internal-note recovery…"
                : noteRecoveryState === "held"
                  ? "A prior internal-note outcome is unresolved. Automatic retry and replacement keys are blocked."
                  : noteRecoveryState === "legacy"
                    ? "A legacy recovery checkpoint lacks API-origin authority. It cannot be adopted or replayed; no note request can start."
                    : noteRecoveryState === "reviewing"
                      ? "Explicit reconciliation review: re-enter the exact prior body to reuse its encrypted key. A mismatch sends nothing."
                      : !noteRecoveryScope
                        ? "Adding an internal note requires a signed-in user session with a stable recovery principal. API-key sessions remain read and record-management only; no note request can start."
                        : "Encrypted internal-note recovery is unavailable or quarantined. No note request can start."}
            </span>
            {noteRecoveryState === "held" ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={!online || sending}
                onClick={beginExactReplayReview}
              >
                Review same-key replay
              </button>
            ) : noteRecoveryState === "reviewing" ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={sending}
                onClick={cancelExactReplayReview}
              >
                Cancel review
              </button>
            ) : null}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span className="muted" style={{ fontSize: 11 }}>
            <span id={replyHintId}>{replyHint}</span>
            <span className="helpdesk-byte-count">
              {noteBytes.toLocaleString()} /{" "}
              {INTERNAL_NOTE_MAX_BYTES.toLocaleString()} UTF-8 bytes
            </span>
          </span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={
              !canAdmin ||
              !online ||
              !id ||
              sending ||
              (noteRecoveryState !== "clear" &&
                noteRecoveryState !== "reviewing") ||
              Boolean(noteValidation)
            }
            aria-describedby={`${replyHintId} ${replyPrivacyId}`}
            onClick={() => void sendReply()}
          >
            {sending
              ? noteRecoveryState === "reviewing"
                ? "Reconciling…"
                : "Adding…"
              : noteRecoveryState === "reviewing"
                ? "Reconcile internal note"
                : "Add internal note"}
          </button>
        </div>
      </div>
    </div>
  );
}
