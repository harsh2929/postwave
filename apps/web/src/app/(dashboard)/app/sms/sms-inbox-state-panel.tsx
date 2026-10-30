// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { FormEvent, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Clock3, History, Tags, UserRound } from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import { ConversationNotesEditor } from "@/components/sms/ConversationNotesEditor";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  addSmsConversationTag,
  archiveSmsConversation,
  assignSmsConversation,
  bulkMutateSmsConversations,
  getSmsConversationActivity,
  listSmsConversationTags,
  removeSmsConversationTag,
  snoozeSmsConversation,
  unarchiveSmsConversation,
  unsnoozeSmsConversation,
} from "@/lib/sms-api";
import type {
  SmsConversationStateMutationReceipt,
  SmsConversationSummary,
} from "@/lib/sms-inbox-contract";

export interface SmsInboxAdminIdentity {
  tenantId: string;
  userId: string;
  effectiveRole: "owner" | "admin";
  viewerMode: false;
  fingerprint: string;
}

interface SharedProps {
  identity: SmsInboxAdminIdentity;
  online: string;
  assertCurrent: () => void;
  onRefreshRequired: () => void;
}

async function reauthorize(
  identity: SmsInboxAdminIdentity,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  const current = await whoami();
  const role = effectiveAuthRole(current);
  if (
    current.tenant_id !== identity.tenantId ||
    current.user_id !== identity.userId ||
    current.viewer_mode === true ||
    role !== identity.effectiveRole ||
    (role !== "owner" && role !== "admin")
  ) {
    throw new Error(
      "SMS inbox authorization changed. Reload before changing conversation state.",
    );
  }
  assertCurrent();
}

function mutationFailure(error: unknown): string {
  return `${apiErrorMessage(error, "The conversation change was not confirmed.")} Refresh the inbox before retrying; a timed-out request may already have committed.`;
}

export function SmsInboxStatePanel({
  conversation,
  identity,
  online,
  queryBase,
  assertCurrent,
  onStateChanged,
  onRefreshRequired,
}: SharedProps & {
  conversation: SmsConversationSummary;
  queryBase: readonly unknown[];
  onStateChanged: (receipt: SmsConversationStateMutationReceipt) => void;
}) {
  const queryClient = useQueryClient();
  const [activityOpen, setActivityOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const mutationRef = useRef(false);
  const phoneE164 = conversation.phoneE164;
  const tagsKey = [...queryBase, "tags"] as const;
  const activityKey = [...queryBase, "activity"] as const;

  const tagsQuery = useQuery({
    queryKey: tagsKey,
    enabled: online !== "offline",
    queryFn: async ({ signal }) => {
      assertCurrent();
      const result = await listSmsConversationTags({
        tenantId: identity.tenantId,
        phoneE164,
        signal,
      });
      assertCurrent();
      return result;
    },
  });
  const activityQuery = useQuery({
    queryKey: activityKey,
    enabled: activityOpen && online !== "offline",
    queryFn: async ({ signal }) => {
      assertCurrent();
      const result = await getSmsConversationActivity({
        tenantId: identity.tenantId,
        phoneE164,
        signal,
      });
      assertCurrent();
      return result;
    },
  });

  const runStateMutation = async (
    label: string,
    request: () => Promise<SmsConversationStateMutationReceipt>,
  ): Promise<void> => {
    if (mutationRef.current || online !== "online") return;
    mutationRef.current = true;
    setBusy(label);
    setError(null);
    setSuccess(null);
    try {
      await reauthorize(identity, assertCurrent);
      const receipt = await request();
      await reauthorize(identity, assertCurrent);
      onStateChanged(receipt);
      setSuccess(`${label} confirmed by the tenant-bound state receipt.`);
    } catch (caught) {
      setError(mutationFailure(caught));
      onRefreshRequired();
    } finally {
      mutationRef.current = false;
      setBusy(null);
    }
  };

  const runTagMutation = async (
    label: string,
    request: () => Promise<unknown>,
    onConfirmed?: () => void,
  ): Promise<void> => {
    if (mutationRef.current || online !== "online") return;
    mutationRef.current = true;
    setBusy(label);
    setError(null);
    setSuccess(null);
    try {
      await reauthorize(identity, assertCurrent);
      await request();
      await reauthorize(identity, assertCurrent);
      await queryClient.invalidateQueries({ queryKey: tagsKey, exact: true });
      onConfirmed?.();
      setSuccess(`${label} confirmed by the tenant-bound tag receipt.`);
    } catch (caught) {
      setError(mutationFailure(caught));
      void queryClient.invalidateQueries({ queryKey: tagsKey, exact: true });
    } finally {
      mutationRef.current = false;
      setBusy(null);
    }
  };

  const disabled = online !== "online" || busy !== null;
  const expectedUpdatedAt = conversation.stateUpdatedAt ?? null;
  const snooze = (hours: number) => {
    const until = new Date(Date.now() + hours * 60 * 60_000).toISOString();
    return runStateMutation(`Snooze ${hours}h`, () =>
      snoozeSmsConversation({
        tenantId: identity.tenantId,
        phoneE164,
        expectedUpdatedAt,
        until,
      }),
    );
  };

  const addTag = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const tag = tagDraft.trim();
    if (!tag || tagsQuery.data?.tags?.some((item) => item.tag === tag)) return;
    await runTagMutation(
      "Tag added",
      () =>
        addSmsConversationTag({
          tenantId: identity.tenantId,
          phoneE164,
          tag,
        }),
      () => setTagDraft(""),
    );
  };

  return (
    <section
      className="space-y-4 rounded-md border bg-muted/20 p-3"
      aria-labelledby="sms-conversation-controls-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id="sms-conversation-controls-title"
          className="text-sm font-semibold"
        >
          Conversation controls
        </h3>
        <div className="flex flex-wrap gap-2">
          {conversation.archivedAt ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11"
              disabled={disabled}
              onClick={() =>
                void runStateMutation("Restore", () =>
                  unarchiveSmsConversation({
                    tenantId: identity.tenantId,
                    phoneE164,
                    expectedUpdatedAt,
                  }),
                )
              }
            >
              <Archive className="mr-1.5 h-4 w-4" aria-hidden />
              {busy === "Restore" ? "Restoring…" : "Restore"}
            </Button>
          ) : conversation.snoozeUntil &&
            Date.parse(conversation.snoozeUntil) > Date.now() ? (
            <>
              <Badge variant="secondary">
                Snoozed until <RelativeTime iso={conversation.snoozeUntil} />
              </Badge>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11"
                disabled={disabled}
                onClick={() =>
                  void runStateMutation("Unsnooze", () =>
                    unsnoozeSmsConversation({
                      tenantId: identity.tenantId,
                      phoneE164,
                      expectedUpdatedAt,
                    }),
                  )
                }
              >
                <Clock3 className="mr-1.5 h-4 w-4" aria-hidden />
                {busy === "Unsnooze" ? "Unsnoozing…" : "Unsnooze"}
              </Button>
            </>
          ) : (
            <div className="flex flex-wrap gap-2" aria-label="Snooze presets">
              {[1, 4, 8, 24].map((hours) => (
                <Button
                  key={hours}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11"
                  disabled={disabled}
                  onClick={() => void snooze(hours)}
                >
                  Snooze {hours}h
                </Button>
              ))}
            </div>
          )}
          {!conversation.archivedAt ? (
            <ConfirmDialog
              trigger={
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="min-h-11"
                  disabled={disabled}
                >
                  <Archive className="mr-1.5 h-4 w-4" aria-hidden /> Archive
                </Button>
              }
              title={`Archive conversation with ${phoneE164}?`}
              description="This removes the thread from the active queue. Retained messages are not deleted."
              confirmLabel="Archive conversation"
              onConfirm={() =>
                runStateMutation("Archive", () =>
                  archiveSmsConversation({
                    tenantId: identity.tenantId,
                    phoneE164,
                    expectedUpdatedAt,
                  }),
                )
              }
            />
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-sm">
          {conversation.assigneeUserId === identity.userId
            ? "Assigned to you"
            : conversation.assigneeUserId
              ? "Assigned to another active workspace member"
              : "Unassigned"}
        </span>
        {conversation.assigneeUserId === identity.userId ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-11"
            disabled={disabled}
            onClick={() =>
              void runStateMutation("Unassign", () =>
                assignSmsConversation({
                  tenantId: identity.tenantId,
                  phoneE164,
                  expectedUpdatedAt,
                  assigneeUserId: null,
                }),
              )
            }
          >
            Unassign
          </Button>
        ) : conversation.assigneeUserId ? (
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11"
                disabled={disabled}
              >
                Take assignment
              </Button>
            }
            title="Take this conversation assignment?"
            description="This replaces the current assignee with your current workspace identity."
            confirmLabel="Assign to me"
            confirmVariant="default"
            onConfirm={() =>
              runStateMutation("Assign to me", () =>
                assignSmsConversation({
                  tenantId: identity.tenantId,
                  phoneE164,
                  expectedUpdatedAt,
                  assigneeUserId: identity.userId,
                }),
              )
            }
          />
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={disabled}
            onClick={() =>
              void runStateMutation("Assign to me", () =>
                assignSmsConversation({
                  tenantId: identity.tenantId,
                  phoneE164,
                  expectedUpdatedAt,
                  assigneeUserId: identity.userId,
                }),
              )
            }
          >
            Assign to me
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Tags className="h-4 w-4" aria-hidden /> Tags
        </div>
        {online === "offline" && !tagsQuery.data ? (
          <p className="text-sm text-muted-foreground" role="status">
            Reconnect to load the current tag inventory.
          </p>
        ) : tagsQuery.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading tags…
          </p>
        ) : tagsQuery.isError || !tagsQuery.data ? (
          <div className="flex flex-wrap items-center gap-2" role="alert">
            <span className="text-sm">Tags could not be verified.</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void tagsQuery.refetch()}
            >
              Retry tags
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {tagsQuery.data.tags.length === 0 ? (
                <span className="text-sm text-muted-foreground">No tags</span>
              ) : (
                tagsQuery.data.tags.map((item) => (
                  <Badge key={`${item.tag}:${item.createdAt}`} variant="outline">
                    <bdi dir="auto">{item.tag}</bdi>
                    <ConfirmDialog
                      trigger={
                        <button
                          type="button"
                          className="ml-1 min-h-11 min-w-11 rounded-sm"
                          aria-label={`Remove tag ${item.tag}`}
                          disabled={disabled || tagsQuery.data.truncated}
                        >
                          ×
                        </button>
                      }
                      title={`Remove tag “${item.tag}”?`}
                      description="This removes only the loaded tag version from this conversation."
                      confirmLabel="Remove tag"
                      onConfirm={() =>
                        runTagMutation("Tag removed", () =>
                          removeSmsConversationTag({
                            tenantId: identity.tenantId,
                            phoneE164,
                            tag: item.tag,
                            expectedCreatedAt: item.createdAt,
                          }),
                        )
                      }
                    />
                  </Badge>
                ))
              )}
            </div>
            <form
              className="flex max-w-md flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(event) => void addTag(event)}
            >
              <div className="flex-1 space-y-1">
                <Label htmlFor="sms-conversation-tag">Add tag</Label>
                <Input
                  id="sms-conversation-tag"
                  value={tagDraft}
                  maxLength={64}
                  disabled={disabled || tagsQuery.data.truncated}
                  onChange={(event) => setTagDraft(event.target.value)}
                />
              </div>
              <Button
                type="submit"
                className="min-h-11"
                disabled={
                  disabled ||
                  tagsQuery.data.truncated ||
                  !tagDraft.trim() ||
                  tagsQuery.data.tags.some(
                    (item) => item.tag === tagDraft.trim(),
                  )
                }
              >
                {busy === "Tag added" ? "Adding…" : "Add tag"}
              </Button>
            </form>
            {tagsQuery.data.truncated ? (
              <p className="text-xs text-warning" role="status">
                The tag inventory is truncated; writes are locked until the
                server can return a complete inventory.
              </p>
            ) : null}
          </>
        )}
      </div>

      <details
        open={activityOpen}
        onToggle={(event) => setActivityOpen(event.currentTarget.open)}
      >
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
          <History className="mr-2 inline h-4 w-4" aria-hidden /> Activity and
          consent evidence
        </summary>
        <div className="space-y-2 pl-1">
          {online === "offline" && !activityQuery.data ? (
            <p className="text-sm text-muted-foreground" role="status">
              Reconnect to load activity evidence.
            </p>
          ) : activityQuery.isPending ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading activity…
            </p>
          ) : activityQuery.isError || !activityQuery.data ? (
            <div className="flex flex-wrap items-center gap-2" role="alert">
              <span className="text-sm">Activity could not be verified.</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void activityQuery.refetch()}
              >
                Retry activity
              </Button>
            </div>
          ) : activityQuery.data.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No events in the loaded evidence sources.
            </p>
          ) : (
            <ol className="space-y-2">
              {activityQuery.data.events.map((event) => (
                <li
                  key={`${event.kind}:${event.at}:${"evidenceId" in event.meta ? event.meta.evidenceId : event.meta.listId}`}
                  className="rounded-md border bg-background p-2 text-sm"
                >
                  <Badge variant="secondary" className="mr-2">
                    {event.kind === "consent" ? "Consent" : "Subscription"}
                  </Badge>
                  <span>{event.title}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    <RelativeTime iso={event.at} />
                  </span>
                </li>
              ))}
            </ol>
          )}
          {activityQuery.data ? (
            <p className="text-xs text-muted-foreground">
              Loaded immutable consent events and current subscription state
              through <RelativeTime iso={activityQuery.data.snapshotAt} />.
              This is not complete suppression or operator-state history.
              {activityQuery.data.truncated
                ? " The server reports that this evidence window is truncated."
                : " The server did not report truncation within these sources."}
            </p>
          ) : null}
        </div>
      </details>

      <ConversationNotesEditor
        conversation={conversation}
        identity={identity}
        online={online}
        assertCurrent={assertCurrent}
        onStateChanged={onStateChanged}
        onRefreshRequired={onRefreshRequired}
      />
      {success ? (
        <p role="status" className="text-sm text-success">
          {success}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function SmsInboxBulkActions({
  conversations,
  status,
  identity,
  online,
  assertCurrent,
  onRefreshRequired,
  onComplete,
}: SharedProps & {
  conversations: SmsConversationSummary[];
  status: "active" | "snoozed" | "archived" | "any";
  onComplete: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  if (conversations.length === 0) return null;

  const run = async (
    action: "archive" | "unarchive" | "snooze" | "unsnooze",
  ) => {
    if (busyRef.current || online !== "online") return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const until =
      action === "snooze"
        ? new Date(Date.now() + 8 * 60 * 60_000).toISOString()
        : undefined;
    try {
      await reauthorize(identity, assertCurrent);
      await bulkMutateSmsConversations({
        tenantId: identity.tenantId,
        action,
        conversations: conversations.map((row) => ({
          phoneE164: row.phoneE164,
          expectedUpdatedAt: row.stateUpdatedAt ?? null,
        })),
        ...(until ? { until } : {}),
      });
      await reauthorize(identity, assertCurrent);
      onComplete();
    } catch (caught) {
      setError(mutationFailure(caught));
      onRefreshRequired();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const actions =
    status === "active"
      ? (["snooze", "archive"] as const)
      : status === "snoozed"
        ? (["unsnooze", "archive"] as const)
        : status === "archived"
          ? (["unarchive"] as const)
          : ([] as const);

  return (
    <div
      className="sticky bottom-2 z-10 space-y-2 rounded-md border bg-background p-3 shadow-lg"
      role="group"
      aria-label="Selected conversation actions"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">{conversations.length} selected</strong>
        {actions.map((action) => (
          <ConfirmDialog
            key={action}
            trigger={
              <Button
                type="button"
                size="sm"
                variant={action === "archive" ? "destructive" : "outline"}
                className="min-h-11"
                disabled={busy || online !== "online"}
              >
                {action === "snooze"
                  ? "Snooze 8h"
                  : action === "unsnooze"
                    ? "Unsnooze"
                    : action === "unarchive"
                      ? "Restore"
                      : "Archive"}
              </Button>
            }
            title={`${action === "unarchive" ? "Restore" : action} ${conversations.length} conversations?`}
            description="The server will apply this only if every selected lifecycle version is still current. One stale row cancels the entire batch."
            confirmLabel="Apply to selection"
            confirmVariant={action === "archive" ? "destructive" : "default"}
            onConfirm={() => run(action)}
          />
        ))}
        {status === "any" ? (
          <span className="text-xs text-muted-foreground">
            Choose a single lifecycle bucket before applying a bulk transition.
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
