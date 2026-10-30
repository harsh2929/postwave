import {
  type Dispatch,
  type MutableRefObject,
  type ReactElement,
  type SetStateAction,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type SubscriberNote,
  type SubscriberNoteAttachment,
  subscriberNotesApi,
} from "../../lib/api-client";
import { formatBytes } from "../../lib/email-byte-size";
import { downloadUrlToFile } from "../../lib/file-transfer";
import { safeExternalAssetUrl } from "../../lib/safe-url";
import { useMe } from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import {
  MarkdownNoteEditor,
  renderNoteMarkdown,
} from "../subscriber/MarkdownNoteEditor";
import {
  NOTE_ATTACHMENT_UPLOAD_UNAVAILABLE_REASON,
  NoteAttachmentForm,
} from "../subscriber/NoteAttachmentForm";
import { type NoteMentionItem } from "../subscriber/NoteMentionMenu";
import { toast } from "../Toast";
import "../../styles-subscriber-notes.css";

interface SubscriberNotesPanelProps {
  active: boolean;
  subscriberId: string | number | null | undefined;
  canMutate: boolean;
  canAdmin: boolean;
  formatRelativeTime: (timestamp: string | undefined | null) => string;
}

interface SubscriberNotesViewProps {
  notes: SubscriberNote[] | null;
  notesErr: string | null;
  notesLoading: boolean;
  noteDraft: string;
  noteSaving: boolean;
  notePinBusy: string | null;
  pendingNoteDelete: SubscriberNote | null;
  noteDeleteBusy: boolean;
  attachBusy: string | null;
  canEditNotes: boolean;
  notesGateTitle: string;
  mentionCandidates: NoteMentionItem[];
  formatRelativeTime: (timestamp: string | undefined | null) => string;
  setNoteDraft: Dispatch<SetStateAction<string>>;
  setPendingNoteDelete: Dispatch<SetStateAction<SubscriberNote | null>>;
  addNote: () => Promise<void>;
  removeAttachment: (
    noteId: string,
    attachment: SubscriberNoteAttachment,
  ) => Promise<void>;
  toggleNotePin: (note: SubscriberNote) => Promise<void>;
  confirmDeleteNote: () => Promise<void>;
  reloadNotes: () => Promise<void>;
}

interface NoteAttachmentDownload {
  key: string;
  url: string;
  filename: string;
  sizeBytes: number | undefined;
}

export const SUBSCRIBER_NOTE_ATTACHMENT_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;

const ATTACHMENT_FILENAME_CONTROLS =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Attachment metadata predates the verified-upload gate and is untrusted.
 * Keep control and bidi characters out of visible labels and save prompts;
 * React continues to provide the HTML-escaping boundary for ordinary text.
 */
export function displayNoteAttachmentFilename(filename: string): string {
  return (
    filename.replace(ATTACHMENT_FILENAME_CONTROLS, "").trim() || "Attachment"
  );
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Build the local @-mention directory from identities already present in the
 * note history. The desktop API has no workspace-user search endpoint.
 */
export function buildNoteMentionCandidates(
  notes: SubscriberNote[],
  currentUserId?: string,
): NoteMentionItem[] {
  const byId = new Map<string, NoteMentionItem>();
  const add = (rawId: string | undefined, display: string, hint?: string) => {
    if (!rawId || !UUID_RE.test(rawId)) return;
    const id = rawId.toLowerCase();
    const label = (display || hint || id).trim();
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { id, display: label, hint });
      return;
    }
    if (existing.display === id && label !== id) existing.display = label;
    if (!existing.hint && hint) existing.hint = hint;
  };

  if (currentUserId) add(currentUserId, currentUserId, "you");
  for (const note of notes) {
    if (note.author_user_id) {
      add(note.author_user_id, note.author_email ?? "", note.author_email);
    }
    for (const mention of note.mentions ?? []) {
      add(mention.user_id, mention.display);
    }
    for (const attachment of note.attachments ?? []) {
      if (attachment.uploaded_by_user_id) {
        add(
          attachment.uploaded_by_user_id,
          attachment.uploaded_by_email ?? "",
          attachment.uploaded_by_email,
        );
      }
    }
  }

  return [...byId.values()].sort((left, right) =>
    left.display.localeCompare(right.display),
  );
}

/**
 * Owns the complete subscriber-notes lifecycle. It stays mounted while tabs
 * change so a loaded note list is retained, but only fetches when activated.
 */
export function SubscriberNotesPanel(
  props: SubscriberNotesPanelProps,
): ReactElement {
  // A keyed state owner prevents notes, drafts, and pending confirmations from
  // the previous subscriber surviving even one render after navigation.
  const subscriberKey =
    props.subscriberId == null
      ? "none:"
      : `${typeof props.subscriberId}:${String(props.subscriberId)}`;
  return <SubscriberNotesPanelState key={subscriberKey} {...props} />;
}

function SubscriberNotesPanelState({
  active,
  subscriberId,
  canMutate,
  canAdmin,
  formatRelativeTime,
}: SubscriberNotesPanelProps): ReactElement | null {
  const [notes, setNotes] = useState<SubscriberNote[] | null>(null);
  const [notesErr, setNotesErr] = useState<string | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [notePinBusy, setNotePinBusy] = useState<string | null>(null);
  const [pendingNoteDelete, setPendingNoteDelete] =
    useState<SubscriberNote | null>(null);
  const [noteDeleteBusy, setNoteDeleteBusy] = useState(false);
  const requestGeneration = useRef(0);
  const inFlightRef = useRef(new Set<string>());
  const me = useMe();

  const canEditNotes = canMutate && canAdmin;
  const notesGateTitle = !canMutate
    ? "Viewer role can't edit notes"
    : "Notes need an admin role";

  const mentionCandidates = useMemo(
    () => buildNoteMentionCandidates(notes ?? [], me?.user),
    [notes, me],
  );

  const beginOperation = useCallback((key: string): boolean => {
    if (inFlightRef.current.has(key)) return false;
    inFlightRef.current.add(key);
    return true;
  }, []);

  const endOperation = useCallback((key: string): void => {
    inFlightRef.current.delete(key);
  }, []);

  useEffect(
    () => () => {
      requestGeneration.current += 1;
      inFlightRef.current.clear();
    },
    [],
  );

  const loadNotes = useCallback(async (): Promise<void> => {
    if (subscriberId == null || !beginOperation("load")) return;
    const generation = requestGeneration.current;
    setNotesLoading(true);
    setNotesErr(null);
    try {
      const result = await subscriberNotesApi.list(subscriberId);
      if (generation !== requestGeneration.current) return;
      if (result.error) {
        const status =
          result.error.kind === "http" ? result.error.status : undefined;
        setNotesErr(
          status === 403
            ? "Notes need an admin-scoped key — this session can't read them."
            : status === 404
              ? "Notes aren't available on this deployment."
              : result.error.message,
        );
        return;
      }
      setNotes(result.data.notes ?? []);
    } catch {
      if (generation === requestGeneration.current) {
        setNotesErr(
          "Notes couldn't be loaded. Check your connection and try again.",
        );
      }
    } finally {
      endOperation("load");
      if (generation === requestGeneration.current) setNotesLoading(false);
    }
  }, [beginOperation, endOperation, subscriberId]);

  useEffect(() => {
    if (
      active &&
      subscriberId != null &&
      notes == null &&
      !notesLoading &&
      !notesErr
    ) {
      void loadNotes();
    }
  }, [active, loadNotes, notes, notesErr, notesLoading, subscriberId]);

  const addNote = async (): Promise<void> => {
    if (subscriberId == null || !canEditNotes || !beginOperation("add-note")) {
      return;
    }
    const markdown = noteDraft.trim();
    if (!markdown) {
      endOperation("add-note");
      return;
    }
    if (markdown.length > 20_000) {
      toast.error("Notes are capped at 20,000 characters.");
      endOperation("add-note");
      return;
    }
    const generation = requestGeneration.current;
    setNoteSaving(true);
    try {
      const result = await subscriberNotesApi.create(subscriberId, {
        markdown_body: markdown,
      });
      if (generation !== requestGeneration.current) return;
      if (result.error) {
        toast.error(`Couldn't add note: ${result.error.message}`);
        return;
      }
      setNoteDraft("");
      void loadNotes();
    } catch {
      if (generation === requestGeneration.current) {
        toast.error("Couldn't add the note. Check your connection and retry.");
      }
    } finally {
      endOperation("add-note");
      if (generation === requestGeneration.current) setNoteSaving(false);
    }
  };

  const { attachBusy, removeAttachment } = useSubscriberNoteAttachments({
    subscriberId,
    canEditNotes,
    beginOperation,
    endOperation,
    requestGeneration,
    setNotes,
  });

  const toggleNotePin = async (note: SubscriberNote): Promise<void> => {
    if (subscriberId == null || !canEditNotes || !beginOperation("pin-note")) {
      return;
    }
    const generation = requestGeneration.current;
    setNotePinBusy(note.id);
    const nextPinned = !note.pinned;
    try {
      const result = await subscriberNotesApi.update(subscriberId, note.id, {
        pinned: nextPinned,
      });
      if (generation !== requestGeneration.current) return;
      if (result.error) {
        toast.error(
          `Couldn't ${note.pinned ? "unpin" : "pin"}: ${result.error.message}`,
        );
        return;
      }
      const pinned = result.data.pinned ?? nextPinned;
      setNotes((previous) =>
        previous
          ? previous.map((item) =>
              item.id === note.id ? { ...item, pinned } : item,
            )
          : previous,
      );
    } catch {
      if (generation === requestGeneration.current) {
        toast.error(
          `Couldn't ${note.pinned ? "unpin" : "pin"} the note. Check your connection and retry.`,
        );
      }
    } finally {
      endOperation("pin-note");
      if (generation === requestGeneration.current) setNotePinBusy(null);
    }
  };

  const confirmDeleteNote = async (): Promise<void> => {
    if (
      subscriberId == null ||
      !pendingNoteDelete ||
      !canEditNotes ||
      !beginOperation("delete-note")
    ) {
      return;
    }
    const generation = requestGeneration.current;
    const deletedId = pendingNoteDelete.id;
    setNoteDeleteBusy(true);
    try {
      const result = await subscriberNotesApi.remove(subscriberId, deletedId);
      if (generation !== requestGeneration.current) return;
      if (result.error) {
        toast.error(`Couldn't delete note: ${result.error.message}`);
        return;
      }
      setPendingNoteDelete(null);
      setNotes((previous) =>
        previous ? previous.filter((note) => note.id !== deletedId) : previous,
      );
      toast.success("Note deleted");
    } catch {
      if (generation === requestGeneration.current) {
        toast.error(
          "Couldn't delete the note. Check your connection and retry.",
        );
      }
    } finally {
      endOperation("delete-note");
      if (generation === requestGeneration.current) setNoteDeleteBusy(false);
    }
  };

  if (!active) return null;

  return (
    <SubscriberNotesView
      notes={notes}
      notesErr={notesErr}
      notesLoading={notesLoading}
      noteDraft={noteDraft}
      noteSaving={noteSaving}
      notePinBusy={notePinBusy}
      pendingNoteDelete={pendingNoteDelete}
      noteDeleteBusy={noteDeleteBusy}
      attachBusy={attachBusy}
      canEditNotes={canEditNotes}
      notesGateTitle={notesGateTitle}
      mentionCandidates={mentionCandidates}
      formatRelativeTime={formatRelativeTime}
      setNoteDraft={setNoteDraft}
      setPendingNoteDelete={setPendingNoteDelete}
      addNote={addNote}
      removeAttachment={removeAttachment}
      toggleNotePin={toggleNotePin}
      confirmDeleteNote={confirmDeleteNote}
      reloadNotes={loadNotes}
    />
  );
}

function useSubscriberNoteAttachments({
  subscriberId,
  canEditNotes,
  beginOperation,
  endOperation,
  requestGeneration,
  setNotes,
}: {
  subscriberId: string | number | null | undefined;
  canEditNotes: boolean;
  beginOperation: (key: string) => boolean;
  endOperation: (key: string) => void;
  requestGeneration: MutableRefObject<number>;
  setNotes: Dispatch<SetStateAction<SubscriberNote[] | null>>;
}) {
  const [attachBusy, setAttachBusy] = useState<string | null>(null);

  const removeAttachment = async (
    noteId: string,
    attachment: SubscriberNoteAttachment,
  ): Promise<void> => {
    if (
      subscriberId == null ||
      !canEditNotes ||
      !beginOperation("attachment")
    ) {
      return;
    }
    const generation = requestGeneration.current;
    setAttachBusy(`${noteId}:${attachment.file_key}`);
    try {
      const result = await subscriberNotesApi.removeAttachment(
        subscriberId,
        noteId,
        attachment.file_key,
      );
      if (generation !== requestGeneration.current) return;
      if (result.error) {
        toast.error(`Couldn't remove attachment: ${result.error.message}`);
        return;
      }
      setNotes((previous) =>
        previous
          ? previous.map((note) =>
              note.id === noteId
                ? {
                    ...note,
                    attachments: note.attachments.filter(
                      (item) => item.file_key !== attachment.file_key,
                    ),
                  }
                : note,
            )
          : previous,
      );
      toast.success("Attachment removed");
    } catch {
      if (generation === requestGeneration.current) {
        toast.error(
          "Couldn't remove the attachment. Check your connection and retry.",
        );
      }
    } finally {
      endOperation("attachment");
      if (generation === requestGeneration.current) setAttachBusy(null);
    }
  };

  return {
    attachBusy,
    removeAttachment,
  };
}

function SubscriberNotesView({
  notes,
  notesErr,
  notesLoading,
  noteDraft,
  noteSaving,
  notePinBusy,
  pendingNoteDelete,
  noteDeleteBusy,
  attachBusy,
  canEditNotes,
  notesGateTitle,
  mentionCandidates,
  formatRelativeTime,
  setNoteDraft,
  setPendingNoteDelete,
  addNote,
  removeAttachment,
  toggleNotePin,
  confirmDeleteNote,
  reloadNotes,
}: SubscriberNotesViewProps): ReactElement {
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);
  const downloadBusyRef = useRef<string | null>(null);
  const viewMountedRef = useRef(true);
  const viewId = useId();
  const accessDescriptionId = `${viewId}-notes-access`;
  const composeDescriptionId = `${viewId}-compose-description`;
  const composeDescription = !canEditNotes
    ? `${notesGateTitle}. Existing notes remain readable, but posting, pinning, deleting, and attachment changes are unavailable.`
    : noteSaving
      ? "Posting this note. Keep the panel open until it finishes."
      : !noteDraft.trim()
        ? "Write a note before posting. Notes are internal and never shown to subscribers."
        : "Posts this internal note permanently; posted note text cannot be edited.";

  useEffect(() => {
    viewMountedRef.current = true;
    return () => {
      viewMountedRef.current = false;
      downloadBusyRef.current = null;
    };
  }, []);

  const downloadAttachment = async ({
    key,
    url,
    filename,
    sizeBytes,
  }: NoteAttachmentDownload): Promise<void> => {
    if (downloadBusyRef.current !== null) return;
    if (
      typeof sizeBytes === "number" &&
      Number.isFinite(sizeBytes) &&
      sizeBytes > SUBSCRIBER_NOTE_ATTACHMENT_DOWNLOAD_MAX_BYTES
    ) {
      toast.error(
        "This attachment is marked larger than the 50 MB download safety limit.",
      );
      return;
    }
    downloadBusyRef.current = key;
    setDownloadBusy(key);
    try {
      const saved = await downloadUrlToFile({
        url,
        suggestedName: filename,
        label: "Subscriber note attachment",
        privacy: "confidential",
        maxBytes: SUBSCRIBER_NOTE_ATTACHMENT_DOWNLOAD_MAX_BYTES,
        allowExternalFallback: false,
      });
      if (!saved.ok && saved.code !== "cancelled") toast.error(saved.message);
    } catch {
      toast.error("The attachment couldn't be downloaded. Try again.");
    } finally {
      if (downloadBusyRef.current === key) {
        downloadBusyRef.current = null;
        if (viewMountedRef.current) setDownloadBusy(null);
      }
    }
  };

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="label">Notes</div>
        {!canEditNotes ? (
          <div
            id={accessDescriptionId}
            className="muted"
            style={{ fontSize: 11 }}
          >
            {notesGateTitle}. Existing notes remain readable.
          </div>
        ) : null}
        {notesErr ? (
          <div className="notice" role="alert" style={{ fontSize: 12 }}>
            <span>{notesErr}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void reloadNotes()}
            >
              Retry
            </button>
          </div>
        ) : null}
        {notesLoading && notes !== null ? (
          <div className="muted" role="status" style={{ fontSize: 11 }}>
            Refreshing notes…
          </div>
        ) : null}
        {notesLoading && notes == null ? (
          <div role="status">
            <span className="sr-only">Loading subscriber notes</span>
            <div className="skel" style={{ height: 40 }} aria-hidden="true" />
          </div>
        ) : notes == null ? null : notes.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No notes yet. Notes are internal — subscribers never see them.
          </div>
        ) : (
          <SubscriberNotesList
            notes={notes}
            accessDescriptionId={accessDescriptionId}
            attachBusy={attachBusy}
            canEditNotes={canEditNotes}
            downloadBusy={downloadBusy}
            formatRelativeTime={formatRelativeTime}
            notesGateTitle={notesGateTitle}
            notePinBusy={notePinBusy}
            onDeleteRequest={setPendingNoteDelete}
            onDownload={downloadAttachment}
            onRemoveAttachment={removeAttachment}
            onTogglePin={toggleNotePin}
          />
        )}

        {!notesErr ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <MarkdownNoteEditor
              value={noteDraft}
              onChange={setNoteDraft}
              mentionCandidates={mentionCandidates}
              disabled={!canEditNotes || noteSaving}
              maxLength={20_000}
              placeholder="Add an internal note… markdown supported, type @ to mention a teammate"
              ariaLabel="New note"
              onSubmit={() => void addNote()}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span
                id={composeDescriptionId}
                className="muted"
                style={{ fontSize: 10 }}
              >
                {noteDraft.length.toLocaleString()}/20,000 · ⌘/Ctrl+Enter to
                post. {composeDescription}
              </span>
              <span className="spacer" style={{ flex: 1 }} />
              <button
                type="button"
                className={`btn btn-sm btn-primary${
                  !canEditNotes || !noteDraft.trim()
                    ? " pw-discoverable-unavailable"
                    : ""
                }`}
                onClick={() => void addNote()}
                disabled={noteSaving}
                aria-disabled={
                  !canEditNotes || noteSaving || !noteDraft.trim() || undefined
                }
                aria-describedby={composeDescriptionId}
              >
                {noteSaving ? "Adding…" : "Add note"}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <ConfirmModal
        open={pendingNoteDelete !== null}
        title="Delete note?"
        description="Permanently removes this note. Notes can't be edited after posting, so there's no way to restore the text."
        confirmLabel="Delete note"
        danger
        busy={noteDeleteBusy}
        onClose={() => setPendingNoteDelete(null)}
        onConfirm={() => void confirmDeleteNote()}
      />
    </>
  );
}

function SubscriberNotesList({
  notes,
  accessDescriptionId,
  attachBusy,
  canEditNotes,
  downloadBusy,
  formatRelativeTime,
  notePinBusy,
  onDeleteRequest,
  onDownload,
  onRemoveAttachment,
  onTogglePin,
  notesGateTitle,
}: {
  notes: SubscriberNote[];
  accessDescriptionId: string;
  attachBusy: string | null;
  canEditNotes: boolean;
  downloadBusy: string | null;
  formatRelativeTime: SubscriberNotesViewProps["formatRelativeTime"];
  notePinBusy: string | null;
  onDeleteRequest: SubscriberNotesViewProps["setPendingNoteDelete"];
  onDownload: (input: NoteAttachmentDownload) => Promise<void>;
  onRemoveAttachment: SubscriberNotesViewProps["removeAttachment"];
  onTogglePin: SubscriberNotesViewProps["toggleNotePin"];
  notesGateTitle: string;
}): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {notes.map((note) => (
        <div
          key={note.id}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "6px 8px",
            background: "var(--pw-bg-elev-2)",
            borderRadius: 4,
            borderLeft: note.pinned
              ? "2px solid var(--pw-accent)"
              : "2px solid transparent",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              flexWrap: "wrap",
            }}
          >
            {note.pinned ? (
              <span
                className="badge"
                style={{ fontSize: 9 }}
                title="Pinned note"
              >
                Pinned
              </span>
            ) : null}
            <span className="muted">
              {note.author_email || note.author_user_id || "Unknown author"}
            </span>
            <span className="muted tabular" title={note.created_at}>
              · {formatRelativeTime(note.created_at)}
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            <button
              type="button"
              className={`btn btn-xs btn-ghost${canEditNotes ? "" : " pw-discoverable-unavailable"}`}
              style={{ fontSize: 10 }}
              onClick={() => {
                if (canEditNotes) void onTogglePin(note);
              }}
              disabled={notePinBusy === note.id}
              aria-disabled={
                !canEditNotes || notePinBusy === note.id || undefined
              }
              aria-describedby={canEditNotes ? undefined : accessDescriptionId}
              aria-label={`${note.pinned ? "Unpin" : "Pin"} note from ${
                note.author_email || note.author_user_id || "unknown author"
              }`}
            >
              {notePinBusy === note.id
                ? "Saving…"
                : note.pinned
                  ? "Unpin"
                  : "Pin"}
            </button>
            <button
              type="button"
              className={`btn btn-xs btn-ghost${canEditNotes ? "" : " pw-discoverable-unavailable"}`}
              style={{ fontSize: 10, color: "var(--pw-danger)" }}
              onClick={() => {
                if (canEditNotes) onDeleteRequest(note);
              }}
              aria-disabled={!canEditNotes || undefined}
              aria-describedby={canEditNotes ? undefined : accessDescriptionId}
              aria-label={`Delete note from ${
                note.author_email || note.author_user_id || "unknown author"
              }`}
            >
              Delete
            </button>
          </div>
          <div className="note-body" style={{ fontSize: 12 }}>
            {renderNoteMarkdown(note.markdown_body || note.body)}
          </div>

          {note.attachments.length > 0 ? (
            <div className="note-attachments">
              {note.attachments.map((attachment) => {
                const busy = attachBusy === `${note.id}:${attachment.file_key}`;
                const downloadKey = `${note.id}:${attachment.file_key}`;
                const filename = displayNoteAttachmentFilename(
                  attachment.filename,
                );
                const downloadUrl = safeExternalAssetUrl(
                  attachment.download_url,
                );
                return (
                  <span key={attachment.id} className="note-attachment-chip">
                    {downloadUrl ? (
                      <button
                        type="button"
                        className="note-attachment-link"
                        aria-label={`Download ${filename}`}
                        aria-busy={downloadBusy === downloadKey}
                        disabled={downloadBusy !== null}
                        onClick={() =>
                          void onDownload({
                            key: downloadKey,
                            url: downloadUrl,
                            filename,
                            sizeBytes: attachment.size_bytes,
                          })
                        }
                      >
                        {downloadBusy === downloadKey
                          ? `Downloading ${filename}…`
                          : filename}
                      </button>
                    ) : (
                      <span className="note-attachment-link">
                        {filename} <span className="muted">(unavailable)</span>
                      </span>
                    )}
                    <span className="muted note-attachment-size">
                      {formatBytes(attachment.size_bytes)}
                    </span>
                    <button
                      type="button"
                      className={`note-attachment-remove${canEditNotes ? "" : " pw-discoverable-unavailable"}`}
                      aria-label={`Remove ${filename}`}
                      disabled={busy}
                      aria-disabled={!canEditNotes || busy || undefined}
                      aria-describedby={
                        canEditNotes ? undefined : accessDescriptionId
                      }
                      onClick={() => {
                        if (canEditNotes) {
                          void onRemoveAttachment(note.id, attachment);
                        }
                      }}
                    >
                      {busy ? "…" : "×"}
                    </button>
                  </span>
                );
              })}
            </div>
          ) : null}

          <NoteAttachmentForm
            reason={
              canEditNotes
                ? NOTE_ATTACHMENT_UPLOAD_UNAVAILABLE_REASON
                : `${notesGateTitle}. ${NOTE_ATTACHMENT_UPLOAD_UNAVAILABLE_REASON}`
            }
          />
        </div>
      ))}
    </div>
  );
}
