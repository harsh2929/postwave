// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Deep-profile panels for the subscriber drill-down: canonical Lists & Tags
// (segment/group membership + tag add/remove), Notes, per-channel Consent,
// Audit/attribute history, prediction cards, and DSAR receipt downloads.
// Each panel owns its own query and is enabled only when its tab is active so
// the profile doesn't fan out every endpoint on load.

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  AtSign,
  Download,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage, isApiError } from "@/lib/api";
import { invalidateTagging } from "@/lib/audience-invalidation";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { base, qk, STALE, type RoleKey } from "@/lib/query-keys";
import { timeAgo, absoluteTime } from "@/lib/relative-time";
import {
  channelConsentWriteBlock,
  consentSourceLabel,
  CONSENT_CHANNEL_LABELS,
  CONSENT_CHANNELS,
} from "@/lib/subscriber-consent-api";
import {
  bulkTagSubscribers,
  bulkUntagSubscribers,
  type Subscriber,
} from "@/lib/subscribers-api";
import { downloadTextFile } from "@/lib/download";
import {
  buildNoteMentionCandidates,
  buildNoteMentionToken,
  createSubscriberNote,
  deleteSubscriberNote,
  displayNoteAttachmentFilename,
  editSubscriberNote,
  NOTE_ATTACHMENT_REMOVE_UNADDRESSABLE_REASON,
  NOTE_ATTACHMENT_UPLOAD_UNAVAILABLE_REASON,
  noteAttachmentDownloadUrl,
  noteAttachmentKeyAddressable,
  removeSubscriberNoteAttachment,
  SUBSCRIBER_NOTE_MAX_CHARS,
  getAttributeHistory,
  getChannelConsents,
  getCrossChannelTimeline,
  getErasureReceiptJson,
  getGroupMembership,
  getSegmentMembership,
  getSubscriberAudit,
  listSubscriberNotes,
  updateChannelConsent,
  updateSubscriberNote,
  type ChannelConsent,
  type ChannelConsentStatus,
  type ConsentChannel,
  type ConsentEvidenceInput,
  type NoteMentionCandidate,
  type SubscriberNote,
  type SubscriberNoteAttachment,
} from "@/lib/subscriber-profile-api";
import { listMembers } from "@/lib/team-members-api";
import {
  reauthorizeSubscriberMutation,
  subscriberAuthorityFromMe,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";

import { NoteMarkdown } from "./_note-markdown";

function PanelError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
    >
      {message}
    </div>
  );
}

function panelMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * The write gate for the two panels the page mounts without an `authority`
 * prop. It reads the same session the page does, through the one helper that
 * folds viewer_mode in with the effective role — a bare role check would leave
 * every control live for an owner in View-as-Viewer. `identityReady` separates
 * "this session may not write" from "the session has not loaded yet", so the
 * viewer explanation is never shown to someone who turns out to be an editor.
 */
function useSubscriberWriteAuthority(): {
  authority: SubscriberAuthority | null;
  identityReady: boolean;
  /** The key scope every subscriber read uses (page.tsx derives it the same way). */
  tenantId: string;
  role: RoleKey;
} {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  return {
    authority: meQuery.data ? subscriberAuthorityFromMe(meQuery.data) : null,
    identityReady: Boolean(meQuery.data),
    tenantId: meQuery.data?.tenant_id ?? "anon",
    role: meQuery.data ? effectiveAuthRole(meQuery.data) : null,
  };
}

/* ============================= Lists & Tags ============================== */

export function ListsTagsPanel({
  id,
  subscriber,
  enabled,
  onTagsChanged,
}: {
  id: string;
  subscriber: Subscriber | undefined;
  enabled: boolean;
  onTagsChanged: () => void;
}) {
  const [newTag, setNewTag] = useState("");
  const [busyTag, setBusyTag] = useState<string | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);
  const busyTagRef = useRef(false);
  const tagErrorRef = useRef<HTMLDivElement>(null);
  const { authority, identityReady, tenantId, role } =
    useSubscriberWriteAuthority();
  const queryClient = useQueryClient();
  const permissionReasonId = useId();
  // Only claim read-only once the session is known; before that the controls
  // are disabled but nothing is asserted about who the operator is.
  const writeBlocked = identityReady && authority === null;

  useEffect(() => {
    if (tagError) tagErrorRef.current?.focus();
  }, [tagError]);

  const membership = useQuery({
    // Under this subscriber's key, so a tag change (segments can be defined
    // by tags) reaches it with the timeline.
    queryKey: [...qk.subscriber(tenantId, role, id), "segment-membership"],
    queryFn: async () => {
      const [segments, groups] = await Promise.all([
        getSegmentMembership(id),
        getGroupMembership(id),
      ]);
      return { segments: segments.segments, groups: groups.groups };
    },
    enabled: enabled && identityReady,
    staleTime: 60_000,
  });
  // Pending covers the wait for the session too: until it resolves the read
  // cannot start, and "Not a member of any segment" would be a claim made
  // before anything was asked.
  const membershipLoading = enabled && membership.isPending;

  // The record refetch is the page's (onTagsChanged); everything else the
  // tag moved is refreshed here.
  const tagsChanged = () => {
    onTagsChanged();
    void invalidateTagging(queryClient, tenantId, role, { subscriberIds: [id] });
  };

  const tags = subscriber?.tags ?? [];

  const addTag = async (e: FormEvent) => {
    e.preventDefault();
    const tag = newTag.trim();
    if (!tag || !authority || busyTagRef.current) return;
    busyTagRef.current = true;
    setTagError(null);
    setBusyTag(tag);
    try {
      await bulkTagSubscribers([id], tag);
      setNewTag("");
      tagsChanged();
      toast.success(`Added tag "${tag}".`);
    } catch (err) {
      const message = panelMessage(err, "Could not add tag.");
      setTagError(message);
      toast.error(message);
    } finally {
      busyTagRef.current = false;
      setBusyTag(null);
    }
  };

  const removeTag = async (tag: string) => {
    if (!authority || busyTagRef.current) return;
    busyTagRef.current = true;
    setTagError(null);
    setBusyTag(tag);
    try {
      await bulkUntagSubscribers([id], tag);
      tagsChanged();
      toast.success(`Removed tag "${tag}".`);
    } catch (err) {
      const message = panelMessage(err, "Could not remove tag.");
      setTagError(message);
      toast.error(message);
    } finally {
      busyTagRef.current = false;
      setBusyTag(null);
    }
  };

  const memberSegments = Array.isArray(membership.data?.segments)
    ? membership.data.segments.filter((s) => s.is_member)
    : [];

  return (
    <div className="space-y-6">
      {/* Tags — editable from the web profile. */}
      <section aria-busy={busyTag !== null}>
        <h3 className="mb-2 text-sm font-medium">Tags</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.length === 0 ? (
            <span className="text-sm text-muted-foreground">No tags yet.</span>
          ) : (
            tags.map((tag) => (
              <span
                key={tag}
                data-testid="subscriber-chip"
                className="inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-0.5 text-xs"
              >
                {tag}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  disabled={!authority || busyTag !== null}
                  aria-describedby={
                    writeBlocked ? permissionReasonId : undefined
                  }
                  onClick={() => void removeTag(tag)}
                  className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))
          )}
        </div>
        <form className="mt-3 flex max-w-sm gap-2" onSubmit={addTag}>
          <Input
            value={newTag}
            disabled={!authority || busyTag !== null}
            onChange={(e) => {
              setNewTag(e.target.value);
              if (tagError) setTagError(null);
            }}
            placeholder="Add a tag"
            aria-label="Add a tag"
            aria-describedby={
              writeBlocked ? permissionReasonId : undefined
            }
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!authority || !newTag.trim() || busyTag !== null}
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </form>
        {writeBlocked ? (
          <p
            id={permissionReasonId}
            role="status"
            className="mt-2 text-xs text-muted-foreground"
          >
            Viewer access can inspect tags but cannot add or remove them.
          </p>
        ) : null}
        {tagError ? (
          <div
            ref={tagErrorRef}
            tabIndex={-1}
            role="alert"
            className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
          >
            {tagError}
          </div>
        ) : null}
      </section>

      {/* Canonical segment membership. */}
      <section>
        <h3 className="mb-2 text-sm font-medium">Segments</h3>
        {membershipLoading ? (
          <Skeleton className="h-5 w-40" />
        ) : membership.error ? (
          <PanelError
            message={panelMessage(membership.error, "Could not load segments.")}
          />
        ) : memberSegments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Not a member of any segment.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {memberSegments.map((s) => (
              <Badge
                key={s.segment_id}
                data-testid="subscriber-chip"
                variant="secondary"
              >
                {s.segment_name}
              </Badge>
            ))}
          </div>
        )}
      </section>

      {/* Canonical group/interest membership. */}
      <section>
        <h3 className="mb-2 text-sm font-medium">Groups</h3>
        {membershipLoading ? (
          <Skeleton className="h-5 w-40" />
        ) : membership.error ? (
          // One query fetches segments and groups together, so a 500 from
          // either endpoint leaves `data` undefined. Without this branch the
          // failure reads as "this contact belongs to no group" — a claim
          // somebody excludes them from a group-targeted send on.
          <PanelError
            message={panelMessage(membership.error, "Could not load groups.")}
          />
        ) : (membership.data?.groups?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No group memberships.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {membership.data?.groups?.map((g) => (
              <Badge
                key={g.group_id}
                data-testid="subscriber-chip"
                variant="outline"
              >
                {g.category ? `${g.category}: ` : ""}
                {g.name}
              </Badge>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ================================= Notes ================================= */

export function NotesPanel({
  id,
  enabled,
  tenantId = "anon",
  role = null,
}: {
  id: string;
  enabled: boolean;
  tenantId?: string;
  role?: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [pinned, setPinned] = useState(false);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyNoteId, setBusyNoteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<SubscriberNote | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteMutationRef = useRef(false);
  const noteErrorRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const { authority, identityReady } = useSubscriberWriteAuthority();
  const permissionReasonId = useId();
  const uploadReasonId = useId();
  const composeHintId = useId();
  // The notes routes are mounted under the admin scope server-side (a session
  // needs owner/admin), so an editor would only ever get a 403 from them —
  // the same gate desktop applies (canMutate && canAdmin).
  const canEditNotes =
    authority?.role === "owner" || authority?.role === "admin";
  // Only claim read-only once the session is known; before that the controls
  // are disabled but nothing is asserted about who the operator is.
  const writeBlocked = identityReady && !canEditNotes;

  useEffect(() => {
    if (noteError) noteErrorRef.current?.focus();
  }, [noteError]);

  const notesQuery = useQuery({
    queryKey: [...base("subscriber-notes", tenantId, role), id],
    queryFn: () => listSubscriberNotes(id),
    enabled,
    staleTime: 30_000,
  });
  // The roster is admin-only too, and only needed to offer @-mentions.
  const rosterQuery = useQuery({
    queryKey: base("workspace-members", tenantId, role),
    queryFn: ({ signal }) => listMembers({ signal }),
    enabled: enabled && canEditNotes,
    staleTime: 5 * 60_000,
  });
  const notes = Array.isArray(notesQuery.data?.notes)
    ? notesQuery.data.notes
    : [];
  const roster = Array.isArray(rosterQuery.data?.members)
    ? rosterQuery.data.members.filter((member) => member.status === "active")
    : [];
  const mentionCandidates = buildNoteMentionCandidates(notes, roster);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || !canEditNotes || saving) return;
    if (body.length > SUBSCRIBER_NOTE_MAX_CHARS) {
      setNoteError("Notes are capped at 20,000 characters.");
      return;
    }
    setSaving(true);
    setNoteError(null);
    try {
      await createSubscriberNote(id, { markdown_body: body, pinned });
      setDraft("");
      setPinned(false);
      setPreview(false);
      await notesQuery.refetch();
      toast.success("Note added.");
    } catch (err) {
      const message = isApiError(err)
        ? apiErrorMessage(err, "Could not add note.")
        : panelMessage(err, "Could not add note.");
      setNoteError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const togglePin = async (noteId: string, next: boolean) => {
    if (!canEditNotes || noteMutationRef.current) return;
    noteMutationRef.current = true;
    setBusyNoteId(noteId);
    setNoteError(null);
    try {
      await updateSubscriberNote(id, noteId, { pinned: next });
      await notesQuery.refetch();
    } catch (err) {
      const message = panelMessage(err, "Could not update note.");
      setNoteError(message);
      toast.error(message);
    } finally {
      noteMutationRef.current = false;
      setBusyNoteId(null);
    }
  };

  const remove = async (noteId: string) => {
    if (!canEditNotes) {
      throw new Error("Notes need an owner or admin role.");
    }
    try {
      await deleteSubscriberNote(id, noteId);
      await notesQuery.refetch();
      toast.success("Note deleted.");
    } catch (err) {
      const message = panelMessage(err, "Could not delete note.");
      toast.error(message);
      throw err instanceof Error ? err : new Error(message);
    }
  };

  const removeAttachment = async (
    noteId: string,
    attachment: SubscriberNoteAttachment,
  ) => {
    if (!canEditNotes) {
      throw new Error("Notes need an owner or admin role.");
    }
    await removeSubscriberNoteAttachment(id, noteId, attachment.file_key);
    await notesQuery.refetch();
    toast.success(
      `Removed ${displayNoteAttachmentFilename(attachment.filename)}.`,
    );
  };

  const insertMention = (candidateId: string) => {
    const candidate = mentionCandidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    const token = `${buildNoteMentionToken(candidate)} `;
    const area = draftRef.current;
    const start = area?.selectionStart ?? draft.length;
    const end = area?.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + token + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      const caret = start + token.length;
      draftRef.current?.focus();
      draftRef.current?.setSelectionRange(caret, caret);
    });
  };

  const readOnlyReason = !authority
    ? "Viewer access can read notes but cannot add, edit, pin, or delete them."
    : "Notes need an owner or admin role; this session can read them but cannot add, edit, pin, or delete them.";

  return (
    <div className="space-y-4">
      <form className="space-y-2" onSubmit={submit}>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={preview ? "ghost" : "secondary"}
            size="sm"
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
          >
            Write
          </Button>
          <Button
            type="button"
            variant={preview ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={preview}
            disabled={!draft.trim()}
            onClick={() => setPreview(true)}
          >
            Preview
          </Button>
          <MentionPicker
            candidates={mentionCandidates}
            disabled={!canEditNotes || saving || preview}
            describedBy={writeBlocked ? permissionReasonId : undefined}
            onPick={insertMention}
          />
        </div>
        {preview ? (
          <div
            data-testid="note-preview"
            className="min-h-24 rounded-md border bg-muted/30 px-3 py-2"
          >
            <NoteMarkdown source={draft} />
          </div>
        ) : (
          <textarea
            ref={draftRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={SUBSCRIBER_NOTE_MAX_CHARS}
            disabled={!canEditNotes || saving}
            aria-describedby={
              writeBlocked ? `${composeHintId} ${permissionReasonId}` : composeHintId
            }
            placeholder="Add an internal note. Markdown is supported."
            aria-label="New note"
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50"
          />
        )}
        <p id={composeHintId} className="text-xs text-muted-foreground">
          {draft.length.toLocaleString()}/20,000 · Notes are internal; subscribers
          never see them. Mentioned teammates are recorded on the note.
        </p>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground sm:min-h-9">
            <input
              type="checkbox"
              checked={pinned}
              disabled={!canEditNotes}
              onChange={(e) => setPinned(e.target.checked)}
              className="h-4 w-4 rounded border-input accent-primary"
            />
            Pin this note
          </label>
          <Button
            type="submit"
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={!canEditNotes || saving || !draft.trim()}
          >
            {saving ? "Saving…" : "Add note"}
          </Button>
        </div>
        {writeBlocked ? (
          <p
            id={permissionReasonId}
            role="status"
            className="text-xs text-muted-foreground"
          >
            {readOnlyReason}
          </p>
        ) : null}
      </form>

      {notesQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : notesQuery.isError ? (
        <PanelError
          message={
            isApiError(notesQuery.error)
              ? apiErrorMessage(notesQuery.error, "Could not load notes.")
              : panelMessage(notesQuery.error, "Could not load notes.")
          }
        />
      ) : notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((note) => {
            const attachments = Array.isArray(note.attachments)
              ? note.attachments
              : [];
            const author =
              note.author_email || note.author_user_id || "unknown author";
            return (
              <li
                key={note.id}
                className="rounded-md border bg-card p-3 text-sm shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <NoteMarkdown source={note.markdown_body || note.body} />
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${note.pinned ? "Unpin" : "Pin"} note from ${author}`}
                      title={note.pinned ? "Unpin" : "Pin"}
                      disabled={!canEditNotes || busyNoteId !== null}
                      aria-describedby={
                        writeBlocked ? permissionReasonId : undefined
                      }
                      onClick={() => void togglePin(note.id, !note.pinned)}
                    >
                      {note.pinned ? (
                        <PinOff className="h-4 w-4" />
                      ) : (
                        <Pin className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit note from ${author}`}
                      title="Edit"
                      disabled={!canEditNotes || busyNoteId !== null}
                      aria-describedby={
                        writeBlocked ? permissionReasonId : undefined
                      }
                      onClick={() => setEditing(note)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <NoteDeleteButton
                      disabled={!canEditNotes || busyNoteId !== null}
                      onDelete={() => remove(note.id)}
                    />
                  </div>
                </div>
                {attachments.length > 0 ? (
                  <ul
                    aria-label="Attachments"
                    className="mt-2 flex flex-wrap gap-2"
                  >
                    {attachments.map((attachment) => (
                      <NoteAttachmentChip
                        key={attachment.id}
                        attachment={attachment}
                        canEdit={canEditNotes}
                        permissionReasonId={
                          writeBlocked ? permissionReasonId : undefined
                        }
                        onRemove={() => removeAttachment(note.id, attachment)}
                      />
                    ))}
                  </ul>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {note.pinned ? <Badge variant="outline">Pinned</Badge> : null}
                  {note.author_email ? <span>{note.author_email}</span> : null}
                  <span title={absoluteTime(note.created_at)}>
                    {timeAgo(note.created_at)}
                  </span>
                  {Array.isArray(note.mentions) && note.mentions.length > 0 ? (
                    <span>
                      · mentions{" "}
                      {note.mentions.map((m) => m.display).join(", ")}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          aria-describedby={uploadReasonId}
        >
          <Paperclip className="h-4 w-4" />
          Attach file · Unavailable
        </Button>
        <p id={uploadReasonId} className="text-xs text-muted-foreground">
          {NOTE_ATTACHMENT_UPLOAD_UNAVAILABLE_REASON}
        </p>
      </div>
      {noteError ? (
        <div
          ref={noteErrorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
        >
          {noteError}
        </div>
      ) : null}
      <NoteEditDialog
        subscriberId={id}
        note={editing}
        candidates={mentionCandidates}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={async () => {
          setEditing(null);
          await notesQuery.refetch();
          toast.success("Note updated.");
        }}
      />
    </div>
  );
}

function MentionPicker({
  candidates,
  disabled,
  describedBy,
  onPick,
}: {
  candidates: NoteMentionCandidate[];
  disabled: boolean;
  describedBy?: string;
  onPick: (candidateId: string) => void;
}) {
  const pickerId = useId();
  return (
    <div className="flex items-center gap-1.5">
      <AtSign aria-hidden className="h-4 w-4 text-muted-foreground" />
      <label htmlFor={pickerId} className="sr-only">
        Mention a teammate
      </label>
      <Select
        id={pickerId}
        className="h-8 w-48"
        value=""
        disabled={disabled || candidates.length === 0}
        aria-describedby={describedBy}
        onChange={(event) => {
          if (event.target.value) onPick(event.target.value);
        }}
      >
        <option value="">
          {candidates.length === 0 ? "No teammates to mention" : "Mention…"}
        </option>
        {candidates.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.display}
          </option>
        ))}
      </Select>
    </div>
  );
}

function formatAttachmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function NoteAttachmentChip({
  attachment,
  canEdit,
  permissionReasonId,
  onRemove,
}: {
  attachment: SubscriberNoteAttachment;
  canEdit: boolean;
  permissionReasonId?: string;
  onRemove: () => Promise<void>;
}) {
  const filename = displayNoteAttachmentFilename(attachment.filename);
  const downloadUrl = noteAttachmentDownloadUrl(attachment);
  const addressable = noteAttachmentKeyAddressable(attachment.file_key);
  const unaddressableId = useId();
  return (
    <li className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-xs">
      {downloadUrl ? (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          download={filename}
          className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
          aria-label={`Download ${filename}`}
        >
          <Download aria-hidden className="h-3 w-3" />
          {filename}
        </a>
      ) : (
        <span>
          {filename}{" "}
          <span className="text-muted-foreground">(download unavailable)</span>
        </span>
      )}
      <span className="text-muted-foreground">
        {formatAttachmentBytes(attachment.size_bytes)}
      </span>
      {canEdit && addressable ? (
        <ConfirmDialog
          title={`Remove ${filename}?`}
          description={`This permanently deletes ${filename} from this note and from file storage. It cannot be restored, and new attachments can't be uploaded to replace it yet.`}
          confirmLabel="Remove attachment"
          onConfirm={onRemove}
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={`Remove ${filename}`}
            >
              <X className="h-3 w-3" />
            </Button>
          }
        />
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            disabled
            aria-label={`Remove ${filename}`}
            aria-describedby={
              !canEdit ? permissionReasonId : unaddressableId
            }
          >
            <X className="h-3 w-3" />
          </Button>
          {canEdit ? (
            <span id={unaddressableId} className="text-muted-foreground">
              {NOTE_ATTACHMENT_REMOVE_UNADDRESSABLE_REASON}
            </span>
          ) : null}
        </>
      )}
    </li>
  );
}

function NoteEditDialog({
  subscriberId,
  note,
  candidates,
  onOpenChange,
  onSaved,
}: {
  subscriberId: string;
  note: SubscriberNote | null;
  candidates: NoteMentionCandidate[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();

  useEffect(() => {
    if (!note) return;
    setValue(note.markdown_body || note.body);
    setError(null);
  }, [note]);

  const original = note ? note.markdown_body || note.body : "";
  const changed = value.trim() !== original.trim();

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!note || pendingRef.current || !value.trim() || !changed) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await editSubscriberNote(subscriberId, note.id, value);
      await onSaved();
    } catch (err) {
      setError(
        isApiError(err)
          ? apiErrorMessage(err, "Could not update the note.")
          : panelMessage(err, "Could not update the note."),
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const insertMention = (candidateId: string) => {
    const candidate = candidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    const token = `${buildNoteMentionToken(candidate)} `;
    const area = areaRef.current;
    const start = area?.selectionStart ?? value.length;
    const end = area?.selectionEnd ?? value.length;
    setValue(value.slice(0, start) + token + value.slice(end));
  };

  return (
    <Dialog
      open={note !== null}
      onOpenChange={(next) => {
        if (!next && pendingRef.current) return;
        onOpenChange(next);
      }}
    >
      <DialogContent aria-busy={pending} className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit note</DialogTitle>
          <DialogDescription>
            Saving replaces this note&apos;s text for everyone on the team.
            Mentions are re-read from the new text.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={save}>
          <div className="grid gap-1.5">
            <Label htmlFor={fieldId}>Note text</Label>
            <Textarea
              ref={areaRef}
              id={fieldId}
              rows={6}
              value={value}
              maxLength={SUBSCRIBER_NOTE_MAX_CHARS}
              disabled={pending}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <MentionPicker
            candidates={candidates}
            disabled={pending}
            onPick={insertMention}
          />
          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
            >
              {error}
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={pending || !value.trim() || !changed}
            >
              {pending ? "Saving…" : "Save note"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NoteDeleteButton({
  disabled,
  onDelete,
}: {
  disabled: boolean;
  onDelete: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const confirm = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await onDelete();
      setOpen(false);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Could not delete note.",
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pendingRef.current) return;
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Delete note"
          title="Delete"
          disabled={disabled}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-busy={pending}
        onEscapeKeyDown={(event) => {
          if (pendingRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pendingRef.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Delete note?</DialogTitle>
          <DialogDescription>
            This permanently removes the note.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
          >
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================ Channel consent =========================== */

/** Desktop's status vocabulary: a decision, not the storage token. */
const CONSENT_STATUS_LABELS: Record<ChannelConsentStatus, string> = {
  opted_in: "Granted",
  opted_out: "Revoked",
  pending: "Pending",
  unknown: "Unknown",
};

interface ChannelConsentReview {
  channel: ConsentChannel;
  nextStatus: ConsentEvidenceInput["status"];
}

function consentBadgeVariant(status: ChannelConsentStatus) {
  if (status === "opted_in") return "success" as const;
  if (status === "opted_out") return "destructive" as const;
  return "secondary" as const;
}

export function ConsentPanel({
  id,
  enabled,
  tenantId,
  role,
  authority,
  country,
  onAggregateChanged,
}: {
  id: string;
  enabled: boolean;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
  country?: string | null;
  onAggregateChanged: () => void | Promise<void>;
}) {
  const consentsQuery = useQuery({
    queryKey: ["subscriber-consents", tenantId, role ?? "viewer", id],
    queryFn: ({ signal }) => getChannelConsents(id, signal),
    enabled,
    staleTime: 30_000,
  });
  const permissionReasonId = useId();
  const readOnlyPrefix = useId();
  const [saving, setSaving] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<ChannelConsentReview | null>(
    null,
  );
  const [mutationError, setMutationError] = useState<string | null>(null);
  const mutationRef = useRef(false);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    mutationRef.current = false;
    setSaving(null);
    setReviewing(null);
    setMutationError(null);
  }, [id, authority?.tenantId, authority?.userId, authority?.role]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (mutationError) errorRef.current?.focus();
  }, [mutationError]);

  const setStatus = async (
    channel: ConsentChannel,
    input: ConsentEvidenceInput,
  ): Promise<string | null> => {
    if (
      !authority ||
      mutationRef.current ||
      !consentsQuery.data?.subscriber_version
    ) {
      return "Reload this subscriber before changing consent so the latest revision can be verified.";
    }
    mutationRef.current = true;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setSaving(channel);
    setMutationError(null);
    let committed = false;
    try {
      await reauthorizeSubscriberMutation(authority);
      await updateChannelConsent(
        id,
        channel,
        input,
        consentsQuery.data.subscriber_version,
        {
          idempotencyKey: `subscriber-consent:${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`,
          signal: controller.signal,
        },
      );
      committed = true;
      await reauthorizeSubscriberMutation(authority);
      if (generation !== generationRef.current) return null;
      await consentsQuery.refetch();
      await onAggregateChanged();
      toast.success(
        input.status === "opted_in"
          ? `${CONSENT_CHANNEL_LABELS[channel]} consent granted.`
          : `${CONSENT_CHANNEL_LABELS[channel]} consent revoked.`,
      );
      return null;
    } catch (err) {
      if (generation !== generationRef.current) return null;
      const stale =
        isApiError(err) && [409, 412, 428].includes(Number(err.status));
      // A server refusal (protected suppression, concurrent decision,
      // consent sync unavailable, …) renders the server's own sentence.
      const message = committed
        ? "Consent saved, but workspace access changed afterward. The profile was reloaded."
        : stale
          ? "Consent changed while you were reviewing it. Reload the latest evidence before trying again."
          : isApiError(err)
            ? apiErrorMessage(err)
            : err instanceof Error && err.message.trim()
              ? err.message
              : "Consent could not be confirmed. No new eligibility is shown.";
      setMutationError(message);
      if (committed) {
        await consentsQuery.refetch();
        await onAggregateChanged();
        toast.info(message);
        return null;
      }
      if (stale) void consentsQuery.refetch();
      toast.error(message);
      return message;
    } finally {
      if (generation === generationRef.current) {
        mutationRef.current = false;
        abortRef.current = null;
        setSaving(null);
      }
    }
  };

  if (consentsQuery.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (consentsQuery.error) {
    return (
      <PanelError
        message={panelMessage(consentsQuery.error, "Could not load consent.")}
      />
    );
  }
  const items = Array.isArray(consentsQuery.data?.items)
    ? consentsQuery.data?.items
    : [];
  const byChannel = new Map<string, ChannelConsent>(
    items.map((consent) => [consent.channel, consent]),
  );
  // Every reachability channel renders, even with no stored row, so the
  // operator sees all five on one profile (an absent row is "Unknown").
  const rows = CONSENT_CHANNELS.map((channel) => ({
    channel,
    record: byChannel.get(channel) ?? null,
  }));
  // The frequency cap is shared across channels by design: surface the first
  // expiry plus which channels it currently holds.
  const cappedChannels = rows.filter((row) => row.record?.frequency_cap_until);
  const sharedCap = cappedChannels[0]?.record?.frequency_cap_until ?? null;
  const versionReady = Boolean(consentsQuery.data?.subscriber_version);
  const subscriberEmail = byChannel.get("email")?.email;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Email grants and revocations take effect across sending immediately.
        SMS, push, WhatsApp, and RCS are visible but read-only until their
        canonical consent stores are connected; the frequency cap is shared
        across all channels.
      </p>
      {!authority ? (
        <p
          id={permissionReasonId}
          role="status"
          className="text-sm text-muted-foreground"
        >
          Consent is read-only for viewers and while view-as mode is active.
        </p>
      ) : null}
      {mutationError ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
        >
          {mutationError}
        </div>
      ) : null}
      <ul className="divide-y rounded-md border bg-card">
        {rows.map(({ channel, record }) => {
          const status: ChannelConsentStatus = record?.status ?? "unknown";
          const granted = status === "opted_in";
          const label = CONSENT_CHANNEL_LABELS[channel];
          const writeBlock = channelConsentWriteBlock(channel);
          const readOnlyReasonId = `${readOnlyPrefix}-${channel}`;
          return (
            <li
              key={channel}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={consentBadgeVariant(status)}>
                    {CONSENT_STATUS_LABELS[status]}
                  </Badge>
                  {record?.consent_timestamp ? (
                    <span title={absoluteTime(record.consent_timestamp)}>
                      {timeAgo(record.consent_timestamp)}
                    </span>
                  ) : (
                    <span>
                      {status === "pending"
                        ? "Awaiting confirmation"
                        : "Not recorded"}
                    </span>
                  )}
                  {/* A source names the act behind a decision, so it is shown
                      beside one — never on its own, where it would read as a
                      consent nobody has given yet. */}
                  {record?.consent_timestamp &&
                  consentSourceLabel(record.consent_source) ? (
                    <span>· {consentSourceLabel(record.consent_source)}</span>
                  ) : null}
                  {record?.frequency_cap_until ? (
                    <span>
                      · capped until {absoluteTime(record.frequency_cap_until)}
                    </span>
                  ) : null}
                </div>
              </div>
              {writeBlock ? (
                <div className="max-w-xs text-right">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled
                    aria-describedby={readOnlyReasonId}
                    aria-label={`${label} consent is read-only`}
                  >
                    Read-only
                  </Button>
                  <p
                    id={readOnlyReasonId}
                    className="mt-1 text-xs text-muted-foreground"
                  >
                    {writeBlock}
                  </p>
                </div>
              ) : (
                <Button
                  type="button"
                  variant={granted ? "outline" : "default"}
                  size="sm"
                  disabled={!authority || saving !== null || !versionReady}
                  aria-describedby={!authority ? permissionReasonId : undefined}
                  aria-label={`${granted ? "Revoke" : "Grant"} ${label} consent`}
                  onClick={() =>
                    setReviewing({
                      channel,
                      nextStatus: granted ? "opted_out" : "opted_in",
                    })
                  }
                >
                  {saving === channel ? "Saving…" : granted ? "Revoke" : "Grant"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Shared frequency cap</span>
        {sharedCap ? (
          <>
            <Badge
              variant="warning"
              title="Sends across the affected channels are held until this passes."
            >
              Held until {absoluteTime(sharedCap)}
            </Badge>
            {cappedChannels.map((row) => (
              <Badge
                key={row.channel}
                variant="outline"
                title={`${CONSENT_CHANNEL_LABELS[row.channel]} is held by the shared frequency cap.`}
              >
                {CONSENT_CHANNEL_LABELS[row.channel]}
              </Badge>
            ))}
          </>
        ) : (
          <span>None active</span>
        )}
      </p>
      <ChannelConsentEvidenceDialog
        pending={reviewing}
        email={subscriberEmail}
        country={country}
        busy={saving !== null}
        onOpenChange={(open) => {
          if (!open && saving === null) setReviewing(null);
        }}
        onSave={async (input) => {
          if (!reviewing) return "Choose a channel decision to record.";
          const error = await setStatus(reviewing.channel, input);
          if (!error) setReviewing(null);
          return error;
        }}
      />
    </div>
  );
}

function ChannelConsentEvidenceDialog({
  pending,
  email,
  country,
  busy,
  onOpenChange,
  onSave,
}: {
  pending: ChannelConsentReview | null;
  email?: string;
  country?: string | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves to null on success, or the message to show on failure. */
  onSave: (input: ConsentEvidenceInput) => Promise<string | null>;
}) {
  const [source, setSource] =
    useState<ConsentEvidenceInput["consent_source"]>("direct_request");
  const [channel, setChannel] =
    useState<ConsentEvidenceInput["evidence_channel"]>("api");
  const [legalBasis, setLegalBasis] =
    useState<ConsentEvidenceInput["legal_basis"]>("consent");
  const [occurredAt, setOccurredAt] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [policyVersion, setPolicyVersion] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fieldPrefix = useId();
  useEffect(() => {
    if (!pending) return;
    setSource("direct_request");
    setChannel("api");
    setLegalBasis("consent");
    setOccurredAt(new Date().toISOString().slice(0, 16));
    setJurisdiction(country?.trim().toUpperCase() || "UNSPECIFIED");
    setEvidence("");
    setReason("");
    setPolicyVersion("");
    setReviewed(false);
    setFormError(null);
  }, [pending, country]);
  const status = pending?.nextStatus ?? "opted_in";
  const granting = status === "opted_in";
  const label = pending ? CONSENT_CHANNEL_LABELS[pending.channel] : "channel";
  const complete = Boolean(
    reviewed &&
    occurredAt &&
    jurisdiction.trim() &&
    evidence.trim() &&
    reason.trim() &&
    policyVersion.trim(),
  );
  // An email grant requires legal_basis=consent server-side; the select is
  // pinned rather than letting an operator pick a basis the server refuses.
  const evidenceInput = (): ConsentEvidenceInput => ({
    status,
    consent_source: source,
    consent_timestamp: new Date(occurredAt).toISOString(),
    evidence_channel: channel,
    legal_basis: granting ? "consent" : legalBasis,
    evidence,
    jurisdiction,
    reason,
    policy_version: policyVersion,
  });
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => !busy && onOpenChange(open)}
    >
      <DialogContent
        className="max-h-[90vh] max-w-xl overflow-y-auto"
        aria-busy={busy}
      >
        <DialogHeader>
          <DialogTitle>
            {granting ? `Grant ${label} consent` : `Revoke ${label} consent`}
          </DialogTitle>
          <DialogDescription>
            This appends an immutable consent event; Moosewave will not infer
            permission from the admin action itself. Record the reviewed proof.
            Unknown and pending remain read-only, fail-closed states.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!granting || !complete || busy) return;
            setFormError(await onSave(evidenceInput()));
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <ConsentSelect
              id={`${fieldPrefix}-source`}
              label="Evidence source"
              value={source}
              disabled={busy}
              options={[
                "direct_request",
                "double_optin",
                "single_optin",
                "preference_center",
                "signed_form",
              ]}
              onChange={(value) =>
                setSource(value as ConsentEvidenceInput["consent_source"])
              }
            />
            <ConsentSelect
              id={`${fieldPrefix}-channel`}
              label="Evidence channel"
              value={channel}
              disabled={busy}
              options={["api", "email", "web", "mobile", "desktop", "import"]}
              onChange={(value) =>
                setChannel(value as ConsentEvidenceInput["evidence_channel"])
              }
            />
            <ConsentSelect
              id={`${fieldPrefix}-basis`}
              label="Legal basis"
              value={granting ? "consent" : legalBasis}
              disabled={busy || granting}
              options={[
                "consent",
                "contract",
                "legitimate_interest",
                "legal_obligation",
              ]}
              onChange={(value) =>
                setLegalBasis(value as ConsentEvidenceInput["legal_basis"])
              }
            />
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldPrefix}-occurred`}>Occurred at</Label>
              <Input
                id={`${fieldPrefix}-occurred`}
                type="datetime-local"
                value={occurredAt}
                disabled={busy}
                max={new Date(Date.now() + 5 * 60_000)
                  .toISOString()
                  .slice(0, 16)}
                onChange={(event) => setOccurredAt(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldPrefix}-jurisdiction`}>
                Jurisdiction
              </Label>
              <Input
                id={`${fieldPrefix}-jurisdiction`}
                value={jurisdiction}
                maxLength={32}
                disabled={busy}
                onChange={(event) => setJurisdiction(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${fieldPrefix}-evidence`}>Evidence</Label>
            <Textarea
              id={`${fieldPrefix}-evidence`}
              value={evidence}
              maxLength={2048}
              disabled={busy}
              placeholder="Where the reviewed proof is stored, or the captured statement."
              onChange={(event) => setEvidence(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${fieldPrefix}-reason`}>Reason</Label>
            <Textarea
              id={`${fieldPrefix}-reason`}
              value={reason}
              maxLength={500}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${fieldPrefix}-policy`}>Policy version</Label>
            <Input
              id={`${fieldPrefix}-policy`}
              value={policyVersion}
              maxLength={100}
              disabled={busy}
              placeholder="privacy-2026-08"
              onChange={(event) => setPolicyVersion(event.target.value)}
            />
          </div>
          <label className="flex min-h-11 items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-primary"
              checked={reviewed}
              disabled={busy}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            <span>
              I reviewed the source proof and confirm it belongs to this exact
              subscriber and {label.toLowerCase()} decision.
            </span>
          </label>
          {formError ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
            >
              {formError}
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            {granting ? (
              <Button type="submit" disabled={busy || !complete}>
                {busy ? "Recording…" : "Record grant"}
              </Button>
            ) : (
              <ConfirmDialog
                title={`Revoke ${label.toLowerCase()} consent?`}
                description={`Revoking ${label.toLowerCase()} consent for ${email ?? "this subscriber"} stops marketing ${label.toLowerCase()} immediately and appends an immutable consent event. It cannot be undone; sending again will need fresh consent evidence.`}
                confirmLabel="Revoke consent"
                onConfirm={async () => {
                  const error = await onSave(evidenceInput());
                  if (error) throw new Error(error);
                }}
                trigger={
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy || !complete}
                  >
                    {busy ? "Recording…" : "Record revocation"}
                  </Button>
                }
              />
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConsentSelect({
  id,
  label,
  value,
  disabled,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replaceAll("_", " ")}
          </option>
        ))}
      </Select>
    </div>
  );
}

/* ================================ Audit ================================= */

export function AuditPanel({
  id,
  enabled,
  tenantId,
  role,
}: {
  id: string;
  enabled: boolean;
  tenantId: string;
  role: string | null;
}) {
  const auditQuery = useQuery({
    queryKey: ["subscriber-audit", tenantId, role ?? "viewer", id],
    queryFn: async ({ signal }) => {
      const [audit, attrs] = await Promise.all([
        getSubscriberAudit(id, 50, signal),
        getAttributeHistory(id, 50, signal),
      ]);
      return { audit: audit.items, attrs: attrs.items };
    },
    enabled,
    staleTime: 30_000,
  });

  if (auditQuery.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  if (auditQuery.error) {
    return (
      <PanelError
        message={panelMessage(
          auditQuery.error,
          "Could not load audit history.",
        )}
      />
    );
  }

  const attrs = Array.isArray(auditQuery.data?.attrs)
    ? auditQuery.data?.attrs
    : [];
  const audit = Array.isArray(auditQuery.data?.audit)
    ? auditQuery.data?.audit
    : [];

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-medium">Attribute changes</h3>
        {attrs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No attribute changes recorded.
          </p>
        ) : (
          <ul className="divide-y rounded-md border bg-card text-sm">
            {attrs.map((change) => (
              <li key={change.id} className="p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{change.field_name}</span>
                  <span
                    className="text-xs text-muted-foreground"
                    title={absoluteTime(change.changed_at)}
                  >
                    {timeAgo(change.changed_at)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  <span className="line-through">
                    {change.old_value ?? "—"}
                  </span>
                  {" → "}
                  <span className="text-foreground">
                    {change.new_value ?? "—"}
                  </span>
                  <span> · {change.source}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-medium">Audit log</h3>
        {audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">No audit entries.</p>
        ) : (
          <ul className="divide-y rounded-md border bg-card text-sm">
            {audit.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-baseline justify-between gap-2 p-3"
              >
                <span>
                  <span className="font-medium">{entry.action}</span>
                  {entry.actor_label ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {entry.actor_label}
                    </span>
                  ) : null}
                </span>
                <span
                  className="text-xs text-muted-foreground"
                  title={absoluteTime(entry.at)}
                >
                  {timeAgo(entry.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ========================= Cross-channel timeline ====================== */

export function CrossChannelPanel({
  id,
  enabled,
  tenantId,
  role,
}: {
  id: string;
  enabled: boolean;
  tenantId: string;
  role: string | null;
}) {
  const query = useQuery({
    queryKey: ["subscriber-cross-channel", tenantId, role ?? "viewer", id],
    queryFn: ({ signal }) =>
      getCrossChannelTimeline(id, { limit: 100, signal }),
    enabled,
    staleTime: 30_000,
  });

  if (query.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (query.error) {
    return (
      <PanelError
        message={panelMessage(
          query.error,
          "Could not load cross-channel timeline.",
        )}
      />
    );
  }
  const items = Array.isArray(query.data?.items) ? query.data?.items : [];
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No cross-channel (email + SMS) activity recorded.
      </p>
    );
  }
  return (
    <ol className="relative ml-2 border-l border-border">
      {items.map((ev, i) => (
        <li key={`${ev.channel}-${ev.at}-${i}`} className="ml-4 pb-4">
          <span
            className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full"
            style={{
              background:
                ev.channel === "sms"
                  ? "hsl(var(--info))"
                  : "hsl(var(--chart-1))",
            }}
            aria-hidden
          />
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <Badge variant="outline" className="uppercase">
              {ev.channel}
            </Badge>
            <span className="font-medium">{ev.label || ev.type}</span>
            {ev.campaign_id ? (
              <Link
                href={`/app/campaigns/${encodeURIComponent(ev.campaign_id)}`}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                · view campaign
              </Link>
            ) : null}
            <span
              className="ml-auto text-xs text-muted-foreground"
              title={absoluteTime(ev.at)}
            >
              {timeAgo(ev.at)}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ============================ Receipt actions =========================== */

export function ReceiptActions({ id, email }: { id: string; email: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const busyRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const safe = email.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const downloadErasureReceipt = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setDownloaded(false);
    setBusy(true);
    try {
      const json = await getErasureReceiptJson(id);
      downloadTextFile(
        `erasure-receipt-${safe}.json`,
        json,
        "application/json",
      );
      setDownloaded(true);
    } catch (err) {
      const message = panelMessage(
        err,
        "No erasure receipt (this contact hasn't been erased).",
      );
      setError(message);
      toast.error(message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap gap-2" aria-busy={busy}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void downloadErasureReceipt()}
      >
        {busy ? "Preparing…" : "Erasure receipt"}
      </Button>
      {error ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="w-full rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
        >
          {error}
        </div>
      ) : downloaded ? (
        <p role="status" className="w-full text-sm text-success">
          Erasure receipt downloaded.
        </p>
      ) : null}
    </div>
  );
}
