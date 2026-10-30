/** Conversation taxonomy with explicit read/write integrity states. */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { type SMSConversationTag, api } from "../../lib/api-client";
import { toast } from "../Toast";
import { useSMSDocumentVisible } from "./sms-page-activity";

interface Props {
  phone: string;
}

export function ConversationTagsNotes({ phone }: Props): ReactElement {
  const [tags, setTags] = useState<SMSConversationTag[] | null>(null);
  const [newTag, setNewTag] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const generationRef = useRef(0);
  const mutationRef = useRef(false);
  const loadAbortRef = useRef<AbortController | null>(null);
  const documentVisible = useSMSDocumentVisible();

  const load = useCallback(async (): Promise<void> => {
    if (!documentVisible) return;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const generation = ++generationRef.current;
    setTags(null);
    setLoadError(null);
    try {
      const response = await api.listSMSConversationTags(phone, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== generationRef.current) {
        return;
      }
      if (response.error || !response.data) {
        setLoadError("Conversation tags could not be loaded.");
        return;
      }
      setTags(response.data.tags);
    } catch {
      if (!controller.signal.aborted && generation === generationRef.current) {
        setLoadError(
          "Conversation tags could not be loaded. Check the connection and retry.",
        );
      }
    } finally {
      if (loadAbortRef.current === controller) loadAbortRef.current = null;
    }
  }, [documentVisible, phone]);

  useEffect(() => {
    setNewTag("");
    if (documentVisible) void load();
    else loadAbortRef.current?.abort();
    return () => {
      generationRef.current += 1;
      loadAbortRef.current?.abort();
    };
  }, [documentVisible, load]);

  const onAddTag = async (): Promise<void> => {
    const tag = newTag.trim();
    if (!tag || mutationRef.current) return;
    mutationRef.current = true;
    setBusy("add");
    try {
      const response = await api.addSMSConversationTag(phone, tag);
      if (response.error || !response.data?.createdAt) {
        toast.error(
          "The tag could not be added. Refresh the conversation and retry.",
        );
        return;
      }
      const returnedTag = response.data.tag;
      const createdAt = response.data.createdAt;
      setNewTag("");
      setTags((previous) => {
        if (!previous) return previous;
        if (previous.some((item) => item.tag === returnedTag)) {
          return previous;
        }
        return [
          ...previous,
          {
            tag: returnedTag,
            createdAt,
          },
        ];
      });
    } catch {
      toast.error(
        "The tag could not be added. Check the connection and retry.",
      );
    } finally {
      mutationRef.current = false;
      setBusy(null);
    }
  };

  const onRemoveTag = async (
    tag: string,
    expectedCreatedAt: string,
  ): Promise<void> => {
    if (mutationRef.current) return;
    mutationRef.current = true;
    setBusy(tag);
    try {
      const response = await api.removeSMSConversationTag(
        phone,
        tag,
        expectedCreatedAt,
      );
      if (response.error) {
        toast.error(
          "The tag could not be removed. Refresh the conversation and retry.",
        );
        return;
      }
      setTags((previous) =>
        previous ? previous.filter((item) => item.tag !== tag) : previous,
      );
    } catch {
      toast.error(
        "The tag could not be removed. Check the connection and retry.",
      );
    } finally {
      mutationRef.current = false;
      setBusy(null);
    }
  };

  return (
    <section className="sms-tags-notes" aria-labelledby="sms-thread-tags-title">
      <div className="sms-tags-row">
        <span
          id="sms-thread-tags-title"
          className="sms-thread-subsection-label"
        >
          Tags
        </span>
        {tags === null && !loadError ? (
          <span className="muted small" role="status">
            Loading tags…
          </span>
        ) : loadError ? (
          <span className="sms-tags-error" role="alert">
            {loadError}{" "}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void load()}
            >
              Retry
            </button>
          </span>
        ) : (tags ?? []).length === 0 ? (
          <span className="muted small">No tags</span>
        ) : (
          (tags ?? []).map((item, index) => (
            <span key={item.tag} className="sms-tag-chip">
              <bdi className="sms-tag-text" dir="auto">
                {item.tag}
              </bdi>
              <button
                type="button"
                className="sms-tag-remove"
                onClick={() => void onRemoveTag(item.tag, item.createdAt)}
                disabled={busy !== null}
                aria-label={`Remove conversation tag ${index + 1}`}
              >
                {busy === item.tag ? "…" : "×"}
              </button>
            </span>
          ))
        )}
        {tags !== null && !loadError ? (
          <form
            className="sms-tag-form"
            onSubmit={(event) => {
              event.preventDefault();
              void onAddTag();
            }}
          >
            <label className="visually-hidden" htmlFor="sms-conversation-tag">
              Add a conversation tag
            </label>
            <input
              id="sms-conversation-tag"
              className="input sms-tag-input"
              placeholder="Add tag"
              value={newTag}
              maxLength={64}
              disabled={busy !== null}
              onChange={(event) => setNewTag(event.target.value)}
            />
            <button
              type="submit"
              className="btn btn-sm btn-ghost"
              disabled={!newTag.trim() || busy !== null}
            >
              {busy === "add" ? "Adding…" : "Add"}
            </button>
          </form>
        ) : null}
      </div>
      <p className="sms-notes-unavailable muted small">
        Existing internal notes are not exposed by the current read contract, so
        this client does not overwrite them.
      </p>
    </section>
  );
}
