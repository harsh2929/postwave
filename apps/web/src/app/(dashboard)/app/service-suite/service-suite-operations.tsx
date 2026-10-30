// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Inbox,
  MessageSquareText,
  RefreshCw,
  Search,
  Tags,
  TicketCheck,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  OperationsFailure,
  OperationsLoading,
  OperationsSection,
} from "@/components/operations/operations-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage, isApiError } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import {
  serviceSuiteIdentity,
  type ServiceSuiteIdentity,
} from "@/lib/service-suite-access";
import {
  HELPDESK_CHANNELS,
  HELPDESK_PRIORITIES,
  HELPDESK_STATUSES,
  archiveHelpdeskMacro,
  assignHelpdeskConversation,
  assignmentReasonValidationError,
  createHelpdeskInternalNote,
  getHelpdeskConversation,
  internalNoteValidationError,
  listHelpdeskConversations,
  listHelpdeskMacros,
  listHelpdeskMessages,
  listHelpdeskTickets,
  newInternalNoteKey,
  patchHelpdeskMacro,
  patchHelpdeskTicket,
  setHelpdeskConversationStatus,
  type HelpdeskConversation,
  type HelpdeskMacro,
  type HelpdeskMessage,
  type HelpdeskPageInfo,
  type HelpdeskPriority,
  type HelpdeskStatus,
  type HelpdeskTicket,
} from "@/lib/service-suite-operations-api";

const LIST_STALE_MS = 10_000;
const ALL = "__all__";
const MACRO_PICKER_PAGE_SIZE = 100;
const MACRO_PICKER_MAX_PAGES = 20;

/**
 * Every stored macro, or a refusal — never a partial list. A picker built from
 * one page would silently omit the macro an agent is looking for, so a
 * repeated record or cursor, or a library beyond the bound, fails the whole
 * load (desktop HelpdeskInbox applies the same rule).
 */
async function loadCompleteMacroLibrary(args: {
  tenantId: string;
  signal?: AbortSignal;
}): Promise<HelpdeskMacro[]> {
  const loaded: HelpdeskMacro[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < MACRO_PICKER_MAX_PAGES; pageNumber += 1) {
    const page = await listHelpdeskMacros({
      tenantId: args.tenantId,
      limit: MACRO_PICKER_PAGE_SIZE,
      cursor,
      signal: args.signal,
    });
    for (const macro of page.items) {
      if (ids.has(macro.id)) {
        throw new Error(
          "A macro page repeated a record. No partial macro list was offered.",
        );
      }
      ids.add(macro.id);
      loaded.push(macro);
    }
    const next = page.page.hasMore ? page.page.nextCursor : null;
    if (!next) return loaded.filter((macro) => macro.status === "active");
    if (cursors.has(next)) {
      throw new Error(
        "Macro pagination repeated a cursor. No partial macro list was offered.",
      );
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error(
    `The macro library exceeds the ${(
      MACRO_PICKER_PAGE_SIZE * MACRO_PICKER_MAX_PAGES
    ).toLocaleString()}-record picker bound. No partial macro list was offered.`,
  );
}

export function ServiceSuiteOperations({
  identity,
}: {
  identity: ServiceSuiteIdentity;
}) {
  const authorization = useQuery({
    queryKey: [...identity.queryBase, "helpdesk", "reauthorize"],
    queryFn: async () => {
      const me = await whoami();
      const fresh = serviceSuiteIdentity({
        me,
        origin: identity.origin,
        contextEpoch: identity.contextEpoch,
      });
      if (!fresh || fresh.fingerprint !== identity.fingerprint) {
        throw new Error(
          "The active tenant, administrator, role, origin, or security context changed.",
        );
      }
      return true;
    },
    staleTime: 0,
    refetchOnMount: "always",
  });

  if (authorization.isPending || authorization.isFetching) {
    return (
      <OperationsSection
        id="helpdesk-reauthorizing"
        title="Helpdesk operations"
        description="Reauthorizing the exact tenant administrator before requesting protected records."
      >
        <OperationsLoading label="Reauthorizing Helpdesk access" rows={3} />
      </OperationsSection>
    );
  }
  if (authorization.isError) {
    return (
      <OperationsSection
        id="helpdesk-reauthorization-failed"
        title="Helpdesk operations"
        description="No conversation, ticket, message, or macro record was requested."
      >
        <OperationsFailure
          title="Helpdesk access could not be reauthorized"
          description={apiErrorMessage(
            authorization.error,
            "Fresh exact-admin authority could not be established.",
          )}
          onRetry={() => void authorization.refetch()}
          retrying={authorization.isFetching}
        />
      </OperationsSection>
    );
  }

  return <AuthorizedHelpdeskOperations identity={identity} />;
}

function AuthorizedHelpdeskOperations({
  identity,
}: {
  identity: ServiceSuiteIdentity;
}) {
  return (
    <div className="space-y-5">
      <Alert variant="warning">
        <AlertTitle>Record-state operations only</AlertTitle>
        <AlertDescription>
          Customer and provider replies are release-held. This screen cannot
          send a reply, create a conversation or ticket, create a macro, or
          record macro usage. Internal notes are private workspace records and
          are never delivered to the customer.
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="conversations">
        <TabsList aria-label="Helpdesk operational queues">
          <TabsTrigger value="conversations">Conversations</TabsTrigger>
          <TabsTrigger value="tickets">Tickets</TabsTrigger>
          <TabsTrigger value="macros">Macros</TabsTrigger>
        </TabsList>
        <TabsContent value="conversations">
          <ConversationsPanel identity={identity} />
        </TabsContent>
        <TabsContent value="tickets">
          <TicketsPanel identity={identity} />
        </TabsContent>
        <TabsContent value="macros">
          <MacrosPanel identity={identity} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function useOnline(): boolean {
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);
  return online;
}

function useCursorWindow(resetKey: string) {
  const [history, setHistory] = useState<(string | null)[]>([null]);
  useEffect(() => setHistory([null]), [resetKey]);
  return {
    cursor: history.at(-1) ?? null,
    pageNumber: history.length,
    canPrevious: history.length > 1,
    previous: () => setHistory((current) => current.slice(0, -1)),
    next: (cursor: string) => setHistory((current) => [...current, cursor]),
    reset: () => setHistory([null]),
  };
}

const QUEUE_SEARCH_MAX = 128;

/** Local text match over the loaded page, like desktop's queue search. */
function conversationMatchesSearch(
  conversation: HelpdeskConversation,
  search: string,
): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    requesterLabel(conversation),
    conversation.subject,
    conversation.requesterEmail,
    conversation.requesterPhone,
    conversation.assignedTo,
    conversation.channelType,
    conversation.sourceType,
    conversation.status,
    conversation.priority,
    ...conversation.tags,
  ].some((value) => (value ?? "").toLocaleLowerCase().includes(needle));
}

function ConversationsPanel({ identity }: { identity: ServiceSuiteIdentity }) {
  const [status, setStatus] = useState<typeof ALL | HelpdeskStatus>(ALL);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const paging = useCursorWindow(status);
  const query = useQuery({
    queryKey: [
      ...identity.queryBase,
      "helpdesk",
      "conversations",
      status,
      paging.cursor,
    ],
    queryFn: ({ signal }) =>
      listHelpdeskConversations({
        tenantId: identity.tenantId,
        ...(status === ALL ? {} : { status }),
        cursor: paging.cursor,
        signal,
      }),
    staleTime: LIST_STALE_MS,
  });
  const searching = search.trim() !== "";
  const visibleConversations = useMemo(() => {
    const loaded = Array.isArray(query.data?.items) ? query.data.items : [];
    return loaded.filter((conversation) =>
      conversationMatchesSearch(conversation, search),
    );
  }, [query.data, search]);

  return (
    <OperationsSection
      id="helpdesk-conversations"
      title="Conversation queue"
      description="A tenant-bound, mutable server window. Refetch after acting because records may reorder between pages."
      aside={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
          loading={query.isFetching}
        >
          <RefreshCw aria-hidden /> Refresh
        </Button>
      }
    >
      <div className="mb-4 grid gap-4 sm:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div>
          <Label htmlFor="conversation-status-filter">Status</Label>
          <Select
            id="conversation-status-filter"
            className="mt-2"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as typeof ALL | HelpdeskStatus)
            }
          >
            <option value={ALL}>All statuses</option>
            {HELPDESK_STATUSES.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="conversation-queue-search">
            Search this loaded page
          </Label>
          <div className="mt-2 flex gap-2">
            <Input
              id="conversation-queue-search"
              type="search"
              value={search}
              maxLength={QUEUE_SEARCH_MAX}
              autoComplete="off"
              placeholder="Requester, subject, tag, status…"
              aria-describedby="conversation-queue-search-hint"
              onChange={(event) =>
                setSearch(event.target.value.slice(0, QUEUE_SEARCH_MAX))
              }
            />
            {searching ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setSearch("")}
              >
                Clear search
              </Button>
            ) : null}
          </div>
          <p
            id="conversation-queue-search-hint"
            className="mt-1 text-xs text-muted-foreground"
          >
            Filters only the records already loaded on this page. Nothing is
            sent to the server or kept in the address bar.
          </p>
        </div>
      </div>

      {query.isPending ? (
        <OperationsLoading label="Loading conversation queue" rows={5} />
      ) : query.isError || !query.data ? (
        <OperationsFailure
          title="Conversation queue could not be verified"
          description={apiErrorMessage(
            query.error,
            "The protected conversation window was not accepted.",
          )}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Verified empty conversation window"
          description={`The server returned no conversations for this exact status filter on page ${paging.pageNumber}.`}
        />
      ) : visibleConversations.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matching conversations on this page"
          description={`None of the ${query.data.items.length} loaded conversation(s) match “${search.trim()}”. Clear or change the local search; other pages are not searched.`}
        />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {visibleConversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                className="flex w-full flex-col gap-2 p-4 text-left transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
                onClick={() => setSelectedId(conversation.id)}
                aria-label={`Review conversation with ${requesterLabel(conversation)}`}
              >
                <span className="min-w-0">
                  <bdi className="block truncate font-medium" dir="auto">
                    {conversation.subject || requesterLabel(conversation)}
                  </bdi>
                  <bdi
                    className="mt-1 block truncate text-sm text-muted-foreground"
                    dir="auto"
                  >
                    {requesterLabel(conversation)} · {humanize(conversation.channelType)}
                  </bdi>
                </span>
                <span className="flex shrink-0 flex-wrap gap-2">
                  <Badge variant="outline">{humanize(conversation.status)}</Badge>
                  <Badge variant="secondary">{humanize(conversation.priority)}</Badge>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {query.data ? (
        <PageControls
          page={query.data.page}
          pageNumber={paging.pageNumber}
          canPrevious={paging.canPrevious}
          onPrevious={paging.previous}
          onNext={() => {
            if (query.data?.page.nextCursor) paging.next(query.data.page.nextCursor);
          }}
          loading={query.isFetching}
        />
      ) : null}

      <ConversationDialog
        key={selectedId ?? "closed"}
        identity={identity}
        conversationId={selectedId}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </OperationsSection>
  );
}

function ConversationDialog({
  identity,
  conversationId,
  onOpenChange,
}: {
  identity: ServiceSuiteIdentity;
  conversationId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const enabled = Boolean(conversationId);
  const queryClient = useQueryClient();
  const online = useOnline();
  const [messageCursor, setMessageCursor] = useState<(string | null)[]>([null]);
  const [ticketCursor, setTicketCursor] = useState<(string | null)[]>([null]);
  const [note, setNote] = useState("");
  const [noteIntent, setNoteIntent] = useState<{
    body: string;
    key: string;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [statusDraft, setStatusDraft] = useState<HelpdeskStatus>("open");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [macroPickerRequested, setMacroPickerRequested] = useState(false);

  // Loaded on first focus of the picker, not on dialog open: reviewing a
  // conversation should not read the whole macro library.
  const macroLibrary = useQuery({
    queryKey: [...identity.queryBase, "helpdesk", "macros", "complete-picker"],
    queryFn: ({ signal }) =>
      loadCompleteMacroLibrary({ tenantId: identity.tenantId, signal }),
    enabled: enabled && macroPickerRequested,
    staleTime: LIST_STALE_MS,
    retry: false,
  });
  const macroOptions = Array.isArray(macroLibrary.data) ? macroLibrary.data : [];
  const applyMacro = (macroId: string) => {
    const macro = macroOptions.find((item) => item.id === macroId);
    if (!macro) return;
    // Local insertion only. Macro usage evidence is release-held on the
    // server, so nothing is recorded about this use.
    setNote((previous) =>
      previous.trim() ? `${previous.replace(/\s+$/u, "")}\n\n${macro.body}` : macro.body,
    );
    setNoteIntent(null);
  };

  const detailKey = [
    ...identity.queryBase,
    "helpdesk",
    "conversation",
    conversationId,
  ] as const;
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) =>
      getHelpdeskConversation({
        tenantId: identity.tenantId,
        conversationId: conversationId as string,
        signal,
      }),
    enabled,
    staleTime: 0,
  });
  useEffect(() => {
    if (detail.data) setStatusDraft(detail.data.status);
  }, [detail.data]);

  const messages = useQuery({
    queryKey: [
      ...identity.queryBase,
      "helpdesk",
      "messages",
      conversationId,
      messageCursor.at(-1) ?? null,
    ],
    queryFn: ({ signal }) =>
      listHelpdeskMessages({
        tenantId: identity.tenantId,
        conversationId: conversationId as string,
        order: "desc",
        cursor: messageCursor.at(-1) ?? null,
        signal,
      }),
    enabled,
    staleTime: LIST_STALE_MS,
  });
  const linkedTickets = useQuery({
    queryKey: [
      ...identity.queryBase,
      "helpdesk",
      "linked-tickets",
      conversationId,
      ticketCursor.at(-1) ?? null,
    ],
    queryFn: ({ signal }) =>
      listHelpdeskTickets({
        tenantId: identity.tenantId,
        conversationId: conversationId as string,
        cursor: ticketCursor.at(-1) ?? null,
        signal,
      }),
    enabled,
    staleTime: LIST_STALE_MS,
  });

  const invalidateConversation = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: [...identity.queryBase, "helpdesk", "conversations"],
      }),
      queryClient.invalidateQueries({ queryKey: detailKey }),
    ]);
  };
  const statusMutation = useMutation({
    mutationFn: (conversation: HelpdeskConversation) =>
      setHelpdeskConversationStatus({
        tenantId: identity.tenantId,
        conversationId: conversation.id,
        version: conversation.version,
        status: statusDraft,
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(detailKey, next);
      setReceipt(`Status recorded as ${humanize(next.status)} at version ${next.version}.`);
      setActionError(null);
      void invalidateConversation();
    },
    onError: (error) => {
      setActionError(apiErrorMessage(error, "Status was not changed."));
      void queryClient.invalidateQueries({ queryKey: detailKey });
    },
  });
  const assignmentMutation = useMutation({
    mutationFn: ({
      conversation,
      action,
    }: {
      conversation: HelpdeskConversation;
      action: "assign_self" | "unassign";
    }) =>
      assignHelpdeskConversation({
        tenantId: identity.tenantId,
        conversationId: conversation.id,
        version: conversation.version,
        action,
        reason,
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(detailKey, next);
      setReceipt(
        `${next.assignmentState === "tenant_active_user" ? "Assigned to you" : "Unassigned"} at version ${next.version}.`,
      );
      setReason("");
      setActionError(null);
      void invalidateConversation();
    },
    onError: (error) => {
      setActionError(apiErrorMessage(error, "Assignment was not changed."));
      void queryClient.invalidateQueries({ queryKey: detailKey });
    },
  });
  const noteMutation = useMutation({
    mutationFn: async () => {
      const body = note.trim();
      const intent =
        noteIntent?.body === body
          ? noteIntent
          : { body, key: newInternalNoteKey() };
      setNoteIntent(intent);
      return createHelpdeskInternalNote({
        tenantId: identity.tenantId,
        conversationId: conversationId as string,
        bodyText: body,
        idempotencyKey: intent.key,
      });
    },
    onSuccess: (result) => {
      setReceipt(
        result.replayed
          ? `The original private-note receipt was replayed (${result.message.id}); no duplicate was created.`
          : `Private internal note recorded (${result.message.id}).`,
      );
      setNote("");
      setNoteIntent(null);
      setActionError(null);
      setMessageCursor([null]);
      void queryClient.invalidateQueries({
        queryKey: [...identity.queryBase, "helpdesk", "messages", conversationId],
      });
    },
    onError: (error) => {
      const message = apiErrorMessage(
        error,
        "The private note was not confirmed.",
      );
      setActionError(
        isApiError(error) && error.status === 410
          ? `${message} The original intent remains locked; do not create a replacement note with a new key.`
          : `${message} Retry without changing the text to reuse the same protected intent.`,
      );
    },
  });

  const conversation = detail.data;
  const noteError = internalNoteValidationError(note);
  const reasonError = assignmentReasonValidationError(reason);
  const writesPending =
    statusMutation.isPending || assignmentMutation.isPending || noteMutation.isPending;

  return (
    <Dialog open={enabled} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl" closeDisabled={writesPending}>
        <DialogHeader>
          <DialogTitle>Conversation review</DialogTitle>
          <DialogDescription>
            Exact tenant record, message projection, linked-ticket query, and
            version-protected administrative actions.
          </DialogDescription>
        </DialogHeader>

        {detail.isPending ? (
          <OperationsLoading label="Loading conversation detail" rows={4} />
        ) : detail.isError || !conversation ? (
          <OperationsFailure
            title="Conversation detail could not be verified"
            description={apiErrorMessage(detail.error)}
            onRetry={() => void detail.refetch()}
            retrying={detail.isFetching}
          />
        ) : (
          <div className="space-y-5">
            <div className="rounded-lg border p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <bdi className="block break-words font-medium" dir="auto">
                    {conversation.subject || "No recorded subject"}
                  </bdi>
                  <bdi className="mt-1 block break-words text-sm text-muted-foreground" dir="auto">
                    {requesterLabel(conversation)}
                  </bdi>
                </div>
                <span className="flex flex-wrap gap-2">
                  <Badge variant="outline">{humanize(conversation.status)}</Badge>
                  <Badge variant="secondary">{humanize(conversation.priority)}</Badge>
                </span>
              </div>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <Fact label="Channel" value={humanize(conversation.channelType)} />
                <Fact label="Assignment" value={humanize(conversation.assignmentState)} />
                <Fact label="Updated" value={formatTimestamp(conversation.updatedAt)} />
                <Fact label="Version" value={conversation.version} mono />
              </dl>
            </div>

            {!online ? (
              <Alert variant="warning" role="status">
                <AlertTitle>Offline — writes unavailable</AlertTitle>
                <AlertDescription>
                  Reads may show an already loaded window. No Helpdesk action is
                  queued for later replay.
                </AlertDescription>
              </Alert>
            ) : null}
            {actionError ? (
              <Alert variant="destructive">
                <AlertTitle>Action not confirmed</AlertTitle>
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            ) : null}
            {receipt ? (
              <Alert role="status">
                <AlertTitle>Server receipt</AlertTitle>
                <AlertDescription>{receipt}</AlertDescription>
              </Alert>
            ) : null}

            <section aria-labelledby="conversation-state-actions" className="rounded-lg border p-4">
              <h3 id="conversation-state-actions" className="font-medium">
                Record state
              </h3>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <div>
                  <Label htmlFor="conversation-status">Status</Label>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <Select
                      id="conversation-status"
                      value={statusDraft}
                      disabled={writesPending || !online}
                      onChange={(event) =>
                        setStatusDraft(event.target.value as HelpdeskStatus)
                      }
                    >
                      {HELPDESK_STATUSES.map((value) => (
                        <option key={value} value={value}>
                          {humanize(value)}
                        </option>
                      ))}
                    </Select>
                    <ConfirmDialog
                      trigger={
                        <Button
                          type="button"
                          disabled={
                            !online ||
                            writesPending ||
                            statusDraft === conversation.status
                          }
                        >
                          Change status
                        </Button>
                      }
                      title="Change conversation status?"
                      description={`Change this record from ${humanize(conversation.status)} to ${humanize(statusDraft)} using version ${conversation.version}?`}
                      confirmLabel="Record status"
                      confirmVariant="default"
                      onConfirm={async () => {
                        await statusMutation.mutateAsync(conversation);
                      }}
                    />
                  </div>
                </div>

                <div>
                  <Label htmlFor="assignment-reason">Assignment reason (optional)</Label>
                  <Input
                    id="assignment-reason"
                    className="mt-2"
                    value={reason}
                    disabled={writesPending || !online}
                    aria-invalid={Boolean(reasonError)}
                    aria-describedby={reasonError ? "assignment-reason-error" : undefined}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  {reasonError ? (
                    <p id="assignment-reason-error" className="mt-1 text-xs text-destructive">
                      {reasonError}
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <ConfirmDialog
                      trigger={
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            !online ||
                            writesPending ||
                            Boolean(reasonError) ||
                            conversation.assignmentState === "tenant_active_user"
                          }
                        >
                          Assign to me
                        </Button>
                      }
                      title="Assign this conversation to you?"
                      description="The server will re-check that your current human session is still an active tenant administrator at commit time."
                      confirmLabel="Assign to me"
                      confirmVariant="default"
                      onConfirm={async () => {
                        await assignmentMutation.mutateAsync({
                          conversation,
                          action: "assign_self",
                        });
                      }}
                    />
                    <ConfirmDialog
                      trigger={
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            !online ||
                            writesPending ||
                            Boolean(reasonError) ||
                            conversation.assignmentState === "unassigned"
                          }
                        >
                          Unassign
                        </Button>
                      }
                      title="Unassign this conversation?"
                      description="This changes only the tenant record. It does not notify or reply to the customer."
                      confirmLabel="Unassign"
                      onConfirm={async () => {
                        await assignmentMutation.mutateAsync({
                          conversation,
                          action: "unassign",
                        });
                      }}
                    />
                  </div>
                </div>
              </div>
            </section>

            <section aria-labelledby="private-note-heading" className="rounded-lg border p-4">
              <h3 id="private-note-heading" className="font-medium">
                Private internal note
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Saved to the workspace only. It is not a customer or provider reply.
              </p>
              <Label htmlFor="internal-note" className="sr-only">
                Private internal note
              </Label>
              <Textarea
                id="internal-note"
                className="mt-3"
                value={note}
                disabled={writesPending || !online}
                aria-invalid={Boolean(note && noteError)}
                aria-describedby="internal-note-help"
                onChange={(event) => {
                  setNote(event.target.value);
                  if (noteIntent && noteIntent.body !== event.target.value.trim()) {
                    setNoteIntent(null);
                  }
                }}
              />
              <div id="internal-note-help" className="mt-2 text-xs text-muted-foreground">
                {note ? noteError || "Ready for review. Maximum 16 KiB UTF-8." : "Maximum 16 KiB UTF-8. Unsafe controls and bidi overrides are rejected."}
              </div>
              <div className="mt-3 max-w-sm">
                <Label htmlFor="internal-note-macro">
                  Insert macro text into this note
                </Label>
                <Select
                  id="internal-note-macro"
                  className="mt-2"
                  value=""
                  disabled={
                    writesPending ||
                    !online ||
                    macroLibrary.isFetching ||
                    macroLibrary.isError
                  }
                  aria-describedby={
                    macroLibrary.isError ? "internal-note-macro-error" : "internal-note-macro-help"
                  }
                  onFocus={() => setMacroPickerRequested(true)}
                  onPointerDown={() => setMacroPickerRequested(true)}
                  onChange={(event) => applyMacro(event.target.value)}
                >
                  <option value="">
                    {!macroPickerRequested
                      ? "Choose a macro…"
                      : macroLibrary.isFetching
                        ? "Loading macros…"
                        : macroLibrary.isError
                          ? "Macro list unavailable"
                          : macroLibrary.data?.length === 0
                            ? "No active macros available"
                            : "Insert macro text…"}
                  </option>
                  {macroOptions.map((macro) => (
                    <option key={macro.id} value={macro.id}>
                      {macro.name}
                    </option>
                  ))}
                </Select>
                {macroLibrary.isError ? (
                  <div
                    id="internal-note-macro-error"
                    role="status"
                    className="mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive"
                  >
                    <span>
                      {apiErrorMessage(
                        macroLibrary.error,
                        "The macro library could not be verified.",
                      )}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!online}
                      loading={macroLibrary.isFetching}
                      onClick={() => void macroLibrary.refetch()}
                    >
                      Retry complete macro list
                    </Button>
                  </div>
                ) : (
                  <p id="internal-note-macro-help" className="mt-1 text-xs text-muted-foreground">
                    Appends the stored text for you to review. No macro usage is
                    recorded and nothing is sent.
                  </p>
                )}
              </div>
              <ConfirmDialog
                trigger={
                  <Button
                    type="button"
                    className="mt-3"
                    disabled={!online || writesPending || Boolean(noteError)}
                  >
                    Review and add private note
                  </Button>
                }
                title="Record this private internal note?"
                description="This creates a durable workspace record. It does not send anything to the customer. If the result is ambiguous, retry the unchanged text so the same idempotency intent is reused."
                confirmLabel="Add private note"
                confirmVariant="default"
                onConfirm={async () => {
                  await noteMutation.mutateAsync();
                }}
              />
            </section>

            <MessagesSection
              query={messages}
              history={messageCursor}
              setHistory={setMessageCursor}
            />
            <LinkedTicketsSection
              query={linkedTickets}
              history={ticketCursor}
              setHistory={setTicketCursor}
            />
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={writesPending}>
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MessagesSection({
  query,
  history,
  setHistory,
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof listHelpdeskMessages>>>>;
  history: (string | null)[];
  setHistory: React.Dispatch<React.SetStateAction<(string | null)[]>>;
}) {
  return (
    <section aria-labelledby="conversation-messages" className="rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 id="conversation-messages" className="font-medium">Messages</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Plain-text minimized projection; newest records first.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
          loading={query.isFetching}
        >
          <RefreshCw aria-hidden /> Refresh
        </Button>
      </div>
      {query.isPending ? (
        <div className="mt-4"><OperationsLoading label="Loading messages" rows={3} /></div>
      ) : query.isError || !query.data ? (
        <div className="mt-4">
          <OperationsFailure
            title="Messages could not be verified"
            description={apiErrorMessage(query.error)}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </div>
      ) : query.data.items.length === 0 ? (
        <EmptyState
          icon={MessageSquareText}
          className="py-8"
          title="Verified empty message window"
          description="The protected conversation query returned no message records for this page."
        />
      ) : (
        <ul className="mt-4 space-y-3">
          {query.data.items.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
        </ul>
      )}
      {query.data ? (
        <PageControls
          page={query.data.page}
          pageNumber={history.length}
          canPrevious={history.length > 1}
          onPrevious={() => setHistory((current) => current.slice(0, -1))}
          onNext={() => {
            if (query.data?.page.nextCursor) {
              setHistory((current) => [...current, query.data.page.nextCursor]);
            }
          }}
          loading={query.isFetching}
          navLabel="Message history pagination"
          previousLabel="Newer messages"
          nextLabel="Older messages"
        />
      ) : null}
    </section>
  );
}

function MessageRow({ message }: { message: HelpdeskMessage }) {
  const omitted = message.bodyOmittedReason
    ? `Body withheld: ${humanize(message.bodyOmittedReason)}.`
    : "No safe text body was returned.";
  return (
    <li
      className={`rounded-lg border p-3 ${
        message.direction === "internal" ? "border-amber-500/40 bg-amber-50/40" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={message.direction === "internal" ? "secondary" : "outline"}>
          {message.direction === "internal" ? "Private note" : humanize(message.direction)}
        </Badge>
        <span>{humanize(message.senderType)}</span>
        <span aria-hidden>·</span>
        <time dateTime={message.sentAt}>{formatTimestamp(message.sentAt)}</time>
      </div>
      {message.bodyText ? (
        <bdi
          dir="auto"
          className="mt-2 block whitespace-pre-wrap break-words text-sm leading-6"
        >
          {message.bodyText}
        </bdi>
      ) : (
        <p className="mt-2 text-sm italic text-muted-foreground">{omitted}</p>
      )}
      {message.direction === "outbound" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Historical outbound record · delivery unverified
        </p>
      ) : null}
    </li>
  );
}

function LinkedTicketsSection({
  query,
  history,
  setHistory,
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof listHelpdeskTickets>>>>;
  history: (string | null)[];
  setHistory: React.Dispatch<React.SetStateAction<(string | null)[]>>;
}) {
  return (
    <section aria-labelledby="linked-tickets" className="rounded-lg border p-4">
      <h3 id="linked-tickets" className="font-medium">Linked tickets</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Exact conversation-bound query; completeness applies only to this loaded page window.
      </p>
      {query.isPending ? (
        <div className="mt-4"><OperationsLoading label="Loading linked tickets" rows={2} /></div>
      ) : query.isError || !query.data ? (
        <div className="mt-4">
          <OperationsFailure
            title="Linked tickets could not be verified"
            description={apiErrorMessage(query.error)}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </div>
      ) : query.data.items.length === 0 ? (
        <EmptyState
          icon={TicketCheck}
          className="py-8"
          title="Verified empty linked-ticket window"
          description="No ticket in this exact server window is linked to the conversation."
        />
      ) : (
        <TicketList tickets={query.data.items} />
      )}
      {query.data ? (
        <PageControls
          page={query.data.page}
          pageNumber={history.length}
          canPrevious={history.length > 1}
          onPrevious={() => setHistory((current) => current.slice(0, -1))}
          onNext={() => {
            if (query.data?.page.nextCursor) {
              setHistory((current) => [...current, query.data.page.nextCursor]);
            }
          }}
          loading={query.isFetching}
        />
      ) : null}
    </section>
  );
}

function TicketsPanel({ identity }: { identity: ServiceSuiteIdentity }) {
  const [status, setStatus] = useState<typeof ALL | HelpdeskStatus>(ALL);
  const [editing, setEditing] = useState<HelpdeskTicket | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const paging = useCursorWindow(status);
  const query = useQuery({
    queryKey: [
      ...identity.queryBase,
      "helpdesk",
      "tickets",
      status,
      paging.cursor,
    ],
    queryFn: ({ signal }) =>
      listHelpdeskTickets({
        tenantId: identity.tenantId,
        ...(status === ALL ? {} : { status }),
        cursor: paging.cursor,
        signal,
      }),
    staleTime: LIST_STALE_MS,
  });

  return (
    <OperationsSection
      id="helpdesk-tickets"
      title="Ticket queue"
      description="Update existing ticket state with the exact version receipt. Ticket creation remains release-held."
      aside={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
          loading={query.isFetching}
        >
          <RefreshCw aria-hidden /> Refresh
        </Button>
      }
    >
      <div className="mb-4 max-w-xs">
        <Label htmlFor="ticket-status-filter">Status</Label>
        <Select
          id="ticket-status-filter"
          className="mt-2"
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof ALL | HelpdeskStatus)}
        >
          <option value={ALL}>All statuses</option>
          {HELPDESK_STATUSES.map((value) => (
            <option key={value} value={value}>{humanize(value)}</option>
          ))}
        </Select>
      </div>
      {receipt ? (
        <Alert role="status" className="mb-4">
          <AlertTitle>Server receipt</AlertTitle>
          <AlertDescription>{receipt}</AlertDescription>
        </Alert>
      ) : null}
      {query.isPending ? (
        <OperationsLoading label="Loading ticket queue" rows={5} />
      ) : query.isError || !query.data ? (
        <OperationsFailure
          title="Ticket queue could not be verified"
          description={apiErrorMessage(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          icon={TicketCheck}
          title="Verified empty ticket window"
          description={`The server returned no tickets for this exact status filter on page ${paging.pageNumber}.`}
        />
      ) : (
        <TicketList tickets={query.data.items} onEdit={setEditing} />
      )}
      {query.data ? (
        <PageControls
          page={query.data.page}
          pageNumber={paging.pageNumber}
          canPrevious={paging.canPrevious}
          onPrevious={paging.previous}
          onNext={() => {
            if (query.data?.page.nextCursor) paging.next(query.data.page.nextCursor);
          }}
          loading={query.isFetching}
        />
      ) : null}
      <TicketEditDialog
        key={editing?.id ?? "closed"}
        identity={identity}
        ticket={editing}
        onClose={() => setEditing(null)}
        onReceipt={(message) => {
          setReceipt(message);
          setEditing(null);
        }}
      />
    </OperationsSection>
  );
}

function TicketList({
  tickets,
  onEdit,
}: {
  tickets: HelpdeskTicket[];
  onEdit?: (ticket: HelpdeskTicket) => void;
}) {
  return (
    <ul className="mt-4 divide-y overflow-hidden rounded-lg border">
      {tickets.map((ticket) => (
        <li key={ticket.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <bdi className="block break-words font-medium" dir="auto">
              #{ticket.ticketNumber} · {ticket.title}
            </bdi>
            <p className="mt-1 text-sm text-muted-foreground">
              {humanize(ticket.status)} · {humanize(ticket.priority)} · due {formatTimestamp(ticket.dueAt, "not recorded")}
            </p>
          </div>
          {onEdit ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onEdit(ticket)}>
              Edit record
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TicketEditDialog({
  identity,
  ticket,
  onClose,
  onReceipt,
}: {
  identity: ServiceSuiteIdentity;
  ticket: HelpdeskTicket | null;
  onClose: () => void;
  onReceipt: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [status, setStatus] = useState<HelpdeskStatus>(ticket?.status ?? "open");
  const [priority, setPriority] = useState<HelpdeskPriority>(ticket?.priority ?? "normal");
  const [due, setDue] = useState(() => toLocalDateTime(ticket?.dueAt ?? null));
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!ticket) throw new Error("Ticket is unavailable.");
      const patch: Parameters<typeof patchHelpdeskTicket>[0]["patch"] = {};
      if (title.trim() !== ticket.title) patch.title = title.trim();
      if (status !== ticket.status) patch.status = status;
      if (priority !== ticket.priority) patch.priority = priority;
      const nextDue = fromLocalDateTime(due);
      if (nextDue !== ticket.dueAt) patch.dueAt = nextDue;
      return patchHelpdeskTicket({
        tenantId: identity.tenantId,
        ticketId: ticket.id,
        version: ticket.version,
        patch,
      });
    },
    onSuccess: (next) => {
      void queryClient.invalidateQueries({
        queryKey: [...identity.queryBase, "helpdesk", "tickets"],
      });
      void queryClient.invalidateQueries({
        queryKey: [...identity.queryBase, "helpdesk", "linked-tickets"],
      });
      onReceipt(`Ticket #${next.ticketNumber} updated at version ${next.version}.`);
    },
    onError: (cause) => {
      setError(apiErrorMessage(cause, "Ticket was not changed."));
      void queryClient.invalidateQueries({
        queryKey: [...identity.queryBase, "helpdesk", "tickets"],
      });
    },
  });
  const changed = Boolean(
    ticket &&
      (title.trim() !== ticket.title ||
        status !== ticket.status ||
        priority !== ticket.priority ||
        fromLocalDateTime(due) !== ticket.dueAt),
  );
  const titleError = !title.trim()
    ? "Title is required."
    : new TextEncoder().encode(title.trim()).byteLength > 500
      ? "Title must not exceed 500 UTF-8 bytes."
      : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!changed || titleError || !online || mutation.isPending) return;
    setError(null);
    mutation.mutate();
  }

  return (
    <Dialog open={Boolean(ticket)} onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent closeDisabled={mutation.isPending}>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Edit ticket record</DialogTitle>
            <DialogDescription>
              Review the complete patch before submitting it against version {ticket?.version}.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-5 space-y-4">
            {!online ? (
              <Alert variant="warning" role="status">
                <AlertTitle>Offline — update unavailable</AlertTitle>
                <AlertDescription>This versioned write will not be queued.</AlertDescription>
              </Alert>
            ) : null}
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Ticket update not confirmed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <div>
              <Label htmlFor="ticket-title">Title</Label>
              <Input
                id="ticket-title"
                className="mt-2"
                value={title}
                disabled={mutation.isPending}
                aria-invalid={Boolean(titleError)}
                aria-describedby={titleError ? "ticket-title-error" : undefined}
                onChange={(event) => setTitle(event.target.value)}
              />
              {titleError ? <p id="ticket-title-error" className="mt-1 text-xs text-destructive">{titleError}</p> : null}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="ticket-edit-status">Status</Label>
                <Select id="ticket-edit-status" className="mt-2" value={status} onChange={(event) => setStatus(event.target.value as HelpdeskStatus)}>
                  {HELPDESK_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
                </Select>
              </div>
              <div>
                <Label htmlFor="ticket-edit-priority">Priority</Label>
                <Select id="ticket-edit-priority" className="mt-2" value={priority} onChange={(event) => setPriority(event.target.value as HelpdeskPriority)}>
                  {HELPDESK_PRIORITIES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="ticket-due-at">Recorded due date (optional)</Label>
              <Input
                id="ticket-due-at"
                type="datetime-local"
                className="mt-2"
                value={due}
                onChange={(event) => setDue(event.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Empty clears the recorded due date. No service-level policy is inferred.
              </p>
            </div>
          </div>
          <DialogFooter className="mt-6">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={mutation.isPending}>Cancel</Button>
            </DialogClose>
            <Button type="submit" loading={mutation.isPending} disabled={!online || !changed || Boolean(titleError)}>
              Confirm ticket update
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MacrosPanel({ identity }: { identity: ServiceSuiteIdentity }) {
  const [editing, setEditing] = useState<HelpdeskMacro | null>(null);
  const [archiving, setArchiving] = useState<HelpdeskMacro | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const paging = useCursorWindow("macros");
  const queryClient = useQueryClient();
  const online = useOnline();
  const query = useQuery({
    queryKey: [...identity.queryBase, "helpdesk", "macros", paging.cursor],
    queryFn: ({ signal }) =>
      listHelpdeskMacros({
        tenantId: identity.tenantId,
        cursor: paging.cursor,
        signal,
      }),
    staleTime: LIST_STALE_MS,
  });
  const archiveMutation = useMutation({
    mutationFn: (macro: HelpdeskMacro) =>
      archiveHelpdeskMacro({
        tenantId: identity.tenantId,
        macroId: macro.id,
        version: macro.version,
      }),
    onSuccess: (result) => {
      setReceipt(`Macro archived at version ${result.version}. No usage or delivery was recorded.`);
      setArchiving(null);
      void queryClient.invalidateQueries({
        queryKey: [...identity.queryBase, "helpdesk", "macros"],
      });
    },
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: [...identity.queryBase, "helpdesk", "macros"],
      });
    },
  });

  return (
    <OperationsSection
      id="helpdesk-macros"
      title="Macro library"
      description="Review and update existing stored text. Creation and usage evidence remain release-held; editing a macro does not send or apply it."
      aside={
        <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()} loading={query.isFetching}>
          <RefreshCw aria-hidden /> Refresh
        </Button>
      }
    >
      {receipt ? (
        <Alert role="status" className="mb-4">
          <AlertTitle>Server receipt</AlertTitle>
          <AlertDescription>{receipt}</AlertDescription>
        </Alert>
      ) : null}
      {!online ? (
        <Alert variant="warning" role="status" className="mb-4">
          <AlertTitle>Offline — macro writes unavailable</AlertTitle>
          <AlertDescription>Versioned macro mutations are never queued.</AlertDescription>
        </Alert>
      ) : null}
      {query.isPending ? (
        <OperationsLoading label="Loading macros" rows={4} />
      ) : query.isError || !query.data ? (
        <OperationsFailure
          title="Macro library could not be verified"
          description={apiErrorMessage(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          icon={Tags}
          title="Verified empty macro window"
          description={`The server returned no existing macros on page ${paging.pageNumber}. Macro creation remains release-held.`}
        />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {query.data.items.map((macro) => (
            <li key={macro.id} className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <bdi className="break-words font-medium" dir="auto">{macro.name}</bdi>
                    <Badge variant="outline">{humanize(macro.status)}</Badge>
                  </div>
                  <bdi className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground" dir="auto">
                    {macro.body}
                  </bdi>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Historical use count {macro.useCount} · evidence unverified
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={!online} onClick={() => setEditing(macro)}>
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!online || macro.status === "archived"}
                    onClick={() => setArchiving(macro)}
                  >
                    <Archive aria-hidden /> Archive
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {query.data ? (
        <PageControls
          page={query.data.page}
          pageNumber={paging.pageNumber}
          canPrevious={paging.canPrevious}
          onPrevious={paging.previous}
          onNext={() => {
            if (query.data?.page.nextCursor) paging.next(query.data.page.nextCursor);
          }}
          loading={query.isFetching}
        />
      ) : null}

      <MacroEditDialog
        key={editing?.id ?? "closed"}
        identity={identity}
        macro={editing}
        onClose={() => setEditing(null)}
        onReceipt={(message) => {
          setReceipt(message);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={Boolean(archiving)}
        onOpenChange={(open) => !open && setArchiving(null)}
        title="Archive this macro?"
        description="Archiving is a version-protected record-state change. It does not send the macro or create usage evidence."
        confirmLabel="Archive macro"
        onConfirm={async () => {
          if (!archiving) throw new Error("Macro is unavailable.");
          await archiveMutation.mutateAsync(archiving);
        }}
      />
    </OperationsSection>
  );
}

function MacroEditDialog({
  identity,
  macro,
  onClose,
  onReceipt,
}: {
  identity: ServiceSuiteIdentity;
  macro: HelpdeskMacro | null;
  onClose: () => void;
  onReceipt: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const [name, setName] = useState(macro?.name ?? "");
  const [body, setBody] = useState(macro?.body ?? "");
  const [status, setStatus] = useState<"active" | "archived">(macro?.status ?? "active");
  const [channels, setChannels] = useState<string[]>(macro?.channelTypes ?? []);
  const [tags, setTags] = useState((macro?.tags ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);
  const channelLegendId = useId();
  const parsedTags = useMemo(
    () => tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    [tags],
  );
  const validation = macroValidation(name, body, parsedTags);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!macro) throw new Error("Macro is unavailable.");
      const patch: Parameters<typeof patchHelpdeskMacro>[0]["patch"] = {};
      if (name.trim() !== macro.name) patch.name = name.trim();
      if (body.trim() !== macro.body) patch.body = body.trim();
      if (status !== macro.status) patch.status = status;
      if (JSON.stringify(channels) !== JSON.stringify(macro.channelTypes)) {
        patch.channelTypes = channels as typeof macro.channelTypes;
      }
      if (JSON.stringify(parsedTags) !== JSON.stringify(macro.tags)) patch.tags = parsedTags;
      return patchHelpdeskMacro({
        tenantId: identity.tenantId,
        macroId: macro.id,
        version: macro.version,
        patch,
      });
    },
    onSuccess: (next) => {
      void queryClient.invalidateQueries({
        queryKey: [...identity.queryBase, "helpdesk", "macros"],
      });
      onReceipt(`Macro “${next.name}” updated at version ${next.version}. No usage or delivery was recorded.`);
    },
    onError: (cause) => {
      setError(apiErrorMessage(cause, "Macro was not changed."));
      void queryClient.invalidateQueries({
        queryKey: [...identity.queryBase, "helpdesk", "macros"],
      });
    },
  });
  const changed = Boolean(
    macro &&
      (name.trim() !== macro.name ||
        body.trim() !== macro.body ||
        status !== macro.status ||
        JSON.stringify(channels) !== JSON.stringify(macro.channelTypes) ||
        JSON.stringify(parsedTags) !== JSON.stringify(macro.tags)),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!changed || validation || !online || mutation.isPending) return;
    setError(null);
    mutation.mutate();
  }

  return (
    <Dialog open={Boolean(macro)} onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent closeDisabled={mutation.isPending}>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Edit stored macro</DialogTitle>
            <DialogDescription>
              This edits text and classification only. No reply, note, provider action, or usage evidence is created.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-5 space-y-4">
            {!online ? (
              <Alert variant="warning" role="status">
                <AlertTitle>Offline — update unavailable</AlertTitle>
                <AlertDescription>This versioned write will not be queued.</AlertDescription>
              </Alert>
            ) : null}
            {error || validation ? (
              <Alert variant="destructive">
                <AlertTitle>Macro cannot be updated</AlertTitle>
                <AlertDescription>{error || validation}</AlertDescription>
              </Alert>
            ) : null}
            <div>
              <Label htmlFor="macro-name">Name</Label>
              <Input id="macro-name" className="mt-2" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div>
              <Label htmlFor="macro-body">Stored text</Label>
              <Textarea id="macro-body" className="mt-2" value={body} onChange={(event) => setBody(event.target.value)} />
            </div>
            <div>
              <Label htmlFor="macro-status">Status</Label>
              <Select id="macro-status" className="mt-2" value={status} onChange={(event) => setStatus(event.target.value as "active" | "archived")}>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </Select>
            </div>
            <fieldset aria-labelledby={channelLegendId}>
              <legend id={channelLegendId} className="text-sm font-medium">Channel classifications</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {HELPDESK_CHANNELS.map((channel) => (
                  <Label key={channel} className="flex min-h-11 items-center gap-2 rounded-md border px-3 font-normal">
                    <Checkbox
                      checked={channels.includes(channel)}
                      onChange={(event) =>
                        setChannels((current) =>
                          event.currentTarget.checked
                            ? [...current, channel]
                            : current.filter((value) => value !== channel),
                        )
                      }
                    />
                    {humanize(channel)}
                  </Label>
                ))}
              </div>
            </fieldset>
            <div>
              <Label htmlFor="macro-tags">Tags (comma separated)</Label>
              <Input id="macro-tags" className="mt-2" value={tags} onChange={(event) => setTags(event.target.value)} />
            </div>
          </div>
          <DialogFooter className="mt-6">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={mutation.isPending}>Cancel</Button>
            </DialogClose>
            <Button type="submit" loading={mutation.isPending} disabled={!online || !changed || Boolean(validation)}>
              Confirm macro update
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PageControls({
  page,
  pageNumber,
  canPrevious,
  onPrevious,
  onNext,
  loading,
  navLabel = "Queue pagination",
  previousLabel = "Previous",
  nextLabel = "Next",
}: {
  page: HelpdeskPageInfo;
  pageNumber: number;
  canPrevious: boolean;
  onPrevious: () => void;
  onNext: () => void;
  loading: boolean;
  navLabel?: string;
  previousLabel?: string;
  nextLabel?: string;
}) {
  return (
    <nav className="mt-4 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between" aria-label={`${navLabel}, page ${pageNumber}`}>
      <p className="text-xs text-muted-foreground">
        Page {pageNumber} · verified {formatTimestamp(page.asOf)} · records may reorder
      </p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={!canPrevious || loading} onClick={onPrevious}>
          <ChevronLeft aria-hidden /> {previousLabel}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={!page.hasMore || !page.nextCursor || loading} onClick={onNext}>
          {nextLabel} <ChevronRight aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}

function requesterLabel(conversation: HelpdeskConversation): string {
  return (
    conversation.requesterName ||
    conversation.requesterEmail ||
    conversation.requesterPhone ||
    "Unknown requester"
  );
}

function formatTimestamp(value: string | null, fallback = "unknown"): string {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : fallback;
}

function toLocalDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromLocalDateTime(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().replace(".000Z", "Z").replace(/(\.\d*?[1-9])0+Z$/u, "$1Z");
}

function macroValidation(name: string, body: string, tags: string[]): string | null {
  const encoder = new TextEncoder();
  if (!name.trim()) return "Macro name is required.";
  if (encoder.encode(name.trim()).byteLength > 200) return "Macro name must not exceed 200 UTF-8 bytes.";
  if (!body.trim()) return "Macro text is required.";
  if (encoder.encode(body.trim()).byteLength > 16 * 1024) return "Macro text must not exceed 16 KiB UTF-8.";
  if (tags.length > 32) return "A macro may have at most 32 tags.";
  if (new Set(tags).size !== tags.length) return "Macro tags must be unique.";
  if (tags.some((tag) => encoder.encode(tag).byteLength > 100)) return "Each macro tag must not exceed 100 UTF-8 bytes.";
  return null;
}

function humanize(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
